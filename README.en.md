# @whatsmore-nf/dsh-plugin-pdf-edit

> English | [中文](./README.md)

DeepSeek Harness plugin — AI edits PDF text, automatically preserving the original layout.

## What Is This

An AI-powered PDF editing plugin. Tell it what to change in natural language, and it will:

- **Edit text only, keep layout intact** — Fonts, sizes, colors, and positions are all locked. The result looks identical to the original
- **Handle overflow automatically** — When replacement text is longer, font size shrinks or text truncates. Layout never breaks
- **Support CJK** — Auto-detects and embeds system CJK fonts (SimHei / MS Gothic / Noto Sans CJK)

## Use Cases

| Scenario | Example |
|---|---|
| **Terminology standardization** | Replace 「帐号」with 「账号」, 「数据中台」with 「数据平台」document-wide |
| **Typo correction** | Let AI scan and fix spelling and grammar errors |
| **Contract/report batch editing** | Replace names, amounts, dates across multi-page documents |
| **Format conversion** | Reflow messy PDFs into academic 2-column, mobile single-column, or briefing layouts |

## Install

```bash
# Via Harness plugin CLI (same as official plugins)
dsh plugin --profile web add @whatsmore-nf/dsh-plugin-pdf-edit@latest

# Or via npm
npm install @whatsmore-nf/dsh-plugin-pdf-edit
```

## Usage

### 1. Activate

```typescript
import { activate, tools } from "@whatsmore-nf/dsh-plugin-pdf-edit";

activate({
  apiKey: process.env.DEEPSEEK_API_KEY,
  glossary: { "帐号": "账号", "数据中台": "数据平台" },
});
```

### 2. Edit a Single Page

```typescript
const { outputPath, changed } = await tools["pdf-edit-page"].execute({
  pdfPath: "./report.pdf",
  pageNumber: 1,
  instruction: "Fix typos and standardize terminology",
});
```

### 3. Edit Entire Document

```typescript
const result = await tools["pdf-edit-document"].execute({
  pdfPath: "./report.pdf",
  instruction: "Replace all 「帐号」with 「账号」, fix grammar errors",
});
```

### 4. Relayout

```typescript
await tools["pdf-edit-relayout"].execute({
  pdfPath: "./report.pdf",
  templateId: "academic",  // "academic" | "mobile" | "briefing"
});
```

Three layout templates:

| Template | Description |
|---|---|
| `academic` | Academic paper — A4 two-column, Times serif, 9.5pt body |
| `mobile` | Mobile reading — 320×568 single-column, Helvetica, 13pt body |
| `briefing` | Business briefing — A4 single-column, Helvetica, 10pt body |

## How It Works

```
Original PDF ──▶ Extract text + styles ──▶ AI generates edits ──▶ Overlay draw back to PDF
```

1. **Extract**: pdfjs reads text content from each page, recording position, font, size, and color for every word
2. **AI edit**: The extracted text is sent to DeepSeek. AI returns only the text fragments that need changing
3. **Overlay draw**: pdf-lib covers old text with a white rectangle at the original position, then draws new text at the same spot with the same font

No browser needed. No Chromium download. Pure JavaScript.

## License

[MIT](./LICENSE)