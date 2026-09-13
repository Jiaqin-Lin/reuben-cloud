/**
 * Phase 1 · 政策与提示词（循环之外、但决定"什么时候停、系统提示词长什么样"）。
 *
 * 对应 spec 测试要点 9（策略停下——策略本身的原因与数值在这里单独验）、11（前缀稳定性）、
 * 以及设计文档 §B.4 的"压缩摘要不能伪装成用户指令"。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultConvertToLlm, renderCompactionSummary } from "../src/loop.ts";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_OUTPUT_TOKEN_BUDGET,
  DEFAULT_WALL_CLOCK_MS,
  createRepeatGuard,
  defaultStopPolicy,
  signatureOf,
  stableJson,
} from "../src/limits.ts";
import { buildSystemPrompt, ROLE_PROMPT } from "../src/prompt/system.ts";
import { buildTaskPrompt, initialMessages } from "../src/prompt/task.ts";
import type { AgentMessage, AssistantMessage, ShouldStopAfterTurnContext } from "../src/types.ts";

function turnContext(outputTokens: number): ShouldStopAfterTurnContext {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "x" }],
    stopReason: "toolUse",
    usage: { inputTokens: 1, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  };
  return { message, toolResults: [], context: { systemPrompt: "s", messages: [] }, newMessages: [message] };
}

describe("Phase 1 · 默认停止策略", () => {
  test("三个默认值就是 M0 的 40 轮 / 30 分钟 / 300k 输出 token", () => {
    assert.equal(DEFAULT_MAX_TURNS, 40);
    assert.equal(DEFAULT_WALL_CLOCK_MS, 30 * 60_000);
    assert.equal(DEFAULT_OUTPUT_TOKEN_BUDGET, 300_000);
  });

  test("轮数上限：第 maxTurns 轮结束返回 true，原因与描述一致", () => {
    const policy = defaultStopPolicy({ maxTurns: 3, wallClockMs: 60_000, outputTokenBudget: 1_000_000 });
    assert.equal(policy.shouldStopAfterTurn(turnContext(1)), false);
    assert.equal(policy.shouldStopAfterTurn(turnContext(1)), false);
    assert.equal(policy.shouldStopAfterTurn(turnContext(1)), true);
    assert.equal(policy.stopReason, "max_turns");
    assert.match(policy.detail ?? "", /3 轮/);
  });

  test("墙钟上限：拨快时钟 → wall_clock", () => {
    let now = 1_000;
    const policy = defaultStopPolicy(
      { maxTurns: 100, wallClockMs: 5_000, outputTokenBudget: 1_000_000 },
      { now: () => now },
    );
    assert.equal(policy.deadline, 6_000);
    assert.equal(policy.shouldStopAfterTurn(turnContext(1)), false);
    now = 6_000;
    assert.equal(policy.shouldStopAfterTurn(turnContext(1)), true);
    assert.equal(policy.stopReason, "wall_clock");
  });

  test("累计输出 token 上限：跨轮累加（不是单轮）", () => {
    const policy = defaultStopPolicy({ maxTurns: 100, wallClockMs: 60_000, outputTokenBudget: 100 });
    assert.equal(policy.shouldStopAfterTurn(turnContext(40)), false);
    assert.equal(policy.shouldStopAfterTurn(turnContext(40)), false);
    assert.equal(policy.shouldStopAfterTurn(turnContext(40)), true);
    assert.equal(policy.stopReason, "output_token_budget");
    assert.equal(policy.outputTokens, 120);
  });

  test("轮数优先于墙钟与 token（顺序与 M0 一致）", () => {
    let now = 0;
    const policy = defaultStopPolicy(
      { maxTurns: 1, wallClockMs: 0, outputTokenBudget: 0 },
      { now: () => now++ },
    );
    assert.equal(policy.shouldStopAfterTurn(turnContext(999)), true);
    assert.equal(policy.stopReason, "max_turns");
  });
});

describe("Phase 1 · 重复守卫的签名语义", () => {
  test("签名的 JSON 稳定（键顺序不影响）：同样参数 = 同样签名", () => {
    assert.equal(signatureOf({ name: "read", arguments: { a: 1, b: [2, { c: 3 }] } }), signatureOf({ name: "read", arguments: { b: [2, { c: 3 }], a: 1 } }));
    assert.equal(signatureOf({ name: "read", arguments: { a: 1 } }), 'read({"a":1})');
    assert.equal(stableJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  });

  test("阈值可配：notice=2、stop=3 时第 2 次提示、第 3 次停", async () => {
    const guard = createRepeatGuard({ noticeThreshold: 2, stopThreshold: 3 });
    const call = (name: string, args: Record<string, unknown>, id: string) => {
      const toolCall = { type: "toolCall" as const, id, name, arguments: args };
      const assistantMessage: AssistantMessage = { role: "assistant", content: [toolCall] };
      return guard.beforeToolCall({
        assistantMessage,
        toolCall,
        args,
        context: { systemPrompt: "s", messages: [] },
      });
    };
    assert.equal(await call("read", { path: "a" }, "b1"), undefined);
    const notice = await call("read", { path: "a" }, "b2");
    assert.equal(notice?.block, true);
    assert.equal(notice?.terminate, undefined);
    const stop = await call("read", { path: "a" }, "b3");
    assert.equal(stop?.terminate, true);
    assert.equal(guard.stopped, true);
  });
});

describe("Phase 1 · 提示词组装", () => {
  test("用例 11：同一输入两次构造的 system 逐字节相同（缓存前缀的前提）", () => {
    const input = {
      sandbox: { repoDir: "/workspace/repo", health: "集成测试不可用（compose 服务缺失）" },
      skills: "<available_skills>\n  <skill><name>make-release</name></skill>\n</available_skills>",
      changedFiles: ["src/a.ts", "src/b.ts"],
      notes: ["代理只放行依赖源。"],
    };
    const a = buildSystemPrompt(input);
    const b = buildSystemPrompt(input);
    assert.equal(a, b);
    assert.ok(a.startsWith(ROLE_PROMPT));
    // 分区顺序固定：角色 → 沙箱事实 → 技能 → 已改动 → 提醒。
    const order = ["工作目录是", "available_skills", "已改动", "代理只放行依赖源"];
    let cursor = -1;
    for (const marker of order) {
      const index = a.indexOf(marker);
      assert.ok(index > cursor, `分区顺序不对：${marker} 出现在 ${index}，上一个在 ${cursor}`);
      cursor = index;
    }
  });

  test("空分区不产生空行：不给技能/改动文件时与\"没有这一段代码\"一致", () => {
    const bare = buildSystemPrompt();
    assert.equal(buildSystemPrompt({ skills: null, changedFiles: [] }), bare);
    assert.equal(buildSystemPrompt({ skills: "  ", notes: ["  "] }), bare);
    assert.ok(!bare.includes("已改动"));
  });

  test("任务书含 issue 原文与分隔线；初始消息是一条 user", () => {
    const prompt = buildTaskPrompt("修一下登录");
    assert.match(prompt, /---- issue ----\n修一下登录\n---- issue 结束 ----/);
    const messages = initialMessages("修一下登录");
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.role, "user");
  });

  test("压缩摘要渲染成带前缀的 user 文本（不是新指令）", () => {
    const messages: AgentMessage[] = [
      { role: "compactionSummary", summary: "已经改完 A、正在改 B", firstKeptEntryId: "ent_1", tokensBefore: 120_000 },
      { role: "custom", customType: "skillNote", content: "读了 make-release 技能", display: true },
    ];
    const converted = defaultConvertToLlm(messages);
    assert.equal(converted.length, 2);
    assert.match(String(converted[0]!.role === "user" ? converted[0]!.content : ""), /不是新的指令/);
    assert.match(String(converted[1]!.role === "user" ? converted[1]!.content : ""), /\[系统提示\]/);
    assert.match(renderCompactionSummary({ role: "compactionSummary", summary: "S", firstKeptEntryId: "e", tokensBefore: 1 }), /S/);
  });
});
