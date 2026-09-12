/**
 * 执行注册表：单执行并发闸 + id 生成 + 状态表。
 *
 * 并发模型是设计而不是临时限制（§C.2）：一个沙箱同时只允许一个 exec，
 * 第二个请求返回 409。需要并发就开多个沙箱。
 *
 * 状态表的唯一权威在 CP 的 Postgres 里；这里只维护「这个进程现在还活着吗」这个事实。
 */

import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { Config } from "../config.ts";
import type { RootResolver } from "../paths.ts";
import { ulid } from "../ulid.ts";
import type { ErrorResponse, TerminalStatus } from "../types.ts";
import { EventBus } from "./events.ts";
import { LogFile } from "./logfile.ts";
import type { OutputMerger } from "./output.ts";
import type { KillEscalation, ScheduledTimeout } from "./timeout.ts";
import { requestKill, startProcess, validateExecRequest, type ValidatedExecRequest } from "./spawn.ts";

export interface ExecutionRecord {
  readonly id: string;  readonly cmd: string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly logPath: string;
  readonly log: LogFile;
  readonly bus: EventBus;
  readonly startedAt: number;

  status: "running" | TerminalStatus;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;

  /** 进程产出的原始字节数（不是字符数），与日志文件长度一致。 */
  stdoutBytes: number;
  stderrBytes: number;
  /** 已经发进事件流的字节数，上限 maxOutputBytes。 */
  inlineBytes: number;
  truncated: boolean;

  endedAt: number | null;
  /** 一旦置上就不再变：先发生的终止原因说了算。 */
  killReason: "killed" | "timeout" | null;
  spawnError: { code?: string; message: string } | null;

  // 以下由 spawn.ts 独占读写（接线与收尾状态机）。
  child: ChildProcess | null;
  mergers: { out: OutputMerger; err: OutputMerger } | null;
  timers: {
    timeout?: ScheduledTimeout;
    escalation?: KillEscalation;
    drain?: NodeJS.Timeout;
  };
  stdoutEnded: boolean;
  stderrEnded: boolean;
  childExited: boolean;
  finishing: boolean;

  /** 终态事件发完、日志落盘之后 resolve。 */
  readonly finished: Promise<void>;
  resolveFinished: () => void;
  /** registry 用来释放 BUSY 槽。 */
  onFinish: (() => void) | null;
}

/** 与 /exec 共享的 BUSY 槽。Phase 3 的 diff / archive 也用这一个（附录 A-5）。 */
export class BusyGate {
  #active: string | null = null;

  get activeExecution(): string | null {
    return this.#active;
  }

  acquire(id: string): { ok: true } | { ok: false; activeExecution: string } {
    if (this.#active !== null) return { ok: false, activeExecution: this.#active };
    this.#active = id;
    return { ok: true };
  }

  release(id: string): void {
    if (this.#active === id) this.#active = null;
  }
}

export type StartResult =
  | { ok: true; execution: ExecutionRecord }
  | { ok: false; status: number; body: ErrorResponse };

export type KillResult = { ok: true; execution: ExecutionRecord } | { ok: false };

export class ExecutionRegistry {
  #config: Config;
  #roots: RootResolver;
  #executions = new Map<string, ExecutionRecord>();
  #gate = new BusyGate();
  #shuttingDown = false;

  constructor(config: Config, roots: RootResolver) {
    this.#config = config;
    this.#roots = roots;
  }

  get activeExecution(): string | null {
    return this.#gate.activeExecution;
  }

  get runningCount(): number {
    let count = 0;
    for (const record of this.#executions.values()) {
      if (record.status === "running") count += 1;
    }
    return count;
  }

  start(raw: unknown): StartResult {
    if (this.#shuttingDown) {
      return { ok: false, status: 503, body: { error: "shutting_down" } };
    }

    const validated = validateExecRequest(raw, this.#config, this.#roots);
    if (!validated.ok) return { ok: false, status: 400, body: validated.body };

    const id = `exe_${ulid()}`;
    const slot = this.#gate.acquire(id);
    if (!slot.ok) {
      return {
        ok: false,
        status: 409,
        body: { error: "busy", activeExecution: slot.activeExecution },
      };
    }

    const record = this.#createRecord(id, validated.request);
    this.#executions.set(id, record);
    startProcess(record, this.#config);
    return { ok: true, execution: record };
  }

  get(id: string): ExecutionRecord | undefined {
    return this.#executions.get(id);
  }

  /** 幂等：未知 id → not ok（调用方给 404）；已在终态 → ok，调用方读 record.status。 */
  kill(id: string): KillResult {
    const record = this.#executions.get(id);
    if (record === undefined) return { ok: false };
    if (record.status === "running") requestKill(record, "killed", this.#config);
    return { ok: true, execution: record };
  }

  /**
   * 优雅退出：杀掉所有在跑的进程组，等它们真的死掉。
   * 顺序是重点——先杀进程组再关 server，否则容器里会留下孤儿。
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const running = [...this.#executions.values()].filter((r) => r.status === "running");
    for (const record of running) requestKill(record, "killed", this.#config);
    if (running.length === 0) return;

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#config.killGraceMs + 1_000);
      timer.unref();
    });
    await Promise.race([Promise.all(running.map((r) => r.finished)), deadline]);
    if (timer !== undefined) clearTimeout(timer);
  }

  #createRecord(id: string, request: ValidatedExecRequest): ExecutionRecord {
    const logPath = path.join(this.#config.logRoot, `${id}.log`);
    const bus = new EventBus(logPath, {
      maxEvents: this.#config.eventBufferMaxEvents,
      maxBytes: this.#config.eventBufferMaxBytes,
      heartbeatMs: this.#config.heartbeatMs,
    });
    // 日志的错误/截断回调可能在终态事件之后才到（写错误是异步的），
    // 这时总线已经关了——发了会抛，而抛出点是在流的 error 监听器里。
    const publishIfOpen = (type: "stderr" | "truncated", data: unknown): void => {
      if (!bus.closed) bus.publish(type, data);
    };
    const log = new LogFile({
      path: logPath,
      maxBytes: this.#config.maxLogBytes,
      // 写失败不能弄死执行：发一条 stderr 事件说明，然后继续跑。
      onError: (message) => {
        publishIfOpen("stderr", { chunk: `[sandbox-agent] log write failed: ${message}\n` });
      },
      onTruncated: (limit) => {
        publishIfOpen("truncated", { reason: "log_limit", limit, log_path: logPath });
      },
    });

    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    return {
      id,
      cmd: request.cmd,
      cwd: request.cwd,
      env: request.env,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      logPath,
      log,
      bus,
      startedAt: Date.now(),
      status: "running",
      pid: null,
      exitCode: null,
      signal: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      inlineBytes: 0,
      truncated: false,
      endedAt: null,
      killReason: null,
      spawnError: null,
      child: null,
      mergers: null,
      timers: {},
      stdoutEnded: false,
      stderrEnded: false,
      childExited: false,
      finishing: false,
      finished,
      resolveFinished,
      onFinish: () => this.#gate.release(id),
    };
  }
}
