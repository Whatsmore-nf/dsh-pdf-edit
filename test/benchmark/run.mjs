#!/usr/bin/env node
/**
 * dsh-pdf-edit 编辑能力基准
 *
 * 用法：
 *   npm run bench                # oracle 模式：确定性“理想 AI”，度量管线机械保真上限
 *   npm run bench -- --llm       # 真实模式：调用 DeepSeek API（需 DEEPSEEK_API_KEY），按 ground truth 打分
 *   npm run bench -- --filter zh # 只跑 id 含关键字的用例
 *
 * 产物：
 *   test/benchmark/results/report.json   机器可读全量指标
 *   test/benchmark/results/report.md     人读报告
 *   test/benchmark/results/<case>/       original.pdf / edited.pdf
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const RESULTS = join(HERE, "results");

const args = process.argv.slice(2);
const USE_LLM = args.includes("--llm");
const FILTER = args[args.indexOf("--filter") + 1] || "";

/* dist 构建产物（保证评测的是发布形态） */
const { StyleLockedEditor } = await import(join(ROOT, "dist", "pipeline.js"));
const { StyleLockedExtractor } = await import(join(ROOT, "dist", "extractor.js"));
const { replacePages } = await import(join(ROOT, "dist", "pdf-ops.js"));
const {
  createDeepSeekChatFn,
} = await import(join(ROOT, "dist", "ai-editor.js"));

/* TS helpers（node --experimental-strip-types 直载） */
const pdfHelpers = await import(join(HERE, "..", "helpers", "make-pdf.ts"));
const { scriptedChat } = await import(join(HERE, "..", "helpers", "chat-mock.ts"));
const { CASES, deriveTruth } = await import(join(HERE, "cases.mjs"));
const { evaluate } = await import(join(HERE, "metrics.mjs"));

const cjkAvailable = pdfHelpers.hasCjkFont();

function pickChat() {
  if (!USE_LLM) return null; // 每个 case 单独建 oracle
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    console.error("--llm 需要 DEEPSEEK_API_KEY 环境变量");
    process.exit(2);
  }
  return createDeepSeekChatFn({
    apiKey: key,
    baseUrl: process.env.DEEPSEEK_BASE_URL || undefined,
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  });
}

async function extractAll(bytes, pageLimit = Infinity) {
  const ex = await StyleLockedExtractor.open(bytes);
  const n = Math.min(ex.pageCount, pageLimit);
  const pages = [];
  for (let p = 1; p <= n; p++) pages.push(await ex.extractPage(p));
  return { pages, pageCount: ex.pageCount };
}

async function loadCaseBytes(c) {
  if (c.kind === "gen") return c.makeBytes();
  const p = join(ROOT, "test", "fixtures", "downloaded", c.file);
  if (!existsSync(p)) return null;
  return new Uint8Array(readFileSync(p));
}

/** 大文档/限流场景：逐页 editPage 后合并，尊重 maxUnits 预算。
 *  注意：editPage 返回的是整份文档字节（native 与 browser 一致），
 *  因此这里从返回文档中拷出对应页再拼装。 */
async function editPerPage(bytes, totalUnits, chatFactory, opts, instruction, budget) {
  const { PDFDocument } = await import("pdf-lib");
  const editor = await StyleLockedEditor.open(bytes, chatFactory(), opts);
  const replacements = new Map();
  let used = 0;
  const stageT0 = performance.now();
  for (let p = 1; p <= editor.pageCount; p++) {
    const units = await editor.previewPage(p);
    if (used + units.length > budget) break;
    used += units.length;
    const outFull = await editor.editPage(p, instruction);
    // 从整文档输出中取出第 p 页，组装为单页文档
    const src = await PDFDocument.load(outFull, { ignoreEncryption: true });
    const tmp = await PDFDocument.create();
    const [pg] = await tmp.copyPages(src, [p - 1]);
    tmp.addPage(pg);
    replacements.set(p, await tmp.save());
  }
  const merged = await replacePages(bytes, replacements);
  return { merged, used, failures: editor.lastFailures, ms: performance.now() - stageT0 };
}

async function runCase(c, llmChatFn) {
  const dir = join(RESULTS, c.id);
  mkdirSync(dir, { recursive: true });

  const bytes = await loadCaseBytes(c);
  if (!bytes) return { id: c.id, title: c.title, skipped: `样例文件缺失：${c.file}` };
  if (c.cjkRequired && !cjkAvailable) return { id: c.id, title: c.title, skipped: "系统无 CJK 字体" };

  writeFileSync(join(dir, "original.pdf"), bytes);

  /* 提取原文 + 推导 ground truth */
  const t0 = performance.now();
  const { pages } = await extractAll(bytes);
  const extractMsBefore = performance.now() - t0;

  const truth = deriveTruth(pages, c.rules, c.glossary);
  const totalUnits = pages.reduce((s, p) => s + p.units.length, 0);

  /* 目标页 / 未触及页 */
  const touchedPages = new Set();
  for (const p of pages)
    for (const u of p.units)
      if (truth.expected.has(`${p.pageNumber}|${Math.round(u.x * 4)}:${Math.round(u.top * 4)}|${u.text}`))
        touchedPages.add(p.pageNumber);
  const untouchedPages = pages.map((p) => p.pageNumber).filter((n) => !touchedPages.has(n));

  /* 组装编辑器选项 */
  const opts = {
    overflow: c.overflow,
    renderMode: "native",
    ...(c.glossary ? { glossary: c.glossary } : {}),
    ...((c.rules.some((r) =>
      typeof r.match === "string"
        ? /[\u2E80-\u9FFF]/.test(r.match)
        : false,
    ) || c.cjkRequired)
      ? { fonts: { cjk: { bytes: pdfHelpers.loadCjkFaceBytes() } } }
      : {}),
  };

  /* 执行编辑并计时（分阶段） */
  const timing = { extractMs: r1(extractMsBefore), stages: {} };
  let merged, failures, aiMs = 0;

  const usePerpage = c.maxUnits && totalUnits > c.maxUnits;
  const chatFactory = () => {
    if (USE_LLM) return llmChatFn;
    return scriptedChat(c.rules);
  };

  const tEdit = performance.now();
  if (usePerpage) {
    ({ merged, failures, ms: aiMs } = await editPerPage(
      bytes,
      totalUnits,
      chatFactory,
      opts,
      c.instruction,
      c.maxUnits,
    ));
    timing.stages.mode = "per-page(预算截断)";
  } else {
    const editor = await StyleLockedEditor.open(bytes, chatFactory(), opts);
    const stageTimes = {};
    let lastMark = performance.now();
    const onProgress = (info) => {
      const now = performance.now();
      stageTimes[info.stage] = r1((stageTimes[info.stage] ?? 0) + (now - lastMark));
      lastMark = now;
    };
    merged = await editor.editDocument(c.instruction, onProgress);
    failures = editor.lastFailures;
    timing.stages = stageTimes;
    await editor.close();
  }
  const editMs = performance.now() - tEdit;

  /* 提取编辑结果并评分 */
  const t2 = performance.now();
  const { pages: afterPages, pageCount: pcAfter } = await extractAll(merged);
  const extractAfterMs = r1(performance.now() - t2);

  // 元数据保留检查
  let metadataKept = null;
  try {
    const { PDFDocument } = await import("pdf-lib");
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const outDoc = await PDFDocument.load(merged, { ignoreEncryption: true });
    const st = srcDoc.getTitle() ?? "";
    const ot = outDoc.getTitle() ?? "";
    metadataKept = st ? st === ot : null;
  } catch {}

  const report = evaluate(pages, afterPages, truth, {
    overflow: c.overflow,
    untouchedPages,
    metadataKept,
    bytesIn: bytes.length,
    bytesOut: merged.length,
    timing: {
      editTotalMs: r1(editMs),
      editPerOriginalPageMs: r1(editMs / pages.length),
      extractBeforeMs: r1(timing.extractMs),
      extractAfterMs,
      stages: timing.stages,
      mode: USE_LLM ? "deepseek-api" : "oracle-scripted",
      failures: failures.length,
      totalUnits,
      targets: truth.targetCount,
    },
  });

  if (c.skipAccuracy) {
    report.accuracy = { note: "n/a（真实样例无逐单元 ground truth，仅评版式/完整性/性能）" };
  }

  writeFileSync(join(dir, "edited.pdf"), merged);
  writeFileSync(join(dir, "result.json"), JSON.stringify(report, null, 2));

  return {
    id: c.id,
    title: c.title,
    description: c.description,
    ...report,
  };
}

const r1 = (x) => Math.round(x * 10) / 10;

/* ---------------- 主流程 ---------------- */

mkdirSync(RESULTS, { recursive: true });
const llmChatFn = pickChat();
const selected = CASES.filter((c) => !FILTER || c.id.includes(FILTER));

console.log(
  `\n== dsh-pdf-edit 基准 ==\n模式: ${USE_LLM ? "DeepSeek API" : "oracle（理想 AI）"} | 用例 ${selected.length}/${CASES.length}\n`,
);

const reports = [];
for (const c of selected) {
  process.stdout.write(`▶ ${c.id} ... `);
  try {
    const r = await runCase(c, llmChatFn);
    reports.push(r);
    console.log(r.skipped ? `跳过（${r.skipped}）` : `完成`);
  } catch (e) {
    reports.push({ id: c.id, title: c.title, error: String(e && e.stack ? e.stack : e) });
    console.log(`失败: ${e.message}`);
  }
}

writeFileSync(join(RESULTS, "report.json"), JSON.stringify(reports, null, 2));
await renderMarkdown(reports);
console.log(`\n报告已写入 test/benchmark/results/{report.json,report.md}\n`);

/* ---------------- Markdown 报告 ---------------- */

async function renderMarkdown(reports) {
  const lines = [];
  lines.push("# dsh-pdf-edit PDF 编辑能力基准报告");
  lines.push("");
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 运行模式：**${USE_LLM ? "DeepSeek API（真实 LLM）" : "oracle（脚本化理想 AI）"}**`);
  lines.push("- 评分口径：所有指标基于「编辑前后 PDF 重新提取」的对比与规则推导的 ground truth，见 `metrics.mjs`");
  lines.push("");

  const ok = reports.filter((r) => !r.skipped && !r.error);
  const bad = reports.filter((r) => r.error);

  lines.push("## 总览");
  lines.push("");
  lines.push("| 用例 | 目标 | 准确性 F1 | 字符相似度 | 完全匹配 | 改动位置保持 | 溢出残留 | 旧文残留率 | 页数保持 | 耗时(ms) |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const r of ok) {
    const a = r.accuracy.note ? "n/a" : `${r.accuracy.unitF1}`;
    const cs = r.accuracy.note ? "n/a" : `${r.accuracy.charSimilarity}`;
    const ex = r.accuracy.note ? "n/a" : `${Math.round(r.accuracy.exactMatchRate * 100)}%`;
    const pos = r.layout.changedPositionKeptRate == null ? "n/a" : `${Math.round(r.layout.changedPositionKeptRate * 100)}%`;
    const ovf = r.layout.policyConformanceRate == null ? "n/a" : `${Math.round(r.layout.policyConformanceRate * 100)}%`;
    const stale = r.integrity.staleOriginalTextRate == null ? "n/a" : `${Math.round(r.integrity.staleOriginalTextRate * 100)}%`;
    lines.push(
      `| ${r.id} | ${r.accuracy.targets ?? "-"} | ${a} | ${cs} | ${ex} | ${pos} | ${ovf} | ${stale} | ${
        r.integrity.pageCountPreserved ? "✓" : "✗"
      } | ${r.performance.editTotalMs ?? "-"} |`,
    );
  }
  for (const r of reports.filter((x) => x.skipped))
    lines.push(`| ${r.id} | - | - | - | - | - | - | - | - | 跳过：${r.skipped} |`);
  lines.push("");

  for (const r of ok) {
    lines.push(`---`);
    lines.push("");
    lines.push(`### ${r.id} — ${r.title}`);
    lines.push("");
    lines.push(r.description || "");
    lines.push("");
    lines.push("**A. 编辑准确性**");
    lines.push("```json");
    lines.push(JSON.stringify(r.accuracy, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("**B. 版式保持（破坏度）**");
    lines.push("```json");
    lines.push(JSON.stringify(r.layout, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("**C. 文档完整性**");
    lines.push("```json");
    lines.push(JSON.stringify(r.integrity, null, 2));
    lines.push("```");
    lines.push("");
    lines.push("**D. 性能**");
    lines.push("```json");
    lines.push(JSON.stringify(r.performance, null, 2));
    lines.push("```");
    lines.push("");
    lines.push(`产物：\`results/${r.id}/original.pdf\` · \`results/${r.id}/edited.pdf\` · \`results/${r.id}/result.json\``);
    lines.push("");
  }

  if (bad.length) {
    lines.push("## 失败用例");
    for (const r of bad) {
      lines.push(`### ${r.id}`);
      lines.push("```");
      lines.push(String(r.error));
      lines.push("```");
    }
  }

  writeFileSync(join(RESULTS, "report.md"), lines.join("\n"));
}
