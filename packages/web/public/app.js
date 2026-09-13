/**
 * `app.js` —— 观察窗的前端（Phase 13）。
 *
 * 【这一层只做三件事】连 SSE、把事件渲染成 DOM、别把页面卡住。
 * 它不认识沙箱、不认识模型、不知道一次 Run 该怎么跑：`docs/sandbox-spec.md` §Phase 13 的
 * 技术边界是"只读、不做交互"，所以这里连一个 POST 都没有。
 *
 * 【为什么是原生 ESM + 无构建】正文的理由（"再引一套打包工具不划算"）之外还有一条：
 * 没有构建 = 没有依赖，也就没有供应链。这个文件里一个 import 都没有，所以它既能被
 * 浏览器直接当模块加载，也能被测试用 `new vm.Script()` 整份语法检查（见 `test/ui.test.ts`）。
 *
 * 【安全：所有动态内容一律走 textContent】题面、模型输出、命令输出、工具结果全是外部输入，
 * 而它们都会出现在页面上。这个文件里**没有一处拼 HTML**（`test/ui.test.ts` 会拦下来），
 * 内容进 DOM 的唯一通道是 `textContent` / `createTextNode`——这类页面真正的安全问题
 * 只有这一个，用 textContent 就整类没有了。
 *
 * 【DOM 是有上限的】一次 Run 的命令输出可以是几十 MB。`StreamBox` 只保留最后
 * `MAX_OUTPUT_LINES` 行，工具结果默认折叠且只渲染前 `MAX_RESULT_LINES` 行。
 * 不设这两条的话，"跑一个 npm install"就能让页面在一分钟后卡死——而卡死的是观察窗，
 * 那等于把"能看清每一步"这个前提弄丢了。
 *
 * 【样式：对 Anthropic / Claude 视觉语言的致敬式近似，不是官方资源】
 * 暖中性底色 + 陶土色强调（`--accent`）+ 无气泡的消息流。字体走系统栈：这个页面要求
 * 离线可用、不加外部请求，自托管字体换来的那点气质不值得多一个二进制资源。
 */

const MAX_OUTPUT_LINES = 400;
const MAX_RESULT_LINES = 300;
const THEME_KEY = "reuben-cloud.theme";

/** 三态主题。`auto` 会被解析成 light / dark 写到 `<html data-theme>`（见 applyTheme）。 */
const THEMES = [
  { id: "auto", label: "跟随系统" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
];

/** 说明类事件的标签（`note.kind` → 人话）。认不出的 kind 会原样显示。 */
const NOTE_LABELS = {
  context_trim: "上下文",
  repeat_notice: "重复调用",
  repeat_stop: "重复调用",
  model_error: "模型错误",
  incomplete: "提前结束",
  gap: "丢帧",
  exec_truncated: "输出截断",
  exec_unknown: "协议",
  exec_unparsed: "协议",
};

/** `run_end.stopReason` → 人话。认不出的原样显示（循环加了新终态时不会静默）。 */
const STOP_LABELS = {
  end_turn: "模型正常收工",
  refusal: "模型拒绝了这次请求",
  max_turns: "撞上轮数上限",
  wall_clock: "撞上墙钟上限",
  output_token_budget: "撞上输出 token 上限",
  repeated_tool_calls: "同一调用重复太多次",
  model_error: "模型调用失败",
  aborted: "被取消",
  incomplete_response: "这一轮既没有工具调用也没正常收尾",
};

// ---------------------------------------------------------------- 小工具

/** 建一个元素。**文字一律走 textContent**（见文件头）。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function countLines(text) {
  if (text === "") return 0;
  let lines = 0;
  for (const char of text) if (char === "\n") lines += 1;
  return text.endsWith("\n") ? lines : lines + 1;
}

function firstLine(text) {
  const line = String(text ?? "").split("\n")[0].trim();
  return line === "" ? "（题面为空）" : line;
}

/** 工具参数的一行摘要。认不出的工具就退回紧凑 JSON（不猜语义）。 */
function summarizeInput(name, input) {
  const record = input !== null && typeof input === "object" ? input : {};
  if (name === "bash" && Array.isArray(record.cmd)) return record.cmd.join(" ");
  if (typeof record.path === "string") return record.path;
  if (typeof record.query === "string") return record.query;
  const json = JSON.stringify(input ?? {});
  return json === undefined ? "" : json.length > 96 ? `${json.slice(0, 96)}…` : json;
}

/** 从 `/runs/<id>` 里取 run id。取不到返回 null（页面会显示"URL 里没有 id"）。 */
function runIdFromPath(pathname) {
  const segments = String(pathname ?? "").split("/").filter((segment) => segment !== "");
  if (segments.length !== 2 || segments[0] !== "runs") return null;
  try {
    return decodeURIComponent(segments[1]) || null;
  } catch {
    return null;
  }
}

/** 只渲染前 maxLines 行，后面折成一行说明（工具结果专用）。 */
function clampLines(text, maxLines) {
  const lines = String(text ?? "").split("\n");
  if (lines.length <= maxLines) return { text: String(text ?? ""), omitted: 0 };
  return { text: lines.slice(0, maxLines).join("\n"), omitted: lines.length - maxLines };
}

// ---------------------------------------------------------------- 有界的输出框

/**
 * 一块只保留最后 N 行的等宽输出区（命令输出用它）。
 * 按"块"（chunk）而不是按字节丢：stderr 的着色是按块的，丢掉半块会把颜色截断。
 */
class StreamBox {
  constructor(pre, maxLines) {
    this.pre = pre;
    this.maxLines = maxLines;
    this.lines = 0;
    this.omittedLines = 0;
    this.marker = el("span", "chunk chunk--omitted");
  }

  append(text, stream) {
    const chunk = el("span", "chunk");
    if (stream === "stderr") chunk.classList.add("chunk--err");
    chunk.textContent = text;
    this.pre.append(chunk);
    this.lines += countLines(text);

    while (this.lines > this.maxLines) {
      const first = this.pre.firstChild;
      if (first === null || first === this.pre.lastChild) break;
      this.omittedLines += countLines(first.textContent);
      this.lines -= countLines(first.textContent);
      first.remove();
    }
    if (this.omittedLines > 0) {
      this.marker.textContent = `… 前面 ${this.omittedLines} 行没显示\n`;
      if (this.pre.firstChild !== this.marker) this.pre.prepend(this.marker);
    }
  }
}

// ---------------------------------------------------------------- 页面状态

const log = document.getElementById("log");
const jump = document.getElementById("jump");
const jumpButton = document.getElementById("jump-button");
const stateEl = document.getElementById("state");
const stateText = document.getElementById("state-text");
const themeButton = document.getElementById("theme");
const runIdEl = document.getElementById("run-id");
const sentinel = document.getElementById("sentinel");

/** 跟着新内容滚到底（用户往上翻过之后就不再打扰他）。 */
let pinned = true;
let ended = false;
/** 当前这一轮的元素（`turn` 事件建的）；没有就挂在 `log` 上。 */
let turnNode = null;
/** 当前这一段的 assistant 文字（下一个非 text 事件到达时清空）。 */
let sayNode = null;
/** tool_use id → 外层元素（tool_result 回来时挂进去）。 */
const toolNodes = new Map();
/** executionId → { box }（exec_output / exec_end 按它找落点）。 */
const execNodes = new Map();
/** 最近一个工具块：`exec_start` 没有 tool id 可挂时落在这里。 */
let lastToolNode = null;

function setState(name, text) {
  stateEl.dataset.state = name;
  stateText.textContent = text;
}

function container() {
  return turnNode ?? log;
}

function atBottom() {
  const doc = document.documentElement;
  return doc.scrollHeight - window.scrollY - window.innerHeight < 160;
}

function scrollToBottom() {
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
}

new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      pinned = entry.isIntersecting;
      jump.hidden = pinned;
    }
  },
  { threshold: 0 },
).observe(sentinel);

jumpButton.addEventListener("click", () => {
  pinned = true;
  jump.hidden = true;
  scrollToBottom();
});

// ---------------------------------------------------------------- 主题

const media = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(mode) {
  const resolved = mode === "auto" ? (media.matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
  const theme = THEMES.find((candidate) => candidate.id === mode) ?? THEMES[0];
  themeButton.textContent = theme.label;
  themeButton.dataset.mode = theme.id;
}

function readTheme() {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (THEMES.some((theme) => theme.id === stored)) return stored;
  } catch {
    // 隐私模式下 localStorage 会抛。主题不是关键功能，回退到"跟随系统"。
  }
  return "auto";
}

applyTheme(readTheme());

themeButton.addEventListener("click", () => {
  const current = themeButton.dataset.mode ?? "auto";
  const next = THEMES[(THEMES.findIndex((theme) => theme.id === current) + 1) % THEMES.length];
  try {
    window.localStorage.setItem(THEME_KEY, next.id);
  } catch {
    // 同上：存不下就只在这次会话里生效。
  }
  applyTheme(next.id);
});

media.addEventListener("change", () => applyTheme(themeButton.dataset.mode ?? "auto"));

// ---------------------------------------------------------------- 渲染

function metaRow(items) {
  const row = el("div", "meta");
  for (const item of items) {
    const cell = el("span", "meta__item");
    cell.append(el("span", "meta__key", item.key));
    cell.append(el("span", "meta__value", item.value));
    row.append(cell);
  }
  return row;
}

function renderRunStart(event) {
  const card = el("section", "card");
  card.append(el("div", "card__label", "题面"));
  card.append(el("pre", "card__issue", event.issue));
  card.append(
    metaRow([
      { key: "模型", value: event.model },
      { key: "工作目录", value: event.repoDir },
      {
        key: "上限",
        value: `${event.limits.maxTurns} 轮 / ${Math.round(event.limits.wallClockMs / 60_000)} 分钟 / ${event.limits.outputTokenBudget} 输出 token`,
      },
    ]),
  );
  log.append(card);
}

function renderTurn(turn) {
  sayNode = null;
  lastToolNode = null;
  turnNode = el("section", "turn");
  turnNode.dataset.turn = String(turn);
  turnNode.append(el("div", "turn__label", `Turn ${turn}`));
  log.append(turnNode);
}

function appendText(delta) {
  if (sayNode === null) {
    sayNode = el("div", "say");
    container().append(sayNode);
  }
  // 文本节点追加：模型输出的换行与空格都原样保留（`.say` 是 pre-wrap）。
  sayNode.append(document.createTextNode(delta));
}

function renderToolCall(event) {
  sayNode = null;
  const node = el("article", "tool");
  node.dataset.toolId = event.id;
  const head = el("div", "tool__head");
  head.append(el("span", "tool__name", event.name));
  head.append(el("span", "tool__arg", summarizeInput(event.name, event.input)));
  node.append(head);

  const input = JSON.stringify(event.input ?? {}, null, 2);
  if (input !== "{}" && input.length > 2) node.append(collapsible("参数", input, false, "tool__input"));

  container().append(node);
  toolNodes.set(event.id, node);
  lastToolNode = node;
}

function renderToolResult(event) {
  sayNode = null;
  const clamped = clampLines(event.content, MAX_RESULT_LINES);
  const body = clamped.omitted > 0 ? `${clamped.text}\n\n… 后面 ${clamped.omitted} 行没显示` : clamped.text;
  const title = `${event.isError ? "工具报错" : "结果"} / ${formatBytes(event.bytes)}`;
  const block = collapsible(title, body, event.isError, "tool__result");
  const target = toolNodes.get(event.id) ?? lastToolNode ?? container();
  target.append(block);
}

function renderExecStart(event) {
  sayNode = null;
  const node = el("div", "exec");
  // 命令通常已经写在工具块的表头里（`.tool__arg`），重复一遍是噪音；
  // 只有没有工具块可挂的时候（重放缺口）才把命令写全。
  if (lastToolNode === null) node.append(el("div", "exec__cmd", event.cmd.join(" ")));
  const out = el("pre", "exec__out");
  node.append(out);
  (lastToolNode ?? container()).append(node);

  const key = event.executionId ?? `unknown-${execNodes.size}`;
  execNodes.set(key, { node, box: new StreamBox(out, MAX_OUTPUT_LINES) });
}

function renderExecOutput(event) {
  const target = execNodes.get(event.executionId ?? "");
  if (target === undefined) {
    // `started` 事件丢了（重放有空洞）也要把输出显示出来，而不是静默丢掉。
    renderExecStart({ executionId: event.executionId, cmd: ["（命令）"], cwd: null });
    return renderExecOutput(event);
  }
  target.box.append(event.text ?? "", event.stream);
}

function renderExecEnd(event) {
  const target = execNodes.get(event.executionId ?? "");
  const items = [event.state];
  if (event.exitCode !== null) items.push(`exit ${event.exitCode}`);
  const duration = formatDuration(event.durationMs);
  if (duration !== null) items.push(duration);
  items.push(`stdout ${formatBytes(event.stdoutBytes)}`);
  items.push(`stderr ${formatBytes(event.stderrBytes)}`);
  if (event.truncated) items.push("事件流里有截断");
  if (event.logPath) items.push(`完整日志 ${event.logPath}`);

  const row = el("div", "exec__end");
  for (const item of items) row.append(el("span", "exec__stat", item));
  if (event.state !== "completed" || (event.exitCode ?? 0) !== 0) row.classList.add("is-error");
  (target?.node ?? lastToolNode ?? container()).append(row);
}

function renderNote(event) {
  sayNode = null;
  const node = el("div", "note");
  node.dataset.kind = event.kind ?? "";
  node.append(el("span", "note__label", NOTE_LABELS[event.kind] ?? event.kind ?? "说明"));
  node.append(el("span", "note__text", event.message));
  container().append(node);
}

function renderRunEnd(event) {
  ended = true;
  setState(event.ok ? "done" : "stopped", STOP_LABELS[event.stopReason] ?? event.stopReason);
  const card = el("section", "end");
  card.classList.toggle("end--ok", event.ok === true);
  card.append(el("div", "end__title", event.ok ? "Run 结束" : "Run 停止"));
  card.append(el("p", "end__detail", event.detail));
  card.append(
    metaRow([
      { key: "轮数", value: String(event.turns) },
      { key: "工具调用", value: String(event.toolCalls) },
      { key: "输入 token", value: String(event.usage.inputTokens) },
      { key: "输出 token", value: String(event.usage.outputTokens) },
      { key: "缓存命中", value: String(event.usage.cacheReadInputTokens) },
    ]),
  );
  log.append(card);
}

function renderRunError(message) {
  ended = true;
  setState("error", "出错了");
  const card = el("section", "end end--error");
  card.append(el("div", "end__title", "这次 Run 没能跑起来"));
  card.append(el("p", "end__detail", message));
  log.append(card);
}

function renderWaiting(text) {
  log.append(el("p", "empty", text));
}

function renderMissingRun(runId) {
  const card = el("section", "card");
  card.append(el("div", "card__label", "找不到这个 Run"));
  card.append(el("p", "card__text", `观察窗里没有 ${runId} 的事件缓冲。`));
  card.append(
    el(
      "p",
      "card__text",
      "缓冲只在内存里，CP 进程重启过就没了。重新跑一次 npm run agent:run -- --serve，用新打印的地址打开。",
    ),
  );
  const link = el("a", "link", "看看最近的 Run");
  link.href = "/";
  card.append(link);
  log.append(card);
}

function renderNoRun() {
  const card = el("section", "card");
  card.append(el("div", "card__label", "URL 里没有 Run id"));
  card.append(el("p", "card__text", "这个页面的地址形如 /runs/<runId>。"));
  card.append(el("p", "card__text", "npm run agent:run 加上 --serve 之后，它会打印出带 run id 的完整地址。"));
  const link = el("a", "link", "看看最近的 Run");
  link.href = "/";
  card.append(link);
  log.append(card);
}

/** 折叠块：默认收起的参数 / 结果都走它（`<details>` 自带键盘可达）。 */
function collapsible(title, body, open, className) {
  const details = el("details", `fold ${className ?? ""}`.trim());
  details.open = open === true;
  details.append(el("summary", "fold__summary", title));
  details.append(el("pre", "fold__body", body));
  return details;
}

// ---------------------------------------------------------------- 事件分发

function handle(event) {
  // 滚动跟随的判断必须在**改 DOM 之前**做（改完再判断，页面已经被撑长了）。
  const follow = pinned || atBottom();
  switch (event.type) {
    case "run_start":
      renderRunStart(event);
      break;
    case "turn":
      renderTurn(event.turn);
      break;
    case "text":
      appendText(event.delta ?? "");
      break;
    case "tool_call":
      renderToolCall(event);
      break;
    case "tool_result":
      renderToolResult(event);
      break;
    case "exec_start":
      renderExecStart(event);
      break;
    case "exec_output":
      renderExecOutput(event);
      break;
    case "exec_end":
      renderExecEnd(event);
      break;
    case "note":
      renderNote(event);
      break;
    case "run_end":
      renderRunEnd(event);
      break;
    case "run_error":
      renderRunError(event.message ?? "没有更多信息");
      break;
    default:
      // 认不出的事件：显示一条说明而不是静默吞掉（后端加了新事件类型时能看见）。
      renderNote({ kind: "未知事件", message: `认不出的事件类型：${String(event.type)}` });
      break;
  }
  if (follow) scrollToBottom();
}

// ---------------------------------------------------------------- 连接

async function openStream(runId) {
  let info;
  try {
    const response = await fetch(`/runs/${encodeURIComponent(runId)}/info`, { headers: { accept: "application/json" } });
    if (response.status === 404) {
      setState("error", "没有这个 Run");
      renderMissingRun(runId);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    info = await response.json();
  } catch (error) {
    setState("error", "连不上观察窗服务");
    renderRunError(`取不到 Run 信息：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (info.bufferedEvents === 0) {
    renderWaiting(
      info.status === "running" ? "Run 已经在跑了，等第一个事件…" : "这个 Run 已经结束，而且缓冲里没有事件了。",
    );
  }

  // `EventSource` 自己负责重连，并且会带上 `Last-Event-ID`：服务端按它补发缺的那一段，
  // 所以"断线再连"既不会丢也不会重。这里只需要把状态显示对。
  const source = new EventSource(`/runs/${encodeURIComponent(runId)}/stream`);
  source.onopen = () => {
    if (!ended) setState("live", "实时");
  };
  source.onerror = () => {
    setState(ended ? "done" : "retry", ended ? "已结束" : "重连中");
  };
  source.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return; // 半个帧 / 非 JSON：丢掉这一条，别让页面崩掉。
    }
    handle(event);
  };
  window.addEventListener("pagehide", () => source.close(), { once: true });
}

function main() {
  const runId = runIdFromPath(window.location.pathname);
  if (runId === null) {
    runIdEl.textContent = "（没有 id）";
    setState("error", "URL 里没有 Run id");
    renderNoRun();
    return;
  }
  runIdEl.textContent = runId;
  document.title = `${runId} · reuben-cloud`;
  void openStream(runId);
}

main();
