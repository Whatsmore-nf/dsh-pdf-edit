

---

## 目录结构

```text
src/
├─ types.ts
├─ util.ts
├─ prompts.ts
├─ html.ts
├─ fonts.ts
├─ extractor.ts
├─ ai-editor.ts
├─ validator.ts
├─ renderer.ts
├─ pdf-ops.ts
├─ templates.ts
├─ flow.ts
├─ pipeline.ts
├─ index.ts
└─ pdfjs-dist.d.ts
```

---

## 1. `package.json`

````json
{
  "name": "style-locked-pdf-editor",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "example": "node dist/example.js"
  },
  "dependencies": {
    "pdf-lib": "^1.17.1",
    "pdfjs-dist": "^4.8.69",
    "playwright": "^1.48.0"
  },
  "optionalDependencies": {
    "canvas": "^2.11.2"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "typescript": "^5.5.0"
  }
}
````

安装：

```bash
npm i
npx playwright install chromium
```

---

## 2. `tsconfig.json`

````json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "example.ts"]
}
````

---

## 3. `src/pdfjs-dist.d.ts`

````ts
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export const getDocument: any;
  export const OPS: any;
  export const GlobalWorkerOptions: any;
}
````

---

## 4. `src/types.ts`

````ts
/** 样式签名：一颗“钉子”的四要素 */
export interface StyleSignature {
  fontFamily: string;
  fontSizePt: number;
  color: string; // #rrggbb
  bold: boolean;
  italic: boolean;
}

/** 内部单元：钉子（位置+样式）+ 流水（文字） */
export interface Unit {
  /** 锚点 ID，如 "p3-17" */
  tid: string;
  text: string;

  /** 距页左 pt */
  x: number;

  /** 距页顶 pt，已按 ascent 换算 */
  top: number;

  /** 钉位宽度，溢出判定基准 */
  width: number;

  fontSize: number;

  /** 固化样式类 s1..sN */
  className: string;

  sig: StyleSignature;

  /** 引擎端渲染标记，AI 不可见、不可改 */
  fontSizeOverride?: number;
  clip?: boolean;
  wrap?: boolean;
}

/** 暴露给 AI 的“流水”：只有锚点和文字，没有任何结构可破坏 */
export interface EditableUnit {
  tid: string;
  text: string;
}

/** 页面底图：复杂版面保真模式 */
export interface PageBackground {
  dataUrl: string;
  widthPt: number;
  heightPt: number;
}

export interface PageExtract {
  /** 1-based */
  pageNumber: number;
  widthPt: number;
  heightPt: number;

  /** 本页固化样式 */
  css: string;

  /** 锁定 HTML，由引擎重建，AI 永远接触不到 */
  html: string;

  units: Unit[];

  /** background: "image" 时填充 */
  background?: PageBackground;

  /**
   * 底图模式下记录哪些 tid 相对原始底图已经变脏。
   * 用于多次编辑时不丢上一轮修改。
   */
  dirtyTids?: Set<string>;
}

/** 文本溢出钉位的处理策略 */
export type OverflowMode = "clip" | "shrink" | "reject" | "wrap";

export interface OverflowPolicy {
  mode: OverflowMode;

  /** shrink 模式下限，默认 6pt，触底后兜底裁剪 */
  minFontSizePt?: number;
}

/** 术语统一表 */
export type Glossary =
  | Record<string, string>
  | Array<{ from: string; to: string }>;

/** 中文字体资源：@font-face 注入 */
export interface FontResource {
  /** 必须与 PDF 内字体名 normalize 后一致才能命中 */
  family: string;

  /** data: URL 或 https: URL */
  src: string;

  format?: string;
  weight?: number;
  style?: "normal" | "italic";
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export type ChatFn = (
  messages: ChatMessage[],
  opts?: ChatOptions,
) => Promise<string>;

/** 正式适配器接口 */
export interface LLMAdapter {
  complete(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

export type Stage =
  | "extract"
  | "ai"
  | "render"
  | "skip"
  | "merge"
  | "error";

export interface ProgressInfo {
  stage: Stage;
  done: number;
  total: number;
  page?: number;
  message?: string;
}

export type ProgressFn = (info: ProgressInfo) => void;
````

---

## 5. `src/util.ts`

````ts
import type { Glossary } from "./types.js";

export const round1 = (n: number): number => Math.round(n * 10) / 10;

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export function range(from: number, to: number): number[] {
  const r: number[] = [];
  for (let i = from; i <= to; i++) r.push(i);
  return r;
}

export function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** 轻量并发闸，零依赖 */
export function pLimit(max: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return function run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            active--;
            queue.shift()?.();
          });
      };

      if (active < max) start();
      else queue.push(start);
    });
  };
}

/** FNV-1a 32 位哈希：文档指纹 / 缓存 key */
export function hash32(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 宽度估算：CJK≈1em，Latin≈0.5em，窄字符≈0.32em */
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

const NARROW = /[iljtf.,:;'`!|()[\]{}]/;

export function estimateTextWidthPt(text: string, fontSizePt: number): number {
  let em = 0;

  for (const ch of text) {
    if (ch === " ") em += 0.3;
    else if (WIDE.test(ch)) em += 1.0;
    else if (NARROW.test(ch)) em += 0.32;
    else if (ch >= "A" && ch <= "Z") em += 0.72;
    else if (ch >= "0" && ch <= "9") em += 0.56;
    else em += 0.52;
  }

  return em * fontSizePt;
}

export interface GlossaryTerm {
  from: string;
  to: string;
}

/** 归一化术语表：长词优先，避免短词抢先部分替换 */
export function normalizeGlossary(g?: Glossary): GlossaryTerm[] {
  if (!g) return [];

  const list: GlossaryTerm[] = Array.isArray(g)
    ? g
    : Object.entries(g).map(([from, to]) => ({ from, to }));

  return list
    .filter((t) => t.from && t.to && t.from !== t.to)
    .sort((a, b) => b.from.length - a.from.length);
}

/** 本地术语后处理 */
export function applyGlossary(text: string, terms: GlossaryTerm[]): string {
  let out = text;
  for (const t of terms) {
    out = out.split(t.from).join(t.to);
  }
  return out;
}
````

---

## 6. `src/prompts.ts`

````ts
export const TEXT_EDIT_SYSTEM_PROMPT = `你是 PDF 文本精修引擎，工作在“样式锁定”模式下。

【铁律——违反任意一条即判定失败】
1. 你只能修改文本内容本身（错别字、标点、术语统一、指定措辞调整）。
2. 输出的条目数量必须与输入完全一致，顺序一致。
3. tid 必须逐条原样返回：不得新增、删除、合并、改写任何 tid。
4. 无需修改的条目，text 原样返回。
5. 禁止输出 HTML/XML 标签、Markdown 标记、注释或任何解释性文字。
6. 只输出一个 JSON 对象，格式：{"items":[{"tid":"...","text":"..."}]}，不带代码块围栏。`;

export function buildEditPrompt(
  instruction: string,
  units: Array<{ tid: string; text: string }>,
  glossaryTerms?: Array<{ from: string; to: string }>,
): string {
  const lines: string[] = ["【修改任务】", instruction];

  if (glossaryTerms?.length) {
    lines.push("", "【术语统一表——所有输出必须全部应用】");
    for (const t of glossaryTerms) {
      lines.push(`- ${t.from} → ${t.to}`);
    }
  }

  lines.push(
    "",
    "【待修改文本条目】",
    JSON.stringify({ items: units }),
    "",
    "【输出要求】",
    '只输出 JSON 对象：{"items":[{"tid":"原样tid","text":"修改后文本"},...]}；',
    "条目数量与 tid 必须与输入完全一致；未修改条目原样返回。",
  );

  return lines.join("\n");
}
````

---

## 7. `src/html.ts`

````ts
import { escapeHtml, estimateTextWidthPt } from "./util.js";
import type { Unit } from "./types.js";

export const BASE_CSS = `*{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
.pdf-page{position:relative;background:#fff;overflow:hidden}
.txt{position:absolute;white-space:pre;line-height:1;transform-origin:0 0}
.bg{position:absolute;left:0;top:0}
.mask{position:absolute;line-height:1}`;

export interface PageHtmlOptions {
  /**
   * 底图模式下：只重绘这些单元。
   * 其余文字由底图承载，避免双重绘制。
   */
  changedTids?: Set<string>;

  /**
   * 底图模式下遮盖原文字的色块颜色。
   * 默认白色，按需匹配页面底色。
   */
  patchColor?: string;
}

/**
 * 钉版式 HTML：
 * - 无底图：全部单元；
 * - 有底图：仅脏单元 + 遮盖块。
 */
export function buildPageHtml(
  ex: {
    widthPt: number;
    heightPt: number;
    units: Unit[];
    background?: {
      dataUrl: string;
      widthPt: number;
      heightPt: number;
    };
  },
  opts: PageHtmlOptions = {},
): string {
  const parts: string[] = [];

  if (ex.background) {
    const b = ex.background;
    parts.push(
      `<img class="bg" src="${b.dataUrl}" style="width:${b.widthPt.toFixed(
        2,
      )}pt;height:${b.heightPt.toFixed(2)}pt">`,
    );
  }

  let draw: Unit[];

  if (ex.background) {
    draw = opts.changedTids
      ? ex.units.filter((u) => opts.changedTids!.has(u.tid))
      : [];
  } else {
    draw = ex.units;
  }

  if (ex.background && opts.changedTids) {
    const color = opts.patchColor ?? "#ffffff";
    for (const u of draw) {
      const r = maskRect(u);
      parts.push(
        `<span class="mask" style="left:${r.left.toFixed(2)}pt;top:${r.top.toFixed(
          2,
        )}pt;width:${r.width.toFixed(2)}pt;height:${r.height.toFixed(
          2,
        )}pt;background:${color}"></span>`,
      );
    }
  }

  for (const u of draw) {
    parts.push(textSpan(u));
  }

  return `<div class="pdf-page" style="width:${ex.widthPt.toFixed(
    2,
  )}pt;height:${ex.heightPt.toFixed(2)}pt">\n${parts.join("\n")}\n</div>`;
}

function textSpan(u: Unit): string {
  const style: string[] = [
    `left:${u.x.toFixed(2)}pt`,
    `top:${u.top.toFixed(2)}pt`,
  ];

  if (u.fontSizeOverride) {
    style.push(`font-size:${u.fontSizeOverride.toFixed(2)}pt`);
  }

  if (u.clip) {
    style.push(`width:${(u.width + 1).toFixed(2)}pt`, "overflow:hidden");
  } else if (u.wrap) {
    style.push(`width:${(u.width + 1).toFixed(2)}pt`, "white-space:pre-wrap");
  }

  return `<span class="txt ${u.className}" style="${style.join(
    ";",
  )}" data-tid="${u.tid}">${escapeHtml(u.text)}</span>`;
}

/** 遮盖块：覆盖底图上被改单元的原文字区域 */
function maskRect(u: Unit) {
  const fs = u.fontSizeOverride ?? u.fontSize;
  const w = Math.max(u.width, estimateTextWidthPt(u.text, fs)) + 1;

  return {
    left: u.x - 0.5,
    top: u.top - 0.15 * u.fontSize,
    width: w,
    height: u.fontSize * 1.5,
  };
}

/** 渲染用完整文档壳 */
export function docShell(
  css: string,
  body: string,
  opts: { fontCss?: string } = {},
): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
@page{margin:0}
html,body{margin:0;padding:0;background:#fff}
${opts.fontCss ?? ""}
${css}
</style>
</head>
<body>${body}</body>
</html>`;
}
````

---

## 8. `src/fonts.ts`

````ts
import { readFileSync } from "node:fs";
import type { FontResource } from "./types.js";

/** 从本地字体文件加载为 data URL */
export function loadFontFromFile(
  family: string,
  path: string,
  opts: Omit<FontResource, "family" | "src"> = {},
): FontResource {
  const buf = readFileSync(path);
  const ext = path.toLowerCase().split(".").pop();

  const format =
    opts.format ??
    (ext === "otf"
      ? "opentype"
      : ext === "woff2"
        ? "woff2"
        : ext === "woff"
          ? "woff"
          : "truetype");

  const mime =
    ext === "otf"
      ? "font/otf"
      : ext === "woff2"
        ? "font/woff2"
        : ext === "woff"
          ? "font/woff"
          : "font/ttf";

  return {
    family,
    src: `data:${mime};base64,${buf.toString("base64")}`,
    format,
    ...opts,
  };
}

/** 生成 @font-face CSS */
export function fontFaceCss(fonts: FontResource[]): string {
  return fonts
    .map((f) => {
      const family = f.family.replace(/"/g, '\\"');
      return `@font-face{font-family:"${family}";src:url("${f.src}") format("${
        f.format ?? "truetype"
      }");font-weight:${f.weight ?? 400};font-style:${f.style ?? "normal"}}`;
    })
    .join("\n");
}
````

---

## 9. `src/extractor.ts`

````ts
import {
  getDocument,
  OPS,
  GlobalWorkerOptions,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import { BASE_CSS, buildPageHtml } from "./html.js";
import { round1 } from "./util.js";
import type {
  PageBackground,
  PageExtract,
  StyleSignature,
  Unit,
} from "./types.js";

/** pdf.js worker 适配：浏览器环境必须设置 workerSrc */
export function configurePdfWorker(opts: { workerSrc?: string }): void {
  if (opts.workerSrc && GlobalWorkerOptions) {
    GlobalWorkerOptions.workerSrc = opts.workerSrc;
  }
}

/** mergeRuns 可调参数 */
export interface ExtractorOptions {
  /** 同行判定：基线差 <= max(1.2pt, fontSize×系数)，默认 0.3 */
  lineThresholdFactor?: number;

  /** 合并阈值：间距 < fontSize×系数 才合并，默认 0.45 */
  maxGapFactor?: number;

  /** 补空格阈值：间距 > fontSize×系数 补空格，默认 0.18 */
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

  /** 懒加载打开：只建文档句柄，不解析任何页面内容 */
  static async open(
    bytes: Uint8Array,
    opts: ExtractorOptions = {},
  ): Promise<StyleLockedExtractor> {
    const doc = await getDocument({
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
    const page = await this.doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });

    const tc: any = await page.getTextContent();
    const textItems = (tc.items as any[]).filter(
      (it) => typeof it.str === "string",
    );

    let colors =
      opts.recoverColor ?? true ? await recoverColors(page) : null;

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

  /**
   * 原页栅格化为底图。
   * 需要可选依赖 node-canvas：npm i canvas
   */
  async renderPageImage(
    pageNumber: number,
    opts: { scale?: number } = {},
  ): Promise<PageBackground> {
    const scale = opts.scale ?? 2;
    const page = await this.doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });

    let createCanvas: ((w: number, h: number) => any) | undefined;

    try {
      const dynamicImport = new Function(
        "s",
        "return import(s)",
      ) as (s: string) => Promise<any>;

      const mod = await dynamicImport("canvas");
      createCanvas = mod.createCanvas;
    } catch {
      // ignore
    }

    if (!createCanvas) {
      throw new Error(
        "背景底图模式需要 node-canvas（npm i canvas），或设 background:'none' 走纯文本重绘",
      );
    }

    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );

    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;

    return {
      dataUrl: canvas.toDataURL("image/png"),
      widthPt: viewport.width / scale,
      heightPt: viewport.height / scale,
    };
  }

  /** 行内合并：同基线 + 同样式 + 间距小于阈值 */
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
      };

      units.push(u);
      cur = u;
      curBase = r.baselineTop;
    }

    return units;
  }
}

/** 样式去重 → 固化 CSS 类 */
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

/** 尽力还原文字填充色 */
async function recoverColors(page: any): Promise<string[] | null> {
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
````

---

## 10. `src/ai-editor.ts`

````ts
import { buildEditPrompt, TEXT_EDIT_SYSTEM_PROMPT } from "./prompts.js";
import { applyGlossary, normalizeGlossary, sleep } from "./util.js";
import { reconcilePatches, type PatchOptions } from "./validator.js";
import type {
  ChatFn,
  ChatMessage,
  EditableUnit,
  Glossary,
  LLMAdapter,
} from "./types.js";

export interface AiEditorConfig {
  maxCharsPerCall?: number;
  maxRetries?: number;
  glossary?: Glossary;
  patch?: PatchOptions;
}

export class AiTextEditor {
  private readonly maxChars: number;
  private readonly maxRetries: number;
  private readonly terms: ReturnType<typeof normalizeGlossary>;
  private readonly patchOpts: PatchOptions;

  constructor(
    private chat: ChatFn,
    cfg: AiEditorConfig = {},
  ) {
    this.maxChars = cfg.maxCharsPerCall ?? 18_000;
    this.maxRetries = cfg.maxRetries ?? 2;
    this.terms = normalizeGlossary(cfg.glossary);
    this.patchOpts = {
      strict: false,
      missingTidsUseOriginal: true,
      ...cfg.patch,
    };
  }

  /**
   * 输入可编辑单元，输出 tid → 新文本。
   */
  async edit(
    units: EditableUnit[],
    instruction: string,
  ): Promise<Map<string, string>> {
    if (!units.length) return new Map();

    const merged = new Map<string, string>();
    const chunks = packChunks(units, this.maxChars);

    await Promise.all(
      chunks.map(async (c) => {
        const part = await this.editWithRetry(c, instruction);
        for (const [tid, text] of part) merged.set(tid, text);
      }),
    );

    const reconciled = reconcilePatches(units, merged, this.patchOpts);

    if (!this.terms.length) return reconciled;

    const out = new Map<string, string>();
    for (const [tid, text] of reconciled) {
      out.set(tid, applyGlossary(text, this.terms));
    }

    return out;
  }

  private async editWithRetry(
    units: EditableUnit[],
    instruction: string,
  ): Promise<Map<string, string>> {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const messages: ChatMessage[] = [
          { role: "system", content: TEXT_EDIT_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildEditPrompt(instruction, units, this.terms),
          },
        ];

        const raw = await this.chat(messages, {
          json: true,
          temperature: 0.1,
        });

        return parsePatchObject(raw);
      } catch (e) {
        lastErr = e;
        await sleep(400 * (attempt + 1));
      }
    }

    throw lastErr;
  }
}

/** 按字符预算打包 */
function packChunks(
  units: EditableUnit[],
  maxChars: number,
): EditableUnit[][] {
  const chunks: EditableUnit[][] = [];
  let cur: EditableUnit[] = [];
  let size = 0;

  for (const u of units) {
    const cost = u.tid.length + u.text.length + 48;

    if (cur.length && size + cost > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }

    cur.push(u);
    size += cost;
  }

  if (cur.length) chunks.push(cur);
  return chunks;
}

const FENCE = String.fromCharCode(96).repeat(3);
const FENCE_START = new RegExp(`^${FENCE}[a-zA-Z0-9_-]*\\s*`);
const FENCE_END = new RegExp(`\\s*${FENCE}$`);

/** 容错解析 AI JSON */
export function parsePatchObject(raw: string): Map<string, string> {
  let s = raw.trim().replace(FENCE_START, "").replace(FENCE_END, "");

  const l = s.indexOf("{");
  const r = s.lastIndexOf("}");

  if (l >= 0 && r > l) s = s.slice(l, r + 1);

  let obj: any;

  try {
    obj = JSON.parse(s);
  } catch (firstError) {
    try {
      obj = JSON.parse(s.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      throw firstError;
    }
  }

  const items = Array.isArray(obj) ? obj : obj?.items;

  if (!Array.isArray(items)) {
    throw new Error("AI 输出缺少 items 数组");
  }

  const out = new Map<string, string>();

  for (const it of items) {
    if (it && typeof it.tid === "string" && typeof it.text === "string") {
      out.set(it.tid, it.text);
    }
  }

  if (!out.size) {
    throw new Error("AI 输出无有效条目");
  }

  return out;
}

/** ChatFn / LLMAdapter 适配层 */
export const adapterToChatFn = (adapter: LLMAdapter): ChatFn =>
  (messages, opts) => adapter.complete(messages, opts);

/** 默认 DeepSeek OpenAI-compatible ChatFn */
export function createDeepSeekChatFn(cfg: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}): ChatFn {
  return async (messages, opts) => {
    const base = (cfg.baseUrl ?? "https://api.deepseek.com").replace(
      /\/+$/,
      "",
    );

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model ?? "deepseek-chat",
        messages,
        temperature: opts?.temperature ?? 0.1,
        stream: false,
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
    }

    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (typeof content !== "string") {
      throw new Error("DeepSeek 返回结构异常");
    }

    return content;
  };
}
````

---

## 11. `src/validator.ts`

````ts
import { estimateTextWidthPt, round1 } from "./util.js";
import type {
  EditableUnit,
  OverflowPolicy,
  PageExtract,
  Unit,
} from "./types.js";

export interface SanitizeOptions {
  maxGrowRatio?: number;
}

export function sanitizeText(
  original: string,
  next: unknown,
  opts: SanitizeOptions = {},
): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof next !== "string") {
    return { ok: false, reason: "类型非法" };
  }

  let t = next.replace(/<[^>]*>/g, "");
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  if (t.length === 0) {
    return { ok: false, reason: "空文本" };
  }

  const grow = opts.maxGrowRatio ?? 3;
  if (t.length > original.length * grow + 16) {
    return { ok: false, reason: "长度异常膨胀（疑似跑飞）" };
  }

  return { ok: true, text: t };
}

/** tid 严格校验 */
export interface PatchOptions {
  /** true：缺 tid / 未知 tid 直接抛错 */
  strict?: boolean;

  /** 宽松模式下，AI 漏返回的 tid 自动回填原文，默认 true */
  missingTidsUseOriginal?: boolean;
}

export function reconcilePatches(
  input: EditableUnit[],
  output: Map<string, string>,
  opts: PatchOptions = {},
): Map<string, string> {
  const result = new Map<string, string>();
  const inputTids = new Set(input.map((u) => u.tid));

  for (const [tid, text] of output) {
    if (!inputTids.has(tid)) {
      if (opts.strict) {
        throw new Error(`AI 返回了未知 tid（越权）: ${tid}`);
      }
      continue;
    }

    result.set(tid, text);
  }

  for (const u of input) {
    if (!result.has(u.tid)) {
      if (opts.strict) {
        throw new Error(`AI 缺少 tid: ${u.tid}`);
      }

      if (opts.missingTidsUseOriginal ?? true) {
        result.set(u.tid, u.text);
      }
    }
  }

  return result;
}

export interface ApplyOptions extends SanitizeOptions {
  strictUnknown?: boolean;
  overflow?: OverflowPolicy;
}

export interface ApplyReport {
  changed: number;
  changedTids: string[];
  rejected: Array<{ tid: string; reason: string }>;
}

/** 回填补丁：只按 tid 改 text */
export function applyPatches(
  page: PageExtract,
  patches: Map<string, string>,
  opts: ApplyOptions = {},
): ApplyReport {
  const report: ApplyReport = {
    changed: 0,
    changedTids: [],
    rejected: [],
  };

  const byTid = new Map(page.units.map((u) => [u.tid, u]));
  const policy: OverflowPolicy = opts.overflow ?? {
    mode: "shrink",
    minFontSizePt: 6,
  };

  for (const [tid, raw] of patches) {
    const unit = byTid.get(tid);

    if (!unit) {
      if (opts.strictUnknown) {
        report.rejected.push({ tid, reason: "未知 tid（越权）" });
      }
      continue;
    }

    if (raw === unit.text) continue;

    const s = sanitizeText(unit.text, raw, opts);
    if (!s.ok) {
      report.rejected.push({ tid, reason: s.reason });
      continue;
    }

    unit.fontSizeOverride = undefined;
    unit.clip = false;
    unit.wrap = false;

    if (overflowAction(unit, s.text, policy) === "reject") {
      report.rejected.push({
        tid,
        reason: "新文本溢出钉位，需人工确认",
      });
      continue;
    }

    unit.text = s.text;
    report.changed++;
    report.changedTids.push(tid);
  }

  return report;
}

function overflowAction(
  u: Unit,
  newText: string,
  p: OverflowPolicy,
): "ok" | "reject" {
  const est = estimateTextWidthPt(newText, u.fontSize);
  const limit = u.width * 1.06 + 2;
  const over = est > limit;

  switch (p.mode) {
    case "clip": {
      if (over) u.clip = true;
      return "ok";
    }

    case "wrap": {
      if (over) u.wrap = true;
      return "ok";
    }

    case "reject": {
      return over ? "reject" : "ok";
    }

    case "shrink": {
      if (!over) return "ok";

      const min = p.minFontSizePt ?? 6;
      const scaled = u.fontSize * (u.width / est);

      if (scaled >= min) {
        u.fontSizeOverride = round1(scaled);
        return "ok";
      }

      u.fontSizeOverride = min;
      u.clip = true;
      return "ok";
    }
  }
}

/** 旁路兜底：快速骨架比较 */
export function htmlSkeleton(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>([^<]*)</g, "><")
    .replace(/\s+/g, " ")
    .trim();
}

export const assertStructureIntact = (
  before: string,
  after: string,
): boolean => htmlSkeleton(before) === htmlSkeleton(after);

/** DOM 级旁路校验：逐标签比对标签名 + 属性 */
export function validateEditedHtml(
  originalHtml: string,
  editedHtml: string,
): { ok: boolean; diff?: string } {
  const a = tokenizeTags(originalHtml);
  const b = tokenizeTags(editedHtml);

  if (a.length !== b.length) {
    return {
      ok: false,
      diff: `标签数量不同: ${a.length} vs ${b.length}`,
    };
  }

  for (let i = 0; i < a.length; i++) {
    const ta = a[i];
    const tb = b[i];

    if (ta.name !== tb.name || ta.close !== tb.close) {
      return {
        ok: false,
        diff: `第${i + 1}个标签不同: <${ta.close ? "/" : ""}${ta.name}> vs <${
          tb.close ? "/" : ""
        }${tb.name}>`,
      };
    }

    if (JSON.stringify(ta.attrs) !== JSON.stringify(tb.attrs)) {
      return {
        ok: false,
        diff: `标签 <${ta.name}> 的属性被修改`,
      };
    }
  }

  return { ok: true };
}

interface TagTok {
  name: string;
  close: boolean;
  attrs: Array<[string, string]>;
}

function tokenizeTags(html: string): TagTok[] {
  const toks: TagTok[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;

  let m: RegExpExecArray | null;

  while ((m = re.exec(html))) {
    const attrs: Array<[string, string]> = [];
    const attrText = m[3];

    const are =
      /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

    let a: RegExpExecArray | null;

    while ((a = are.exec(attrText))) {
      const value = a[3] ?? a[4] ?? a[5] ?? "";
      attrs.push([a[1].toLowerCase(), value]);
    }

    attrs.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

    toks.push({
      name: m[2].toLowerCase(),
      close: m[1] === "/",
      attrs,
    });
  }

  return toks;
}
````

---

## 12. `src/renderer.ts`

````ts
import { chromium, type Browser } from "playwright";
import { docShell } from "./html.js";
import { pLimit } from "./util.js";

const pt2in = (pt: number): string => `${(pt / 72).toFixed(3)}in`;

const ZERO_MARGIN = {
  top: "0",
  right: "0",
  bottom: "0",
  left: "0",
} as const;

export interface RenderOptions {
  fontCss?: string;
}

export class PlaywrightRenderer {
  private browser?: Browser;
  private readonly slot: ReturnType<typeof pLimit>;

  constructor(concurrency = 4) {
    this.slot = pLimit(concurrency);
  }

  private async ensureBrowser(): Promise<Browser> {
    this.browser ??= await chromium.launch({ headless: true });
    return this.browser;
  }

  /** 钉版式单页重绘 */
  async renderPage(
    ex: { widthPt: number; heightPt: number; css: string; html: string },
    opts: RenderOptions = {},
  ): Promise<Uint8Array> {
    return this.slot(async () => {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.setContent(docShell(ex.css, ex.html, { fontCss: opts.fontCss }), {
          waitUntil: "domcontentloaded",
        });

        await page.evaluate(() => (document as any).fonts?.ready ?? Promise.resolve());

        const buf = await page.pdf({
          width: pt2in(ex.widthPt),
          height: pt2in(ex.heightPt),
          printBackground: true,
          pageRanges: "1",
          margin: ZERO_MARGIN,
        });

        return new Uint8Array(buf);
      } finally {
        await context.close().catch(() => {});
      }
    });
  }

  /** 流式排版：模板接管样式，内容自动分页 */
  async renderFlow(
    css: string,
    bodyHtml: string,
    pageSize: { widthPt: number; heightPt: number },
    opts: RenderOptions = {},
  ): Promise<Uint8Array> {
    return this.slot(async () => {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await page.setContent(docShell(css, bodyHtml, { fontCss: opts.fontCss }), {
          waitUntil: "domcontentloaded",
        });

        await page.evaluate(() => (document as any).fonts?.ready ?? Promise.resolve());

        const buf = await page.pdf({
          width: pt2in(pageSize.widthPt),
          height: pt2in(pageSize.heightPt),
          printBackground: true,
          margin: ZERO_MARGIN,
        });

        return new Uint8Array(buf);
      } finally {
        await context.close().catch(() => {});
      }
    });
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }
}
````

---

## 13. `src/pdf-ops.ts`

````ts
import { PDFDocument } from "pdf-lib";

/**
 * 按页替换：只重写被改的页。
 * 未修改页走最长连续区间批量拷贝。
 */
export async function replacePages(
  original: Uint8Array,
  replacements: Map<number, Uint8Array>,
): Promise<Uint8Array> {
  if (replacements.size === 0) {
    return original.slice();
  }

  const src = await PDFDocument.load(original, { ignoreEncryption: true });
  const total = src.getPageCount();

  const out = await PDFDocument.create();
  copyMetadata(src, out);

  let i = 1;

  while (i <= total) {
    if (replacements.has(i)) {
      const single = await PDFDocument.load(replacements.get(i)!, {
        ignoreEncryption: true,
      });

      const [pg] = await out.copyPages(single, [0]);
      out.addPage(pg);
      i++;
    } else {
      let j = i;
      while (j <= total && !replacements.has(j)) j++;

      const idx: number[] = [];
      for (let k = i; k < j; k++) idx.push(k - 1);

      const pages = await out.copyPages(src, idx);
      for (const pg of pages) out.addPage(pg);

      i = j;
    }
  }

  return out.save();
}

/** 版式重排：整本换新页，只继承元数据 */
export async function replaceEntireDocument(
  newBytes: Uint8Array,
  metaSource: Uint8Array,
): Promise<Uint8Array> {
  const meta = await PDFDocument.load(metaSource, { ignoreEncryption: true });
  const doc = await PDFDocument.load(newBytes, { ignoreEncryption: true });

  copyMetadata(meta, doc);
  return doc.save();
}

function copyMetadata(from: PDFDocument, to: PDFDocument): void {
  try {
    to.setTitle(from.getTitle() ?? "");
    to.setAuthor(from.getAuthor() ?? "");
    to.setSubject(from.getSubject() ?? "");

    const keywords = from.getKeywords();
    if (keywords) {
      to.setKeywords(Array.isArray(keywords) ? keywords : [keywords]);
    }

    to.setProducer(from.getProducer() ?? "style-locked-editor");
    to.setCreator(from.getCreator() ?? "style-locked-editor");

    const d = from.getCreationDate();
    if (d) to.setCreationDate(d);

    const m = from.getModificationDate();
    if (m) to.setModificationDate(m);
  } catch {
    // 元数据缺失不影响正文
  }
}
````

---

## 14. `src/templates.ts`

````ts
import { escapeHtml } from "./util.js";

export type TemplateId = "academic" | "mobile" | "briefing";

export interface LayoutTemplate {
  id: TemplateId;
  name: string;
  pageSize: { widthPt: number; heightPt: number };
  css: string;
}

const A4 = { widthPt: 595.28, heightPt: 841.89 };
const PHONE = { widthPt: 320, heightPt: 568 };

export const TEMPLATES: Record<TemplateId, LayoutTemplate> = {
  academic: {
    id: "academic",
    name: "学术双栏",
    pageSize: A4,
    css: `.doc-title{column-span:all;font-size:17pt;font-weight:700;text-align:center;margin:0 0 12pt}
.content{column-count:2;column-gap:18pt;column-rule:.5pt solid #ccc;font-size:9.5pt;line-height:1.55;text-align:justify}
h2{font-size:11.5pt;font-weight:700;margin:10pt 0 4pt;break-after:avoid}
h3{font-size:10.5pt;font-weight:700;margin:8pt 0 3pt}
p{margin:0 0 5pt;text-indent:2em}
p.caption{font-size:8pt;color:#555;text-indent:0;text-align:center;margin:2pt 0 8pt}`,
  },

  mobile: {
    id: "mobile",
    name: "手机单栏",
    pageSize: PHONE,
    css: `.doc-title{font-size:16pt;font-weight:700;line-height:1.35;margin:0 0 12pt}
.content{font-size:11pt;line-height:1.8}
h2{font-size:13pt;font-weight:700;margin:14pt 0 6pt}
h3{font-size:12pt;font-weight:700;margin:12pt 0 5pt}
p{margin:0 0 9pt}
p.caption{font-size:9pt;color:#777}`,
  },

  briefing: {
    id: "briefing",
    name: "商务简报",
    pageSize: A4,
    css: `.doc-title{font-size:22pt;font-weight:800;color:#0f2b46;border-bottom:3pt solid #2f6fed;padding-bottom:6pt;margin:0 0 14pt}
.content{font-size:10.5pt;line-height:1.65;color:#222}
h2{font-size:13pt;font-weight:700;color:#2f6fed;border-left:3pt solid #2f6fed;padding-left:6pt;margin:12pt 0 5pt;break-after:avoid}
h3{font-size:11.5pt;font-weight:700;color:#0f2b46;margin:10pt 0 4pt}
p{margin:0 0 7pt}
p.caption{font-size:8.5pt;color:#6a737d}`,
  },
};

export function fillTemplate(
  tpl: LayoutTemplate,
  title: string | null,
  bodyHtml: string,
): string {
  const head = title
    ? `<h1 class="doc-title">${escapeHtml(title)}</h1>`
    : "";

  return `<div class="doc">${head}<div class="content">${bodyHtml}</div></div>`;
}
````

---

## 15. `src/flow.ts`

````ts
import { escapeHtml, median } from "./util.js";
import type { PageExtract, Unit } from "./types.js";

export interface FlowBlock {
  kind: "heading" | "subheading" | "body" | "caption";
  text: string;
  size: number;
}

/** 启发式分类：字号中位数为正文基准 */
export function buildFlowBlocks(pages: PageExtract[]): FlowBlock[] {
  const sizes: number[] = [];

  for (const p of pages) {
    for (const u of p.units) sizes.push(u.fontSize);
  }

  const bodySize = median(sizes) || 12;
  const blocks: FlowBlock[] = [];

  for (const page of pages) {
    const units = [...page.units].sort((a, b) => a.top - b.top || a.x - b.x);

    let para: Unit[] = [];

    const flush = () => {
      if (para.length) {
        blocks.push(classify(para, bodySize));
        para = [];
      }
    };

    for (const u of units) {
      const prev = para[para.length - 1];

      if (
        prev &&
        u.top - prev.top > Math.max(prev.fontSize, u.fontSize) * 2.1
      ) {
        flush();
      }

      para.push(u);
    }

    flush();
  }

  return blocks;
}

function classify(para: Unit[], bodySize: number): FlowBlock {
  const size = para[0].fontSize;

  let kind: FlowBlock["kind"] = "body";

  if (size >= bodySize * 1.45) kind = "heading";
  else if (size >= bodySize * 1.15) kind = "subheading";
  else if (size <= bodySize * 0.85) kind = "caption";

  return { kind, text: joinText(para), size };
}

const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

function joinText(units: Unit[]): string {
  let s = "";

  for (const u of units) {
    if (s && u.text) {
      const a = s[s.length - 1];
      const b = u.text[0];

      if (!CJK.test(a) && !CJK.test(b)) s += " ";
    }

    s += u.text;
  }

  return s.replace(/\s{2,}/g, " ").trim();
}

/** 槽位填充 */
export function blocksToHtml(blocks: FlowBlock[]): {
  title: string | null;
  bodyHtml: string;
} {
  const mainTitle = blocks.find((b) => b.kind === "heading") ?? null;
  const parts: string[] = [];

  for (const b of blocks) {
    if (b === mainTitle) continue;

    if (b.kind === "heading") {
      parts.push(`<h2>${escapeHtml(b.text)}</h2>`);
    } else if (b.kind === "subheading") {
      parts.push(`<h3>${escapeHtml(b.text)}</h3>`);
    } else if (b.kind === "caption") {
      parts.push(`<p class="caption">${escapeHtml(b.text)}</p>`);
    } else {
      parts.push(`<p>${escapeHtml(b.text)}</p>`);
    }
  }

  return {
    title: mainTitle?.text ?? null,
    bodyHtml: parts.join("\n"),
  };
}
````

---

## 16. `src/pipeline.ts`

````ts
import { AiTextEditor } from "./ai-editor.js";
import { StyleLockedExtractor, type ExtractorOptions } from "./extractor.js";
import { fontFaceCss } from "./fonts.js";
import { blocksToHtml, buildFlowBlocks } from "./flow.js";
import { buildPageHtml } from "./html.js";
import { replaceEntireDocument, replacePages } from "./pdf-ops.js";
import { PlaywrightRenderer } from "./renderer.js";
import { TEMPLATES, fillTemplate, type TemplateId } from "./templates.js";
import { applyPatches, type ApplyReport } from "./validator.js";
import { chunk, hash32, pLimit, range } from "./util.js";

import type {
  ChatFn,
  EditableUnit,
  FontResource,
  Glossary,
  OverflowPolicy,
  PageExtract,
  ProgressFn,
  Unit,
} from "./types.js";

export interface EditorOptions {
  batchSize?: number;
  extractConcurrency?: number;
  renderConcurrency?: number;
  aiMaxCharsPerCall?: number;
  recoverColor?: boolean;
  strictColor?: boolean;
  merge?: ExtractorOptions;
  overflow?: OverflowPolicy;
  glossary?: Glossary;

  /** 底图模式 */
  background?: "none" | "image";

  backgroundScale?: number;
  patchColor?: string;
  fonts?: FontResource[];
  strictTids?: boolean;
  missingTidsUseOriginal?: boolean;

  /**
   * none：渲染完成后立即释放底图，适合全篇批改，内存更安全。
   * session：同一 editor 实例内保留底图，适合单页反复微调。
   */
  backgroundRetention?: "none" | "session";
}

interface ResolvedEditorOptions {
  batchSize: number;
  extractConcurrency: number;
  renderConcurrency: number;
  aiMaxCharsPerCall: number;
  recoverColor: boolean;
  strictColor: boolean;
  merge: ExtractorOptions;
  overflow: OverflowPolicy;
  glossary?: Glossary;
  background: "none" | "image";
  backgroundScale: number;
  patchColor: string;
  fonts: FontResource[];
  strictTids: boolean;
  missingTidsUseOriginal: boolean;
  backgroundRetention: "none" | "session";
}

type BatchExtractResult =
  | { ok: true; extracts: PageExtract[] }
  | { ok: false; error: unknown };

const toEditable = (u: Unit): EditableUnit => ({ tid: u.tid, text: u.text });

export class StyleLockedEditor {
  readonly docHash: string;

  private readonly extractCache = new Map<number, PageExtract>();

  lastFailures: Array<{ page: number; error: unknown }> = [];
  warnings: string[] = [];

  private readonly fontCss: string;

  private constructor(
    private readonly original: Uint8Array,
    private readonly extractor: StyleLockedExtractor,
    private readonly renderer: PlaywrightRenderer,
    private readonly ai: AiTextEditor,
    private readonly opts: ResolvedEditorOptions,
  ) {
    this.docHash = hash32(original);
    this.fontCss = opts.fonts.length ? fontFaceCss(opts.fonts) : "";
  }

  static async open(
    original: Uint8Array,
    chat: ChatFn,
    opts: EditorOptions = {},
  ): Promise<StyleLockedEditor> {
    const o: ResolvedEditorOptions = {
      batchSize: opts.batchSize ?? 10,
      extractConcurrency: opts.extractConcurrency ?? 4,
      renderConcurrency: opts.renderConcurrency ?? 4,
      aiMaxCharsPerCall: opts.aiMaxCharsPerCall ?? 18_000,
      recoverColor: opts.recoverColor ?? true,
      strictColor: opts.strictColor ?? false,
      merge: { ...opts.merge },
      overflow: opts.overflow ?? { mode: "shrink", minFontSizePt: 6 },
      glossary: opts.glossary,
      background: opts.background ?? "none",
      backgroundScale: opts.backgroundScale ?? 2,
      patchColor: opts.patchColor ?? "#ffffff",
      fonts: opts.fonts ?? [],
      strictTids: opts.strictTids ?? false,
      missingTidsUseOriginal: opts.missingTidsUseOriginal ?? true,
      backgroundRetention: opts.backgroundRetention ?? "none",
    };

    const extractor = await StyleLockedExtractor.open(original, o.merge);

    return new StyleLockedEditor(
      original.slice(),
      extractor,
      new PlaywrightRenderer(o.renderConcurrency),
      new AiTextEditor(chat, {
        maxCharsPerCall: o.aiMaxCharsPerCall,
        glossary: o.glossary,
        patch: {
          strict: o.strictTids,
          missingTidsUseOriginal: o.missingTidsUseOriginal,
        },
      }),
      o,
    );
  }

  get pageCount(): number {
    return this.extractor.pageCount;
  }

  /** 预览某页可编辑文本 */
  async previewPage(pageNumber: number): Promise<EditableUnit[]> {
    const ex = await this.getExtract(pageNumber);
    return ex.units.map(toEditable);
  }

  /** 场景①：单页微调 */
  async editPage(
    pageNumber: number,
    instruction: string,
    targetTids?: string[],
  ): Promise<Uint8Array> {
    const ex = await this.getExtract(pageNumber);

    let units = ex.units.map(toEditable);

    if (targetTids?.length) {
      const set = new Set(targetTids);
      units = units.filter((u) => set.has(u.tid));
    }

    const patches = await this.ai.edit(units, instruction);

    const report = applyPatches(ex, patches, {
      overflow: this.opts.overflow,
      strictUnknown: this.opts.strictTids,
    });

    const hasDirty = (ex.dirtyTids?.size ?? 0) > 0;

    if (report.changed === 0 && !hasDirty) {
      return this.original.slice();
    }

    const pagePdf = await this.rebuildAndRender(ex, report);
    return replacePages(this.original, new Map([[pageNumber, pagePdf]]));
  }

  /** 场景②：全篇批改 */
  async editDocument(
    instruction: string,
    onProgress?: ProgressFn,
  ): Promise<Uint8Array> {
    const total = this.pageCount;
    this.lastFailures = [];

    if (total === 0) return this.original.slice();

    const batches = chunk(range(1, total), this.opts.batchSize);
    const replacements = new Map<number, Uint8Array>();
    const renderTasks: Array<Promise<void>> = [];

    let done = 0;

    let prefetch: Promise<BatchExtractResult> | null = this.extractBatch(
      batches[0],
    );

    for (let b = 0; b < batches.length; b++) {
      const result = await prefetch!;

      prefetch =
        b + 1 < batches.length ? this.extractBatch(batches[b + 1]) : null;

      if (!result.ok) {
        for (const n of batches[b]) {
          this.lastFailures.push({ page: n, error: result.error });
        }

        done += batches[b].length;
        onProgress?.({
          stage: "error",
          done,
          total,
          message: `第${b + 1}批提取失败，本批沿用原文`,
        });

        continue;
      }

      const extracts = result.extracts;

      let patches = new Map<string, string>();

      try {
        patches = await this.ai.edit(
          extracts.flatMap((p) => p.units.map(toEditable)),
          instruction,
        );
      } catch (e) {
        for (const n of batches[b]) {
          this.lastFailures.push({ page: n, error: e });
        }

        done += batches[b].length;
        onProgress?.({
          stage: "error",
          done,
          total,
          message: `第${b + 1}批 AI 调用失败，本批沿用原文`,
        });

        continue;
      }

      for (const ex of extracts) {
        const report = applyPatches(ex, patches, {
          overflow: this.opts.overflow,
          strictUnknown: this.opts.strictTids,
        });

        const hasDirty = (ex.dirtyTids?.size ?? 0) > 0;

        if (report.changed === 0 && !hasDirty) {
          done++;
          onProgress?.({
            stage: "skip",
            done,
            total,
            page: ex.pageNumber,
            message: "无改动，复用原页",
          });
          continue;
        }

        renderTasks.push(
          this.rebuildAndRender(ex, report)
            .then((bytes) => {
              replacements.set(ex.pageNumber, bytes);
              done++;
              onProgress?.({
                stage: "render",
                done,
                total,
                page: ex.pageNumber,
              });
            })
            .catch((e) => {
              this.lastFailures.push({ page: ex.pageNumber, error: e });
              done++;
              onProgress?.({
                stage: "error",
                done,
                total,
                page: ex.pageNumber,
                message: String(e),
              });
            }),
        );
      }
    }

    await Promise.all(renderTasks);

    onProgress?.({ stage: "merge", done: total, total });

    return replacePages(this.original, replacements);
  }

  /** 场景③：更换版式 */
  async relayout(
    templateId: TemplateId,
    onProgress?: ProgressFn,
  ): Promise<Uint8Array> {
    const tpl = TEMPLATES[templateId];
    const extracts: PageExtract[] = [];

    const total = this.pageCount;
    const limit = pLimit(this.opts.extractConcurrency);

    await Promise.all(
      range(1, total).map((n) =>
        limit(async () => {
          extracts.push(await this.getExtract(n));
          onProgress?.({
            stage: "extract",
            done: extracts.length,
            total,
            page: n,
          });
        }),
      ),
    );

    extracts.sort((a, b) => a.pageNumber - b.pageNumber);

    const { title, bodyHtml } = blocksToHtml(buildFlowBlocks(extracts));
    const html = fillTemplate(tpl, title, bodyHtml);

    const bytes = await this.renderer.renderFlow(
      tpl.css,
      html,
      tpl.pageSize,
      { fontCss: this.fontCss },
    );

    return replaceEntireDocument(bytes, this.original);
  }

  async close(): Promise<void> {
    await this.renderer.close();
  }

  /** 回填后重建 HTML 并渲染单页 */
  private async rebuildAndRender(
    ex: PageExtract,
    report: ApplyReport,
  ): Promise<Uint8Array> {
    if (report.changedTids.length) {
      ex.dirtyTids = new Set([...(ex.dirtyTids ?? []), ...report.changedTids]);
    }

    await this.ensureBackground(ex);

    const changedTids =
      this.opts.background === "image"
        ? ex.dirtyTids ?? new Set<string>()
        : undefined;

    ex.html = buildPageHtml(ex, {
      changedTids,
      patchColor: this.opts.patchColor,
    });

    const pdf = await this.renderer.renderPage(ex, {
      fontCss: this.fontCss,
    });

    if (
      this.opts.background === "image" &&
      this.opts.backgroundRetention === "none"
    ) {
      ex.background = undefined;
    }

    return pdf;
  }

  private async ensureBackground(ex: PageExtract): Promise<void> {
    if (this.opts.background !== "image") return;
    if (ex.background) return;

    try {
      ex.background = await this.extractor.renderPageImage(ex.pageNumber, {
        scale: this.opts.backgroundScale,
      });
    } catch (e) {
      this.warnings.push(
        `第${ex.pageNumber}页底图渲染失败，退回纯文本重绘: ${String(e)}`,
      );
    }
  }

  private async getExtract(pageNumber: number): Promise<PageExtract> {
    let ex = this.extractCache.get(pageNumber);

    if (!ex) {
      ex = await this.extractor.extractPage(pageNumber, {
        recoverColor: this.opts.recoverColor,
        strictColor: this.opts.strictColor,
      });

      this.extractCache.set(pageNumber, ex);
    }

    return ex;
  }

  private extractBatch(pageNumbers: number[]): Promise<BatchExtractResult> {
    const limit = pLimit(this.opts.extractConcurrency);

    return Promise.all(pageNumbers.map((n) => limit(() => this.getExtract(n))))
      .then((extracts) => ({ ok: true as const, extracts }))
      .catch((error) => ({ ok: false as const, error }));
  }
}
````

---

## 17. `src/index.ts`

````ts
export * from "./types.js";
export * from "./util.js";
export * from "./prompts.js";
export * from "./html.js";
export * from "./fonts.js";
export * from "./extractor.js";
export * from "./ai-editor.js";
export * from "./validator.js";
export * from "./renderer.js";
export * from "./pdf-ops.js";
export * from "./templates.js";
export * from "./flow.js";
export * from "./pipeline.js";
````

---

## 18. `example.ts`

````ts
import { readFileSync, writeFileSync } from "node:fs";

import {
  adapterToChatFn,
  createDeepSeekChatFn,
  loadFontFromFile,
  StyleLockedEditor,
  type LLMAdapter,
} from "./src/index.js";

async function main() {
  const original = new Uint8Array(readFileSync("input.pdf"));

  /**
   * 方式一：直接用默认 DeepSeek ChatFn
   */
  const chat = createDeepSeekChatFn({
    apiKey: process.env.DEEPSEEK_API_KEY!,
  });

  /**
   * 方式二：如果你的 DeepSeek Harness 是 LLMAdapter 形态，
   * 可以这样接：
   *
   * const yourAdapter: LLMAdapter = ...;
   * const chat = adapterToChatFn(yourAdapter);
   */

  const editor = await StyleLockedEditor.open(original, chat, {
    glossary: {
      数据中台: "数据平台",
      帐号: "账号",
    },

    overflow: {
      mode: "shrink",
      minFontSizePt: 6,
    },

    /**
     * 纯文本文档建议 none；
     * 有图片/表格线/Logo 的复杂版面用 image。
     */
    background: "image",
    backgroundScale: 2,
    backgroundRetention: "none",

    /**
     * 中文字体分发。
     * family 必须与 PDF 内字体名 normalize 后一致。
     */
    fonts: [
      // loadFontFromFile("SimSun", "./assets/simsun.ttf"),
    ],

    strictTids: false,
    missingTidsUseOriginal: true,

    /**
     * 双栏/表格文档可收紧合并阈值：
     * merge: { maxGapFactor: 0.3 },
     */

    /**
     * 颜色 op 对不齐时宁黑勿错：
     * strictColor: true,
     */
  });

  try {
    /** ① 单页微调 */
    const p3 = await editor.editPage(
      3,
      "修正本页错别字；把“帐号”统一为“账号”",
    );
    writeFileSync("out.p3.pdf", p3);

    /** ② 全篇批改 */
    const all = await editor.editDocument(
      "全文校对：修正错别字与标点；术语统一：数据中台→数据平台",
      (p) => {
        console.log(
          `[${p.stage}] ${p.done}/${p.total}` +
            (p.page ? ` 第${p.page}页` : "") +
            (p.message ? ` ${p.message}` : ""),
        );
      },
    );

    writeFileSync("out.all.pdf", all);

    if (editor.lastFailures.length) {
      console.warn(
        "失败页（已沿用原文）:",
        editor.lastFailures.map((f) => f.page),
      );
    }

    if (editor.warnings.length) {
      console.warn("警告:", editor.warnings);
    }

    /** ③ 一键换版式 */
    const mobile = await editor.relayout("mobile");
    writeFileSync("out.mobile.pdf", mobile);
  } finally {
    await editor.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
````

---

## 19. 插件接入时你只需要重点改这几处

### 1）DeepSeek Harness 接入

如果你的 Harness 是函数式：

```ts
const chat = yourHarnessChatFunction;
```

如果是 adapter：

```ts
const chat = adapterToChatFn(yourAdapter);
```

只要满足：

```ts
(messages: ChatMessage[], opts?: ChatOptions) => Promise<string>
```

即可。

---

### 2）插件 UI 进度条

直接消费：

```ts
onProgress: (p) => {
  // p.stage
  // p.done
  // p.total
  // p.page
  // p.message
}
```

---

### 3）复杂 PDF 开启底图模式

```ts
background: "image"
```

如果是 500 页大文档，建议保持：

```ts
backgroundRetention: "none"
```

如果是单页反复编辑，可以开：

```ts
backgroundRetention: "session"
```

---

### 4）纯文本 PDF 推荐配置

```ts
{
  background: "none",
  overflow: { mode: "shrink", minFontSizePt: 7 },
  strictTids: false,
  missingTidsUseOriginal: true
}
```

---

## 20. 这一版已经可以作为实现基线

这套代码已经完成了你方案里的核心闭环：

```text
PDF
 ↓ pdf.js 提取
Unit[] = 钉子 + 流水
 ↓ 只暴露 { tid, text }
DeepSeek
 ↓ 返回 { tid, text }
tid 校验 / 术语后处理 / sanitize / overflow
 ↓
引擎重建锁定 HTML
 ↓ Playwright 渲染单页 PDF
 ↓ pdf-lib 替换原页
```

并且 AI 全程不接触 HTML、class、style、font、position。  
这已经符合你的核心原则：

> 样式做“钉子”，内容做“流水”；AI 只改词，引擎管样式。