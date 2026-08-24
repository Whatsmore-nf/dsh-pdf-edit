import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import facet, {
  stdToolNames,
  stdToolDefinitions,
  TOOL_REFERENCE,
  envConfig,
  type StdExecutableToolDefinition,
} from "../../src/std/host.js";
import { deactivate as resetConfig, setChatFn, isActive } from "../../src/index.js";
import { scriptedChat } from "../helpers/chat-mock.js";

/* ------------------------------------------------------------------ */
/* 模拟 dsh-std 宿主的 ActivationContext（只实现 publish/scope 子集）    */
/* ------------------------------------------------------------------ */

interface Published {
  reference: { apiVersion: string; kind: string };
  handler: { resolve(): unknown | undefined };
}

function makeFakeStdCtx() {
  const published = new Map<string, Published>();
  const ctx = {
    scope: {
      signal: new AbortController().signal,
      add(_dispose: () => void | Promise<void>) {
        return () => undefined;
      },
    },
    extensions: {
      publish(
        reference: { apiVersion: string; kind: string },
        name: string,
        handler: Published["handler"],
      ) {
        published.set(name, { reference, handler });
        return () => void published.delete(name);
      },
    },
  };
  return { ctx, published };
}

const MANIFEST_PATH = join(import.meta.dirname, "..", "..", "dsh-plugin.json");

describe("dsh-std Community v0.15 适配（dsh-plugin.json + FacetModule）", () => {
  it("manifest：结构、身份与入口符合 Community v0.15", () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
    const id = manifest.id as string;
    const facets = manifest.facets as Record<string, Record<string, unknown>>;
    const requires = manifest.requires as Record<string, unknown>;

    expect(manifest.manifestVersion).toBe("0.15");
    expect(manifest.version).toBe("0.4.0");
    expect(typeof manifest.$schema).toBe("string");
    expect(() => new URL(manifest.$schema as string)).not.toThrow(); // $schema 必须是绝对 URI
    expect(id).toMatch(/^[a-z][a-z0-9]*(?:[.-][a-z0-9][a-z0-9-]*)+$/);
    expect(facets.host?.apiVersion).toBe("v1alpha1");
    // 入口必须包内相对且指向编译产物
    expect(facets.host?.entry).toBe("dist/std/host.js");
    expect(facets.host?.entry).not.toMatch(/^[\\/]/);
    // 声明完整性：requires / permissions / subscriptions / contributes 显式声明
    expect(Array.isArray(requires.contracts)).toBe(true);
    expect(Array.isArray(manifest.permissions)).toBe(true);
    expect(Array.isArray(manifest.subscriptions)).toBe(true);
    expect(manifest.license).toBe("MIT");
    expect(typeof (manifest.source as Record<string, unknown>).repository).toBe("string");
    // v0.15 禁止 provides 与非空 requires.services
    expect(manifest.provides).toBeUndefined();
    expect(requires.services ?? []).toEqual([]);
  });

  it("manifest x-tools 与 std 工具目录一一对应", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Record<string, any>;
    const contributions = manifest.contributes["x-tools"] as Array<Record<string, any>>;
    expect(contributions).toHaveLength(5);
    for (const c of contributions) {
      expect(c.apiVersion).toBe(TOOL_REFERENCE.apiVersion);
      expect(c.kind).toBe(TOOL_REFERENCE.kind);
      expect(typeof c.id).toBe("string");
      expect(typeof c.spec?.title).toBe("string");
      expect(typeof c.spec?.description).toBe("string");
    }
    expect(contributions.map((c) => c.name)).toEqual([...stdToolNames()]);
  });

  it("facet：default 导出具备 activate/deactivate/snapshot", () => {
    expect(typeof facet.activate).toBe("function");
    expect(typeof facet.deactivate).toBe("function");
    expect(typeof facet.snapshot).toBe("function");
    const snap = facet.snapshot!();
    expect(snap.state).toBe("active");
    expect(snap.extensions).toHaveLength(5);
    expect(
      snap.extensions!.every(
        (e) =>
          e.apiVersion === TOOL_REFERENCE.apiVersion &&
          (e.status as { state: string }).state === "available",
      ),
    ).toBe(true);
  });

  it("activate 向宿主发布 5 个 Tool handler，名称与 resolve() 定义一致", async () => {
    const { ctx, published } = makeFakeStdCtx();
    await facet.activate(ctx as never);

    expect(published.size).toBe(5);
    for (const name of stdToolNames()) {
      const row = published.get(name);
      expect(row, `${name} 未发布`).toBeTruthy();
      expect(row!.reference.apiVersion).toBe(TOOL_REFERENCE.apiVersion);
      expect(row!.reference.kind).toBe(TOOL_REFERENCE.kind);
      const definition = row!.handler.resolve() as Record<string, unknown>;
      // @dsh-std/tool：definition.name 必须等于扩展 metadata.name
      expect(definition.name).toBe(name);
      expect(typeof definition.description).toBe("string");
      expect((definition.parameters as Record<string, unknown>).type).toBe("object");
      expect((definition.output as Record<string, unknown>).type).toBe("object");
      expect(typeof definition.execute).toBe("function");
    }
  });
});

describe("dsh-std 工具执行（经 ExecutableToolDefinition.execute）", () => {
  let root: string;
  let pdfPath: string;
  let previewDef: StdExecutableToolDefinition;
  let pageDef: StdExecutableToolDefinition;
  let insertDef: StdExecutableToolDefinition;
  const captured: Array<Array<{ role: string; content: string }>> = [];
  const prevAllowedRoots = process.env.DSH_PDF_EDIT_ALLOWED_ROOTS;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "dsh-std-pdf-edit-run-"));
    pdfPath = join(root, "doc.pdf");

    const { fixture, FIXTURE_NAMES } = await import("../helpers/make-pdf.js");
    writeFileSync(pdfPath, await fixture(FIXTURE_NAMES.enBasic));

    // 通过环境变量注入白名单（std 宿主无 cordis config 注入），再激活 facet
    process.env.DSH_PDF_EDIT_ALLOWED_ROOTS = root;
    expect(envConfig().allowedRoots).toEqual([root]);

    const { ctx } = makeFakeStdCtx();
    await facet.activate(ctx as never);

    // AI mock：把 99.95 改成 99.99（与 cordis 入口的集成测试同款场景）
    setChatFn(scriptedChat(
      [{ match: "99.95 percent", to: (t) => t.replace("99.95", "99.99") }],
      { calls: captured },
    ));

    const definitions = await stdToolDefinitions();
    previewDef = definitions.get("pdf-edit-preview")!;
    pageDef = definitions.get("pdf-edit-page")!;
    insertDef = definitions.get("pdf-edit-insert")!;
  }, 60_000);

  afterAll(() => {
    if (prevAllowedRoots === undefined) delete process.env.DSH_PDF_EDIT_ALLOWED_ROOTS;
    else process.env.DSH_PDF_EDIT_ALLOWED_ROOTS = prevAllowedRoots;
    resetConfig();
    rmSync(root, { recursive: true, force: true });
  });

  it("preview：data 与 model-facing content 一致", async () => {
    const result = await previewDef.execute({ pdfPath, pageNumber: 1 }, {} as never);
    const value = result.data as {
      units: Array<{ tid: string; text: string }>;
      pageCount: number;
    };

    expect(value.pageCount).toBe(1);
    expect(value.units.some((u) => u.text.includes("Quarterly Operations Review"))).toBe(true);

    const block = result.content[0]!;
    expect(block.type).toBe("text");
    expect(JSON.parse(block.text)).toEqual(value);
  });

  it("page：AI 编辑落盘并返回 outputPath/changed", async () => {
    const outAbs = join(root, "doc.edited.pdf");
    const result = await pageDef.execute(
      { pdfPath, pageNumber: 1, instruction: "更新可用率数字", outputPath: outAbs },
      {} as never,
    );
    const value = result.data as { outputPath: string; changed: boolean };

    expect(value.changed).toBe(true);
    expect(existsSync(outAbs)).toBe(true);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]![0]!.role).toBe("system");
    expect(captured[0]![1]!.content).toContain("```data");
  });

  it("insert：无需 LLM 即可插入内容页", async () => {
    const outAbs = join(root, "doc.inserted.pdf");
    const result = await insertDef.execute(
      {
        pdfPath,
        insertions: [{ afterPage: 1, title: "附录：补充说明", markdown: "# 补充\n- 要点一" }],
        outputPath: outAbs,
      },
      {} as never,
    );
    const value = result.data as {
      outputPath: string;
      insertedPages: number;
      totalPages: number;
    };

    expect(value.insertedPages).toBe(1);
    expect(value.totalPages).toBe(2);
    expect(existsSync(outAbs)).toBe(true);
  });

  it("路径越界仍被守卫拦截（安全护栏在 std 宿主下不放松）", async () => {
    await expect(
      previewDef.execute({ pdfPath: "/etc/passwd", pageNumber: 1 }, {} as never),
    ).rejects.toThrow(/不在允许的目录范围/);
  });

  it("deactivate 复位注入的 chatFn；重新激活可恢复（重复 activation 场景）", async () => {
    const prevKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      expect(isActive()).toBe(true); // setChatFn 已注入
      facet.deactivate!("host unload");
      expect(isActive()).toBe(false);

      // 宿主再次激活：工具可重新发布，配置经环境变量重新生效
      const { ctx, published } = makeFakeStdCtx();
      await facet.activate(ctx as never);
      expect(published.size).toBe(5);

      // chatFn 已随复位清空，AI 精修此时应明确报错而非静默失败
      await expect(
        pageDef.execute(
          { pdfPath, pageNumber: 1, instruction: "x", outputPath: join(root, "x.pdf") },
          {} as never,
        ),
      ).rejects.toThrow(/未检测到 DSH LLM 服务/);
    } finally {
      if (prevKey !== undefined) process.env.DEEPSEEK_API_KEY = prevKey;
      else delete process.env.DEEPSEEK_API_KEY;
    }
  });
});
