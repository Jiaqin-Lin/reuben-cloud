/**
 * argv 校验 → 进程组 → 管道接线 → 终态收尾。
 *
 * 这个文件负责的是整个方案里唯一真正有技术风险的部分（§K）：进程组回收、
 * 输出合并、终态与日志落盘的顺序。
 *
 * 三条不能动的规则：
 *  - `shell: false` + argv 数组：注入类 bug 整类消失。要管道就显式写 ["bash","-lc",...]
 *  - `stdio[0] = "ignore"`：没有交互式输入通道。需要交互的程序会立刻读到 EOF 失败——
 *    这是设计边界，不是 bug。
 *  - 终态事件必须在**进程真的死了、日志真的落盘之后**才发。
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  type Config,
} from "../config.ts";
import type { RootResolver } from "../paths.ts";
import type { ErrorResponse, TerminalEventData, TerminalStatus } from "../types.ts";
import { OutputMerger } from "./output.ts";
import type { ExecutionRecord } from "./registry.ts";
import { escalateKill, scheduleTimeout } from "./timeout.ts";

export interface ValidatedExecRequest {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type ValidationResult =
  | { ok: true; request: ValidatedExecRequest }
  | { ok: false; body: ErrorResponse };

export function validateExecRequest(
  raw: unknown,
  config: Config,
  roots: RootResolver,
): ValidationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("invalid_body", "request body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;

  const cmd = body.cmd;
  if (!Array.isArray(cmd) || cmd.length === 0) {
    return invalid("invalid_cmd", "cmd must be a non-empty array of strings (argv, not a shell string)");
  }
  for (const part of cmd) {
    if (typeof part !== "string") return invalid("invalid_cmd", "every cmd element must be a string");
    if (part.includes("\0")) return invalid("invalid_cmd", "cmd must not contain NUL bytes");
  }
  if (cmd[0] === "") return invalid("invalid_cmd", "cmd[0] must not be empty");

  let cwd = roots.realRoot;
  if (body.cwd !== undefined) {
    const resolved = roots.resolve(body.cwd);
    if (!resolved.ok) {
      if (resolved.reason === "out_of_bounds") {
        return {
          ok: false,
          body: { error: "path_out_of_bounds", message: `cwd must stay inside ${roots.realRoot}` },
        };
      }
      return invalid("invalid_cwd", `cwd is not usable: ${resolved.reason}`);
    }
    // 注意：越界是策略违规（400），root 之内但磁盘上不存在是运行期事实（→ failed 事件）。
    // 这个区分决定了 CP 的错误处理分支，不要合并它们。
    cwd = resolved.abs;
  }

  const env: Record<string, string> = {};
  if (body.env !== undefined) {
    if (body.env === null || typeof body.env !== "object" || Array.isArray(body.env)) {
      return invalid("invalid_env", "env must be an object of string values");
    }
    for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
      if (typeof value !== "string") return invalid("invalid_env", `env.${key} must be a string`);
      if (key.includes("\0") || value.includes("\0")) {
        return invalid("invalid_env", `env.${key} must not contain NUL bytes`);
      }
      env[key] = value;
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (body.timeoutMs !== undefined) {
    const value = body.timeoutMs;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return invalid("invalid_timeout", "timeoutMs must be a positive integer");
    }
    if (value > MAX_TIMEOUT_MS) {
      // 不静默截断：静默截断会让调用方以为自己拿到了 30 分钟。
      return {
        ok: false,
        body: { error: "timeout_exceeds_max", limit: MAX_TIMEOUT_MS },
      };
    }
    timeoutMs = value;
  }

  let maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
  if (body.maxOutputBytes !== undefined) {
    const value = body.maxOutputBytes;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_MAX_OUTPUT_BYTES) {
      return invalid("invalid_max_output_bytes", `maxOutputBytes must be an integer in 1..${MAX_MAX_OUTPUT_BYTES}`);
    }
    maxOutputBytes = value;
  }

  return { ok: true, request: { cmd: cmd as string[], cwd, env, timeoutMs, maxOutputBytes } };
}

export function startProcess(record: ExecutionRecord, config: Config): void {
  let child: ChildProcess;
  try {
    child = spawn(record.cmd[0]!, record.cmd.slice(1), {
      cwd: record.cwd,
      env: buildEnv(record.env, config),
      detached: true, // ← 关键：子进程成为进程组组长（setsid）
      stdio: ["ignore", "pipe", "pipe"],
      shell: false, // ← 默认值，但写出来
    });
  } catch (err) {
    record.spawnError = { message: (err as Error).message };
    void finalize(record, config);
    return;
  }

  record.child = child;
  record.pid = child.pid ?? null;
  record.bus.publish("started", {
    execution_id: record.id,
    pid: record.pid,
    ts: new Date().toISOString(),
    cwd: record.cwd,
    cmd: record.cmd,
  });

  const out = new OutputMerger({
    chunkBytes: config.chunkBytes,
    flushIntervalMs: config.flushIntervalMs,
    onChunk: (text, bytes) => emitChunk(record, "stdout", text, bytes),
  });
  const err = new OutputMerger({
    chunkBytes: config.chunkBytes,
    flushIntervalMs: config.flushIntervalMs,
    onChunk: (text, bytes) => emitChunk(record, "stderr", text, bytes),
  });
  record.mergers = { out, err };

  const stdout = child.stdout!;
  const stderr = child.stderr!;
  stdout.on("data", (buf: Buffer) => {
    record.stdoutBytes += buf.length;
    record.log.write(buf);
    out.push(buf);
  });
  stderr.on("data", (buf: Buffer) => {
    record.stderrBytes += buf.length;
    record.log.write(buf);
    err.push(buf);
  });
  stdout.on("end", () => {
    record.stdoutEnded = true;
    out.end();
    maybeComplete(record, config);
  });
  stderr.on("end", () => {
    record.stderrEnded = true;
    err.end();
    maybeComplete(record, config);
  });

  child.on("error", (error: Error) => {
    // ENOENT 走这条路：spawn 本身不抛，且不会有 exit 事件。
    record.spawnError = { code: (error as NodeJS.ErrnoException).code, message: error.message };
    void finalize(record, config);
  });

  child.on("exit", (code, signal) => {
    record.childExited = true;
    record.exitCode = code;
    record.signal = signal;
    maybeComplete(record, config);
  });

  if (record.timeoutMs > 0) {
    record.timers.timeout = scheduleTimeout(record.timeoutMs, () => {
      requestKill(record, "timeout", config);
    });
  }
}

/** SIGTERM → 5s → SIGKILL，整组。幂等：已经在终态就直接返回。 */
export function requestKill(
  record: ExecutionRecord,
  reason: "killed" | "timeout",
  config: Config,
): void {
  if (record.status !== "running" || record.finishing) return;
  if (record.killReason === null) record.killReason = reason; // 先发生的终止原因说了算

  record.timers.timeout?.cancel();
  record.timers.timeout = undefined;

  // 已经攒在合并器里的输出立刻冲出去，不等 100ms 窗口。
  record.mergers?.out.flush();
  record.mergers?.err.flush();

  if (record.pid !== null && record.timers.escalation === undefined) {
    record.timers.escalation = escalateKill(record.pid, config.killGraceMs);
  }
}

async function finalize(record: ExecutionRecord, config: Config): Promise<void> {
  if (record.finishing) return;
  record.finishing = true;
  clearTimers(record);

  // 先吐干净残留输出，再定终态——终态事件必须排在所有内容事件之后。
  record.mergers?.out.end();
  record.mergers?.err.end();

  const status: TerminalStatus =
    record.spawnError !== null ? "failed" : (record.killReason ?? "completed");
  record.status = status;
  record.endedAt = Date.now();

  // 日志落盘之后才发终态：CP 一收到终态事件就会去读 log_path。
  await record.log.end();

  record.bus.publish(status, terminalData(record, status));
  record.bus.close();
  record.onFinish?.();
  record.resolveFinished();
}

/**
 * 终态的条件：直接子进程已经退出，且两路管道都到 EOF——或宽限期用完。
 *
 * 为什么需要宽限期：后台进程会继承管道写端，`nohup ./dev-server &` 之后
 * 管道永远不会 EOF。死等就会让终态事件永远不发（§C.2：exec 正常结束时不禁子进程）。
 */
function maybeComplete(record: ExecutionRecord, config: Config): void {
  if (record.finishing || record.status !== "running") return;
  if (!record.childExited) return;

  if (record.stdoutEnded && record.stderrEnded) {
    void finalize(record, config);
    return;
  }
  if (record.timers.drain !== undefined) return;

  const drain = setTimeout(() => {
    record.timers.drain = undefined;
    record.mergers?.out.end();
    record.mergers?.err.end();
    // 后台进程之后的输出就丢了——它不属于这次执行的结果。
    record.child?.stdout?.destroy();
    record.child?.stderr?.destroy();
    void finalize(record, config);
  }, config.exitDrainMs);
  drain.unref();
  record.timers.drain = drain;
}

function clearTimers(record: ExecutionRecord): void {
  record.timers.timeout?.cancel();
  record.timers.timeout = undefined;
  record.timers.escalation?.cancel();
  record.timers.escalation = undefined;
  if (record.timers.drain !== undefined) {
    clearTimeout(record.timers.drain);
    record.timers.drain = undefined;
  }
}

/**
 * 内联事件的字节预算。超限后事件流不再发内容，只发一条 truncated——
 * 但日志文件继续写（§C.2：完整内容始终在日志文件）。
 */
function emitChunk(
  record: ExecutionRecord,
  stream: "stdout" | "stderr",
  text: string,
  bytes: number,
): void {
  if (record.truncated || record.finishing) return;

  const remaining = record.maxOutputBytes - record.inlineBytes;
  if (bytes > remaining) {
    const prefix = takePrefixBytes(text, remaining);
    if (prefix.length > 0) {
      record.inlineBytes += Buffer.byteLength(prefix, "utf8");
      record.bus.publish(stream, { chunk: prefix });
    }
    record.truncated = true;
    record.bus.publish("truncated", {
      reason: "output_limit",
      limit: record.maxOutputBytes,
      log_path: record.logPath,
    });
    return;
  }

  record.inlineBytes += bytes;
  record.bus.publish(stream, { chunk: text });
}

/** 按码点截断，绝不切在代理对中间。只在触发截断时走一次。 */
function takePrefixBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let prefix = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    prefix += char;
  }
  return prefix;
}

function terminalData(record: ExecutionRecord, status: TerminalStatus): TerminalEventData {
  const data: TerminalEventData = {
    exit_code: record.exitCode,
    signal: record.signal,
    duration_ms: (record.endedAt ?? Date.now()) - record.startedAt,
    stdout_bytes: record.stdoutBytes,
    stderr_bytes: record.stderrBytes,
    truncated: record.truncated,
    log_truncated: record.log.truncated,
    log_path: record.logPath,
  };
  if (status === "timeout") data.timeout_ms = record.timeoutMs;
  if (status === "failed") {
    data.error = record.spawnError?.code ?? "spawn_failed";
    data.message = record.spawnError?.message ?? "failed to spawn command";
  }
  return data;
}

/**
 * 固定的最小环境集合 + 请求里的 env。
 * **不继承** agent 自己的 process.env：理由不是防泄密（容器里本来没秘密），
 * 而是确定性——测试里环境变量不随宿主漂移。顺带保证 SANDBOX_AGENT_TOKEN
 * 不可能从环境里漏进被执行的命令。
 */
export function buildEnv(requestEnv: Record<string, string>, config: Config): Record<string, string> {
  return {
    PATH: config.basePath,
    HOME: config.home,
    LANG: config.lang,
    TERM: config.term,
    ...requestEnv,
  };
}

function invalid(error: string, message: string): ValidationResult {
  return { ok: false, body: { error, message } };
}
