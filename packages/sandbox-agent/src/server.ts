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

export function createAgentServer(config: Config, registry: ExecutionRegistry): Server {
  return createServer((req, res) => {
    handle(req, res, config, registry).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent || res.writableEnded) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "internal_error", message });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  registry: ExecutionRegistry,
): Promise<void> {
  if (!isAuthorized(req.headers.authorization, config.token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://agent.local");
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/health") {
    sendJson(res, 200, healthPayload(registry));
    return;
  }

  if (method === "POST" && pathname === "/exec") {
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendJson(res, body.status, body.body);
      return;
    }
    const started = registry.start(body.value);
    if (!started.ok) {
      sendJson(res, started.status, started.body);
      return;
    }
    const payload: ExecAcceptedResponse = {
      execution_id: started.execution.id,
      log_path: started.execution.logPath,
    };
    sendJson(res, 202, payload);
    return;
  }

  const execRoute = /^\/exec\/([^/]+)\/(events|kill)$/.exec(pathname);
  if (execRoute !== null) {
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
  const header = req.headers["last-event-id"];
  record.bus.subscribe(res, parseLastEventId(Array.isArray(header) ? header[0] : header));
}

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

function healthPayload(registry: ExecutionRegistry): HealthResponse {
  return {
    status: "ready", // Phase 1 只会是 ready（starting 用不到、error 保留）
    version: VERSION,
    activeExecution: registry.activeExecution,
  };
}

function parseLastEventId(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const prefix = "bearer ";
  if (header.length <= prefix.length) return false;
  if (header.slice(0, prefix.length).toLowerCase() !== prefix) return false;
  return safeEqual(header.slice(prefix.length), token);
}

function safeEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  // 长度不等直接返回 false —— timingSafeEqual 长度不等会抛异常。
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; body: ErrorResponse };

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
