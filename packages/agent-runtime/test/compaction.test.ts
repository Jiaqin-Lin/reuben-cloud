/**
 * Phase 3 · compaction 的算法面（spec P3 的测试要点 1–6、11）。
 *
 * 【这份文件测什么、不测什么】这里只测"纯函数 + 摘要生成"：估算、切点、split turn、
 * 结构化摘要、文件清单、序列化预算。循环与存储的接线（阈值触发、溢出恢复、账本）在
 * `compaction-controller.test.ts`——分两份是因为前者的失败几乎都是算法错，后者几乎都是接线错。
 *
 * 【fixture 直接造 entry】不经过 `SessionStore`：切点与估算要的是"给定一串 entry，结果是什么"，
 * 走一遍存储只会让失败信息里多一层间接。存储接线的那一份用真 store（内存实现）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CompactionEntryPayload } from "../src/session/entries.ts";
import type { EntryType, StoredEntry } from "../src/session/store.ts";
import type { AgentMessage, AssistantMessage, Content, ModelRequest, Usage } from "../src/types.ts";
import { emptyUsage } from "../src/types.ts";
import { calculateContextTokens, estimateContextTokens, estimateTokens, shouldCompact } from "../src/compaction/tokens.ts";
import { findCutPoint, findTurnStartIndex, findValidCutPoints } from "../src/compaction/cut.ts";
import {
  TOOL_RESULT_MAX_CHARS,
  computeFileLists,
  createFileOps,
  extractFileOperations,
  extractFileOpsFromMessage,
  formatFileOperations,
  generateSummary,
  serializeConversation,
  summaryBudgetChars,
} from "../src/compaction/summarize.ts";
import { DEFAULT_COMPACTION_SETTINGS, compact, prepareCompaction } from "../src/compaction/index.ts";
import type { CompactionSettings } from "../src/compaction/index.ts";
import { buildContextEntries, projectEntry } from "../src/session/entries.ts";
import { defaultConvertToLlm } from "../src/loop.ts";
import { ScriptedModel, stepText, stepError, text, toolCall, usageOf } from "./helpers.ts";

// ---------------------------------------------------------------- 脚手架

let nextSeq = 0;
let nextId = 0;

/** 建一条 entry（seq 递增 = 排序键；id 可读 = 断言失败时看得懂）。 */
function entryOf(payload: unknown, options: { id?: string; type?: EntryType } = {}): StoredEntry {
  nextSeq += 1;
  nextId += 1;
  return {
    id: options.id ?? `ent_${String(nextId).padStart(4, "0")}`,
    sessionId: "ses_test",
    runId: "run_test",
    parentId: null,
    seq: nextSeq,
    type: options.type ?? "message",
    payload,
    createdAt: new Date(1_700_000_000_000 + nextSeq),
  };
}

function user(content: string): AgentMessage {
  return { role: "user", content };
}

function assistant(content: Content[], options: { stopReason?: AssistantMessage["stopReason"]; usage?: Usage } = {}): AgentMessage {
  return {
    role: "assistant",
    content,
    stopReason: options.stopReason ?? "stop",
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
}

/** assistant 的纯文本回复（`repeat` 控制体积：切点测试靠体积说话）。 */
function assistantText(value: string, usage?: Usage): AgentMessage {
  return assistant([text(value)], usage === undefined ? {} : { usage });
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AgentMessage {
  return assistant([toolCall(id, name, args)]);
}

function toolResult(toolCallId: string, toolName: string, value: string): AgentMessage {
  return { role: "toolResult", toolCallId, toolName, content: [text(value)], isError: false, timestamp: 1 };
}

function note(content: string): StoredEntry {
  return entryOf({ customType: "note", content, display: true, forModel: false }, { type: "custom" });
}

function compactionEntryOf(summary: string, firstKeptEntryId: string, details?: CompactionEntryPayload["details"]): StoredEntry {
  return entryOf({ summary, firstKeptEntryId, tokensBefore: 1234, ...(details === undefined ? {} : { details }) }, { type: "compaction" });
}

/** 固定的配置（env 的解析单独测；这里只关心算法）。 */
function settings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
  return { ...DEFAULT_COMPACTION_SETTINGS, ...overrides };
}

function before(): void {
  nextSeq = 0;
  nextId = 0;
}

/** entry 序列的"角色视图"（断言失败时能一眼看出切到哪儿了）。 */
function rolesOf(entries: readonly StoredEntry[]): string[] {
  return entries.map((entry) => (entry.type === "compaction" ? "compaction" : (projectEntry(entry)?.role ?? "?")));
}

/** 取一次请求的 user 正文（摘要请求只有一条 user 消息）。 */
function promptOf(request: ModelRequest): string {
  const first = request.messages[0];
  assert.equal(first?.role, "user");
  const content = first!.content;
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

// ---------------------------------------------------------------- 1. 估算与阈值

describe("Phase 3 · token 估算与阈值", () => {
  it("按 usage 的四个量算总占用（与 pi 的 calculateContextTokens 同义）", () => {
    assert.equal(
      calculateContextTokens({ inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 200, cacheCreationInputTokens: 100 }),
      1800,
    );
    assert.equal(calculateContextTokens(emptyUsage()), 0);
  });

  it("阈值：超过 窗口 - 预留 才压缩，关掉开关永远不压", () => {
    const base = settings({ reserveTokens: 10_000, keepRecentTokens: 20_000 });
    assert.equal(shouldCompact(95_000, 100_000, base), true);
    assert.equal(shouldCompact(89_000, 100_000, base), false);
    assert.equal(shouldCompact(95_000, 100_000, { ...base, enabled: false }), false);
  });

  it("estimateTokens 覆盖五种角色的口径", () => {
    assert.equal(estimateTokens(user("a".repeat(400))), 100);
    assert.equal(estimateTokens(assistantText("a".repeat(400))), 100);
    assert.equal(estimateTokens(toolResult("call_1", "read", "a".repeat(400))), 100);
    assert.equal(
      estimateTokens({ role: "compactionSummary", summary: "a".repeat(400), firstKeptEntryId: "x", tokensBefore: 1 }),
      100,
    );
    assert.equal(estimateTokens({ role: "custom", customType: "note", content: "a".repeat(400), display: true }), 100);
    // assistant 的思考与工具调用都要算（思考往往比正文长，漏掉会低估一大截）。
    const withThinking = assistant([
      { type: "thinking", thinking: "a".repeat(400) },
      toolCall("call_1", "read", { path: "a.ts" }),
    ]);
    assert.ok(estimateTokens(withThinking) >= 100);
  });

  it("estimateContextTokens：没有 usage 就全估；有基线只估基线之后", () => {
    const noUsage = estimateContextTokens([user("a".repeat(400)), assistantText("b".repeat(400))]);
    assert.equal(noUsage.tokens, 200);
    assert.equal(noUsage.lastUsageIndex, null);

    const withUsage = estimateContextTokens([
      user("a".repeat(400)),
      assistantText("b".repeat(400), usageOf(50)),
      user("c".repeat(400)),
    ]);
    assert.equal(withUsage.usageTokens, calculateContextTokens(usageOf(50)));
    assert.equal(withUsage.lastUsageIndex, 1);
    assert.equal(withUsage.trailingTokens, 100);
    assert.equal(withUsage.tokens, withUsage.usageTokens + 100);
  });

  it("error / aborted 的 usage 不能当基线（拿它当基线会让估算凭空缩水）", () => {
    const broken: AgentMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "boom",
      usage: { inputTokens: 999_999, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
    const estimate = estimateContextTokens([broken, user("a".repeat(400))]);
    assert.equal(estimate.lastUsageIndex, null);
    assert.equal(estimate.tokens, 100);
  });

  it("spec 要点 6：20 条真实 usage 的估算 vs 实际，误差 < 15%", () => {
    // "实际"用一个不同的口径（3.5 字符/token）扮演真 tokenizer；usage 报的就是它的累计值，
    // 只有最后一条 assistant 没有 usage（尾部必须靠估算——这才是要测的部分）。
    const trueTokens = (message: AgentMessage): number => {
      if (message.role === "user" && typeof message.content === "string") return Math.ceil(message.content.length / 3.5);
      if (message.role === "assistant") {
        const chars = message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
        return Math.ceil(chars / 3.5);
      }
      return 0;
    };
    const messages: AgentMessage[] = [];
    let cumulative = 0;
    for (let turn = 0; turn < 20; turn += 1) {
      const question = user(`第 ${turn} 轮的提问：${"问".repeat(200)}`);
      messages.push(question);
      cumulative += trueTokens(question);
      const answer = assistantText(`第 ${turn} 轮的回答：${"答".repeat(300)}`);
      cumulative += trueTokens(answer);
      // 最后一条故意不给 usage。
      if (turn < 19) {
        (answer as AssistantMessage).usage = {
          inputTokens: cumulative,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        };
      }
      messages.push(answer);
    }
    const estimate = estimateContextTokens(messages).tokens;
    const error = Math.abs(estimate - cumulative) / cumulative;
    assert.ok(error < 0.15, `估算 ${estimate} vs 实际 ${cumulative}，误差 ${(error * 100).toFixed(1)}%`);
  });
});

// ---------------------------------------------------------------- 2. 切点

describe("Phase 3 · 切点", () => {
  /** 一轮 = user + assistant(工具调用) + toolResult + assistant(文字)。 */
  function turn(index: number, bodyChars = 1200): AgentMessage[] {
    const call = toolCall(`call_${index}`, "read", { path: `f${index}.ts` });
    return [
      user(`第 ${index} 轮：${"问".repeat(bodyChars)}`),
      assistant([call]),
      toolResult(`call_${index}`, "read", "结".repeat(bodyChars)),
      assistantText(`第 ${index} 轮的结论：${"答".repeat(bodyChars)}`),
    ];
  }

  it("spec 要点 1：普通多轮 → 切在 turn 边界（user），保留区的 tool_result 都有配对的 tool_use", () => {
    const entries: StoredEntry[] = [];
    for (let index = 0; index < 6; index += 1) for (const message of turn(index)) entries.push(entryOf(message));

    // keepRecent 大约两轮（每轮约 900 token），切点必须落在某个 turn 的起点上。
    const cut = findCutPoint(entries, 0, entries.length, 2500);
    assert.equal(
      projectEntry(entries[cut.firstKeptEntryIndex]!)?.role,
      "user",
      `切到了 ${rolesOf(entries)[cut.firstKeptEntryIndex]}`,
    );
    assert.equal(cut.isSplitTurn, false);
    assert.ok(cut.firstKeptEntryIndex > 0, "什么都没压掉：切点应落在列表中间");

    const kept = entries.slice(cut.firstKeptEntryIndex);
    for (const [index, entry] of kept.entries()) {
      const message = projectEntry(entry);
      if (message?.role !== "toolResult") continue;
      const owner = kept.slice(0, index).some((candidate) => {
        const candidateMessage = projectEntry(candidate);
        return (
          candidateMessage?.role === "assistant" &&
          candidateMessage.content.some((block) => block.type === "toolCall" && block.id === message.toolCallId)
        );
      });
      assert.ok(owner, "保留下来的 tool_result 丢了配对的 tool_use");
    }
  });

  it("spec 要点 2：tool_result 不是切点（紧跟 tool_use 时也不能把它切出去）", () => {
    const entries = [
      entryOf(user("u1")),
      entryOf(assistantToolCall("call_1", "bash", { command: "ls" })),
      entryOf(toolResult("call_1", "bash", "x".repeat(4000))),
      entryOf(assistantText("a2")),
    ];
    const points = findValidCutPoints(entries, 0, entries.length);
    assert.deepEqual(
      points.map((point) => rolesOf(entries)[point]),
      ["user", "assistant", "assistant"],
    );

    // 预算刚好卡在 tool_result 上：切点必须往后挪到下一个合法位置（不能切出孤立的 tool_result）。
    const cut = findCutPoint(entries, 0, entries.length, 900);
    assert.notEqual(projectEntry(entries[cut.firstKeptEntryIndex]!)?.role, "toolResult");
  });

  it("spec 要点 3：单个 turn 超过保留预算 → split turn（切在 turn 中间，记下起点）", () => {
    const entries = [
      entryOf(user("u1")),
      entryOf(assistant([{ type: "thinking", thinking: "thinking".repeat(200) }])),
      entryOf(assistantToolCall("call_1", "read", { path: "big.ts" })),
      entryOf(toolResult("call_1", "read", "结".repeat(4000))),
      entryOf(assistantText("a-final")),
    ];
    const cut = findCutPoint(entries, 0, entries.length, 1000);
    assert.equal(cut.isSplitTurn, true);
    assert.equal(cut.turnStartIndex, findTurnStartIndex(entries, cut.firstKeptEntryIndex, 0));
    assert.equal(projectEntry(entries[cut.turnStartIndex]!)?.role, "user");

    // 准备阶段要把三段切对：历史（空）、turn 前缀（前半段）、保留尾（后半段）。
    const prepared = prepareCompaction(entries, settings({ keepRecentTokens: 1000 }));
    assert.ok(prepared !== undefined);
    assert.equal(prepared.isSplitTurn, true);
    assert.ok(prepared.turnPrefixMessages.length > 0);
    assert.ok(prepared.retainedTail.length > 0);
    assert.equal(prepared.firstKeptEntryId, entries[cut.firstKeptEntryIndex]!.id);
  });

  it("切点落在 assistant 上、但往前找不到 user 时不算 split turn", () => {
    const orphan = [entryOf(assistantText("a".repeat(100))), entryOf(assistantText("b".repeat(100)))];
    assert.equal(findTurnStartIndex(orphan, 1, 0), -1);
    const cut = findCutPoint(orphan, 0, orphan.length, 1);
    assert.equal(cut.isSplitTurn, false);
    assert.equal(cut.turnStartIndex, -1);
  });

  it("尾巴是一大段工具结果时仍能压出东西（不能退化成什么都不压）", () => {
    before();
    const entries = [
      entryOf(user("u1".repeat(1000))), // 250 token
      entryOf(assistantText("a1".repeat(1000))),
      entryOf(user("u2".repeat(200))),
      entryOf(assistantToolCall("call_1", "bash", { command: "ls" })),
      entryOf(toolResult("call_1", "bash", "x".repeat(8000))), // 2000 token：预算在工具结果里就已经超了
    ];
    // 工具结果之后没有合法切点 → 退回它前面最近的那个（发这批调用的 assistant）。
    const cut = findCutPoint(entries, 0, entries.length, 1000);
    assert.equal(cut.firstKeptEntryIndex, 3);

    const prepared = prepareCompaction(entries, settings({ keepRecentTokens: 1000 }));
    assert.ok(prepared !== undefined);
    assert.ok(prepared.messagesToSummarize.length > 0, "前面的历史必须被总结掉");
    assert.equal(prepared.firstKeptEntryId, entries[3]!.id);
  });

  it("没有可用切点时退回列表开头（等于没什么可压的）", () => {
    const onlyToolResults = [entryOf(toolResult("call_1", "read", "x")), entryOf(toolResult("call_2", "read", "y"))];
    assert.deepEqual(findCutPoint(onlyToolResults, 0, onlyToolResults.length, 1), {
      firstKeptEntryIndex: 0,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
  });

  it("note 这类元数据条目跟着保留区走（不单独成为摘要区间的尾巴）", () => {
    before();
    const question = entryOf(user("u".repeat(4000)));
    const noteEntry = note("旁路提示");
    const answer = entryOf(assistantText("a".repeat(4000)));
    const entries = [question, noteEntry, answer];

    const cut = findCutPoint(entries, 0, entries.length, 100);
    // note 投影成 null（不进模型），所以往回吃一步落在它身上——它留在保留区，而不是摘要区。
    assert.equal(entries[cut.firstKeptEntryIndex]!.id, noteEntry.id);

    const prepared = prepareCompaction(entries, settings({ keepRecentTokens: 100 }));
    assert.ok(prepared !== undefined);
    // 三段加起来正好覆盖"除 note 之外"的全部消息（note 既不进摘要也不进模型）。
    assert.deepEqual(
      [...prepared.messagesToSummarize, ...prepared.turnPrefixMessages, ...prepared.retainedTail],
      [question.payload, answer.payload].filter(() => true),
    );
  });
});

// ---------------------------------------------------------------- 3. 摘要

describe("Phase 3 · 结构化摘要与文件清单", () => {
  it("文件清单：read 进 readFiles、write/edit 进 modifiedFiles，且改过的文件从只读里剔掉", () => {
    const fileOps = createFileOps();
    extractFileOpsFromMessage(assistantToolCall("call_1", "read", { path: "a.ts" }), fileOps);
    extractFileOpsFromMessage(assistantToolCall("call_2", "write", { path: "b.ts", content: "x" }), fileOps);
    extractFileOpsFromMessage(assistantToolCall("call_3", "edit", { path: "c.ts", oldString: "x", newString: "y" }), fileOps);
    extractFileOpsFromMessage(assistantToolCall("call_4", "read", { path: "b.ts" }), fileOps);
    const lists = computeFileLists(fileOps);
    assert.deepEqual(lists.readFiles, ["a.ts"]);
    assert.deepEqual(lists.modifiedFiles, ["b.ts", "c.ts"]);
    assert.match(formatFileOperations(lists), /<read-files>\na\.ts\n<\/read-files>/);
    assert.match(formatFileOperations(lists), /<modified-files>\nb\.ts\nc\.ts\n<\/modified-files>/);
  });

  it("spec 要点 5：两次压缩之后，清单里还有第一次改过的文件", () => {
    const first = computeFileLists(
      extractFileOperations([assistantToolCall("call_1", "write", { path: "first.ts", content: "x" })]),
    );
    assert.deepEqual(first.modifiedFiles, ["first.ts"]);

    const second = computeFileLists(
      extractFileOperations([assistantToolCall("call_2", "edit", { path: "second.ts" })], first),
    );
    assert.deepEqual(second.modifiedFiles, ["first.ts", "second.ts"]);
  });

  it("序列化：工具结果截断到 2000 字符，并写明被截掉多少", () => {
    const serialized = serializeConversation(defaultConvertToLlm([toolResult("call_1", "bash", "x".repeat(5000))]));
    assert.match(serialized, /\[Tool result\]:/);
    assert.match(serialized, /\[\.\.\. 后面还有 3000 个字符被截断\]/);
    assert.ok(serialized.length < TOOL_RESULT_MAX_CHARS + 200);
  });

  it("spec 要点 11：100 条大工具结果 → 序列化后不超过预留预算", async () => {
    const reserveTokens = 16_384;
    const budget = summaryBudgetChars(reserveTokens);
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 100; index += 1) {
      messages.push(user(`第 ${index} 轮`));
      messages.push(toolResult(`call_${index}`, "bash", "x".repeat(2000)));
    }
    assert.ok(JSON.stringify(messages).length > 200_000, "fixture 本身要够大");

    const serialized = serializeConversation(defaultConvertToLlm(messages), budget);
    assert.ok(serialized.length <= budget, `${serialized.length} > ${budget}`);
    assert.match(serialized, /中间部分因为篇幅被省略/);

    // 走完整路径也一样：摘要请求的正文不能超过"预算 + 模板"的量级。
    const model = new ScriptedModel([stepText("摘要正文")]);
    await generateSummary(messages, { model, reserveTokens });
    const prompt = promptOf(model.requests[0]!);
    assert.ok(prompt.length < budget + 4000, `摘要请求正文 ${prompt.length} 字符`);
  });

  it("摘要请求关闭 prompt cache（一次性请求，写缓存是浪费）", async () => {
    const model = new ScriptedModel([stepText("摘要正文")]);
    const result = await generateSummary([user("hi")], { model, reserveTokens: 16_384 });
    assert.equal(result.text, "摘要正文");
    assert.equal(model.requests[0]!.cache, "none");
    assert.ok(model.requests[0]!.maxTokens <= Math.floor(0.8 * 16_384));
  });

  it("摘要模型报错 → 抛错（由控制器翻成 compaction_failed）", async () => {
    const model = new ScriptedModel([stepError("error", "provider 挂了")]);
    await assert.rejects(() => generateSummary([user("hi")], { model, reserveTokens: 16_384 }), /provider 挂了/);
  });

  it("迭代摘要：有上一份摘要时带上 <previous-summary> 与更新模板", async () => {
    const model = new ScriptedModel([stepText("更新后的摘要")]);
    await generateSummary([user("新消息")], { model, reserveTokens: 16_384, previousSummary: "旧摘要" });
    const prompt = promptOf(model.requests[0]!);
    assert.match(prompt, /<previous-summary>\n旧摘要\n<\/previous-summary>/);
    assert.match(prompt, /保留上一份摘要里的全部信息/);
  });

  it("摘要模型没有输出任何文本 → 失败（不能拿空摘要换掉整段历史）", async () => {
    const model = new ScriptedModel([stepText("   ")]);
    await assert.rejects(() => generateSummary([user("hi")], { model, reserveTokens: 16_384 }), /没有输出任何文本/);
  });
});

// ---------------------------------------------------------------- 4. 准备与连续压缩

describe("Phase 3 · prepareCompaction 与连续压缩", () => {
  it("最后一条就是压缩条目 → 没有可压的（不原地踏步）", () => {
    before();
    const kept = entryOf(user("u"));
    const compaction = compactionEntryOf("已有摘要", kept.id);
    assert.equal(prepareCompaction([kept, compaction], settings()), undefined);
    assert.equal(prepareCompaction([], settings()), undefined);
  });

  it("全部内容都在保留预算内 → 没有可压的区间", () => {
    before();
    const entries = [entryOf(user("u1")), entryOf(assistantText("a1"))];
    assert.equal(prepareCompaction(entries, settings({ keepRecentTokens: 1_000_000 })), undefined);
  });

  it("spec 要点 4：第二次压缩的起点是上一次的 firstKeptEntryId（不是压缩条目本身）", () => {
    before();
    // 每条 400 字符 = 100 token。
    const u1 = entryOf(user("u1".repeat(200)), { id: "ent_u1" });
    const a1 = entryOf(assistantText("a1".repeat(200)));
    const u2 = entryOf(user("u2".repeat(200)), { id: "ent_u2" });
    const a2 = entryOf(assistantText("a2".repeat(200)));
    const first = compactionEntryOf("第一份摘要", "ent_u2");
    const u3 = entryOf(user("u3".repeat(200)), { id: "ent_u3" });
    const a3 = entryOf(assistantText("a3".repeat(200)));

    // 每条消息 100 token；预算 150 → 从尾部累加：a3(100) < 150，加 u3(100) ≥ 150 → 切在 u3。
    const prepared = prepareCompaction([u1, a1, u2, a2, first, u3, a3], settings({ keepRecentTokens: 150 }));
    assert.ok(prepared !== undefined);
    assert.equal(prepared.previousSummary, "第一份摘要");
    // 三段合起来必须正好是"上次幸存的 + 新增的"，一条不多一条不少（且不含压缩条目本身）。
    assert.deepEqual([...prepared.messagesToSummarize, ...prepared.turnPrefixMessages, ...prepared.retainedTail], [
      u2.payload,
      a2.payload,
      u3.payload,
      a3.payload,
    ]);
    // u2/a2 这次才被总结，u3 之后原样保留。
    assert.equal(prepared.firstKeptEntryId, "ent_u3");
    assert.deepEqual(prepared.messagesToSummarize, [u2.payload, a2.payload]);
    assert.deepEqual(prepared.retainedTail, [u3.payload, a3.payload]);
  });

  it("连续压缩之后投影里只有一份摘要（旧摘要不能再当成一条 user 消息发出去）", () => {
    before();
    const u1 = entryOf(user("u1"));
    const a1 = entryOf(assistantText("a1"));
    const u2 = entryOf(user("u2"), { id: "ent_u2" });
    const a2 = entryOf(assistantText("a2"));
    const first = compactionEntryOf("第一份摘要", "ent_u2");
    const u3 = entryOf(user("u3"), { id: "ent_u3" });
    const a3 = entryOf(assistantText("a3"));
    const second = compactionEntryOf("第二份摘要", "ent_u3");

    const projected = buildContextEntries([u1, a1, u2, a2, first, u3, a3, second]);
    const summaries = projected.filter((message) => message.role === "compactionSummary");
    assert.equal(summaries.length, 1);
    assert.equal((summaries[0] as { summary: string }).summary, "第二份摘要");
    // 投影 = 最新摘要 + 它 firstKeptEntryId 之后的内容（u3/a3）。这份投影里**不能**出现
    // 第一份摘要（它已经被第二份吸收了）。
    assert.deepEqual(
      projected.map((message) => message.role),
      ["compactionSummary", "user", "assistant"],
    );
  });

  it("tokensBefore 是压缩前整个投影的估算", () => {
    before();
    const entries = [
      entryOf(user("a".repeat(4000))),
      entryOf(assistantText("b".repeat(4000), usageOf(10))),
      entryOf(user("c".repeat(400))),
    ];
    const prepared = prepareCompaction(entries, settings({ keepRecentTokens: 1 }));
    assert.ok(prepared !== undefined);
    assert.equal(prepared.tokensBefore, estimateContextTokens(buildContextEntries(entries)).tokens);
  });

  it("文件清单从上一份 details 继续累积，并写进摘要末尾与 details", async () => {
    before();
    const previous = { readFiles: ["old-read.ts"], modifiedFiles: ["first.ts"] };
    const messagesToSummarize = [
      assistantToolCall("call_1", "write", { path: "first.ts", content: "x" }),
      assistantToolCall("call_2", "edit", { path: "second.ts", oldString: "a", newString: "b" }),
    ];
    const outcome = await compact(
      {
        messagesToSummarize,
        turnPrefixMessages: [],
        retainedTail: [],
        isSplitTurn: false,
        tokensBefore: 100,
        previousDetails: previous,
        fileOps: extractFileOperations(messagesToSummarize, previous),
        settings: settings(),
        firstKeptEntryId: "ent_kept",
      },
      { model: new ScriptedModel([stepText("第二次摘要")]) },
    );
    assert.deepEqual(outcome.details, { readFiles: ["old-read.ts"], modifiedFiles: ["first.ts", "second.ts"] });
    assert.match(outcome.summary, /第二次摘要/);
    assert.match(outcome.summary, /<read-files>\nold-read\.ts\n<\/read-files>/);
    assert.match(outcome.summary, /<modified-files>\nfirst\.ts\nsecond\.ts\n<\/modified-files>/);
    assert.ok(outcome.usage.outputTokens > 0);
  });

  it("上一份 details 形状不对时当作没有（不猜，也不抛）", () => {
    before();
    const question = entryOf(user("u1".repeat(400)), { id: "ent_u1" });
    const write = entryOf(assistantToolCall("call_1", "write", { path: "first.ts", content: "x" }));
    const broken = compactionEntryOf("坏 details", "ent_u1", { readFiles: "不是数组" } as never);
    const u2 = entryOf(user("u2".repeat(400)), { id: "ent_u2" });
    const answer = entryOf(assistantText("a2".repeat(400)));

    const prepared = prepareCompaction([question, write, broken, u2, answer], settings({ keepRecentTokens: 150 }));
    assert.ok(prepared !== undefined);
    assert.equal(prepared.previousDetails, null);
    assert.deepEqual(computeFileLists(prepared.fileOps).modifiedFiles, ["first.ts"]);
  });
});
