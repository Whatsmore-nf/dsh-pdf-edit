import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { StyleLockedEditor } from "../../src/pipeline.js";
import {
  fixture,
  FIXTURE_NAMES,
  hasCjkFont,
  loadCjkFaceBytes,
  tightBoxes,
} from "../helpers/make-pdf.js";
import {
  scriptedChat,
  alwaysFails,
  type ReplaceRule,
} from "../helpers/chat-mock.js";

/* 从编辑结果中重新提取，供断言 */
async function reExtract(bytes: Uint8Array) {
  const { StyleLockedExtractor } = await import("../../src/extractor.js");
  const ex = await StyleLockedExtractor.open(bytes);
  const pages = [];
  for (let p = 1; p <= ex.pageCount; p++) pages.push(await ex.extractPage(p));
  return { extractor: ex, pages };
}

describe("pipeline/editPage（native 模式）", () => {
  it("只改目标 tid；新文本原位覆盖，未改动单元样式零漂移", async () => {
    const bytes = await fixture(FIXTURE_NAMES.enBasic);
    const chat = scriptedChat([
      { match: "99.95 percent", to: (t) => t.replace("99.95", "99.99") },
    ]);
    const editor = await StyleLockedEditor.open(bytes, chat);

    const before = await editor.previewPage(1);
    const target = before.find((u) => u.text.includes("99.95 percent"))!;

    // 完整单元（含坐标）直接从提取器获取
    const { StyleLockedExtractor } = await import("../../src/extractor.js");
    const beforeUnits = (
      await (await StyleLockedExtractor.open(bytes)).extractPage(1)
    ).units;
    const targetFull = beforeUnits.find((u) => u.tid === target.tid)!;

    const outBytes = await editor.editPage(1, "更新可用率", [target.tid]);
    expect(editor.lastFailures).toHaveLength(0);

    const { pages } = await reExtract(outBytes);
    const afterUnits = pages[0].units;

    // 新文本以叠加方式出现（native 模式不重写内容流）
    const changedAfter = afterUnits.find((u) => u.text.includes("99.99"));
    expect(changedAfter).toBeDefined();
    expect(changedAfter!.x).toBeCloseTo(targetFull.x, 1);

    // 未改动单元：以 (x,top,text) 三元组在编辑后文档中寻回，样式必须零漂移
    const beforeKey = new Map(
      beforeUnits
        .filter((u) => u.tid !== target.tid)
        .map((u) => [
          `${Math.round(u.x * 4)}:${Math.round(u.top * 4)}|${u.text}`,
          u,
        ]),
    );
    let compared = 0;
    for (const au of afterUnits) {
      const bu = beforeKey.get(
        `${Math.round(au.x * 4)}:${Math.round(au.top * 4)}|${au.text}`,
      );
      if (!bu) continue;
      compared++;
      expect(au.fontSize).toBe(bu.fontSize);
      expect(au.sig.color).toBe(bu.sig.color);
    }
    expect(compared).toBeGreaterThan(2);
  });
});

describe("pipeline/editDocument（native 模式）", () => {
  it("多页全量编辑 + 进度阶段回调完整", async () => {
    const bytes = await fixture(FIXTURE_NAMES.report3p);
    const rules: ReplaceRule[] = [
      {
        match: "lorem ipsum dolor",
        to: (t) =>
          t.replace(
            "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.",
            "EDITED TEXT HERE (overlay keeps original run beneath)",
          ),
      },
    ];
    const editor = await StyleLockedEditor.open(bytes, scriptedChat(rules));

    const stages: string[] = [];
    const outBytes = await editor.editDocument("替换占位文本", (info) =>
      stages.push(info.stage),
    );

    expect(stages[0]).toBe("render");
    expect(stages.at(-1)).toBe("merge");
    expect(editor.lastFailures).toHaveLength(0);

    const { pages } = await reExtract(outBytes);
    expect(pages).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const joined = pages[i].units.map((u) => u.text).join("");
      expect(joined).toContain(`EDITED TEXT HERE`); // 新文本已叠加
      expect(joined).toContain(`Chapter ${i + 1}: Section Title`); // 未编辑单元原样
      expect(joined).toContain(`- ${i + 1} -`); // 页脚未被波及
    }
  });

  it("AI 整批失败：该批页面沿用原文且记录 lastFailures（retryBaseMs=0 消除退避等待）", async () => {
    const bytes = await fixture(FIXTURE_NAMES.report3p);
    const editor = await StyleLockedEditor.open(bytes, alwaysFails, {
      retryBaseMs: 0,
    });
    const outBytes = await editor.editDocument("任意指令");

    expect(editor.lastFailures.map((f) => f.page).sort()).toEqual([1, 2, 3]);

    const { pages } = await reExtract(outBytes);
    expect(pages).toHaveLength(3);
    expect(pages[0].units.map((u) => u.text).join("")).toContain("Chapter 1");
  });

  it.each([
    ["shrink", "Much longer replacement text that exceeds the fixed column"],
    ["reject", "A vastly longer replacement sentence that cannot possibly fit"],
  ] as const)("溢出策略 %s：端到端行为符合策略承诺", async (mode, longText) => {
    const { bytes } = await tightBoxes();
    const editor = await StyleLockedEditor.open(
      bytes,
      scriptedChat([{ match: "Fixed width column", to: () => longText }]),
      { overflow: { mode, minFontSizePt: 6 } },
    );
    const outBytes = await editor.editPage(1, "加长");

    const { pages } = await reExtract(outBytes);
    if (mode === "shrink") {
      const edited = pages[0].units.filter((u) => u.text.includes("Much longer"));
      expect(edited.length).toBeGreaterThan(0);
      for (const u of edited) {
        expect(u.fontSize).toBeLessThanOrEqual(11); // 缩放后不超过原字号
        expect(u.fontSize).toBeGreaterThanOrEqual(6);
      }
    } else {
      // reject：三行原文保持不变
      expect(
        pages[0].units.filter((u) => u.text === "Fixed width column").length,
      ).toBe(3);
    }
  });

  it("旋转页 native 直绘失败被捕获进 lastFailures，不崩溃", async () => {
    const bytes = await fixture(FIXTURE_NAMES.rotated90);
    const editor = await StyleLockedEditor.open(
      bytes,
      scriptedChat([{ match: "Rotated page content", to: "ROTATED EDITED" }]),
    );
    const outBytes = await editor.editPage(1, "修改");
    expect(editor.lastFailures.length).toBe(1);
    expect(String(editor.lastFailures[0].error)).toContain("旋转页");

    const joined = (await reExtract(outBytes)).pages[0].units
      .map((u) => u.text)
      .join("|");
    expect(joined).toContain("Rotated page content"); // 原文保留
  });

  it("纯图像页：editDocument 跳过且输出有效", async () => {
    const bytes = await fixture(FIXTURE_NAMES.scanImageOnly);
    const editor = await StyleLockedEditor.open(bytes, alwaysFails);
    const parsed = await PDFDocument.load(await editor.editDocument("无效指令"));
    expect(parsed.getPageCount()).toBe(1);
  });
});

describe("pipeline/CJK 回写", () => {
  it("术语表跨页生效（glossary 全局替换）", async () => {
    if (!hasCjkFont()) return console.warn("skip: 无系统 CJK 字体");
    const bytes = await fixture(FIXTURE_NAMES.zhGlossary);
    const editor = await StyleLockedEditor.open(bytes, scriptedChat([]), {
      glossary: { 帐号: "账号" },
      fonts: { cjk: { bytes: loadCjkFaceBytes() } }, // 中文回写需要可嵌入的 CJK 字体
    });
    const outBytes = await editor.editDocument("统一术语");

    const all = (await reExtract(outBytes))
      .pages.flatMap((p) => p.units.map((u) => u.text))
      .join("");
    expect(all).toContain("账号体系");
    expect(all).toContain("访客账号");
  });
});

describe("pipeline/relayout（native 重排版）", () => {
  // 三种模板共用同一条 flow 渲染路径，仅主题 CSS 不同 → 抽查两种即可覆盖
  it.each(["academic", "mobile"] as const)(
    "模板 %s：产出可解析的新文档并保留元数据",
    async (tpl) => {
      const bytes = await fixture(FIXTURE_NAMES.report2p);
      const editor = await StyleLockedEditor.open(bytes, scriptedChat([]));
      const outBytes = await editor.relayout(tpl);

      const { PDFDocument } = await import("pdf-lib");
      const doc = await PDFDocument.load(outBytes);
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
      expect(doc.getTitle()).toBe("Multipage Report"); // replaceEntireDocument 元数据回填

      const all = (await reExtract(outBytes)).pages
        .flatMap((p) => p.units.map((u) => u.text))
        .join("");
      expect(all).toContain("Section Title");
    },
    60_000,
  );
});

describe("pipeline/browser 模式守卫与基础契约", () => {
  it("未配置 browserExecutablePath 时给出明确错误", async () => {
    const bytes = await fixture(FIXTURE_NAMES.enBasic);
    const editor = await StyleLockedEditor.open(
      bytes,
      scriptedChat([{ match: "Quarterly", to: "X" }]),
      { renderMode: "browser" },
    );
    await expect(editor.editPage(1, "改")).rejects.toThrow(/browserExecutablePath/);
    await editor.close();
  });

  it("docHash 稳定；previewPage 幂等", async () => {
    const bytes = await fixture(FIXTURE_NAMES.enBasic);
    const e1 = await StyleLockedEditor.open(bytes, scriptedChat([]));
    const e2 = await StyleLockedEditor.open(bytes, scriptedChat([]));
    expect(e1.docHash).toBe(e2.docHash);
    expect(await e1.previewPage(1)).toEqual(await e1.previewPage(1));
  });
});
