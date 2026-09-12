/**
 * 路由表 + 鉴权。手写匹配，不引路由库（`node:http` 足够）。
 *
 * 鉴权写在最前面，对所有路由生效——包括 /health。裸跑阶段这个 token 看起来没用
 * （本机、127.0.0.1），但容器化之后它是内网唯一的防线；事后补的鉴权就是这个项目里
 * 最容易被漏掉的一行。
 *
 * 【在链路中的位置】Phase 2 起路由表覆盖 exec（4 条）+ files（3 条），
 * Phase 3 再加 diff / archive 两条。但它只做「method + path → 交给谁」的分发，
 * 具体逻辑住在 registry.ts / files/* / diff.ts / archive.ts 里。
 * 响应工具（sendJson / 鉴权）搬到了 http.ts，理由见那个文件的头注释。
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:http";
import { VERSION, type Config } from "./config.ts";
import type { RootResolver } from "./paths.ts";
import type { ExecutionRegistry } from "./exec/registry.ts";
import { handleArchive } from "./archive.ts";
import { handleDiff } from "./diff.ts";
import { handleFileList } from "./files/list.ts";
import { handleFileRead } from "./files/read.ts";
import { handleFileWrite } from "./files/write.ts";
import { isAuthorized, readJsonBody, sendError, sendJson } from "./http.ts";
import type { ExecAcceptedResponse, HealthResponse, KillResponse } from "./types.ts";

/**
 * 建一个 HTTP server（还没开始 listen，那是 index.ts 的事）。
 *
 * 为什么要包一层 `.catch()`：`handle` 是 async 函数，它抛出的异常 Node 不会自动变成 500，
 * 而是变成一个未处理的 Promise 拒绝（进程可能直接挂）。所以这里统一兜底成 500。
 *
 * @param config 读 token / 各种上限
 * @param registry 执行注册表，exec 的四条路由都通过它做事
 * @param roots 路径校验器，Phase 2 起 files 的三条路由要用（exec 的 cwd 校验也用它）
 * @returns 配好路由但未监听的 Server
 */
export function createAgentServer(
  config: Config,
  registry: ExecutionRegistry,
  roots: RootResolver,
): Server {
  return createServer((req, res) => {
    handle(req, res, config, registry, roots).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // 响应已经开始发了就不能再写头部（会报 ERR_HEADERS_SENT），只能把它关掉。
      if (res.headersSent || res.writableEnded) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "internal_error", message });
    });
  });
}

/**
 * 路由分发。整个 agent 有九条路由：
 *
 *   GET  /health
 *   POST /exec
 *   GET  /exec/{id}/events   （SSE，会一直挂着不返回）
 *   POST /exec/{id}/kill
 *   GET  /files              （读：JSON 或 raw 流）
 *   PUT  /files              （写：流式裸字节）
 *   GET  /files/list         （列目录）
 *   GET  /diff               （相对 base commit 的 patch，Phase 3）
 *   GET  /archive            （整仓 tar.gz 流，Phase 3）
 *
 * 手写匹配而不是引路由库：九条路由不值得一个依赖（和“零依赖”的整体取舍一致）。
 *
 * @throws 本函数不吞异常，由 createAgentServer 的 catch 统一变 500。
 */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  registry: ExecutionRegistry,
  roots: RootResolver,
): Promise<void> {
  // 鉴权在所有路由之前，包括 /health。这一行容易被当成“本机跑不需要”而忘掉，
  // 但容器化之后它就是内网唯一的防线。
  if (!isAuthorized(req.headers.authorization, config.token)) {
    sendError(res, 401, "unauthorized");
    return;
  }

  const method = req.method ?? "GET";
  // 第二个参数是 base：只为了能让相对 req.url（"/exec"）被 URL 构造器接受。
  // 但 url.pathname 仍然只有路径，host 部分不参与。
  const url = new URL(req.url ?? "/", "http://agent.local");
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/health") {
    // 就绪探针。直接返回，不碰 registry 的锁。
    sendJson(res, 200, healthPayload(registry));
    return;
  }

  if (method === "POST" && pathname === "/exec") {
    // 先把 body 读完才能动 registry。body 有大小上限（否则一个请求就能吃满内存）。
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, body.body);
      return;
    }
    const started = registry.start(body.value);
    if (!started.ok) {
      // 400 / 409 / 503 都是在这一行决定的（错误语义住在 registry 里）。
      sendJson(res, started.status, started.body);
      return;
    }
    // 202 = 已受理。注意：此时命令可能还在跑，也可能已经失败了——
    // 真正的结果从 SSE 事件流里读。
    const payload: ExecAcceptedResponse = {
      execution_id: started.execution.id,
      log_path: started.execution.logPath,
    };
    sendJson(res, 202, payload);
    return;
  }

  // ---- Phase 2：文件 API。三条路由都只是把参数原样转交给 files/*，
  // 路径校验、上限、响应形状都在那边（这里保持"只有分发"）。
  if (method === "GET" && pathname === "/files") {
    await handleFileRead(res, url, roots, config);
    return;
  }
  if (method === "PUT" && pathname === "/files") {
    await handleFileWrite(req, res, url, roots, config);
    return;
  }
  if (method === "GET" && pathname === "/files/list") {
    await handleFileList(res, url, roots, config);
    return;
  }

  // ---- Phase 3：diff 与 archive。两条都是「占 exec 的同一个 BUSY 槽」的长活任务
  // （附录 A-5），槽的抢占、超时、断线杀进程都在被调方里，这里只做分发。
  if (method === "GET" && pathname === "/diff") {
    await handleDiff(res, url, roots, registry, config);
    return;
  }
  if (method === "GET" && pathname === "/archive") {
    await handleArchive(res, url, registry, config);
    return;
  }

  // /exec/{id}/events 和 /exec/{id}/kill。两个捕获组：([^/]+)=id，
  // (events|kill)=动作。`[^/]+` 的“不能带斜杠”是故意的：防止 /exec/a/b/kill 被当成 id="a/b"。
  const execRoute = /^\/exec\/([^/]+)\/(events|kill)$/.exec(pathname);
  if (execRoute !== null) {
    // 末尾的 `!` 告诉 TS “我知道捕获组一定有值”；路由匹配成功就必然有。
    const id = decodeURIComponent(execRoute[1]!);
    const action = execRoute[2]!;
    if (action === "events" && method === "GET") {
      handleEvents(req, res, registry, id);
      return;
    }
    if (action === "kill" && method === "POST") {
      handleKill(res, registry, id);
      return;
    }
  }

  sendError(res, 404, "not_found");
}

/**
 * `GET /exec/{id}/events`：把这一条 HTTP 请求
 * 变成一条长活的 SSE 流。本函数开完头就返回了（subscribe 内部接管了 res），
 * 事件是以后由 EventBus.publish 陆续写的。
 *
 * @param id execution_id。不存在就 404（这里就判）。
 */
function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ExecutionRegistry,
  id: string,
): void {
  const record = registry.get(id);
  if (record === undefined) {
    sendError(res, 404, "not_found");
    return;
  }
  // Last-Event-ID 是 SSE 协议自带的重连头：客户端断线重连时会自动带上它，
  // 带的就是上次收到的最后一个 id。把它交给总线做重放。
  // 同一个头可能有多个值，所以要做 Array 判断（Node 会把重复头聚成数组）。
  const header = req.headers["last-event-id"];
  record.bus.subscribe(res, parseLastEventId(Array.isArray(header) ? header[0] : header));
}

/**
 * `POST /exec/{id}/kill`。只是“请求杀”，不等进程真的死。
 * 调用方应该接着读 SSE，等 killed / timeout 那个终态事件。
 */
function handleKill(res: ServerResponse, registry: ExecutionRegistry, id: string): void {
  const result = registry.kill(id);
  if (!result.ok) {
    sendError(res, 404, "not_found");
    return;
  }
  // 幂等：已经在终态就返回当前状态，这不是错误——重试语义需要它。
  const payload: KillResponse = {
    execution_id: result.execution.id,
    status: result.execution.status === "running" ? "killing" : result.execution.status,
  };
  sendJson(res, 200, payload);
}

/**
 * 解析 `Last-Event-ID` 请求头。
 * 故意宽容：不是数字、负数、空值都当成“没带”处理（null = 从头重放）。
 * 为什么不报 400：这个头是浏览器/客户端自动带的，格式不对也犯不上拒绝整个连接。
 */
function parseLastEventId(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

/** 拼 /health 的响应。status 现在永远写 ready（starting / error 是为容器化预留的）。 */
function healthPayload(registry: ExecutionRegistry): HealthResponse {
  return {
    status: "ready", // Phase 1 只会是 ready（starting 用不到、error 保留）
    version: VERSION,
    activeExecution: registry.activeExecution,
  };
}
