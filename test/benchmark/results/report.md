# dsh-pdf-edit PDF 编辑能力基准报告

- 生成时间：2026-08-21T16:07:35.476Z
- 运行模式：**oracle（脚本化理想 AI）**
- 评分口径：所有指标基于「编辑前后 PDF 重新提取」的对比与规则推导的 ground truth，见 `metrics.mjs`

## 总览

| 用例 | 目标 | 准确性 F1 | 字符相似度 | 完全匹配 | 改动位置保持 | 溢出残留 | 旧文残留率 | 页数保持 | 耗时(ms) |
|---|---|---|---|---|---|---|---|---|---|
| en-basic-replace | 3 | 1 | 1 | 100% | 100% | 100% | 67% | ✓ | 58.6 |
| zh-glossary-doc | 5 | 1 | 1 | 100% | 100% | 100% | 100% | ✓ | 1148.7 |
| multipage-report-5p | 30 | 1 | 1 | 100% | 100% | 100% | 100% | ✓ | 75.1 |
| overflow-shrink | 3 | 1 | 0.97 | 100% | 100% | 100% | 100% | ✓ | 13.4 |
| overflow-clip | 3 | 1 | 1 | 100% | 100% | 100% | 100% | ✓ | 13.5 |
| overflow-reject | 3 | 1 | 1 | 100% | 100% | 100% | 100% | ✓ | 16.5 |
| mixed-zh-en-3p | 4 | 1 | 1 | 100% | 100% | 100% | 100% | ✓ | 1283.3 |
| real-w3c-smoke | 1 | 1 | 1 | 100% | 100% | 100% | 100% | ✓ | 24.3 |
| real-two-column-academic | - | n/a | n/a | n/a | 100% | 100% | 100% | ✓ | 245.3 |
| real-arxiv-paper | - | n/a | n/a | n/a | 100% | 100% | 100% | ✓ | 11137.9 |

---

### en-basic-replace — 英文单页 · 术语/数字替换

单页 Helvetica 文档，3 处定点替换（含跨 run 合并行）。验证提取-修改-回写全链路的准确性。

**A. 编辑准确性**
```json
{
  "targets": 3,
  "unitPrecision": 1,
  "unitRecall": 1,
  "unitF1": 1,
  "charSimilarity": 1,
  "exactMatchRate": 1,
  "collateralUnits": 0
}
```

**B. 版式保持（破坏度）**
```json
{
  "unchangedCompared": 3,
  "unchangedMaxDxPt": 0,
  "unchangedColorMismatch": 0,
  "unchangedFontFamilyMismatch": 0,
  "unchangedFontSizeMismatch": 0,
  "changedPositionKeptRate": 1,
  "policyConformanceRate": 1
}
```

**C. 文档完整性**
```json
{
  "pageCountBefore": 1,
  "pageCountAfter": 1,
  "pageCountPreserved": true,
  "untouchedPageTextRatio": null,
  "staleOriginalTextRate": 0.67,
  "metadataKept": true,
  "bytesIn": 1480,
  "bytesOut": 2199,
  "sizeRatio": 1.49
}
```

**D. 性能**
```json
{
  "editTotalMs": 58.6,
  "editPerOriginalPageMs": 58.6,
  "extractBeforeMs": 324.2,
  "extractAfterMs": 25,
  "stages": {
    "render": 40.5,
    "merge": 7.5
  },
  "mode": "oracle-scripted",
  "failures": 0,
  "totalUnits": 6,
  "targets": 3
}
```

产物：`results/en-basic-replace/original.pdf` · `results/en-basic-replace/edited.pdf` · `results/en-basic-replace/result.json`

---

### zh-glossary-doc — 中文文档 · 术语表全局替换

嵌入 CJK 字体的中文文档，「帐号→账号」「数据中台→数据平台」全文统一。验证 CJK 提取、回写与术语链路。

**A. 编辑准确性**
```json
{
  "targets": 5,
  "unitPrecision": 1,
  "unitRecall": 1,
  "unitF1": 1,
  "charSimilarity": 1,
  "exactMatchRate": 1,
  "collateralUnits": 0
}
```

**B. 版式保持（破坏度）**
```json
{
  "unchangedCompared": 2,
  "unchangedMaxDxPt": 0,
  "unchangedColorMismatch": 0,
  "unchangedFontFamilyMismatch": 0,
  "unchangedFontSizeMismatch": 0,
  "changedPositionKeptRate": 1,
  "policyConformanceRate": 1
}
```

**C. 文档完整性**
```json
{
  "pageCountBefore": 1,
  "pageCountAfter": 1,
  "pageCountPreserved": true,
  "untouchedPageTextRatio": null,
  "staleOriginalTextRate": 1,
  "metadataKept": true,
  "bytesIn": 6477945,
  "bytesOut": 6495697,
  "sizeRatio": 1
}
```

**D. 性能**
```json
{
  "editTotalMs": 1148.7,
  "editPerOriginalPageMs": 1148.7,
  "extractBeforeMs": 944.3,
  "extractAfterMs": 895.2,
  "stages": {
    "render": 990.1,
    "merge": 9.2
  },
  "mode": "oracle-scripted",
  "failures": 0,
  "totalUnits": 7,
  "targets": 5
}
```

产物：`results/zh-glossary-doc/original.pdf` · `results/zh-glossary-doc/edited.pdf` · `results/zh-glossary-doc/result.json`

---

### multipage-report-5p — 多页报告 · 全文批量编辑

5 页 Times 报告，每页正文替换一处长短语。验证分批调度、进度阶段与跨页一致性。

**A. 编辑准确性**
```json
{
  "targets": 30,
  "unitPrecision": 1,
  "unitRecall": 1,
  "unitF1": 1,
  "charSimilarity": 1,
  "exactMatchRate": 1,
  "collateralUnits": 0
}
```

**B. 版式保持（破坏度）**
```json
{
  "unchangedCompared": 10,
  "unchangedMaxDxPt": 0,
  "unchangedColorMismatch": 0,
  "unchangedFontFamilyMismatch": 0,
  "unchangedFontSizeMismatch": 0,
  "changedPositionKeptRate": 1,
  "policyConformanceRate": 1
}
```

**C. 文档完整性**
```json
{
  "pageCountBefore": 5,
  "pageCountAfter": 5,
  "pageCountPreserved": true,
  "untouchedPageTextRatio": null,
  "staleOriginalTextRate": 1,
  "metadataKept": true,
  "bytesIn": 3264,
  "bytesOut": 5495,
  "sizeRatio": 1.68
}
```

**D. 性能**
```json
{
  "editTotalMs": 75.1,
  "editPerOriginalPageMs": 15,
  "extractBeforeMs": 51.1,
  "extractAfterMs": 52,
  "stages": {
    "render": 52.8,
    "merge": 12.7
  },
  "mode": "oracle-scripted",
  "failures": 0,
  "totalUnits": 40,
  "targets": 30
}
```

产物：`results/multipage-report-5p/original.pdf` · `results/multipage-report-5p/edited.pdf` · `results/multipage-report-5p/result.json`

---

### overflow-shrink — 溢出策略 · shrink（缩放）

三行窄框文本替换为其 3.4 倍长度的新句。期望：字号缩至 ≥6pt 或钳位+截断，不越界。

**A. 编辑准确性**
```json
{
  "targets": 3,
  "unitPrecision": 1,
  "unitRecall": 1,
  "unitF1": 1,
  "charSimilarity": 0.97,
  "exactMatchRate": 1,
  "collateralUnits": 0
}
```

**B. 版式保持（破坏度）**
```json
{
  "unchangedCompared": 1,
  "unchangedMaxDxPt": 0,
  "unchangedColorMismatch": 0,
  "unchangedFontFamilyMismatch": 0,
  "unchangedFontSizeMismatch": 0,
  "changedPositionKeptRate": 1,
  "policyConformanceRate": 1
}
```

**C. 文档完整性**
```json
{
  "pageCountBefore": 1,
  "pageCountAfter": 1,
  "pageCountPreserved": true,
  "untouchedPageTextRatio": null,
  "staleOriginalTextRate": 1,
  "metadataKept": null,
  "bytesIn": 1054,
  "bytesOut": 1575,
  "sizeRatio": 1.49
}
```

**D. 性能**
```json
{
  "editTotalMs": 13.4,
  "editPerOriginalPageMs": 13.4,
  "extractBeforeMs": 6.8,
  "extractAfterMs": 9.1,
  "stages": {
    "render": 5.5,
    "merge": 2.9
  },
  "mode": "oracle-scripted",
  "failures": 0,
  "totalUnits": 4,
  "targets": 3
}
```

产物：`results/overflow-shrink/original.pdf` · `results/overflow-shrink/edited.pdf` · `results/overflow-shrink/result.json`

---

### overflow-clip — 溢出策略 · clip（截断）

同上但使用 clip 策略。期望：保持原字号、超出部分截断加省略号。

**A. 编辑准确性**
```json
{
  "targets": 3,
  "unitPrecision": 1,
  "unitRecall": 1,
  "unitF1": 1,
  "charSimilarity": 1,
  "exactMatchRate": 1,
  "collateralUnits": 0
}
```

**B. 版式保持（破坏度）**
```json
{
  "unchangedCompared": 1,
  "unchangedMaxDxPt": 0,
  "unchangedColorMismatch": 0,
  "unchangedFontFamilyMismatch": 0,
  "unchangedFontSizeMismatch": 0,
  "changedPositionKeptRate": 1,
  "policyConformanceRate": 1
}
```

**C. 文档完整性**
```json
{
  "pageCountBefore": 1,
  "pageCountAfter": 1,
  "pageCountPreserved": true,
  "untouchedPageTextRatio": null,
  "staleOriginalTextRate": 1,
  "metadataKept": null,
  "bytesIn": 1054,
  "bytesOut": 1562,
  "sizeRatio": 1.48
}
```

**D. 性能**
```json
{
  "editTotalMs": 13.5,
  "editPerOriginalPageMs": 13.5,
  "extractBeforeMs": 4.6,
  "extractAfterMs": 8.9,
  "stages": {
    "render": 4.4,
    "merge": 3.5
  },
  "mode": "oracle-scripted",
  "failures": 0,
  "totalUnits": 4,
  "targets": 3
}
```

产物：`results/overflow-clip/original.pdf` · `results/overflow-clip/edited.pdf` · `results/overflow-clip/result.json`

---

### overflow-reject — 溢出策略 · reject（拒绝）

同上但使用 reject 策略。期望：全部拒绝、原文零改动 —— 度量「拒绝是否干净」。

**A. 编辑准确性**
```json
{
  "targets": 3,
  "unitPrecision": 1,
  "unitRecall": 1,
  "unitF1": 1,
  "charSimilarity": 1,
  "exactMatchRate": 1,
  "collateralUnits": 0
}
```

**B. 版式保持（破坏度）**
```json
{
  "unchangedCompared": 1,
  "unchangedMaxDxPt": 0,
  "unchangedColorMismatch": 0,
  "unchangedFontFamilyMismatch": 0,
  "unchangedFontSizeMismatch": 0,
  "changedPositionKeptRate": 1,
  "policyConformanceRate": 1
}
```

**C. 文档完整性**
```json
{
  "pageCountBefore": 1,
  "pageCountAfter": 1,
  "pageCountPreserved": true,
  "untouchedPageTextRatio": null,
  "staleOriginalTextRate": 1,
  "metadataKept": null,
  "bytesIn": 1054,
  "bytesOut": 1066,
  "sizeRatio": 1.01
}
```

**D. 性能**
```json
{
  "editTotalMs": 16.5,
  "editPerOriginalPageMs": 16.5,
  "extractBeforeMs": 5.8,
  "extractAfterMs": 4.7,
  "stages": {
    "skip": 13.4,
    "merge": 0
  },
  "mode": "oracle-scripted",
  "failures": 0,
  "totalUnits": 4,
  "targets": 3
}
```

产物：`results/overflow-reject/original.pdf` · `results/overflow-reject/edited.pdf` · `results/overflow-reject/result.json`

---

### mixed-zh-en-3p — 中英混排 3 页 · 综合

标题/章节/正文/附录混合样式 + 中英双语 + 元数据。组合替换与术语表，考察复杂真实版面下的综合表现。

**A. 编辑准确性**
```json
{
  "targets": 4,
  "unitPrecision": 1,
  "unitRecall": 1,
  "unitF1": 1,
  "charSimilarity": 1,
  "exactMatchRate": 1,
  "collateralUnits": 0
}
```

**B. 版式保持（破坏度）**
```json
{
  "unchangedCompared": 16,
  "unchangedMaxDxPt": 0,
  "unchangedColorMismatch": 0,
  "unchangedFontFamilyMismatch": 0,
  "unchangedFontSizeMismatch": 0,
  "changedPositionKeptRate": 1,
  "policyConformanceRate": 1
}
```

**C. 文档完整性**
```json
{
  "pageCountBefore": 3,
  "pageCountAfter": 3,
  "pageCountPreserved": true,
  "untouchedPageTextRatio": null,
  "staleOriginalTextRate": 1,
  "metadataKept": true,
  "bytesIn": 6479427,
  "bytesOut": 6486752,
  "sizeRatio": 1
}
```

**D. 性能**
```json
{
  "editTotalMs": 1283.3,
  "editPerOriginalPageMs": 427.8,
  "extractBeforeMs": 860.7,
  "extractAfterMs": 784.5,
  "stages": {
    "render": 981.4,
    "merge": 3.6
  },
  "mode": "oracle-scripted",
  "failures": 0,
  "totalUnits": 20,
  "targets": 4
}
```

产物：`results/mixed-zh-en-3p/original.pdf` · `results/mixed-zh-en-3p/edited.pdf` · `results/mixed-zh-en-3p/result.json`

---

### real-w3c-smoke — 真实 PDF · W3C 冒烟样例（1 页）

最小真实 PDF，验证外部样例加载→编辑→回写链路畅通（成本近零）。

**A. 编辑准确性**
```json
{
  "targets": 1,
  "unitPrecision": 1,
  "unitRecall": 1,
  "unitF1": 1,
  "charSimilarity": 1,
  "exactMatchRate": 1,
  "collateralUnits": 0
}
```

**B. 版式保持（破坏度）**
```json
{
  "unchangedCompared": 0,
  "unchangedMaxDxPt": 0,
  "unchangedColorMismatch": 0,
  "unchangedFontFamilyMismatch": 0,
  "unchangedFontSizeMismatch": 0,
  "changedPositionKeptRate": 1,
  "policyConformanceRate": 1
}
```

**C. 文档完整性**
```json
{
  "pageCountBefore": 1,
  "pageCountAfter": 1,
  "pageCountPreserved": true,
  "untouchedPageTextRatio": null,
  "staleOriginalTextRate": 1,
  "metadataKept": null,
  "bytesIn": 13264,
  "bytesOut": 13124,
  "sizeRatio": 0.99
}
```

**D. 性能**
```json
{
  "editTotalMs": 24.3,
  "editPerOriginalPageMs": 24.3,
  "extractBeforeMs": 11.9,
  "extractAfterMs": 17.7,
  "stages": {
    "render": 17.5,
    "merge": 1.2
  },
  "mode": "oracle-scripted",
  "failures": 0,
  "totalUnits": 1,
  "targets": 1
}
```

产物：`results/real-w3c-smoke/original.pdf` · `results/real-w3c-smoke/edited.pdf` · `results/real-w3c-smoke/result.json`

---

### real-two-column-academic — 真实 PDF · 双栏学术排版（css4.pub 样例）

外部双栏学术样例（4 页）。无逐单元 ground truth，accuracy 记 n/a；评 layout/integrity/perf 与旧文残留率。

**A. 编辑准确性**
```json
{
  "note": "n/a（真实样例无逐单元 ground truth，仅评版式/完整性/性能）"
}
```

**B. 版式保持（破坏度）**
```json
{
  "unchangedCompared": 246,
  "unchangedMaxDxPt": 0,
  "unchangedColorMismatch": 0,
  "unchangedFontFamilyMismatch": 0,
  "unchangedFontSizeMismatch": 0,
  "changedPositionKeptRate": 1,
  "policyConformanceRate": 1
}
```

**C. 文档完整性**
```json
{
  "pageCountBefore": 4,
  "pageCountAfter": 4,
  "pageCountPreserved": true,
  "untouchedPageTextRatio": 1,
  "staleOriginalTextRate": 1,
  "metadataKept": true,
  "bytesIn": 145349,
  "bytesOut": 140579,
  "sizeRatio": 0.97
}
```

**D. 性能**
```json
{
  "editTotalMs": 245.3,
  "editPerOriginalPageMs": 61.3,
  "extractBeforeMs": 239.6,
  "extractAfterMs": 181.2,
  "stages": {
    "render": 236.3,
    "skip": 0.4,
    "merge": 1.5
  },
  "mode": "oracle-scripted",
  "failures": 0,
  "totalUnits": 248,
  "targets": 2
}
```

产物：`results/real-two-column-academic/original.pdf` · `results/real-two-column-academic/edited.pdf` · `results/real-two-column-academic/result.json`

---

### real-arxiv-paper — 真实 PDF · arXiv 论文（5 页，含公式）

arXiv:1706.03762 前 5 页，密集学术文本与数学符号。stress 测试：大小写规范化替换，重点看版式漂移与完整性。

**A. 编辑准确性**
```json
{
  "note": "n/a（真实样例无逐单元 ground truth，仅评版式/完整性/性能）"
}
```

**B. 版式保持（破坏度）**
```json
{
  "unchangedCompared": 1700,
  "unchangedMaxDxPt": 0,
  "unchangedColorMismatch": 0,
  "unchangedFontFamilyMismatch": 0,
  "unchangedFontSizeMismatch": 0,
  "changedPositionKeptRate": 1,
  "policyConformanceRate": 1
}
```

**C. 文档完整性**
```json
{
  "pageCountBefore": 15,
  "pageCountAfter": 15,
  "pageCountPreserved": true,
  "untouchedPageTextRatio": 1,
  "staleOriginalTextRate": 1,
  "metadataKept": null,
  "bytesIn": 2215244,
  "bytesOut": 2699183,
  "sizeRatio": 1.22
}
```

**D. 性能**
```json
{
  "editTotalMs": 11137.9,
  "editPerOriginalPageMs": 742.5,
  "extractBeforeMs": 1766.5,
  "extractAfterMs": 2182.3,
  "stages": {
    "mode": "per-page(预算截断)"
  },
  "mode": "oracle-scripted",
  "failures": 0,
  "totalUnits": 1702,
  "targets": 2
}
```

产物：`results/real-arxiv-paper/original.pdf` · `results/real-arxiv-paper/edited.pdf` · `results/real-arxiv-paper/result.json`
