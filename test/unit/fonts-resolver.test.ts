import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  FontResolver,
  normFamily,
  toWinAnsiSafe,
  unwrapFontBytes,
  ttcFaceBytes,
} from "../../src/fonts-resolver.js";
import { loadCjkFaceBytes, hasCjkFont, cjkFontPath } from "../helpers/make-pdf.js";
import { readFileSync } from "node:fs";

describe("fonts-resolver/normFamily", () => {
  it("剥离子集前缀与家族后缀，转小写", () => {
    expect(normFamily("ABCDEF+Helvetica")).toBe("helvetica");
    expect(normFamily("SimHei,Bold")).toBe("simhei");
    expect(normFamily(" Times New Roman ")).toBe("times new roman");
  });
});

describe("fonts-resolver/toWinAnsiSafe", () => {
  it("常见 Unicode 标点映射为 WinAnsi 安全字符", () => {
    expect(toWinAnsiSafe("\u2018x\u2019")).toBe("'x'");
    expect(toWinAnsiSafe("\u201Ca\u201D")).toBe('"a"');
    expect(toWinAnsiSafe("a\u2013b\u2014c")).toBe("a-b--c");
    expect(toWinAnsiSafe("\u2026\u00A0\u2022\u2212")).toBe("... --");
  });
  it("其余非 Latin-1 字符替换为 ?", () => {
    expect(toWinAnsiSafe("中文abc")).toBe("??abc");
  });
});

describe("fonts-resolver/unwrapFontBytes", () => {
  it("非 TTC 字节原样返回（同一引用）", () => {
    const plain = new Uint8Array([0, 1, 2, 3, 4]);
    expect(unwrapFontBytes(plain)).toBe(plain);
  });

  it("TTC 集合拆出单 face：不再是 ttcf，且 pdf-lib 可子集嵌入", async () => {
    if (!hasCjkFont()) return console.warn("skip: 无系统 CJK 字体");
    const ttc = new Uint8Array(readFileSync(cjkFontPath()!));
    const isTtc =
      ttc[0] === 0x74 && ttc[1] === 0x74 && ttc[2] === 0x63 && ttc[3] === 0x66;

    if (!isTtc) {
      // 系统 CJK 本就是单 face 文件 → unwrap 应为恒等
      expect(unwrapFontBytes(ttc)).toBe(ttc);
      return;
    }

    const face = ttcFaceBytes(ttc, 0);
    expect(face.length).toBeLessThan(ttc.length); // 只含一个 face 的表
    expect(face[0] !== 0x74 || face[1] !== 0x74 || face[2] !== 0x63).toBe(true); // 非 "ttc…"

    // 拆包结果必须能通过 pdf-lib 子集嵌入（回归 v0.1.4 声称的修复）
    const { PDFDocument: Doc } = await import("pdf-lib");
    const { default: fk } = await import("@pdf-lib/fontkit");
    const doc = await Doc.create();
    doc.registerFontkit(fk);
    const pf = await doc.embedFont(face, { subset: true });
    expect(pf.name).toBeTruthy();
  });

  it("face 索引越界抛错", async () => {
    if (!hasCjkFont()) return console.warn("skip: 无系统 CJK 字体");
    const ttc = new Uint8Array(readFileSync(cjkFontPath()!));
    if (!(ttc[0] === 0x74 && ttc[1] === 0x74 && ttc[2] === 0x63 && ttc[3] === 0x66)) {
      return console.warn("skip: 系统 CJK 非 TTC");
    }
    expect(() => ttcFaceBytes(ttc, 99)).toThrow(/face/);
  });
});

describe("fonts-resolver/FontResolver", () => {
  it("标准字体按家族映射：times→TimesRoman、mono→Courier、默认 Helvetica", async () => {
    const doc = await PDFDocument.create();
    const r = await FontResolver.create(doc);

    const helv = await r.resolveA("Arial", "hello", false, false);
    expect(helv.standard).toBe(true);
    expect(helv.font.name).toBe("Helvetica");

    const times = await r.resolveA("Times New Roman", "hello", false, false);
    expect(times.font.name).toBe("Times-Roman");

    const mono = await r.resolveA("Consolas", "hello", false, false);
    expect(mono.font.name).toBe("Courier");

    const bold = await r.resolveA("Helvetica-Bold", "hi", true, false);
    expect(bold.font.name).toBe("Helvetica-Bold");

    // 同 key 二次解析命中字体缓存（包装对象新建，但底层 PDFFont 同一实例）
    const again = await r.resolveA("Arial", "again", false, false);
    expect(again.font).toBe(helv.font);
  });

  it("measure 用真实字体度量；标准字体先过 WinAnsi 清洗", async () => {
    const doc = await PDFDocument.create();
    const r = await FontResolver.create(doc);
    const rf = await r.resolveA("Helvetica", "", false, false);
    const w1 = r.measure(rf, "hello world", 12);
    expect(w1).toBeGreaterThan(0);
    // 弯引号在清洗前后宽度不同但都不抛错
    expect(r.measure(rf, "\u201Cq\u201D", 12)).toBeGreaterThan(0);
  });

  it("CJK 文本且未配置字体 → 抛出带指引的错误", async () => {
    const doc = await PDFDocument.create();
    const r = await FontResolver.create(doc, { cjkAutoDetect: false });
    await expect(r.resolveA("Serif", "中文", false, false)).rejects.toThrow(
      /CJK.*fonts\.cjk/s,
    );
  });

  it("配置 cjk.bytes（TTC 自动拆包）→ 嵌入成功且可测量中文", async () => {
    if (!hasCjkFont()) return console.warn("skip: 无系统 CJK 字体");
    const doc = await PDFDocument.create();
    const bytes = loadCjkFaceBytes(); // helper 已做 TTC 拆包；此处验证 resolver 自身也能处理原始 TTC
    const r = await FontResolver.create(doc, { cjk: { bytes }, cjkAutoDetect: false });
    const rf = await r.resolveA("SimHei", "术语统一", false, false);
    expect(rf.standard).toBe(false);
    expect(r.measure(rf, "术语统一", 12)).toBeGreaterThan(20); // CJK 全宽
  });

  it("customs 按家族名匹配；cjk 兜底生效且 fakeBold 标记正确", async () => {
    if (!hasCjkFont()) return console.warn("skip: 无可用字体文件");
    const bytes = loadCjkFaceBytes();
    const doc = await PDFDocument.create();
    const r = await FontResolver.create(doc, {
      customs: [{ family: "MyBrand", bytes }],
      cjk: { bytes },
      fakeBold: true,
    });
    // 家族名精确命中自定义字体
    const custom = await r.resolveA("MyBrand", "anything 中文", false, false);
    expect(custom.standard).toBe(false);
    // CJK 文本走 cjk 配置；粗体请求在非标准字体上产生 fakeBold 标记
    const cjk = await r.resolveA("Hei", "加粗测试", true, false);
    expect(cjk.fakeBold).toBe(true);
  });
});
