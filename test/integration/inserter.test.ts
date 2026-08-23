import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import {
  insertPages,
  parseMarkdownBlocks,
  type PageInsertion,
} from "../../src/inserter.js";
import { multipageReport, hasCjkFont, loadCjkFaceBytes } from "../helpers/make-pdf.js";

const FREE_SANS = "/usr/share/fonts/gnu-free/FreeSans.otf";

describe("inserter/parseMarkdownBlocks", () => {
  it("识别标题/段落/要点/子要点/公式/分隔线", () => {
    const blocks = parseMarkdownBlocks(
      [
        "## 小节标题",
        "",
        "普通段落文本。",
        "- 要点一",
        "  - 子要点",
        "- 要点二",
        "eq: 2H⁺ + SO₄²⁻ + Ba²⁺ = BaSO₄↓",
        "",
        "---",
        "结尾段落",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.t)).toEqual([
      "h2",
      "gap",
      "p",
      "b",
      "b2",
      "b",
      "eq",
      "gap",
      "p",
    ]);
    expect(blocks.find((b) => b.t === "eq")!.s).toBe(
      "2H⁺ + SO₄²⁻ + Ba²⁺ = BaSO₄↓",
    );
    expect(blocks.find((b) => b.t === "b2")!.s).toBe("子要点");
  });
});

describe("inserter/insertPages", () => {
  it("插入到指定页之后：原页内容不变，插入页含标题/正文/公式，支持多处插入", async () => {
    if (!hasCjkFont()) return console.warn("skip: 无系统 CJK 字体");
    const src = await multipageReport(3);

    const insertions: PageInsertion[] = [
      {
        afterPage: 1,
        title: "补充一：插入测试",
        caption: "模块甲｜插入位置：第 1 页之后",
        blocks: [
          { t: "p", s: "这是一段补充正文内容。" },
          { t: "eq", s: "2H⁺ + SO₄²⁻ + Ba²⁺ + 2OH⁻ = BaSO₄↓ + 2H₂O" },
          { t: "b", s: "第一个要点。" },
          { t: "h2", s: "子节" },
          { t: "p", s: "子节下的段落。" },
        ],
      },
      {
        afterPage: 2,
        title: "补充二",
        blocks: [{ t: "p", s: "第二处补充内容。" }],
      },
    ];

    const res = await insertPages(src, insertions, {
      fonts: {
        cjk: { bytes: loadCjkFaceBytes() },
        cjkAutoDetect: false,
        fallbacks: existsSync(FREE_SANS)
          ? [{ family: "freesans", path: FREE_SANS }]
          : [],
      },
    });
    expect(res.insertedPages).toBe(2);
    expect(res.totalPages).toBe(5);

    const { StyleLockedExtractor } = await import("../../src/extractor.js");
    const out = await StyleLockedExtractor.open(res.bytes);
    const srcEx = await StyleLockedExtractor.open(src);

    // 原第 1 页（新位置 1）与第 2 页（新位置 3）内容保持不变
    const orig1 = (await out.extractPage(1)).units.map((u) => u.text).join("");
    const orig3 = (await out.extractPage(3)).units.map((u) => u.text).join("");
    expect(orig1).toBe(
      (await srcEx.extractPage(1)).units.map((u) => u.text).join(""),
    );
    expect(orig3).toBe(
      (await srcEx.extractPage(2)).units.map((u) => u.text).join(""),
    );

    // 插入页内容
    const ins1 = (await out.extractPage(2)).units.map((u) => u.text).join("");
    expect(ins1).toContain("补充一：插入测试");
    expect(ins1).toContain("这是一段补充正文内容");
    expect(ins1).toContain("第一个要点");
    expect(ins1).toContain("子节");
    if (existsSync(FREE_SANS)) expect(ins1).toContain("BaSO₄");
    else expect(ins1).toContain("BaSO");
    const ins2 = (await out.extractPage(4)).units.map((u) => u.text).join("");
    expect(ins2).toContain("补充二");
    expect(ins2).toContain("第二处补充内容");
  });

  it("超长内容自动跨页，续页带（续）标记", async () => {
    const src = await multipageReport(3);
    const longBlocks: PageInsertion["blocks"] = [];
    for (let i = 0; i < 60; i++) {
      longBlocks.push({ t: "p", s: `这是第 ${i + 1} 条很长的补充内容行，用来撑满一页以上。` });
    }
    const res = await insertPages(src, [
      { afterPage: 1, title: "超长补充", blocks: longBlocks },
    ], {
      fonts: {
        cjk: { bytes: loadCjkFaceBytes() },
        cjkAutoDetect: false,
        fallbacks: existsSync(FREE_SANS)
          ? [{ family: "freesans", path: FREE_SANS }]
          : [],
      },
    });
    expect(res.insertedPages).toBeGreaterThanOrEqual(2);
    expect(res.totalPages).toBe(3 + res.insertedPages);

    const { StyleLockedExtractor } = await import("../../src/extractor.js");
    const out = await StyleLockedExtractor.open(res.bytes);
    const all = (
      await out.extractPage(res.insertedPages + 1) // 最后一页插入页
    ).units.map((u) => u.text).join("");
    expect(all).toContain("（续）");
    // 内容完整（第 60 条在最后一页）
    expect(all.replace(/\s+/g, "")).toContain("60条很长的补充内容");
  });
});
