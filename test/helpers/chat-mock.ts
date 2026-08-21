/**
 * 可编排的 ChatFn mock：
 *  - scriptedChat：按文本匹配规则执行“理想 AI”替换（全量回包，符合提示词契约）
 *  - failingChat：先失败 N 次再成功 / 永远失败
 *  - malformedChat：输出非法 JSON / 未知 tid 等，用于校验层测试
 */
import type { ChatFn, ChatMessage, ChatOptions } from "../../src/types.js";

export interface ReplaceRule {
  /** 命中该子串（或正则）的 unit 才会被修改 */
  match: string | RegExp;
  /** 替换后的完整文本；函数形式接收原文本 */
  to: string | ((text: string) => string);
}

export const ruleTo = (rules: ReplaceRule[], text: string): string | null => {
  for (const r of rules) {
    if (typeof r.match === "string" ? text.includes(r.match) : r.match.test(text)) {
      return typeof r.to === "function" ? r.to(text) : r.to;
    }
  }
  return null;
};

/** 从用户提示中解析首个 {"items":[...]} 载荷（非贪婪，避免吃进样例 JSON） */
export function parseUserPayload(content: string): {
  items: Array<{ tid: string; text: string }>;
} {
  const m = content.match(/\{"items":\[.*?\]\}/s);
  if (!m) throw new Error("用户提示中找不到 items 载荷");
  return JSON.parse(m[0]);
}

/** 理想 AI：对所有条目原样返回；命中的按规则替换。记录收到的消息供断言。 */
export function scriptedChat(
  rules: ReplaceRule[],
  opts: { calls?: ChatMessage[][] } = {},
): ChatFn {
  return async (messages: ChatMessage[], _o?: ChatOptions) => {
    opts.calls?.push(messages);
    const userMsg = messages.find((m) => m.role === "user")!.content;
    const payload = parseUserPayload(userMsg);
    const items = payload.items.map((u: { tid: string; text: string }) => ({
      tid: u.tid,
      text: ruleTo(rules, u.text) ?? u.text,
    }));
    return JSON.stringify({ items });
  };
}

/** 统计调用次数的包装器 */
export function counting(chat: ChatFn): { chat: ChatFn; count: () => number } {
  let n = 0;
  return {
    chat: async (...a) => {
      n++;
      return chat(...a);
    },
    count: () => n,
  };
}

/** 前 failTimes 次抛错，之后透传 */
export function flakyChat(chat: ChatFn, failTimes: number): ChatFn {
  let remaining = failTimes;
  return async (...a) => {
    if (remaining-- > 0) throw new Error("transient network error");
    return chat(...a);
  };
}

export const alwaysFails: ChatFn = async () => {
  throw new Error("AI 服务不可用");
};

/** 输出带代码围栏、前后废话和尾逗号的“劣质”JSON，考验解析容错 */
export function messyJsonChat(
  items: Array<{ tid: string; text: string }>,
): ChatFn {
  return async () => {
    const body = items
      .map((i) => `{"tid":"${i.tid}","text":${JSON.stringify(i.text)}}`)
      .join(",\n");
    return (
      "好的，以下是修改结果：\n```json\n{\n  \"items\": [\n" +
      body +
      ",\n  ]\n}\n```\n以上。"
    );
  };
}
