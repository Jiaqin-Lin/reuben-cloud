/**
 * Phase 11 · `@live`：真模型跑一次 agent 循环（默认跳过）。
 *
 * 【它为什么单独一层】spec §0.5 的三层里没有它：这一层**要花钱、要网络、结果不完全
 * 确定**（模型可以选别的工具组合），所以不能进 `npm test`。它存在的理由是前两层答不了
 * 的那个问题：**我们发出去的请求，真实 API 认不认**——`thinking: adaptive`、
 * `output_config.effort`、system 上的 `cache_control`、以及"下一轮带上 thinking 块"会不会 400。
 *
 * 【怎么跑】
 *   npm run test:live -w @reuben-cloud/control-plane
 * `REUBEN_CLOUD_PROVIDER` 决定打哪一家（默认看哪个 key 在）；脚本带 `--env-file-if-exists`，
 * 所以仓库根的 `.env` 会被自动读进来，不需要 export。想省钱就指定便宜模型：
 *   REUBEN_CLOUD_MODEL=deepseek-flash npm run test:live -w @reuben-cloud/control-plane
 *
 * 【它对应 spec 的哪两条】测试要点 8（真实模型 smoke：工具被调用、循环正常结束）
 * 与 10（多轮之后 `cache_read_input_tokens > 0`）。
 *
 * 【两家 provider 在缓存上的差异】Anthropic 要显式 `cache_control` 断点，命中时
 * `cache_creation_input_tokens > 0`；DeepSeek 是自动上下文缓存（`cache_control` 被忽略），
 * `cache_creation` 恒为 0。所以“缓存建过”只对 Anthropic 断言，而测试要点 10 的
 * `cache_read_input_tokens > 0` 对两家都断言——那一条才是“前缀字节稳定”的真正判据。
 *
 * 【为什么不接真沙箱】真沙箱的那部分在 `test/integration/agent-tools.integration.test.ts`
 * 里（那里同时验容器里搜不到 API key）。这一层只关心"模型 + 循环 + 工具契约"，
 * 用一个内存里的假工具箱就够了——真沙箱会让一条 live 用例同时依赖 Docker、
 * Postgres 和网络，失败时你分不清是哪一层的问题。
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { modelFromEnv, selectProvider } from "../../src/agent/model.ts";
import { runAgentLoop } from "../../src/agent/loop.ts";
import { Transcript } from "../../src/agent/transcript.ts";
import type { AgentToolkit } from "../../src/agent/tools/index.ts";
import type { ToolResult } from "../../src/agent/tools/types.ts";

/** 环境里有哪套凭据。`null` = 一处都没说，这一层整层跳过。 */
const selection = selectProvider(process.env);
const live = selection !== null && (process.env[selection.apiKeyEnv] ?? "") !== "";

let workDir = "";
after(async () => {
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

/**
 * 一个只有两个工具的假工具箱：`read` 固定返回一段内容，`bash` 固定返回一行结果。
 * 它不模拟沙箱，只让模型有一次真实的 tool_use 往返。
 */
function stubToolkit(): AgentToolkit & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    definitions: [
      {
        name: "read",
        description: "Read a file from the repository. Output is truncated to 2000 lines or 50KB.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "bash",
        description: 'Run an argv command (array, not a shell string), e.g. ["npm","test"].',
        input_schema: {
          type: "object",
          properties: { cmd: { type: "array", items: { type: "string" } } },
          required: ["cmd"],
        },
      },
    ],
    async run(name, input): Promise<ToolResult> {
      calls.push(name);
      if (name === "read") {
        return { content: "export const MAGIC = 41;\n", isError: false };
      }
      void input;
      return { content: "MAGIC + 1 = 42\n[exit 0]", isError: false };
    },
  };
}

describe("Phase 11 · live（@live，默认跳过）", () => {
  test("真模型：工具往返 + 多轮缓存命中 + transcript 完整", { skip: live ? false : "没有模型凭据（DEEPSEEK_API_KEY 或 ANTHROPIC_API_KEY）" }, async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), "rc-live-"));
    const transcript = await Transcript.create({ runId: "run_live_1", path: path.join(workDir, "transcript.jsonl") });
    const toolkit = stubToolkit();
    const model = modelFromEnv();
    const modelName = model.model;
    const result = await runAgentLoop({
      model,
      tools: toolkit,
      transcript,
      issue:
        "请读一遍 src/magic.ts（用 read 工具），然后用 bash 跑一条命令算一下 MAGIC + 1 是多少，" +
        "最后用一句话告诉我结论。不要做别的。",
      maxTurns: 6,
      wallClockMs: 5 * 60_000,
    });

    assert.equal(result.ok, true, `循环没有正常结束：${result.stopReason} / ${result.detail}`);
    assert.ok(toolkit.calls.length >= 2, `模型没有调用两个工具：${toolkit.calls.join(",")}`);
    assert.equal(result.turns >= 2, true, "至少要两轮才可能有缓存命中");
    // 测试要点 10：缓存前缀真的生效了。为 0 说明前缀里有东西在变（最常见的是工具顺序）。
    assert.ok(
      result.usage.cacheReadInputTokens > 0,
      `cache_read_input_tokens 是 0（provider=${selection!.provider} model=${modelName}）——缓存前缀不稳定，检查 tools 顺序与 system 内容`,
    );
    // 缓存断点只对 Anthropic 有意义：DeepSeek 是自动缓存，从不报 cache_creation（见文件头）。
    if (selection!.provider === "anthropic") {
      assert.ok(result.usage.cacheCreationInputTokens > 0, "没有任何 cache_creation，缓存断点可能没打上");
    }

    // transcript 完整：每轮请求/响应都在，且能拼回完整对话
    const records = (await readFile(transcript.path, "utf8"))
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records.filter((record) => record["type"] === "request").length, result.turns);
    assert.equal(records.filter((record) => record["type"] === "response").length, result.turns);
    const start = records[0]!;
    assert.equal(start["type"], "run_start");
    assert.equal(typeof start["system"], "string");
    assert.equal(records.at(-1)!["stopReason"], "end_turn");

    console.log(
      `[live] provider=${selection!.provider} model=${modelName} turns=${result.turns} tools=${toolkit.calls.join(",")} ` +
        `cache_read=${result.usage.cacheReadInputTokens} cache_write=${result.usage.cacheCreationInputTokens} ` +
        `in=${result.usage.inputTokens} out=${result.usage.outputTokens}`,
    );
  });
});
