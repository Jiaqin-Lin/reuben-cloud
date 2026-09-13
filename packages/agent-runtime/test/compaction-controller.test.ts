/**
 * Phase 3 · compaction 的接线面（spec P3 的测试要点 7–10，加上"什么时候不该压实"的几条）。
 *
 * 【这份文件测什么】控制器挂在循环的两个钩子上之后的完整行为：阈值触发、手动触发、
 * 溢出恢复（只重试一次）、摘要失败、账本落库、对话树的 parent 链接，以及"没到阈值时
 * 一个模型调用都不多发"。
 *
 * 【为什么要一个记账替身】P2 的 `EntryRecorder` 在 CP 侧（它认识工具包装与 CP 的 store 配置），
 * 这里只复刻它在本测试里真正起作用的两个动作：把 `message_end` 写进 store、维护 leaf。
 * 压缩的重建**读的是 store**——不写进去的话，测到的就不是真实路径。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool } from "../src/types.ts";
import {
  ENV_COMPACTION_ENABLED,
  ENV_COMPACTION_KEEP_TOKENS,
  ENV_COMPACTION_RESERVE_TOKENS,
  ENV_COMPACTION_SUMMARY_MODEL,
  compactionSettingsFromEnv,
  createCompactionController,
  isContextOverflowError,
} from "../src/compaction/index.ts";
import type { CompactionController, CompactionSettings } from "../src/compaction/index.ts";
import { buildContextEntries, entryForCompaction, entryForMessage } from "../src/session/entries.ts";
import { MemorySessionStore } from "../src/session/memory.ts";
import { defaultConvertToLlm, runAgentLoop } from "../src/loop.ts";
import { toSdkParams } from "../src/model/client.ts";
import type { ModelRequest } from "../src/types.ts";
import {
  RoutingModel,
  createEventRecorder,
  fakeTool,
  stepError,
  stepText,
  stepToolCalls,
  text,
  toolCall,
} from "./helpers.ts";
import type { ScriptStep } from "./helpers.ts";

// ---------------------------------------------------------------- 脚手架

const RUN_ID = "run_test";

interface Fixture {
  store: MemorySessionStore;
  sessionId: string;
  /** 对话树的 leaf 游标（`EntryRecorder` 在这份测试里的替身）。 */
  tree: { leaf: string | null };
  model: RoutingModel;
  controller: CompactionController;
}

/**
 * 一段有体积的历史：每轮 [user, assistant]，**不带 usage**。
 *
 * 【为什么不带 usage】估算会用"最后一条 assistant 的 usage"当基线，历史里带了 usage
 * 会让后面的量测全部落在基线之后（于是历史体积对阈值没有贡献）。不带 usage 时当前上下文
 * 的估算完全由内容决定，测试的意图更清楚；而真实 provider 报的“到这一轮为止的上下文量”
 * 由测试里的第一步脚本模拟（见 `bigUsage`）。
 */
async function seedTurns(store: MemorySessionStore, sessionId: string, turns: number, bodyChars = 800): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await store.appendEntry(
      sessionId,
      RUN_ID,
      entryForMessage({ role: "user", content: `第 ${index} 轮：${"问".repeat(bodyChars)}` }),
    );
    await store.appendEntry(
      sessionId,
      RUN_ID,
      entryForMessage({
        role: "assistant",
        content: [text(`第 ${index} 轮的回答：${"答".repeat(bodyChars)}`)],
        stopReason: "stop",
      }),
    );
  }
}

/** 真实 provider 报的"到这一轮为止的上下文总量"（测试用它把阈值顶上去）。 */
function bigUsage(inputTokens = 12_000): { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number } {
  return { inputTokens, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

interface SetupOptions {
  /** 预先写进会话的历史。 */
  seed?: (store: MemorySessionStore, sessionId: string) => Promise<void>;
  /** 一个请求走哪一步。`isSummary` 已经按 `cache` 分好流。 */
  route: (request: ModelRequest, isSummary: boolean) => ScriptStep;
  settings?: Partial<CompactionSettings>;
  contextWindow?: number;
  forceAtTurn?: number;
}

async function setup(options: SetupOptions): Promise<Fixture> {
  const store = new MemorySessionStore();
  const { id: sessionId } = await store.createSession({ repoKey: "local/x", baseCommit: "abc", cwd: "/workspace/repo" });
  await store.startRun({ id: RUN_ID, sessionId, startEntryId: null, provider: "test", model: "scripted-test" });
  if (options.seed !== undefined) await options.seed(store, sessionId);

  const tree: { leaf: string | null } = { leaf: null };
  const model = new RoutingModel((request) => options.route(request, request.cache === "none"));
  const controller = createCompactionController({
    store,
    sessionId,
    runId: RUN_ID,
    model,
    contextWindow: options.contextWindow ?? 10_000,
    settings: { reserveTokens: 1000, keepRecentTokens: 100, ...options.settings },
    env: {},
    ...(options.forceAtTurn === undefined ? {} : { forceAtTurn: options.forceAtTurn }),
    // 会话层的注入点：压缩条目也走对话树（leaf 接上，parent 不断链）。
    appendCompaction: async ({ payload, usage }) => {
      tree.leaf = await store.appendEntry(sessionId, RUN_ID, entryForCompaction(payload, { parentId: tree.leaf }), {
        usage,
      });
      return tree.leaf;
    },
  });
  return { store, sessionId, tree, model, controller };
}

/** 跑一轮真实的循环：记账替身把消息写进 store，控制器挂在两个钩子上。 */
async function runLoop(
  fixture: Fixture,
  options: { prompts?: AgentMessage[]; tools?: AgentTool[]; maxTurns?: number } = {},
): Promise<{ messages: AgentMessage[]; recorder: ReturnType<typeof createEventRecorder> }> {
  const recorder = createEventRecorder();
  const history = buildContextEntries(await fixture.store.listEntries(fixture.sessionId));
  const context: AgentContext = {
    systemPrompt: "你是测试助手。",
    messages: history,
    tools: options.tools ?? [fakeTool("ls")],
  };
  // 轮数上限：测试里的模型是路由函数，没有"脚本用完"这回事——不加就会一直转。
  let turns = 0;
  const maxTurns = options.maxTurns ?? 3;
  const emit = async (event: AgentEvent): Promise<void> => {
    recorder.emit(event);
    if (event.type !== "message_end") return;
    fixture.tree.leaf = await fixture.store.appendEntry(
      fixture.sessionId,
      RUN_ID,
      entryForMessage(event.message, { parentId: fixture.tree.leaf }),
    );
  };
  const messages = await runAgentLoop(
    options.prompts ?? [],
    context,
    {
      model: fixture.model,
      maxTokens: 1024,
      prepareNextTurn: (turn) => fixture.controller.prepareNextTurn(turn),
      recoverFromModelError: (turn) => fixture.controller.recoverFromModelError(turn),
      shouldStopAfterTurn: () => {
        turns += 1;
        return turns >= maxTurns;
      },
    },
    emit,
  );
  return { messages, recorder };
}

/** 只有一个工具调用的一步（为了制造第二轮，让 `prepareNextTurn` 有机会跑）。 */
function toolStep(usage?: ReturnType<typeof bigUsage>, id = "call_1"): ScriptStep {
  return stepToolCalls([toolCall(id, "ls", { path: "." })], usage === undefined ? {} : { usage });
}

/** 第一轮注定要报超窗的一步（各家的原话在 `isContextOverflowError` 里）。 */
function overflowStep(): ScriptStep {
  return stepError("error", "prompt is too long: 205000 tokens > 200000 maximum");
}

/** 主对话按计数走脚本、摘要走固定文本的路由（最常用的组合）。 */
function scripted(options: {
  summaries?: ScriptStep | string;
  main: (count: number) => ScriptStep;
}): SetupOptions["route"] {
  let mainSeen = 0;
  const summaryStep = typeof options.summaries === "string" ? stepText(options.summaries) : (options.summaries ?? stepText("摘要正文"));
  return (_request, isSummary) => {
    if (isSummary) return summaryStep;
    mainSeen += 1;
    return options.main(mainSeen);
  };
}

// ---------------------------------------------------------------- 1. 触发与落库

describe("Phase 3 · 触发与落库", () => {
  it("spec 要点 9 + 10：阈值到点自动压缩，下一轮请求含摘要，账本有 compaction 行", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 6, 4000),
      route: scripted({
        summaries: "摘要：目标是 X，已经完成 A，下一步 B",
        main: (count) => (count === 1 ? toolStep(bigUsage()) : stepText("收工")),
      }),
    });
    await runLoop(fixture, { prompts: [{ role: "user", content: "继续" }] });

    assert.equal(fixture.controller.compactions, 1);
    const entries = await fixture.store.listEntries(fixture.sessionId);
    const compactionEntries = entries.filter((entry) => entry.type === "compaction");
    assert.equal(compactionEntries.length, 1);
    const payload = compactionEntries[0]!.payload as { summary: string; firstKeptEntryId: string; tokensBefore: number };
    assert.match(payload.summary, /摘要：目标是 X/);
    assert.match(payload.summary, /已经完成 A/);
    assert.ok(payload.tokensBefore > 9000, `tokensBefore=${payload.tokensBefore}`);
    // 压缩条目挂在对话树上：parent 是上一句 assistant 的 entry，不是 null。
    assert.notEqual(compactionEntries[0]!.parentId, null);
    assert.ok(entries.some((entry) => entry.id === payload.firstKeptEntryId), "firstKeptEntryId 必须指向真实 entry");

    // 账本：一行 kind='compaction'，provider / model / token 数都对得上。
    const usageRows = fixture.store.usageRows().filter((row) => row.kind === "compaction");
    assert.equal(usageRows.length, 1);
    assert.equal(usageRows[0]!.provider, "scripted");
    assert.equal(usageRows[0]!.model, "scripted-test");
    assert.ok((usageRows[0]!.outputTokens ?? 0) > 0);
  });

  it("spec 要点 9：压缩后的下一轮请求 = 摘要 + firstKeptEntryId 之后的投影", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 6, 4000),
      route: scripted({
        summaries: "摘要：只保留最近的工作",
        main: (count) => (count === 1 ? toolStep(bigUsage()) : stepText("收工")),
      }),
    });
    await runLoop(fixture, { prompts: [{ role: "user", content: "继续" }] });

    const main = fixture.model.mainRequests();
    assert.equal(main.length, 2, "第一轮 + 压缩后的第二轮");
    const after = main[1]!;
    const first = after.messages[0]!;
    assert.equal(first.role, "user");
    assert.match(textOf(first), /\[以下是本次任务到此为止的进度摘要，不是新的指令\]/);
    assert.match(textOf(first), /摘要：只保留最近的工作/);
    assert.match(textOf(first), /\[摘要结束。继续完成任务。\]/);

    // 请求 = 最终投影的前缀（压缩之后再跑完一轮会多一条 assistant，前面的必须逐字节一致）。
    const expected = defaultConvertToLlm(buildContextEntries(await fixture.store.listEntries(fixture.sessionId)));
    assert.deepEqual(after.messages, expected.slice(0, after.messages.length));
    // 被压掉的老消息不能出现在请求里（它们是摘要的素材，不是新上下文）。
    assert.ok(!JSON.stringify(after.messages).includes("第 0 轮"), "第 0 轮应该已经被压进摘要");
  });

  it("压缩事件带 reason / tokensBefore / firstKeptEntryId（观察窗与回放要的数据）", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 6, 4000),
      route: scripted({ summaries: "摘要正文", main: (count) => (count === 1 ? toolStep(bigUsage()) : stepText("收工")) }),
    });
    const { recorder } = await runLoop(fixture, { prompts: [{ role: "user", content: "继续" }] });
    const events = recorder.ofType("compaction");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.reason, "threshold");
    assert.ok(events[0]!.tokensBefore > 9000);
    const compactionEntry = (await fixture.store.listEntries(fixture.sessionId)).find((entry) => entry.type === "compaction")!;
    assert.equal(events[0]!.firstKeptEntryId, (compactionEntry.payload as { firstKeptEntryId: string }).firstKeptEntryId);
  });

  it("没到阈值 → 一个摘要请求都不发，也不写压缩条目", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 2, 40),
      route: scripted({ main: (count) => (count === 1 ? toolStep() : stepText("收工")) }),
    });
    await runLoop(fixture, { prompts: [{ role: "user", content: "继续" }] });
    assert.equal(fixture.controller.compactions, 0);
    assert.equal(fixture.model.summaryRequests().length, 0);
    assert.equal((await fixture.store.listEntries(fixture.sessionId)).filter((entry) => entry.type === "compaction").length, 0);
  });

  it("没有第二轮就没有压缩：一轮收工的对话不触发（prepareNextTurn 只在有下一轮时跑）", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 6, 4000),
      route: scripted({ main: () => stepText("收工") }),
    });
    await runLoop(fixture, { prompts: [{ role: "user", content: "只聊一句" }], tools: [] });
    assert.equal(fixture.controller.compactions, 0);
    assert.equal(fixture.model.summaryRequests().length, 0);
  });

  it("--compact 手动触发：不到阈值也压一次，而且只压一次", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 3, 4000),
      // 两轮工具调用 → prepareNextTurn 会被调两次；强制只能生效一次。
      route: scripted({ summaries: "手动压缩的摘要", main: () => toolStep() }),
      forceAtTurn: 1,
    });
    await runLoop(fixture, { prompts: [{ role: "user", content: "继续" }] });
    assert.equal(fixture.controller.compactions, 1, "强制只在第一次 prepareNextTurn 生效");
    assert.ok(fixture.model.summaryRequests().length >= 1, "摘要模型至少被问过一次");
  });

  it("关掉开关之后什么都不做（手动触发也不做）", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 6, 4000),
      settings: { enabled: false },
      forceAtTurn: 1,
      route: scripted({ main: () => toolStep() }),
    });
    await runLoop(fixture, { prompts: [{ role: "user", content: "继续" }] });
    assert.equal(fixture.controller.compactions, 0);
    assert.equal(fixture.model.summaryRequests().length, 0);
  });
});

// ---------------------------------------------------------------- 2. 溢出恢复

describe("Phase 3 · 溢出恢复", () => {
  it("spec 要点 7：先报超窗 → 压缩一次 → 重试这一轮；不重复压缩第二次", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 6, 4000),
      route: scripted({ summaries: "溢出后的摘要", main: (count) => (count === 1 ? overflowStep() : stepText("修好了")) }),
    });
    const { recorder } = await runLoop(fixture, { prompts: [{ role: "user", content: "继续" }] });

    assert.equal(fixture.controller.compactions, 1, "只压缩一次（split turn 会跑两次摘要请求，所以看压缩次数）");
    assert.equal(fixture.model.mainRequests().length, 2, "第一次失败 + 重试一次");
    const events = recorder.ofType("compaction");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.reason, "overflow");

    // 重试的请求：第一条是摘要，且**结尾不是 assistant**（失败的那条被退掉了；
    // 中间出现 assistant 是正常的：那是保留区里的历史）。
    const retry = fixture.model.mainRequests()[1]!;
    const roles = retry.messages.map((message) => message.role);
    assert.equal(roles[0], "user");
    assert.notEqual(roles.at(-1), "assistant", `重试请求不该以 assistant 结尾：${roles.join(" → ")}`);
    assert.match(textOf(retry.messages[0]!), /溢出后的摘要/);
  });

  it("spec 要点 8：摘要失败 → Run 以 compaction_failed 停止，不重试", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 6, 4000),
      route: scripted({
        summaries: stepError("error", "摘要服务挂了"),
        main: (count) => (count === 1 ? overflowStep() : stepText("不该跑到这里")),
      }),
    });
    const { recorder } = await runLoop(fixture, { prompts: [{ role: "user", content: "继续" }] });

    assert.equal(fixture.controller.compactions, 0);
    assert.equal(fixture.model.summaryRequests().length, 1, "失败之后不再重试摘要");
    assert.equal(fixture.model.mainRequests().length, 1, "不重试主请求");
    const failure = recorder.ofType("note").filter((event) => event.kind === "compaction_failed");
    assert.equal(failure.length, 1);
    assert.match(failure[0]!.message, /摘要服务挂了/);
    assert.equal(recorder.types().at(-1), "agent_end", "note 之后立刻收工，事件齐全");
    assert.equal(fixture.controller.failure?.reason, "compaction_failed");
  });

  it("只重试一次：重试之后又超窗就不再压，直接失败收尾", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 6, 4000),
      route: scripted({ summaries: "压缩一次就够", main: () => overflowStep() }),
    });
    const { recorder } = await runLoop(fixture, { prompts: [{ role: "user", content: "继续" }] });
    assert.equal(fixture.model.mainRequests().length, 2, "第一次失败 + 重试一次，然后停");
    assert.equal(fixture.controller.compactions, 1, "第二次超窗不再压缩");
    assert.equal(recorder.ofType("compaction").length, 1);
  });

  it("不是超窗的模型错误 → 一次都不压（判断在控制器里，循环不认识 provider 文案）", async () => {
    const fixture = await setup({
      seed: (store, sessionId) => seedTurns(store, sessionId, 6, 4000),
      route: scripted({ main: () => stepError("error", "429 rate limit exceeded") }),
    });
    const { recorder } = await runLoop(fixture, { prompts: [{ role: "user", content: "继续" }] });
    assert.equal(fixture.model.summaryRequests().length, 0);
    assert.equal(fixture.controller.compactions, 0);
    assert.equal(recorder.ofType("note").filter((event) => event.kind === "compaction_failed").length, 0);
  });

  it("溢出但已经没有可压缩的历史 → compaction_failed（如实报告，不静默继续）", async () => {
    const fixture = await setup({
      // 只有一句话：`prepareCompaction` 找不到可压区间。
      seed: async (store, sessionId) => {
        await store.appendEntry(sessionId, RUN_ID, entryForMessage({ role: "user", content: "只有一句话" }));
      },
      route: scripted({ summaries: "不该被调用", main: () => overflowStep() }),
    });
    const { recorder } = await runLoop(fixture, { tools: [] });
    const failure = recorder.ofType("note").filter((event) => event.kind === "compaction_failed");
    assert.equal(failure.length, 1);
    assert.match(failure[0]!.message, /没有可压缩的历史/);
    assert.equal(fixture.model.summaryRequests().length, 0);
  });
});

// ---------------------------------------------------------------- 3. 识别与配置

describe("Phase 3 · 溢出识别与配置", () => {
  it("各家的超窗文案都认得，限流之类的错误不认", () => {
    assert.equal(isContextOverflowError("prompt is too long: 213462 tokens > 200000 maximum"), true);
    assert.equal(
      isContextOverflowError("This model's maximum context length is 131072 tokens. However, you requested 131100 tokens"),
      true,
    );
    assert.equal(isContextOverflowError('413 {"error":{"type":"request_too_large"}}'), true);
    assert.equal(isContextOverflowError("context_length_exceeded"), true);
    assert.equal(isContextOverflowError("Please reduce the length of the messages"), true);
    assert.equal(isContextOverflowError("429 rate limit exceeded"), false);
    assert.equal(isContextOverflowError(undefined), false);
    assert.equal(isContextOverflowError(""), false);
  });

  it("env 配置：开关、两个预算、摘要模型；坏值抛错（不静默退回默认）", () => {
    assert.deepEqual(compactionSettingsFromEnv({}), {});
    assert.deepEqual(compactionSettingsFromEnv({ [ENV_COMPACTION_ENABLED]: "off" }), { enabled: false });
    assert.deepEqual(
      compactionSettingsFromEnv({
        [ENV_COMPACTION_ENABLED]: "true",
        [ENV_COMPACTION_RESERVE_TOKENS]: "8000",
        [ENV_COMPACTION_KEEP_TOKENS]: "5000",
        [ENV_COMPACTION_SUMMARY_MODEL]: "claude-haiku-4-5",
      }),
      { enabled: true, reserveTokens: 8000, keepRecentTokens: 5000, summaryModel: "claude-haiku-4-5" },
    );
    assert.throws(() => compactionSettingsFromEnv({ [ENV_COMPACTION_RESERVE_TOKENS]: "0" }), /正整数/);
    assert.throws(() => compactionSettingsFromEnv({ [ENV_COMPACTION_KEEP_TOKENS]: "abc" }), /正整数/);
  });

  it("摘要请求不写 prompt cache（SDK 参数里没有 cache_control）", () => {
    const base: ModelRequest = {
      system: "系统提示",
      messages: [{ role: "user", content: "你好" }],
      tools: [{ name: "ls", description: "", inputSchema: { type: "object" } }],
      maxTokens: 100,
    };
    const withCache = toSdkParams(base, { model: "m", thinking: false, effort: "high" });
    assert.deepEqual((withCache.system as Array<{ cache_control?: unknown }>)[0]?.cache_control, { type: "ephemeral" });

    const without = toSdkParams({ ...base, cache: "none" }, { model: "m", thinking: false, effort: "high" });
    assert.equal((without.system as Array<{ cache_control?: unknown }>)[0]?.cache_control, undefined);
    assert.equal(JSON.stringify(without).includes("cache_control"), false);
  });
});

/** 一条 LlmMessage 的可见文字。 */
function textOf(message: { content: string | readonly { type: string; text?: string }[] }): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}
