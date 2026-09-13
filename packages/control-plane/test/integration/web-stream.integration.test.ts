/**
 * Phase 13 的真容器端到端（`npm run test:integration`，**需要 Docker + 沙箱镜像 + Postgres**）。
 *
 * 【它测什么】spec 的验收标准是"一次 Run 的全过程能在浏览器里实时看到"，而"打开浏览器
 * 看一眼"不是自动化测试。所以这里用的办法是：**在真沙箱上跑一次 Run，同时用真 HTTP
 * 读那条 SSE**，然后断言这条流真的包含了三类事件：
 *  · 模型文字增量（`text`，走 Phase 11 的 `onText` 回调）
 *  · 工具调用与结果（`tool_call` / `tool_result`）
 *  · **沙箱命令输出**（`exec_start` / `exec_output` / `exec_end`，来自沙箱的事件流）
 * 以及 spec 测试要点的第二条：**断线之后带 `Last-Event-ID` 重连能接上**（不重不漏）。
 *
 * 【为什么值得多一个真容器用例】单测把每一段都盖住了，但"沙箱的事件真的会经过 manager
 * 的 `onEvent`、再经 bash 工具、再进 hub、再经 SSE 到客户端"这一整条链路只有在真容器上
 * 才能一次走通。Phase 11 的集成测试抓到过好几个"单测全绿、真跑不通"的问题（workspaceDir
 * 漏传、cwd 不在仓库里），这条链路同样长。
 *
 * 【为什么用脚本化模型】这里要测的是**观察窗**，不是模型。假模型让事件序列完全确定，
 * 也就不需要 API key、不会花钱、不会因为模型今天话多而红。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { AssistantMessageEventStream, Content, ModelClient } from "@reuben-cloud/agent-runtime";
import { createAssistantMessageEventStream } from "@reuben-cloud/agent-runtime";
import type { RunEvent, RunEventSink } from "../../src/agent/events.ts";
import { runAgentLoop } from "../../src/agent/run.ts";
import { Transcript } from "../../src/agent/transcript.ts";
import { REPO_DIR } from "@reuben-cloud/agent-runtime";
import { createSandboxToolkit } from "../../src/agent/sandbox-operations.ts";
import { SandboxApiClient } from "../../src/client/sandbox-api.ts";
import { Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { SandboxManager } from "../../src/manager/sandbox-manager.ts";
import { LocalDockerProvider } from "../../src/provider/local-docker.ts";
import { forwardContainerName } from "../../src/provider/types.ts";
import { cloneRepo, removeRunDir } from "../../src/repo/clone.ts";
import { injectRepo } from "../../src/repo/inject.ts";
import { RunHub } from "../../src/web/hub.ts";
import type { WebServer } from "../../src/web/server.ts";
import { startWebServer } from "../../src/web/server.ts";
import type { TestPostgres } from "../support.ts";
import { CleanupRegistry, deleteSandboxRows, dockerAvailable, resolveImageRef, run, startPostgres } from "../support.ts";

let pg: TestPostgres;
let db: Db;
let tempRoot = "";
let runId = "";
let sandboxId = "";
const created: string[] = [];
const cleanup = new CleanupRegistry();

/** 造一个会失败的测试仓库（本地目录当远端，不需要 smart-HTTP 服务器）。 */
async function makeFixtureRepo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(path.join(tempRoot, "repo-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), `${JSON.stringify({ name: "rc-web-fixture", scripts: { test: "node test.js" } }, null, 2)}\n`);
  await writeFile(path.join(dir, "src/math.js"), "exports.add = (a, b) => a - b; // BUG: 应该相加\n");
  await writeFile(
    path.join(dir, "test.js"),
    [
      'const { add } = require("./src/math.js");',
      "const actual = add(2, 3);",
      "if (actual !== 5) {",
      '  console.log("FAIL: add(2, 3) =", actual, "(expected 5)");',
      "  process.exit(1);",
      "}",
      'console.log("ok");',
      "",
    ].join("\n"),
  );
  const git = async (args: string[]): Promise<string> => {
    const result = await run(["git", ...args], { cwd: dir });
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr.trim()}`);
    return result.stdout;
  };
  await git(["init", "-q", "--initial-branch", "main"]);
  await git(["add", "-A"]);
  await git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "init"]);
  return { dir, baseSha: (await git(["rev-parse", "HEAD"])).trim() };
}

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("Phase 13 的集成测试需要可用的 Docker daemon（npm run test:integration）。");
  }
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "rc-web-stream-"));
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
});

after(async () => {
  const failed = await cleanup.sweep();
  if (failed.length > 0) console.warn(`清理时有问题：\n  ${failed.join("\n  ")}`);
  await deleteSandboxRows(db, created);
  await db.close();
  await pg.stop();
  if (tempRoot !== "") await rm(tempRoot, { recursive: true, force: true });
  if (runId !== "") await removeRunDir(runId).catch(() => undefined);
});

// ---------------------------------------------------------------- 脚手架

interface Frame {
  id: number;
  event: RunEvent;
}

/** 打开一条 SSE，逐条地读事件（心跳跳过）。调用方 `close()`。 */
function openReader(url: string, headers: Record<string, string> = {}): { next(): Promise<Frame>; close(): Promise<void> } {
  const controller = new AbortController();
  const queue: Frame[] = [];
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let failure: Error | null = null;
  let started = false;

  /** 连接并一直读到对端关掉。响应头一到就 resolve（不等到流结束）。 */
  async function start(): Promise<void> {
    try {
      const response = await fetch(url, {
        headers: { accept: "text/event-stream", ...headers },
        signal: controller.signal,
      });
      if (response.status !== 200) throw new Error(`SSE 应该 200，实际 ${response.status}`);
      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const frame = parseFrame(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          if (frame !== null) queue.push(frame);
          index = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      failure = error instanceof Error ? error : new Error(String(error));
    }
  }

  return {
    async next(): Promise<Frame> {
      if (!started) {
        started = true;
        void start();
      }
      for (let waited = 0; waited < 20_000; waited += 20) {
        const frame = queue.shift();
        if (frame !== undefined) return frame;
        if (failure !== null) throw failure;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("等 SSE 事件超时（20s）");
    },
    async close(): Promise<void> {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
    },
  };
}

/** 一帧 → 一条事件。心跳注释帧与没有 `data:` 的帧返回 null。 */
function parseFrame(raw: string): Frame | null {
  let id: number | null = null;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = (colon === -1 ? "" : line.slice(colon + 1)).replace(/^ /, "");
    if (field === "id") id = Number(value);
    else if (field === "data") data.push(value);
  }
  if (id === null || data.length === 0) return null;
  return { id, event: JSON.parse(data.join("\n")) as RunEvent };
}

/** 事件序列里的一个"标记"，用来断言顺序（不关心中间夹了什么）。 */
function markerOf(event: RunEvent): string {
  switch (event.type) {
    case "tool_call":
      return `tool_call:${event.name}`;
    case "tool_result":
      return `tool_result:${event.name}`;
    case "exec_start":
      return "exec_start";
    case "exec_output":
      return `exec_output:${event.stream}`;
    case "exec_end":
      return `exec_end:${event.state}:${event.exitCode}`;
    default:
      return event.type;
  }
}

/** 脚本化模型：第一轮跑一条会失败的命令，第二轮收工。 */
/** 两轮脚本：先跑一次 bash（shell 字符串），再收工。 */
class ScriptedModel implements ModelClient {
  readonly provider = "scripted";
  readonly model = "scripted-integration";
  #calls = 0;

  stream(): AssistantMessageEventStream {
    this.#calls += 1;
    const stream = createAssistantMessageEventStream();
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    void Promise.resolve().then(() => {
      if (this.#calls === 1) {
        const call = { type: "toolCall" as const, id: "tu_1", name: "bash", arguments: { command: "node test.js" } };
        const message = { role: "assistant" as const, content: [textBlock("先跑测试看看"), call], usage, stopReason: "toolUse" as const };
        stream.push({ type: "start", partial: { ...message, stopReason: undefined } });
        stream.push({ type: "text_start", contentIndex: 0, partial: { ...message } });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "先跑测试看看", partial: { ...message } });
        stream.push({ type: "text_end", contentIndex: 0, content: "先跑测试看看", partial: { ...message } });
        stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: { ...message } });
        stream.push({ type: "done", reason: "toolUse", message });
        return;
      }
      const message = { role: "assistant" as const, content: [textBlock("跑完了")], usage, stopReason: "stop" as const };
      stream.push({ type: "start", partial: { ...message, stopReason: undefined } });
      stream.push({ type: "text_start", contentIndex: 0, partial: { ...message } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "跑完了", partial: { ...message } });
      stream.push({ type: "text_end", contentIndex: 0, content: "跑完了", partial: { ...message } });
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  }
}

function textBlock(value: string): Content {
  return { type: "text", text: value };
}

// ---------------------------------------------------------------- 用例

describe("Phase 13 · 真沙箱里的一次 Run 实时流", () => {
  test("三类事件都出现在一条 SSE 上，且带 Last-Event-ID 的重连能接上", async () => {
    const imageRef = await resolveImageRef();
    const api = new SandboxApiClient();
    const manager = new SandboxManager({ db, provider: new LocalDockerProvider(), api, image: imageRef });

    // ---- 真沙箱 + 真仓库（fixture 里有一个会失败的测试，命令退出码 1 才有看头）
    const fixture = await makeFixtureRepo();
    runId = `run_web_${randomBytes(4).toString("hex")}`;
    const sandbox = await manager.createSandbox({ runId });
    sandboxId = sandbox.sandboxId;
    created.push(sandboxId);
    cleanup.container(sandbox.containerName);
    cleanup.volume(sandbox.volumeName);
    if (process.platform === "darwin") cleanup.container(forwardContainerName(sandboxId));

    const target = {
      endpoint: sandbox.endpoint ?? "",
      authToken: sandbox.authToken ?? "",
      sandboxId: sandbox.sandboxId,
    };
    assert.ok(target.endpoint !== "" && target.authToken !== "", "沙箱没有 endpoint/token");

    const clone = await cloneRepo({ runId, url: fixture.dir, commit: fixture.baseSha });
    const injected = await injectRepo({ api, target, clone, workspaceDir: REPO_DIR });
    assert.equal(injected.headSha, fixture.baseSha);

    // ---- 观察窗（Phase 13）：真 http server + 真 hub。先连上，再开始跑。
    const hub = new RunHub({ log: () => undefined });
    let server: WebServer | null = null;
    const sink: RunEventSink = hub.ensure(runId);
    let stream: ReturnType<typeof openReader> | null = null;
    try {
      server = await startWebServer({ hub, port: 0, log: () => undefined });
      stream = openReader(`${server.url}/runs/${encodeURIComponent(runId)}/stream`);
      // 先确认连接建立（否则"先连再跑"这件事没被验到）。
      await new Promise((resolve) => setTimeout(resolve, 50));

      const transcript = await Transcript.create({ runId });
      const toolkit = createSandboxToolkit({
        sandboxId: sandbox.sandboxId,
        exec: manager,
        api,
        target,
        repoDir: REPO_DIR,
        events: sink,
        log: () => undefined,
      });
      const result = await runAgentLoop({
        model: new ScriptedModel(),
        tools: toolkit.tools,
        transcript,
        issue: "跑一遍测试",
        events: sink,
        onText: (delta) => sink.emit({ type: "text", delta }),
        maxTurns: 4,
        log: () => undefined,
      });
      assert.equal(result.ok, true, result.detail);

      // ---- 把流读到 run_end（第一条帧就从缓冲里开始，所以不会有"漏了开头"的问题）
      const frames: Frame[] = [];
      for (let index = 0; index < 200; index += 1) {
        const frame = await stream.next();
        frames.push(frame);
        if (frame.event.type === "run_end") break;
      }
      const idRunEnd = frames.at(-1)!;
      assert.equal(idRunEnd.event.type, "run_end", "200 条事件里没等到 run_end");

      // id 单调（重放与实时是同一个序列，页面据此分片）
      for (let index = 1; index < frames.length; index += 1) {
        assert.ok(frames[index]!.id > frames[index - 1]!.id, `id 不单调：${frames[index - 1]!.id} → ${frames[index]!.id}`);
      }

      const markers = frames.map((frame) => markerOf(frame.event));
      assert.deepEqual(
        markers.filter((marker) => !marker.startsWith("text")),
        [
          "run_start",
          "turn",
          "tool_call:bash",
          "exec_start",
          "exec_output:stdout",
          "exec_end:completed:1",
          "tool_result:bash",
          "turn",
          "run_end",
        ],
      );

      // 命令输出是真的从沙箱里出来的（fixture 的测试会打印 FAIL 并以 1 退出）
      const output = frames.find((frame) => frame.event.type === "exec_output")!;
      assert.match(output.event.type === "exec_output" ? output.event.text : "", /FAIL: add\(2, 3\) = -1/);
      const execEnd = frames.find((frame) => frame.event.type === "exec_end")!;
      assert.equal(execEnd.event.type === "exec_end" ? execEnd.event.state : null, "completed");
      assert.equal(execEnd.event.type === "exec_end" ? execEnd.event.exitCode : null, 1);
      // 非 0 退出不是"工具报错"（Phase 1 §7 的语义），模型自己看退出码
      const toolResult = frames.find((frame) => frame.event.type === "tool_result")!;
      assert.equal(toolResult.event.type === "tool_result" ? toolResult.event.isError : null, false);

      // ---- 断线重连：从第 3 条之后接着读，必须正好是第 4 条开始的同一串
      const resumed = openReader(`${server.url}/runs/${encodeURIComponent(runId)}/stream`, {
        "last-event-id": String(frames[2]!.id),
      });
      try {
        const next = await resumed.next();
        assert.equal(next.id, frames[3]!.id, "重连后的第一条应该紧接断点（不重不漏）");
        assert.deepEqual(next.event, frames[3]!.event);
      } finally {
        await resumed.close();
      }

      // ---- `/info` 是页面判断"run 存不存在"的依据
      const info = (await (await fetch(`${server!.url}/runs/${encodeURIComponent(runId)}/info`)).json()) as {
        status: string;
        model: string | null;
        totalEvents: number;
        stopReason: string | null;
        ok: boolean | null;
      };
      assert.equal(info.status, "ended");
      assert.equal(info.model, "scripted-integration");
      assert.equal(info.ok, true);
      assert.equal(info.stopReason, "end_turn");
      assert.ok(info.totalEvents >= frames.length);
    } finally {
      await stream?.close();
      await server?.close();
      hub.close();
      await manager.destroySandbox(sandboxId, "phase13_test_done").catch(() => undefined);
    }
  });
});
