/**
 * 确定性的 PDF fixture 生成器（pdf-lib 直绘）。
 * 所有生成器都是纯函数：相同输入永远产出相同字节序列（除 pdf-lib 自动写入的时间戳），
 * 保证测试与基准可复现。
 */
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { existsSync, readFileSync } from "node:fs";
import type { PDFPage } from "pdf-lib";

export type PdfBytes = Uint8Array;

/* ------------------------------------------------------------------ */
/* 统一命名规范                                                        */
/* ------------------------------------------------------------------ */

/**
 * 统一命名规范：
 *   gen-<内容>-<特征>-<页数>p.pdf   自建确定性夹具
 *   real-<来源>-<描述>.pdf          外部下载样例（见 fixtures/fetch-samples.sh）
 *   <case-id>/{original,edited}.pdf benchmark 产物（run.mjs）
 *
 * 所有导出的生成器均做了进程内缓存，重复调用零成本；
 * 需要落盘复核时执行 `npm run fixtures`。
 */
export const FIXTURE_NAMES = {
  enBasic: "gen-en-basic-1p.pdf",
  zhGlossary: "gen-zh-glossary-1p.pdf",
  report5p: "gen-report-times-5p.pdf",
  report3p: "gen-report-times-3p.pdf",
  report2p: "gen-report-times-2p.pdf",
  stylesMatrix: "gen-styles-matrix-1p.pdf",
  tightBoxes: "gen-tight-boxes-1p.pdf",
  rotated90: "gen-rotated-90-1p.pdf",
  scanImageOnly: "gen-scan-image-only-1p.pdf",
  corruptTruncated: "gen-corrupt-truncated.bin",
  mixedZhEn3p: "gen-mixed-zh-en-3p.pdf",
} as const;

/** 名称 → 构建器注册表（各生成器自带缓存，这里只做名字映射）。 */
export const FIXTURES: Record<string, () => Promise<PdfBytes>> = {};

/* ------------------------------------------------------------------ */
/* CJK 字体探测                                                        */
/* ------------------------------------------------------------------ */

const CJK_CANDIDATES = [
  process.env.TEST_CJK_FONT,
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/wenquanyi/wqy-zenhei/wqy-zenhei.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\msyh.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/System/Library/Fonts/Supplemental/Songti.ttc",
].filter((p): p is string => !!p && existsSync(p));

export const cjkFontPath = (): string | null => CJK_CANDIDATES[0] ?? null;
export const hasCjkFont = (): boolean => cjkFontPath() !== null;

// 11MB 级 TTC 读取+拆包开销大，进程内只做一次
let _cjkFace: Uint8Array | null = null;

/** 加载 CJK 字体字节（进程内缓存）；TTC 集合拆出第 0 个 face（与 fonts-resolver 的修复一致）。 */
export function loadCjkFaceBytes(): Uint8Array {
  if (_cjkFace) return _cjkFace;
  const p = cjkFontPath();
  if (!p) throw new Error("系统无可用 CJK 字体，跳过相关用例");
  let bytes = new Uint8Array(readFileSync(p));
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x74 && bytes[1] === 0x74 &&
    bytes[2] === 0x63 && bytes[3] === 0x66
  ) {
    bytes = ttcFace(bytes, 0);
  }
  return (_cjkFace = bytes);
}

function ttcFace(ttc: Uint8Array, index: number): Uint8Array {
  const dv = new DataView(ttc.buffer, ttc.byteOffset, ttc.byteLength);
  const num = dv.getUint32(8);
  if (index >= num) throw new Error(`TTC 只有 ${num} 个 face`);
  const off = dv.getUint32(12 + index * 4);
  const numTables = dv.getUint16(off + 4);

  const entries: Array<{ o: number; len: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const e = off + 12 + i * 16;
    entries.push({ o: dv.getUint32(e + 8), len: dv.getUint32(e + 12) });
  }
  const dirSize = 12 + numTables * 16;
  let bodySize = 0;
  for (const t of entries) bodySize += Math.ceil(t.len / 4) * 4;

  const out = new Uint8Array(dirSize + bodySize);
  out.set(ttc.subarray(off, off + dirSize), 0);
  const odv = new DataView(out.buffer);
  let p = dirSize;
  for (let i = 0; i < numTables; i++) {
    const t = entries[i];
    out.set(ttc.subarray(t.o, t.o + t.len), p);
    odv.setUint32(12 + i * 16 + 8, p);
    p += Math.ceil(t.len / 4) * 4;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 基础绘制工具                                                        */
/* ------------------------------------------------------------------ */

// 夹具是确定性的 → 进程内只生成一次，多处测试共享同一字节
const memo = new Map<string, Promise<PdfBytes>>();
function cached(key: string, build: () => Promise<PdfBytes>): () => Promise<PdfBytes> {
  return () => {
    if (!memo.has(key)) memo.set(key, build());
    return memo.get(key)!;
  };
}

interface Line {
  text: string;
  x: number;
  y: number; // baseline（PDF 坐标系，自页底起）
  size: number;
  font: "helv" | "helvB" | "helvI" | "times" | "timesB" | "courier";
  color?: [number, number, number];
}

async function buildDoc(
  pages: Line[][], // 每个元素 = 一页的行数组
  opts: {
    widthPt?: number;
    heightPt?: number;
    title?: string;
    author?: string;
    rotateLastBy?: number;
    embedCjk?: boolean;
  } = {},
): Promise<PdfBytes> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  const fonts: Record<string, StandardFonts> = {
    helv: StandardFonts.Helvetica,
    helvB: StandardFonts.HelveticaBold,
    helvI: StandardFonts.HelveticaOblique,
    times: StandardFonts.TimesRoman,
    timesB: StandardFonts.TimesRomanBold,
    courier: StandardFonts.Courier,
  };
  const std: Record<string, Awaited<ReturnType<PDFDocument["embedFont"]>>> = {};
  for (const [k, f] of Object.entries(fonts)) std[k] = await doc.embedFont(f);

  let cjk: Awaited<ReturnType<PDFDocument["embedFont"]>> | null = null;
  if (opts.embedCjk) {
    cjk = await doc.embedFont(loadCjkFaceBytes());
  }

  const width = opts.widthPt ?? 595.28;
  const height = opts.heightPt ?? 841.89;

  pages.forEach((lines, pi) => {
    const page: PDFPage = doc.addPage([width, height]);
    const isRotated =
      opts.rotateLastBy && pi === pages.length - 1
        ? opts.rotateLastBy
        : undefined;
    if (isRotated) page.setRotation(degrees(isRotated));

    for (const l of lines) {
      const font = hasCJK(l.text) && cjk ? cjk : std[l.font];
      page.drawText(l.text, {
        x: l.x,
        y: l.y,
        size: l.size,
        font,
        color: rgb(...(l.color ?? [0.1, 0.1, 0.1])),
      });
    }
  });

  if (opts.title) doc.setTitle(opts.title);
  if (opts.author) doc.setAuthor(opts.author);

  return doc.save();
}

const hasCJK = (s: string): boolean =>
  /[\u2E80-\u9FFF\uF900-\uFAFF]/.test(s);

/* ------------------------------------------------------------------ */
/* 各类 fixture                                                        */
/* ------------------------------------------------------------------ */

/** 1. 英文单页：标题 + 多段正文；其中一段拆成同 baseline 相邻两个 run（测合并） */
async function buildEnglishBasic(): Promise<PdfBytes> {
  const L = (
    text: string,
    y: number,
    extra: Partial<Line> = {},
  ): Line => ({ text, x: 72, y, size: 11, font: "helv", ...extra });

  // 预量第一段 run 宽度，使第二段紧随其后（间隙 ~2.3pt，可被 mergeRuns 合并）
  const probe = await PDFDocument.create();
  const helvProbe = await probe.embedFont(StandardFonts.Helvetica);
  const run1 = "Availability stayed above the 99.95 percent";
  const w1 = helvProbe.widthOfTextAtSize(run1, 11);

  return buildDoc([
    [
      L("Quarterly Operations Review", 760, {
        size: 18,
        font: "helvB",
        x: 72,
      }),
      L("Prepared by the platform engineering group.", 730),
      L(
        "This report summarizes system availability, incident response times and capacity planning for the second quarter.",
        706,
      ),
      L(run1, 690),
      // 间隙 ~2.3pt：超过 spaceGapFactor(0.18)*11≈1.98 → 合并时补空格；
      // 低于 maxGapFactor(0.45)*11≈4.95 → 仍会合并
      { text: "target throughout the period.", x: 72 + w1 + 4, y: 690, size: 11, font: "helv" },
      L(
        "Incident response improved after the on-call rotation was expanded to five engineers.",
        674,
      ),
      L("Next quarter will focus on multi-region failover drills.", 658),
    ],
  ], { title: "Quarterly Operations Review", author: "Platform Engineering" });
}
/** 确定性缓存：同进程内多次调用共享同一字节。 */
export const englishBasic = cached("gen-en-basic-1p.pdf", buildEnglishBasic);

/** 2. 中文文档：含错别字「帐号」与术语「数据中台」，供术语统一/纠错用例 */
async function buildChineseDoc(): Promise<PdfBytes> {
  const L = (text: string, y: number, extra: Partial<Line> = {}): Line => ({
    text,
    x: 72,
    y,
    size: 12,
    font: "helv",
    ...extra,
  });

  return buildDoc(
    [
      [
        L("数据中台建设方案", 760, { size: 20, font: "helvB" }),
        L("第一章 总体目标", 720, { size: 14, font: "helvB" }),
        L("本项目旨在统一公司内部的数据资产管理，帐号体系与权限模型将全部迁移。", 700),
        L("数据中台将为各业务线提供实时查询能力，预计降低重复开发成本百分之三十。", 682),
        L("第二章 实施计划", 650, { size: 14, font: "helvB" }),
        L("第一阶段完成帐号打通与元数据采集；第二阶段上线指标口径管理平台。", 630),
        L("所有成员须使用企业邮箱注册帐号，外部协作者使用访客帐号。", 612),
      ],
    ],
    { title: "数据中台建设方案", embedCjk: true },
  );
}
export const chineseDoc = cached(FIXTURE_NAMES.zhGlossary, buildChineseDoc);

/** 3. 多页报告（默认 5 页）：标题/正文/页脚，带元数据（按页数缓存） */
const reportCache = new Map<number, Promise<PdfBytes>>();
export function multipageReport(pageCount = 5): Promise<PdfBytes> {
  if (!reportCache.has(pageCount)) {
    reportCache.set(pageCount, buildReport(pageCount));
  }
  return reportCache.get(pageCount)!;
}

function buildReport(pageCount: number): Promise<PdfBytes> {
  const pages: Line[][] = [];
  for (let p = 1; p <= pageCount; p++) {
    const lines: Line[] = [];
    lines.push({
      text: `Chapter ${p}: Section Title`,
      x: 72,
      y: 760,
      size: 16,
      font: "timesB",
    });
    for (let i = 0; i < 6; i++) {
      lines.push({
        text: `Page ${p} line ${i + 1}: lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.`,
        x: 72,
        y: 730 - i * 22,
        size: 10.5,
        font: "times",
      });
    }
    lines.push({
      text: `- ${p} -`,
      x: 290,
      y: 40,
      size: 9,
      font: "courier",
    });
    pages.push(lines);
  }
  return buildDoc(pages, { title: "Multipage Report", author: "Fixture Bot" });
}

/** 4. 混合样式：多字号、多颜色、粗斜体、等宽 —— 冻结样式/颜色恢复用例 */
async function buildStyledMixed(): Promise<PdfBytes> {
  const lines: Line[] = [
    { text: "Style Matrix", x: 60, y: 750, size: 22, font: "helvB", color: [0.8, 0.1, 0.1] },
    { text: "Regular gray caption text", x: 60, y: 715, size: 9, font: "helv", color: [0.45, 0.45, 0.45] },
    { text: "Bold statement in black", x: 60, y: 685, size: 13, font: "helvB" },
    { text: "Italic serif quotation", x: 60, y: 655, size: 12, font: "times" },
    { text: "MONO CODE 42", x: 60, y: 625, size: 11, font: "courier", color: [0, 0.4, 0] },
    { text: "Small print legal notice", x: 60, y: 595, size: 7, font: "helv", color: [0.6, 0.6, 0.6] },
    { text: "Big blue finale", x: 60, y: 550, size: 17, font: "helvB", color: [0.05, 0.2, 0.75] },
  ];
  return buildDoc([lines]);
}
export const styledMixed = cached(FIXTURE_NAMES.stylesMatrix, buildStyledMixed);

/**
 * 5. 紧凑列：每行是独立短单元且行距大（不会被合并），
 * 用于溢出策略（shrink/clip/wrap/reject）端到端测试。
 */
export async function tightBoxes(): Promise<{ bytes: PdfBytes; boxText: string }> {
  return {
    bytes: await fixture(FIXTURE_NAMES.tightBoxes),
    boxText: "Fixed width column",
  };
}

async function buildTightBoxes(): Promise<PdfBytes> {
  const lines: Line[] = [{ text: "Overflow Lab", x: 60, y: 750, size: 16, font: "helvB" }];
  // 三行相同文本，间隔足够大 → 提取后应为三个独立 unit
  [700, 640, 580].forEach((y) => {
    lines.push({ text: "Fixed width column", x: 60, y, size: 11, font: "helv" });
  });
  return buildDoc([lines]);
}
// 注册表项指向真正的构建器（tightBoxes() 从这里取缓存字节）
FIXTURES[FIXTURE_NAMES.tightBoxes] = cached(FIXTURE_NAMES.tightBoxes, buildTightBoxes);

/** 6. 旋转页（/Rotate 90）：native 直绘应记录失败而不崩溃 */
async function buildRotatedPage(): Promise<PdfBytes> {
  const lines: Line[] = [
    { text: "Rotated page content", x: 100, y: 400, size: 14, font: "helv" },
  ];
  return buildDoc([lines], { rotateLastBy: 90 });
}
export const rotatedPage = cached(FIXTURE_NAMES.rotated90, buildRotatedPage);

/** 7. 纯图像页（模拟扫描件）：无文本 → 提取零单元 */
async function buildImageOnlyScan(): Promise<PdfBytes> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawRectangle({
    x: 50,
    y: 50,
    width: 495,
    height: 741,
    color: rgb(0.92, 0.92, 0.9),
  });
  page.drawRectangle({ x: 70, y: 600, width: 300, height: 24, color: rgb(0.5, 0.5, 0.55) });
  page.drawRectangle({ x: 70, y: 560, width: 420, height: 8, color: rgb(0.6, 0.6, 0.6) });
  page.drawRectangle({ x: 70, y: 536, width: 380, height: 8, color: rgb(0.6, 0.6, 0.6) });
  return doc.save();
}
export const imageOnlyScan = cached(FIXTURE_NAMES.scanImageOnly, buildImageOnlyScan);

/** 9. 损坏文件：截断的合法 PDF 头 */
export function corruptBytes(): PdfBytes {
  const head = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n1 0 obj");
  return head.slice();
}

/** 10. 中英混排长文档（benchmark 主用例）：3 页，混合样式 + 中文段落 */
async function buildBenchmarkMixedDoc(): Promise<PdfBytes> {
  const zhLines: Line[] = [
    { text: "智能文档处理平台白皮书", x: 64, y: 770, size: 19, font: "helvB" },
    { text: "摘要：本白皮书介绍帐号体系、数据中台与智能校对能力的整体架构。", x: 64, y: 738, size: 11, font: "helv" },
    { text: "1. 背景与挑战", x: 64, y: 706, size: 14, font: "helvB" },
    { text: "企业在数字化转型过程中积累了大量非结构化文档，人工校对成本高、周期长。", x: 64, y: 686, size: 11, font: "helv" },
    { text: "传统的 OCR 方案只能解决文字识别问题，无法保证修改后的版式一致性。", x: 64, y: 668, size: 11, font: "helv" },
    { text: "2. 核心设计", x: 64, y: 636, size: 14, font: "helvB" },
    { text: "平台采用“提取—修改—回写”三段式流水线，在回写阶段锁定字体、字号与位置。", x: 64, y: 616, size: 11, font: "helv" },
    { text: "当新文本长度超出原文本框时，按预设策略缩放或截断，避免破坏相邻版面。", x: 64, y: 598, size: 11, font: "helv" },
  ];

  const enLines: Line[] = [
    { text: "Appendix A: Deployment Notes", x: 64, y: 500, size: 15, font: "timesB", color: [0.2, 0.2, 0.55] },
    { text: "The cluster runs three replicas per service behind a regional load balancer.", x: 64, y: 476, size: 10.5, font: "times" },
    { text: "Rolling updates complete within eight minutes at the ninety-ninth percentile.", x: 64, y: 460, size: 10.5, font: "times" },
    { text: "Alert routing integrates with the on-call schedule via webhooks.", x: 64, y: 444, size: 10.5, font: "times" },
  ];

  return buildDoc(
    [zhLines, enLines, zhLines.map((l) => ({ ...l, y: l.y - 20 }))],
    { title: "智能文档处理平台白皮书", author: "DSH Benchmark", embedCjk: true },
  );
}
export const benchmarkMixedDoc = cached(
  FIXTURE_NAMES.mixedZhEn3p,
  buildBenchmarkMixedDoc,
);

/* ------------------------------------------------------------------ */
/* 注册表收尾 + 落盘工具                                                */
/* ------------------------------------------------------------------ */

// 各生成器定义完毕后统一登记
// 注意：tightBoxes 已在上方用 cached(buildTightBoxes) 覆盖注册表项，此处不再登记，
// 否则会覆盖回「tightBoxes()→fixture()」的互相递归。
Object.assign(FIXTURES, {
  [FIXTURE_NAMES.enBasic]: englishBasic,
  [FIXTURE_NAMES.zhGlossary]: chineseDoc,
  [FIXTURE_NAMES.report5p]: () => multipageReport(5),
  [FIXTURE_NAMES.report3p]: () => multipageReport(3),
  [FIXTURE_NAMES.report2p]: () => multipageReport(2),
  [FIXTURE_NAMES.stylesMatrix]: styledMixed,
  [FIXTURE_NAMES.rotated90]: rotatedPage,
  [FIXTURE_NAMES.scanImageOnly]: imageOnlyScan,
  [FIXTURE_NAMES.corruptTruncated]: async () => corruptBytes(),
  [FIXTURE_NAMES.mixedZhEn3p]: benchmarkMixedDoc,
});

/** 按统一文件名取夹具字节。 */
export function fixture(name: string): Promise<PdfBytes> {
  const build = FIXTURES[name];
  if (!build) throw new Error(`未知夹具：${name}（可用：${Object.keys(FIXTURES).join(", ")}）`);
  return build();
}

/** 把全部自建夹具落盘（调试/复核用）：npm run fixtures */
export async function writeFixtureFiles(dir: string): Promise<string[]> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, build] of Object.entries(FIXTURES)) {
    writeFileSync(`${dir}/${name}`, await build());
    written.push(name);
  }
  return written;
}
