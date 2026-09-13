/**
 * `server.ts` —— CP 的第一个（也是 M0 唯一的）HTTP 服务：**观察窗**（Phase 13，P4 加会话视图）。
 *
 * 【它不是 API 服务器，刻意不是】没有鉴权、没有多用户、没有一个 CRUD。README 里画的
 * Hono + 完整 API 面是 M1 的事；M0 需要的只有这几条路由：
 *   GET /                        → 有 run 就跳到最近那个，没有就渲染空状态
 *   GET /runs/{id}               → 页面（`packages/web/public/index.html`）
 *   GET /runs/{id}/info          → 这个 run 的元信息（JSON）
 *   GET /runs/{id}/stream        → **SSE**：Run 生命周期 + 循环事件 + 沙箱命令输出
 *   GET /runs/{id}/transcript    → 本次执行的 entries（P4，读 `session_entries`）
 *   GET /sessions/{id}/entries   → 整个会话的 entries + runs（P4，页面默认的会话视图）
 *   GET /app.js /style.css       → 白名单静态资源（见 `static.ts`）
 *
 * 所以实现就是 `node:http` 加一个 switch：多引一个框架只会让"这个进程到底监听了什么"
 * 变得更难回答。
 *
 * 【为什么不把 SSE 端点做成"包一层沙箱的流"】沙箱的事件流只覆盖命令输出，而观察窗要的是
 * 一次 Run 的全景（模型在想什么、调了什么工具、命令跑出什么）。事件在 CP 侧汇集到
 * `hub.ts` 的同一个缓冲里，这个端点只是把缓冲按 SSE 的帧格式吐出去——**端点自己不认识
 * 事件内容**，加一种事件不需要动这里一行（通道名来自 `events.ts` 的映射表）。
 *
 * 【P4 的会话视图为什么需要 `store`】entries 在 Postgres / 内存存储里，不在 hub 的缓冲里。
 * 没接 store 时这两条端点回 503（说清楚原因），而不是回一个空列表假装"这个会话是空的"。
 *
 * 【安全边界就是回环地址】spec 明确"不做鉴权"，那么"谁能访问"就只能靠绑定地址回答。
 * 所以 host 写死 127.0.0.1，也**不提供** `--host` 之类的开关：想远程看就 SSH 隧道。
 * 一个没有鉴权的 HTTP 服务监听 0.0.0.0 是网络里最便宜的一个洞。
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { SessionStore } from "@reuben-cloud/agent-runtime";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { sseFrameOf } from "../agent/events.ts";
import type { HubEventRecord, RunHub } from "./hub.ts";
import { readRunView, readSessionView } from "./history.ts";
import { readStatic, webRoot } from "./static.ts";

/** 只监听回环（见文件头）。改这个值等于把一个无鉴权的服务暴露出去。 */
export const LOOPBACK = "127.0.0.1";

/** 默认端口。选 8787 是因为它不像 3000/8080 那样总被别的开发服务占着。 */
export const DEFAULT_WEB_PORT = 8787;

/** 心跳间隔：中间任何一层代理都可能掐掉长时间没数据的连接（§C.2 的同一条道理）。 */
export const DEFAULT_HEARTBEAT_MS = 15_000;

export interface WebServerOptions {
  hub: RunHub;
  /**
   * 会话存储（P4 的会话视图与 transcript 端点读它）。不给时这两条端点回 503——
   * 观察窗的核心（实时流）不依赖它，所以它是可选的。
   */
  store?: SessionStore | null;
  /** 前端资源目录；缺省 `packages/web/public`（`static.ts` 的 `webRoot()`）。 */
  webRoot?: string;
  /** 端口；0 = 让系统分配（测试用）。 */
  port?: number;
  heartbeatMs?: number;
  log?: LogFn;
}

export interface WebServer {
  /** 形如 `http://127.0.0.1:8787`（不带结尾斜杠）。 */
  readonly url: string;
  readonly port: number;
  /** 关掉：断开所有连接（含正在读的 SSE），然后关闭监听。**幂等**。 */
  close(): Promise<void>;
}

/** 请求处理函数。单独导出是为了让测试不必真的 `listen` 也能覆盖路由逻辑。 */
export type WebHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createWebHandler(options: WebServerOptions): WebHandler {
  const log = options.log ?? noopLog;
  const root = options.webRoot ?? webRoot();
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;

  return async function handle(req, res): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
    const pathname = url.pathname;

    if (req.method !== "GET") {
      return sendJson(res, 405, { error: "method_not_allowed", message: "观察窗只有 GET" });
    }

    // 静态白名单先查：文件名只来自表，`pathname` 不参与拼路径（见 `static.ts`）。
    if (pathname === "/" || pathname === "/index.html") {
      const latest = options.hub.latest();
      if (pathname === "/" && latest !== null) {
        res.writeHead(302, { location: `/runs/${encodeURIComponent(latest)}` });
        res.end();
        return;
      }
      return sendStatic(res, "/index.html", root);
    }
    if (pathname === "/app.js" || pathname === "/style.css") {
      return sendStatic(res, pathname, root);
    }
    if (pathname === "/favicon.ico") {
      // 不引图标二进制（白名单里没有它）：回一个空的 204，浏览器就不会天天报一条 404。
      res.writeHead(204);
      res.end();
      return;
    }

    const route = parseRoute(pathname);
    if (route === null) {
      return sendJson(res, 404, { error: "not_found", message: `没有这个路径：${pathname}` });
    }

    if (route.kind === "page") {
      // 页面本身对不存在的 run 也返回 200：**谁来告诉用户"这个 run 不存在"是前端的事**
      // （它靠 `/info` 判断），而服务器回 HTML 404 只会让浏览器显示一句没用的默认页。
      return sendStatic(res, "/index.html", root);
    }
    if (route.kind === "info") {
      const info = options.hub.info(route.id);
      if (info === null) {
        return sendJson(res, 404, { error: "run_not_found", message: `没有这个 run：${route.id}` });
      }
      return sendJson(res, 200, info);
    }
    if (route.kind === "transcript" || route.kind === "session-entries") {
      return sendHistory(res, route, options.store ?? null, url);
    }

    return streamRun(req, res, route.id, options.hub, heartbeatMs, log);
  };
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const log = options.log ?? noopLog;
  const handler = createWebHandler(options);
  const server = createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      // 处理函数自己出错：能回一个 500 就回，回不了就把连接断掉（不要留半截响应）。
      log("error", `web 请求处理失败`, { url: req.url ?? "", error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal", message: "观察窗自己出错了" });
      else res.end();
    });
  });

  const port = options.port ?? DEFAULT_WEB_PORT;
  await listen(server, port);
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  log("info", `观察窗已就绪：http://${LOOPBACK}:${actualPort}`, { webRoot: options.webRoot ?? webRoot() });

  let closed = false;
  return {
    url: `http://${LOOPBACK}:${actualPort}`,
    port: actualPort,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // 先断开所有连接：SSE 是长连接，不主动断的话 `close()` 会等到浏览器关页面为止。
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------- SSE

interface Route {
  /** `page` / `info` / `stream` 的对象是 run id；`session-entries` 的是 session id。 */
  kind: "page" | "info" | "stream" | "transcript" | "session-entries";
  id: string;
}

/**
 * 路径解析。两种形状：`/runs/{id}[/{action}]` 与 `/sessions/{id}/entries`。
 * 解析不出来（含非法转义、多余段）一律返回 null（→ 404）。
 */
function parseRoute(pathname: string): Route | null {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length < 2 || segments.length > 3) return null;
  const [head, rawId, action] = segments;
  const id = decodeSegment(rawId);
  if (id === null) return null;

  if (head === "sessions") {
    if (action === "entries") return { kind: "session-entries", id };
    return null;
  }
  if (head !== "runs") return null;
  if (action === undefined) return { kind: "page", id };
  if (action === "info") return { kind: "info", id };
  if (action === "stream") return { kind: "stream", id };
  if (action === "transcript") return { kind: "transcript", id };
  return null;
}

/** 解码一段路径；空串、非法转义、含 `/` 的都算不合法。 */
function decodeSegment(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const value = decodeURIComponent(raw);
    return value === "" || value.includes("/") ? null : value;
  } catch {
    return null;
  }
}

/**
 * 会话视图 / 本次执行切片。两条端点除了取哪一份数据之外完全一样，所以共用一个处理。
 *
 * 404 与 503 的分界很重要：**没有这条记录**是 404（前端显示"找不到"）；
 * **没接存储**是 503（观察窗少了半个库，不是数据不存在）——混在一起会让人去查错方向。
 */
async function sendHistory(
  res: ServerResponse,
  route: Route,
  store: SessionStore | null,
  url: URL,
): Promise<void> {
  if (store === null) {
    return sendJson(res, 503, {
      error: "store_unavailable",
      message: "这个观察窗没有接会话存储，读不到 entries（起服务时传 SessionStore）",
    });
  }
  const options = viewOptionsOf(url);
  if (route.kind === "session-entries") {
    const view = await readSessionView(store, route.id, options);
    if (view === null) {
      return sendJson(res, 404, { error: "session_not_found", message: `没有这个会话：${route.id}` });
    }
    return sendJson(res, 200, view);
  }
  const view = await readRunView(store, route.id, options);
  if (view === null) {
    return sendJson(res, 404, { error: "run_not_found", message: `没有这个 run：${route.id}` });
  }
  return sendJson(res, 200, view);
}

/** `?afterSeq=` / `?limit=`：解析不出来就当作没给（不因为一个坏参数回 400）。 */
function viewOptionsOf(url: URL): { afterSeq?: number; limit?: number } {
  const afterSeq = Number(url.searchParams.get("afterSeq"));
  const limit = Number(url.searchParams.get("limit"));
  return {
    ...(Number.isFinite(afterSeq) && afterSeq > 0 ? { afterSeq } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
  };
}

async function streamRun(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  hub: RunHub,
  heartbeatMs: number,
  log: LogFn,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
  const afterId = afterIdOf(req, url);

  // 订阅**先于**响应头：没有这个 run 时还能老老实实回一个 404（EventSource 看不到
  // 状态码，所以前端另有 `/info` 探活；但 curl 与测试看得到，别浪费这个信号）。
  const controller = new AbortController();
  const subscriber = hub.subscribe(runId, {
    afterId,
    signal: controller.signal,
  });
  if (subscriber === null) {
    sendJson(res, 404, { error: "run_not_found", message: `没有这个 run：${runId}` });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // 明确告诉可能存在的反向代理"别缓冲"：缓冲会让"实时"变成"一次性倒出来"。
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  log("info", `SSE 已连接`, { runId, afterId, subscribers: hub.info(runId)?.subscribers ?? null });

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(": ping\n\n");
  }, heartbeatMs);
  heartbeat.unref();

  // 客户端一断就把订阅关掉：**不要靠 GC**，否则一个反复刷新的页面会攒下一堆死订阅。
  res.once("close", () => controller.abort());

  try {
    for await (const record of subscriber) {
      if (res.writableEnded || res.destroyed) break;
      if (!res.write(frameOf(record))) await waitForDrain(res, controller.signal);
    }
  } finally {
    clearInterval(heartbeat);
    hub.release(runId, subscriber);
    if (!res.writableEnded) res.end();
  }
}

/**
 * 重连游标。两个来源，**头优先**：`EventSource` 自动带 `Last-Event-ID`；
 * `?after=` 是给 `curl -N` 用的（命令行里没法设那个头，但补读历史时很需要）。
 */
function afterIdOf(req: IncomingMessage, url: URL): number | null {
  const header = req.headers["last-event-id"];
  const raw = typeof header === "string" ? header : url.searchParams.get("after");
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 一条事件 → 一个 SSE 帧。**一次 write 写完一整帧**，中间不可能被心跳插进去。
 *
 * 【`event:` 字段为什么必须有】通道名来自 `events.ts` 的映射表（唯一出处）：
 * 浏览器按名字分发（`addEventListener("tool", ...)`），不认识的新通道**天然被忽略**
 * ——这就是 spec 要的"老客户端向后兼容"，不需要在客户端写兜底。
 */
export function frameOf(record: HubEventRecord): string {
  const frame = sseFrameOf(record.event);
  return `id: ${record.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** 等 `drain`，但**不能死等**：连接断掉时 drain 可能永远不来。 */
function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  if (res.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------- 小工具

async function sendStatic(res: ServerResponse, pathname: string, root: string): Promise<void> {
  let file;
  try {
    file = await readStatic(pathname, root);
  } catch (error) {
    // 文件在表里但盘上没有（部署只拷了半个目录）：这是环境问题，不是 404。
    sendJson(res, 500, {
      error: "static_missing",
      message: `读不到静态资源 ${pathname}：${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }
  if (file === null) {
    sendJson(res, 404, { error: "not_found", message: `没有这个静态资源：${pathname}` });
    return;
  }
  res.writeHead(200, { "content-type": file.type, "content-length": file.body.byteLength, "cache-control": "no-store" });
  res.end(file.body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, LOOPBACK, () => {
      server.off("error", onError);
      resolve();
    });
  });
}
