/**
 * 路由表 + 鉴权 + 响应工具。手写匹配，不引路由库（`node:http` 足够）。
 *
 * 鉴权写在最前面，对所有路由生效——包括 /health。裸跑阶段这个 token 看起来没用
 * （本机、127.0.0.1），但容器化之后它是内网唯一的防线；事后补的鉴权就是这个项目里
 * 最容易被漏掉的一行。
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { VERSION, type Config } from "./config.ts";
import type { ExecutionRegistry } from "./exec/registry.ts";
import type {
  ErrorResponse,
  ExecAcceptedResponse,
  HealthResponse,
  KillResponse,
} from "./types.ts";

/** /exec 的请求体很小（argv 数组）。给足余量，但必须有上限。 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 建一个 HTTP server（还没开始 listen，那是 index.ts 的事）。
 *
 * 为什么要包一层 `.catch()`：`handle` 是 async 函数，它抛出的异常 Node 不会自动变成 500，
 * 而是变成一个未处理的 Promise 拒绝（进程可能直接挂）。所以这里统一兜底成 500。
 *
 * @param config 读 token / 停不限用
 * @param registry 执行注册表，三个路由都通过它做事
 * @returns 配好路由但未监听的 Server
 */
export function createAgentServer(config: Config, registry: ExecutionRegistry): Server {
  return createServer((req, res) => {
    handle(req, res, config, registry).catch((err: unknown) => {
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
 * 路由分发。整个 agent 就四个路（比 spec 里的 9 个少，剩下的是 Phase 2/3 的事）：
 *
 *   GET  /health
 *   POST /exec
 *   GET  /exec/{id}/events   （SSE，会一直挂着不返回）
 *   POST /exec/{id}/kill
 *
 * 手写匹配而不是引路由库：4 条路由不值得一个依赖（和“零依赖”的整体取舍一致）。
 *
 * @throws 本函数不吞异常，由 createAgentServer 的 catch 统一变 500。
 */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  registry: ExecutionRegistry,
): Promise<void> {
  // 鉴权在所有路由之前，包括 /health。这一行容易被当成“本机跑不需要”而忘掉，
  // 但容器化之后它就是内网唯一的防线。
  if (!isAuthorized(req.headers.authorization, config.token)) {
    sendJson(res, 401, { error: "unauthorized" });
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

  sendJson(res, 404, { error: "not_found" });
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
    sendJson(res, 404, { error: "not_found" });
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
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  // 幂等：已经在终态就返回当前状态，这不是错误——重试语义需要它。
  const payload: KillResponse = {
    execution_id: result.execution.id,
    status: result.execution.status === "running" ? "killing" : result.execution.status,
  };
  sendJson(res, 200, payload);
}

/** 拼 /health 的响应。status 现在永远写 ready（starting / error 是为容器化预留的）。 */
function healthPayload(registry: ExecutionRegistry): HealthResponse {
  return {
    status: "ready", // Phase 1 只会是 ready（starting 用不到、error 保留）
    version: VERSION,
    activeExecution: registry.activeExecution,
  };
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

/**
 * 校验 `Authorization: Bearer <token>`。
 * 大小写不敏感（HTTP 标准），但 token 本身必须完全一致。
 * 先比长度再调 safeEqual——故意的：能在常数时间里比对的事情不要提前泄露信息。
 */
function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const prefix = "bearer ";
  if (header.length <= prefix.length) return false;
  if (header.slice(0, prefix.length).toLowerCase() !== prefix) return false;
  return safeEqual(header.slice(prefix.length), token);
}

/**
 * 常数时间字符串比较，防“计时攻击”。
 *
 * 为什么不能用 `a === b`：JS 的字符串比较发现不同就立刻返回，
 * 于是“前缀对了几个字符”会反映在耗时上；攻击者可以逐字节把 token 猜出来。
 * timingSafeEqual 无论如何都比完全部字节。
 */
function safeEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  // 长度不等直接返回 false —— timingSafeEqual 长度不等会抛异常。
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** readJsonBody 的返回：成功带解析结果，失败带该发的状态码和响应体。 */
type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; body: ErrorResponse };

/**
 * 把请求体读完并 JSON.parse。
 *
 * 这里只有三个分支：太大（413）、空的/不是 JSON（400）、读流时断了（400）。
 * 具体的字段校验不在这里——那是 spawn.ts 的 validateExecRequest 的事。
 * 分成两层是因为“是不是合法 JSON”和“字段合不合法”是两种不同的错误。
 */
async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;

  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        // 继续把流排干而不是 break：break 会销毁 socket，413 就送不出去了。
        // 超限之后不再累积，内存不随 body 增长。
        tooLarge = true;
        chunks.length = 0;
        continue;
      }
      chunks.push(buf);
    }
  } catch {
    return { ok: false, status: 400, body: { error: "invalid_json", message: "request aborted" } };
  }

  if (tooLarge) {
    return { ok: false, status: 413, body: { error: "body_too_large", limit: MAX_BODY_BYTES } };
  }
  if (size === 0) {
    return { ok: false, status: 400, body: { error: "invalid_json", message: "empty body" } };
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, body: { error: "invalid_json", message: "body is not valid JSON" } };
  }
}

/**
 * 统一的 JSON 响应出口。**所有**响应都从这里走，保证头部一致。
 * 先判定“已经开始发了吗”——否则写头部会抛异常，把原本的 4xx 变成一个 500 噪声。
 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) {
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
  });
  res.end(json);
}
