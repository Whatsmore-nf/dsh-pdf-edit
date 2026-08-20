# @whatsmore-nf/dsh-plugin-pdf-edit

Style-locked PDF editor plugin for [DeepSeek Harness](https://github.com/Whatsmore-nf) — AI edits text, native renderer preserves layout.

## Features

- **Style-locked editing** — AI modifies text content while preserving original fonts, sizes, colors, and positions
- **Native renderer** — uses `pdf-lib` direct draw, zero browser dependency, zero native compilation
- **CJK support** — auto-detects and embeds CJK fonts (SimHei / MS Gothic / Noto Sans CJK) for Chinese, Japanese, Korean
- **Overflow handling** — shrink, clip, wrap, or reject when replacement text exceeds original box
- **Glossary** — global term substitution (e.g. `帐号 → 账号`) applied before AI call
- **Batch editing** — edit entire document page-by-page with progress tracking
- **Relayout** — reflow extracted text into academic (2-col A4), mobile (single-col), or briefing templates
- **Browser mode** (optional) — `puppeteer-core` + system Chrome for complex CSS rendering when needed

## Install

```bash
# Harness plugin CLI
dsh plugin --profile web add @whatsmore-nf/dsh-plugin-pdf-edit@latest

# npm
npm install @whatsmore-nf/dsh-plugin-pdf-edit
```

## Quick Start

```typescript
import { activate, tools } from "@whatsmore-nf/dsh-plugin-pdf-edit";

// Activate with DeepSeek API key
activate({
  apiKey: process.env.DEEPSEEK_API_KEY,
  glossary: { "帐号": "账号", "数据中台": "数据平台" },
  overflow: { mode: "shrink", minFontSizePt: 6 },
});

// Edit a single page
const { outputPath, changed } = await tools["pdf-edit-page"].execute({
  pdfPath: "./report.pdf",
  pageNumber: 1,
  instruction: "修正错别字，统一术语",
});
console.log(changed ? `Saved to ${outputPath}` : "No changes");

// Edit entire document
const result = await tools["pdf-edit-document"].execute({
  pdfPath: "./report.pdf",
  instruction: "将所有「帐号」替换为「账号」，修正语法错误",
  onProgress: (info) => console.log(`[${info.stage}] ${info.done}/${info.total}`),
});

// Relayout to academic 2-column template
await tools["pdf-edit-relayout"].execute({
  pdfPath: "./report.pdf",
  templateId: "academic",
});
```

## Configuration

```typescript
interface DshPdfEditConfig {
  /** DeepSeek API key (or set DEEPSEEK_API_KEY env) */
  apiKey?: string;
  /** Custom API base URL */
  baseUrl?: string;
  /** Model name (default: deepseek-chat) */
  model?: string;

  /** Overflow policy when replacement text is wider than original */
  overflow?: OverflowPolicy;
  /** Global term substitution */
  glossary?: Glossary;
  /** Custom font configuration */
  fonts?: FontConfig;
  /** Background patch color (default: #ffffff) */
  patchColor?: string;

  /** Strict TID matching — reject patches for unknown tids */
  strictTids?: boolean;
  /** Use original text when AI returns unknown tid */
  missingTidsUseOriginal?: boolean;
  /** Recover color from surrounding context */
  recoverColor?: boolean;
  /** Strict color matching */
  strictColor?: boolean;

  /** Render mode: "native" (pdf-lib direct) or "browser" (puppeteer-core) */
  renderMode?: "native" | "browser";
  /** Path to Chrome/Chromium executable (browser mode only) */
  browserExecutablePath?: string;
  /** Max concurrent browser pages (browser mode only) */
  browserConcurrency?: number;
}
```

### OverflowPolicy

```typescript
interface OverflowPolicy {
  mode: "clip" | "shrink" | "reject" | "wrap";
  minFontSizePt?: number; // for shrink mode, default 6
}
```

| Mode | Behavior |
|---|---|
| `shrink` | Reduce font size to fit, down to `minFontSizePt` |
| `clip` | Truncate text with ellipsis (…) |
| `wrap` | Wrap to next line if space allows |
| `reject` | Throw error on overflow |

### FontConfig

```typescript
interface FontConfig {
  customs?: Array<{
    family: string;
    path?: string;   // local .ttf/.otf path
    url?: string;    // remote font URL
    bytes?: Uint8Array;
  }>;
  cjk?: {
    path?: string;
    url?: string;
    bytes?: Uint8Array;
  };
  cjkAutoDetect?: boolean; // auto-find system CJK font, default true
  fakeBold?: boolean;      // simulate bold for fonts without bold variant
}
```

### Glossary

```typescript
// Object form
type Glossary = Record<string, string>;

// Array form (preserves order)
type Glossary = Array<{ from: string; to: string }>;
```

## Tools

### `pdf-edit-page`

Edit a single page with natural language instruction.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pdfPath` | `string` | ✅ | Input PDF file path |
| `pageNumber` | `number` | ✅ | 1-based page number |
| `instruction` | `string` | ✅ | Natural language edit instruction |
| `targetTids` | `string[]` | | Restrict editing to specific text units |
| `outputPath` | `string` | | Output file path (default: `*.edited.pdf`) |

### `pdf-edit-document`

Edit all pages in a document.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pdfPath` | `string` | ✅ | Input PDF file path |
| `instruction` | `string` | ✅ | Natural language edit instruction |
| `outputPath` | `string` | | Output file path |
| `onProgress` | `ProgressFn` | | Progress callback |

### `pdf-edit-relayout`

Reflow document text into a template layout.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `pdfPath` | `string` | ✅ | Input PDF file path |
| `templateId` | `"academic" \| "mobile" \| "briefing"` | ✅ | Layout template |
| `outputPath` | `string` | | Output file path |
| `onProgress` | `ProgressFn` | | Progress callback |

## Relayout Templates

| Template | Description |
|---|---|
| `academic` | A4, 2-column, Times serif, 9.5pt body — for papers & journals |
| `mobile` | 320×568, single-column, Helvetica, 13pt body — for phone reading |
| `briefing` | A4, single-column, Helvetica, 10pt body — for business reports |

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  extractor   │────▶│  validator   │────▶│ native-renderer │
│ (pdfjs-dist) │     │ (measure +   │     │ (pdf-lib draw)  │
│              │     │  overflow)   │     │                 │
└─────────────┘     └──────────────┘     └─────────────────┘
       │                    │                      │
       ▼                    ▼                      ▼
  PageExtract          applyPatches          renderPatches
  (units + style)     (text → patches)      (patches → PDF)
```

**Native mode (default):**
- `pdfjs-dist` extracts text positions & styles
- `@pdf-lib/fontkit` measures real glyph widths
- `pdf-lib` overlays white rectangles + redraws text at exact positions
- Zero browser, zero native compilation, ~25 kB package

**Browser mode (optional):**
- Uses `puppeteer-core` + system Chrome
- Set `renderMode: "browser"` and `browserExecutablePath`
- For cases requiring CSS features not expressible in pdf-lib

## Dependencies

| Package | Purpose | Size |
|---|---|---|
| `pdf-lib` | PDF load / modify / draw / save | ~200 kB |
| `@pdf-lib/fontkit` | Font parsing & glyph measurement | ~150 kB |
| `pdfjs-dist` | Text extraction (lazy loaded) | ~500 kB |
| `puppeteer-core` | Browser rendering (optional) | — |

## Development

```bash
# Install
npm install

# Build
npm run build

# Type check
npm run lint

# Watch mode
npm run dev
```

## License

[MIT](./LICENSE)