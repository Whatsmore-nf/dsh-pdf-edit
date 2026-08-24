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

> Node `>= 22`. Compatible with dsh `0.1.1-rc.2` (cordis-direct) and dsh-std Community v0.15 hosts.

```bash
# Via Harness plugin CLI (same as official plugins)
dsh plugin --profile web add dsh-pdf-edit@latest

# Or via npm
npm install dsh-pdf-edit

# Inside a dsh-std host (adapter scans profile dependencies for dsh-plugin.json)
dsh plugin --profile web add @dsh-std/adapter-dsh
dsh plugin --profile web add dsh-pdf-edit
```

### dsh-std Ecosystem Adaptation (v0.4.0+)

This plugin is also a **dsh-std Community v0.15** standard plugin: hosts read the static `dsh-plugin.json` at the package root to decide compatibility **without executing plugin code**, and all runtime traffic goes through an adapter layer — future upstream breaking changes are absorbed by the adapter, so this plugin stays maintenance-free.

| Loading mode | Host | Entry | Extra deps |
|---|---|---|---|
| **dsh-std (recommended)** | std-capable hosts (e.g. via `@dsh-std/adapter-dsh`) | `dsh-plugin.json` → `facets.host.entry` (`dist/std/host.js`) | none — zero `@deepseek-ai/*` packages |
| cordis-direct (legacy) | native DeepSeek Harness profiles | `cordis.patch.yml` + `apply(ctx, config)` | `@deepseek-ai/dsh-tools` (optional peerDep) |

Under std hosts (no cordis config injection), configuration comes from environment variables:

| Variable | Meaning |
|---|---|
| `DEEPSEEK_API_KEY` | LLM key; required for AI editing (preview/insert work without it). `DSH_PDF_EDIT_API_KEY` overrides |
| `DSH_PDF_EDIT_ALLOWED_ROOTS` | Path whitelist, joined with the platform path delimiter (defaults to cwd) |
| `DSH_PDF_EDIT_PROVIDER` / `_MODEL` / `_BASE_URL` | Model routing for direct API calls |
| `DSH_PDF_EDIT_RENDER_MODE` | `native` (default) or `browser` |

Note: the dsh-std tool/model protocols (v1alpha1) do not yet expose host LLM inference to plugins, so AI editing under std hosts uses direct DeepSeek API calls; tool registration, lifecycle, and cleanup semantics are fully standard.

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

### v0.4.0

- **dsh-std Community v0.15 adaptation**: static `dsh-plugin.json` manifest at the package root + standard FacetModule entry (`src/std/host.ts` → `dist/std/host.js`). Under std hosts (e.g. `@dsh-std/adapter-dsh`), the 5 tools are published as `tools.dsh/v1alpha1 Tool` extensions with local `ToolHandler`s; lifecycle/cleanup follow the standard activation scope
- **No hard dependency on official packages**: `@deepseek-ai/dsh-tools` peerDependency is now optional — zero `@deepseek-ai/*` dependencies under std hosts; future upstream breaking changes are absorbed by the adapter layer. The cordis-direct entry is preserved unchanged and reports clear guidance when the package is missing
- std-host configuration switches to environment variables (`DSH_PDF_EDIT_*` / `DEEPSEEK_API_KEY`)
- Tool parameter schemas upgraded to standard JSON Schema; tool implementations (`pdfEditPreview`, etc.) are exported for both entries to share

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