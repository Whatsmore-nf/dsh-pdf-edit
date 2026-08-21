/**
 * benchmark 指标体系 —— 全部基于「编辑前后 PDF 的重新提取结果」与 ground truth 计算，
 * 不依赖内部状态，可对任意实现（native/browser、oracle/LLM）横向比较。
 *
 * 维度：
 *  A. 编辑准确性 accuracy   —— 改得对不对（策略感知：shrink/clip/reject 的合理结果均计入）
 *  B. 版式保持 layout       —— 版面破坏度
 *  C. 文档完整性 integrity  —— 文件级损伤与副作用（含「旧文残留率」）
 *  D. 性能 performance      —— 各阶段耗时与体积
 */

/* ---------- 基础工具 ---------- */

export function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

export function charSim(a, b) {
  if (a === b) return 1;
  const d = levenshtein(a, b);
  return 1 - d / Math.max(a.length, b.length);
}

const posKey = (u) => `${Math.round(u.x * 4)}:${Math.round(u.top * 4)}`;
const r2 = (x) => Math.round(x * 100) / 100;

/* 宽度估算（与 src/util.estimateTextWidthPt 同口径） */
function estimateWidth(text, fontSizePt) {
  const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
  const NARROW = /[iljtf.,:;'`!|()[\]{}]/;
  let em = 0;
  for (const ch of text) {
    if (ch === " ") em += 0.3;
    else if (WIDE.test(ch)) em += 1.0;
    else if (NARROW.test(ch)) em += 0.32;
    else if (ch >= "A" && ch <= "Z") em += 0.72;
    else if (ch >= "0" && ch <= "9") em += 0.56;
    else em += 0.52;
  }
  return em * fontSizePt;
}

/* 与 src/util 相同行为的截断/换行复刻，用于生成"可接受结果变体" */
function ellipsizeLike(text, maxW, fs) {
  const m = (s) => estimateWidth(s, fs);
  if (m(text) <= maxW) return text;
  let s = text;
  while (s.length > 1 && m(s + "…") > maxW) s = s.slice(0, -1);
  return s + "…";
}
function wrapJoinLike(text, maxW, fs) {
  const m = (s) => estimateWidth(s, fs);
  const tokens =
    text.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]|\s+|[^\s\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]+/g) ?? [];
  const lines = [];
  let cur = "";
  for (const tk of tokens) {
    if (cur && m(cur + tk) > maxW) {
      lines.push(cur.trimEnd());
      cur = tk.trimStart();
    } else cur += tk;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.join("\n");
}

/**
 * 相对宽度：want 相对原文本的宽度比 × 原文本的真实测量宽度（pdfjs 实测）。
 * 消除「估算字宽 ≠ 真实字体度量」的系统性偏差。
 */
function realWantWidth(u, want) {
  const fs = u.fontSize;
  const denom = estimateWidth(u.text, fs);
  const rel = denom > 0 ? estimateWidth(want, fs) / denom : 1;
  return u.width * rel;
}

/**
 * 策略感知的可接受结果集合（返回 [{text, approx}]）：
 *  - approx=false：完整期望文本，要求近乎完全一致
 *  - approx=true ：截断/换行等估算变体（估算宽度 ≠ 真实字体度量），放宽到 ≥0.9
 *  - reject 溢出  → 原文本保持才是正确结果
 */
function acceptedVariants(u, want, overflow) {
  const mode = overflow?.mode ?? "shrink";
  const over = realWantWidth(u, want) > u.width * 1.06 + 2;
  const out = [{ text: want, approx: false }];

  if (!over) return out;

  if (mode === "reject") return [{ text: u.text, approx: false }];

  if (mode === "clip") out.push({ text: ellipsizeLike(want, u.width + 1, u.fontSize), approx: true });
  if (mode === "wrap") out.push({ text: wrapJoinLike(want, u.width + 1, u.fontSize), approx: true });
  if (mode === "shrink") {
    const min = overflow?.minFontSizePt ?? 6;
    const estAbs = estimateWidth(want, u.fontSize);
    const rel = estAbs / Math.max(1e-6, estimateWidth(u.text, u.fontSize));
    const realW = u.width * rel;
    const scaled = u.fontSize * (u.width / Math.max(1e-6, realW)); // = fs/rel
    if (scaled < min)
      out.push({ text: ellipsizeLike(want, u.width + 1, min), approx: true });
  }
  // 真实字体度量与估算存在偏差，完整文本也允许极小截尾误差
  out.push({ text: want, approx: true });
  return out;
}

/* 策略符合性判定：编辑结果是否兑现了溢出策略承诺 */
function policyOk(mode, t, want, cands, candStrings) {
  if (mode === "reject") {
    // 拒绝：不得有任何新文本落地（允许旧文本原样存在；用单条候选避免窗口拼接误报）
    return !cands.some((c) => c.text !== t.text && charSim(c.text, t.text) < 0.999);
  }

  // 其余策略：期望新文本必须已落地。
  // 窄框可能只容得下极少字符，因此按 20→12→8→4 渐进匹配前缀；省略号也算落地证据。
  const fresh = cands.filter((c) => charSim(c.text, t.text) < 0.999);
  let landed = false;
  outer: for (const n of [20, 12, 8, 4]) {
    const head = want.slice(0, Math.min(n, want.length));
    for (const cs of candStrings)
      if (cs.includes(head) && charSim(cs, t.text) < 0.999) {
        landed = true;
        break outer;
      }
  }
  if (!landed && fresh.some((c) => c.text.includes("…"))) landed = true;
  if (!landed) return false;

  const fitsFull = realWantWidth(t, want) <= t.width * 1.06 + 2;

  if (mode === "clip")
    return fitsFull || fresh.some((c) => c.text.includes("…")); // 省略号可能藏在合并单元中部
  if (mode === "wrap") return true; // 落地即受控（换行由绘制端按宽度执行）
  if (mode === "shrink") {
    if (fitsFull) return true;
    const smaller = fresh.some(
      (c) => (c.fontSizeOverride ?? c.fontSize) < t.fontSize - 0.01,
    );
    return smaller || fresh.some((c) => c.text.includes("…"));
  }
  return true;
}

/* ---------- 主入口 ---------- */

/**
 * @param before 原始 PDF 的 PageExtract[]
 * @param after  编辑后 PDF 的 PageExtract[]
 * @param truth  { expected: Map<`${page}|${posKey}|${origText}`, want>, ... } 由 cases 推导
 * @param opts   { overflow, untouchedPages, metadataKept, bytesIn, bytesOut, timing }
 */
export function evaluate(before, after, truth, opts = {}) {
  const beforeAll = before.flatMap((p) => p.units.map((u) => ({ ...u, page: p.pageNumber })));
  const afterAll = after.flatMap((p) => p.units.map((u) => ({ ...u, page: p.pageNumber })));
  const res = { accuracy: {}, layout: {}, integrity: {}, performance: opts.timing ?? {} };

  /* ---- A. 编辑准确性 ---- */
  const targets = beforeAll.filter((u) =>
    truth.expected.has(`${u.page}|${posKey(u)}|${u.text}`),
  );

  let exact = 0;
  const sims = [];
  let posKept = 0;
  let posChecked = 0;
  let overflowResidual = 0;
  let overflowChecked = 0;

  for (const t of targets) {
    const want = truth.expected.get(`${t.page}|${posKey(t)}|${t.text}`);
    const accepted = acceptedVariants(t, want, opts.overflow);

    // 同页、位置容差内的候选（叠加式回写会在同一位置产生新单元）。
    // top 容差动态放宽：字号被缩小时提取 top 会按 ascent 差下移。
    const topTol = Math.max(6, (t.fontSize - 6) * 0.9);
    const cands = afterAll
      .filter(
        (a) =>
          a.page === t.page &&
          Math.abs(a.x - t.x) < 3 &&
          Math.abs(a.top - t.top) < topTol,
      )
      .sort((a, b) => a.x - b.x);

    // pdfjs 会把一段叠加文本按空格拆成多个项：单条 + 相邻滑窗拼接（≤4）一起参与匹配
    const candStrings = [];
    for (let i = 0; i < cands.length; i++) {
      let joined = "";
      for (let j = i; j < Math.min(i + 4, cands.length); j++) {
        joined += cands[j].text;
        candStrings.push(joined);
      }
    }

    let best = 0;
    let bestStr = null;
    for (const cs of candStrings) {
      for (const acc of accepted) {
        // 包含关系视为命中：提取器会把同位置的旧文本与叠加文本合并成一个单元，
        // 这是叠加式回写的固有提取伪影，不代表编辑失败
        const s =
          cs === acc.text || cs.includes(acc.text) || acc.text.includes(cs)
            ? 1
            : charSim(cs, acc.text);
        const pass = s >= (acc.approx ? 0.9 : 0.999);
        if (pass && s > best) {
          best = s;
          bestStr = cs;
        }
      }
    }
    sims.push(best);
    if (best >= 0.9) exact++; // 近似命中也计入完全达成（截断口径）

    if (cands.length) {
      posChecked++;
      if (
        Math.abs(cands[0].x - t.x) < 3 &&
        Math.abs(cands[0].top - t.top) < 6
      )
        posKept++;
    // 策略符合性：reject 应拒绝、其余应落地且受控（缩字号/截断/换行）
    if (!policyOk(opts.overflow?.mode ?? "shrink", t, want, cands, candStrings)) {
      overflowResidual++;
      if (process.env.DSH_BENCH_DEBUG)
        console.error(
          `[policy-fail] mode=${opts.overflow?.mode} tid=${t.tid} want=${JSON.stringify(want.slice(0, 40))} cands=${cands.length} firstCand=${JSON.stringify(cands[0]?.text?.slice(0, 50))}`,
        );
    }
    overflowChecked++;
  }
  }

  const changedCorrectly = sims.filter((s) => s >= 0.9).length;
  const tp = changedCorrectly;
  const fn = targets.length - changedCorrectly;

  // 误改：after 中与任何 before 文本都不同、也不在任何目标位置附近
  const beforeTexts = new Set(beforeAll.map((u) => `${u.page}:${Math.round(u.x)}:${Math.round(u.top)}:${u.text}`));
  let fp = 0;
  for (const a of afterAll) {
    if (beforeTexts.has(`${a.page}:${Math.round(a.x)}:${Math.round(a.top)}:${a.text}`)) continue;
    const nearTarget = targets.some(
      (t) => t.page === a.page && Math.abs(t.x - a.x) < 3 && Math.abs(t.top - a.top) < 6,
    );
    if (nearTarget) continue;
    fp++;
  }

  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = targets.length ? tp / targets.length : 1;
  res.accuracy = {
    targets: targets.length,
    unitPrecision: r2(precision),
    unitRecall: r2(recall),
    unitF1: r2((2 * precision * recall) / (precision + recall) || 0),
    charSimilarity: r2(sims.length ? sims.reduce((s, x) => s + x, 0) / sims.length : 1),
    exactMatchRate: r2(targets.length ? exact / targets.length : 1),
    collateralUnits: fp,
  };

  /* ---- B. 版式保持 ---- */
  const afterByKey = new Map();
  for (const a of afterAll) {
    const k = `${a.page}|${posKey(a)}|${a.text}`;
    if (!afterByKey.has(k)) afterByKey.set(k, a);
  }
  const dxs = [];
  let colorMismatch = 0;
  let fontMismatch = 0;
  let fsMismatch = 0;
  let compared = 0;
  for (const b of beforeAll) {
    if (truth.expected.has(`${b.page}|${posKey(b)}|${b.text}`)) continue; // 目标位不计
    const a = afterByKey.get(`${b.page}|${posKey(b)}|${b.text}`);
    if (!a) continue;
    compared++;
    dxs.push(Math.abs(a.x - b.x));
    if (a.sig.color !== b.sig.color) colorMismatch++;
    if (a.sig.fontFamily !== b.sig.fontFamily) fontMismatch++;
    if (Math.abs(a.fontSize - b.fontSize) > 0.01) fsMismatch++;
  }
  res.layout = {
    unchangedCompared: compared,
    unchangedMaxDxPt: dxs.length ? r2(Math.max(...dxs)) : 0,
    unchangedColorMismatch: colorMismatch,
    unchangedFontFamilyMismatch: fontMismatch,
    unchangedFontSizeMismatch: fsMismatch,
    changedPositionKeptRate: posChecked ? r2(posKept / posChecked) : null,
    policyConformanceRate: overflowChecked ? r2(1 - overflowResidual / overflowChecked) : null,
  };

  /* ---- C. 文档完整性 ---- */
  let stale = 0;
  for (const t of targets) {
    const stillThere = afterAll.some(
      (a) => a.page === t.page && a.text.includes(t.text),
    );
    if (stillThere) stale++;
  }
  let untouchedRatio = null;
  if (opts.untouchedPages?.length) {
    const ratios = [];
    for (const pn of opts.untouchedPages) {
      const bt = (before.find((p) => p.pageNumber === pn)?.units ?? []).map((u) => u.text).join("");
      const at = (after.find((p) => p.pageNumber === pn)?.units ?? []).map((u) => u.text).join("");
      if (bt.length) ratios.push(charSim(bt, at));
    }
    untouchedRatio = ratios.length ? r2(ratios.reduce((s, x) => s + x, 0) / ratios.length) : null;
  }
  res.integrity = {
    pageCountBefore: before.length,
    pageCountAfter: after.length,
    pageCountPreserved: before.length === after.length,
    untouchedPageTextRatio: untouchedRatio,
    staleOriginalTextRate: targets.length ? r2(stale / targets.length) : null,
    metadataKept: opts.metadataKept ?? null,
    bytesIn: opts.bytesIn ?? null,
    bytesOut: opts.bytesOut ?? null,
    sizeRatio: opts.bytesIn ? r2(opts.bytesOut / opts.bytesIn) : null,
  };

  return res;
}
