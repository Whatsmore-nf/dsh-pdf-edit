import { describe, it, expect } from "vitest";
import {
  sanitizeText,
  reconcilePatches,
  applyPatches,
  validateEditedHtml,
} from "../../src/validator.js";
import { estimateTextWidthPt } from "../../src/util.js";
import type { PageExtract, Unit } from "../../src/types.js";

const mkUnit = (over: Partial<Unit> & { tid: string; text: string }): Unit => ({
  x: 10,
  top: 100,
  width: estimateTextWidthPt(over.text, 12) + 2,
  fontSize: 12,
  className: "s1",
  sig: { fontFamily: "Helvetica", fontSizePt: 12, color: "#0a0a0a", bold: false, italic: false },
  baselineTop: 110,
  ...over,
});

const mkPage = (units: Unit[]): PageExtract => ({
  pageNumber: 1,
  widthPt: 595,
  heightPt: 842,
  css: "",
  html: "",
  units,
});

/* ------------------------------------------------------------------ */

describe("validator/sanitizeText", () => {
  it("剥离 HTML 标签与控制字符", () => {
    const r = sanitizeText("a<b>i</b>", "he<b>llo</b>\u0007world\u001f");
    expect(r).toEqual({ ok: true, text: "helloworld" });
  });
  it("拒绝非字符串 / 空文本 / 纯标签文本", () => {
    expect(sanitizeText("orig", 42).ok).toBe(false);
    expect(sanitizeText("orig", "").ok).toBe(false);
    const r = sanitizeText("orig", "<div></div>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("空");
  });
  it("拒绝超过 3 倍原长 + 16 的膨胀（防跑飞）", () => {
    // "ab" 长度 2 → 上限 2*3+16 = 22
    expect(sanitizeText("ab", "x".repeat(22)).ok).toBe(true);
    const r = sanitizeText("ab", "x".repeat(23));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("膨胀");
  });
  it("恰好等于阈值时放行", () => {
    expect(sanitizeText("ab", "x".repeat(22)).ok).toBe(true);
  });
});

describe("validator/reconcilePatches", () => {
  const input = [
    { tid: "a", text: "A" },
    { tid: "b", text: "B" },
  ];

  it("未知 tid 默认丢弃，缺失 tid 用原文补回", () => {
    const out = reconcilePatches(input, new Map([["a", "A2"], ["zz", "X"]]));
    expect([...out.entries()].sort()).toEqual([["a", "A2"], ["b", "B"]]);
  });
  it("strict 模式：未知 tid 抛错", () => {
    expect(() =>
      reconcilePatches(input, new Map([["zz", "X"]]), { strict: true }),
    ).toThrow(/越权/);
  });
  it("strict 模式：缺失 tid 抛错", () => {
    expect(() =>
      reconcilePatches(input, new Map([["a", "A2"]]), { strict: true }),
    ).toThrow(/缺少 tid/);
  });
  it("missingTidsUseOriginal=false 时缺失项直接缺席", () => {
    const out = reconcilePatches(
      input,
      new Map([["a", "A2"]]),
      { missingTidsUseOriginal: false },
    );
    expect(out.has("b")).toBe(false);
  });
});

describe("validator/applyPatches — 溢出策略", () => {
  const unit = mkUnit({ tid: "u1", text: "short" });

  it("相同文本不计入改动", async () => {
    const page = mkPage([mkUnit({ tid: "u1", text: "same" })]);
    const report = await applyPatches(page, new Map([["u1", "same"]]));
    expect(report.changed).toBe(0);
    expect(report.changedTids).toEqual([]);
  });

  it("shrink：轻微超宽 → 缩放字号（保留 1 位小数）", async () => {
    // 原文宽 ~5*12*0.52≈31pt，替换为双倍长度文本
    const u = mkUnit({ tid: "u1", text: "short" });
    const report = await applyPatches(
      mkPage([u]),
      new Map([["u1", "much longer text here"]]),
      {}, // 无 measure → estimate 回退
    );
    expect(report.changed).toBe(1);
    expect(u.fontSizeOverride).toBeDefined();
    expect(u.fontSizeOverride!).toBeLessThan(u.fontSize);
    expect(u.fontSizeOverride!).toBeGreaterThanOrEqual(6); // minFontSizePt 默认 6
  });

  it("shrink：缩放后低于最小字号 → 钳到最小值并启用截断", async () => {
    // 原文 "tiny" 长度 4 → sanitize 上限 28 字符；12 个 x 足以触发深度缩放
    const u = mkUnit({ tid: "u1", text: "tiny", width: 20 });
    await applyPatches(mkPage([u]), new Map([["u1", "x".repeat(12)]]), {
      overflow: { mode: "shrink", minFontSizePt: 6 },
    });
    expect(u.fontSizeOverride).toBe(6);
    expect(u.clip).toBe(true);
  });

  it("clip 策略：标记 clip 而不改字号", async () => {
    const u = mkUnit({ tid: "u1", text: "tiny", width: 20 });
    await applyPatches(mkPage([u]), new Map([["u1", "x".repeat(24)]]), {
      overflow: { mode: "clip" },
      measure: (t) => t.length * 12 * 0.6,
    });
    expect(u.clip).toBe(true);
    expect(u.fontSizeOverride).toBeUndefined();
  });

  it("wrap 策略：标记 wrap", async () => {
    const u = mkUnit({ tid: "u1", text: "tiny", width: 20 });
    await applyPatches(mkPage([u]), new Map([["u1", "x".repeat(24)]]), {
      overflow: { mode: "wrap" },
      measure: (t) => t.length * 12 * 0.6,
    });
    expect(u.wrap).toBe(true);
  });

  it("reject 策略：超宽条目被拒且原文保持不变", async () => {
    const original = "tiny";
    const u = mkUnit({ tid: "u1", text: original, width: 20 });
    // 24 字符：通过 sanitize（上限 28），但在溢出判定中超宽
    const report = await applyPatches(mkPage([u]), new Map([["u1", "x".repeat(24)]]), {
      overflow: { mode: "reject" },
      measure: (t) => t.length * 12 * 0.6,
    });
    expect(report.changed).toBe(0);
    expect(report.rejected[0].reason).toContain("溢出");
    expect(u.text).toBe(original);
  });

  it("sanitize 失败的条目进入 rejected", async () => {
    const u = mkUnit({ tid: "u1", text: "keep" });
    const report = await applyPatches(mkPage([u]), new Map([["u1", ""]]));
    expect(report.changed).toBe(0);
    expect(report.rejected[0].reason).toBeTruthy();
  });

  it("未知 tid：默认忽略；strictUnknown 时记录 rejected", async () => {
    const p1 = await applyPatches(mkPage([]), new Map([["ghost", "x"]]));
    expect(p1.rejected).toHaveLength(0);

    const p2 = await applyPatches(mkPage([]), new Map([["ghost", "x"]]), {
      strictUnknown: true,
    });
    expect(p2.rejected[0].reason).toContain("越权");
  });

  it("自定义 measure 参与溢出判定", async () => {
    const u = mkUnit({ tid: "u1", text: "abc", width: 50 });
    let measured = "";
    await applyPatches(mkPage([u]), new Map([["u1", "abcdef"]]), {
      measure: (t) => {
        measured = t;
        return 10;
      },
    });
    expect(measured).toBe("abcdef");
    expect(u.fontSizeOverride).toBeUndefined(); // 未溢出
  });
});

describe("validator/validateEditedHtml", () => {
  it("结构一致（仅文字不同）→ ok", () => {
    const a = `<div><span data-tid="p1-0">旧文本</span></div>`;
    const b = `<div><span data-tid="p1-0">新文本</span></div>`;
    expect(validateEditedHtml(a, b).ok).toBe(true);
  });
  it("标签数量变化 → 不 ok 并给出差异", () => {
    const a = `<div><span>x</span></div>`;
    const b = `<div><span>x</span><span>y</span></div>`;
    const r = validateEditedHtml(a, b);
    expect(r.ok).toBe(false);
    expect(r.diff).toContain("数量");
  });
  it("属性被篡改 → 不 ok", () => {
    const a = `<span class="s1">x</span>`;
    const b = `<span class="s9">x</span>`;
    const r = validateEditedHtml(a, b);
    expect(r.ok).toBe(false);
    expect(r.diff).toContain("属性");
  });
});
