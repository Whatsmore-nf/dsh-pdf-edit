import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apply,
  activate,
  deactivate,
  setChatFn,
  name as pluginName,
  inject,
} from "../../src/index.js";
import { scriptedChat } from "../helpers/chat-mock.js";
import type { PageExtract } from "../../src/types.js";

/* dsh-tools 的 defineTool 返回结构（只取测试关心的字段） */
interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: { schema: unknown; render: (args: unknown, value: unknown) => unknown[] };
  execute: (args: any) => Promise<unknown>;
}

function makeFakeCtx() {
  const registered = new Map<string, RegisteredTool>();
  // 模拟健康宿主：ctx.tools 挂载 dsh-tools 调度器 Symbol（非全局注册表 Symbol）
  const sched = Symbol("@deepseek-ai/dsh-tools.scheduler");
  const ctx = {
    tools: Object.assign(
      {
        register(def: RegisteredTool) {
          registered.set(def.name, def);
          return () => registered.delete(def.name);
        },
      },
      { [sched]: { prepare() {}, dispatch() {}, finalize() {}, finish() {} } },
    ),
  };
  return { ctx, registered };
}

describe("dsh 插件契约（dsh 0.1.1-rc.2）", () => {
  let root: string;
  let pdfPath: string;
  const captured: Array<{ role: string; content: string }> = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "dsh-plugin-"));
    pdfPath = join(root, "doc.pdf");

    // 用项目夹具生成一份真实 PDF（en-basic：含 99.95 percent）
    const { fixture, FIXTURE_NAMES } = await import("../helpers/make-pdf.js");
    writeFileSync(pdfPath, await fixture(FIXTURE_NAMES.enBasic));

    // 注册工具（allowedRoots 锁到临时目录）
    setChatFn(scriptedChat(
      [{ match: "99.95 percent", to: (t) => t.replace("99.95", "99.99") }],
      { calls: captured },
    ));
    const { ctx } = makeFakeCtx();
    await apply(ctx as any, { allowedRoots: [root] });
  }, 60_000);

  afterAll(() => {
    deactivate();
    rmSync(root, { recursive: true, force: true });
  });

  it("导出契约：name/inject 与官方工具插件一致", async () => {
    expect(pluginName).toBe("dsh-pdf-edit");
    expect(inject).toContain("tools");
  });

  it("apply 向 ctx.tools 注册 4 个工具，均带 output.schema/render", async () => {
    const { ctx, registered } = makeFakeCtx();
    await apply(ctx as any);
    for (const n of [
      "pdf-edit-preview",
      "pdf-edit-page",
      "pdf-edit-document",
      "pdf-edit-relayout",
    ]) {
      const t = registered.get(n);
      expect(t, `${n} 未注册`).toBeTruthy();
      expect(t!.output.render).toBeTypeOf("function");
      expect(t!.parameters).toBeTypeOf("object");
    }
  });

  it("pdf-edit-preview：返回 tid/text 单元与页数", async () => {
    const tool = await getTool("pdf-edit-preview");
    const value = (await tool.execute({
      pdfPath,
      pageNumber: 1,
    })) as { units: Array<{ tid: string; text: string }>; pageCount: number };

    expect(value.pageCount).toBe(1);
    expect(value.units.some((u) => u.text.includes("Quarterly Operations Review"))).toBe(true);
    expect(value.units.every((u) => /^p1-\d+$/.test(u.tid))).toBe(true);

    // render 输出 content block
    const blocks = tool.output.render({}, value) as Array<{ type: string; text: string }>;
    expect(blocks[0].type).toBe("text");
    expect(JSON.parse(blocks[0].text)).toEqual(value);
  });

  it("pdf-edit-page：编辑落盘并返回 outputPath/changed", async () => {
    const tool = await getTool("pdf-edit-page");
    const outAbs = join(root, "doc.edited.pdf");
    const value = (await tool.execute({
      pdfPath,
      pageNumber: 1,
      instruction: "更新可用率数字",
      outputPath: outAbs,
    })) as { outputPath: string; changed: boolean };

    expect(value.changed).toBe(true);
    expect(existsSync(outAbs)).toBe(true);
    // AI 确实被调用且收到 data 容器化的条目
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0][0].role).toBe("system");
    expect(captured[0][1].content).toContain("```data");
  });

  it("路径越界被守卫拦截（安全审查 #1）", async () => {
    const preview = await getTool("pdf-edit-preview");
    await expect(
      preview.execute({ pdfPath: "/etc/passwd", pageNumber: 1 }),
    ).rejects.toThrow(/不在允许的目录范围/);
  });

  async function getTool(n: string): Promise<RegisteredTool> {
    const { ctx, registered } = makeFakeCtx();
    await apply(ctx as any, { allowedRoots: [root] });
    const t = registered.get(n);
    if (!t) throw new Error(`工具未注册: ${n}`);
    return t;
  }
});
