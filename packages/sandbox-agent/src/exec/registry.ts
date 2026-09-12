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

/**
 * 一次执行的全部状态。可以理解成"内存里对应一个正在跑的进程的那行数据库记录"。
 *
 * 它同时被三个模块读写，所以字段分两段：
 *  - 上半段：创建时定下的入参 + 对外可读的进度；谁都可以读
 *  - 下半段（注释标了的那堆）：**只有 spawn.ts** 读写，别的文件不要碰（收尾状态机在用）
 * 注意没有任何字段是 `readonly` 以外的写入保护——全靠约定，所以那段注释很重要。
 */
export interface ExecutionRecord {
  /** 形如 `exe_01H...`。也是日志文件名的来源。整条链路上都用它寻址。 */
  readonly id: string;
  /** 实际执行的 argv（已经过校验）。 */
  readonly cmd: string[];
  /** 实际生效的工作目录（已经过 paths.ts 校验与解析）。 */
  readonly cwd: string;
  /** 本次专属的环境变量（不含 spawn.ts 补的那个固定最小集合）。 */
  readonly env: Record<string, string>;
  /** 超时毫秒数。已经过"≤ MAX_TIMEOUT_MS"校验。 */
  readonly timeoutMs: number;
  /** 内联事件流的字节预算。已经过校验。 */
  readonly maxOutputBytes: number;
  /** 日志文件路径。创建时就算好，因为 /exec 的 202 响应里要立即返回它。 */
  readonly logPath: string;
  /** 日志文件句柄，见 logfile.ts。 */
  readonly log: LogFile;
  /** 事件总线，见 events.ts。 */
  readonly bus: EventBus;
  /** 创建时刻（Date.now()），用来算 duration_ms。 */
  readonly startedAt: number;

  /** 运行中还是已终态。**只有 spawn.ts 能把它从 "running" 改掉**。 */
  status: "running" | TerminalStatus;
  /** 进程组组长 pid；spawn 之前或 spawn 失败时为 null。kill 用的就是它。 */
  pid: number | null;
  /** 退出码；被信号杀死 / 还没退出时为 null。 */
  exitCode: number | null;
  /** 杀死它的信号名；正常退出时为 null。 */
  signal: string | null;

  /** 进程产出的原始字节数（不是字符数），与日志文件长度一致。 */
  stdoutBytes: number;
  stderrBytes: number;
  /** 已经发进事件流的字节数，上限 maxOutputBytes。注意它是 stdout+stderr **共享**的预算。 */
  inlineBytes: number;
  /** 是否已经因为 inlineBytes 超限而发过 truncated（发过就不再发内容事件了）。 */
  truncated: boolean;

  /** 终态时刻（Date.now()）。算 duration_ms 和判断“结束多久了”用。 */
  endedAt: number | null;
  /** 一旦置上就不再变：先发生的终止原因说了算。 */
  killReason: "killed" | "timeout" | null;
  /** spawn 失败的结构化原因。非 null 时终态直接是 failed（优先于 killReason）。 */
  spawnError: { code?: string; message: string } | null;

  // 以下由 spawn.ts 独占读写（接线与收尾状态机）。
  /** Node 的子进程对象。stdout/stderr 的 'data' 监听就挂在它身上。 */
  child: ChildProcess | null;
  /** 两个输出合并器，一个管 stdout 一个管 stderr（不能合并，语义不同）。 */
  mergers: { out: OutputMerger; err: OutputMerger } | null;
  /**
   * 三个还没到点的定时器：
   *  - timeout：总超时，到点就 requestKill
   *  - escalation：已经发了 SIGTERM，等 5s 后补 SIGKILL
   *  - drain：直接子进程退了，等管道 EOF 的宽限期
   * 全部显式 cancel（而不是靠 unref）——否则终态事件会晚发。
   */
  timers: {
    timeout?: ScheduledTimeout;
    escalation?: KillEscalation;
    drain?: NodeJS.Timeout;
  };
  /** stdout 管道是否已经 EOF。 */
  stdoutEnded: boolean;
  /** stderr 管道是否已经 EOF。 */
  stderrEnded: boolean;
  /** 直接子进程是否已退出（孙子进程不算）。 */
  childExited: boolean;
  /** 收尾是否已经在跑。它是 finalize() 的幂等锁：并发调用只能有一个赢。 */
  finishing: boolean;

  /** 终态事件发完、日志落盘之后 resolve。registry.shutdown() 等它；记录本身不带取消。 */
  readonly finished: Promise<void>;
  /** #finished 的 resolve 函数，由 spawn.ts 收尾时调。 */
  resolveFinished: () => void;
  /** registry 用来释放 BUSY 槽。执行结束时被调用（不能忘，否则沙箱永久 409）。 */
  onFinish: (() => void) | null;
}

/**
 * 单执行并发闸（BUSY 槽）。整个沙箱同时只允许一个执行在跑。
 *
 * 为什么不支持并发：agent 本身是串行的，多路并发会带来输出交错、cwd 竞争、
 * 状态歧义，而这些复杂度换不来任何产品价值（§C.2）。需要并发的场景应该开多个沙箱。
 */
export class BusyGate {
  /** 当前占着槽的 execution_id；空闲时 null。 */
  #active: string | null = null;

  /** 槽里是谁（/health 会返回它，409 也返回它）。 */
  get activeExecution(): string | null {
    return this.#active;
  }

  /** 抢槽。抢不到时把"谁在占着"一起返回，好给 CP 一个可用的错误响应。 */
  acquire(id: string): { ok: true } | { ok: false; activeExecution: string } {
    if (this.#active !== null) return { ok: false, activeExecution: this.#active };
    this.#active = id;
    return { ok: true };
  }

  /** 还槽。**比对 id**：防止一个晚到的旧执行把新执行的槽给释放了。 */
  release(id: string): void {
    if (this.#active === id) this.#active = null;
  }
}

/**
 * registry.start() 的结果。
 * 失败时直接带着该返回给 CP 的 HTTP 状态码和响应体，server.ts 原样 down 回去——
 * 这样"什么算 400、什么算 409、什么算 503"的知识只存在于这一层。
 */
export type StartResult =
  | { ok: true; execution: ExecutionRecord }
  | { ok: false; status: number; body: ErrorResponse };

/** registry.kill() 的结果：ok=false 只有一种含义——这个 id 没见过（→ 404）。 */
export type KillResult = { ok: true; execution: ExecutionRecord } | { ok: false };

/**
 * 执行注册表：把 HTTP 请求变成进程，并记住每个执行的状态。
 * 对外只有四个方法：start / get / kill / shutdown（外加给 /health 读的 activeExecution）。
 */
export class ExecutionRegistry {
  #config: Config;
  #roots: RootResolver;
  /** 所有见过的执行，包括已经终态的。不清理——CP 可能很晚才来查原因。 */
  #executions = new Map<string, ExecutionRecord>();
  #gate = new BusyGate();
  /** 置上之后 start() 一律 503，拒绝接新活（正在优雅退出）。 */
  #shuttingDown = false;

  constructor(config: Config, roots: RootResolver) {
    this.#config = config;
    this.#roots = roots;
  }

  /** /health 用的那个值，直接转发给闸。 */
  get activeExecution(): string | null {
    return this.#gate.activeExecution;
  }

  /** 还有几个执行在跑。优雅退出时打日志用。 */
  get runningCount(): number {
    let count = 0;
    for (const record of this.#executions.values()) {
      if (record.status === "running") count += 1;
    }
    return count;
  }

  /**
   * 接一个 /exec。五步，顺序都是设计过的：
   *  1. 正在关停 → 503（不再接新活）
   *  2. 校验请求 → 400（所有字段都不可信）
   *  3. 生成 id → 抢 BUSY 槽 → 抢不到 409
   *  4. 建状态记录（包括开日志文件、建事件总线）
   *  5. 起进程，**立即返回**——不等命令跑完
   *
   * @param raw 已经 JSON.parse 过的请求体，类型故意是 unknown（还得自己校验）
   */
  start(raw: unknown): StartResult {
    if (this.#shuttingDown) {
      return { ok: false, status: 503, body: { error: "shutting_down" } };
    }

    const validated = validateExecRequest(raw, this.#config, this.#roots);
    if (!validated.ok) return { ok: false, status: 400, body: validated.body };

    // id 先分配、槽后抢：这样 409 的响应里也带上造成冲突的那个 id，方便排查。
    const id = `exe_${ulid()}`;
    const slot = this.#gate.acquire(id);
    if (!slot.ok) {
      return {
        ok: false,
        status: 409,
        body: { error: "busy", activeExecution: slot.activeExecution },
      };
    }

    // 先把记录放进表，再起进程：startProcess 是同步的，但它内部会立即发 started 事件，
    // 那时记录必须已经可查（否则刚连上来的 SSE 会 404）。
    const record = this.#createRecord(id, validated.request);
    this.#executions.set(id, record);
    startProcess(record, this.#config);
    return { ok: true, execution: record };
  }

  /** 按 id 查记录。server.ts 的 events / kill 两个路由都先靠它判 404。 */
  get(id: string): ExecutionRecord | undefined {
    return this.#executions.get(id);
  }

  /**
   * 幂等：未知 id → not ok（调用方给 404）；已在终态 → ok，调用方读 record.status。
   *
   * @param id execution_id
   * @returns ok=true 时调用方自己看 `record.status` 决定回什么 body：
   *          "running" → 回 "killing"；已经是终态 → 原样回那个终态值。
   *          重试语义靠这个幂等性：重复 POST /kill 不会报错。
   */
  kill(id: string): KillResult {
    const record = this.#executions.get(id);
    if (record === undefined) return { ok: false };
    if (record.status === "running") requestKill(record, "killed", this.#config);
    return { ok: true, execution: record };
  }

  /**
   * 优雅退出：杀掉所有在跑的进程组，等它们真的死掉。
   * 顺序是重点——先杀进程组再关 server，否则容器里会留下孤儿。
   *
   * "真的是杀干净了吗"靠两条：
   *  - 每个 record 的 #finished（由 spawn.ts 的 finalize() 在日志落盘后才 resolve）
   *  - 一个兜底 deadline（killGraceMs + 1s）：万一某个进程赖着不死，也不能无限等
   * index.ts 在拿到本方法返回之后才会调 server.closeAllConnections()。
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
    // 日志路径在这里定下来（不是 spawn 的时候），因为 /exec 的 202 响应里就要返回它。
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

    // 手写一个 Promise 并把 resolve 存下来：spawn.ts 的 finalize() 到最后会调它，
    // registry.shutdown() 就 await 这个 Promise 来等所有执行真正收尾（见下面 shutdown）。
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
      // 注意：status 一开始就是 "running"，没有 "pending" ——start() 里同步就把进程起来了。
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
      // 下面这些全部由 spawn.ts 填。
      child: null,
      mergers: null,
      timers: {},
      stdoutEnded: false,
      stderrEnded: false,
      childExited: false,
      finishing: false,
      finished,
      resolveFinished,
      // 关键的一行：终态收尾时会调它，把 BUSY 槽还回去。
      onFinish: () => this.#gate.release(id),
    };
  }
}
