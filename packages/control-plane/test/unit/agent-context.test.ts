/**
 * Phase 1 · 兼容层的上下文裁剪（不需要 Docker、不需要模型）。
 *
 * M0 的策略是"超阈值丢最旧的工具结果**正文**，不丢消息本身"——因为 Anthropic 要求每个
 * `tool_use` 都有配对的 `tool_result`，删消息会让下一次请求 400。P3 的 compaction 会
 * 取代它；在那之前这条性质必须保持（否则长 Run 会直接爆窗）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentMessage, ToolResultMessage, UserMessage } from "@reuben-cloud/agent-runtime";
import { ELIDED_TOOL_RESULT, elideOldToolResults } from "../../src/agent/run.ts";

function toolResult(id: string, body: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: body }],
    details: { keep: "me" },
    isError: false,
    timestamp: 1,
  };
}

function user(text: string): UserMessage {
  return { role: "user", content: text };
}

describe("Phase 1 · 上下文裁剪", () => {
  test("没超阈值时原样返回（removed=0）", () => {
    const messages: AgentMessage[] = [user("问题"), toolResult("tu_1", "短结果")];
    const result = elideOldToolResults(messages, { maxChars: 10_000, keepRecent: 1 });
    assert.equal(result.removed, 0);
    assert.deepEqual(result.messages, messages);
  });

  test("超阈值时从最旧的工具结果开始丢正文，最近 keepRecent 条不碰", () => {
    const body = "x".repeat(500);
    const messages: AgentMessage[] = [
      user("问题"),
      toolResult("tu_1", body),
      toolResult("tu_2", body),
      toolResult("tu_3", body),
    ];
    const result = elideOldToolResults(messages, { maxChars: 1_100, keepRecent: 1 });
    // 丢掉了 tu_1（可能还有 tu_2），最后一条原样。
    assert.ok(result.removed >= 1);
    const last = result.messages[3] as ToolResultMessage;
    assert.equal((last.content[0] as { text: string }).text, body);
    // 被丢的只换了 content；details（给 UI 的）不动。
    const first = result.messages[1] as ToolResultMessage;
    assert.equal((first.content[0] as { text: string }).text, ELIDED_TOOL_RESULT);
    assert.deepEqual(first.details, { keep: "me" });
    // user 的文字永远不动。
    assert.deepEqual(result.messages[0], user("问题"));
  });

  test("已经是占位符的不重复计数", () => {
    const body = "x".repeat(500);
    const messages: AgentMessage[] = [toolResult("tu_1", body), toolResult("tu_2", body)];
    const first = elideOldToolResults(messages, { maxChars: 10, keepRecent: 0 });
    assert.equal(first.removed, 2);
    const second = elideOldToolResults(first.messages, { maxChars: 10, keepRecent: 0 });
    assert.equal(second.removed, 0);
  });
});
