/**
 * benchmark 用例定义。
 * 每个用例 = { id, title, description, makeBytes(), rules, editorOpts, untouchedPages?, realPdf? }
 *  - rules: ReplaceRule[]（与 test/helpers/chat-mock.ts 同构），oracle 模式下即"理想 AI"；
 *          expected ground truth 由规则对原文本推导，因此 accuracy 可精确打分。
 *  - realPdf: 真实世界样例（无逐单元 ground truth），accuracy 记 n/a，只评 layout/integrity/perf。
 */

const EN_RULES = [
  { match: "99.95 percent", to: (t) => t.replace("99.95 percent", "99.99 percent") },
  { match: "on-call rotation", to: (t) => t.replace("on-call rotation", "on-call schedule") },
  { match: "multi-region failover", to: (t) => t.replace("multi-region failover drills", "cross-region failover exercises") },
];

const ZH_RULES = [
  { match: "帐号", to: (t) => t.split("帐号").join("账号") },
  { match: "数据中台", to: (t) => t.split("数据中台").join("数据平台") },
];

export const CASES = [
  {
    id: "en-basic-replace",
    title: "英文单页 · 术语/数字替换",
    description:
      "单页 Helvetica 文档，3 处定点替换（含跨 run 合并行）。验证提取-修改-回写全链路的准确性。",
    kind: "gen",
    makeBytes: () => import("../helpers/make-pdf.ts").then((m) => m.englishBasic()),
    instruction: "把 99.95 更新为 99.99；rotation 统一为 schedule；drills 改为 exercises",
    rules: EN_RULES,
    overflow: { mode: "shrink", minFontSizePt: 6 },
  },

  {
    id: "zh-glossary-doc",
    title: "中文文档 · 术语表全局替换",
    description:
      "嵌入 CJK 字体的中文文档，「帐号→账号」「数据中台→数据平台」全文统一。验证 CJK 提取、回写与术语链路。",
    kind: "gen",
    makeBytes: () => import("../helpers/make-pdf.ts").then((m) => m.chineseDoc()),
    instruction: "统一术语：帐号→账号，数据中台→数据平台",
    rules: ZH_RULES,
    glossary: { 帐号: "账号", 数据中台: "数据平台" },
    overflow: { mode: "shrink", minFontSizePt: 6 },
    cjkRequired: true,
  },

  {
    id: "multipage-report-5p",
    title: "多页报告 · 全文批量编辑",
    description:
      "5 页 Times 报告，每页正文替换一处长短语。验证分批调度、进度阶段与跨页一致性。",
    kind: "gen",
    makeBytes: () => import("../helpers/make-pdf.ts").then((m) => m.multipageReport(5)),
    instruction: "把每页的 lorem ipsum 句子替换为 EDITED TEXT HERE",
    rules: [
      {
        match: "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.",
        to: () => "EDITED TEXT HERE (replaced placeholder sentence)",
      },
    ],
    overflow: { mode: "shrink", minFontSizePt: 6 },
  },

  {
    id: "overflow-shrink",
    title: "溢出策略 · shrink（缩放）",
    description:
      "三行窄框文本替换为其 3.4 倍长度的新句。期望：字号缩至 ≥6pt 或钳位+截断，不越界。",
    kind: "gen",
    makeBytes: () => import("../helpers/make-pdf.ts").then((m) => m.tightBoxes().then((r) => r.bytes)),
    instruction: "把 Fixed width column 全部替换成长句",
    rules: [
      {
        match: "Fixed width column",
        to: () => "Much longer replacement text that exceeds the fixed column",
      },
    ],
    overflow: { mode: "shrink", minFontSizePt: 6 },
  },

  {
    id: "overflow-clip",
    title: "溢出策略 · clip（截断）",
    description: "同上但使用 clip 策略。期望：保持原字号、超出部分截断加省略号。",
    kind: "gen",
    makeBytes: () => import("../helpers/make-pdf.ts").then((m) => m.tightBoxes().then((r) => r.bytes)),
    instruction: "把 Fixed width column 全部替换成长句（截断模式）",
    rules: [
      {
        match: "Fixed width column",
        to: () => "Much longer replacement text that exceeds the fixed column",
      },
    ],
    overflow: { mode: "clip" },
  },

  {
    id: "overflow-reject",
    title: "溢出策略 · reject（拒绝）",
    description: "同上但使用 reject 策略。期望：全部拒绝、原文零改动 —— 度量「拒绝是否干净」。",
    kind: "gen",
    makeBytes: () => import("../helpers/make-pdf.ts").then((m) => m.tightBoxes().then((r) => r.bytes)),
    instruction: "把 Fixed width column 全部替换成长句（拒绝模式）",
    rules: [
      {
        match: "Fixed width column",
        to: () => "Much longer replacement text that exceeds the fixed column",
      },
    ],
    overflow: { mode: "reject" },
  },

  {
    id: "mixed-zh-en-3p",
    title: "中英混排 3 页 · 综合",
    description:
      "标题/章节/正文/附录混合样式 + 中英双语 + 元数据。组合替换与术语表，考察复杂真实版面下的综合表现。",
    kind: "gen",
    makeBytes: () => import("../helpers/make-pdf.ts").then((m) => m.benchmarkMixedDoc()),
    instruction: "统一术语并修正措辞",
    rules: [
      ...ZH_RULES,
      { match: "three replicas per service", to: (t) => t.replace("three replicas per service", "four replicas per service") },
      { match: "Rolling updates complete", to: (t) => t.replace("within eight minutes", "within six minutes") },
    ],
    glossary: { 帐号: "账号", 数据中台: "数据平台" },
    overflow: { mode: "shrink", minFontSizePt: 6 },
    cjkRequired: true,
  },

  {
    id: "real-w3c-smoke",
    title: "真实 PDF · W3C 冒烟样例（1 页）",
    description: "最小真实 PDF，验证外部样例加载→编辑→回写链路畅通（成本近零）。",
    kind: "file",
    file: "real-w3c-dummy-1p.pdf",
    instruction: "把 Dummy 改为 Sample（演示性编辑）",
    rules: [{ match: /[Dd]ummy/, to: (t) => t.replace(/[Dd]ummy/g, "Sample") }],
    overflow: { mode: "shrink", minFontSizePt: 6 },
  },

  {
    id: "real-two-column-academic",
    title: "真实 PDF · 双栏学术排版（css4.pub 样例）",
    description:
      "外部双栏学术样例（4 页）。无逐单元 ground truth，accuracy 记 n/a；评 layout/integrity/perf 与旧文残留率。",
    kind: "file",
    file: "real-css4pub-twocol-4p.pdf",
    instruction: "将文中出现的 'somatosensory' 统一替换为 'somatic'（演示性编辑）",
    rules: [{ match: "somatosensory", to: (t) => t.split("somatosensory").join("somatic") }],
    overflow: { mode: "shrink", minFontSizePt: 6 },
    skipAccuracy: true,
  },

  {
    id: "real-arxiv-paper",
    title: "真实 PDF · arXiv 论文（5 页，含公式）",
    description:
      "arXiv:1706.03762 前 5 页，密集学术文本与数学符号。stress 测试：大小写规范化替换，重点看版式漂移与完整性。",
    kind: "file",
    file: "real-arxiv-1706.03762-15p.pdf",
    pages: [1, 2, 3, 4, 5],
    instruction: "将 transformer 的各种大小写形式统一为 Transformer（大小写规范化演示）",
    rules: [
      {
        match: /[Tt]ransformers?\b/,
        to: (t) => t.replace(/[Tt]ransformer(s?)\b/g, "Transformer$1"),
      },
    ],
    overflow: { mode: "shrink", minFontSizePt: 6 },
    skipAccuracy: true,
    maxUnits: 1200,
  },
];

/** 由规则推导 ground truth（级联：首条命中规则 + 术语表，与生产管线一致） */
export function deriveTruth(pages, rules, glossary) {
  const terms = glossary
    ? (Array.isArray(glossary) ? glossary : Object.entries(glossary).map(([from, to]) => ({ from, to })))
        .filter((t) => t.from && t.to && t.from !== t.to)
        .sort((a, b) => b.from.length - a.from.length)
    : [];

  const expected = new Map();
  let targetCount = 0;
  for (const p of pages) {
    for (const u of p.units) {
      for (const r of rules) {
        const hit =
          typeof r.match === "string" ? u.text.includes(r.match) : r.match.test(u.text);
        if (!hit) continue;
        let want = typeof r.to === "function" ? r.to(u.text) : r.to;
        for (const t of terms) want = want.split(t.from).join(t.to);
        // 恒等替换（规则命中但内容不变）不是编辑，不计入目标
        if (want === u.text) continue;
        expected.set(`${p.pageNumber}|${Math.round(u.x * 4)}:${Math.round(u.top * 4)}|${u.text}`, want);
        targetCount++;
        break;
      }
    }
  }
  return { expected, targetCount };
}
