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

import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import type { SseEvent } from "./sse.ts";
import { readSseStream } from "./sse.ts";

/**
 * 失败的原因。前三条覆盖普通请求，后两条是 Phase 9 的流式路径：
 *  - `unreachable`：连不上（endpoint 过期、agent 挂了、端口转发容器没了）
 *  - `http_error`：连上了但响应不是 2xx（`agentError` 里带沙箱给的错误码）
 *  - `invalid_response`：2xx 但响应体不是我们认识的形状（协议漂了），
 *    或者**写进去的字节数与沙箱报的对不上**（见 `putFile`）
 *  - `upload_failed`：流式上传在本地就坏了（tar 进程失败、连接被掐）
 *  - `stream_incomplete`：事件流结束了却没有终态事件（`execAndWait` 专用）
 */
export type SandboxApiErrorReason =
  | "unreachable"
  | "http_error"
  | "invalid_response"
  | "upload_failed"
  | "stream_incomplete";

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

/** `PUT /files` 的响应（Phase 9 拿 sha256 校验灌进去的 tar 完整）。 */export interface AgentFileWrite {
  path: string;
  size: number;
  sha256: string;
}

/** `GET /diff` 的 `files[]` 一项（Phase 9/10 用它算影响面、写 artifacts）。 */
export interface AgentDiffFile {
  path: string;
  /** 仅 renamed / copied 有。 */
  oldPath?: string;
  /** added / modified / deleted / renamed / copied / typechanged / unknown。 */
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** `GET /diff` 的响应。`patch` 为 null 时正文在 `patchLogPath`（`truncated:true`）。 */
export interface AgentDiff {
  /** 解析之后的 base commit（完整 sha）。 */
  base: string;
  head: string;
  files: AgentDiffFile[];
  patch: string | null;
  patchBytes: number;
  /** true = patch **没有内联**（超上限或不是合法 UTF-8），完整内容在 `patchLogPath`。 */
  truncated: boolean;
  patchLogPath: string | null;
}

/** 四种终态事件（§C.2），互斥。 */
export const AGENT_TERMINAL_EVENTS: ReadonlySet<string> = new Set(["completed", "failed", "timeout", "killed"]);

/** 流式上传的默认总时限。仓库 tar 可以有几百 MiB，但也不该无限期挂着。 */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export type AgentTerminalState = "completed" | "failed" | "timeout" | "killed";

/** `execAndWait` 的结果：终态事实 + 收下来的输出。 */
export interface AgentExecOutcome {
  executionId: string;
  state: AgentTerminalState;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  /** 输出被 agent 截断（完整内容在 `logPath`）。 */
  truncated: boolean;
  logPath: string | null;
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
   * 流式写文件（`PUT /files`）。Phase 9 用它把仓库 tar 灌进沙箱。
   *
   * 【为什么必须流式】仓库 tar 可能几百 MiB。先把整个 body 收进内存再发出去，
   * 等于让一个不受 CP 控制的体积决定 CP 的内存占用；这里把 `Readable` 直接接到
   * fetch 的请求体上（`duplex:"half"`），sha256 边传边算。
   *
   * 【为什么校验 sha256】响应里的 sha256 是沙箱**收到**的字节。它与我们**发出**的
   * 字节不一致时，说明中间少了或多了东西——一个半个 tar 进沙箱比这次请求失败更坏
   * （后面 `/diff?base=` 的整条链路都会错）。所以这里直接抛，不把可疑产物交给调用方。
   */
  async putFile(
    endpoint: string,
    token: string,
    path: string,
    body: Readable,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<AgentFileWrite> {
    const url = `${endpoint}/files?path=${encodeURIComponent(path)}`;
    const timeoutMs = options.timeoutMs ?? UPLOAD_TIMEOUT_MS;
    // 上传没有默认的短超时（10s 的 requestTimeoutMs 对几百 MiB 的 tar 是错的），
    // 但也不能永远挂着：给一个宽裕的总时限，与调用方的 signal 谁先到算谁。
    const signal =
      options.signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
    const hash = createHash("sha256");
    let sent = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sent += chunk.length;
        callback(null, chunk);
      },
    });

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
        body: Readable.toWeb(body.pipe(meter)) as ReadableStream,
        // Node 的 fetch（undici）要求流式请求体显式声明 duplex，否则直接抛。
        duplex: "half",
        signal,
      });
    } catch (error) {
      throw new SandboxApiError("upload_failed", `上传到沙箱失败（${url}）：${messageOf(error)}`, {
        details: { sent },
      });
    }

    const payload = await this.#decodeJson(response, 200, "PUT", url);
    const record = asRecord(payload);
    const size = typeof record["size"] === "number" ? record["size"] : null;
    const sha256 = typeof record["sha256"] === "string" ? record["sha256"] : null;
    if (size === null || sha256 === null) {
      throw new SandboxApiError("invalid_response", `${url} 没有返回 size/sha256`, { details: { body: payload } });
    }
    const localSha = hash.digest("hex");
    if (sent !== size || localSha !== sha256) {
      throw new SandboxApiError(
        "invalid_response",
        `${url} 的 sha256 不一致：发出的 ${sent}/${localSha}，沙箱报的 ${size}/${sha256}`,
        { details: { sent, localSha, size, sha256 } },
      );
    }
    return { path: typeof record["path"] === "string" ? record["path"] : path, size, sha256 };
  }

  /**
   * 读文件的原始字节流（`GET /files?raw=1`）。超限的 patch 走这条路
   * （Phase 3 备注 4：超过内联上限的 patch 落在 diffRoot，内容完整、只是不在 JSON 里）。
   *
   * 状态校验发生在**返回流之前**：一个 404 的正文是 JSON 错误，把它当文件流交给
   * 调用方，错误只会在下游以"tar 解不开"的形式出现，和真正的原因隔了三层。
   */
  async readRaw(
    endpoint: string,
    token: string,
    path: string,
    options: { offset?: number; limit?: number; signal?: AbortSignal } = {},
  ): Promise<Readable> {
    const params = new URLSearchParams({ path, raw: "1" });
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    return this.#openStream(`${endpoint}/files?${params}`, "GET", token, options.signal);
  }

  /**
   * 归档流（`GET /archive`）。**不进 CP 的内存**：Phase 9 的兜底把它直接接给 tar，
   * Phase 10 把它接给 S3 的分段上传。
   */
  async readArchive(
    endpoint: string,
    token: string,
    options: { exclude?: readonly string[]; signal?: AbortSignal } = {},
  ): Promise<Readable> {
    const params = new URLSearchParams();
    if (options.exclude !== undefined && options.exclude.length > 0) params.set("exclude", options.exclude.join(","));
    const suffix = params.size === 0 ? "" : `?${params}`;
    return this.#openStream(`${endpoint}/archive${suffix}`, "GET", token, options.signal);
  }

  /**
   * `GET /diff?base=<sha>`。base 由 CP 传（附录 A-3：沙箱不持有业务状态）；
   * `path` 指向仓库根（Phase 3 备注 2：仓库在哪儿由调用方说，沙箱不猜）。
   */
  async diff(
    endpoint: string,
    token: string,
    options: { base?: string; path?: string; signal?: AbortSignal } = {},
  ): Promise<AgentDiff> {
    const params = new URLSearchParams();
    if (options.base !== undefined) params.set("base", options.base);
    if (options.path !== undefined) params.set("path", options.path);
    const suffix = params.size === 0 ? "" : `?${params}`;
    const payload = await this.#json(`${endpoint}/diff${suffix}`, {
      method: "GET",
      token,
      signal: options.signal,
    });
    const record = asRecord(payload);
    const patchBytes = typeof record["patch_bytes"] === "number" ? record["patch_bytes"] : null;
    if (typeof record["base"] !== "string" || patchBytes === null) {
      throw new SandboxApiError("invalid_response", "/diff 的响应缺少 base/patch_bytes", { details: { body: payload } });
    }
    return {
      base: record["base"],
      head: typeof record["head"] === "string" ? record["head"] : record["base"],
      files: Array.isArray(record["files"]) ? record["files"].map(toDiffFile) : [],
      patch: typeof record["patch"] === "string" ? record["patch"] : null,
      patchBytes,
      truncated: record["truncated"] === true,
      patchLogPath: typeof record["patch_log_path"] === "string" ? record["patch_log_path"] : null,
    };
  }

  /**
   * 跑一条命令并等到终态。**给 repo/* 的内部命令用**（tar / rm / git rev-parse 这类）：
   * 要的是"跑完、拿退出码和输出"，不需要 DB 记账，也不需要看门狗——它们的时限由
   * 请求里的 `timeoutMs` 和调用方给的 signal 兜住。
   *
   * 【与 SandboxManager.execInSandbox 的分工】那条路是**业务命令**（Phase 11 的工具），
   * 走 READY→BUSY→READY 与 executions 表；这条路是 CP 搬仓库时的内部命令，
   * 发生时工具循环还没开始（或已经结束）。两条路的并发语义不同，所以是两段代码。
   *
   * 【输出上限】内部命令的输出只用来判断成败与排障，`maxCaptureBytes` 之外的字节直接丢
   * （大输出本来就在沙箱的日志文件里，`logPath` 仍然给出去）。
   */
  async execAndWait(
    endpoint: string,
    token: string,
    request: AgentExecRequest,
    options: { signal?: AbortSignal; maxCaptureBytes?: number; onEvent?: (event: SseEvent) => void } = {},
  ): Promise<AgentExecOutcome> {
    const accepted = await this.exec(endpoint, token, request);
    const cap = options.maxCaptureBytes ?? 1024 * 1024;
    const stdout: string[] = [];
    const stderr: string[] = [];
    let captured = 0;
    let terminalEvent: AgentTerminalState | null = null;
    let terminalData: Record<string, unknown> = {};

    for await (const event of this.streamEvents(endpoint, token, accepted.executionId, { signal: options.signal })) {
      options.onEvent?.(event);
      if (event.event === "stdout" || event.event === "stderr") {
        const chunk = asRecord(parseJsonString(event.data))["chunk"];
        const room = cap - captured;
        if (typeof chunk === "string" && room > 0) {
          const taken = chunk.length <= room ? chunk : chunk.slice(0, room);
          (event.event === "stdout" ? stdout : stderr).push(taken);
          captured += taken.length;
        }
        continue;
      }
      if (AGENT_TERMINAL_EVENTS.has(event.event)) {
        terminalEvent = event.event as AgentTerminalState;
        terminalData = asRecord(parseJsonString(event.data));
        break;
      }
    }

    if (terminalEvent === null) {
      throw new SandboxApiError(
        "stream_incomplete",
        `执行 ${accepted.executionId} 的事件流结束了但没有终态事件`,
        { details: { executionId: accepted.executionId } },
      );
    }
    return {
      executionId: accepted.executionId,
      state: terminalEvent,
      exitCode: numberOrNull(terminalData["exit_code"]),
      signal: typeof terminalData["signal"] === "string" ? terminalData["signal"] : null,
      durationMs: numberOrNull(terminalData["duration_ms"]),
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      truncated: terminalData["truncated"] === true,
      logPath:
        typeof terminalData["log_path"] === "string"
          ? terminalData["log_path"]
          : accepted.logPath === ""
            ? null
            : accepted.logPath,
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
    options: { method: string; token: string; payload?: unknown; expected?: number; signal?: AbortSignal },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: options.method,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(options.payload === undefined ? {} : { "content-type": "application/json" }),
        },
        body: options.payload === undefined ? undefined : JSON.stringify(options.payload),
        signal: this.#deadline(options.signal),
      });
    } catch (error) {
      throw new SandboxApiError("unreachable", `连不上沙箱 ${url}：${messageOf(error)}`);
    }
    return this.#decodeJson(response, options.expected ?? 200, options.method, url);
  }

  /**
   * 一条流式响应的开头：校验状态，然后把 body 原样交给调用方。
   * 非 2xx 时把错误的 JSON body 读干净再抛——不读干净的话连接会一直挂着。
   */
  async #openStream(url: string, method: string, token: string, signal?: AbortSignal): Promise<Readable> {
    let response: Response;
    try {
      response = await this.#fetch(url, { method, headers: { authorization: `Bearer ${token}` }, signal });
    } catch (error) {
      throw new SandboxApiError("unreachable", `连不上沙箱 ${url}：${messageOf(error)}`);
    }
    if (response.status !== 200) {
      const text = await response.text().catch(() => "");
      throw this.#httpError(response.status, parseJsonString(text), text, method, url);
    }
    if (response.body === null) {
      throw new SandboxApiError("invalid_response", `${method} ${url} 是 200 但没有响应体`);
    }
    return Readable.fromWeb(response.body as never);
  }

  /** 读 body → 解 JSON（解不开就原样给文本）→ 状态不对就抛 `http_error`。 */
  async #decodeJson(response: Response, expected: number, method: string, url: string): Promise<unknown> {
    const text = await response.text();
    const body = text === "" ? null : parseJsonString(text);
    if (response.status !== expected) throw this.#httpError(response.status, body, text, method, url);
    return body;
  }

  /** 沙箱的错误形状统一是 `{error, message}`（§C.2 的错误码表）。 */
  #httpError(status: number, body: unknown, text: string, method: string, url: string): SandboxApiError {
    const record = asRecord(body);
    const agentError = typeof record["error"] === "string" ? record["error"] : null;
    const message = typeof record["message"] === "string" ? record["message"] : text.slice(0, 200);
    return new SandboxApiError("http_error", `${method} ${url} 得到 ${status}：${agentError ?? message}`, {
      status,
      agentError,
      details: { body },
    });
  }

  /** 短请求的时限：调用方给的 signal 与 requestTimeoutMs 谁先到算谁。 */
  #deadline(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function parseJsonString(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `/diff` 的 `files[]` 一项：只取 CP 认识的字段，不认识的给缺省值。 */
function toDiffFile(value: unknown): AgentDiffFile {
  const record = asRecord(value);
  return {
    path: typeof record["path"] === "string" ? record["path"] : "",
    ...(typeof record["old_path"] === "string" ? { oldPath: record["old_path"] } : {}),
    status: typeof record["status"] === "string" ? record["status"] : "unknown",
    additions: numberOrNull(record["additions"]) ?? 0,
    deletions: numberOrNull(record["deletions"]) ?? 0,
    binary: record["binary"] === true,
  };
}
