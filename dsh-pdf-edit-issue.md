# Issue: 应通过 ctx.llm 复用 DSH 已有 LLM 服务，而非自建 DeepSeek API 连接

## 问题描述

插件当前完全绕过了 DSH 的 LLM 服务，自建了一个直连 DeepSeek API 的 HTTP 客户端。这意味着：

1. **无法复用 DSH 当前会话的模型和凭据** — 即使 DSH 配置了 Agnes/OpenAI/其他 provider，插件仍需单独配置 `DEEPSEEK_API_KEY` 或 `apiKey`/`baseUrl`/`model` config
2. **需要用户手动填 key** — 破坏了 DSH "一个 key 管所有模型" 的设计
3. **绕过了 pi-ai 的多 provider 路由** — 无法使用 opencode-go、openrouter 等已注册的 provider

---

## 代码证据

### 1. `inject` 只声明了 `["tools"]`（index.js:167）

```js
export const inject = ["tools"];
```

根本没有请求 `"llm"` 服务，所以 `ctx.llm` 从未被使用。

### 2. `getChatFn()` 自建 HTTP fetch（index.js:49-68）

```js
function getChatFn() {
    if (_chatFn) return _chatFn;
    const apiKey = process.env.DEEPSEEK_API_KEY ?? _config.apiKey;  // 只认 DeepSeek key
    if (!apiKey) throw new Error("dsh-pdf-edit: 请设置 DEEPSEEK_API_KEY");
    if (!/^sk-[A-Za-z0-9\-_]{8,}$/.test(apiKey)) throw ...  // 硬编码 key 格式
    _chatFn = createDeepSeekChatFn({ apiKey, baseUrl, model });
    return _chatFn;
}
```

### 3. `createDeepSeekChatFn` 直接 fetch（ai-editor.js:171-199）

```js
fetch(`${base}/chat/completions`, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
        model: cfg.model ?? "deepseek-chat",
        messages, temperature: 0.1, stream: false
    })
})
```

完全不经过 `ctx.llm`，且只支持 DeepSeek 官方 endpoint。

---

## DSH 已有的 LLM 服务接口

DSH 通过 cordis context 暴露 `ctx.llm`（`LlmRuntime` 实例），提供：

```typescript
// LlmRuntime.stream(options: GenerateOptions): AsyncIterable<StreamChunk>
interface GenerateOptions {
  provider: string;        // e.g. "agnes", "deepseek", "opencode-go"
  model: string;           // e.g. "agnes-2.5-flash", "deepseek-v4-flash"
  messages: Message[];     // DSH 标准消息格式
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

// StreamChunk 包含 text-delta、block-end(text)、finish 等类型
type StreamChunk =
  | { type: "text-delta"; index: number; text: string }
  | { type: "block-end"; index: number; block: TextBlock }
  | { type: "finish"; reason: FinishReason }
  | ...
```

优势：
- 自动从凭证管理器（`.credentials.yaml`）读取 key，无需用户配置
- 路由到所有 pi-ai 已注册的 provider（OpenAI、Anthropic、DeepSeek、opencode-go 等）
- 与 `agent-default-model` 设置联动
- 支持流式处理和重试

---

## 建议修复方案

### 修改 `inject`，增加 `"llm"`

```js
// 改前
export const inject = ["tools"];
// 改后
export const inject = ["tools", "llm"];
```

### 在 `apply(ctx)` 中接入 DSH LLM 服务

```ts
export async function apply(ctx, config) {
    assertSingleDshTools(ctx);
    if (config) {
        const chatAffecting = ["apiKey", "baseUrl", "model"];
        if (chatAffecting.some((k) => k in config)) _chatFn = null;
        _config = { ..._config, ...config };
    }

    const llm = ctx.get("llm");
    if (llm) {
        // 使用 DSH 已有 LLM 服务，无需手动配置 key
        _chatFn = async (messages: ChatMessage[], opts?: ChatOptions) => {
            const provider = _config.provider ?? _resolveProvider(ctx);
            const model = _config.model ?? _resolveModel(ctx);
            const dshMessages = messages.map(m => ({
                role: m.role as "user" | "assistant" | "system",
                content: m.content
            }));
            const chunks: string[] = [];
            for await (const chunk of llm.stream({
                provider,
                model,
                messages: dshMessages,
                temperature: opts?.temperature ?? 0.1,
                maxTokens: opts?.maxTokens,
            })) {
                if (chunk.type === "text-delta") {
                    chunks.push(chunk.text);
                } else if (chunk.type === "block-end" && chunk.block.type === "text") {
                    chunks.push(chunk.block.text);
                }
            }
            return chunks.join("");
        };
    } else {
        // fallback: 原有手动 key 模式（向后兼容）
        _chatFn = getChatFn();
    }

    // ... 注册工具的代码不变
}
```

### `_resolveProvider()` 辅助函数

从 DSH settings 读取默认 provider/model：

```ts
function _resolveProvider(ctx): string {
    // 优先读 config，其次读 settings 中的 agent-default-model
    return _config.provider || ctx.get("settings")?.get("agent-default-model")?.provider || "agnes";
}

function _resolveModel(ctx): string {
    return _config.model || ctx.get("settings")?.get("agent-default-model")?.model || "agnes-2.5-flash";
}
```

---

## 修复后效果

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 使用 DSH 配置的 Agnes 模型 | ❌ 需要手动填 apiKey/baseUrl | ✅ 自动复用，零配置 |
| 使用 OpenAI GPT-4o | ❌ 不支持（key 格式校验失败） | ✅ 通过 pi-ai 路由 |
| 使用本地 Ollama | ❌ key 格式不匹配 | ✅ 通过 pi-ai opencode provider |
| 使用 DeepSeek 官方 API | ✅ 可用 | ✅ 仍可用（fallback） |
| 离线环境无网络 | ❌ 报错 | ❌ 仍报错（正确行为） |

---

## 影响范围

- 修复后用户可以直接用 DSH 配置的任意模型编辑 PDF，无需额外配置 key
- 与 DSH 的 `agent-default-model` 设置自动联动
- 支持所有 pi-ai 已注册的 provider（deepseek-v4-flash、gpt-4o、claude、opencode-go 等）
- 现有配置 `baseUrl`/`model`/`apiKey` 仍可作为 override 保留（向后兼容）

---

## 环境信息

- DSH 版本: `0.1.0-rc.8`
- 插件版本: `dsh-pdf-edit@0.1.7`
- 当前 agent-default-model: `agnes / agnes-2.5-flash`
- pi-ai provider 列表: deepseek、opencode-go、openai、anthropic、google 等 30+ 个
