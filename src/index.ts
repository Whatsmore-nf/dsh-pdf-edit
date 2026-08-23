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
import type { InsertBlockType } from "./inserter.js";
import {
  validateInputPath,
  validateOutputPath,
  withExtraRoots,
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
export * from "./inserter.js";

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

/** 工具入参路径守卫选项：allowedRoots 未配置时锁在 cwd；可按调用额外放行。 */
function guardOpts(extraRoots?: string[]): PathGuardOptions {
  return {
    allowedRoots: withExtraRoots(
      _config.allowedRoots ?? [process.cwd()],
      extraRoots,
    ),
  };
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
  allowedRoots?: string[];
}): Promise<{ outputPath: string; changed: boolean }> {
  const inputAbs = validateInputPath(params.pdfPath, guardOpts(params.allowedRoots));
  const outputAbs = validateOutputPath(params.outputPath, inputAbs, guardOpts(params.allowedRoots));
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
  allowedRoots?: string[];
}): Promise<{
  outputPath: string;
  failures: Array<{ page: number; error: string }>;
  warnings: string[];
}> {
  const inputAbs = validateInputPath(params.pdfPath, guardOpts(params.allowedRoots));
  const outputAbs = validateOutputPath(params.outputPath, inputAbs, guardOpts(params.allowedRoots));
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
  allowedRoots?: string[];
}): Promise<{ outputPath: string }> {
  const inputAbs = validateInputPath(params.pdfPath, guardOpts(params.allowedRoots));
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
  allowedRoots?: string[];
}): Promise<{
  units: Array<{ tid: string; text: string }>;
  pageCount: number;
}> {
  const inputAbs = validateInputPath(params.pdfPath, guardOpts(params.allowedRoots));
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

/* -------------------------- pdf-edit-insert ------------------------- */
/* 无需 LLM：把结构化内容作为新页插入指定页之后（见 src/inserter.ts）    */

async function pdfEditInsert(params: {
  pdfPath: string;
  insertions: Array<{
    afterPage: number;
    title: string;
    caption?: string;
    /** 结构化块（t: h2/p/b/b2/eq/gap） */
    blocks?: Array<{ t: string; s: string }>;
    /** 便捷写法：markdown 文本，内部经 parseMarkdownBlocks 解析，与 blocks 合并 */
    markdown?: string;
  }>;
  outputPath?: string;
  allowedRoots?: string[];
}): Promise<{
  outputPath: string;
  insertedPages: number;
  totalPages: number;
}> {
  const inputAbs = validateInputPath(params.pdfPath, guardOpts(params.allowedRoots));
  const outputAbs = validateOutputPath(
    params.outputPath,
    inputAbs,
    guardOpts(params.allowedRoots),
    ".inserted.pdf",
  );
  const original = new Uint8Array(readFileSync(inputAbs));

  const { insertPages, parseMarkdownBlocks } = await import("./inserter.js");
  const result = await insertPages(
    original,
    params.insertions.map((ins) => {
      const blocks: Array<{ t: InsertBlockType; s: string }> = [
        ...(ins.blocks ?? []).map((b) => ({
          t: b.t as InsertBlockType,
          s: b.s,
        })),
        ...(ins.markdown ? parseMarkdownBlocks(ins.markdown) : []),
      ];
      if (blocks.length === 0) {
        throw new Error(
          `insertions[afterPage=${ins.afterPage}] 缺少内容：请提供 blocks 或 markdown`,
        );
      }
      return {
        afterPage: ins.afterPage,
        title: ins.title,
        caption: ins.caption,
        blocks,
      };
    }),
    { fonts: _config.fonts },
  );
  writeFileSync(outputAbs, result.bytes);
  return {
    outputPath: outputAbs,
    insertedPages: result.insertedPages,
    totalPages: result.totalPages,
  };
}

/* ------------------------------------------------------------------ */
/* dsh 插件契约                                                        */
/* ------------------------------------------------------------------ */

export const name = "dsh-pdf-edit";

/** 依赖的 dsh 服务：工具注册表 + LLM 运行时 + 默认模型选择 */
export const inject = ["tools", "llm", "agentDefaultModel"] as const;

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
    agentDefaultModel?: {
      currentSelection(): {
        provider: string;
        model: string;
        reasoningEffort?: string;
      };
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
      // 优先级：用户配置 > DSH 默认模型选择 > 硬编码兜底
      let provider = _config.provider;
      let model = _config.model;

      if (!provider || !model) {
        try {
          const selection = ctx.agentDefaultModel?.currentSelection();
          if (selection) {
            if (!provider) provider = selection.provider;
            if (!model) model = selection.model;
          }
        } catch {
          // agentDefaultModel 不可用时静默降级
        }
      }

      // 最终兜底：若仍无值则使用 agnes（DSH 内置）
      provider ??= "agnes";
      model ??= "agnes-2.5-flash";

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
        allowedRoots: {
          type: "array",
          items: { type: "string" },
          description: "可选：本次调用额外放行的绝对路径根目录（与插件配置的 allowedRoots 合并）",
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
        allowedRoots: {
          type: "array",
          items: { type: "string" },
          description: "可选：本次调用额外放行的绝对路径根目录（与插件配置的 allowedRoots 合并），如 [\"/home/user/workspace\"]",
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
        allowedRoots: {
          type: "array",
          items: { type: "string" },
          description: "可选：本次调用额外放行的绝对路径根目录（与插件配置的 allowedRoots 合并），如 [\"/home/user/workspace\"]",
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
        allowedRoots: {
          type: "array",
          items: { type: "string" },
          description: "可选：本次调用额外放行的绝对路径根目录（与插件配置的 allowedRoots 合并）",
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

  /* -------------------------- pdf-edit-insert -------------------------- */
  ctx.tools.register(
    defineTool({
      name: "pdf-edit-insert",
      description:
        "把结构化补充内容（标题 + 文本块）作为新页插入 PDF 指定页之后：自动排版（标题横幅/正文/公式灰底框/跨页断页/页脚），原页零改动。无需 LLM。文本块类型：p 段落 / b 要点 / b2 子要点 / h2 小节标题 / eq 公式框 / gap 间距。",
      parameters: {
        pdfPath: {
          type: "string",
          required: true,
          description: "PDF 文件路径（必须位于 allowedRoots 白名单内）",
        },
        insertions: {
          type: "array",
          required: true,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              afterPage: {
                type: "integer",
                required: true,
                description: "插到原 PDF 该页（1-based）之后",
              },
              title: {
                type: "string",
                required: true,
                description: "横幅标题（加粗）",
              },
              caption: {
                type: "string",
                description: "横幅上方的灰色说明行（如插入位置）",
              },
              blocks: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    t: {
                      type: "string",
                      required: true,
                      enum: ["h2", "p", "b", "b2", "eq", "gap"],
                    },
                    s: { type: "string", required: true },
                  },
                },
                description: "结构化块（t: h2 小节标题 / p 段落 / b 要点 / b2 子要点 / eq 公式框 / gap 间距）",
              },
              markdown: {
                type: "string",
                description: "便捷写法：markdown 文本（# 标题 / - 要点 / 缩进子要点 / eq: 公式 / --- 分隔），内部自动解析，与 blocks 合并；两者至少提供一个",
              },
            },
          },
        },
        outputPath: {
          type: "string",
          description: "输出文件路径，默认在原文件名后加 .inserted",
        },
        allowedRoots: {
          type: "array",
          items: { type: "string" },
          description: "可选：本次调用额外放行的绝对路径根目录（与插件配置的 allowedRoots 合并）",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            outputPath: { type: "string", required: true },
            insertedPages: { type: "integer", required: true },
            totalPages: { type: "integer", required: true },
          },
        },
        render: jsonRender,
      },
      execute: (args) => pdfEditInsert(args),
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

/* ------------------------------------------------------------------ */
/* 简化编程包装（供 AI 直接操作 Unit 对象，绕过 sanitizeText 限制）       */
/* ------------------------------------------------------------------ */

/**
 * 简化包装：删除匹配的小标题（直接操作 Unit，不依赖 editDocument 标准流程）。
 *
 * @param pdfPath      输入 PDF 路径（必须在 allowedRoots 内）
 * @param outputPath   输出路径
 * @param subheadingTexts  要删除的小标题文本列表（精确匹配）
 * @param chatFn       可选：自定义 LLM 调用函数（如不用 AI 修改，仅删除则可传 null）
 */
export async function removeSubheadings(
  pdfPath: string,
  outputPath: string,
  subheadingTexts: string[],
  chatFn?: ChatFn,
): Promise<{ outputPath: string; deletedTids: string[] }> {
  // 使用工具接口同样的路径守卫（避免绕过 allowedRoots 限制）
  const inputAbs = validateInputPath(pdfPath, { allowedRoots: [process.cwd()] });
  const outputAbs = validateOutputPath(outputPath, inputAbs, { allowedRoots: [process.cwd()] });

  const original = new Uint8Array(readFileSync(inputAbs));
  const chat = chatFn ?? (async () => { throw new Error("removeSubheadings 需要传入 chatFn 或设置 DEEPSEEK_API_KEY"); });

  const editor = await StyleLockedEditor.open(original, chat, {
    renderMode: "native",
  });

  try {
    const deletedTids: string[] = [];
    const work: Array<{ ex: import("./types.js").PageExtract; changedTids: Set<string> }> = [];

    // 遍历所有页面，找到匹配的小标题并直接设空
    for (let pageNum = 1; pageNum <= editor.pageCount; pageNum++) {
      const ex = await editor.getExtract(pageNum);
      const pageDeletedTids: string[] = [];

      for (const u of ex.units) {
        // 精确匹配或包含匹配
        if (subheadingTexts.some((t) => u.text === t || u.text.includes(t))) {
          u.text = "";
          pageDeletedTids.push(u.tid);
        }
      }

      if (pageDeletedTids.length) {
        deletedTids.push(...pageDeletedTids);
        work.push({ ex, changedTids: new Set(pageDeletedTids) });
      }
    }

    if (work.length) {
      const { doc, resolver } = await editor.openNativeDoc();
      await editor.drawPatchedPages(doc, resolver, work);
      const result = await doc.save();
      writeFileSync(outputAbs, result);
      return { outputPath: outputAbs, deletedTids };
    }

    // 没有匹配项：直接复制原文件
    writeFileSync(outputAbs, original);
    return { outputPath: outputAbs, deletedTids: [] };
  } finally {
    await editor.close().catch(() => {});
  }
}