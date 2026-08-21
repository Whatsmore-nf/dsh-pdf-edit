import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { replacePages, replaceEntireDocument } from "../../src/pdf-ops.js";

const build = async (
  pages: string[],
  meta?: { title?: string; author?: string },
): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  for (const t of pages) {
    const p = doc.addPage([300, 200]);
    p.drawText(t, { x: 20, y: 100, size: 14 });
  }
  if (meta?.title) doc.setTitle(meta.title);
  if (meta?.author) doc.setAuthor(meta.author);
  return doc.save();
};

describe("pdf-ops/replacePages", () => {
  it("空替换表返回原字节副本", async () => {
    const src = await build(["A"]);
    const out = await replacePages(src, new Map());
    expect(out).not.toBe(src); // 副本
    expect(out).toEqual(src);
  });

  it("混合替换：单页/跨段替换并存，其余页原样且顺序不变，元数据保留", async () => {
    const src = await build(["A", "B", "C", "D", "E"], { title: "T" });
    const single = async (label: string) => {
      const d = await PDFDocument.create();
      d.addPage([300, 200]).drawText(label, { x: 10, y: 50, size: 12 });
      return d.save();
    };

    const outBytes = await replacePages(
      src,
      new Map([
        [1, await single("NEW-1")],
        [3, await single("NEW-3")],
        [5, await single("NEW-5")],
      ]),
    );
    const out = await PDFDocument.load(outBytes);
    expect(out.getPageCount()).toBe(5);
    expect(out.getTitle()).toBe("T");

    const t = [];
    for (let i = 0; i < 5; i++) t.push(await extractText(outBytes, i));
    expect(t.join("|")).toBe("NEW-1|B|NEW-3|D|NEW-5");
  });
});

describe("pdf-ops/replaceEntireDocument", () => {
  it("以新文档为正文、旧文档提供元数据", async () => {
    const oldDoc = await build(["legacy"], { title: "旧标题", author: "原作者" });
    const newDoc = await build(["brand new body"]);

    const out = await PDFDocument.load(
      await replaceEntireDocument(newDoc, oldDoc),
    );
    expect(out.getTitle()).toBe("旧标题");
    expect(out.getAuthor()).toBe("原作者");
    expect(out.getPageCount()).toBe(1);
  });
});

/* 简易文本提取（pdfjs），供断言使用 */
async function extractText(bytes: Uint8Array, pageIdx: number): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const page = await doc.getPage(pageIdx + 1);
  const tc = await page.getTextContent();
  return tc.items.map((it: any) => it.str).join("");
}
