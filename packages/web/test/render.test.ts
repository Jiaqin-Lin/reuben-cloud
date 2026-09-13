/**
 * Phase 13 · 前端渲染路径（把 `public/app.js` 真跑起来，见 `dom.ts` 的说明）。
 *
 * 【为什么值得写】`app.js` 是这一批新代码里唯一一份"没有构建、也没有编译器"的东西：
 * 语法错了要靠 `ui.test.ts` 的 `vm.Script`，而**运行时**错了（未定义的函数、写错的属性、
 * 事件类型少一个分支）只有打开浏览器才知道。这里用极小的 DOM 替身把渲染跑一遍，
 * 于是下面这些事变成了 `npm test` 里的红：
 *  · 每一个 `HubEvent` 分支都能渲染而不抛异常
 *  · `exec_*` 与工具结果真的挂进了对应的工具块（不是飘在页面末尾）
 *  · 轮次按 `turn_start` 分组、助手文字按 `message_update` 增量拼起来
 *  · 输出超过 400 行时真的在丢，并留下"前面 N 行没显示"
 *  · 上下文面板（P4）按 `context_compiled` 画出分区占比与压缩标记
 *  · 会话视图（P4）按 `runs.startEntryId` 把历史与本次执行切开
 *  · run 不存在 / 没有 run id / 终态三种状态各自的页面
 *
 * 【事件怎么进页面】测试用后端真有的 `sseFrameOf()` 决定通道名，再按那个通道派发——
 * 与浏览器里 `EventSource` 的行为一致（名字对不上就不派发）。所以"通道名写错了"这类
 * 问题也会在这里红。
 *
 * 【它不替代什么】观感与真实滚动仍然要人眼看一次（spec 的验收标准里那条手工项）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, test } from "node:test";
import type { AgentMessage, AssistantMessage, Usage } from "@reuben-cloud/agent-runtime";
import { emptyUsage } from "@reuben-cloud/agent-runtime";
import type { HubEvent } from "../../control-plane/src/agent/events.ts";
import { sseFrameOf } from "../../control-plane/src/agent/events.ts";
import type { FakeDom, FakeNode } from "./dom.ts";
import { createDom } from "./dom.ts";

const appJs = await readFile(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");

/** `index.html` 里存在的那些 id（`ui.test.ts` 会把这份清单与 HTML 比对）。 */
const IDS = ["log", "context", "state", "state-text", "theme", "run-id", "jump", "jump-button", "sentinel"];

interface Harness {
  dom: FakeDom;
  log: FakeNode;
  panel: FakeNode;
  state: () => { name: string; text: string };
  runIdText: () => string;
  /** 派发一系列事件（自动等 `/info`、会话历史那两次 fetch 与 EventSource 建好）。 */
  play(events: HubEvent[]): Promise<void>;
  /** 最后一个 EventSource（派发事件、看它有没有被关掉）。 */
  source(): { url: string; closed: boolean; onopen: (() => void) | null; onerror: (() => void) | null; dispatch(name: string, data: unknown): void };
  /** 让微任务跑完（`app.js` 的 openStream 是 async 的）。 */
  settle(): Promise<void>;
}

async function loadApp(options: { pathname: string; info?: unknown; status?: number; session?: unknown }): Promise<Harness> {
  const fetches = [
    ...(options.session === undefined ? [] : [{ match: "/entries", status: 200, body: options.session }]),
    {
      match: "/info",
      status: options.status ?? 200,
      body: options.info ?? { error: "run_not_found" },
    },
  ];
  const dom = createDom({ ids: IDS, pathname: options.pathname, fetches });
  const context = vm.createContext(dom.globals);
  new vm.Script(appJs, { filename: "app.js" }).runInContext(context, { timeout: 5_000 });

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  await settle();

  const log = dom.document.getElementById("log")!;
  return {
    dom,
    log,
    panel: dom.document.getElementById("context")!,
    settle,
    state: () => {
      const element = dom.document.getElementById("state")!;
      return { name: element.dataset["state"] ?? "", text: dom.document.getElementById("state-text")!.textContent };
    },
    runIdText: () => dom.document.getElementById("run-id")!.textContent,
    source: () => {
      const found = dom.sources.at(-1);
      assert.ok(found !== undefined, "app.js 没有建 EventSource");
      return found;
    },
    async play(events) {
      const source = dom.sources.at(-1);
      assert.ok(source !== undefined, "app.js 没有建 EventSource");
      source.onopen?.();
      for (const event of events) {
        const frame = sseFrameOf(event);
        source.dispatch(frame.event, frame.data);
        await settle();
      }
    },
  };
}

// ---------------------------------------------------------------- 事件构造

const USAGE: Usage = { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 900, cacheCreationInputTokens: 0 };

function runStart(sessionId: string | null = null): HubEvent {
  return {
    type: "run_start",
    runId: "run_render",
    sessionId,
    model: "deepseek-flash",
    issue: "跑一遍测试",
    repoDir: "/workspace/repo",
    limits: { maxTurns: 40, wallClockMs: 1_800_000, outputTokenBudget: 300_000, maxTokens: 64_000 },
  };
}

const RUN_END: HubEvent = {
  type: "run_end",
  ok: true,
  stopReason: "end_turn",
  detail: "模型在第 2 轮正常收工",
  turns: 2,
  toolCalls: 1,
  usage: USAGE,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content, usage: emptyUsage(), stopReason };
}

/** 用户消息（循环对 prompt / 插话都发 start + end 两条）。 */
function userMessage(text: string): HubEvent[] {
  const message: AgentMessage = { role: "user", content: text };
  return [
    { type: "message_start", message },
    { type: "message_end", message },
  ];
}

/** 助手文字：start + 逐段 delta + end（与真循环的事件序一致）。 */
function assistantText(text: string): HubEvent[] {
  const partial = assistant([{ type: "text", text }]);
  const events: HubEvent[] = [{ type: "message_start", message: assistant([{ type: "text", text: "" }]) }];
  for (const chunk of [text.slice(0, 2), text.slice(2)]) {
    events.push({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk, partial },
    });
  }
  events.push({ type: "message_end", message: partial });
  return events;
}

function toolResultMessage(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

function byClass(node: FakeNode, className: string): FakeNode | null {
  return node.one(className);
}

describe("Phase 13 · 页面渲染路径", () => {
  test("一次完整的 Run：题面卡片 / 轮次 / 助手文字 / 工具块 / 终态卡片", async () => {
    const app = await loadApp({
      pathname: "/runs/run_render",
      info: { runId: "run_render", status: "running", bufferedEvents: 3, totalEvents: 3, sessionId: null },
    });
    assert.equal(app.runIdText(), "run_render");
    assert.equal(app.source().url, "/runs/run_render/stream");

    await app.play([
      runStart(),
      // 第一轮：任务书（题面卡片里已经有了，不再重复画）+ 助手文字 + 一次 bash
      { type: "turn_start" },
      ...userMessage("跑一遍测试"),
      ...assistantText("先跑一下测试。"),
      { type: "tool_execution_start", toolCallId: "tu_1", toolName: "bash", args: { command: "node test.js" } },
      { type: "exec_start", executionId: "exe_1", cmd: ["node", "test.js"], cwd: "/workspace/repo" },
      { type: "exec_output", executionId: "exe_1", stream: "stdout", text: "FAIL: add(2, 3) = -1\n" },
      { type: "exec_output", executionId: "exe_1", stream: "stderr", text: "warn\n" },
      {
        type: "exec_end",
        executionId: "exe_1",
        state: "completed",
        exitCode: 1,
        durationMs: 812,
        stdoutBytes: 25,
        stderrBytes: 5,
        truncated: false,
        logPath: "/tmp/reuben-cloud/exec/exe_1.log",
      },
      { type: "tool_execution_end", toolCallId: "tu_1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "FAIL: add(2, 3) = -1\n[exit 1]" }] } },
      { type: "message_start", message: toolResultMessage("tu_1", "bash", "FAIL: add(2, 3) = -1") },
      { type: "message_end", message: toolResultMessage("tu_1", "bash", "FAIL: add(2, 3) = -1") },
      { type: "turn_end", message: assistant([]), toolResults: [] },
      // 第二轮：收工
      { type: "turn_start" },
      ...assistantText("跑完了"),
      { type: "turn_end", message: assistant([]), toolResults: [] },
      { type: "agent_end", messages: [] },
      RUN_END,
    ]);

    // 题面卡片
    const issue = byClass(app.log, "card__issue");
    assert.equal(issue?.textContent, "跑一遍测试");
    assert.match(byClass(app.log, "card__label")?.textContent ?? "", /题面/);
    assert.match(app.log.textContent, /deepseek-flash/);

    // 两个轮次，按 `turn_start` 分组（事件里没有序号，前端自己数）
    assert.deepEqual(
      app.log.all("turn").map((node) => node.dataset["turn"]),
      ["1", "2"],
    );

    // 助手文字拼在同一个 `.say` 里（增量不各占一块）；任务书没有重复画一遍
    const firstTurn = app.log.all("turn")[0]!;
    assert.deepEqual(
      firstTurn.all("say").map((node) => node.textContent),
      ["先跑一下测试。"],
    );
    assert.equal(app.log.all("say--user").length, 0, "第一条 user 消息是题面，不重复渲染");

    // 工具块：命令在表头，参数折叠，输出与终态在同一个块里
    const tool = firstTurn.one("tool")!;
    assert.equal(byClass(tool, "tool__name")?.textContent, "bash");
    assert.equal(byClass(tool, "tool__arg")?.textContent, "node test.js");
    assert.equal(byClass(tool, "fold__summary")?.textContent, "参数");
    const output = byClass(tool, "exec__out");
    assert.match(output?.textContent ?? "", /FAIL: add\(2, 3\) = -1/);
    assert.match(output?.textContent ?? "", /warn/);
    assert.equal(output?.all("chunk--err").length, 1, "stderr 的那一块要有自己的颜色");
    const execEnd = byClass(tool, "exec__end")!;
    assert.match(execEnd.textContent, /exit 1/);
    assert.match(execEnd.textContent, /812ms/);
    assert.match(execEnd.textContent, /\/tmp\/reuben-cloud\/exec\/exe_1\.log/);
    assert.equal(execEnd.classList.contains("is-error"), true, "非 0 退出要标出来");

    // 工具结果挂进同一个工具块（且不在别的块里）
    const result = byClass(tool, "tool__result");
    assert.match(result?.textContent ?? "", /\[exit 1\]/);
    assert.equal(app.log.all("tool").length, 1);

    // 终态卡片：实数与原因都在，状态行跟着变
    const end = byClass(app.log, "end")!;
    assert.match(end.textContent, /Run 结束/);
    assert.match(end.textContent, /模型在第 2 轮正常收工/);
    assert.match(end.textContent, /1200/);
    assert.equal(app.state().text, "模型正常收工");
    assert.equal(app.dom.document.getElementById("state")!.dataset["state"], "done");
  });

  test("工具执行中的增量挂进卡片（`tool_execution_update`）", async () => {
    const app = await loadApp({ pathname: "/runs/run_update", info: { status: "running", bufferedEvents: 1 } });
    await app.play([
      runStart(),
      { type: "turn_start" },
      { type: "tool_execution_start", toolCallId: "tu_1", toolName: "bash", args: { command: "npm test" } },
      { type: "tool_execution_update", toolCallId: "tu_1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "正在跑…\n" }] } },
    ]);
    const tool = app.log.one("tool")!;
    assert.equal(byClass(tool, "tool__progress")?.textContent, "正在跑…\n");
  });

  test("事件类型认不出时给一条说明（而不是静默吞掉）", async () => {
    const app = await loadApp({ pathname: "/runs/run_unknown_event", info: { status: "running", bufferedEvents: 1 } });
    // 通道名是真的（tool），data.type 是假的：后端加了事件而前端没跟上时就是这个样子。
    const source = app.source();
    source.onopen?.();
    source.dispatch("tool", { type: "brand_new_thing" });
    await app.settle();
    assert.match(app.log.textContent, /认不出的事件类型：brand_new_thing/);
    // 完全不认识的**通道**不该有反应（EventSource 只派发有人监听的类型），页面不白屏。
    source.dispatch("future_channel", { type: "whatever" });
    await app.settle();
    assert.equal(app.log.all("note").length, 1);
  });

  test("`note` 按 kind 给标签；模型报错那条是红的", async () => {
    const app = await loadApp({ pathname: "/runs/run_note", info: { status: "running", bufferedEvents: 2 } });
    await app.play([
      runStart(),
      { type: "turn_start" },
      { type: "note", kind: "model_error", message: "连不上模型服务" },
      { type: "note", kind: "gap", message: "页面渲染跟不上，3 条事件被丢弃" },
      { type: "note", kind: "compaction_failed", message: "摘要压不出来" },
    ]);
    const notes = app.log.all("note");
    assert.equal(notes.length, 3);
    assert.equal(byClass(notes[0]!, "note__label")?.textContent, "模型错误");
    assert.equal(notes[0]!.dataset["kind"], "model_error");
    assert.equal(byClass(notes[1]!, "note__label")?.textContent, "丢帧");
    assert.equal(byClass(notes[2]!, "note__label")?.textContent, "压缩失败");
  });

  test("命令输出是有界的：超过 400 行时丢掉最老的，并说明丢了多少", async () => {
    const app = await loadApp({ pathname: "/runs/run_bounded", info: { status: "running", bufferedEvents: 1 } });
    await app.play([
      runStart(),
      { type: "turn_start" },
      { type: "tool_execution_start", toolCallId: "tu_1", toolName: "bash", args: { command: "yes" } },
      { type: "exec_start", executionId: "exe_1", cmd: ["yes"], cwd: "/workspace/repo" },
    ]);
    // 300 行一块，来 3 块 = 900 行 → 只该留下最后 400 行左右
    for (let index = 0; index < 3; index += 1) {
      await app.play([
        {
          type: "exec_output",
          executionId: "exe_1",
          stream: "stdout",
          text: Array.from({ length: 300 }, (_, line) => `line-${index}-${line}`).join("\n") + "\n",
        },
      ]);
    }
    const output = byClass(app.log, "exec__out")!;
    const markers = output.all("chunk--omitted");
    assert.equal(markers.length, 1, "只该有一个'省略'标记");
    assert.match(markers[0]!.textContent, /前面 \d+ 行没显示/);
    assert.match(output.textContent, /line-2-299/);
    assert.equal(/line-0-0\n/.test(output.textContent), false, "最老的那一段应该已经被丢掉");
  });

  test("run 不存在：一句人话 + 一条回到最近 Run 的链接（不再重试）", async () => {
    const app = await loadApp({ pathname: "/runs/run_gone", status: 404 });
    assert.equal(app.state().name, "error");
    assert.equal(app.dom.sources.length, 0, "404 时不该再去开 SSE");
    assert.match(app.log.textContent, /找不到这个 Run/);
    assert.match(app.log.textContent, /run_gone/);
    assert.equal(byClass(app.log, "link")?.href, "/");
  });

  test("URL 里没有 run id：说清楚地址该长什么样", async () => {
    const app = await loadApp({ pathname: "/" });
    assert.equal(app.runIdText(), "（没有 id）");
    assert.match(app.log.textContent, /URL 里没有 Run id/);
    assert.match(app.log.textContent, /\/runs\/<runId>/);
  });

  test("主题按钮：三态循环，并把解析后的深浅色写到 <html data-theme>", async () => {
    const app = await loadApp({ pathname: "/runs/run_theme", info: { status: "running", bufferedEvents: 0 } });
    const button = app.dom.document.getElementById("theme")!;
    const themeOf = (): string => app.dom.document.documentElement.dataset["theme"] ?? "";

    assert.equal(button.textContent, "跟随系统");
    assert.equal(themeOf(), "light", "系统是浅色时 auto 要解析成 light");
    button.dispatch("click");
    assert.equal(button.textContent, "浅色");
    button.dispatch("click");
    assert.equal(button.textContent, "深色");
    assert.equal(themeOf(), "dark");
    button.dispatch("click");
    assert.equal(button.textContent, "跟随系统", "第三次点回到 auto");
    assert.equal(themeOf(), "light");
  });

  test("循环之外的崩（run_error）与断线（onerror）都有交代", async () => {
    const app = await loadApp({ pathname: "/runs/run_err", info: { status: "running", bufferedEvents: 1 } });
    const source = app.source();
    source.onerror?.();
    assert.equal(app.state().text, "重连中", "还没结束时的断线是'重连中'（浏览器自己会重试）");

    await app.play([runStart(), { type: "run_error", message: "clone 失败：仓库不存在" }]);
    assert.match(app.log.textContent, /clone 失败：仓库不存在/);
    assert.equal(app.state().name, "error");

    source.onerror?.();
    assert.equal(app.state().text, "已结束", "终态之后的断线只说'已结束'，不再假装在重连");
  });

  test("上下文面板：分区 token / 占比 / hash 前 8 位 / 压缩标记", async () => {
    const app = await loadApp({ pathname: "/runs/run_ctx", info: { status: "running", bufferedEvents: 1 } });
    assert.equal(app.panel.hidden, true, "没有 context_compiled 之前面板不占地方");

    await app.play([
      runStart(),
      { type: "turn_start" },
      {
        type: "context_compiled",
        turn: 1,
        hash: "0123456789abcdef",
        sections: [
          { name: "system", tokens: 3000, hash: "aaaaaaaa1111" },
          { name: "repo_map", tokens: 1000, hash: "bbbbbbbb2222" },
        ],
      },
    ]);

    assert.equal(app.panel.hidden, false);
    assert.match(app.panel.textContent, /上下文/);
    assert.match(app.panel.textContent, /4,000 token/);
    assert.match(app.panel.textContent, /编译 01234567/, "compiled_hash 只显示前 8 位");
    assert.match(app.panel.textContent, /未压缩/);

    const rows = app.panel.all("ctx-section");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]!.all("ctx-section__name").map((node) => node.textContent), ["system"]);
    assert.equal(byClass(rows[0]!, "ctx-section__tokens")?.textContent, "3,000");
    assert.equal(byClass(rows[0]!, "ctx-section__pct")?.textContent, "75%");
    assert.equal(byClass(rows[0]!, "ctx-section__hash")?.textContent, "aaaaaaaa");
    assert.equal(byClass(rows[1]!, "ctx-section__pct")?.textContent, "25%");

    // 压缩事件：流里一条分隔线，面板上的标记跟着点亮
    await app.play([{ type: "compaction", reason: "threshold", tokensBefore: 12345, firstKeptEntryId: "ent_keep" }]);
    const divider = app.log.one("divider")!;
    assert.match(divider.textContent, /已压缩/);
    assert.match(divider.textContent, /12,345 token/);
    assert.match(divider.textContent, /ent_keep/);
    assert.equal(byClass(app.panel, "panel__flag")?.textContent, "已压缩");
  });

  test("会话视图：历史 entries 画出来，本次执行的部分留给实时流", async () => {
    const app = await loadApp({
      pathname: "/runs/run_now",
      info: { runId: "run_now", status: "running", bufferedEvents: 1, totalEvents: 1, sessionId: "ses_1" },
      session: {
        sessionId: "ses_1",
        runs: [
          { id: "run_prev", sessionId: "ses_1", startEntryId: null, endEntryId: "ent_2", model: "m1", status: "stopped", stopReason: "end_turn" },
          { id: "run_now", sessionId: "ses_1", startEntryId: "ent_2", endEntryId: null, model: "m2", status: "running", stopReason: null },
        ],
        entries: [
          { id: "ent_1", runId: "run_prev", seq: 1, type: "message", payload: { role: "user", content: "上一轮的问题" } },
          { id: "ent_2", runId: "run_prev", seq: 2, type: "message", payload: { role: "assistant", content: [{ type: "text", text: "上一轮的回答" }] } },
          { id: "ent_3", runId: "run_now", seq: 3, type: "message", payload: { role: "user", content: "本次执行的题面" } },
        ],
      },
    });

    // 历史：上一轮的 user / assistant + 一条 Run 边界；本次执行的 ent_3 不在这里画
    assert.match(app.log.textContent, /上一轮的问题/);
    assert.match(app.log.textContent, /上一轮的回答/);
    assert.match(app.log.textContent, /Run run_prev/);
    assert.equal(/本次执行的题面/.test(app.log.textContent), false, "本次执行的部分由实时流画（不重叠）");
    assert.equal(app.log.all("say--user").length, 1);

    // 实时流接上本次执行：题面卡片 + 插话（第一条 user 消息是任务书，不重复画）
    await app.play([runStart("ses_1"), { type: "turn_start" }, ...userMessage("本次执行的题面"), ...userMessage("再补一句")]);
    assert.match(app.log.textContent, /再补一句/);
    assert.equal(app.log.all("say--user").length, 2, "历史一条 + 插话一条（题面已经在卡片里了）");
  });

  test("会话视图读不到时只显示实时流（历史是锦上添花）", async () => {
    const app = await loadApp({
      pathname: "/runs/run_nohistory",
      info: { runId: "run_nohistory", status: "running", bufferedEvents: 1, sessionId: "ses_x" },
      session: { error: "session_not_found" },
    });
    await app.play([runStart("ses_x"), { type: "turn_start" }, ...assistantText("照样能看")]);
    assert.match(app.log.textContent, /照样能看/);
  });
});
