import { describe, it, expect } from "vitest";
import {
  round1,
  hexToRgb,
  tokenizeText,
  wrapByMeasure,
  ellipsizeByMeasure,
  escapeHtml,
  chunk,
  range,
  median,
  pLimit,
  hash32,
  estimateTextWidthPt,
  normalizeGlossary,
  applyGlossary,
} from "../../src/util.js";

describe("util/round1", () => {
  it("四舍五入到 1 位小数", () => {
    expect(round1(1.234)).toBe(1.2);
    expect(round1(1.25)).toBe(1.3);
    expect(round1(-0.04)).toBe(-0);
  });
});

describe("util/hexToRgb", () => {
  it("解析 #rrggbb（含可省略的 #）", () => {
    expect(hexToRgb("#ff0000")).toEqual({ type: "RGB", red: 1, green: 0, blue: 0 });
    expect(hexToRgb("00ff00")).toEqual({ type: "RGB", red: 0, green: 1, blue: 0 });
  });
  it("非法输入回退为黑色", () => {
    const c = hexToRgb("not-a-color");
    expect(c.red).toBe(0);
    expect(c.green).toBe(0);
    expect(c.blue).toBe(0);
  });
});

describe("util/tokenizeText", () => {
  it("英文按词、CJK 按字切分", () => {
    expect(tokenizeText("hello 世界")).toEqual(["hello", " ", "世", "界"]);
  });
  it("空串返回空数组", () => {
    expect(tokenizeText("")).toEqual([]);
  });
});

describe("util/wrapByMeasure / ellipsizeByMeasure", () => {
  const m = (s: string) => s.length; // 1 char == 1pt 的确定性测量
  it("按宽度换行且不丢字", () => {
    const lines = wrapByMeasure("aa bb cc dd", m, 5);
    expect(lines).toEqual(["aa bb", "cc dd"]);
  });
  it("单 token 超宽时仍独占一行", () => {
    expect(wrapByMeasure("abcdef", m, 3)).toEqual(["abcdef"]);
  });
  it("ellipsize 截断并追加省略号，总宽不超限", () => {
    const out = ellipsizeByMeasure("abcdefghij", m, 6);
    expect(out.endsWith("…")).toBe(true);
    expect(m(out)).toBeLessThanOrEqual(6);
  });
  it("不超宽时原样返回", () => {
    expect(ellipsizeByMeasure("abc", m, 10)).toBe("abc");
  });
});

describe("util/escapeHtml", () => {
  it("转义五个危险字符", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("util/chunk / range / median", () => {
  it("chunk 均匀分片", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
  it("range 含首尾", () => {
    expect(range(1, 3)).toEqual([1, 2, 3]);
    expect(range(5, 5)).toEqual([5]);
  });
  it("median 奇偶长度均正确", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("util/pLimit", () => {
  it("并发数不超过上限且结果有序", async () => {
    let active = 0;
    let peak = 0;
    const limit = pLimit(3);
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const tasks = Array.from({ length: 9 }, (_, i) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
        return i;
      }),
    );
    const out = await Promise.all(tasks);
    expect(out).toEqual([...Array(9).keys()]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("util/hash32", () => {
  it("同输入同输出、不同输入不同输出", () => {
    const a = new TextEncoder().encode("pdf");
    const b = new TextEncoder().encode("pd f");
    expect(hash32(a)).toBe(hash32(a.slice()));
    expect(hash32(a)).not.toBe(hash32(b));
    expect(hash32(new Uint8Array(0))).toBe("811c9dc5"); // FNV-1a offset basis
  });
});

describe("util/estimateTextWidthPt", () => {
  it("CJK 宽度约为拉丁字符的两倍", () => {
    const zh = estimateTextWidthPt("中中", 10);
    const en = estimateTextWidthPt("aa", 10);
    expect(zh).toBeCloseTo(20, 1);
    expect(en).toBeLessThan(zh / 1.5);
  });
  it("与字号线性相关", () => {
    expect(estimateTextWidthPt("abc", 20)).toBeCloseTo(
      estimateTextWidthPt("abc", 10) * 2,
      5,
    );
  });
});

describe("util/normalizeGlossary / applyGlossary", () => {
  it("对象形式转为数组并按 from 长度降序", () => {
    const terms = normalizeGlossary({ ab: "X", a: "Y" });
    expect(terms.map((t) => t.from)).toEqual(["ab", "a"]);
  });
  it("过滤空项与恒等项", () => {
    expect(normalizeGlossary([{ from: "", to: "x" }, { from: "a", to: "a" }, { from: "b", to: "c" }]))
      .toEqual([{ from: "b", to: "c" }]);
  });
  it("undefined 返回空数组", () => {
    expect(normalizeGlossary(undefined)).toEqual([]);
  });
  it("applyGlossary 长词优先，避免短词破坏长词", () => {
    const terms = normalizeGlossary({ 数据: "DATA", 数据中台: "PLATFORM" });
    expect(applyGlossary("数据中台与数据", terms)).toBe("PLATFORM与DATA");
  });
});
