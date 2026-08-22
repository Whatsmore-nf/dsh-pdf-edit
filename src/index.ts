/**
 * dsh-pdf-edit — DeepSeek Harness 插件（适配 dsh 0.1.1-rc.2 插件契约）。
 *
 * 导出契约（与官方 @deepseek-ai/dsh-tool-* 一致）：
 *   name   — cordis 插件名
 *   inject — 依赖的服务（"tools"）
 *   apply(ctx, config) — 通过 ctx.tools.register(defineTool({...})) 注册工具
 *
 * 兼容导出：activate/deactivate/setChatFn 等编程接口保留，便于测试与嵌入调用。
 */
import { readFileSync, writeFileSync } from "node:fs";

import { StyleLockedEditor } from "./pipeline.js";
import { createDeepSeekChatFn, adapterToChatFn } from "./ai-editor.js";
import {
  validateInputPath,
  validateOutputPath,
  type PathGuardOptions,
} from "./path-guard.js";
import { assertSingleDshTools } from "./guard.js";
import type { FontConfig } from "./fonts-resolver.js";

import type {
  ChatFn,
  Glossary,
  LLMAdapter,
  OverflowPolicy,
  ProgressFn,
} from "./types.js";

export * from "./types.js";
export * from "./util.js";
export * from "./prompts.js";
export * from "./html.js";
export * from "./pdfjs-lazy.js";
export * from "./fonts-resolver.js";
export * from "./extractor.js";
export * from "./ai-editor.js";
export * from "./validator.js";
export * from "./native-renderer.js";
export * from "./path-guard.js";
export * from "./guard.js";
export * from "./pdf-ops.js";
export {
  TEMPLATES,
  fillTemplate,
  type LayoutTemplate,
} from "./templates.js";
export * from "./flow-themes.js";
export * from "./layout-flow.js";
export * from "./flow.js";
export * from "./pipeline.js";

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

export interface DshPdfEditConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
  /** 允许读写的根目录（绝对路径）。默认 [process.cwd()]；空数组 = 完全禁用文件操作 */
  allowedRoots?: string[];
  overflow?: OverflowPolicy;
  glossary?: Glossary;
  fonts?: FontConfig;
  patchColor?: string;
  strictTids?: boolean;
  missingTidsUseOriginal?: boolean;
  recoverColor?: boolean;
  strictColor?: boolean;
  renderMode?: "native" | "browser";
  browserExecutablePath?: string;
  browserConcurrency?: number;
}

const DEFAULT_CONFIG: DshPdfEditConfig = {
  overflow: { mode: "shrink", minFontSizePt: 6 },
  strictTids: false,
  missingTidsUseOriginal: true,
  recoverColor: true,
  strictColor: false,
  renderMode: "native",
  patchColor: "#ffffff",
};

let _config: DshPdfEditConfig = { ...DEFAULT_CONFIG };
let _chatFn: ChatFn | null = null;

/** 工具入参路径守卫选项：allowedRoots 未配置时锁在 cwd。 */
function guardOpts(): PathGuardOptions {
  return { allowedRoots: _config.allowedRoots ?? [process.cwd()] };
}

function getChatFn(): ChatFn {
  if (_chatFn) return _chatFn;

  // fallback：当 ctx.llm 不可用时，通过环境变量或 config 直连 DeepSeek API
  const apiKey = process.env.DEEPSEEK_API_KEY ?? _config.apiKey;
  if (!apiKey) {
    throw new Error(
      "dsh-pdf-edit: 未检测到 DSH LLM 服务，请设置 DEEPSEEK_API_KEY 环境变量（或在配置中传入 apiKey）",
    );
  }
  if (!/^sk-[A-Za-z0-9\-_]{8,}$/.test(apiKey)) {
    throw new Error("dsh-pdf-edit: API Key 格式异常，应以 sk- 开头且包含足够长度");
  }
  if (process.env.DEEPSEEK_API_KEY === undefined) {
    console.warn(
      "[dsh-pdf-edit] 建议改用 DEEPSEEK_API_KEY 环境变量，避免 Key 随配置对象泄漏",
    );
  }

  _chatFn = createDeepSeekChatFn({
    apiKey,
    baseUrl: _config.baseUrl,
    model: _config.model,
  });
  return _chatFn;
}

function editorOptions() {
  return {
    overflow: _config.overflow,
    glossary: _config.glossary,
    fonts: _config.fonts,
    patchColor: _config.patchColor,
    strictTids: _config.strictTids,
    missingTidsUseOriginal: _config.missingTidsUseOriginal,
    recoverColor: _config.recoverColor,
    strictColor: _config.strictColor,
    renderMode: _config.renderMode,
    browserExecutablePath: _config.browserExecutablePath,
    browserConcurrency: _config.browserConcurrency,
  };
}

/* ------------------------------------------------------------------ */
/* 工具执行体（供 defineTool 与编程调用共用）                            */
/* ------------------------------------------------------------------ */

async function pdfEditPage(params: {
  pdfPath: string;
  pageNumber: number;
  instruction: string;
  targetTids?: string[];
  outputPath?: string;
}): Promise<{ outputPath: string; changed: boolean }> {
  const inputAbs = validateInputPath(params.pdfPath, guardOpts());
  const outputAbs = validateOutputPath(params.outputPath, inputAbs, guardOpts());
  const chat = getChatFn();
  const original = new Uint8Array(readFileSync(inputAbs));

  const editor = await StyleLockedEditor.open(original, chat, editorOptions());

  try {
    const result = await editor.editPage(
      params.pageNumber,
      params.instruction,
      params.targetTids,
    );

    const changed =
      result.length !== original.length ||
      !result.every((b, i) => b === original[i]);

    writeFileSync(outputAbs, result);

    return { outputPath: outputAbs, changed };
  } finally {
    await editor.close();
  }
}

async function pdfEditDocument(params: {
  pdfPath: string;
  instruction: string;
  outputPath?: string;
}): Promise<{
  outputPath: string;
  failures: Array<{ page: number; error: string }>;
  warnings: string[];
}> {
  const inputAbs = validateInputPath(params.pdfPath, guardOpts());
  const outputAbs = validateOutputPath(params.outputPath, inputAbs, guardOpts());
  const chat = getChatFn();
  const original = new Uint8Array(readFileSync(inputAbs));

  const editor = await StyleLockedEditor.open(original, chat, editorOptions());

  try {
    const result = await editor.editDocument(params.instruction);
    writeFileSync(outputAbs, result);

    return {
      outputPath: outputAbs,
      // error 必须是无损 JSON：序列化为字符串
      failures: editor.lastFailures.map((f) => ({
        page: f.page,
        error: String(f.error),
      })),
      warnings: editor.warnings,
    };
  } finally {
    await editor.close();
  }
}

async function pdfEditRelayout(params: {
  pdfPath: string;
  templateId: "academic" | "mobile" | "briefing";
  outputPath?: string;
}): Promise<{ outputPath: string }> {
  const inputAbs = validateInputPath(params.pdfPath, guardOpts());
  const outputAbs = validateOutputPath(
    params.outputPath,
    inputAbs,
    guardOpts(),
    ".relayout.pdf",
  );
  const chat = getChatFn();
  const original = new Uint8Array(readFileSync(inputAbs));

  const editor = await StyleLockedEditor.open(original, chat, editorOptions());

  try {
    const result = await editor.relayout(params.templateId);
    writeFileSync(outputAbs, result);
    return { outputPath: outputAbs };
  } finally {
    await editor.close();
  }
}

async function pdfEditPreview(params: {
  pdfPath: string;
  pageNumber: number;
}): Promise<{
  units: Array<{ tid: string; text: string }>;
  pageCount: number;
}> {
  const inputAbs = validateInputPath(params.pdfPath, guardOpts());
  const chat = getChatFn();
  const original = new Uint8Array(readFileSync(inputAbs));

  const editor = await StyleLockedEditor.open(original, chat, {
    recoverColor: _config.recoverColor,
    strictColor: _config.strictColor,
    renderMode: _config.renderMode,
    browserExecutablePath: _config.browserExecutablePath,
    browserConcurrency: _config.browserConcurrency,
  });

  try {
    const units = await editor.previewPage(params.pageNumber);
    return { units, pageCount: editor.pageCount };
  } finally {
    await editor.close();
  }
}

/* ------------------------------------------------------------------ */
/* dsh 插件契约                                                        */
/* ------------------------------------------------------------------ */

export const name = "dsh-pdf-edit";

/** 依赖的 dsh 服务：工具注册表 + LLM 运行时 */
export const inject = ["tools", "llm"] as const;

/**
 * 插件装载入口。config 来自 cordis.patch.yml 中本插件行的 `config:` 字段，
 * 键名与 DshPdfEditConfig 一致（如 allowedRoots / glossary / fonts / renderMode）。
 */
export async function apply(
  ctx: {
    tools: { register(definition: unknown): unknown };
    llm?: {
      stream(options: {
        provider: string;
        model: string;
        messages: Array<{
          role: "system" | "user" | "assistant";
          content: Array<{ type: string; text?: string }>;
          source: { kind: string; plugin: string };
        }>;
        system?: string;
        temperature?: number;
        maxTokens?: number;
        signal?: AbortSignal;
      }): AsyncIterable<{
        type: string;
        index?: number;
        text?: string;
        block?: { type: string; text?: string };
        kind?: string;
      }>;
    };
  },
  config?: Partial<DshPdfEditConfig>,
): Promise<void> {
  // 入口守卫：必须在任何 ctx.tools 访问之前（双副本诊断，见 src/guard.ts）
  assertSingleDshTools(ctx);

  if (config) {
    // 仅当影响 chat 构造的键变化时才重建 chatFn，避免误清外部注入的 mock
    const chatAffecting = ["apiKey", "baseUrl", "model", "provider"] as const;
    if (chatAffecting.some((k) => k in config)) _chatFn = null;
    _config = { ..._config, ...config };
  }

  // 优先使用 DSH 已有 LLM 服务（ctx.llm），无需用户手动配置 key
  if (ctx.llm && !_chatFn) {
    _chatFn = async (messages, opts) => {
      const provider = _config.provider ?? "agnes";
      const model = _config.model ?? "agnes-2.5-flash";

      const dshMessages = messages.map((m) => ({
        role: m.role as "system" | "user" | "assistant",
        content: [{ type: "text" as const, text: m.content }],
        source: { kind: "plugin" as const, plugin: "dsh-pdf-edit" },
      }));

      const chunks: string[] = [];
      for await (const chunk of ctx.llm!.stream({
        provider,
        model,
        messages: dshMessages,
        temperature: opts?.temperature ?? 0.1,
        maxTokens: opts?.maxTokens,
      })) {
        if (chunk.type === "text-delta" && chunk.text) {
          chunks.push(chunk.text);
        } else if (
          chunk.type === "block-end" &&
          chunk.block?.type === "text" &&
          chunk.block.text
        ) {
          chunks.push(chunk.block.text);
        }
      }
      return chunks.join("");
    };
  }

  // 延迟加载：本地开发环境未安装 dsh-tools 时模块本身仍可导入（供测试）
  const { defineTool } = await import("@deepseek-ai/dsh-tools");

  const jsonRender = (_args: unknown, value: unknown) => [
    { type: "text" as const, text: JSON.stringify(value) },
  ];

  /* ------------------------- pdf-edit-preview ------------------------- */
  ctx.tools.register(
    defineTool({
      name: "pdf-edit-preview",
      description:
        "预览 PDF 某页的可编辑文本单元（tid + text），不做修改。编辑前先预览以获取 targetTids。",
      parameters: {
        pdfPath: {
          type: "string",
          required: true,
          description:
            "PDF 文件路径（必须位于 allowedRoots 白名单内，默认当前工作目录）",
        },
        pageNumber: {
          type: "integer",
          required: true,
          description: "要预览的页码（1-based）",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            units: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  tid: { type: "string", required: true },
                  text: { type: "string", required: true },
                },
              },
            },
            pageCount: { type: "integer", required: true },
          },
        },
        render: jsonRender,
      },
      execute: (args) => pdfEditPreview(args),
    }),
  );

  /* -------------------------- pdf-edit-page -------------------------- */
  ctx.tools.register(
    defineTool({
      name: "pdf-edit-page",
      description:
        "对 PDF 单页进行 AI 文本精修（修正错别字、术语统一、措辞调整），样式锁定不变。",
      parameters: {
        pdfPath: {
          type: "string",
          required: true,
          description: "PDF 文件路径（必须位于 allowedRoots 白名单内）",
        },
        pageNumber: {
          type: "integer",
          required: true,
          description: "要编辑的页码（1-based）",
        },
        instruction: {
          type: "string",
          required: true,
          description: "修改指令，如：修正错别字；把「帐号」统一为「账号」",
        },
        targetTids: {
          type: "array",
          description: "可选，只编辑这些 tid 对应的文本单元（先用 pdf-edit-preview 获取）",
          items: { type: "string" },
        },
        outputPath: {
          type: "string",
          description: "输出文件路径，默认在原文件名后加 .edited",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            outputPath: { type: "string", required: true },
            changed: { type: "boolean", required: true },
          },
        },
        render: jsonRender,
      },
      execute: (args) => pdfEditPage(args),
    }),
  );

  /* ------------------------ pdf-edit-document ------------------------ */
  ctx.tools.register(
    defineTool({
      name: "pdf-edit-document",
      description:
        "对 PDF 全文进行 AI 批量精修（校对、术语统一、措辞调整），逐页样式锁定。",
      parameters: {
        pdfPath: {
          type: "string",
          required: true,
          description: "PDF 文件路径（必须位于 allowedRoots 白名单内）",
        },
        instruction: {
          type: "string",
          required: true,
          description: "全文修改指令",
        },
        outputPath: {
          type: "string",
          description: "输出文件路径，默认在原文件名后加 .edited",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            outputPath: { type: "string", required: true },
            failures: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  page: { type: "integer", required: true },
                  error: { type: "string", required: true },
                },
              },
            },
            warnings: { type: "array", items: { type: "string" } },
          },
        },
        render: jsonRender,
      },
      execute: (args) => pdfEditDocument(args),
    }),
  );

  /* ------------------------ pdf-edit-relayout ------------------------ */
  ctx.tools.register(
    defineTool({
      name: "pdf-edit-relayout",
      description:
        "对 PDF 进行版式重排，可选学术双栏（academic）、手机单栏（mobile）、商务简报（briefing）三种模板。",
      parameters: {
        pdfPath: {
          type: "string",
          required: true,
          description: "PDF 文件路径（必须位于 allowedRoots 白名单内）",
        },
        templateId: {
          type: "string",
          required: true,
          enum: ["academic", "mobile", "briefing"],
          description: "版式模板",
        },
        outputPath: {
          type: "string",
          description: "输出文件路径，默认在原文件名后加 .relayout",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            outputPath: { type: "string", required: true },
          },
        },
        render: jsonRender,
      },
      execute: (args) => pdfEditRelayout(args),
    }),
  );
}

/* ------------------------------------------------------------------ */
/* 编程接口（保留，供嵌入方与测试使用）                                  */
/* ------------------------------------------------------------------ */

export function activate(config?: DshPdfEditConfig): void {
  _config = { ...DEFAULT_CONFIG, ..._config, ...config };
  _chatFn = null;
}

export function deactivate(): void {
  _config = { ...DEFAULT_CONFIG };
  _chatFn = null;
}

export function isActive(): boolean {
  return _chatFn !== null || process.env.DEEPSEEK_API_KEY !== undefined;
}

export function setChatFn(chatFn: ChatFn): void {
  _chatFn = chatFn;
}

export function setLLMAdapter(adapter: LLMAdapter): void {
  _chatFn = adapterToChatFn(adapter);
}