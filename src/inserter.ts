/**
 * 内容插入排版引擎 —— 把结构化补充内容作为新页插入 PDF 指定页之后。
 *
 * 定位：插件四个工具（preview/page/document/relayout）只支持"原位改字"，
 * 无法在文档里"加内容"。本模块补齐这条链路：markdown/结构化块 → 自动排版
 * （标题横幅、正文、公式框、跨页断页、页脚）→ 插到目标页后面，原页零改动。
 *
 * 字体：走 FontResolver，支持 fonts.customs / fonts.cjk / fonts.fallbacks
 * （fallbacks 用于化学式上下标等主字体缺字的场景，混排渲染）。
 */
import { PDFDocument, rgb, grayscale } from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import { FontResolver } from "./fonts-resolver.js";
import type { FontConfig } from "./fonts-resolver.js";

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type InsertBlockType = "h2" | "p" | "b" | "b2" | "eq" | "gap";

/** 排版块：h2=小节标题（加粗），p=段落，b=要点（悬挂缩进），b2=子要点，eq=公式（灰底框），gap=间距 */
export interface InsertBlock {
  t: InsertBlockType;
  s: string;
}

/** 一次插入：插到原 PDF 第 afterPage 页之后 */
export interface PageInsertion {
  afterPage: number;
  /** 横幅标题（加粗，灰底条内显示） */
  title: string;
  /** 横幅上方的灰色说明行（如“模块：…｜插入位置：…”），可省略 */
  caption?: string;
  blocks: InsertBlock[];
}

export interface InsertMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface InsertOptions {
  fonts?: FontConfig;
  /** 正文默认字体族（走 FontResolver 解析；默认 sans-serif） */
  family?: string;
  /** 标题/小节标题字体族（默认与 family 相同；可指向 customs 中的加粗字体） */
  titleFamily?: string;
  margins?: InsertMargins;
  bodySize?: number;
  bodyLineHeight?: number;
  h2Size?: number;
  h2LineHeight?: number;
  bannerTitleSize?: number;
  captionSize?: number;
  footerSize?: number;
  /** 页脚文案；返回空字符串则不画页脚（默认：`补充页 · 插于原第 N 页之后`） */
  footerText?: (afterPage: number, continuation: boolean) => string;
  onProgress?: (stage: "layout" | "insert", page: number) => void;
}

export interface InsertResult {
  bytes: Uint8Array;
  insertedPages: number;
  totalPages: number;
}

/* ------------------------------------------------------------------ */
/* markdown 轻量解析                                                   */
/* ------------------------------------------------------------------ */

/**
 * 把简化的 markdown 文本转成 InsertBlock[]：
 *   - `#`/`##` 开头        → h2（小节标题）
 *   - `-`/`*`/`•`/`·` 开头 → b（要点；前导空格两个以上 → b2）
 *   - `eq:` / `公式:` 开头  → eq（公式灰底框）
 *   - `---` 或空行          → gap
 *   - 其余                  → p（段落）
 */
export function parseMarkdownBlocks(text: string): InsertBlock[] {
  const blocks: InsertBlock[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) {
      blocks.push({ t: "gap", s: "" });
      continue;
    }
    if (/^#{1,6}\s+/.test(t)) {
      blocks.push({ t: "h2", s: t.replace(/^#{1,6}\s+/, "") });
      continue;
    }
    if (/^[-*•·]\s+/.test(t)) {
      const sub = /^(?: {2,}|\t)/.test(raw);
      blocks.push({
        t: sub ? "b2" : "b",
        s: t.replace(/^[-*•·]\s+/, ""),
      });
      continue;
    }
    if (/^(?:eq|公式)\s*[:：]\s*/i.test(t)) {
      blocks.push({ t: "eq", s: t.replace(/^(?:eq|公式)\s*[:：]\s*/i, "") });
      continue;
    }
    if (/^---+$/.test(t)) {
      blocks.push({ t: "gap", s: "" });
      continue;
    }
    blocks.push({ t: "p", s: t });
  }
  // 合并连续 gap
  return blocks.filter(
    (b, i) => !(b.t === "gap" && blocks[i + 1]?.t === "gap"),
  );
}

/* ------------------------------------------------------------------ */
/* 排版引擎                                                            */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  family: "sans-serif",
  titleFamily: undefined as string | undefined,
  bodySize: 9.5,
  bodyLineHeight: 13.8,
  h2Size: 10.5,
  h2LineHeight: 15.2,
  bannerTitleSize: 12,
  captionSize: 8,
  footerSize: 8,
  margins: { left: 48.5, right: 48.5, top: 52, bottom: 46 },
};

const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.42, 0.42, 0.42);
const BOX_GRAY = grayscale(0.9);
const EQ_GRAY = grayscale(0.945);

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  y: number; // bottom-up 坐标，下一行 baseline
  afterPage: number;
  k: number; // 组内第几页（0 起）
  pageW: number;
  pageH: number;
  marginL: number;
  marginR: number;
  bottom: number; // 正文底线（bottom-up）
}

type Opts = InsertOptions & typeof DEFAULTS;

const famOf = (o: Opts, title: boolean) =>
  title ? (o.titleFamily ?? o.family) : o.family;

/**
 * 把 insertions 插入到 PDF：同 afterPage 的插入合并为一组，
 * 组内按标题+块顺序排版（超长自动分页），组按 afterPage 倒序插入，
 * 保证所有插入都落在各自锚点页之后。原页内容保持不变。
 */
export async function insertPages(
  pdfBytes: Uint8Array,
  insertions: PageInsertion[],
  opts: InsertOptions = {},
): Promise<InsertResult> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const resolver = await FontResolver.create(doc, opts.fonts ?? {});
  const o: Opts = {
    ...DEFAULTS,
    ...opts,
    margins: { ...DEFAULTS.margins, ...opts.margins },
  };

  // 同页合并
  const byPage = new Map<number, PageInsertion[]>();
  for (const ins of insertions) {
    if (!byPage.has(ins.afterPage)) byPage.set(ins.afterPage, []);
    byPage.get(ins.afterPage)!.push(ins);
  }
  const groups = [...byPage.entries()]
    .map(([afterPage, gs]) => ({
      afterPage,
      title: gs.map((g) => g.title).join(" ＋ "),
      caption:
        gs.map((g) => g.caption ?? "").filter(Boolean).join("；") || undefined,
      blocks: gs.flatMap((g) => g.blocks),
    }))
    .sort((a, b) => b.afterPage - a.afterPage);

  let insertedPages = 0;
  for (const g of groups) {
    // 锚点页尺寸（保持与原页一致）
    const anchor = doc.getPage(Math.max(0, g.afterPage - 1));
    const { width: pageW, height: pageH } = anchor.getSize();
    const ctx: Ctx = {
      doc,
      page: null as unknown as PDFPage, // newGroupPage 填充
      y: pageH - o.margins.top,
      afterPage: g.afterPage,
      k: 0,
      pageW,
      pageH,
      marginL: o.margins.left,
      marginR: o.margins.right,
      bottom: o.margins.bottom,
    };
    ctx.page = await newGroupPage(ctx, o, resolver, false);
    opts.onProgress?.("layout", g.afterPage);
    await drawBanner(ctx, g, o, resolver);
    for (const blk of g.blocks) await drawBlock(ctx, blk, o, resolver);
    insertedPages += ctx.k + 1;
    opts.onProgress?.("insert", g.afterPage);
  }

  const bytes = await doc.save();
  return { bytes, insertedPages, totalPages: doc.getPageCount() };
}

/* ------------------------------------------------------------------ */
/* 绘制                                                               */
/* ------------------------------------------------------------------ */

function textAreaW(ctx: Ctx, o: Opts): number {
  return ctx.pageW - ctx.marginL - ctx.marginR;
}

function measureText(
  resolver: FontResolver,
  text: string,
  size: number,
  family: string,
): Promise<number> {
  return resolver
    .resolveRuns(text, family, false, false)
    .then((runs) =>
      runs.reduce((acc, r) => acc + resolver.measure(r.rf, r.text, size), 0),
    );
}

/** 按字素拆行；宽度按混排字体实测 */
async function wrap(
  resolver: FontResolver,
  text: string,
  size: number,
  maxW: number,
  family: string,
): Promise<string[]> {
  const chars = Array.from(text);
  const lines: string[] = [];
  let cur: string[] = [];
  for (const c of chars) {
    if ((await measureText(resolver, cur.join("") + c, size, family)) <= maxW) {
      cur.push(c);
      continue;
    }
    if (cur.length === 0) {
      cur.push(c);
      continue;
    }
    let sp = -1;
    for (let i = cur.length - 1; i >= 1; i--) {
      if (cur[i] === " ") {
        sp = i;
        break;
      }
    }
    if (sp >= 0) {
      lines.push(cur.slice(0, sp).join(""));
      cur = cur.slice(sp + 1);
    } else {
      lines.push(cur.join(""));
      cur = [];
    }
    cur.push(c);
  }
  if (cur.length) lines.push(cur.join(""));
  return lines;
}

async function drawLine(
  page: PDFPage,
  resolver: FontResolver,
  text: string,
  x: number,
  y: number,
  size: number,
  bold: boolean,
  color: ReturnType<typeof rgb>,
  family: string,
): Promise<void> {
  const runs = await resolver.resolveRuns(text, family, bold, false);
  let cx = x;
  for (const r of runs) {
    if (r.covered) {
      page.drawText(r.text, { x: cx, y, size, font: r.rf.font, color });
      if (r.rf.fakeBold) {
        // 与 native-renderer 一致的 fakeBold：偏移重绘模拟加粗
        page.drawText(r.text, {
          x: cx + Math.max(0.2, size * 0.02),
          y,
          size,
          font: r.rf.font,
          color,
        });
      }
    }
    // covered=false：主字体与回退链都没有该字符（将绘制 .notdef），
    // 标准字体还会直接抛错 —— 跳过绘制，但仍按估算宽度占位。
    cx += resolver.measure(r.rf, r.text, size);
  }
}

/** 新建一页：插入 + 居中页脚 + 页脚横线 */
async function newGroupPage(
  ctx: Ctx,
  o: Opts,
  resolver: FontResolver,
  continuation: boolean,
): Promise<PDFPage> {
  const page = ctx.doc.insertPage(ctx.afterPage + ctx.k);
  const foot =
    o.footerText?.(ctx.afterPage, continuation) ??
    `补充页 · 插于原第 ${ctx.afterPage} 页之后`;
  if (foot) {
    const w = await measureText(resolver, foot, o.footerSize, o.family);
    await drawLine(
      page,
      resolver,
      foot,
      (ctx.pageW - w) / 2,
      34,
      o.footerSize,
      false,
      GRAY,
      o.family,
    );
  }
  page.drawLine({
    start: { x: ctx.marginL, y: 42 },
    end: { x: ctx.pageW - ctx.marginR, y: 42 },
    thickness: 0.5,
    color: grayscale(0.82),
  });
  return page;
}

async function drawBanner(
  ctx: Ctx,
  g: { title: string; caption?: string },
  o: Opts,
  resolver: FontResolver,
): Promise<void> {
  const { page } = ctx;
  if (g.caption) {
    for (const ln of await wrap(resolver, g.caption, o.captionSize, textAreaW(ctx, o), o.family)) {
      await drawLine(page, resolver, ln, ctx.marginL, ctx.y, o.captionSize, false, GRAY, o.family);
      ctx.y -= o.captionSize + 1.5;
    }
    ctx.y -= 3;
  }
  const boxTop = ctx.y - 4;
  const bh = 30;
  page.drawRectangle({
    x: ctx.marginL,
    y: boxTop - bh,
    width: textAreaW(ctx, o),
    height: bh,
    color: BOX_GRAY,
  });
  const lines = await wrap(resolver, g.title, o.bannerTitleSize, textAreaW(ctx, o) - 18, famOf(o, true));
  let ty = boxTop - 11;
  for (const ln of lines) {
    await drawLine(page, resolver, ln, ctx.marginL + 9, ty, o.bannerTitleSize, true, BLACK, famOf(o, true));
    ty -= o.bannerTitleSize + 3.5;
  }
  ctx.y = boxTop - bh - 6;
}

async function ensureSpace(
  ctx: Ctx,
  need: number,
  o: Opts,
  resolver: FontResolver,
): Promise<void> {
  if (ctx.y - need >= ctx.bottom + 8) return;
  // 分页：组内新开一页，带"（续）"标记
  ctx.k += 1;
  ctx.page = await newGroupPage(ctx, o, resolver, true);
  ctx.y = ctx.pageH - o.margins.top - 2;
  await drawLine(ctx.page, resolver, "（续）", ctx.marginL, ctx.y, o.captionSize, false, GRAY, o.family);
  ctx.y -= o.captionSize + 2;
}

async function drawBlock(
  ctx: Ctx,
  blk: InsertBlock,
  o: Opts,
  resolver: FontResolver,
): Promise<void> {
  const { page } = ctx;
  if (blk.t === "gap") {
    ctx.y -= 8;
    return;
  }
  if (blk.t === "h2") {
    await ensureSpace(ctx, o.h2LineHeight + 8, o, resolver);
    ctx.y -= 5;
    for (const ln of await wrap(resolver, blk.s, o.h2Size, textAreaW(ctx, o), famOf(o, true))) {
      await drawLine(page, resolver, ln, ctx.marginL, ctx.y, o.h2Size, true, BLACK, famOf(o, true));
      ctx.y -= o.h2LineHeight;
    }
    ctx.y -= 2;
    return;
  }
  if (blk.t === "eq") {
    const lines = await wrap(resolver, blk.s, o.bodySize, textAreaW(ctx, o) - 16, o.family);
    const boxH = lines.length * o.bodyLineHeight + 10;
    await ensureSpace(ctx, boxH + 6, o, resolver);
    ctx.y -= 3;
    const top = ctx.y - 2;
    page.drawRectangle({
      x: ctx.marginL,
      y: top - boxH,
      width: textAreaW(ctx, o),
      height: boxH,
      color: EQ_GRAY,
    });
    let ly = top - 8;
    for (const ln of lines) {
      await drawLine(page, resolver, ln, ctx.marginL + 8, ly, o.bodySize, false, BLACK, o.family);
      ly -= o.bodyLineHeight;
    }
    ctx.y = top - boxH - 3;
    return;
  }

  // p / b / b2
  const indent = blk.t === "b" ? 14 : blk.t === "b2" ? 28 : 0;
  const prefix = blk.t === "b" ? "• " : blk.t === "b2" ? "– " : "";
  const pfxW = prefix ? await measureText(resolver, prefix, o.bodySize, o.family) : 0;
  const hangX = ctx.marginL + indent + pfxW;
  await ensureSpace(ctx, o.bodyLineHeight, o, resolver);
  let rest = blk.s;
  if (prefix) {
    const chars = Array.from(rest);
    let take = "";
    for (const c of chars) {
      if (
        (await measureText(resolver, prefix + take + c, o.bodySize, o.family)) >
        textAreaW(ctx, o) - indent
      ) {
        break;
      }
      take += c;
    }
    await drawLine(page, resolver, prefix + take, ctx.marginL + indent, ctx.y, o.bodySize, false, BLACK, o.family);
    ctx.y -= o.bodyLineHeight;
    rest = rest.slice(take.length);
  }
  for (const ln of await wrap(resolver, rest, o.bodySize, textAreaW(ctx, o) - indent - pfxW, o.family)) {
    if (!ln) continue;
    await drawLine(page, resolver, ln, hangX, ctx.y, o.bodySize, false, BLACK, o.family);
    ctx.y -= o.bodyLineHeight;
  }
  ctx.y -= 2;
}
