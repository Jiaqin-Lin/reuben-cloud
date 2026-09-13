/*
 * env.js —— 环境页（Phase 7 §4）。
 *
 * 【它只做三件事】读 `/env/<projectKey>/info` → 用 DOM 拼出来 → 那一个按钮发 POST 并轮询。
 * 没有框架、没有构建、没有状态管理库：这个页面的全部状态就是那一个 JSON。
 *
 * 【为什么一切动态内容都走 textContent / createTextNode】仓库名、状态原因、体检事实、构建
 * 错误分类、日志 key——全都是外部输入（它们最终来自仓库内容与模型）。拼 HTML 就是把
 * "仓库里有个叫 <script> 的文件"变成一个 XSS。`packages/web/test/ui.test.ts` 会拦下来。
 *
 * 【为什么要轮询而不是 SSE】观察窗那条流是"一次执行的事件"，而这里是"一个仓库的状态"：
 * 构建可能跑十分钟、体检要起沙箱，中间的变化就是**几次状态推进**。为此新造一条事件通道
 * 的收益比不上"每 3 秒读一次那个已经在的 JSON"；而且页面关掉就停了（没有常驻订阅要清理）。
 */

const THEME_KEY = "reuben-cloud-theme";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 20 * 60 * 1000;

const root = document.documentElement;
const projectEl = document.getElementById("env-project");
const stateEl = document.getElementById("env-state");
const stateTextEl = document.getElementById("env-state-text");
const currentEl = document.getElementById("env-current");
const healthEl = document.getElementById("env-health");
const revisionsEl = document.getElementById("env-revisions");
const messageEl = document.getElementById("env-message");
const buildButton = document.getElementById("env-build-button");
const buildHint = document.getElementById("env-build-hint");
const themeButton = document.getElementById("theme");

/** 页面路径 → 这个仓库的 projectKey（`/env/owner%2Fname` 里的那一段，原样保留编码）。 */
function pageBase() {
  return location.pathname.replace(/\/+$/, "");
}

let polling = false;
let pollUntil = 0;
/**
 * 最后一条消息是谁写的：`"load"` 表示它是一条"读不到 / 失败"的提示，下一次成功刷新应该把它清掉；
 * `"action"` 表示它是用户刚做的事的回执（"已入队"），刷新**不能**把它擦掉
 * ——否则点完按钮那条回执会在 3 秒内自己消失，用户会以为没点上。
 */
let messageOwner = null;

function setMessage(text, owner) {
  messageEl.textContent = text;
  messageOwner = owner;
}

// ---------------------------------------------------------------- 主题（与 app.js 同一套）

function resolveTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  root.dataset.theme = theme;
  themeButton.textContent = theme === "dark" ? "深色" : "浅色";
}

themeButton.addEventListener("click", () => {
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

applyTheme(resolveTheme());

// ---------------------------------------------------------------- 小工具

/** `el(tag, className, text)`：只在有内容时写 textContent（空串会画出多余的空节点）。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined && className !== null) node.className = className;
  if (text !== undefined && text !== null && text !== "") node.appendChild(document.createTextNode(String(text)));
  return node;
}

/** 状态徽章：`data-status` 决定配色（见 style.css 的 `.badge`）。 */
function badge(status) {
  const node = el("span", "badge", status);
  node.dataset.status = status;
  return node;
}

/** 一列"键 / 值"（键是机器读的标识，值是内容）。 */
function metaItem(key, value) {
  const item = el("div", "meta__item");
  item.appendChild(el("span", "meta__key", key));
  item.appendChild(el("span", "meta__value", value === null || value === undefined || value === "" ? "—" : value));
  return item;
}

function shortDigest(digest) {
  if (digest === null || digest === undefined) return null;
  const hash = String(digest).includes(":") ? String(digest).split(":").pop() : String(digest);
  return hash.slice(0, 12);
}

function shortTime(iso) {
  if (iso === null || iso === undefined) return null;
  return String(iso).replace("T", " ").replace(/\..*$/, "");
}

// ---------------------------------------------------------------- 渲染

function render(view) {
  projectEl.textContent = view.projectKey;
  const current = view.revisions.find((revision) => revision.revision === view.currentRevision) ?? null;
  const status = current === null ? "无当前版本" : current.status;
  stateEl.dataset.state = current === null ? "idle" : current.status;
  stateTextEl.textContent = status;

  renderCurrent(view, current);
  renderHealth(current);
  renderRevisions(view);

  buildButton.disabled = view.canBuild !== true;
  buildHint.textContent =
    view.canBuild === true
      ? "manual 触发：跳过缓存、落一版新 revision，然后体检"
      : "这个进程只服务它自己那个仓库；别的仓库这里只能看（只读）";
}

function renderCurrent(view, current) {
  currentEl.replaceChildren();
  currentEl.appendChild(el("div", "card__label", "当前环境"));

  if (current === null) {
    currentEl.appendChild(
      el("p", "card__text", "这个仓库还没有生效的 revision（可能正在构建，或者上一版失败了）。下面能看到每一版的历史。"),
    );
    return;
  }

  const meta = el("div", "meta");
  meta.appendChild(metaItem("revision", `#${current.revision}${current.parentRevision === null ? "" : `（父 #${current.parentRevision}）`}`));
  meta.appendChild(metaItem("状态", current.status));
  meta.appendChild(metaItem("推断级别", current.level));
  meta.appendChild(metaItem("缓存键", current.cacheKey === null ? null : current.cacheKey.slice(0, 12)));
  meta.appendChild(metaItem("镜像", shortDigest(current.imageDigest)));
  meta.appendChild(metaItem("创建时间", shortTime(current.createdAt)));
  currentEl.appendChild(meta);

  const base = el("p", "card__text", `基础镜像：${current.baseImage}`);
  currentEl.appendChild(base);
  if (current.health !== null && current.health.checkedAt !== null) {
    currentEl.appendChild(el("p", "card__text", `体检时间：${shortTime(current.health.checkedAt)}（${current.health.status}）`));
  }
  if (current.revision !== view.currentRevision) {
    currentEl.appendChild(el("p", "card__text", `（当前生效的是 #${view.currentRevision}，这一版只是历史）`));
  }
}

function renderHealth(current) {
  healthEl.replaceChildren();
  const facts = current !== null && current.health !== null ? current.health.facts : [];
  if (facts.length === 0) {
    healthEl.hidden = true;
    return;
  }
  healthEl.hidden = false;
  healthEl.appendChild(el("span", "note__label", "体检事实"));
  const list = el("div", "note__text");
  for (const fact of facts) {
    // 「影响：integration_tests」——agent 会据此跳过集成测试（设计文档 §C.6）。
    list.appendChild(el("div", null, `${fact.detail}（影响：${(fact.affected ?? []).join("/")}）`));
  }
  healthEl.appendChild(list);
}

function renderRevisions(view) {
  revisionsEl.replaceChildren();
  revisionsEl.appendChild(el("div", "divider", "历史 revision"));
  if (view.revisions.length === 0) {
    revisionsEl.appendChild(el("p", "card__text", "还没有任何构建记录。"));
    return;
  }
  for (const revision of view.revisions) {
    revisionsEl.appendChild(revisionCard(view, revision));
  }
}

function revisionCard(view, revision) {
  const card = el("section", "card env__rev");
  const head = el("div", "env__rev-head");
  head.appendChild(el("span", "env__rev-title", `revision #${revision.revision}`));
  head.appendChild(badge(revision.status));
  head.appendChild(el("span", "env__rev-sub", `${revision.level}｜${shortTime(revision.createdAt)}｜镜像 ${shortDigest(revision.imageDigest) ?? "—"}`));
  if (revision.revision === view.currentRevision) head.appendChild(el("span", "panel__flag", "当前"));
  card.appendChild(head);

  if (revision.health !== null && revision.health.reason !== null) {
    card.appendChild(el("p", "card__text", `体检原因：${revision.health.reason} —— ${revision.health.detail ?? ""}`));
  }

  const builds = el("div", "env__builds");
  if (revision.builds.length === 0) {
    builds.appendChild(el("p", "card__text", "还没有构建尝试。"));
  }
  for (const build of revision.builds) {
    builds.appendChild(buildRow(view, revision, build));
  }
  card.appendChild(builds);

  if (revision.health !== null && revision.health.logKey !== null) {
    const link = el("a", "link", "体检日志");
    link.href = `${pageBase()}/logs/${revision.revision}?health=${encodeURIComponent(healthRunIdOf(revision.health.logKey))}`;
    link.target = "_blank";
    link.rel = "noopener";
    card.appendChild(link);
  }

  const details = el("details", "fold");
  details.appendChild(el("summary", "fold__summary", "构建 / 验证命令与推断说明"));
  const body = el("div", "fold__body");
  for (const [label, list] of [
    ["构建命令", revision.buildCommands],
    ["验证命令", revision.verifyCommands],
    ["降级风险", revision.degradedRisks],
    ["推断说明", revision.notes],
  ]) {
    if (list === undefined || list.length === 0) continue;
    body.appendChild(el("div", "card__label", label));
    for (const item of list) body.appendChild(el("div", "note__text", item));
  }
  details.appendChild(body);
  card.appendChild(details);
  return card;
}

function buildRow(view, revision, build) {
  const row = el("div", "env__build");
  row.appendChild(el("span", "env__build-attempt", `第 ${build.attempt} 轮`));
  row.appendChild(el("span", "env__build-inference", build.inference));
  row.appendChild(badge(build.status));
  row.appendChild(el("span", "env__build-meta", build.errorClass === null ? build.trigger : `${build.trigger}｜${build.errorClass}`));
  row.appendChild(el("span", "env__build-meta", build.durationMs === null ? "" : `${(build.durationMs / 1000).toFixed(1)}s`));
  if (build.logKey !== null) {
    // 日志的 key 由服务端按 `?build=` 拼（页面不传 key，见 web/env.ts 的文件头）。
    const link = el("a", "link", "日志");
    link.href = `${pageBase()}/logs/${revision.revision}?build=${encodeURIComponent(build.id)}`;
    link.target = "_blank";
    link.rel = "noopener";
    row.appendChild(link);
  }
  return row;
}

/** 体检日志 key 的文件名就是那次体检沙箱的 run id（见 `envHealthLogKey`）。 */
function healthRunIdOf(logKey) {
  const name = String(logKey).split("/").pop() ?? "";
  return name.replace(/\.health\.log$/, "");
}

// ---------------------------------------------------------------- 读取与轮询

async function load() {
  let response;
  try {
    response = await fetch(`${pageBase()}/info`, { headers: { accept: "application/json" } });
  } catch (error) {
    setMessage(`读不到环境信息：${error instanceof Error ? error.message : String(error)}`, "load");
    stateEl.dataset.state = "error";
    stateTextEl.textContent = "读不到";
    return null;
  }
  if (!response.ok) {
    setMessage(
      response.status === 404 ? "这个仓库还没有任何环境记录（先跑一次 agent:run 或 env:build）。" : `读环境信息失败：HTTP ${response.status}`,
      "load",
    );
    stateEl.dataset.state = "error";
    stateTextEl.textContent = `HTTP ${response.status}`;
    return null;
  }
  if (messageOwner === "load") setMessage("", null);
  const view = await response.json();
  render(view);
  return view;
}

/** 有没有正在跑的构建（draft / building 都算"还在路上"）。 */
function hasActiveBuild(view) {
  return view.revisions.some(
    (revision) => revision.status === "draft" || revision.status === "building" || revision.builds.some((build) => build.status === "building"),
  );
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    // 先立刻读一次：点完按钮的那一瞬间就该看到"draft / building"，而不是先等一个间隔。
    for (;;) {
      const view = await load();
      if (view === null || !hasActiveBuild(view)) return;
      if (Date.now() >= pollUntil) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } finally {
    polling = false;
  }
}

buildButton.addEventListener("click", async () => {
  buildButton.disabled = true;
  setMessage("已入队（manual）：构建可能在后台跑十分钟，这个页面会自动刷新状态。", "action");
  try {
    const response = await fetch(`${pageBase()}/build`, { method: "POST", headers: { accept: "application/json" } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setMessage(`入队失败：HTTP ${response.status}${body.message === undefined ? "" : ` —— ${body.message}`}`, "action");
      return;
    }
    pollUntil = Date.now() + POLL_MAX_MS;
    void poll();
  } catch (error) {
    setMessage(`入队失败：${error instanceof Error ? error.message : String(error)}`, "action");
  } finally {
    buildButton.disabled = false;
  }
});

// 【为什么不是顶层 await】这个文件没有构建步骤、也没有模块加载器之外的包装：让它以一条
// 同步语句结尾，`node --test` 里那份 DOM 替身才不需要支持顶层 await（见 dom.ts 的说明）。
void load();
