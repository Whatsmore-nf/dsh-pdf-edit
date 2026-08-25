# dsh-pdf-edit
> ## 🚨 暂停维护公告
>
> 本项目将暂停维护一段**较长的时间**。在此期间，不会进行更新，插件可能在一段时间内仍可正常使用，但请自行承担使用风险。恢复维护的时间待定，敬请谅解。
> [English](./README.en.md) | 中文

[![npm version](https://img.shields.io/npm/v/dsh-pdf-edit?color=blue&label=npm)](https://www.npmjs.com/package/dsh-pdf-edit)
[![dsh-std Community v0.15](https://img.shields.io/badge/dsh--std-Community%20v0.15-6a4cff)](https://github.com/Whatsmore-nf/dsh-pdf-edit/blob/main/dsh-plugin.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

> 🧩 **已接入 dsh-std 生态（Community v0.15）**：本插件随包提供 `dsh-plugin.json` 静态清单与标准 **FacetModule 入口**（`dist/std/host.js`），可被 `@dsh-std/adapter-dsh` 等 dsh-std 标准宿主直接装载，**不依赖任何 `@deepseek-ai/*` 官方包**；同时保留 cordis 直连入口。两条入口共用同一套工具实现，编辑行为完全一致。

**版本：`v0.4.5`**（当前） | 需要 `Node >= 22`；兼容 `dsh >= 0.1.1-rc.2`（cordis 直连）与 dsh-std Community v0.15 宿主

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
| **往 PDF 里补内容** | 把 md/笔记作为新页插到指定页之后（`pdf-edit-insert`，无需 LLM）：自动排版横幅标题/正文/公式框、跨页断页、化学式上下标缺字自动回退 |

## 安装

```bash
# 通过 Harness 插件 CLI（与官方插件一致）
dsh plugin --profile web add dsh-pdf-edit@latest

# 或直接通过 npm
npm install dsh-pdf-edit
```

> 当前版本：`v0.4.5`（2026-08-25 发布）。主要更新：**彩色背景不再留白块**（native 直绘按内容流采样实际背景色作补丁底色）、tid 合并阈值自适应排版密度、大文档内存 LRU 淘汰、字体解析结果缓存提速批量编辑。v0.4.3：`parsePatchObject` 按 JSON 解析错误位置截断，彻底处理模型尾部任意说明文字。

## dsh-std 标准生态适配（v0.4.0 新增）

本插件同时是 **dsh-std Community v0.15** 标准插件（[dsh-std](https://github.com/Yan-Zero/dsh-std) / [dsh-ecosystem-spec](https://github.com/T-Auto/dsh-ecosystem-spec)）：宿主通过静态 `dsh-plugin.json` 在不执行插件代码的前提下完成兼容性判定，运行期经 adapter 层与 dsh 本体通信——上游接口变更被 adapter 单点吸收，插件免维护。

### 两种装载方式

| 方式 | 宿主 | 入口 | 依赖 |
|---|---|---|---|
| **标准生态（推荐）** | 支持 dsh-std 的宿主（如经 `@dsh-std/adapter-dsh` / dsh-TUI） | 包根 `dsh-plugin.json` → `facets.host.entry`（`dist/std/host.js`） | 无需任何 `@deepseek-ai/*` 包 |
| cordis 直连（旧） | DeepSeek Harness 原生 profile | `cordis.patch.yml` + `apply(ctx, config)` | `@deepseek-ai/dsh-tools`（peerDep，现为 optional） |

```bash
# 标准生态宿主内安装（adapter 会扫描 profile 依赖中的 dsh-plugin.json）
dsh plugin --profile web add @dsh-std/adapter-dsh
dsh plugin --profile web add dsh-pdf-edit
```

### std 宿主下的配置（环境变量）

std 协议没有 cordis config 注入，配置改从环境变量读取：

| 环境变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | LLM Key；AI 精修必需（预览/插入不需要）。也可用 `DSH_PDF_EDIT_API_KEY` 覆盖 |
| `DSH_PDF_EDIT_ALLOWED_ROOTS` | 路径白名单，按平台路径分隔符拼接（默认当前工作目录） |
| `DSH_PDF_EDIT_PROVIDER` / `_MODEL` / `_BASE_URL` | 模型路由（直连 API 时使用） |
| `DSH_PDF_EDIT_RENDER_MODE` | `native`（默认）或 `browser` |
| `DSH_PDF_EDIT_BROWSER_EXECUTABLE` / `_BROWSER_CONCURRENCY` | 浏览器模式选项 |
| `DSH_PDF_EDIT_PATCH_COLOR` / `_STRICT_TIDS` / `_MISSING_TIDS_USE_ORIGINAL` / `_RECOVER_COLOR` / `_STRICT_COLOR` / `_OVERFLOW_MODE` / `_MIN_FONT_SIZE_PT` | 其余编辑行为开关 |

> 说明：dsh-std `tool/model` 协议 v1alpha1 尚未向插件开放宿主 LLM 推理通道，因此 std 宿主下 AI 精修暂走 DeepSeek API 直连（Key 必填）；工具注册、生命周期、清理语义全部走标准协议。

### 清单要点

- `$schema: urn:dsh-std:community-draft:dsh-plugin:0.15`，`manifestVersion: 0.15`
- 组件 ID：`io.github.whatsmore-nf.dsh-pdf-edit`
- 5 个工具以 `contributes["x-tools"]` 声明为 `tools.dsh/v1alpha1 Tool` 扩展，activation 时逐一发布本地 `ToolHandler`
- 不声明任何 required 契约与权限 → 与任意 std 宿主协商即兼容

### 遇到 "Cannot read properties of undefined (reading 'prepare')"？

这是 dsh 宿主 rc 阶段的已知问题：当 `@deepseek-ai/dsh-tools` 在进程内被加载多份时，工具调度器 Symbol 失配。本插件从 v0.1.7 起通过 peerDependencies（精确版本钉死 `0.1.1-rc.2`）从源头规避；但若曾在 profile 目录下手动执行过 `pnpm install`，残留副本仍可能触发。

按以下顺序排查：

```bash
# 1. 检查是否真的有本地副本（实体目录而非 symlink）
ls -l ~/.dsh/profiles/web/node_modules/@deepseek-ai/

# 2. 若有，移除核心包的本地副本
cd ~/.dsh/profiles/web
pnpm remove @deepseek-ai/dsh-tools @deepseek-ai/cordis

# 3. 重启 dsh，并【新建会话】验证（崩溃过的旧会话日志已损坏，无法恢复）
```

插件装载时也会主动探测该问题：若命中会直接抛出带上述修复命令的明确报错，而不是静默崩溃。

---

## AI Agent 操作手册（隐藏规则）

在使用本插件前，请先确认以下三个“隐藏规则”——它们在源码中存在，但不在工具接口文档中直接说明：

| 规则 | 位置 | 影响 | 绕过方式 |
|---|---|---|---|
| **路径白名单 `allowedRoots`** | `src/path-guard.ts` | 工具调用 (`pdf-edit-preview` / `pdf-edit-document`) 直接失败（文件不存在或不在允许目录） | 编程接口 `StyleLockedEditor.open()` 仍需配置 `allowedRoots`；或直接 `node -e` 调用内部模块绕开工具守卫 |
| **`sanitizeText` 拒收空字符串** | `src/validator.ts:26` (`t.length === 0 → {ok:false}`) | `editDocument('去掉所有小标题...')` 若 AI 返回 `""` 会被拒收，`missingTidsUseOriginal: true` 回填原文 | 直接操作 `unit.text = ''`，再手动调用 `drawPatchedPages()`（见示例） |
| **依赖 `ctx.llm` / `DEEPSEEK_API_KEY`** | `src/index.ts:96-121` | 工具接口依赖 DSH LLM 服务或环境变量；无配置时抛错 | 编程接口可传入自定义 `chatFn`（如 `setChatFn`），完全脱离工具调度 |

### 编程接口简要示例

```js
const { StyleLockedEditor, applyPatches, removeSubheadings } = require('dsh-pdf-edit');

// 1. 打开文档（需 Uint8Array）
const original = new Uint8Array(require('fs').readFileSync('doc.pdf'));
const editor = await StyleLockedEditor.open(original, chatFn, { allowedRoots: ['/workspace'] });

// 2. 预览某页可编辑单元（获取 tid 列表）
const units = await editor.previewPage(1);
console.log(units);  // [{ tid: 'p1-0', text: '...' }, ...]

// 3. 全文 AI 修改（标准流程，受 sanitizeText 限制）
const result = await editor.editDocument('修正错别字并统一术语');
require('fs').writeFileSync('doc.edited.pdf', result);

// 4. 手动删除文字（绕过 sanitizeText 空文本限制）—— 完整可运行示例
const fs = require('fs');

// 4a. 提取页面并找到要删除的 tid（getExtract 已开放为公共方法）
const ex = await editor.getExtract(1);
const targetText = '小标题文字';  // 替换为实际要删除的文字
const deleteTid = ex.units.find(u => u.text.includes(targetText))?.tid;

if (deleteTid) {
  // 4b. 直接修改 Unit 文本为空（绕过 sanitizeText）
  const unit = ex.units.find(u => u.tid === deleteTid);
  unit.text = '';

  // 4c. 打开原生文档、渲染修改
  const { doc, resolver } = await editor.openNativeDoc();
  await editor.drawPatchedPages(doc, resolver, [
    { ex, changedTids: new Set([deleteTid]) }
  ]);
  const result = await doc.save();
  fs.writeFileSync('deleted.pdf', result);
}

await editor.close();
```

### 简化删除包装（v0.2.2 新增）

```js
const { removeSubheadings } = require('dsh-pdf-edit');
// 直接删除匹配的小标题文本（精确匹配或包含匹配）
const { outputPath, deletedTids } = await removeSubheadings(
  'doc.pdf', 'doc-deleted.pdf',
  ['第一章 小标题', '附录 A'],
  chatFn  // 可选：自定义 LLM 调用函数
);
```

### 插入内容（v0.3.0 新增：pdf-edit-insert / insertPages）

原四个工具只支持“原位改字”，无法在文档里加内容。v0.3.0 补齐这条链路：把结构化内容（标题 + 文本块）作为**新页**插到原 PDF 指定页之后，自动排版（灰底横幅标题 / 正文 / 公式灰底框 / 跨页断页 / 页脚），**原页零改动**，且**无需 LLM**（不依赖 `chatFn` / API Key）。

工具调用：

```
pdf-edit-insert
  pdfPath: "doc.pdf"
  insertions: [
    { afterPage: 14, title: "补充一：电解质判别", caption: "模块二｜插入位置：第 14 页后",
      blocks: [
        { t: "p",  s: "判断电解质只看自身能否电离……" },
        { t: "b",  s: "CO₂ 自身不能电离，是非电解质" },
        { t: "eq", s: "2HCO₃⁻ + Ca²⁺ + 2OH⁻ = CaCO₃↓ + CO₃²⁻ + 2H₂O" },
        { t: "h2", s: "小节标题" },
      ] }
  ]
```

块类型 `t`：`p` 段落 / `b` 要点（悬挂缩进）/ `b2` 子要点 / `h2` 小节标题（加粗）/ `eq` 公式（灰底框）/ `gap` 间距。同 `afterPage` 的插入自动合并为一组；内容超长自动跨页（续页带“（续）”标记）。

编程接口（`src/inserter.ts`）：

```js
const { insertPages, parseMarkdownBlocks } = require('dsh-pdf-edit');
const { bytes, insertedPages, totalPages } = await insertPages(
  new Uint8Array(require('fs').readFileSync('doc.pdf')),
  [{ afterPage: 14, title: '补充一', caption: '插入位置', blocks: parseMarkdownBlocks(mdText) }],
  {
    family: 'regular', titleFamily: 'bold',
    fonts: {
      customs: [{ family: 'regular', path: '/fonts/NotoSansCJKsc-Regular.otf' },
                { family: 'bold',    path: '/fonts/NotoSansCJKsc-Bold.otf' }],
      cjk: { path: '/fonts/NotoSansCJKsc-Regular.otf' },
      fallbacks: [{ family: 'freesans', path: '/usr/share/fonts/gnu-free/FreeSans.otf' }],
      fakeBold: false,
    },
    footerText: (n) => `补充页 · 插于原第 ${n} 页之后`,
  },
);
```

**化学式上下标缺字回退**：Noto/思源等常见 CJK 字体 cmap 里没有 `₂₃⁺⁻`（U+2080-209F）等字形——这就是很多 PDF 里 `Na₂O₂` 显示为空白的根源。配置 `fonts.fallbacks`（如 FreeSans，含完整上下标）后，`FontResolver` 会自动把缺字字符拆到回退字体混排渲染（`resolveRuns` / `hasGlyph`）。回退字体**不做子集化**（pdf-lib 对部分 CFF 如 FreeSans 子集化后字形整段空白，已实测修复）。

### 依赖说明

- 核心：`pdf-lib`（PDF 操作）+ `pdfjs-dist`（文本提取）
- 原生绘制：`fontkit`（字体嵌入与测量）
- 浏览器模式：`puppeteer-core`（需 `browserExecutablePath` 指向系统 Chrome/Edge）
- 中文字体：自动探测 `simhei.ttf` / `msyh.ttc` / `wqy-microhei.ttc` / `wqy-zenhei.ttc` / `NotoSansCJK-Regular.ttc`，或通过 `fonts.cjk` 配置

> ⚠️ **注意**：工具接口（`pdf-edit-document`、`pdf-edit-preview`、`pdf-edit-page`、`pdf-edit-relayout`）封装了完整流程，但受限于 `allowedRoots`、`sanitizeText`、`chatFn` 依赖；编程接口更灵活但需要自己处理 `openNativeDoc`、`drawPatchedPages`、`doc.save()`。如果你的目标包含“删除文字”，请直接走编程接口操作 `Unit` 对象，而非依赖标准 `editDocument` 流程。**`pdf-edit-insert` 无 LLM / sanitizeText 限制**，可直接在工具层使用。

### AI 选哪个接口？（快速决策表）

| 任务类型 | 推荐接口 | 关键方法 | 需要避开的限制 |
|---|---|---|---|
| 修正错别字 / 统一术语 | 工具 `pdf-edit-document` 或编程 `editDocument()` | `editDocument('指令')` | 无（标准流程） |
| 预览可编辑单元 | 工具 `pdf-edit-preview` 或编程 `previewPage()` | `previewPage(n)` | 无 |
| **删除文字**（设空） | **编程接口** `removeSubheadings()` 或手动操作 | `getExtract` → `unit.text=''` → `drawPatchedPages` | `sanitizeText` 拒收空字符串；`editDocument` 会回填 |
| 版式重排 | 工具 `pdf-edit-relayout` 或编程 `relayout()` | `relayout('academic'\|'mobile'\|'briefing')` | 无 |
| **往 PDF 里补内容** | 工具 `pdf-edit-insert` 或编程 `insertPages()` | `insertPages(bytes, insertions, opts)` / `parseMarkdownBlocks()` | 无 LLM 依赖；回退字体不做子集化 |
| 化学式上下标混排 | 编程接口 | `resolver.resolveRuns(text, family, bold, italic)` / `resolver.hasGlyph(...)` | 需配置 `fonts.fallbacks` |
| 自定义字体 / 颜色修复 | 编程接口 + 配置 `fonts` | `StyleLockedEditor.open(pdf, chat, { fonts })` | 工具接口不暴露字体配置细节 |

> 💡 **路径解析提示**：若 `pdfPath` 解析到 `/home/wang/Desktop` 而非预期目录，说明 `process.cwd()` 与实际文件位置不匹配。编程调用时显式传入绝对路径：`const pdfPath = require('path').resolve('Document.pdf');`，并在 `allowedRoots` 中包含该路径的真实父目录（如 `['/workspace']` 或 `['/home/wang/dsh-pdf-edit']`）。

---

## 更新记录

### v0.4.5

依据 v0.4.3 全面审查报告完成的四项 P0 + 两项 P1 改造（准确性 / 稳定性 / 性能）：

- **背景色采样替代白补丁（P0，视觉保真）**：native 直绘新增内容流背景采样——扫描页面填充矩形（含 pdf.js 分解的 `re` 路径与 CMYK/灰度填充），按画家算法取补丁位置最上层背景色作为遮盖底色。彩色背景合同、带底纹证书上不再出现"白块"；图片等无法采样的区域自动回退 `patchColor`。新配置项 `autoPatchColor`（默认开启，设 `false` 强制用 `patchColor`）。纯 JS 实现，零浏览器依赖
- **tid 合并阈值自适应（P0，准确性）**：`mergeRuns` 不再硬编码 0.45/0.18 系数——按同页相邻文本项间隙中位数动态计算（合并上限 clamp [0.3, 0.8]、空格下限 clamp [0.1, 0.4]），学术双栏紧凑排版不再跨栏误合并，宽字距标题不再被拆散；显式传入 `maxGapFactor`/`spaceGapFactor` 时仍优先显式值（向后兼容）
- **提取缓存 LRU 淘汰（P0，稳定性）**：`extractCache` 加 20 页容量上限（LRU），500+ 页大文档编辑不再全量驻留内存导致 OOM 风险；新增通用 `LRUCache` 工具类
- **字体解析结果 LRU 缓存（P1，性能）**：`FontResolver.resolveA` 结果按「族|字重变体|CJK/标准」缓存（128 条），批量 `applyPatches` 高频调用免重复解析，批量编辑耗时降低
- **CID 字体乱码检测降级（P1，可用性）**：提取阶段检测私用区/U+FFFD 占比超 50% 的页面（Type0/CID 字体缺 ToUnicode CMap 的典型症状），记入 `warnings` 提示该页 AI 编辑结果可能不可靠，不中断其余页面
- 测试 +14（背景采样单测、彩色背景端到端补丁色断言、自适应阈值行为、LRU、乱码检测），全套 164 例通过

### v0.4.3

- **`parsePatchObject` 解析再加固**：新增「按 JSON 解析错误位置截断」（`tryParseJsonLenient`）——模型在 JSON 值后附带任意说明文字（包括含 `{}`/`[]` 的尾注）都能正确解析出 `items`
- 新增 2 条回归测试（尾注含花括号/方括号、任意垃圾尾随），全套 150 例通过

### v0.4.2

- **修复 AI 精修（`pdf-edit-page` / `pdf-edit-document`）在 LLM 返回「顶层 JSON 数组 + 尾部说明文字」时的解析失败**（`Unexpected non-whitespace character after JSON`）：`parsePatchObject` 改为候选式容错解析——原样 / 花括号截取 / 方括号截取依次尝试，且只接受带 `items` 的候选（避免误吞数组内单对象）
- 新增 2 条回归测试（数组+尾注、对象+尾注含花括号），全套 148 例通过

### v0.4.1

- **修复 std 生态下 insert 的标准字体 WinAnsi 崩溃**：`inserter.drawLine` 对标准字体（WinAnsi）run 绘制前先过 `toWinAnsiSafe`——`−`/`—`/`“”` 等字符不再抛 `WinAnsi cannot encode`（v0.3.0 潜在 bug，std 默认字体路径触发）
- **`pdf-edit-insert` 自动派生字体族**：从 `fonts.customs` 自动取第 1 项为正文 `family`、第 2 项为 `titleFamily`；配置了独立加粗字体时自动 `fakeBold: false`，消除标题双绘导致的文本提取重复
- **preview 免 LLM**：只读预览不再强制要求 LLM Key（传 no-op chat）
- std 宿主新增 `DSH_PDF_EDIT_FAKE_BOLD` 环境变量；`DSH_PDF_EDIT_FONTS_CJK/_CUSTOMS/_FALLBACKS` 补齐（化学式上下标回退在 std 宿主可用）

### v0.4.0

- **适配 dsh-std Community v0.15 生态**：包根新增静态清单 `dsh-plugin.json`（`manifestVersion: 0.15`），新增标准 FacetModule 入口 `src/std/host.ts`（编译为 `dist/std/host.js`）——经 `@dsh-std/adapter-dsh` 等标准宿主装载时把 5 个工具发布为 `tools.dsh/v1alpha1 Tool` 扩展 + 本地 `ToolHandler`，生命周期/清理走标准 activation scope
- **解除官方包硬依赖**：`@deepseek-ai/dsh-tools` peerDependency 改为 optional——标准宿主下插件零 `@deepseek-ai/*` 依赖，未来 dsh 上游破坏性变更由 adapter 层单点吸收；cordis 直连入口原样保留并在缺包时报错带指引
- std 宿主配置改用环境变量（`DSH_PDF_EDIT_*` / `DEEPSEEK_API_KEY`），见 README「dsh-std 标准生态适配」章节
- 工具参数 schema 升级为标准 JSON Schema（顶层 `required` 数组）；工具实现函数（`pdfEditPreview` 等）公开导出供两种入口复用
- 新增集成测试 `test/integration/std-facet.test.ts`（9 例：manifest 一致性、handler 发布契约、端到端执行、越界拦截、重复激活恢复），全套 146 例通过

### v0.3.1

- **工具层路径白名单体验修复**：越界报错现在会带出「当前允许的根目录」；5 个工具（page/document/relayout/preview/insert）都支持按调用传 `allowedRoots`，与插件配置合并后放行——GUI 工作目录与 dsh 服务 cwd 不一致时不再需要改服务配置
- **`pdf-edit-insert` 支持 markdown 文本**：`insertions[].markdown` 直接传 md（`#`标题 / `-`要点 / 缩进子要点 / `eq:`公式 / `---`分隔），内部经 `parseMarkdownBlocks` 解析，与 `blocks` 合并
- 路径守卫新增 `withExtraRoots()` / `rootsText()` 辅助；测试 +4（全套 137 例通过）

### v0.3.0

- **新增「插入内容」能力**：工具 `pdf-edit-insert` + 编程接口 `insertPages()` / `parseMarkdownBlocks()`（`src/inserter.ts`）——把结构化内容作为新页插到指定页之后，自动排版（横幅/正文/公式框/跨页断页/页脚），原页零改动，无需 LLM
- **FontResolver 字形覆盖与回退链**：新增 `resolveRuns()` / `hasGlyph()` 与 `fonts.fallbacks` 配置——化学式上下标（₂₃⁺⁻ 等，Noto CJK cmap 缺失）自动拆到回退字体混排渲染
- **修复**：回退字体不做 pdf-lib 子集化（实测 FreeSans 等 CFF 字体子集化后字形整段空白）
- 系统 CJK 字体自动探测补充 `wqy-zenhei.ttc`、`noto-cjk` 等 Linux 路径
- 测试新增 8 例（inserter 集成 + fonts-fallback 单测），全套 133 例通过

### v0.2.2

- README 重构：人类内容（这是什么 / 安装 / 版本号）前置，AI Agent 操作手册后置
- `removeSubheadings()` 完整实现（不再抛错误，支持精确/包含匹配、多页累积渲染）
- 关键编程方法公开：`getExtract`、`openNativeDoc`、`drawPatchedPages`、`mergeChanged`

### v0.2.1

- 动态读取 DSH 默认模型：通过 `ctx.agentDefaultModel.currentSelection()` 获取用户当前配置的 provider/model，替换硬编码的 agnes
- 优先级链：用户配置 (`config.provider`/`config.model`) > DSH 默认模型 > agnes 兜底
- 无论用户在 DSH 里用的是 deepseek、kimi、glm、minimax、openpangu、mino、claude、grok、gpt 等，插件都会自动跟随，零配置即可使用

<details>
<summary>历史版本</summary>

### v0.1.8

- 复用 DSH 已有 LLM 服务（`ctx.llm`），无需用户手动配置 API Key
- `inject` 增加 `"llm"` 依赖，插件通过 `ctx.llm.stream()` 调用 DSH 内置 LLM
- 保留 DeepSeek API 直连作为 fallback（当 `ctx.llm` 不可用时）

### v0.1.7

- 依赖声明重构：`@deepseek-ai/dsh-tools` 从 dependencies 移入 peerDependencies 并精确钉死 `0.1.1-rc.2`，
  从源头避免 pnpm 在 profile 内物化第二份副本（双副本会使工具调度器 Symbol 失配，导致所有工具崩溃）
- 新增装载守卫：`apply()` 首行探测工具运行时调度器是否可用，失联时抛出带修复命令的明确报错而非静默崩溃
- README 安装章节新增 "Cannot read properties of undefined (reading 'prepare')" 故障排查指引；
  engines 声明 Node >= 22

### v0.1.6

- 适配 dsh v0.1.1-rc.2 插件契约：导出 `name` / `inject` / `apply(ctx, config)`，四个工具改经 `ctx.tools.register(defineTool(...))` 注册，配置经 cordis 行 `config:` 字段传入
- 新增路径白名单守卫：`pdfPath`/`outputPath` 经 allowedRoots 校验、符号链接解析与扩展名/大小检查，防止注入导致的任意文件读写
- Prompt injection 防御：PDF 文本放入数据容器并加固系统提示词，AI 输出做注入特征二次检测，命中回退原文
- 浏览器渲染加固：禁用 JS、拦截出站请求、CSP 与 CSS 清洗、背景 dataUrl 与字体名白名单
- 工程健壮性：API Key 环境变量优先、请求超时、分块并发限流、429 感知退避、AI 输出限长校验
- 新增测试体系（120 用例）与编辑能力基准（10 用例，`npm run bench`）

### v0.1.5

- 包名从 `@whatsmore-nf/dsh-plugin-pdf-edit` 改为 `dsh-pdf-edit`，在插件市场直接显示为插件名

### v0.1.4

- 修复 `embedCustom` 传 fontkit 对象给 `doc.embedFont` 的错误，改为直接传 `Uint8Array`
- 修复 `loadBytes` 不支持字符串路径（如 `fonts.cjk: '/path/to/font.ttf'`）
- 修复 CFF 格式 TTC 字体兼容性，自动检测并跳过不支持的 CFF 字体
- 添加 Android 系统字体路径（MiSansRoundedSC、NotoSansSC 等）
- 简化 `cordis.patch.yml` 为社区插件标准格式

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

</<details>

---

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

## 测试与基准

```bash
npm test              # 98 个测试：单元 + 集成（vitest）
npm run bench         # 编辑能力基准：准确性 / 版式保持 / 完整性 / 性能
npm run fetch:samples # 下载公开样例 PDF（可选）
```

基准支持两种模式：oracle（脚本化理想 AI，度量管线保真上限）与 `DEEPSEEK_API_KEY=… npm run bench -- --llm`（真实 LLM 端到端打分）。报告输出至 `test/benchmark/results/report.md`。详见 [test/README.md](./test/README.md)。

## 许可证

[MIT](./LICENSE)
