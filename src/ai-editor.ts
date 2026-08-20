import { buildEditPrompt, TEXT_EDIT_SYSTEM_PROMPT } from "./prompts.js";
import { applyGlossary, normalizeGlossary, sleep } from "./util.js";
import { reconcilePatches, type PatchOptions } from "./validator.js";
import type {
  ChatFn,
  ChatMessage,
  EditableUnit,
  Glossary,
  LLMAdapter,
} from "./types.js";

export interface AiEditorConfig {
  maxCharsPerCall?: number;
  maxRetries?: number;
  glossary?: Glossary;
  patch?: PatchOptions;
}

export class AiTextEditor {
  private readonly maxChars: number;
  private readonly maxRetries: number;
  private readonly terms: ReturnType<typeof normalizeGlossary>;
  private readonly patchOpts: PatchOptions;

  constructor(
    private chat: ChatFn,
    cfg: AiEditorConfig = {},
  ) {
    this.maxChars = cfg.maxCharsPerCall ?? 18_000;
    this.maxRetries = cfg.maxRetries ?? 2;
    this.terms = normalizeGlossary(cfg.glossary);
    this.patchOpts = {
      strict: false,
      missingTidsUseOriginal: true,
      ...cfg.patch,
    };
  }

  async edit(
    units: EditableUnit[],
    instruction: string,
  ): Promise<Map<string, string>> {
    if (!units.length) return new Map();

    const merged = new Map<string, string>();
    const chunks = packChunks(units, this.maxChars);

    await Promise.all(
      chunks.map(async (c) => {
        const part = await this.editWithRetry(c, instruction);
        for (const [tid, text] of part) merged.set(tid, text);
      }),
    );

    const reconciled = reconcilePatches(units, merged, this.patchOpts);

    if (!this.terms.length) return reconciled;

    const out = new Map<string, string>();
    for (const [tid, text] of reconciled) {
      out.set(tid, applyGlossary(text, this.terms));
    }

    return out;
  }

  private async editWithRetry(
    units: EditableUnit[],
    instruction: string,
  ): Promise<Map<string, string>> {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const messages: ChatMessage[] = [
          { role: "system", content: TEXT_EDIT_SYSTEM_PROMPT },
          {
            role: "user",
            content: buildEditPrompt(instruction, units, this.terms),
          },
        ];

        const raw = await this.chat(messages, {
          json: true,
          temperature: 0.1,
        });

        return parsePatchObject(raw);
      } catch (e) {
        lastErr = e;
        await sleep(400 * (attempt + 1));
      }
    }

    throw lastErr;
  }
}

function packChunks(
  units: EditableUnit[],
  maxChars: number,
): EditableUnit[][] {
  const chunks: EditableUnit[][] = [];
  let cur: EditableUnit[] = [];
  let size = 0;

  for (const u of units) {
    const cost = u.tid.length + u.text.length + 48;

    if (cur.length && size + cost > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }

    cur.push(u);
    size += cost;
  }

  if (cur.length) chunks.push(cur);
  return chunks;
}

const FENCE = String.fromCharCode(96).repeat(3);
const FENCE_START = new RegExp(`^${FENCE}[a-zA-Z0-9_-]*\\s*`);
const FENCE_END = new RegExp(`\\s*${FENCE}$`);

export function parsePatchObject(raw: string): Map<string, string> {
  let s = raw.trim().replace(FENCE_START, "").replace(FENCE_END, "");

  const l = s.indexOf("{");
  const r = s.lastIndexOf("}");

  if (l >= 0 && r > l) s = s.slice(l, r + 1);

  let obj: any;

  try {
    obj = JSON.parse(s);
  } catch (firstError) {
    try {
      obj = JSON.parse(s.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      throw firstError;
    }
  }

  const items = Array.isArray(obj) ? obj : obj?.items;

  if (!Array.isArray(items)) {
    throw new Error("AI 输出缺少 items 数组");
  }

  const out = new Map<string, string>();

  for (const it of items) {
    if (it && typeof it.tid === "string" && typeof it.text === "string") {
      out.set(it.tid, it.text);
    }
  }

  if (!out.size) {
    throw new Error("AI 输出无有效条目");
  }

  return out;
}

export const adapterToChatFn = (adapter: LLMAdapter): ChatFn =>
  (messages, opts) => adapter.complete(messages, opts);

export function createDeepSeekChatFn(cfg: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}): ChatFn {
  return async (messages, opts) => {
    const base = (cfg.baseUrl ?? "https://api.deepseek.com").replace(
      /\/+$/,
      "",
    );

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model ?? "deepseek-chat",
        messages,
        temperature: opts?.temperature ?? 0.1,
        stream: false,
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
      }),
    });

    if (!res.ok) {
      throw new Error(`DeepSeek API ${res.status}: ${await res.text()}`);
    }

    const data: any = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (typeof content !== "string") {
      throw new Error("DeepSeek 返回结构异常");
    }

    return content;
  };
}