import { readFileSync, writeFileSync } from "node:fs";

import { StyleLockedEditor } from "./pipeline.js";
import { createDeepSeekChatFn, adapterToChatFn } from "./ai-editor.js";
import type { FontConfig } from "./fonts-resolver.js";

import type {
  ChatFn,
  ChatMessage,
  ChatOptions,
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

export interface DshPdfEditConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
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
let _active = false;

function getChatFn(): ChatFn {
  if (_chatFn) return _chatFn;

  const apiKey = _config.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error(
      "dsh-plugin-pdf-edit: apiKey 未配置，请设置 DEEPSEEK_API_KEY 环境变量或在 activate 时传入",
    );
  }

  _chatFn = createDeepSeekChatFn({
    apiKey,
    baseUrl: _config.baseUrl,
    model: _config.model,
  });

  return _chatFn;
}

async function pdfEditEditPage(params: {
  pdfPath: string;
  pageNumber: number;
  instruction: string;
  targetTids?: string[];
  outputPath?: string;
}): Promise<{ outputPath: string; changed: boolean }> {
  const chat = getChatFn();
  const original = new Uint8Array(readFileSync(params.pdfPath));

  const editor = await StyleLockedEditor.open(original, chat, {
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
  });

  try {
    const result = await editor.editPage(
      params.pageNumber,
      params.instruction,
      params.targetTids,
    );

    const changed =
      result.length !== original.length ||
      !result.every((b, i) => b === original[i]);

    const outputPath =
      params.outputPath ??
      params.pdfPath.replace(/\.pdf$/i, ".edited.pdf");

    writeFileSync(outputPath, result);

    return { outputPath, changed };
  } finally {
    await editor.close();
  }
}

async function pdfEditDocument(params: {
  pdfPath: string;
  instruction: string;
  outputPath?: string;
  onProgress?: ProgressFn;
}): Promise<{
  outputPath: string;
  failures: Array<{ page: number; error: unknown }>;
  warnings: string[];
}> {
  const chat = getChatFn();
  const original = new Uint8Array(readFileSync(params.pdfPath));

  const editor = await StyleLockedEditor.open(original, chat, {
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
  });

  try {
    const result = await editor.editDocument(
      params.instruction,
      params.onProgress,
    );

    const outputPath =
      params.outputPath ??
      params.pdfPath.replace(/\.pdf$/i, ".edited.pdf");

    writeFileSync(outputPath, result);

    return {
      outputPath,
      failures: editor.lastFailures,
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
  onProgress?: ProgressFn;
}): Promise<{ outputPath: string }> {
  const chat = getChatFn();
  const original = new Uint8Array(readFileSync(params.pdfPath));

  const editor = await StyleLockedEditor.open(original, chat, {
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
  });

  try {
    const result = await editor.relayout(params.templateId, params.onProgress);

    const outputPath =
      params.outputPath ??
      params.pdfPath.replace(/\.pdf$/i, ".relayout.pdf");

    writeFileSync(outputPath, result);

    return { outputPath };
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
  const chat = getChatFn();
  const original = new Uint8Array(readFileSync(params.pdfPath));

  const editor = await StyleLockedEditor.open(original, chat, {
    overflow: _config.overflow,
    glossary: _config.glossary,
    fonts: _config.fonts,
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

export const tools = {
  "pdf-edit-page": {
    description:
      "对 PDF 单页进行 AI 文本精修（修正错别字、术语统一、措辞调整），样式锁定不变",
    parameters: {
      type: "object",
      properties: {
        pdfPath: {
          type: "string",
          description: "PDF 文件路径",
        },
        pageNumber: {
          type: "number",
          description: "要编辑的页码（1-based）",
        },
        instruction: {
          type: "string",
          description: "修改指令，如：修正错别字；把「帐号」统一为「账号」",
        },
        targetTids: {
          type: "array",
          items: { type: "string" },
          description: "可选，只编辑这些 tid 对应的文本单元",
        },
        outputPath: {
          type: "string",
          description: "输出文件路径，默认在原文件名后加 .edited",
        },
      },
      required: ["pdfPath", "pageNumber", "instruction"],
    },
    execute: pdfEditEditPage,
  },

  "pdf-edit-document": {
    description:
      "对 PDF 全文进行 AI 批量精修（校对、术语统一、措辞调整），逐页样式锁定",
    parameters: {
      type: "object",
      properties: {
        pdfPath: {
          type: "string",
          description: "PDF 文件路径",
        },
        instruction: {
          type: "string",
          description: "全文修改指令",
        },
        outputPath: {
          type: "string",
          description: "输出文件路径",
        },
      },
      required: ["pdfPath", "instruction"],
    },
    execute: pdfEditDocument,
  },

  "pdf-edit-relayout": {
    description:
      "对 PDF 进行版式重排，可选学术双栏、手机单栏、商务简报三种模板",
    parameters: {
      type: "object",
      properties: {
        pdfPath: {
          type: "string",
          description: "PDF 文件路径",
        },
        templateId: {
          type: "string",
          enum: ["academic", "mobile", "briefing"],
          description:
            "版式模板：academic=学术双栏, mobile=手机单栏, briefing=商务简报",
        },
        outputPath: {
          type: "string",
          description: "输出文件路径",
        },
      },
      required: ["pdfPath", "templateId"],
    },
    execute: pdfEditRelayout,
  },

  "pdf-edit-preview": {
    description: "预览 PDF 某页的可编辑文本单元（tid + text），不做修改",
    parameters: {
      type: "object",
      properties: {
        pdfPath: {
          type: "string",
          description: "PDF 文件路径",
        },
        pageNumber: {
          type: "number",
          description: "页码（1-based）",
        },
      },
      required: ["pdfPath", "pageNumber"],
    },
    execute: pdfEditPreview,
  },
};

export function activate(config?: DshPdfEditConfig): void {
  _config = { ...DEFAULT_CONFIG, ...config };
  _chatFn = null;
  _active = true;
}

export function deactivate(): void {
  _config = { ...DEFAULT_CONFIG };
  _chatFn = null;
  _active = false;
}

export function isActive(): boolean {
  return _active;
}

export function setChatFn(chatFn: ChatFn): void {
  _chatFn = chatFn;
}

export function setLLMAdapter(adapter: LLMAdapter): void {
  _chatFn = adapterToChatFn(adapter);
}