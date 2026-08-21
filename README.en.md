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

## Changelog

### v0.1.4

- Fix `embedCustom` passing fontkit object to `doc.embedFont`, now passes `Uint8Array` directly
- Fix `loadBytes` not supporting string paths (e.g. `fonts.cjk: '/path/to/font.ttf'`)
- Fix CFF-format TTC font compatibility, auto-detect and skip unsupported CFF fonts
- Add Android system font paths (MiSansRoundedSC, NotoSansSC, etc.)
- Simplify `cordis.patch.yml` to community plugin standard format

### v0.1.3

- Fix missing `output: { schema, render }` field in `ctx.tools.register()` causing registration failure
- Fix `execute` signature mismatch (should be `(args, exec)` two-parameter)

### v0.1.2

- Add cordis plugin format `name`/`inject`/`apply` exports, fix "invalid plugin" error

### v0.1.1

- Fix plugin name mismatch in `cordis.patch.yml` that caused load failure

### v0.1.0

- Initial release
- Style-locked editing: AI modifies text while preserving original layout
- Native render mode: pdf-lib direct draw, zero browser dependency
- CJK font auto-detection and embedding
- Overflow handling: shrink / clip / wrap / reject
- Glossary global substitution
- Three relayout templates: academic / mobile / briefing

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