# dsh-pdf-edit 测试与基准

## 快速上手

```bash
npm test                # 全部测试（93 个，~11s）
npm run test:unit       # 仅单元层（秒级反馈，纯逻辑）
npm run test:integration# 仅集成层（提取器 + 流水线）
npm run verify          # lint + 全部测试
npm run fixtures        # 把自建夹具按规范名落盘到 test/fixtures/.cache/ 供人工检查
npm run bench           # 编辑能力基准（先 build，评测 dist 产物）
npm run fetch:samples   # 下载真实世界样例 PDF
```

分层车道：

| 车道 | 命令 | 内容 | 预期时长 |
|---|---|---|---|
| L1 快速 | `test:unit` | 纯函数单测 | < 1s |
| L2 标准 | `test` / `test:integration` | 单测 + 提取/流水线集成 | ~11s |
| L3 深度 | `bench`（可再加 `--llm`） | 端到端能力评测 + 报告 | 30s+ |

无系统 CJK 字体时中文相关用例自动跳过；可用 `TEST_CJK_FONT=/path/to/font` 指定。

## 统一命名规范

| 类别 | 规范 | 示例 |
|---|---|---|
| 自建夹具 | `gen-<内容>-<特征>-<页数>p.pdf` | `gen-en-basic-1p.pdf`、`gen-report-times-3p.pdf` |
| 外部样例 | `real-<来源>-<描述>.pdf` | `real-arxiv-1706.03762-15p.pdf` |
| 基准产物 | `<case-id>/{original,edited,result}.{pdf,json}` | `results/en-basic-replace/edited.pdf` |
| 测试文件 | `<模块>.test.ts`，置于 `unit/` 或 `integration/` | `unit/validator.test.ts` |

夹具名称的唯一登记处是 `helpers/make-pdf.ts` 的 `FIXTURE_NAMES`；所有生成器带进程内缓存，
同一文件内多次调用零成本。落盘复核用 `npm run fixtures`（输出即规范名）。

## 目录结构

```
test/
├── helpers/
│   ├── make-pdf.ts        # 夹具生成器：命名注册表 + 缓存 + TTC 拆包 CJK
│   └── chat-mock.ts       # ChatFn mock：理想 AI(oracle) / 瞬时失败 / 劣质 JSON
├── fixtures/
│   ├── fetch-samples.sh   # 下载 real-* 样例（已 gitignore，缺失自动跳过）
│   └── downloaded/
├── unit/                  # 75 用例 · 纯函数
│   ├── util.test.ts           # 分片/限流/宽度估算/换行截断/术语表
│   ├── validator.test.ts      # sanitize / reconcile / 四种溢出策略 / HTML 结构校验
│   ├── ai-editor.test.ts      # JSON 容错 / 重试(retryBaseMs=0) / 分块 / 术语后置
│   ├── prompts.test.ts        # 提示词契约
│   ├── fonts-resolver.test.ts # 家族映射 / WinAnsi 清洗 / TTC 拆包 / 缓存
│   └── pdf-ops.test.ts        # 页替换 / 元数据回填
├── integration/           # 18 用例 · 组件级
│   ├── extractor.test.ts      # 共享提取结果(beforeAll)：合并/颜色/旋转页/扫描件/损坏字节
│   └── pipeline.test.ts       # editPage/editDocument/溢出策略/旋转失败降级/CJK 回写/relayout
└── benchmark/             # 10 用例 · 能力评测（跑 dist 构建产物）
    ├── cases.mjs          # 用例 + ground truth 推导（策略感知、恒等替换剔除）
    ├── metrics.mjs        # 指标体系
    ├── run.mjs            # CLI：oracle 默认；--llm 用真实 API；--filter 过滤
    └── results/           # report.md / report.json / 各用例产物
```

## 基准指标口径

所有指标基于「编辑前后 PDF **重新提取**」的对比与规则推导的 ground truth，
不读内部状态，可对任意实现横向比较。

### A. 编辑准确性
| 指标 | 含义 |
|---|---|
| `unitPrecision/Recall/F1` | 单元级「应改且改对 / 应改」（≥0.9 相似计达成） |
| `charSimilarity` | 达成文本 vs 期望文本归一化 Levenshtein 相似度均值 |
| `exactMatchRate` | 与可接受结果完全一致比例 |
| `collateralUnits` | 目标位置外新增的可疑文本数 |

### B. 版式保持（破坏度）
| 指标 | 含义 |
|---|---|
| `unchangedMaxDxPt` 等 | 未改动单元位置/字号/颜色/字体漂移（全 0 = 完美锁定） |
| `changedPositionKeptRate` | 改动单元原位覆盖率 |
| `policyConformanceRate` | 溢出策略兑现率：reject 拒绝、clip 截断、shrink 缩放 |

### C. 文档完整性
| 指标 | 含义 |
|---|---|
| `pageCountPreserved` / `metadataKept` | 结构与元数据保持 |
| `untouchedPageTextRatio` | 未触及页文本一致度（1 = 一字未动） |
| `staleOriginalTextRate` | **旧文残留率**：被改单元原文仍可提取的比例 |
| `sizeRatio` | 体积膨胀比 |

### D. 性能
分阶段耗时、每页均摊、字节量。

## 当前基准结论（oracle 模式）

- 全部 10 用例 F1=1.0、位置保持 100%、策略兑现 100%、未触及页零损伤。
- `staleOriginalTextRate` 普遍 >0：叠加式回写不重写内容流，旧文字被白块视觉遮盖但仍在
  文件中 —— 复制粘贴会带出。隐私敏感场景需在上游知悉该特性。
- overflow-shrink 字符相似度 0.97：评分器的估算字宽与真实字体度量存在微小截断位差，
  属评分口径残差而非产品缺陷（已按 ≥0.9 近似命中计满分）。

## 测试过程发现并修复的真实缺陷

1. **`fonts-resolver.ts`：CJK 嵌入必然失败**（v0.1.4 声称已修但未修）—— pdf-lib 只收字节
   却被传入 fontkit 对象；且系统候选多为 pdf-lib 不支持的 TTC。→ 新增 sfnt 表级拆包
   `unwrapFontBytes()`。
2. **`extractor.ts`：颜色恢复产出 `#NaNNaNNaN`** —— pdfjs 4.x 运算符参数是 Float32Array，
   `Array.isArray()` 判定失败。
3. **`extractor.ts`：空项/纯空白项消耗颜色索引** —— pdfjs 间距归一化产物与 showText 运算
   不一一对应，导致后续全部错位。
4. **`ai-editor.ts`：顶层数组补丁永远无法解析** —— 花括号截取把 `[{"tid":…}]` 切成首个对象。

另有一处 API 契约注意点（已适配并记录）：**`editPage` 返回整份文档字节而非单页**
（native/browser 一致），逐页拼装需自行拷出对应页。

## 设计说明

- **oracle / llm 双模式共用同一评分器**：前者度量管线机械保真上限，后者度量端到端能力。
- **策略感知评分**：各溢出策略的合理结果都计入可接受集合，不把正确策略行为误判为失败；
  恒等替换（规则命中但内容不变）不计为目标。
- **相对宽度法**：以原文本 pdfjs 实测宽度为基准按字符估算比例缩放，消除估算字宽与真实
  度量的系统性偏差。
- **包含命中**：叠加文本与旧文本常被提取器合并为一个单元，候选串包含期望全文即视为落地；
  由此产生的旧文残留问题由 `staleOriginalTextRate` 单独刻画，两者互不污染。
