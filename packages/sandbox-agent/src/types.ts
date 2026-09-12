/**
 * sandbox-agent 的对外契约（HTTP + SSE）。
 *
 * 有意与 CP 侧的 types 重复、不共享包：两层之间只有 HTTP 契约，
 * 共享类型会让「沙箱加一个字段」变成「CP 被迫重新编译」（spec §0.4）。
 */

export type HealthStatus = "starting" | "ready" | "error";

export interface HealthResponse {
  status: HealthStatus;
  version: string;
  activeExecution: string | null;
}

/** POST /exec 请求体。全部字段都不可信，一律走 spawn.ts 的校验。 */
export interface ExecRequest {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ExecAcceptedResponse {
  execution_id: string;
  log_path: string;
}

export interface KillResponse {
  execution_id: string;
  /** "killing" 表示已发出终止信号；其余取值即终态（幂等语义）。 */
  status: "killing" | TerminalStatus;
}

/** 终态四种，互斥。退出码非 0 是 completed，不是 failed——判断成败是 CP 的事。 */
export type TerminalStatus = "completed" | "failed" | "timeout" | "killed";

export type ExecEventType = "started" | "stdout" | "stderr" | "truncated" | TerminalStatus;

export interface StartedEventData {
  execution_id: string;
  /** spawn 失败（ENOENT）时 Node 不给 pid，此时为 null。 */
  pid: number | null;
  ts: string;
  cwd: string;
  cmd: string[];
}

export interface OutputEventData {
  chunk: string;
}

export type TruncatedReason = "output_limit" | "log_limit" | "replay_gap";

export interface TruncatedEventData {
  reason: TruncatedReason;
  /** output_limit / log_limit：触发上限。 */
  limit?: number;
  /** replay_gap：客户端带来的 Last-Event-ID。 */
  from_id?: number;
  log_path: string;
}

export interface TerminalEventData {
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  stdout_bytes: number;
  stderr_bytes: number;
  /** 事件流是否因超过 maxOutputBytes 丢过内容（完整内容在 log_path）。 */
  truncated: boolean;
  /** 日志文件是否因超过 MAX_LOG_BYTES 提前封口。 */
  log_truncated: boolean;
  log_path: string;
  /** 仅 timeout。 */
  timeout_ms?: number;
  /** 仅 failed：spawn 失败的结构化原因（ENOENT 等）。 */
  error?: string;
  message?: string;
}

export interface ErrorResponse {
  error: string;
  message?: string;
  [key: string]: unknown;
}
