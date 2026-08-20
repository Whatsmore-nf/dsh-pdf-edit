import { rgb, PDFFont, PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { existsSync, readFileSync } from "node:fs";

export interface CustomFontConfig {
  family: string;
  path?: string;
  url?: string;
  bytes?: Uint8Array;
}

export interface FontConfig {
  customs?: CustomFontConfig[];
  cjk?: { path?: string; url?: string; bytes?: Uint8Array };
  cjkAutoDetect?: boolean;
  fakeBold?: boolean;
}

export interface ResolvedFont {
  font: PDFFont;
  standard: boolean;
  fakeBold: boolean;
}

const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

const CJK_SYSTEM_CANDIDATES = [
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\simsun.ttc",
  "/System/Library/Fonts/Supplemental/Songti.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
];

type StdBase = "helvetica" | "times" | "courier";

const STD_MAP: Record<StdBase, Record<string, StandardFonts>> = {
  helvetica: {
    "": StandardFonts.Helvetica,
    b: StandardFonts.HelveticaBold,
    i: StandardFonts.HelveticaOblique,
    bi: StandardFonts.HelveticaBoldOblique,
  },
  times: {
    "": StandardFonts.TimesRoman,
    b: StandardFonts.TimesRomanBold,
    i: StandardFonts.TimesRomanItalic,
    bi: StandardFonts.TimesRomanBoldItalic,
  },
  courier: {
    "": StandardFonts.Courier,
    b: StandardFonts.CourierBold,
    i: StandardFonts.CourierOblique,
    bi: StandardFonts.CourierBoldOblique,
  },
};

export function normFamily(raw: string): string {
  return (
    raw
      .replace(/^[A-Z]{6}\+/, "")
      .split(/[,+]/)[0]
      ?.trim()
      .toLowerCase() ?? raw.toLowerCase()
  );
}

function baseOf(fam: string): StdBase {
  if (/times|roman|georgia|garamond|book|song|sun|ming|serif/.test(fam))
    return "times";
  if (/courier|mono|consol/.test(fam)) return "courier";
  return "helvetica";
}

const WINANSI_MAP: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u2013": "-",
  "\u2014": "--",
  "\u2026": "...",
  "\u00A0": " ",
  "\u2022": "-",
  "\u2212": "-",
};

export function toWinAnsiSafe(s: string): string {
  return s
    .replace(
      /[\u2018\u2019\u201C\u201D\u2013\u2014\u2026\u00A0\u2022\u2212]/g,
      (c) => WINANSI_MAP[c],
    )
    .replace(/[^\u0000-\u00FF]/g, "?");
}

export class FontResolver {
  private fontCache = new Map<string, PDFFont>();
  private rawCustom = new Map<string, Uint8Array>();
  private rawCjk: Uint8Array | null | undefined;
  private readonly fakeBoldOn: boolean;
  private readonly cjkAuto: boolean;
  private pendingCjk: {
    path?: string;
    url?: string;
    bytes?: Uint8Array;
  } | null;

  private constructor(private doc: PDFDocument, cfg: FontConfig) {
    this.fakeBoldOn = cfg.fakeBold ?? true;
    this.cjkAuto = cfg.cjkAutoDetect ?? true;
    this.pendingCjk = cfg.cjk ?? null;
  }

  static async create(
    doc: PDFDocument,
    cfg: FontConfig = {},
  ): Promise<FontResolver> {
    doc.registerFontkit(fontkit);
    const r = new FontResolver(doc, cfg);
    for (const c of cfg.customs ?? []) {
      const b = await loadBytes(c);
      if (b) r.rawCustom.set(normFamily(c.family), b);
    }
    return r;
  }

  async resolveA(
    family: string,
    text: string,
    bold: boolean,
    italic: boolean,
  ): Promise<ResolvedFont> {
    const fam = normFamily(family);

    if (this.rawCustom.has(fam)) {
      return {
        font: await this.embedCustom(fam, this.rawCustom.get(fam)!),
        standard: false,
        fakeBold: bold && this.fakeBoldOn,
      };
    }

    if (CJK_RE.test(text)) {
      const bytes = this.rawCustom.get("*") ?? (await this.cjkBytes());
      if (bytes) {
        return {
          font: await this.embedCustom("cjk", bytes),
          standard: false,
          fakeBold: bold && this.fakeBoldOn,
        };
      }
      throw new Error(
        `文本含 CJK 但无可用中文字体："${text.slice(0, 20)}…"（配置 fonts.cjk，或依赖系统字体自动探测）`,
      );
    }

    const variant = (bold ? "b" : "") + (italic ? "i" : "");
    const key = `${fam}|${variant}`;
    let font = this.fontCache.get(key);
    if (!font) {
      font = await this.doc.embedFont(
        STD_MAP[baseOf(fam)][variant] ?? StandardFonts.Helvetica,
      );
      this.fontCache.set(key, font);
    }
    return { font, standard: true, fakeBold: false };
  }

  measure(rf: ResolvedFont, text: string, sizePt: number): number {
    const t = rf.standard ? toWinAnsiSafe(text) : text;
    try {
      return rf.font.widthOfTextAtSize(t, sizePt);
    } catch {
      return t.length * sizePt * 0.6;
    }
  }

  private async embedCustom(
    key: string,
    bytes: Uint8Array,
  ): Promise<PDFFont> {
    let font = this.fontCache.get(key);
    if (!font) {
      font = await this.doc.embedFont(
        openFontkitFont(bytes) as any,
        { subset: true },
      );
      this.fontCache.set(key, font);
    }
    return font;
  }

  private async cjkBytes(): Promise<Uint8Array | null> {
    if (this.rawCjk !== undefined) return this.rawCjk;
    if (this.pendingCjk) {
      this.rawCjk = await loadBytes(this.pendingCjk);
      return this.rawCjk;
    }
    if (this.cjkAuto) {
      for (const p of CJK_SYSTEM_CANDIDATES) {
        if (existsSync(p)) {
          try {
            this.rawCjk = new Uint8Array(readFileSync(p));
            return this.rawCjk;
          } catch {
            /* continue */
          }
        }
      }
    }
    return (this.rawCjk = null);
  }
}

async function loadBytes(src: {
  path?: string;
  url?: string;
  bytes?: Uint8Array;
}): Promise<Uint8Array | null> {
  if (src.bytes) return src.bytes;
  if (src.path && existsSync(src.path))
    return new Uint8Array(readFileSync(src.path));
  if (src.url) {
    const r = await fetch(src.url);
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
  }
  return null;
}

function openFontkitFont(bytes: Uint8Array): any {
  const f = (fontkit as any).create(bytes);
  if (f && Array.isArray(f.fonts) && f.fonts.length) return f.fonts[0];
  return f;
}