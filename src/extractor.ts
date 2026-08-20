import { loadPdfjs } from "./pdfjs-lazy.js";
import { BASE_CSS, buildPageHtml } from "./html.js";
import { round1 } from "./util.js";
import type {
  PageExtract,
  StyleSignature,
  Unit,
} from "./types.js";

export interface ExtractorOptions {
  lineThresholdFactor?: number;
  maxGapFactor?: number;
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
  private readonly mo: Required<ExtractorOptions>;

  private constructor(
    private doc: any,
    opts: ExtractorOptions = {},
  ) {
    this.mo = {
      lineThresholdFactor: opts.lineThresholdFactor ?? 0.3,
      maxGapFactor: opts.maxGapFactor ?? 0.45,
      spaceGapFactor: opts.spaceGapFactor ?? 0.18,
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
      const tf: number[] = item.transform;

      const [vx, vy] = viewport.convertToViewportPoint(tf[4], tf[5]);
      const color = colors ? colors[colorIdx] ?? "#000000" : "#000000";
      colorIdx++;

      if (item.str.length === 0) continue;

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

  private mergeRuns(runs: RawRun[], pageNumber: number): Unit[] {
    const sorted = [...runs].sort(
      (a, b) => a.baselineTop - b.baselineTop || a.x - b.x,
    );

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

          if (gap < r.fontSize * this.mo.maxGapFactor) {
            cur.text +=
              gap > r.fontSize * this.mo.spaceGapFactor
                ? " " + r.text
                : r.text;

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

function cssFontFamily(name: string): string {
  const fallback = /hei|kai|sans|arial|helvetica|gothic|micro|yahei|pingfang/i.test(
    name,
  )
    ? "sans-serif"
    : "serif";

  const escaped = name.replace(/"/g, '\\"');
  return `"${escaped}", ${fallback}`;
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
      const a = ops.argsArray[i];
      const args = Array.isArray(a) ? a : [];

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