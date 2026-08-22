/**
 * 双副本守卫 —— 防止 @deepseek-ai/dsh-tools 被加载多份导致的调度器失联。
 *
 * 背景：dsh-tools 把并行调度器挂在实例的 Symbol 键上：
 *   const TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler");
 * 该 Symbol 不在全局注册表（Symbol() 而非 Symbol.for()），因此当进程内存在
 * 第二份 dsh-tools 副本时，消费方（dsh-agent-loop）用它自己的 Symbol 去读
 * `registry[TOOL_RUNTIME_SCHEDULER]` 会得到 undefined，随后在 `.prepare` 处
 * 抛出 "Cannot read properties of undefined"。
 *
 * 本守卫在插件装载时主动反查：ctx.tools 上是否存在描述匹配且值非空的
 * Symbol 属性。不存在 → 结构化诊断 + 自愈命令，把静默崩溃变成 30 秒可修。
 */

/** 与 dsh-tools 源码中的 Symbol 描述字符串逐字对齐 */
export const SCHEDULER_SYMBOL_DESC = "@deepseek-ai/dsh-tools.scheduler";

const RECOVERY_STEPS = [
  "修复步骤（任选其一，完成后重启 dsh 并【新建会话】验证）：",
  "  1. 移除 profile 中被物化的核心包副本（推荐）：",
  "     cd ~/.dsh/profiles/<profile> && \\",
  "       pnpm remove @deepseek-ai/dsh-tools @deepseek-ai/cordis",
  "  2. 或移除近期新装的插件后重试：",
  "     dsh plugin --profile <profile> remove <嫌疑插件>",
  "  3. 或重置 profile 依赖树（会重装全部插件依赖）：",
  "     rm -rf ~/.dsh/profiles/<profile>/node_modules && dsh plugin --profile <profile> add dsh-pdf-edit",
  "",
  "注意：崩溃过的旧会话日志已损坏，无法恢复。",
].join("\n");

/**
 * 断言 ctx.tools 上挂载了可用的工具运行时调度器。
 * 必须在任何 ctx.tools 访问之前调用。
 *
 * @throws 带自愈指引的 Error（检测不到匹配的 scheduler symbol 时）
 */
export function assertSingleDshTools(ctx: {
  tools?: unknown;
}): void {
  const tools = ctx?.tools as Record<PropertyKey, unknown> | undefined;
  if (!tools || typeof tools !== "object") {
    throw new Error(schedulerMissing("当前上下文没有注入 tools 服务"));
  }

  // 反查：健康实例上必有一个 description 匹配、值非空的 Symbol 属性。
  // 注意不能用 Symbol.keyFor —— dsh 用的是非注册表 Symbol。
  let found = false;
  for (const sym of Object.getOwnPropertySymbols(tools)) {
    if (sym.description === SCHEDULER_SYMBOL_DESC && (tools as any)[sym] != null) {
      found = true;
      break;
    }
  }

  if (!found) {
    throw new Error(
      schedulerMissing(
        `ctx.tools 上找不到 ${SCHEDULER_SYMBOL_DESC} 调度器（读到的是 undefined）`,
      ),
    );
  }
}

function schedulerMissing(detail: string): string {
  return [
    `[dsh-pdf-edit] ${detail}`,
    "",
    "这通常意味着 @deepseek-ai/dsh-tools 在当前进程中被加载了多份",
    "（常见诱因：在 profile 目录下手动执行过 pnpm install；或某个插件把",
    "核心包声明为普通 dependencies，导致 pnpm 物化出第二份副本）。",
    "",
    RECOVERY_STEPS,
  ].join("\n");
}
