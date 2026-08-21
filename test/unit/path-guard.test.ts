import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateInputPath,
  validateOutputPath,
} from "../../src/path-guard.js";

describe("path-guard（安全审查 #1：任意文件读写）", () => {
  let root: string;
  let pdfPath: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "path-guard-"));
    mkdirSync(join(root, "sub"));
    pdfPath = join(root, "sample.pdf");
    writeFileSync(pdfPath, "%PDF-1.4 fake");
    writeFileSync(join(root, "note.txt"), "hello");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const opts = () => ({ allowedRoots: [root] });

  /* ---------------- validateInputPath ---------------- */

  it("白名单内的合法路径：返回规范化绝对路径", () => {
    const out = validateInputPath(join(root, "sample.pdf"), opts());
    expect(resolve(out)).toBe(resolve(pdfPath));
  });

  it("空路径 / 非字符串拒绝", () => {
    expect(() => validateInputPath("", opts())).toThrow(/不能为空/);
    // @ts-ignore 故意传错类型
    expect(() => validateInputPath(42 as any, opts())).toThrow(/不能为空/);
  });

  it("控制字符 / null byte 拒绝", () => {
    expect(() =>
      validateInputPath(`${root}/a\u0000.pdf`, opts()),
    ).toThrow(/非法控制字符/);
  });

  it("越出白名单根目录拒绝（含 ../ 逃逸）", () => {
    expect(() => validateInputPath("/etc/passwd", opts())).toThrow(/不在允许的目录范围/);
    expect(() =>
      validateInputPath(join(root, "..", "escape.pdf"), opts()),
    ).toThrow(/不在允许的目录范围/);
  });

  it("未配置 allowedRoots 时全部禁用", () => {
    expect(() => validateInputPath(pdfPath, {})).toThrow(/禁止所有文件读取/);
    expect(() => validateInputPath(pdfPath, { allowedRoots: [] })).toThrow(
      /禁止所有文件读取/,
    );
  });

  it("扩展名白名单拒绝", () => {
    expect(() => validateInputPath(join(root, "note.txt"), opts())).toThrow(
      /不支持的文件类型/,
    );
  });

  it("文件不存在拒绝", () => {
    expect(() => validateInputPath(join(root, "ghost.pdf"), opts())).toThrow(
      /不存在或不可访问/,
    );
  });

  it("目录（非普通文件）拒绝；超过大小上限拒绝", () => {
    expect(() => validateInputPath(join(root, "sub"), opts())).toThrow(
      /不是普通文件/,
    );
    expect(() =>
      validateInputPath(pdfPath, { ...opts(), maxFileSize: 4 }),
    ).toThrow(/超过大小限制/);
  });

  /* ---------------- validateOutputPath ---------------- */

  it("未提供 outputPath 时由输入派生 .edited.pdf", () => {
    const out = validateOutputPath(undefined, pdfPath, opts());
    expect(out).toBe(resolve(join(root, "sample.edited.pdf")));
  });

  it("显式 outputPath 在白名单内允许", () => {
    const out = validateOutputPath(
      join(root, "sub", "out.pdf"),
      pdfPath,
      opts(),
    );
    expect(out).toBe(resolve(join(root, "sub", "out.pdf")));
  });

  it("输出到系统目录 / 白名单外拒绝", () => {
    expect(() =>
      validateOutputPath("/etc/cron.d/evil.pdf", pdfPath, opts()),
    ).toThrow(/不在输入同目录或允许的目录范围/);
    expect(() =>
      validateOutputPath(join(root, "..", "evil.pdf"), pdfPath, opts()),
    ).toThrow(/不在输入同目录或允许的目录范围/);
  });

  it("输出扩展名必须为 .pdf", () => {
    expect(() =>
      validateOutputPath(join(root, "out.txt"), pdfPath, opts()),
    ).toThrow(/不支持的文件类型/);
  });

  it("输出路径含控制字符拒绝；父目录不可写拒绝", () => {
    expect(() =>
      validateOutputPath(`${root}/x\u0001.pdf`, pdfPath, opts()),
    ).toThrow(/非法控制字符/);

    const readonlyDir = join(root, "readonly");
    mkdirSync(readonlyDir, { mode: 0o555 });
    try {
      expect(() =>
        validateOutputPath(join(readonlyDir, "out.pdf"), pdfPath, opts()),
      ).toThrow(/不存在或不可写/);
    } finally {
      rmSync(readonlyDir, { recursive: true, force: true });
    }
  });

  it("relayout 默认后缀可自定义（.relayout.pdf）", () => {
    const out = validateOutputPath(undefined, pdfPath, opts(), ".relayout.pdf");
    expect(out).toBe(resolve(join(root, "sample.relayout.pdf")));
  });
});
