/**
 * dsh-std Community v0.15 宿主 facet 入口（dsh-plugin.json → facets.host.entry）。
 *
 * 由 @dsh-std/adapter-dsh（或任何遵循 dsh-std 生命周期的宿主）装载：
 *   - 以 `lifecycle.dsh/v1alpha1 FacetModule` 激活；
 *   - 在 activation 期间把 dsh-plugin.json 声明的 5 个 `tools.dsh/v1alpha1 Tool`
 *     扩展逐一 publish 对应的本地 ToolHandler（resolve → ExecutableToolDefinition）；
 *   - deactivate 时随 activation scope 自动撤销全部发布。
 *
 * 本文件刻意不 import 任何 @deepseek-ai/* 或 @dsh-std/* 运行时包：
 * 协议坐标与对象形状以结构化类型内联声明（dsh-std 规定符合实现不必依赖参考包），
 * 工具业务逻辑复用 src/index.ts 导出的实现函数（动态 import，延迟加载重依赖）。
 *
 * 配置来源（std 宿主没有 cordis config 注入，改用环境变量）：
 *   DEEPSEEK_API_KEY               LLM Key（AI 精修必需；插入/预览不需要）
 *   DSH_PDF_EDIT_ALLOWED_ROOTS     路径白名单，按平台路径分隔符拼接（默认 cwd）
 *   DSH_PDF_EDIT_PROVIDER / _MODEL / _BASE_URL
 *   DSH_PDF_EDIT_RENDER_MODE       native | browser
 *   DSH_PDF_EDIT_BROWSER_EXECUTABLE / _BROWSER_CONCURRENCY
 *   DSH_PDF_EDIT_PATCH_COLOR
 *   DSH_PDF_EDIT_STRICT_TIDS / _MISSING_TIDS_USE_ORIGINAL / _RECOVER_COLOR / _STRICT_COLOR
 *   DSH_PDF_EDIT_OVERFLOW_MODE / _MIN_FONT_SIZE_PT
 *   DSH_PDF_EDIT_FONTS_CJK        中文字体路径（如 NotoSansCJKsc-Regular.otf）
 *   DSH_PDF_EDIT_FONTS_CUSTOMS    主字体，格式 family=path;family=path（可含加粗）
 *   DSH_PDF_EDIT_FONTS_FALLBACKS  缺字回退字体，同上（如 freesans=/usr/share/fonts/gnu-free/FreeSans.otf，
 *                                 用于 ₂₃⁺⁻ 等 CJK 字体缺失的上下标）
 *   DSH_PDF_EDIT_FAKE_BOLD        0/1 是否用双绘模拟加粗（配置了独立加粗字体时置 0）
 */
import { delimiter } from "node:path";

/* ------------------------------------------------------------------ */
/* dsh-std 协议形状（结构性最小声明，不依赖参考实现包）                   */
/* ------------------------------------------------------------------ */

export const TOOL_API_VERSION = "tools.dsh/v1alpha1";
export const TOOL_KIND = "Tool";

/** tools.dsh/v1alpha1 Tool 的 ApiReference。 */
export const TOOL_REFERENCE: Readonly<{ apiVersion: string; kind: string }> =
  Object.freeze({ apiVersion: TOOL_API_VERSION, kind: TOOL_KIND });

/** 宿主为每次工具执行注入的设施（@dsh-std/tool v1alpha1 子集）。 */
export interface StdToolExecutionContext {
  readonly signal?: AbortSignal;
  readonly model?: { readonly provider: string; readonly model: string };
}

export interface StdToolExecutionResult {
  readonly data: unknown;
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
}

/** resolve() 返回的可执行定义；name 必须等于所发布扩展的 metadata.name。 */
export interface StdExecutableToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
  execute(
    input: Readonly<Record<string, unknown>>,
    context: StdToolExecutionContext,
  ): Promise<StdToolExecutionResult>;
}

/** 随 Tool 资源发布的本地 handler（activation value，不跨 endpoint）。 */
export interface StdToolHandler {
  resolve(): StdExecutableToolDefinition | undefined;
}

/** lifecycle.dsh/v1alpha1 ActivationContext 的结构化子集。 */
export interface StdActivationContext {
  readonly scope: {
    readonly signal: AbortSignal;
    add(dispose: () => void | Promise<void>): () => void;
  };
  readonly extensions: {
    publish<T>(
      reference: Readonly<{ apiVersion: string; kind: string }>,
      name: string,
      handler: T,
    ): () => void;
  };
}

export interface StdFacetProjection {
  readonly state?: "active" | "degraded";
  readonly message?: string;
  readonly extensions?: ReadonlyArray<{
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
    readonly status: unknown;
  }>;
}

export interface StdFacetModule {
  activate(context: StdActivationContext): void | Promise<void>;
  deactivate?(reason: string): void | Promise<void>;
  snapshot?(): StdFacetProjection | Promise<StdFacetProjection>;
}

/* ------------------------------------------------------------------ */
/* 静态工具目录（name 与 dsh-plugin.json x-tools 一一对应）              */
/* ------------------------------------------------------------------ */

interface ToolDefSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly output: Readonly<Record<string, unknown>>;
}

const PATH_PARAM = {
  type: "string",
  description: "PDF 文件路径（必须位于 allowedRoots 白名单内，默认当前工作目录）",
} as const;

const OUTPUT_PATH_PARAM = (suffix: string) => ({
  type: "string",
  description: `输出文件路径，默认在原文件名后加 ${suffix}`,
});

const ALLOWED_ROOTS_PARAM = {
  type: "array",
  items: { type: "string" },
  description:
    '可选：本次调用额外放行的绝对路径根目录（与配置的 allowedRoots 合并），如 ["/home/user/workspace"]',
} as const;

const TOOL_DEFS: readonly ToolDefSpec[] = [
  {
    name: "pdf-edit-preview",
    description:
      "预览 PDF 某页的可编辑文本单元（tid + text），不做修改。编辑前先预览以获取 targetTids。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pdfPath: PATH_PARAM,
        pageNumber: {
          type: "integer",
          minimum: 1,
          description: "要预览的页码（1-based）",
        },
        allowedRoots: ALLOWED_ROOTS_PARAM,
      },
      required: ["pdfPath", "pageNumber"],
    },
    output: {
      type: "object",
      additionalProperties: false,
      properties: {
        units: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { tid: { type: "string" }, text: { type: "string" } },
            required: ["tid", "text"],
          },
        },
        pageCount: { type: "integer" },
      },
      required: ["units", "pageCount"],
    },
  },
  {
    name: "pdf-edit-page",
    description:
      "对 PDF 单页进行 AI 文本精修（修正错别字、术语统一、措辞调整），样式锁定不变。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pdfPath: PATH_PARAM,
        pageNumber: {
          type: "integer",
          minimum: 1,
          description: "要编辑的页码（1-based）",
        },
        instruction: {
          type: "string",
          description: "修改指令，如：修正错别字；把「帐号」统一为「账号」",
        },
        targetTids: {
          type: "array",
          items: { type: "string" },
          description:
            "可选，只编辑这些 tid 对应的文本单元（先用 pdf-edit-preview 获取）",
        },
        outputPath: OUTPUT_PATH_PARAM(".edited"),
        allowedRoots: ALLOWED_ROOTS_PARAM,
      },
      required: ["pdfPath", "pageNumber", "instruction"],
    },
    output: {
      type: "object",
      additionalProperties: false,
      properties: {
        outputPath: { type: "string" },
        changed: { type: "boolean" },
      },
      required: ["outputPath", "changed"],
    },
  },
  {
    name: "pdf-edit-document",
    description:
      "对 PDF 全文进行 AI 批量精修（校对、术语统一、措辞调整），逐页样式锁定。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pdfPath: PATH_PARAM,
        instruction: { type: "string", description: "全文修改指令" },
        outputPath: OUTPUT_PATH_PARAM(".edited"),
        allowedRoots: ALLOWED_ROOTS_PARAM,
      },
      required: ["pdfPath", "instruction"],
    },
    output: {
      type: "object",
      additionalProperties: false,
      properties: {
        outputPath: { type: "string" },
        failures: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { page: { type: "integer" }, error: { type: "string" } },
            required: ["page", "error"],
          },
        },
        warnings: { type: "array", items: { type: "string" } },
      },
      required: ["outputPath"],
    },
  },
  {
    name: "pdf-edit-relayout",
    description:
      "对 PDF 进行版式重排，可选学术双栏（academic）、手机单栏（mobile）、商务简报（briefing）三种模板。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pdfPath: PATH_PARAM,
        templateId: {
          type: "string",
          enum: ["academic", "mobile", "briefing"],
          description: "版式模板",
        },
        outputPath: OUTPUT_PATH_PARAM(".relayout"),
        allowedRoots: ALLOWED_ROOTS_PARAM,
      },
      required: ["pdfPath", "templateId"],
    },
    output: {
      type: "object",
      additionalProperties: false,
      properties: { outputPath: { type: "string" } },
      required: ["outputPath"],
    },
  },
  {
    name: "pdf-edit-insert",
    description:
      "把结构化补充内容（标题 + 文本块）作为新页插入 PDF 指定页之后：自动排版（标题横幅/正文/公式灰底框/跨页断页/页脚），原页零改动。无需 LLM。文本块类型：p 段落 / b 要点 / b2 子要点 / h2 小节标题 / eq 公式框 / gap 间距。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pdfPath: PATH_PARAM,
        insertions: {
          type: "array",
          minItems: 1,
          description: "插入计划列表（每项生成一页）",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              afterPage: {
                type: "integer",
                minimum: 1,
                description: "插到原 PDF 该页（1-based）之后",
              },
              title: { type: "string", description: "横幅标题（加粗）" },
              caption: {
                type: "string",
                description: "横幅上方的灰色说明行（如插入位置）",
              },
              blocks: {
                type: "array",
                description:
                  "结构化块（t: h2 小节标题 / p 段落 / b 要点 / b2 子要点 / eq 公式框 / gap 间距）",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    t: {
                      type: "string",
                      enum: ["h2", "p", "b", "b2", "eq", "gap"],
                    },
                    s: { type: "string" },
                  },
                  required: ["t", "s"],
                },
              },
              markdown: {
                type: "string",
                description:
                  "便捷写法：markdown 文本（# 标题 / - 要点 / 缩进子要点 / eq: 公式 / --- 分隔），内部自动解析，与 blocks 合并；两者至少提供一个",
              },
            },
            required: ["afterPage", "title"],
          },
        },
        outputPath: OUTPUT_PATH_PARAM(".inserted"),
        allowedRoots: ALLOWED_ROOTS_PARAM,
      },
      required: ["pdfPath", "insertions"],
    },
    output: {
      type: "object",
      additionalProperties: false,
      properties: {
        outputPath: { type: "string" },
        insertedPages: { type: "integer" },
        totalPages: { type: "integer" },
      },
      required: ["outputPath", "insertedPages", "totalPages"],
    },
  },
];

/** 工具名目录（供测试校验 manifest 一致性与宿主快照）。 */
export function stdToolNames(): readonly string[] {
  return TOOL_DEFS.map((tool) => tool.name);
}

function jsonRender(data: unknown): StdToolExecutionResult {
  return { data, content: [{ type: "text", text: JSON.stringify(data) }] };
}

/* ------------------------------------------------------------------ */
/* 环境变量配置                                                        */
/* ------------------------------------------------------------------ */

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function envPositiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function envNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 从环境变量收集 std 宿主可用的配置。 */
export function envConfig(): Partial<
  import("../index.js").DshPdfEditConfig
> {
  const env = process.env;
  const config: Record<string, unknown> = {};

  if (env.DSH_PDF_EDIT_ALLOWED_ROOTS !== undefined) {
    config.allowedRoots = env.DSH_PDF_EDIT_ALLOWED_ROOTS
      .split(delimiter)
      .map((root) => root.trim())
      .filter((root) => root.length > 0);
  }

  const apiKey = env.DSH_PDF_EDIT_API_KEY ?? env.DEEPSEEK_API_KEY;
  if (apiKey !== undefined && apiKey.trim() !== "") config.apiKey = apiKey.trim();
  if (env.DSH_PDF_EDIT_BASE_URL?.trim()) config.baseUrl = env.DSH_PDF_EDIT_BASE_URL.trim();
  if (env.DSH_PDF_EDIT_PROVIDER?.trim()) config.provider = env.DSH_PDF_EDIT_PROVIDER.trim();
  if (env.DSH_PDF_EDIT_MODEL?.trim()) config.model = env.DSH_PDF_EDIT_MODEL.trim();

  const renderMode = env.DSH_PDF_EDIT_RENDER_MODE?.trim().toLowerCase();
  if (renderMode === "native" || renderMode === "browser") config.renderMode = renderMode;
  if (env.DSH_PDF_EDIT_BROWSER_EXECUTABLE?.trim()) {
    config.browserExecutablePath = env.DSH_PDF_EDIT_BROWSER_EXECUTABLE.trim();
  }
  const concurrency = envPositiveInt(env.DSH_PDF_EDIT_BROWSER_CONCURRENCY);
  if (concurrency !== undefined) config.browserConcurrency = concurrency;
  if (env.DSH_PDF_EDIT_PATCH_COLOR?.trim()) config.patchColor = env.DSH_PDF_EDIT_PATCH_COLOR.trim();

  const fakeBold = envBool(env.DSH_PDF_EDIT_FAKE_BOLD);
  if (fakeBold !== undefined) config.fakeBold = fakeBold;

  const strictTids = envBool(env.DSH_PDF_EDIT_STRICT_TIDS);
  if (strictTids !== undefined) config.strictTids = strictTids;
  const missingOriginal = envBool(env.DSH_PDF_EDIT_MISSING_TIDS_USE_ORIGINAL);
  if (missingOriginal !== undefined) config.missingTidsUseOriginal = missingOriginal;
  const recoverColor = envBool(env.DSH_PDF_EDIT_RECOVER_COLOR);
  if (recoverColor !== undefined) config.recoverColor = recoverColor;
  const strictColor = envBool(env.DSH_PDF_EDIT_STRICT_COLOR);
  if (strictColor !== undefined) config.strictColor = strictColor;

  const overflowMode = env.DSH_PDF_EDIT_OVERFLOW_MODE?.trim().toLowerCase();
  if (
    overflowMode === "shrink" ||
    overflowMode === "clip" ||
    overflowMode === "wrap" ||
    overflowMode === "reject"
  ) {
    const minFontSizePt = envNumber(env.DSH_PDF_EDIT_MIN_FONT_SIZE_PT);
    config.overflow = {
      mode: overflowMode,
      ...(minFontSizePt !== undefined ? { minFontSizePt } : {}),
    };
  }

  // 字体配置（std 宿主没有 cordis config 注入，改为环境变量）。
  // 格式：family=path;family=path（family 与 index.ts 的 FontResolver 一致）。
  const parseFontPairs = (
    value: string | undefined,
  ): Array<{ family: string; path: string }> => {
    if (value === undefined) return [];
    return value
      .split(";")
      .map((pair) => pair.trim())
      .filter((pair) => pair.length > 0)
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq <= 0) {
          throw new Error(
            `DSH_PDF_EDIT_FONTS_* 格式应为 "family=path;family=path"，收到: ${pair}`,
          );
        }
        return {
          family: pair.slice(0, eq).trim(),
          path: pair.slice(eq + 1).trim(),
        };
      });
  };
  const fonts: Record<string, unknown> = {};
  const cjkPath = env.DSH_PDF_EDIT_FONTS_CJK?.trim();
  if (cjkPath) fonts.cjk = { path: cjkPath };
  const customs = parseFontPairs(env.DSH_PDF_EDIT_FONTS_CUSTOMS);
  if (customs.length) fonts.customs = customs;
  const fallbacks = parseFontPairs(env.DSH_PDF_EDIT_FONTS_FALLBACKS);
  if (fallbacks.length) fonts.fallbacks = fallbacks;
  if (Object.keys(fonts).length > 0) config.fonts = fonts;

  return config;
}

/* ------------------------------------------------------------------ */
/* FacetModule                                                         */
/* ------------------------------------------------------------------ */

type IndexModule = typeof import("../index.js");
let impls: IndexModule | undefined;

async function loadImpl(): Promise<IndexModule> {
  // index.ts 顶层会拉起 pdf-lib/pdfjs 等重依赖，facet 装载阶段保持轻量，
  // activation 时才动态加载。
  if (impls === undefined) impls = await import("../index.js");
  return impls;
}

function bindRunner(name: string): (input: Record<string, unknown>) => Promise<unknown> {
  const mod = impls as IndexModule;
  switch (name) {
    case "pdf-edit-preview":
      return (input) => mod.pdfEditPreview(input as never);
    case "pdf-edit-page":
      return (input) => mod.pdfEditPage(input as never);
    case "pdf-edit-document":
      return (input) => mod.pdfEditDocument(input as never);
    case "pdf-edit-relayout":
      return (input) => mod.pdfEditRelayout(input as never);
    case "pdf-edit-insert":
      return (input) => mod.pdfEditInsert(input as never);
    default:
      throw new Error(`dsh-pdf-edit: 未实现的 std 工具 ${name}`);
  }
}

function buildDefinition(spec: ToolDefSpec): StdExecutableToolDefinition {
  const run = bindRunner(spec.name);
  return Object.freeze({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: spec.output,
    async execute(
      input: Readonly<Record<string, unknown>>,
      _context: StdToolExecutionContext,
    ): Promise<StdToolExecutionResult> {
      // 输入是惰性 JSON 数据；业务级校验由实现层负责（含路径白名单守卫）。
      const data = await run({ ...input });
      return jsonRender(data);
    },
  });
}

async function activate(context: StdActivationContext): Promise<void> {
  await loadImpl();

  // 复用编程接口的配置状态管理：先复位再套用环境变量配置。
  impls!.deactivate();
  impls!.activate(envConfig());

  for (const spec of TOOL_DEFS) {
    const handler: StdToolHandler = Object.freeze({
      resolve: () => buildDefinition(spec),
    });
    // publish 内部登记到 activation scope，deactivate 时自动撤销。
    context.extensions.publish(TOOL_REFERENCE, spec.name, handler);
  }
}

function deactivate(_reason: string): void {
  try {
    impls?.deactivate();
  } catch {
    // 尚未激活过则无需清理
  }
}

function snapshot(): StdFacetProjection {
  return {
    state: "active",
    message: "dsh-pdf-edit tools registered (dsh-std Community v0.15)",
    extensions: TOOL_DEFS.map((spec) => ({
      apiVersion: TOOL_API_VERSION,
      kind: TOOL_KIND,
      name: spec.name,
      status: { state: "available" },
    })),
  };
}

/** 供测试构造已冻结的工具定义（须先经 activate 或手动 loadImpl）。 */
export async function stdToolDefinitions(): Promise<Map<string, StdExecutableToolDefinition>> {
  await loadImpl();
  const definitions = new Map<string, StdExecutableToolDefinition>();
  for (const spec of TOOL_DEFS) definitions.set(spec.name, buildDefinition(spec));
  return definitions;
}

const facet: StdFacetModule = Object.freeze({
  activate,
  deactivate,
  snapshot,
});

export { facet as stdFacet };
export default facet;
