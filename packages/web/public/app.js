/**
 * `app.js` —— 观察窗的前端（Phase 13，P4 改协议 + 会话视图 + 上下文面板）。
 *
 * 【这一层只做三件事】连 SSE、把事件渲染成 DOM、别把页面卡住。
 * 它不认识沙箱、不认识模型、不知道一次 Run 该怎么跑：`docs/sandbox-spec.md` §Phase 13 的
 * 技术边界是"只读、不做交互"，所以这里连一个 POST 都没有。
 *
 * 【P4 之后事件只有一套】后端发过来的就是一族的 `AgentEvent` + Run 生命周期 + 沙箱输出，
 * 按 SSE 通道名分发（`SSE_CHANNELS`）。通道名与事件类型的关系由后端的 `events.ts` 定，
 * 这里只管"每一类怎么画"——多一个通道时后端先加映射表，这里补一个分支（`ui.test.ts`
 * 会把两边对齐的事情变成一条红）。
 *
 * 【会话视图：先读历史，再接实时】页面打开时先 `GET /sessions/{id}/entries` 把**这个会话**
 * 之前说过的话画出来（用 `runs[].startEntryId` 标出每一轮的边界），然后才接本次执行的
 * SSE。两段不重叠：历史只画到"本次执行开始之前"（`startEntryId` 是上一轮的 leaf），
 * 本次执行的部分全部由实时流渲染——包括**已经跑完的**执行（hub 的环形缓冲会从头重放）。
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
const MAX_PROGRESS_LINES = 120;
const THEME_KEY = "reuben-cloud.theme";

/**
 * 前端认的 SSE 通道。**必须与后端 `control-plane/src/agent/events.ts` 的
 * `SSE_EVENT_NAMES` 逐条一致**（`ui.test.ts` 直接比对两份清单）。
 * 不认识的通道名在浏览器里本来就不会被分发（EventSource 只派发有人监听的类型），
 * 所以后端加通道时页面只是少一块信息，不会崩。
 */
const SSE_CHANNELS = ["run", "agent", "turn", "message", "tool", "context", "compaction", "note", "exec"];

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
  loop_crashed: "循环错误",
  compaction_failed: "压缩失败",
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
  compaction_failed: "上下文压不出来了",
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

/** 千分位。刻意不用 `toLocaleString`：页面与测试要看到同一个串（不随 locale 变）。 */
function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return String(Math.round(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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

/** 取 hash 的前 8 位（上下文面板与压缩标记都按这个口径显示）。 */
function shortHash(hash) {
  return typeof hash === "string" && hash.length > 0 ? hash.slice(0, 8) : "无";
}

/** 工具参数的一行摘要。认不出的工具就退回紧凑 JSON（不猜语义）。 */
function summarizeInput(name, input) {
  const record = input !== null && typeof input === "object" ? input : {};
  if (name === "bash" && typeof record.command === "string") return record.command;
  if (Array.isArray(record.cmd)) return record.cmd.join(" ");
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

/** 清空一个元素的孩子（`replaceChildren` 在测试用的 DOM 替身里没有，这里手写一遍）。 */
function clear(node) {
  while (node.firstChild !== null) node.firstChild.remove();
}

/**
 * 一组内容块 → 文本。`AgentToolResult.content` 与消息的 `content` 都是这个形状：
 * 文本块取 `text`，其他块（图片等）用类型名占位。
 */
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block !== null && typeof block === "object" && block.type === "text" ? String(block.text ?? "") : `[${block?.type ?? "?"}]`,
    )
    .join("");
}

/**
 * 工具结果 → 一段文本。工具结果的形状是 `AgentToolResult`（`content` 是内容块数组），
 * 但事件里的类型是 `unknown`（工具可以返回任何东西），所以这里**防御式**地取：
 * 取不到 `content` 就把 JSON 原样显示——宁可难读，也不要显示一个空块。
 */
function toolContentText(result) {
  const content = result !== null && typeof result === "object" ? result.content : null;
  if (content !== null && content !== undefined) return contentText(content);
  const json = JSON.stringify(result ?? null, null, 2);
  return json === undefined || json === null ? "" : json;
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
/** 上下文面板（P4）。HTML 里一直存在，收到第一条 `context_compiled` 才显示。 */
const contextPanel = document.getElementById("context");
// HTML 里已经写了 `hidden`（没有编译产物的 Run 上不该多出一块空白）；这里再写一遍是因为
// `hidden` 是 DOM 属性而不是 class，仅靠标记属性在"页面被别的脚本动过"时不可靠。
if (contextPanel !== null) contextPanel.hidden = true;

/** 跟着新内容滚到底（用户往上翻过之后就不再打扰他）。 */
let pinned = true;
let ended = false;
/** 轮次计数（`turn_start` 事件不带序号，前端自己数——与后端 transcript 的口径一致）。 */
let turnCount = 0;
/** 当前这一轮的元素（`turn_start` 建的）；没有就挂在 `log` 上。 */
let turnNode = null;
/** 当前这一段的 assistant 文字（下一个非 text 增量到达时清空）。 */
let sayNode = null;
/** 这一条 assistant 消息有没有出现过文字增量（`message_end` 的兜底要看它）。 */
let messageTextSeen = false;
/** 第一条 user 消息就是任务书，已经画在题面卡片里了，不再重复。 */
let taskPromptSeen = false;
/** 上下文里出现过压缩（面板上的"已压缩"标记）。 */
let compacted = false;
/** 面板上的标记元素（`context_compiled` 重画时换新，压缩事件用它点亮）。 */
let contextFlag = null;
/** tool_use id → 外层元素（工具结果回来时挂进去）。 */
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

// ---------------------------------------------------------------- 通用积木

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

/** 折叠块：默认收起的参数 / 结果都走它（`<details>` 自带键盘可达）。 */
function collapsible(title, body, open, className) {
  const details = el("details", `fold ${className ?? ""}`.trim());
  details.open = open === true;
  details.append(el("summary", "fold__summary", title));
  details.append(el("pre", "fold__body", body));
  return details;
}

/** 用户说的话（题面之后的插话，或会话视图里的历史消息）。 */
function renderUserMessage(message) {
  sayNode = null;
  const text = contentText(message.content);
  const node = el("div", "say say--user");
  node.append(el("span", "say__who", "用户"));
  node.append(document.createTextNode(text));
  container().append(node);
}

/** 助手消息里的文字块（没有流式增量时的兜底路径，例如重放一个只有终态的流）。 */
function assistantText(message) {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.filter((block) => block !== null && typeof block === "object" && block.type === "text").map((block) => String(block.text ?? "")).join("\n");
}

// ---------------------------------------------------------------- Run 生命周期

function renderRunStart(event) {
  const card = el("section", "card");
  card.append(el("div", "card__label", "题面"));
  card.append(el("pre", "card__issue", event.issue));
  const items = [
    { key: "模型", value: event.model },
    { key: "工作目录", value: event.repoDir },
    {
      key: "上限",
      value: `${event.limits.maxTurns} 轮 / ${Math.round(event.limits.wallClockMs / 60_000)} 分钟 / ${event.limits.outputTokenBudget} 输出 token`,
    },
  ];
  if (typeof event.sessionId === "string" && event.sessionId !== "") {
    items.push({ key: "会话", value: event.sessionId });
  }
  card.append(metaRow(items));
  log.append(card);
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

// ---------------------------------------------------------------- 轮次与消息

function renderTurnStart() {
  sayNode = null;
  lastToolNode = null;
  turnCount += 1;
  turnNode = el("section", "turn");
  turnNode.dataset.turn = String(turnCount);
  turnNode.append(el("div", "turn__label", `Turn ${turnCount}`));
  log.append(turnNode);
}

function appendText(delta) {
  messageTextSeen = true;
  if (sayNode === null) {
    sayNode = el("div", "say");
    container().append(sayNode);
  }
  // 文本节点追加：模型输出的换行与空格都原样保留（`.say` 是 pre-wrap）。
  sayNode.append(document.createTextNode(delta));
}

/**
 * 一条消息开始。只有**用户消息**要在这里画（助手消息靠文字增量流式画出来，
 * 工具卡片靠 `tool_execution_*`），工具结果消息由 `tool_execution_end` 画过一遍。
 */
function renderMessageStart(message) {
  sayNode = null;
  messageTextSeen = false;
  if (message.role !== "user") return;
  if (!taskPromptSeen) {
    // 第一条 user 消息是任务书：它已经在题面卡片里了，重复画一遍只会让首屏变长。
    taskPromptSeen = true;
    return;
  }
  renderUserMessage(message);
}

/** 模型流的一次增量：只有文字进 DOM（思考与工具参数分片不进，见 `handle`）。 */
function renderMessageUpdate(event) {
  const stream = event.assistantMessageEvent;
  if (stream.type === "text_delta") appendText(stream.delta ?? "");
}

function renderMessageEnd(message) {
  if (message.role !== "assistant") return;
  // 兜底：有些路径（重放一个只有终态的流）没有文字增量，文字只存在于终态消息里。
  if (!messageTextSeen) {
    const text = assistantText(message);
    if (text !== "") {
      sayNode = el("div", "say");
      container().append(sayNode);
      sayNode.append(document.createTextNode(text));
    }
  }
  sayNode = null;
}

// ---------------------------------------------------------------- 工具

/** 建一个工具卡片（`tool_execution_start` 与**会话视图里的 toolCall 块**共用）。 */
function renderToolCall(id, name, input) {
  sayNode = null;
  const node = el("article", "tool");
  if (id) node.dataset.toolId = id;
  const head = el("div", "tool__head");
  head.append(el("span", "tool__name", name));
  head.append(el("span", "tool__arg", summarizeInput(name, input)));
  node.append(head);

  const json = JSON.stringify(input ?? {}, null, 2);
  if (json !== "{}" && json.length > 2) node.append(collapsible("参数", json, false, "tool__input"));

  container().append(node);
  if (id) toolNodes.set(id, node);
  lastToolNode = node;
  return node;
}

function renderToolExecutionStart(event) {
  renderToolCall(event.toolCallId, event.toolName, event.args);
}

/** 工具执行中的增量（长命令的中间输出）：挂到卡片里的"实时输出"块（每个卡片一个）。 */
function renderToolExecutionUpdate(event) {
  const target = toolNodes.get(event.toolCallId) ?? lastToolNode;
  if (target === null || target === undefined) return;
  let box = target.__progressBox;
  if (box === undefined) {
    const wrapper = el("div", "exec");
    const pre = el("pre", "exec__out tool__progress");
    wrapper.append(pre);
    target.append(wrapper);
    box = new StreamBox(pre, MAX_PROGRESS_LINES);
    target.__progressBox = box;
  }
  const text = contentText(event.partialResult?.content);
  if (text !== "") box.append(text, "stdout");
}

/** 工具返回：把结果挂进对应的卡片（找不到卡片就挂在最近一个 / 容器末尾）。 */
function renderToolResult(event) {
  sayNode = null;
  const text = toolContentText(event.result);
  const clamped = clampLines(text, MAX_RESULT_LINES);
  const body = clamped.omitted > 0 ? `${clamped.text}\n\n… 后面 ${clamped.omitted} 行没显示` : clamped.text;
  // 页面上按**字符数**报大小（事件里没有字节数；transcript 里才有）。
  const title = `${event.isError ? "工具报错" : "结果"} / ${formatNumber(text.length)} 字符`;
  const block = collapsible(title, body, event.isError === true, "tool__result");
  const target = toolNodes.get(event.toolCallId) ?? lastToolNode ?? container();
  target.append(block);
}

/** 会话视图里的一条 `toolResult` 消息（历史）。 */
function renderToolResultMessage(message) {
  const event = {
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError === true,
    result: { content: message.content },
  };
  renderToolResult(event);
}

// ---------------------------------------------------------------- 沙箱命令输出

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

// ---------------------------------------------------------------- 上下文 / 压缩 / 说明

/**
 * 上下文面板：每个分区的 token 数与占比、`compiled_hash` 前 8 位、是否命中压缩。
 * **重画而不是追加**：它是"当前这一轮编译成什么样"的面板，不是历史（历史在流里）。
 */
function renderContextCompiled(event) {
  if (contextPanel === null) return;
  const sections = Array.isArray(event.sections) ? event.sections : [];
  const total = sections.reduce((sum, section) => sum + (Number(section.tokens) || 0), 0);
  contextPanel.hidden = false;
  clear(contextPanel);

  const head = el("div", "panel__head");
  head.append(el("span", "panel__title", "上下文"));
  head.append(el("span", "panel__stat", `第 ${event.turn} 轮`));
  head.append(el("span", "panel__stat", `${formatNumber(total)} token`));
  head.append(el("span", "panel__stat", `编译 ${shortHash(event.hash)}`));
  contextFlag = el("span", "panel__flag", compacted ? "已压缩" : "未压缩");
  head.append(contextFlag);
  contextPanel.append(head);

  const list = el("ul", "panel__sections");
  for (const section of sections) {
    const tokens = Number(section.tokens) || 0;
    const pct = total > 0 ? Math.round((tokens / total) * 100) : 0;
    const row = el("li", "ctx-section");
    row.append(el("span", "ctx-section__name", String(section.name ?? "（未命名）")));
    row.append(el("span", "ctx-section__tokens", formatNumber(tokens)));
    row.append(el("span", "ctx-section__pct", `${pct}%`));
    row.append(el("span", "ctx-section__hash", shortHash(section.hash)));
    list.append(row);
  }
  contextPanel.append(list);
}

/** 压缩：一条分隔线（含压前 token）。它同时把面板的"已压缩"标记点亮。 */
function renderCompaction(event) {
  sayNode = null;
  compacted = true;
  const node = el("div", "divider");
  node.append(el("span", "divider__label", "已压缩"));
  const detail = `${formatNumber(event.tokensBefore)} token → 保留自 ${event.firstKeptEntryId}`;
  node.append(el("span", "divider__meta", detail));
  container().append(node);
  if (contextFlag !== null) contextFlag.textContent = "已压缩";
}

function renderNote(event) {
  sayNode = null;
  const node = el("div", "note");
  node.dataset.kind = event.kind ?? "";
  node.append(el("span", "note__label", NOTE_LABELS[event.kind] ?? event.kind ?? "说明"));
  node.append(el("span", "note__text", event.message));
  container().append(node);
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

// ---------------------------------------------------------------- 会话视图（历史）

/**
 * 会话视图。读 `GET /sessions/{id}/entries`：那是 `session_entries` 表（P2 起对话的唯一
 * 持久形态），所以刷新页面、甚至 CP 重启之后，之前说过的话还在。
 *
 * 【切在哪里】历史只画到**本次执行开始之前**：`runs[].startEntryId` 是"这一轮从哪条 entry
 * 之后开始"（上一轮的 leaf），所以 seq 大于它的 entry 都属于本次执行——那些由实时流画
 * （hub 的环形缓冲会从头重放，页面不会漏）。这样两段既不重叠、也不留缝。
 */
function renderSessionHistory(view, currentRunId) {
  const runs = Array.isArray(view.runs) ? view.runs : [];
  const entries = Array.isArray(view.entries) ? view.entries : [];
  const current = runs.find((run) => run.id === currentRunId) ?? null;
  const seqById = new Map(entries.map((entry) => [entry.id, entry.seq]));
  const boundary = current?.startEntryId ?? null;
  const cut = boundary === null ? -1 : (seqById.get(boundary) ?? -1);
  if (cut < 0) return; // 本次执行是会话的第一轮：没有历史可画

  // 历史的条数：只画 seq 不大于 cut 的那些（本次执行的由实时流画）。
  let historyCount = 0;
  while (historyCount < entries.length && entries[historyCount].seq <= cut) historyCount += 1;

  // 每一轮的边界 = `startEntryId` 的**下一条**（它是上一轮的 leaf，属于上一轮）。
  // 第一轮没有起点，边界在第一处。定位不到的（entry 被裁过 / 只取了增量）就不画它。
  const indexById = new Map(entries.map((entry, index) => [entry.id, index]));
  const dividerAt = new Map();
  for (const run of runs) {
    const at = run.startEntryId === null ? 0 : (indexById.get(run.startEntryId) ?? -1) + 1;
    if (run.startEntryId !== null && indexById.get(run.startEntryId) === undefined) continue;
    if (at < historyCount) dividerAt.set(at, run);
  }

  for (let index = 0; index < historyCount; index += 1) {
    const run = dividerAt.get(index);
    if (run !== undefined) {
      const divider = el("div", "divider");
      divider.append(el("span", "divider__label", `Run ${run.id}`));
      divider.append(
        el("span", "divider__meta", `${run.model} · ${run.status}${run.stopReason === null ? "" : ` · ${run.stopReason}`}`),
      );
      log.append(divider);
    }
    renderEntry(entries[index]);
  }
}

/** 一条 entry → DOM。类型只有三种（message / compaction / custom），与存储的 CHECK 一致。 */
function renderEntry(entry) {
  const payload = entry.payload;
  if (entry.type === "compaction") {
    renderCompaction({
      tokensBefore: Number(payload?.tokensBefore) || 0,
      firstKeptEntryId: payload?.firstKeptEntryId ?? "?",
    });
    return;
  }
  if (entry.type === "custom") {
    renderNote({ kind: payload?.customType ?? "custom", message: String(payload?.content ?? "") });
    return;
  }
  const message = payload;
  if (message === null || typeof message !== "object") {
    renderNote({ kind: "entry", message: `认不出的 entry：${entry.id}` });
    return;
  }
  switch (message.role) {
    case "user":
      renderUserMessage(message);
      return;
    case "assistant":
      renderAssistantEntry(message);
      return;
    case "toolResult":
      renderToolResultMessage(message);
      return;
    case "compactionSummary":
      renderCompaction({ tokensBefore: message.tokensBefore, firstKeptEntryId: message.firstKeptEntryId });
      return;
    case "custom":
      renderNote({ kind: message.customType ?? "custom", message: message.content ?? "" });
      return;
    default:
      renderNote({ kind: "message", message: `认不出的消息：${String(message.role)}` });
  }
}

/** 历史里的一条 assistant 消息：文字块与工具调用块（工具结果会在后面的 entry 里挂上去）。 */
function renderAssistantEntry(message) {
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    if (block.type === "text") {
      if (String(block.text ?? "").trim() === "") continue;
      const node = el("div", "say");
      node.append(document.createTextNode(String(block.text ?? "")));
      container().append(node);
      continue;
    }
    if (block.type === "toolCall") {
      renderToolCall(block.id, block.name, block.arguments);
    }
  }
}

// ---------------------------------------------------------------- 事件分发

function handle(event) {
  // 滚动跟随的判断必须在**改 DOM 之前**做（改完再判断，页面已经被撑长了）。
  const follow = pinned || atBottom();
  switch (event.type) {
    // ---- Run 生命周期（CP 侧的编排）
    case "run_start":
      renderRunStart(event);
      break;
    case "run_end":
      renderRunEnd(event);
      break;
    case "run_error":
      renderRunError(event.message ?? "没有更多信息");
      break;

    // ---- 循环的状态与轮次
    case "agent_start":
      if (!ended) setState("live", "实时");
      break;
    case "agent_end":
      sayNode = null;
      break;
    case "turn_start":
      renderTurnStart();
      break;
    case "turn_end":
      sayNode = null;
      break;

    // ---- 消息（打字机）
    case "message_start":
      renderMessageStart(event.message);
      break;
    case "message_update":
      renderMessageUpdate(event);
      break;
    case "message_end":
      renderMessageEnd(event.message);
      break;

    // ---- 工具执行
    case "tool_execution_start":
      renderToolExecutionStart(event);
      break;
    case "tool_execution_update":
      renderToolExecutionUpdate(event);
      break;
    case "tool_execution_end":
      renderToolResult(event);
      break;

    // ---- 上下文 / 压缩 / 说明
    case "context_compiled":
      renderContextCompiled(event);
      break;
    case "compaction":
      renderCompaction(event);
      break;
    case "note":
      renderNote(event);
      break;

    // ---- 沙箱命令输出
    case "exec_start":
      renderExecStart(event);
      break;
    case "exec_output":
      renderExecOutput(event);
      break;
    case "exec_end":
      renderExecEnd(event);
      break;

    default:
      // 认不出的事件：显示一条说明而不是静默吞掉（后端加了新事件类型时能看见）。
      renderNote({ kind: "未知事件", message: `认不出的事件类型：${String(event.type)}` });
      break;
  }
  if (follow) scrollToBottom();
}

// ---------------------------------------------------------------- 连接

/** 一个 SSE 帧：解析 + 分发。解不开的帧丢掉，别让页面崩掉。 */
function onFrame(message) {
  let event;
  try {
    event = JSON.parse(message.data);
  } catch {
    return; // 半个帧 / 非 JSON。
  }
  handle(event);
}

async function loadHistory(runId, info) {
  const sessionId = info !== null && typeof info.sessionId === "string" ? info.sessionId : null;
  if (sessionId === null) return;
  try {
    const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/entries`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return;
    renderSessionHistory(await response.json(), runId);
  } catch {
    // 历史是"锦上添花"：读不到就只显示本次执行的实时流（不打断观察）。
  }
}

async function openStream(runId) {
  let info = null;
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

  // 会话视图（P4）：先画历史，再接实时。历史读完才开 SSE——中间的实时事件在 hub 的
  // 环形缓冲里等着重放，所以这个 await 不会丢事件（只影响首屏出现的顺序）。
  await loadHistory(runId, info);

  // `EventSource` 自己负责重连，并且会带上 `Last-Event-ID`：服务端按它补发缺的那一段，
  // 所以"断线再连"既不会丢也不会重。这里只需要把状态显示对。
  const source = new EventSource(`/runs/${encodeURIComponent(runId)}/stream`);
  source.onopen = () => {
    if (!ended) setState("live", "实时");
  };
  source.onerror = () => {
    setState(ended ? "done" : "retry", ended ? "已结束" : "重连中");
  };
  // 每个通道一个监听：浏览器只派发有人监听的类型，所以后端加通道时这里没跟上
  // 也只是"少一块信息"，不会走错分支。
  // **不要同时设 `onmessage`**：它等价于 `message` 通道的第二个监听，会让 message 类的
  // 事件被处理两遍（文字翻倍、第一条 user 消息被当成插话重画）。
  for (const name of SSE_CHANNELS) source.addEventListener(name, onFrame);
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
