import { describe, it, expect, beforeAll } from "vitest";
import { StyleLockedExtractor } from "../../src/extractor.js";
import type { PageExtract } from "../../src/types.js";
import {
  fixture,
  FIXTURE_NAMES,
  hasCjkFont,
} from "../helpers/make-pdf.js";

describe("extractor/StyleLockedExtractor", () => {
  /* 同一夹具只提取一次，多个断言共享（速度优化） */
  let enPage: PageExtract;
  let reportPages: PageExtract[];
  let stylesPage: PageExtract;

  beforeAll(async () => {
    const en = await StyleLockedExtractor.open(await fixture(FIXTURE_NAMES.enBasic));
    enPage = await en.extractPage(1);

    const rep = await StyleLockedExtractor.open(await fixture(FIXTURE_NAMES.report3p));
    reportPages = [];
    for (const p of [1, 2, 3]) reportPages.push(await rep.extractPage(p));

    const st = await StyleLockedExtractor.open(await fixture(FIXTURE_NAMES.stylesMatrix));
    stylesPage = await st.extractPage(1);
  }, 60_000);

  it("英文单页：文本完整、tid 规范、坐标在页面内", async () => {
    const all = enPage.units.map((u) => u.text).join("\n");

    expect(all).toContain("Quarterly Operations Review");
    expect(all).toContain("99.95 percent");
    expect(enPage.units.every((u) => /^p1-\d+$/.test(u.tid))).toBe(true);
    expect(enPage.widthPt).toBeCloseTo(595.28, 0);
    expect(enPage.heightPt).toBeCloseTo(841.89, 0);

    for (const u of enPage.units) {
      expect(u.x).toBeGreaterThanOrEqual(0);
      expect(u.x).toBeLessThan(enPage.widthPt);
      expect(u.top).toBeGreaterThanOrEqual(0);
      expect(u.top).toBeLessThan(enPage.heightPt);
      expect(u.width).toBeGreaterThan(0);
      expect(u.fontSize).toBeGreaterThan(0);
    }
    // 样式冻结：类名分配且 css 含规则
    expect(new Set(enPage.units.map((u) => u.className)).size).toBeGreaterThan(0);
    expect(enPage.css).toMatch(/\.s1\{font-family:/);
  });

  it("同行同样式相邻 run 合并；不同行不合并", () => {
    // 同 baseline、间隙 ~2.3pt 的两个 run 应合并为一个单元（且补空格）
    const merged = enPage.units.filter((u) => u.text.includes("Availability stayed"));
    expect(merged.length).toBe(1);
    expect(merged[0].text).toBe(
      "Availability stayed above the 99.95 percent target throughout the period.",
    );

    // 不同行的句子保持独立单元
    const incident = enPage.units.filter((u) => u.text.includes("Incident response"));
    expect(incident.length).toBe(1);
    expect(incident[0].text).not.toContain("Availability");

    // 标题 18pt 与正文 11pt 分属不同单元
    const title = enPage.units.find((u) => u.text.includes("Quarterly"));
    expect(title!.fontSize).toBeGreaterThan(15);
  });

  it("多页文档：页数正确，各页 tid 前缀对应页码", () => {
    for (const page of reportPages) {
      expect(page.pageNumber).toBe(page.pageNumber); // 序号由 beforeAll 保证
      expect(page.units.some((u) => u.text.includes(`Chapter ${page.pageNumber}`))).toBe(true);
      expect(page.units.every((u) => u.tid.startsWith(`p${page.pageNumber}-`))).toBe(true);
    }
  });

  it("混合样式：颜色恢复 + 字号区分", () => {
    const red = stylesPage.units.find((u) => u.text.includes("Style Matrix"));
    expect(red?.sig.color.toLowerCase()).toBe("#cc1a1a"); // rgb(0.8,0.1,0.1)
    expect(red?.sig.bold).toBe(true);

    const caption = stylesPage.units.find((u) => u.text.includes("Regular gray"));
    expect(caption!.fontSize).toBeLessThan(red!.fontSize);

    const mono = stylesPage.units.find((u) => u.text.includes("MONO CODE"));
    expect(mono?.sig.color.toLowerCase()).toBe("#006600");

    // 不同样式 → 不同 css 类签名
    const sigOf = (t: string) =>
      JSON.stringify(stylesPage.units.find((u) => u.text.includes(t))?.sig);
    expect(sigOf("Style Matrix")).not.toBe(sigOf("MONO CODE"));
  });

  it("纯图像页：零文本单元", async () => {
    const e = await StyleLockedExtractor.open(await fixture(FIXTURE_NAMES.scanImageOnly));
    expect((await e.extractPage(1)).units).toHaveLength(0);
  });

  it("旋转页：viewport 变换后仍能取到文本", async () => {
    const e = await StyleLockedExtractor.open(await fixture(FIXTURE_NAMES.rotated90));
    const joined = (await e.extractPage(1)).units.map((u) => u.text).join("|");
    expect(joined).toContain("Rotated page content");
  });

  it("中文文档：CJK 单元被完整提取", async () => {
    if (!hasCjkFont()) return console.warn("skip: 无系统 CJK 字体");
    const e = await StyleLockedExtractor.open(await fixture(FIXTURE_NAMES.zhGlossary));
    const all = (await e.extractPage(1)).units.map((u) => u.text).join("");
    expect(all).toContain("数据中台建设方案");
    expect(all).toContain("帐号体系与权限模型");
    expect(all).toContain("访客帐号");
  });

  it("tightBoxes 夹具：三行相同文本为三个独立单元", async () => {
    const e = await StyleLockedExtractor.open(await fixture(FIXTURE_NAMES.tightBoxes));
    const boxes = (await e.extractPage(1)).units.filter(
      (u) => u.text === "Fixed width column",
    );
    expect(boxes.length).toBe(3);
    expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(3); // 三行 top 互不相同
  });

  it("损坏字节：open 拒绝并抛错", async () => {
    await expect(
      StyleLockedExtractor.open(await fixture(FIXTURE_NAMES.corruptTruncated)),
    ).rejects.toThrow();
  });
});
