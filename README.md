# @whatsmore-nf/dsh-plugin-pdf-edit

> [English](./README.en.md) | 中文

DeepSeek Harness 插件 —— AI 修改 PDF 文字，自动保持原版式不变。

## 这是什么

一个面向 PDF 文档的 AI 编辑插件。你用自然语言告诉它要改什么，它就会：

- **只改文字，不动排版** —— 字体、字号、颜色、位置全部锁定，改完和原文看起来一模一样
- **自动处理溢出** —— 新文字比原来长时，自动缩小字号或截断，不会撑破版面
- **支持中文** —— 自动识别并嵌入系统中文字体（SimHei / 微软雅黑 / Noto Sans CJK）

## 适合什么场景

| 场景 | 举例 |
|---|---|
| **术语统一** | 全文把「帐号」改成「账号」、「数据中台」改成「数据平台」 |
| **错别字修正** | 让 AI 扫一遍，自动修正拼写和语法错误 |
| **合同/报告批量修改** | 多页文档统一替换人名、金额、日期等 |
| **格式转换** | 把散乱的 PDF 重新排版成学术论文双栏、手机阅读单栏、商务简报等版式 |

## 安装

```bash
# 通过 Harness 插件 CLI（与官方插件一致）
dsh plugin --profile web add @whatsmore-nf/dsh-plugin-pdf-edit@latest

# 或直接通过 npm
npm install @whatsmore-nf/dsh-plugin-pdf-edit
```

## 更新记录

### v0.1.3

- 修复 `ctx.tools.register()` 缺少必需的 `output: { schema, render }` 字段导致注册失败
- 修复 `execute` 签名不匹配（应为 `(args, exec)` 双参数）

### v0.1.2

- 添加 cordis 插件格式的 `name`/`inject`/`apply` 导出，修复 "invalid plugin" 错误

### v0.1.1

- 修复 `cordis.patch.yml` 中插件名与 `package.json` 不一致导致加载失败的问题

### v0.1.0

- 初始发布
- 样式锁定编辑：AI 修改文字，自动保持原排版
- native 渲染模式：pdf-lib 直绘，零浏览器依赖
- CJK 字体自动探测与嵌入
- 溢出处理：shrink / clip / wrap / reject
- 术语表全局替换
- 三种重排版模板：academic / mobile / briefing

## 工作原理

整个编辑流程由 `StyleLockedEditor`（`src/pipeline.ts`）统一调度，分为四个阶段：**提取 → AI 修改 → 溢出控制 → 叠加绘制**。下面结合源码逐步说明。

### 1. 提取：pdfjs + 样式锁定（`src/extractor.ts`）

- 用 `pdfjs-dist`（`src/pdfjs-lazy.ts` 延迟加载）打开 PDF，逐页调用 `getTextContent()` 读取每个文本项（`str`、`transform`、`width`、`fontName`、`height`）。
- 通过 `page.getViewport({ scale: 1 })` 把页面坐标系转换为 PDF 点（pt）坐标。
- 对每个 `str` 构造 `RawRun`：记录 `text`、`x`、`baselineTop`、`width`、`fontSize`（由 `transform` 矩阵计算）、颜色（从 `OPS.setFillRGBColor` / `OPS.setFillGray` / `OPS.setFillCMYKColor` 运算符列表恢复，`recoverColors`），以及样式签名 `sig`（`fontFamily`、`fontSizePt`、`color`、`bold`、`italic`）。
- `mergeRuns()` 把同一行、同一样式、间距小于 `fontSize * maxGapFactor` 的 `RawRun` 合并为一个 `Unit`（文本单元），每个 `Unit` 获得唯一 `tid`（如 `p3-0`），并计算 `top`（`baselineTop - ascent * fontSize`）。
- `freezeStyles()` 把所有 `Unit` 按样式签名分组，生成 CSS 类名（如 `.s1`）和 `css` 字符串，供后续浏览器渲染或原生绘制使用。

输出 `PageExtract` 包含：`pageNumber`、`widthPt`、`heightPt`、`units[]`、`css`、`html`（由 `buildPageHtml` 构造的绝对定位 HTML）。

### 2. AI 修改：分块调用 DeepSeek（`src/ai-editor.ts`、`src/prompts.ts`）

- `AiTextEditor` 接收提取的 `EditableUnit[]`（只保留 `tid` 和 `text`），按字符数分块（`packChunks`，默认每块不超过 18,000 字符）。
- 每块构造提示：系统提示（`TEXT_EDIT_SYSTEM_PROMPT`）要求只输出 `{"items":[{"tid":"...","text":"..."}]}`，条目数与输入完全一致，不能新增/删除 `tid`，未改条目原样返回。
- 调用 `createDeepSeekChatFn`（`src/index.ts`）：向 `https://api.deepseek.com/chat/completions` 发送 POST，设置 `temperature=0.1`、`response_format: {type: "json_object"}`。
- AI 返回的原始字符串经 `parsePatchObject()` 解析：先去除代码围栏（代码围栏 `` ``` ``），再提取 JSON 对象，修复常见的尾部逗号错误。如果解析失败或缺少 `items` 数组则抛出错误。
- 每块并行处理（`Promise.all`），结果合并到 `merged` Map。完成后执行 `reconcilePatches()`（`src/validator.ts`）：
  - 严格模式（`strictTids=true`）下，若 AI 返回未知 `tid` 或缺失 `tid` 直接抛错；
  - 非严格模式下，未知 `tid` 被丢弃，缺失 `tid` 用原文补回（`missingTidsUseOriginal` 默认 `true`）。
- 最后应用术语表（`Glossary`，由 `normalizeGlossary` 处理为 `from→to` 数组），对每条修改后的文本执行 `applyGlossary()`（字符串替换）。

### 3. 溢出控制与文本校验（`src/validator.ts`、`src/util.ts`）

在将 AI 修改应用到 `Unit` 前，执行以下安全校验：

1. `sanitizeText()`：
   - 移除 HTML 标签（`...>`）；
   - 移除控制字符（`\u0000`-`\u0008`、`\u000b`、`\u000c`、`\u000e`-`\u001f`）；
   - 拒绝空文本；
   - 拒绝长度膨胀超过原长 3 倍 + 16 字符（防止 AI 跑飞）。
2. `overflowAction()`（根据配置 `OverflowPolicy`）：
   - `clip`：若新文本宽度超过 `unit.width * 1.06 + 2`，设置 `unit.clip = true`（绘制时截断）；
   - `wrap`：设置 `unit.wrap = true`（绘制时换行）；
   - `reject`：若溢出直接拒绝，记录到 `rejected` 列表，不修改该条；
   - `shrink`（默认）：计算缩放比例 `unit.fontSize * (unit.width / estWidth)`，若缩放后字号 ≥ `minFontSizePt`（默认 6pt）则设置 `fontSizeOverride`；否则设置为最小字号并同时启用 `clip`。
3. `measure()`（`fonts-resolver.ts`）：通过 `font.widthOfTextAtSize()`（pdf-lib + fontkit）计算新文本在当前字号下的实际宽度（pt）；若字体未嵌入则回退到 `text.length * size * 0.6` 估算。

### 4. 叠加绘制：两种渲染模式（`src/native-renderer.ts`、`src/browser-renderer.ts`）

插件支持两种渲染模式，由 `renderMode`（默认 `"native"`）控制：

**Native（原生 pdf-lib 直绘，零浏览器依赖）：**

- `NativePageRenderer.renderPatches()` 对每个被修改的 `Unit` 执行：
  1. 用 `FontResolver.resolveA()` 解析字体（标准字体映射到 Helvetica/Times/Courier，中文自动探测系统字体如 `simhei.ttf` / `msyh.ttc` / `NotoSansCJK-Regular.ttc`，或从配置 `fonts.cjk` 加载）；
  2. 测量新文本宽度，计算遮盖矩形（白色 `patchColor`，默认 `#ffffff`），在原位置画白色矩形遮住旧文字；
  3. 画新文字：若 `wrap` 启用则分行绘制（`wrapByMeasure`），若 `clip` 启用则截断（`ellipsizeByMeasure`）；若 `fontSizeOverride` 有值则使用缩小后的字号；
  4. 对粗体字体启用 `fakeBold` 时，在原位置偏移 `0.02 * size` 再画一次（模拟加粗）。
- 绘制在加载的原始 `PDFDocument`（`PDFDocument.load`）上，通过 `doc.getPage()` 获取页面对象，修改后 `doc.save()` 输出新 PDF 字节流。
- `pdf-ops.ts` 提供 `replacePages()`：当仅部分页修改时，把修改页的 `Uint8Array` 与未修改页的原页合并到新文档，保留原文档元数据（标题、作者、创建日期等）。

**Browser（浏览器渲染，通过 Puppeteer）：**

- `BrowserRenderer` 启动无头 Chrome（`puppeteer-core`，需配置 `browserExecutablePath`），并发限制由 `browserConcurrency` 控制（默认 2）。
- 对修改页构造 HTML：`buildPageHtml()` 生成绝对定位的 `.txt` span（样式从 `freezeStyles` 提取），若有背景图则插入 `.bg` 图片。被修改的单元在原位置上方叠加 `.mask`（白色矩形）遮盖旧字，再在同位置放新 `.txt`。
- `renderPage()` 用 `page.setContent()` 加载 HTML，等待字体就绪（`document.fonts.ready`），然后 `page.pdf()` 打印为 PDF（`margin: 0`、`printBackground: true`），返回 `Uint8Array`。
- `relayout`（重排版）模式下：先提取全文构建 `FlowBlock`（按字号中位数分类：`heading`、`subheading`、`body`、`caption`），再用 `buildFlowBlocks()` 生成流式 HTML，填充到 `templates.ts` 定义的三种模板（`academic` 双栏、`mobile` 手机单栏、`briefing` 商务简报），同样通过浏览器打印为 PDF，并通过 `replaceEntireDocument()` 替换原文档内容（保留元数据）。

### 5. 整体流程控制（`src/pipeline.ts`、`src/index.ts`）

- `StyleLockedEditor.open()` 初始化：加载 PDF、创建 `StyleLockedExtractor`、创建 `AiTextEditor`、设置默认配置（`batchSize=10`、`overflow={mode:"shrink",minFontSizePt:6}`、`patchColor="#ffffff"`、`renderMode="native"`）。
- `editPage()`：提取单页 → AI 修改 → 应用溢出控制 → 原生/浏览器渲染 → 返回新 PDF 字节。
- `editDocument()`：批量逐页处理：先预取第一批（并发 `extractConcurrency`，默认 4），每批调用 AI（分块并行），每页应用溢出控制后收集修改页；原生模式下把所有修改页的工作推迟到最后统一绘制（`drawPatchedPages`），浏览器模式下每页独立渲染后合并（`replacePages`）。过程中通过 `onProgress` 回调报告阶段（`extract` → `ai` → `render` → `skip` → `merge` / `error`）。
- `previewPage()`：仅提取并返回可编辑单元列表，不执行修改，用于预览。
- `relayout()`：提取全部页 → 构建流式块 → 按模板渲染新文档 → 替换原文档内容。

### 6. 字体与中文支持（`src/fonts-resolver.ts`）

- 标准字体：`helvetica`（无衬线）、`times`（衬线）、`courier`（等宽），按 `bold` / `italic` 组合映射到 pdf-lib 的 `StandardFonts`（如 `HelveticaBold`、`TimesRomanItalic`）。
- 中文（CJK）：检测文本中是否含 `\u2E80-\u9FFF` 等字符。若含 CJK 且无嵌入字体，则自动从系统路径探测（Windows `simhei.ttf` / `msyh.ttc`、macOS `Songti.ttc` / `PingFang.ttc`、Linux `wqy-microhei.ttc` / `NotoSansCJK-Regular.ttc`），通过 `fontkit` 嵌入到 PDF。若自动探测失败且未配置 `fonts.cjk`，则抛出错误。
- 自定义字体：支持 `fonts.customs`（按字体族名匹配）和 `fonts.cjk`（专门用于中文）。
- 字体缓存：`FontResolver` 对每个解析后的字体对象 (`PDFFont`) 做缓存（`fontCache`），避免重复嵌入。

整个过程纯 JavaScript 完成：提取和原生绘制依赖 `pdf-lib` + `pdfjs-dist`，浏览器模式额外依赖 `puppeteer-core`（系统 Chrome/Edge 可执行文件）。不需要打开真实浏览器窗口，原生模式完全无浏览器依赖。

## 许可证

[MIT](./LICENSE)