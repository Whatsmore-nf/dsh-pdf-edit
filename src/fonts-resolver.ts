import { rgb, PDFFont, PDFDocument, StandardFonts } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { existsSync, readFileSync } from "node:fs";
import { LRUCache } from "./util.js";

export interface CustomFontConfig {
  family: string;
  path?: string;
  url?: string;
  bytes?: Uint8Array;
}

export interface FontConfig {
  customs?: CustomFontConfig[];
  /**
   * 缺字回退字体链：主字体（customs/cjk/标准字体）没有的字形，
   * 按数组顺序尝试这些字体补齐。典型场景：化学式上下标（₂₃⁺⁻ 等）
   * 不在常见 CJK 字体 cmap 中，可回退到 FreeSans/DejaVu 等符号较全的字体。
   */
  fallbacks?: CustomFontConfig[];
  cjk?: { path?: string; url?: string; bytes?: Uint8Array };
  cjkAutoDetect?: boolean;
  fakeBold?: boolean;
}

export interface ResolvedFont {
  font: PDFFont;
  standard: boolean;
  fakeBold: boolean;
}

/**
 * 混排渲染的一段文本：text 中的每个字符都由 rf 覆盖（或 covered=false 表示
 * 主字体与回退链都无法覆盖，将绘制 .notdef）。
 */
export interface FontRun {
  text: string;
  rf: ResolvedFont;
  covered: boolean;
}

const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

const CJK_SYSTEM_CANDIDATES = [
  "C:\\Windows\\Fonts\\simhei.ttf",
  "C:\\Windows\\Fonts\\msyh.ttc",
  "C:\\Windows\\Fonts\\simsun.ttc",
  "/System/Library/Fonts/Supplemental/Songti.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
  "/usr/share/fonts/wenquanyi/wqy-zenhei/wqy-zenhei.ttc",
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
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
  private faceCache = new Map<string, Uint8Array>();
  /** resolveA 结果缓存（LRU）：批量 applyPatches 高频调用时免重复解析 */
  private resolveLRU = new LRUCache<string, ResolvedFont>(128);
  private rawCustom = new Map<string, Uint8Array>();
  private rawFallbacks: Array<{ key: string; bytes: Uint8Array }> = [];
  private rawCjk: Uint8Array | null | undefined;
  private readonly fakeBoldOn: boolean;
  private readonly cjkAuto: boolean;
  private pendingCjk: {
    path?: string;
    url?: string;
    bytes?: Uint8Array;
  } | null;
  /** 字形覆盖查询用的 fontkit 字体缓存（按字节引用） */
  private fontkitCache = new WeakMap<Uint8Array, any>();

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
    for (const c of cfg.fallbacks ?? []) {
      const b = await loadBytes(c);
      if (b) {
        r.rawFallbacks.push({
          key: normFamily(c.family) || `fallback${r.rawFallbacks.length}`,
          bytes: b,
        });
      }
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
    const variant = (bold ? "b" : "") + (italic ? "i" : "");

    // LRU 命中直接返回：键含 family + 字重变体 + 是否 CJK/自定义
    const kind = this.rawCustom.has(fam)
      ? "custom"
      : CJK_RE.test(text)
        ? "cjk"
        : "std";
    const cacheKey = `${fam}|${variant}|${kind}`;
    const cached = this.resolveLRU.get(cacheKey);
    if (cached) return cached;

    let result: ResolvedFont;

    if (kind === "custom") {
      result = {
        font: await this.embedCustom(fam, this.rawCustom.get(fam)!),
        standard: false,
        fakeBold: bold && this.fakeBoldOn,
      };
    } else if (kind === "cjk") {
      const bytes = this.rawCustom.get("*") ?? (await this.cjkBytes());
      if (!bytes) {
        throw new Error(
          `文本含 CJK 但无可用中文字体："${text.slice(0, 20)}…"（配置 fonts.cjk，或依赖系统字体自动探测）`,
        );
      }
      result = {
        font: await this.embedCustom("cjk", bytes),
        standard: false,
        fakeBold: bold && this.fakeBoldOn,
      };
    } else {
      let font = this.fontCache.get(`${fam}|${variant}`);
      if (!font) {
        font = await this.doc.embedFont(
          STD_MAP[baseOf(fam)][variant] ?? StandardFonts.Helvetica,
        );
        this.fontCache.set(`${fam}|${variant}`, font);
      }
      result = { font, standard: true, fakeBold: false };
    }

    this.resolveLRU.set(cacheKey, result);
    return result;
  }

  /**
   * 把文本按“哪个字体覆盖该字符”拆成可依次绘制的 FontRun 列表。
   *
   * 覆盖优先级：
   *   1. 主字体：customs 中与 family 匹配的字体；否则 CJK 字符 → cjk 字体，其余 → 标准字体；
   *   2. fallbacks 回退链（按配置顺序）；
   *   3. 全部不覆盖 → 仍归入主字体（covered=false，将绘制 .notdef）。
   *
   * 典型用法（化学式混排）：
   *   const runs = await resolver.resolveRuns("KClO₃", "sans-serif", false, false);
   *   let x = 0;
   *   for (const r of runs) { page.drawText(r.text, { x, y, size, font: r.rf.font }); x += measure(r.rf, r.text, size); }
   */
  async resolveRuns(
    text: string,
    family: string,
    bold: boolean,
    italic: boolean,
  ): Promise<FontRun[]> {
    const fam = normFamily(family);
    const customBytes = this.rawCustom.get(fam);

    const runs: FontRun[] = [];
    let cur = "";
    let curRf: ResolvedFont | null = null;
    let curCovered = true;
    const flush = () => {
      if (cur && curRf) runs.push({ text: cur, rf: curRf, covered: curCovered });
      cur = "";
    };
    /** 同一底层 PDFFont + 同 fakeBold 视为同一 run（wrapper 对象每次新建，不能直接 === 比较） */
    const sameRun = (a: ResolvedFont | null, b: ResolvedFont | null) =>
      !!a && !!b && a.font === b.font && a.fakeBold === b.fakeBold;

    for (const ch of Array.from(text)) {
      const cp = ch.codePointAt(0)!;

      // —— 决定该字符的主字体 ——
      let primary: ResolvedFont;
      let primaryCovers: boolean;
      if (customBytes) {
        primary = await this.resolveA(family, ch, bold, italic);
        primaryCovers = await this.coversBytes(customBytes, cp);
      } else if (CJK_RE.test(ch)) {
        const cjk = this.rawCustom.get("*") ?? (await this.cjkBytes());
        if (!cjk) {
          throw new Error(
            `文本含 CJK 但无可用中文字体："${ch}"（配置 fonts.cjk，或依赖系统字体自动探测）`,
          );
        }
        primary = await this.resolveA(family, ch, bold, italic);
        primaryCovers = await this.coversBytes(cjk, cp);
      } else {
        primary = await this.resolveA(family, ch, bold, italic);
        primaryCovers = this.winAnsiCovers(cp);
      }

      if (primaryCovers) {
        if (!sameRun(curRf, primary) || !curCovered) {
          flush();
          curRf = primary;
          curCovered = true;
        }
        cur += ch;
        continue;
      }

      // —— 主字体缺字：尝试回退链 ——
      let placed = false;
      for (const fb of this.rawFallbacks) {
        if (await this.coversBytes(fb.bytes, cp)) {
          const rf: ResolvedFont = {
            font: await this.embedFallback(fb),
            standard: false,
            fakeBold: bold && this.fakeBoldOn,
          };
          if (!sameRun(curRf, rf) || !curCovered) {
            flush();
            curRf = rf;
            curCovered = true;
          }
          cur += ch;
          placed = true;
          break;
        }
      }
      if (placed) continue;

      // —— 全部不覆盖：归主字体（.notdef）——
      if (!sameRun(curRf, primary) || curCovered) {
        flush();
        curRf = primary;
        curCovered = false;
      }
      cur += ch;
    }
    flush();
    return runs;
  }

  /**
   * 判断文本的所有字符是否都有可用字形（主字体或回退链）。
   * false 表示存在会绘制成 .notdef 的字符。
   */
  async hasGlyph(
    text: string,
    family: string,
    bold: boolean,
    italic: boolean,
  ): Promise<boolean> {
    if (!text) return true;
    const runs = await this.resolveRuns(text, family, bold, italic);
    return runs.every((r) => r.covered);
  }

  measure(rf: ResolvedFont, text: string, sizePt: number): number {
    const t = rf.standard ? toWinAnsiSafe(text) : text;
    try {
      return rf.font.widthOfTextAtSize(t, sizePt);
    } catch {
      return t.length * sizePt * 0.6;
    }
  }

  /** 主字体 / 回退链是否覆盖某码点 */
  private async coversBytes(bytes: Uint8Array, cp: number): Promise<boolean> {
    try {
      let f = this.fontkitCache.get(bytes);
      if (!f) {
        f = fontkit.create(bytes);
        this.fontkitCache.set(bytes, f);
      }
      return f.hasGlyphForCodePoint(cp);
    } catch {
      return false;
    }
  }

  /** 标准字体（WinAnsi 编码）是否覆盖某码点 */
  private winAnsiCovers(cp: number): boolean {
    return toWinAnsiSafe(String.fromCodePoint(cp)) !== "?";
  }

  private async embedCustom(
    key: string,
    bytes: Uint8Array,
  ): Promise<PDFFont> {
    let font = this.fontCache.get(key);
    if (!font) {
      // pdf-lib 只接受字节；TTC/OTC 集合需先拆包为单 face
      const faceBytes =
        this.faceCache.get(key) ?? unwrapFontBytes(bytes, this.faceIndex(key));
      this.faceCache.set(key, faceBytes);
      font = await this.doc.embedFont(faceBytes, { subset: true });
      this.fontCache.set(key, font);
    }
    return font;
  }

  private async embedFallback(fb: {
    key: string;
    bytes: Uint8Array;
  }): Promise<PDFFont> {
    const key = `__fb__${fb.key}`;
    let font = this.fontCache.get(key);
    if (!font) {
      // 回退字体（通常是较小的符号字体，如 FreeSans）不做子集化：
      // pdf-lib 对部分 CFF/OTF（如 FreeSans）子集化后字形会整段空白，
      // 全文嵌入可保证 ₂₃⁺⁻ 等上下标真实可见。
      const faceBytes =
        this.faceCache.get(key) ?? unwrapFontBytes(fb.bytes, this.faceIndex(key));
      this.faceCache.set(key, faceBytes);
      font = await this.doc.embedFont(faceBytes);
      this.fontCache.set(key, font);
    }
    return font;
  }

  /** Mono/Sharp 等派生 face 不适合正文排版，优先取集合第 0 个 face。 */
  private faceIndex(_key: string): number {
    return 0;
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

/**
 * pdf-lib 的 embedFont 仅接受字节（不接受 fontkit 字体对象），
 * 且其内置 fontkit 不支持 TTC/OTC 集合（返回 Collection，无 createSubset/layout）。
 * 因此这里把集合中的指定 face 拆包为独立 sfnt 字节再交给 pdf-lib 嵌入。
 */
export function unwrapFontBytes(bytes: Uint8Array, faceIndex = 0): Uint8Array {
  const isCollection =
    bytes.length >= 12 &&
    bytes[0] === 0x74 && // "ttcf"
    bytes[1] === 0x74 &&
    bytes[2] === 0x63 &&
    bytes[3] === 0x66;

  if (!isCollection) return bytes;

  try {
    return ttcFaceBytes(bytes, faceIndex);
  } catch {
    return bytes;
  }
}

/** 从 TTC/OTC 集合中提取第 index 个 face，输出独立 sfnt（TTF/OTF）字节。 */
export function ttcFaceBytes(
  ttc: Uint8Array,
  faceIndex = 0,
): Uint8Array {
  const dv = new DataView(ttc.buffer, ttc.byteOffset, ttc.byteLength);
  const numFonts = dv.getUint32(8);
  if (faceIndex >= numFonts) throw new Error(`TTC 只有 ${numFonts} 个 face`);

  const off = dv.getUint32(12 + faceIndex * 4);
  const numTables = dv.getUint16(off + 4);

  interface Entry {
    name: string;
    offset: number;
    len: number;
  }
  const entries: Entry[] = [];
  for (let i = 0; i < numTables; i++) {
    const e = off + 12 + i * 16;
    entries.push({
      name: String.fromCharCode(
        ttc[e],
        ttc[e + 1],
        ttc[e + 2],
        ttc[e + 3],
      ),
      offset: dv.getUint32(e + 8),
      len: dv.getUint32(e + 12),
    });
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
    out.set(ttc.subarray(t.offset, t.offset + t.len), p);
    odv.setUint32(12 + i * 16 + 8, p); // 更新表偏移指向新位置
    p += Math.ceil(t.len / 4) * 4;
  }

  return out;
}