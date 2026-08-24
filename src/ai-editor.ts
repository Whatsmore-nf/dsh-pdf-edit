import { buildEditPrompt, TEXT_EDIT_SYSTEM_PROMPT } from "./prompts.js";
import { applyGlossary, normalizeGlossary, pLimit, sleep } from "./util.js";
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
  /** 重试退避基数（毫秒），第 n 次重试等待 base*n；测试可设为 0 加速 */
  retryBaseMs?: number;
  /** 分块并发上限（默认 3），防止长文档打爆 API 触发 429 */
  chunkConcurrency?: number;
  glossary?: Glossary;
  patch?: PatchOptions;
}

/* ------------------------------------------------------------------ */
/* Prompt injection 特征检测（对 AI 输出做二次校验）                     */
/* ------------------------------------------------------------------ */

const INJECTION_PATTERNS: RegExp[] = [
  /(?:ignore|disregard|disregarding|忘记|忽略).{0,24}(?:instruction|instructions|previous|above|上述|规则|指令)/i,
  /(?:read|write|access|open|访问|读取|写入|打开).{0,24}(?:\/etc\/|\/proc\/|\.ssh\/|~\/|password|passwd|文件系统)/i,
  /<(?:script|iframe|object|embed|link)\b/i,
  /(?:call|invoke|use|调用|执行|运行).{0,16}(?:tool|function|pdf-edit|shell|命令行)/i,
];

/** 疑似 prompt injection 的输出文本（命中即丢弃该条，回退原文） */
export function looksInjected(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

export class AiTextEditor {
  private readonly maxChars: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly chunkConcurrency: number;
  private readonly terms: ReturnType<typeof normalizeGlossary>;
  private readonly patchOpts: PatchOptions;

  constructor(
    private chat: ChatFn,
    cfg: AiEditorConfig = {},
  ) {
    this.maxChars = cfg.maxCharsPerCall ?? 18_000;
    this.maxRetries = cfg.maxRetries ?? 2;
    this.retryBaseMs = cfg.retryBaseMs ?? 400;
    this.chunkConcurrency = cfg.chunkConcurrency ?? 3;
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

    // 并发限流：避免长文档一次性打出大量请求（429 风暴 / 内存暴涨）
    const limit = pLimit(this.chunkConcurrency);
    await Promise.all(
      chunks.map((c) =>
        limit(async () => {
          const part = await this.editWithRetry(c, instruction);
          for (const [tid, text] of part) {
            // 注入二次校验：AI 输出命中注入特征 → 丢弃该条，走原文回退
            if (looksInjected(text)) {
              console.warn(
                `[dsh-pdf-edit] 检测到疑似注入输出 tid=${tid}，已拒绝该条目并回退原文`,
              );
              continue;
            }
            merged.set(tid, text);
          }
        }),
      ),
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
      } catch (e: any) {
        lastErr = e;
        // 429 感知退避 + 与基数成比例的 jitter（retryBaseMs=0 时零等待，便于测试）
        const msg = String(e?.message ?? e);
        const isRateLimit = /\b429\b|rate.?limit|too many requests/i.test(msg);
        const base = isRateLimit ? Math.max(this.retryBaseMs, 2000) : this.retryBaseMs;
        const jitter = Math.random() * base * 0.5;
        await sleep(base * (attempt + 1) + jitter);
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

/** AI 原始输出总长度上限（防截断/异常响应撑爆内存） */
const MAX_RAW_OUTPUT_CHARS = 2 * 1024 * 1024;
/** 单条 tid/text 长度上限；超限条目直接跳过（不抛错，保持容错解析语义） */
const MAX_TID_LEN = 64;
const MAX_TEXT_LEN = 8192;
/** 条目数上限 */
const MAX_ITEMS = 10_000;

export function parsePatchObject(raw: string): Map<string, string> {
  if (raw.length > MAX_RAW_OUTPUT_CHARS) {
    throw new Error(`AI 输出超过 ${MAX_RAW_OUTPUT_CHARS} 字符，疑似异常响应`);
  }

  let s = raw.trim().replace(FENCE_START, "").replace(FENCE_END, "");

  // 容错候选：模型常会在 JSON 前后附带说明文字。
  //  1) 原样（完整对象 / 顶层数组）
  //  2) 花括号截取（对象 + 前后说明）
  //  3) 方括号截取（顶层数组 + 尾部说明，如"已修改 N 条"）
  const candidates: string[] = [s];
  const lb = s.indexOf("{");
  const rb = s.lastIndexOf("}");
  if (lb >= 0 && rb > lb) candidates.push(s.slice(lb, rb + 1));
  const la = s.indexOf("[");
  const ra = s.lastIndexOf("]");
  if (la >= 0 && ra > la) candidates.push(s.slice(la, ra + 1));

  let obj: any;
  let lastErr: unknown;
  for (const cand of [...new Set(candidates)]) {
    for (const text of [cand, cand.replace(/,\s*([}\]])/g, "$1")]) {
      try {
        const parsed = JSON.parse(text);
        // 只接受能提供 items 的候选；否则（如数组内单个对象被花括号截取出来）
        // 继续尝试下一个候选，避免误吞。
        if (Array.isArray(parsed) || Array.isArray(parsed?.items)) {
          obj = parsed;
          break;
        }
        lastErr = new Error("AI 输出缺少 items 数组");
      } catch (e) {
        lastErr = e;
      }
    }
    if (obj !== undefined) break;
  }
  if (obj === undefined) throw lastErr;

  const items = Array.isArray(obj) ? obj : obj?.items;

  if (!Array.isArray(items)) {
    throw new Error("AI 输出缺少 items 数组");
  }
  if (items.length > MAX_ITEMS) {
    throw new Error(`AI 输出条目数超过上限 ${MAX_ITEMS}`);
  }

  const out = new Map<string, string>();

  for (const it of items) {
    // 逐条轻量 schema：类型/长度不合规的条目跳过（与既有"非字符串字段跳过"语义一致）
    if (it && typeof it.tid === "string" && typeof it.text === "string") {
      if (it.tid.length === 0 || it.tid.length > MAX_TID_LEN) continue;
      if (it.text.length > MAX_TEXT_LEN) continue;
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
  /** 请求超时（毫秒），默认 120_000 */
  timeoutMs?: number;
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
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 120_000), // 2 分钟超时，防挂起
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