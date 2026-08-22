# dsh-pdf-edit

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

> Requires dsh `0.1.1-rc.2`; Node `>= 22`.

```bash
# Via Harness plugin CLI (same as official plugins)
dsh plugin --profile web add dsh-pdf-edit@latest

# Or via npm
npm install dsh-pdf-edit
```

### Seeing "Cannot read properties of undefined (reading 'prepare')"?

This is a known dsh-host issue from the rc stage: when `@deepseek-ai/dsh-tools`
is loaded more than once in the same process, the tool-scheduler Symbol misses.
Since v0.1.7 this plugin pins it via peerDependencies to prevent that at the
source — but a leftover copy can still trigger if you ever ran `pnpm install`
manually inside the profile directory.

Troubleshoot in order:

```bash
# 1. Check for a materialized local copy (real dir, not a symlink)
ls -l ~/.dsh/profiles/web/node_modules/@deepseek-ai/

# 2. If present, remove the core-package copies
cd ~/.dsh/profiles/web
pnpm remove @deepseek-ai/dsh-tools @deepseek-ai/cordis

# 3. Restart dsh and verify in a NEW session (old crashed sessions are unrecoverable)
```

The plugin also probes for this at load time: if detected, it throws an error
containing these exact recovery commands instead of crashing silently.

## Changelog

### v0.2.1

- Dynamically read DSH default model: use `ctx.agentDefaultModel.currentSelection()` to get the user's current provider/model, replacing hardcoded agnes
- Priority chain: user config (`config.provider`/`config.model`) > DSH default model > agnes fallback
- Whether the user is on deepseek, kimi, glm, minimax, openpangu, mino, claude, grok, gpt, etc., the plugin follows automatically — zero config needed

### v0.1.8

- Reuse DSH built-in LLM service (`ctx.llm`), no manual API Key configuration needed
- `inject` adds `"llm"` dependency, plugin calls DSH LLM via `ctx.llm.stream()`
- DeepSeek API direct connection kept as fallback (when `ctx.llm` is unavailable)

<details>
<summary>Historical versions</summary>

### v0.1.7

- Dependency restructure: `@deepseek-ai/dsh-tools` moved from dependencies into peerDependencies, pinned exactly to `0.1.1-rc.2`, preventing pnpm from materializing a second copy inside profiles (dual copies break the tool-scheduler Symbol and crash every tool)
- Load-time guard: `apply()` probes for the scheduler before touching `ctx.tools`; on failure it throws a clear error with recovery commands instead of crashing silently
- README install section now documents the "Cannot read properties of undefined (reading 'prepare')" troubleshooting flow; engines field declares Node >= 22

### v0.1.6

- Adapt to the dsh v0.1.1-rc.2 plugin contract: export `name` / `inject` / `apply(ctx, config)`, register all four tools via `ctx.tools.register(defineTool(...))`, configuration passed through the cordis patch row's `config:` field
- Add path whitelist guard: `pdfPath`/`outputPath` validated against allowedRoots with symlink resolution and extension/size checks, preventing injection-driven arbitrary file read/write
- Prompt injection defense: PDF text wrapped in a data container, hardened system prompt, second-stage injection scan on AI output with fallback to original text
- Browser rendering hardening: JavaScript disabled, outbound requests intercepted, CSP and CSS sanitizer, background dataUrl and font name whitelists
- Engineering robustness: API key env-first, request timeout, chunked concurrency limit, 429-aware backoff, AI output length caps
- New test suite (120 cases) and editing benchmark (10 cases, `npm run bench`)

### v0.1.5

- Rename package from `@whatsmore-nf/dsh-plugin-pdf-edit` to `dsh-pdf-edit`, display plugin name directly in the marketplace

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

</details>

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