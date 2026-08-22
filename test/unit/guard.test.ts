import { describe, it, expect } from "vitest";
import {
  assertSingleDshTools,
  SCHEDULER_SYMBOL_DESC,
} from "../../src/guard.js";

/** 构造一个带健康调度器 symbol 的 tools 对象 */
function healthyTools() {
  const sym = Symbol(SCHEDULER_SYMBOL_DESC);
  return Object.assign(
    { register() {} },
    { [sym]: { prepare() {}, dispatch() {} } },
  );
}

describe("guard/assertSingleDshTools（双副本诊断）", () => {
  it("健康实例：存在匹配描述且非空的 scheduler symbol → 通过", () => {
    expect(() => assertSingleDshTools({ tools: healthyTools() })).not.toThrow();
  });

  it("ctx.tools 缺失 → 抛出带自愈指引的错误", () => {
    for (const bad of [undefined, {}, null]) {
      let msg = "";
      try {
        // @ts-ignore 故意传坏值
        assertSingleDshTools(bad === null ? { tools: null } : (bad as any));
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain("修复步骤");
      expect(msg).toContain("pnpm remove @deepseek-ai/dsh-tools");
    }
  });

  it("symbol 存在但值为 undefined（双副本失联形态）→ 抛错", () => {
    const sym = Symbol(SCHEDULER_SYMBOL_DESC);
    const broken = Object.assign({ register() {} }, { [sym]: undefined });
    expect(() => assertSingleDshTools({ tools: broken })).toThrow(
      /调度器.*undefined/s,
    );
  });

  it("描述不匹配的无关 symbol 不算命中", () => {
    const sym = Symbol("some.other.symbol");
    const decoy = Object.assign({ register() {} }, { [sym]: {} });
    expect(() => assertSingleDshTools({ tools: decoy })).toThrow(/调度器/);
  });

  it("错误信息包含三条修复命令与 profile 占位符", () => {
    try {
      assertSingleDshTools({});
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("pnpm remove @deepseek-ai/dsh-tools @deepseek-ai/cordis");
      expect(msg).toContain("dsh plugin --profile <profile> remove");
      expect(msg).toContain("rm -rf ~/.dsh/profiles/<profile>/node_modules");
      expect(msg).toContain("新建会话");
    }
  });
});
