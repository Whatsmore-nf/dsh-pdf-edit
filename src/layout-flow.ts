import type { PDFDocument, PDFPage } from "pdf-lib";
import { rgb } from "pdf-lib";
import type { FontResolver, ResolvedFont } from "./fonts-resolver.js";
import { toWinAnsiSafe } from "./fonts-resolver.js";
import type { FlowBlock } from "./flow.js";
import { hexToRgb, wrapByMeasure } from "./util.js";

export interface TextStyle {
  family: string;
  sizePt: number;
  bold?: boolean;
  color?: string;
  lineHeight?: number;
  before?: number;
  after?: number;
  align?: "left" | "center";
  indentEm?: number;
}

export interface FlowTheme {
  pageSize: { widthPt: number; heightPt: number };
  margin: { top: number; bottom: number; left: number; right: number };
  columns: 1 | 2;
  columnGapPt: number;
  title: TextStyle & { rule?: { color: string; heightPt: number } };
  h2: TextStyle;
  h3: TextStyle;
  body: TextStyle;
  caption: TextStyle;
}

class FlowState {
  page!: PDFPage;
  col = 0;
  y = 0;
  pageTopY = 0;

  constructor(
    private doc: PDFDocument,
    readonly theme: FlowTheme,
  ) {
    this.newPage();
  }

  get contentW() {
    const m = this.theme.margin;
    return this.theme.pageSize.widthPt - m.left - m.right;
  }

  get colW() {
    return this.theme.columns === 1
      ? this.contentW
      : (this.contentW - this.theme.columnGapPt) / 2;
  }

  colX(ci: number) {
    return (
      this.theme.margin.left + ci * (this.colW + this.theme.columnGapPt)
    );
  }

  get bottom() {
    return this.theme.pageSize.heightPt - this.theme.margin.bottom;
  }

  newPage() {
    this.page = this.doc.addPage([
      this.theme.pageSize.widthPt,
      this.theme.pageSize.heightPt,
    ]);
    this.col = 0;
    this.pageTopY = this.theme.margin.top;
    this.y = this.pageTopY;
  }

  ensure(h: number) {
    if (this.y + h <= this.bottom) return;
    if (this.col + 1 < this.theme.columns) {
      this.col++;
      this.y = this.pageTopY;
    } else this.newPage();
  }
}

export async function renderFlowDocument(
  doc: PDFDocument,
  blocks: FlowBlock[],
  theme: FlowTheme,
  resolver: FontResolver,
): Promise<void> {
  const st = new FlowState(doc, theme);
  const titleBlock = blocks.find((b) => b.kind === "heading") ?? null;

  if (titleBlock) {
    await drawTitle(st, titleBlock.text, theme, resolver);
  }

  for (const b of blocks) {
    if (b === titleBlock) continue;
    const style =
      b.kind === "heading"
        ? theme.h2
        : b.kind === "subheading"
          ? theme.h3
          : b.kind === "caption"
            ? theme.caption
            : theme.body;
    const isHeading = b.kind === "heading" || b.kind === "subheading";
    await drawBlock(st, b.text, style, resolver, isHeading);
  }
}

async function drawTitle(
  st: FlowState,
  text: string,
  theme: FlowTheme,
  resolver: FontResolver,
) {
  const s = theme.title;
  const rf = await resolver.resolveA(s.family, text, !!s.bold, false);
  const t = rf.standard ? toWinAnsiSafe(text) : text;
  const size = s.sizePt,
    lh = size * (s.lineHeight ?? 1.3);
  const H = theme.pageSize.heightPt;
  const lines = wrapByMeasure(
    t,
    (x) => resolver.measure(rf, x, size),
    st.contentW,
  );
  let y = theme.margin.top;

  for (const line of lines) {
    const lw = resolver.measure(rf, line, size);
    const x =
      s.align === "center"
        ? theme.margin.left + (st.contentW - lw) / 2
        : theme.margin.left;
    const color = s.color ? hexToRgb(s.color) : rgb(0, 0, 0);
    st.page.drawText(line, {
      x,
      y: H - (y + size * 0.8),
      size,
      font: rf.font,
      color,
    });
    if (rf.fakeBold) {
      st.page.drawText(line, {
        x: x + Math.max(0.2, size * 0.02),
        y: H - (y + size * 0.8),
        size,
        font: rf.font,
        color,
      });
    }
    y += lh;
  }

  if (theme.title.rule) {
    y += 6;
    st.page.drawRectangle({
      x: theme.margin.left,
      y: H - y - theme.title.rule.heightPt,
      width: st.contentW,
      height: theme.title.rule.heightPt,
      color: hexToRgb(theme.title.rule.color),
    });
    y += theme.title.rule.heightPt + 8;
  }

  st.pageTopY = y;
  st.y = y;
}

async function drawBlock(
  st: FlowState,
  text: string,
  style: TextStyle,
  resolver: FontResolver,
  keepWithNext: boolean,
) {
  if (!text.trim()) return;
  const rf = await resolver.resolveA(style.family, text, !!style.bold, false);
  const t = rf.standard ? toWinAnsiSafe(text) : text;
  const size = style.sizePt;
  const lh = size * (style.lineHeight ?? 1.5);
  const indent = (style.indentEm ?? 0) * size;

  st.y += style.before ?? 0;
  st.ensure(lh + (keepWithNext ? lh * 2.2 : 0));

  const lines = wrapByMeasure(
    t,
    (x) => resolver.measure(rf, x, size),
    st.colW - indent,
  );
  const H = st.theme.pageSize.heightPt;
  const color = style.color ? hexToRgb(style.color) : rgb(0, 0, 0);

  lines.forEach((line, i) => {
    st.ensure(lh);
    const lw = resolver.measure(rf, line, size);
    let x = st.colX(st.col);
    if (i === 0 && indent) x += indent;
    if (style.align === "center") x += Math.max(0, (st.colW - lw) / 2);
    const baseline = H - (st.y + size * 0.8);
    st.page.drawText(line, { x, y: baseline, size, font: rf.font, color });
    if (rf.fakeBold) {
      st.page.drawText(line, {
        x: x + Math.max(0.2, size * 0.02),
        y: baseline,
        size,
        font: rf.font,
        color,
      });
    }
    st.y += lh;
  });

  st.y += style.after ?? 0;
}