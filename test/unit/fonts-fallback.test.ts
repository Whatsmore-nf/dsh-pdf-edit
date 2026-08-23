import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { existsSync } from "node:fs";
import {
  FontResolver,
  toWinAnsiSafe,
} from "../../src/fonts-resolver.js";
import { loadCjkFaceBytes, hasCjkFont } from "../helpers/make-pdf.js";

const FREE_SANS = "/usr/share/fonts/gnu-free/FreeSans.otf";
const hasFreeSans = (): boolean => existsSync(FREE_SANS);

describe("fonts-resolver/fallbacks + resolveRuns", () => {
  it("resolveRuns：标准字体缺字（₂₃⁺⁻）按回退链拆到 FreeSans，其余留在主字体", async () => {
    if (!hasFreeSans()) return console.warn("skip: 无 FreeSans");
    const doc = await PDFDocument.create();
    const r = await FontResolver.create(doc, {
      fallbacks: [{ family: "freesans", path: FREE_SANS }],
    });

    const runs = await r.resolveRuns("KClO₃", "sans-serif", false, false);
    // KClO → Helvetica（标准字体），₃ → FreeSans（回退）
    expect(runs.length).toBeGreaterThanOrEqual(2);
    const latin = runs.find((rn) => rn.text.includes("KClO"));
    expect(latin?.rf.standard).toBe(true);
    const sub = runs.find((rn) => rn.text === "₃");
    expect(sub).toBeTruthy();
    expect(sub!.rf.standard).toBe(false);
    expect(sub!.rf.font.name).toContain("FreeSans");
    expect(runs.every((rn) => rn.covered)).toBe(true);
  });

  it("resolveRuns：CJK 主字体缺字时回退（Na₂O₂ 的 ₂ → FreeSans）", async () => {
    if (!hasCjkFont() || !hasFreeSans())
      return console.warn("skip: 无系统 CJK 或 FreeSans");
    const doc = await PDFDocument.create();
    const r = await FontResolver.create(doc, {
      cjk: { bytes: loadCjkFaceBytes() },
      cjkAutoDetect: false,
      fallbacks: [{ family: "freesans", path: FREE_SANS }],
    });

    const runs = await r.resolveRuns("Na₂O₂", "sans-serif", false, false);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    const subs = runs.filter((rn) => rn.text === "₂");
    expect(subs.length).toBe(2);
    for (const s of subs) {
      expect(s.rf.standard).toBe(false);
      expect(s.rf.font.name).toContain("FreeSans");
    }
    expect(runs.every((rn) => rn.covered)).toBe(true);
  });

  it("hasGlyph：全覆盖为 true；任何字体都没有的字符为 false", async () => {
    if (!hasFreeSans()) return console.warn("skip: 无 FreeSans");
    const doc = await PDFDocument.create();
    const r = await FontResolver.create(doc, {
      fallbacks: [{ family: "freesans", path: FREE_SANS }],
    });

    expect(await r.hasGlyph("KClO₃ + 6HCl", "sans-serif", false, false)).toBe(
      true,
    );
    // U+E000 私用区：Helvetica 与 FreeSans 都没有
    expect(await r.hasGlyph("\uE000", "sans-serif", false, false)).toBe(false);
  });

  it("未配置 fallbacks 时缺字字符归入主字体并标记 covered=false", async () => {
    const doc = await PDFDocument.create();
    const r = await FontResolver.create(doc);
    const runs = await r.resolveRuns("H₂O", "sans-serif", false, false);
    // ₂ 不在 Helvetica（WinAnsi）→ 无回退 → covered=false
    const sub = runs.find((rn) => rn.text === "₂");
    expect(sub).toBeTruthy();
    expect(sub!.covered).toBe(false);
    expect(await r.hasGlyph("H₂O", "sans-serif", false, false)).toBe(false);
  });

  it("标准字体覆盖判断与 WinAnsi 清洗一致", () => {
    expect(toWinAnsiSafe("₂")).toBe("?");
    expect(toWinAnsiSafe("A")).toBe("A");
  });
});
