import { loadPdfjs } from "./pdfjs-lazy.js";
import { BASE_CSS, buildPageHtml } from "./html.js";
import { clamp, median, round1 } from "./util.js";
import type {
  PageExtract,
  StyleSignature,
  Unit,
} from "./types.js";

export interface ExtractorOptions {
  lineThresholdFactor?: number;
  /**
   * tid 合并的最大间隙系数（相对字号）。缺省时按同页相邻文本项的
   * 间隙中位数自适应计算（clamp 到 [0.3, 0.8]），紧凑双栏 / 宽字距标题
   * 等极端排版下比硬编码更稳。显式传入时优先使用显式值（向后兼容）。
   */
  maxGapFactor?: number;
  /** 插入空格的最小间隙系数。缺省时自适应（clamp 到 [0.1, 0.4]） */
  spaceGapFactor?: number;
}

interface RawRun {
  text: string;
  x: number;
  baselineTop: number;
  width: number;
  fontSize: number;
  ascent: number;
  sig: StyleSignature;
}

const sigKey = (s: StyleSignature): string =>
  `${s.fontFamily}|${s.fontSizePt}|${s.color}|${s.bold ? 1 : 0}|${
    s.italic ? 1 : 0
  }`;

export class StyleLockedExtractor {
  private readonly mo: {
    lineThresholdFactor: number;
    maxGapFactor?: number;
    spaceGapFactor?: number;
  };
  /** 提取阶段发现的可读性警告（如 CID/ToUnicode 缺失导致乱码），由上层取走展示 */
  readonly warnings: string[] = [];

  private constructor(
    private doc: any,
    opts: ExtractorOptions = {},
  ) {
    this.mo = {
      lineThresholdFactor: opts.lineThresholdFactor ?? 0.3,
      maxGapFactor: opts.maxGapFactor,
      spaceGapFactor: opts.spaceGapFactor,
    };
  }

  static async open(
    bytes: Uint8Array,
    opts: ExtractorOptions = {},
  ): Promise<StyleLockedExtractor> {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
      data: bytes.slice(),
      isEvalSupported: false,
    }).promise;
    return new StyleLockedExtractor(doc, opts);
  }

  get pageCount(): number {
    return this.doc.numPages;
  }

  /** 暴露 pdfjs 页面对象（供背景采样等只读用途），异常时返回 null */
  async getPdfPage(pageNumber: number): Promise<any | null> {
    try {
      return await this.doc.getPage(pageNumber);
    } catch {
      return null;
    }
  }

  async extractPage(
    pageNumber: number,
    opts: { recoverColor?: boolean; strictColor?: boolean } = {},
  ): Promise<PageExtract> {
    const pdfjs = await loadPdfjs();
    const page = await this.doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });

    const tc: any = await page.getTextContent();
    const textItems = (tc.items as any[]).filter(
      (it) => typeof it.str === "string",
    );

    this.detectGarbledText(textItems, pageNumber);

    let colors =
      opts.recoverColor ?? true
        ? await recoverColors(page, pdfjs.OPS)
        : null;

    if (
      colors &&
      (opts.strictColor ?? false) &&
      colors.length !== textItems.length
    ) {
      colors = null;
    }

    const runs: RawRun[] = [];
    let colorIdx = 0;

    for (const item of textItems) {
      // 空项/纯空白项是 pdfjs 间距归一化的产物，不代表独立的 showText 运算，
      // 不应消耗颜色索引（否则后续全部错位）
      if (item.str.length === 0 || !item.str.trim()) continue;

      const tf: number[] = item.transform;

      const [vx, vy] = viewport.convertToViewportPoint(tf[4], tf[5]);
      const color = colors ? colors[colorIdx] ?? "#000000" : "#000000";
      colorIdx++;

      const fontSize =
        Math.hypot(tf[2] ?? 0, tf[3] ?? 0) || item.height || 12;

      const st = tc.styles?.[item.fontName] ?? {};
      const font = safeGetFont(page, item.fontName);
      const rawName: string = font?.name ?? st.fontFamily ?? "serif";

      runs.push({
        text: item.str,
        x: vx,
        baselineTop: vy,
        width: item.width || 0,
        fontSize: round1(fontSize),
        ascent:
          typeof st.ascent === "number" && st.ascent > 0.3
            ? st.ascent
            : 0.8,
        sig: {
          fontFamily: normalizeFontFamily(rawName),
          fontSizePt: round1(fontSize),
          color,
          bold:
            !!font?.bold ||
            /bold|black|heavy|semib|[,+-]bd\b/i.test(rawName),
          italic:
            !!font?.italic || /italic|oblique|[,+-]it\b/i.test(rawName),
        },
      });
    }

    const units = this.mergeRuns(runs, pageNumber);
    const css = freezeStyles(units);

    return {
      pageNumber,
      widthPt: viewport.width,
      heightPt: viewport.height,
      css,
      html: buildPageHtml({
        widthPt: viewport.width,
        heightPt: viewport.height,
        units,
      }),
      units,
    };
  }

  /**
   * 缺失 ToUnicode CMap 的 Type0/CID 字体常把字符映射到私用区（PUA）或
   * U+FFFD——提取出的就是乱码，AI 对账必然失败。占比过高时记警告（不中断，
   * 其余页面仍可正常编辑）。
   */
  private detectGarbledText(textItems: any[], pageNumber: number): void {
    const nonEmpty = textItems.filter((it) => it.str.trim());
    if (!nonEmpty.length) return;

    const isBadChar = (ch: string): boolean => {
      const cp = ch.codePointAt(0)!;
      return (cp >= 0xe000 && cp <= 0xf8ff) || cp === 0xfffd;
    };

    let garbled = 0;
    for (const it of nonEmpty) {
      const chars = [...it.str];
      const bad = chars.filter(isBadChar).length;
      if (bad / chars.length > 0.3) garbled++;
    }

    if (garbled / nonEmpty.length > 0.5) {
      this.warnings.push(
        `第 ${pageNumber} 页文本疑似乱码（字体缺 ToUnicode/CMap 映射），该页 AI 编辑结果可能不可靠`,
      );
    }
  }

  private mergeRuns(runs: RawRun[], pageNumber: number): Unit[] {
    const sorted = [...runs].sort(
      (a, b) => a.baselineTop - b.baselineTop || a.x - b.x,
    );

    const { maxGap, spaceGap } = this.gapThresholds(sorted);

    const units: Unit[] = [];
    let cur: Unit | null = null;
    let curBase = 0;

    for (const r of sorted) {
      if (cur) {
        const sameLine =
          Math.abs(r.baselineTop - curBase) <=
          Math.max(1.2, r.fontSize * this.mo.lineThresholdFactor);

        const sameStyle = sigKey(cur.sig) === sigKey(r.sig);

        if (sameLine && sameStyle) {
          const gap = r.x - (cur.x + cur.width);

          if (gap < r.fontSize * maxGap) {
            cur.text += gap > r.fontSize * spaceGap ? " " + r.text : r.text;

            cur.width = r.x + r.width - cur.x;
            continue;
          }
        }
      }

      const u: Unit = {
        tid: `p${pageNumber}-${units.length}`,
        text: r.text,
        x: r.x,
        top: r.baselineTop - r.ascent * r.fontSize,
        width: r.width,
        fontSize: r.fontSize,
        className: "",
        sig: r.sig,
        baselineTop: r.baselineTop,
      };

      units.push(u);
      cur = u;
      curBase = r.baselineTop;
    }

    return units;
  }

  /**
   * 合并阈值：显式配置优先；否则按同页相邻同线文本项的正间隙中位数自适应——
   * 中位间隙的 1.5 倍为合并上限（clamp [0.3, 0.8]）、0.6 倍为空格下限
   * （clamp [0.1, 0.4]）。无间隙样本时回退接近旧默认值的 0.25。
   */
  private gapThresholds(sorted: RawRun[]): {
    maxGap: number;
    spaceGap: number;
  } {
    if (
      this.mo.maxGapFactor != null &&
      this.mo.spaceGapFactor != null
    ) {
      return { maxGap: this.mo.maxGapFactor, spaceGap: this.mo.spaceGapFactor };
    }

    const ratios: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (Math.abs(cur.baselineTop - prev.baselineTop) < 1) {
        const gap = cur.x - (prev.x + prev.width);
        if (gap > 0) ratios.push(gap / Math.max(prev.fontSize, 1));
      }
    }

    const med = ratios.length ? median(ratios) : 0.25;
    return {
      maxGap: clamp(med * 1.5, 0.3, 0.8),
      spaceGap: clamp(med * 0.6, 0.1, 0.4),
    };
  }
}

function freezeStyles(units: Unit[]): string {
  const registry = new Map<string, string>();

  for (const u of units) {
    const key = sigKey(u.sig);
    let cls = registry.get(key);

    if (!cls) {
      cls = `s${registry.size + 1}`;
      registry.set(key, cls);
    }

    u.className = cls;
  }

  const rules = [...registry.entries()].map(([key, cls]) => {
    const [family, size, color, bold, italic] = key.split("|");

    return (
      `.${cls}{font-family:${cssFontFamily(family)};` +
      `font-size:${size}pt;color:${color};` +
      `font-weight:${bold === "1" ? 700 : 400};` +
      `font-style:${italic === "1" ? "italic" : "normal"}}`
    );
  });

  return [BASE_CSS, ...rules].join("\n");
}

function normalizeFontFamily(raw: string): string {
  return (
    raw
      .replace(/^[A-Z]{6}\+/, "")
      .split(/[,+]/)[0]
      ?.trim() || raw
  );
}

/** 字体名白名单：来自不可信 PDF 的字体名只允许安全字符，其余直接回退到通用族 */
const FONT_NAME_SAFE = /^[\w\s\-.,#()/]+$/;

function cssFontFamily(name: string): string {
  const fallback = /hei|kai|sans|arial|helvetica|gothic|micro|yahei|pingfang/i.test(
    name,
  )
    ? "sans-serif"
    : "serif";

  // 白名单校验 + 长度限制：不合法直接用 fallback，不携带任何 PDF 内容进 CSS
  if (!FONT_NAME_SAFE.test(name) || name.length > 128) {
    return fallback;
  }
  return `"${name}", ${fallback}`;
}

function safeGetFont(page: any, fontName: string): any {
  try {
    return page.commonObjs?.get(fontName);
  } catch {
    return undefined;
  }
}

async function recoverColors(page: any, OPS: any): Promise<string[] | null> {
  try {
    const ops = await page.getOperatorList();
    const colors: string[] = [];
    let cur = "#000000";

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      // pdfjs 的参数可能是普通数组或 Float32Array 等类型化数组
      const rawArgs = ops.argsArray[i];
      const args: any[] =
        Array.isArray(rawArgs)
          ? rawArgs
          : ArrayBuffer.isView(rawArgs) || typeof rawArgs === "object"
            ? Array.from(rawArgs ?? [])
            : [];

      if (fn === OPS.setFillRGBColor) {
        cur = rgbHex(n255(args[0]), n255(args[1]), n255(args[2]));
      } else if (fn === OPS.setFillGray) {
        const g = n255(args[0]);
        cur = rgbHex(g, g, g);
      } else if (fn === OPS.setFillCMYKColor) {
        const [c = 0, m = 0, y = 0, k = 0] = args.map((v: number) =>
          v <= 1 ? v : v / 255,
        );

        const f = (v: number) => Math.round(255 * (1 - v) * (1 - k));
        cur = rgbHex(f(c), f(m), f(y));
      } else if (fn === OPS.showText || fn === OPS.showSpacedText) {
        colors.push(cur);
      }
    }

    return colors;
  } catch {
    return null;
  }
}

const n255 = (v: number): number =>
  Math.max(0, Math.min(255, Math.round(v <= 1 ? v * 255 : v)));

const rgbHex = (r: number, g: number, b: number): string =>
  "#" +
  [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");