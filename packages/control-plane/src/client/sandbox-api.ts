/**
 * CP 这一侧的 sandbox-agent HTTP 客户端（`/health`、`/exec`、`/kill`、事件流）。
 *
 * 【为什么不复用 `test/support.ts` 里的同名函数】那是**测试**的脚手架：它假设自己
 * 能阻塞到终态、能把整段输出收在内存里。CP 要的是流式消费 + 可取消（看门狗要能
 * 打断它），两者的形状不一样。更重要的：产品代码 import 测试脚手架是个反向依赖，
 * 一旦测试改了签名，产品代码编译不过是应该的，但"因为它本来就不该被 import"更好。
 *
 * 【类型为什么又写一遍】§0.4：两层之间只有 HTTP 契约。沙箱那边 `types.ts` 里的
 * `ExecRequest` / `HealthResponse` 是**那一侧**的描述；这里按 CP 读到的字段重新描述，
 * 故意重复。共享包会让"沙箱加一个字段"变成"CP 被迫重新编译"。
 *
 * 【错误分类】`SandboxApiError.reason` 只有三个：
 *  - `unreachable`：连不上（endpoint 过期、agent 挂了、端口转发容器没了）
 *  - `http_error`：连上了但响应不是 2xx（`agentError` 里带沙箱给的错误码）
 *  - `invalid_response`：2xx 但响应体不是我们认识的形状（协议漂了）
 * 调用方按这三条分支，而不是按状态码猜。
 */

import type { SseEvent } from "./sse.ts";
import { readSseStream } from "./sse.ts";

export type SandboxApiErrorReason = "unreachable" | "http_error" | "invalid_response";

export class SandboxApiError extends Error {
  readonly reason: SandboxApiErrorReason;
  readonly status: number | null;
  /** 沙箱返回的机器可读错误码（`busy` / `invalid_cmd` / …）。没有就是 null。 */
  readonly agentError: string | null;
  readonly details: Record<string, unknown>;

  constructor(
    reason: SandboxApiErrorReason,
    message: string,
    options: { status?: number | null; agentError?: string | null; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "SandboxApiError";
    this.reason = reason;
    this.status = options.status ?? null;
    this.agentError = options.agentError ?? null;
    this.details = options.details ?? {};
  }
}

/** `GET /health` 的响应（CP 读到的字段）。 */
export interface AgentHealth {
  status: string;
  version: string;
  activeExecution: string | null;
}

/** `POST /exec` 的请求体。字段名与沙箱侧的 `ExecRequest` 一致（那是 HTTP 契约）。 */
export interface AgentExecRequest {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** 202 的响应体。`log_path` 是沙箱内的路径（销毁后失效）。 */
export interface AgentExecAccepted {
  executionId: string;
  logPath: string;
}

/** `POST /exec/{id}/kill` 的响应体。`status` 是 `killing` 或某个终态（幂等语义）。 */
export interface AgentKillResponse {
  executionId: string;
  status: string;
}

export interface SandboxApiOptions {
  /** "建立连接 + 拿响应"的超时（不覆盖事件流的读）。默认 10s。 */
  requestTimeoutMs?: number;
  /** 事件流的重连上限。默认 3（§Phase 8 §4 的原话）。 */
  maxReconnects?: number;
  /** 两次重连之间的等待。默认 250ms；测试把它调小。 */
  reconnectDelayMs?: number;
  /** 注入 fetch（测试用）。 */
  fetchImpl?: typeof fetch;
}

export class SandboxApiClient {
  readonly #requestTimeoutMs: number;
  readonly #maxReconnects: number;
  readonly #reconnectDelayMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: SandboxApiOptions = {}) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#maxReconnects = options.maxReconnects ?? 3;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 250;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** 探一次 `/health`。连不上 → `unreachable`（这是事实，不是异常，但需要能被分类）。 */
  async health(endpoint: string, token: string): Promise<AgentHealth> {
    const body = await this.#json(`${endpoint}/health`, { method: "GET", token });
    const record = asRecord(body);
    const status = record["status"];
    if (typeof status !== "string") {
      throw new SandboxApiError("invalid_response", "/health 没有 status 字段", { details: { body } });
    }
    return {
      status,
      version: typeof record["version"] === "string" ? record["version"] : "",
      activeExecution: typeof record["activeExecution"] === "string" ? record["activeExecution"] : null,
    };
  }

  /**
   * 起一条命令。**不重试**：202 之后重试会变成第二条命令（沙箱侧有单执行闸，
   * 第二次会拿到 409，但那是"上一单还在跑"，不是"这一单没起来"）。
   * 重试语义属于上层（Phase 11 的工具层），不属于这里。
   */
  async exec(endpoint: string, token: string, request: AgentExecRequest): Promise<AgentExecAccepted> {
    const body = await this.#json(`${endpoint}/exec`, {
      method: "POST",
      token,
      payload: request,
      expected: 202,
    });
    const record = asRecord(body);
    const executionId = record["execution_id"];
    if (typeof executionId !== "string") {
      throw new SandboxApiError("invalid_response", "/exec 没有返回 execution_id", { details: { body } });
    }
    return {
      executionId,
      logPath: typeof record["log_path"] === "string" ? record["log_path"] : "",
    };
  }

  /** 杀一条执行。**幂等**：沙箱侧对已结束的执行返回当前状态而不是错误。 */
  async kill(endpoint: string, token: string, executionId: string): Promise<AgentKillResponse> {
    const body = await this.#json(`${endpoint}/exec/${encodeURIComponent(executionId)}/kill`, {
      method: "POST",
      token,
    });
    const record = asRecord(body);
    return {
      executionId: typeof record["execution_id"] === "string" ? record["execution_id"] : executionId,
      status: typeof record["status"] === "string" ? record["status"] : "unknown",
    };
  }

  /**
   * 事件流。断线重连（最多 3 次、带上 `Last-Event-ID`）由 `sse.ts` 负责，
   * 这里只负责拼 URL 与鉴权头。
   */
  streamEvents(
    endpoint: string,
    token: string,
    executionId: string,
    options: { lastEventId?: string | null; signal?: AbortSignal; onReconnect?: (info: { attempt: number; lastEventId: string | null; reason: string }) => void } = {},
  ): AsyncGenerator<SseEvent, void, undefined> {
    return readSseStream({
      url: `${endpoint}/exec/${encodeURIComponent(executionId)}/events`,
      headers: { authorization: `Bearer ${token}` },
      fetchImpl: this.#fetch,
      maxReconnects: this.#maxReconnects,
      reconnectDelayMs: this.#reconnectDelayMs,
      ...options,
    });
  }

  /** 一次短请求：拼头 → fetch → 校验状态 → 解 JSON。所有失败都翻译成 SandboxApiError。 */
  async #json(
    url: string,
    options: { method: string; token: string; payload?: unknown; expected?: number },
  ): Promise<unknown> {
    const expected = options.expected ?? 200;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: options.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(options.payload === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
    } catch (error) {
      throw new SandboxApiError(
        "unreachable",
        `连不上沙箱 ${url}：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (response.status !== expected) {
      const record = asRecord(body);
      const agentError = typeof record["error"] === "string" ? record["error"] : null;
      const message = typeof record["message"] === "string" ? record["message"] : text.slice(0, 200);
      throw new SandboxApiError("http_error", `${options.method} ${url} 得到 ${response.status}：${agentError ?? message}`, {
        status: response.status,
        agentError,
        details: { body },
      });
    }
    return body;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
