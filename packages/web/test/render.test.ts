/**
 * Phase 13 · 前端渲染路径（把 `public/app.js` 真跑起来，见 `dom.ts` 的说明）。
 *
 * 【为什么值得写】`app.js` 是这一批新代码里唯一一份"没有构建、也没有编译器"的东西：
 * 语法错了要靠 `ui.test.ts` 的 `vm.Script`，而**运行时**错了（未定义的函数、写错的属性、
 * 事件类型少一个分支）只有打开浏览器才知道。这里用极小的 DOM 替身把渲染跑一遍，
 * 于是下面这些事变成了 `npm test` 里的红：
 *  · 每一个 `RunEvent` 分支都能渲染而不抛异常
 *  · `exec_*` 与 `tool_result` 真的挂进了对应的工具块（不是飘在页面末尾）
 *  · 轮次按 `turn` 事件分组
 *  · 输出超过 400 行时真的在丢，并留下"前面 N 行没显示"
 *  · run 不存在 / 没有 run id / 终态三种状态各自的页面
 *
 * 【它不替代什么】观感与真实滚动仍然要人眼看一次（spec 的验收标准里那条手工项）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, test } from "node:test";
import type { RunEvent } from "../../control-plane/src/agent/events.ts";
import type { FakeDom, FakeNode } from "./dom.ts";
import { createDom } from "./dom.ts";

const appJs = await readFile(fileURLToPath(new URL("../public/app.js", import.meta.url)), "utf8");

/** `index.html` 里存在的那些 id（`ui.test.ts` 会把这份清单与 HTML 比对）。 */
const IDS = ["log", "state", "state-text", "theme", "run-id", "jump", "jump-button", "sentinel"];

interface Harness {
  dom: FakeDom;
  log: FakeNode;
  state: () => { name: string; text: string };
  runIdText: () => string;
  /** 派发一系列事件（自动等 `/info` 那次 fetch 与 EventSource 建好）。 */
  play(events: RunEvent[]): Promise<void>;
  source(): { url: string; closed: boolean; onopen: (() => void) | null; onerror: (() => void) | null };
  /** 让微任务跑完（`app.js` 的 openStream 是 async 的）。 */
  settle(): Promise<void>;
}

async function loadApp(options: { pathname: string; info?: unknown; status?: number }): Promise<Harness> {
  const dom = createDom({
    ids: IDS,
    pathname: options.pathname,
    fetches:
      options.info === undefined
        ? [{ match: "/info", status: options.status ?? 200, body: { error: "run_not_found" } }]
        : [{ match: "/info", status: options.status ?? 200, body: options.info }],
  });
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
        source.onmessage?.({ data: JSON.stringify(event) });
        await settle();
      }
    },
  };
}

const START: RunEvent = {
  type: "run_start",
  runId: "run_render",
  model: "deepseek-flash",
  issue: "跑一遍测试",
  repoDir: "/workspace/repo",
  limits: { maxTurns: 40, wallClockMs: 1_800_000, outputTokenBudget: 300_000, maxTokens: 64_000 },
};

const END: RunEvent = {
  type: "run_end",
  ok: true,
  stopReason: "end_turn",
  detail: "模型在第 2 轮正常收工",
  turns: 2,
  toolCalls: 1,
  usage: { inputTokens: 1200, outputTokens: 340, cacheReadInputTokens: 900, cacheCreationInputTokens: 0 },
};

function byClass(node: FakeNode, className: string): FakeNode | null {
  return node.one(className);
}

describe("Phase 13 · 页面渲染路径", () => {
  test("一次完整的 Run：题面卡片 / 轮次 / 助手文字 / 工具块 / 终态卡片", async () => {
    const app = await loadApp({
      pathname: "/runs/run_render",
      info: { runId: "run_render", status: "running", bufferedEvents: 3, totalEvents: 3 },
    });
    assert.equal(app.runIdText(), "run_render");
    assert.equal(app.source().url, "/runs/run_render/stream");

    await app.play([
      START,
      { type: "turn", turn: 1 },
      { type: "text", delta: "先跑" },
      { type: "text", delta: "一下测试。" },
      { type: "tool_call", turn: 1, id: "tu_1", name: "bash", input: { cmd: ["node", "test.js"] } },
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
      { type: "tool_result", turn: 1, id: "tu_1", name: "bash", isError: false, bytes: 40, content: "FAIL: add(2, 3) = -1\n[exit 1]" },
      { type: "turn", turn: 2 },
      { type: "text", delta: "跑完了" },
      END,
    ]);

    // 题面卡片
    const issue = byClass(app.log, "card__issue");
    assert.equal(issue?.textContent, "跑一遍测试");
    assert.match(byClass(app.log, "card__label")?.textContent ?? "", /题面/);
    assert.match(app.log.textContent, /deepseek-flash/);

    // 两个轮次，按 `turn` 事件分组
    assert.deepEqual(
      app.log.all("turn").map((node) => node.dataset["turn"]),
      ["1", "2"],
    );

    // 助手文字拼在同一个 `.say` 里（增量不各占一块）
    const firstTurn = app.log.all("turn")[0]!;
    assert.deepEqual(
      firstTurn.all("say").map((node) => node.textContent),
      ["先跑一下测试。"],
    );

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

  test("事件类型认不出时给一条说明（而不是静默吞掉）", async () => {
    const app = await loadApp({ pathname: "/runs/run_unknown_event", info: { status: "running", bufferedEvents: 1 } });
    await app.play([START, { type: "brand_new_thing" } as unknown as RunEvent]);
    assert.match(app.log.textContent, /认不出的事件类型：brand_new_thing/);
  });

  test("`note` 按 kind 给标签；模型报错那条是红的", async () => {
    const app = await loadApp({ pathname: "/runs/run_note", info: { status: "running", bufferedEvents: 2 } });
    await app.play([
      START,
      { type: "turn", turn: 1 },
      { type: "note", turn: 1, kind: "model_error", message: "连不上模型服务" },
      { type: "note", turn: null, kind: "gap", message: "页面渲染跟不上，3 条事件被丢弃" },
    ]);
    const notes = app.log.all("note");
    assert.equal(notes.length, 2);
    assert.equal(byClass(notes[0]!, "note__label")?.textContent, "模型错误");
    assert.equal(notes[0]!.dataset["kind"], "model_error");
    assert.equal(byClass(notes[1]!, "note__label")?.textContent, "丢帧");
  });

  test("命令输出是有界的：超过 400 行时丢掉最老的，并说明丢了多少", async () => {
    const app = await loadApp({ pathname: "/runs/run_bounded", info: { status: "running", bufferedEvents: 1 } });
    await app.play([
      START,
      { type: "turn", turn: 1 },
      { type: "tool_call", turn: 1, id: "tu_1", name: "bash", input: { cmd: ["yes"] } },
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

    await app.play([START, { type: "run_error", message: "clone 失败：仓库不存在" }]);
    assert.match(app.log.textContent, /clone 失败：仓库不存在/);
    assert.equal(app.state().name, "error");

    source.onerror?.();
    assert.equal(app.state().text, "已结束", "终态之后的断线只说'已结束'，不再假装在重连");
  });
});
