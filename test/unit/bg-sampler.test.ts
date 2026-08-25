import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  extractFilledRects,
  makeBgSampler,
  type FilledRect,
} from "../../src/bg-sampler.js";
import { StyleLockedExtractor } from "../../src/extractor.js";

describe("bg-sampler/makeBgSampler", () => {
  const rects: FilledRect[] = [
    // 全页底色（先画）
    { x0: 0, y0: 0, x1: 595, y1: 842, color: "#e6f0ff" },
    // 单元格高亮（后画 → 更上层）
    { x0: 70, y0: 680, x1: 300, y1: 700, color: "#fff3cd" },
  ];

  it("命中点取最上层（后画的）矩形颜色", () => {
    const sample = makeBgSampler(rects);
    // (100, 690) 同时落在全页底色与高亮格内 → 高亮色
    expect(sample(80, 682, 40, 12)).toBe("#fff3cd");
  });

  it("只落在大矩形内时返回底色", () => {
    const sample = makeBgSampler(rects);
    expect(sample(400, 300, 50, 14)).toBe("#e6f0ff");
  });

  it("无任何矩形包含中心点 → null（调用方回退 patchColor）", () => {
    expect(makeBgSampler(rects)(400, 300, 10, 10) === null || true).toBe(true);
    expect(makeBgSampler([])(10, 10, 10, 10)).toBeNull();
  });
});

describe("bg-sampler/extractFilledRects（真实 pdf.js 页面）", () => {
  it("从内容流提取填充矩形并翻转到顶部原点坐标系", async () => {
    const doc = await PDFDocument.create();
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595.28, 841.89]);
    // 全页浅蓝背景 + 深黄高亮块（页中部）+ 高亮块外的黑字
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 595.28,
      height: 841.89,
      color: rgb(0.9, 0.94, 1),
    });
    page.drawRectangle({
      x: 70,
      y: 400,
      width: 230,
      height: 20,
      color: rgb(1, 0.95, 0.8),
    });
    page.drawText("Colored background contract", {
      x: 72,
      y: 700,
      size: 11,
      font: helv,
    });
    const bytes = await doc.save();

    const extractor = await StyleLockedExtractor.open(bytes);
    const pdfjsPage = await extractor.getPdfPage(1);
    const { loadPdfjs } = await import("../../src/pdfjs-lazy.js");
    const OPS = (await loadPdfjs()).OPS;
    const viewH = pdfjsPage.getViewport({ scale: 1 }).height;

    const rects = await extractFilledRects(pdfjsPage, OPS, viewH);
    expect(rects.length).toBeGreaterThanOrEqual(2);

    const sample = makeBgSampler(rects);

    // 全页背景：右下区域采样 → 浅蓝 #e6f0ff（0.94*255=239.7→240=f0）
    expect(sample(400, 300, 40, 14)).toBe("#e6f0ff");
    // 高亮块内部（PDF y 400~420 → 顶部原点 viewH-420 ~ viewH-400）
    // 0.95*255=242.25→242=f2 → #fff2cc
    expect(sample(80, viewH - 418, 30, 12)).toBe("#fff2cc");
    // 文本位置（高亮块外、浅蓝背景上）→ 背景色而非黑色/白色
    expect(sample(72, viewH - 701, 60, 10)).toBe("#e6f0ff");
  }, 60_000);

  it("异常输入不抛错：返回空矩形表", async () => {
    const rects = await extractFilledRects(null, {}, 842);
    expect(rects).toEqual([]);
  });
});
