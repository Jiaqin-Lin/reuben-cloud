/**
 * SandboxManager：DB 里的状态与真实容器之间的那一层（§C.1 / §D / Phase 8 §4）。
 *
 * 【它负责什么】把"业务要一个沙箱/要跑一条命令"翻译成两件必须一起做对的事：
 *  1. provider 上的动作（建容器、销毁容器）
 *  2. Postgres 里的状态转换（CREATE→READY、READY→BUSY→READY、…→DESTROYED）
 * 顺序在 create 那里是**先写 DB 再建容器**：崩在中途时留下的是一行可对账的记录，
 * 而不是一个没人知道的孤儿容器。
 *
 * 【它不负责什么】不碰 docker socket（那是 provider 的唯一特权）、不拼 SQL
 * （那是 db/ 的事）、不实现归档本身（那是 `artifacts/offload.ts` 的事——
 * manager 只负责决定"什么时候归档、失败了怎么办"）。它只保证：每次状态变化都经过
 * transition()，每一次执行都有终态记录。
 *
 * 【两条计时，缺一不可】§E 的原话。第一道是沙箱自己的 timeout（Phase 1 §9），
 * 这里实现的是**第二道**：看门狗（`timeoutMs + watchdogGraceMs`）。
 * 它存在的唯一理由是"SSE 断线、CP 重启、agent 假死都会让单点计时失真"。
 * 到点还没收到终态事件 → 调 /kill → 还是没动静 → 沙箱转 ERROR。
 * 所以这里的很多代码在正常路径上**永远不会执行**——它们是留给故障的那一半的。
 */

import { AGENT_TERMINAL_EVENTS, SandboxApiError, SandboxApiClient } from "../client/sandbox-api.ts";
import type { AgentExecAccepted } from "../client/sandbox-api.ts";
import type { ArtifactSummary, OffloadStep } from "../artifacts/offload.ts";
import { ArtifactOffloader, OffloadError } from "../artifacts/offload.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { SseEvent } from "../client/sse.ts";
import type { Db } from "../db/client.ts";
import { recordExecution } from "../db/executions.ts";
import type { ExecutionState } from "../db/executions.ts";
import { currentStateOf, getSandbox, insertSandbox, transition } from "../db/sandboxes.ts";
import type { SandboxLimitsRecord, SandboxRow, SandboxState } from "../db/sandboxes.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { ProviderError, workspaceVolumeName } from "../provider/types.ts";
import type { SandboxLimits, SandboxProvider, SandboxSpec } from "../provider/types.ts";
import { asProviderError } from "../provider/local-docker.ts";
import { prefixedId } from "../ulid.ts";

// ---------------------------------------------------------------- 常量

/** 单条命令的默认时限（§D 的超时表：120s）。 */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/**
 * 单条命令的硬上限（§D：600s）。**超上限拒绝，不静默截断**。
 *
 * 这一条与沙箱侧的 `timeout_exceeds_max` 是同一条规矩的两道实现：
 * CP 在发出去之前就拒，省掉一次往返；沙箱侧仍然拒，因为它不能被绕过。 */
export const MAX_EXEC_TIMEOUT_MS = 600_000;

/** 看门狗的宽限：`timeoutMs + 30_000` 到点才开始怀疑沙箱（§Phase 8 §4 第 5 步）。 */
export const WATCHDOG_GRACE_MS = 30_000;

/**
 * 叫了 /kill 之后等终态事件的时间。**必须大于沙箱侧的 SIGTERM → 5s → SIGKILL 阶梯**
 * （Phase 1 §9），否则我们会在它正常收尾的中途就宣布它死了。
 */
export const WATCHDOG_KILL_WAIT_MS = 15_000;

/** 一把手的配额（§G.1 的 limits 缺省）。TTL 6h 来自 §D。 */
export const DEFAULT_LIMITS: SandboxLimits = {
  cpu: 1,
  memMb: 2048,
  pids: 2048,
  diskMb: 4096,
  ttlSec: 21_600,
};

/**
 * 终态事件四选一，互斥（§C.2）。**名单的来源在 client**：`execAndWait` 与 manager
 * 必须认同一份定义，否则两条路对"什么算跑完了"的理解会静默地分叉。
 */
export const TERMINAL_EVENTS: ReadonlySet<string> = AGENT_TERMINAL_EVENTS;

/** 有执行在跑时不接受新执行的状态。 */
const NOT_READY_REASONS: Record<Exclude<SandboxState, "READY">, string> = {
  CREATING: "沙箱还在创建中",
  BUSY: "沙箱正在执行另一条命令",
  ERROR: "沙箱处于错误状态，需要人工处理",
  DESTROYED: "沙箱已销毁",
};

// ---------------------------------------------------------------- 错误

export type SandboxManagerErrorReason =
  /** 沙箱行不存在（→ 404）。 */
  | "sandbox_missing"
  /** 沙箱当前状态不接受 exec（→ 409）。`details.state` 是当前状态。 */
  | "sandbox_not_ready"
  /** 请求本身不合法（→ 400）。 */
  | "invalid_request"
  /** 连不上 agent，或 agent 明确拒绝（`details.agentError`）。 */
  | "agent_rejected"
  /** 看门狗到点、kill 之后仍然没有终态事件。 */
  | "watchdog_timeout"
  /** 事件流断了且重连用尽。 */
  | "stream_failed"
  /** 状态转换被别人抢先（并发），或行已经不在了。 */
  | "state_conflict"
  /** 销毁前的归档还没成功（还在 10 分钟宽限期内）。`details.step` 是失败的环节。 */
  | "archive_failed";

/** Manager 层的失败。与 `ProviderError` / `SandboxApiError` 一样：调用方按 `reason` 分支。 */
export class SandboxManagerError extends Error {
  readonly reason: SandboxManagerErrorReason;
  readonly details: Record<string, unknown>;

  constructor(reason: SandboxManagerErrorReason, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SandboxManagerError";
    this.reason = reason;
    this.details = details;
  }
}

// ---------------------------------------------------------------- 输入/输出

/** 销毁前的归档设定（Phase 10）。给了才启用；不给就是裸跑/测试模式（与 Phase 8 行为一致）。 */
export interface ArtifactOffloadOptions {
  store: ArtifactStore;
  /** 归档的总尝试次数（含第一次），默认 3。 */
  attempts?: number;
  /** 重试退避基数，默认 500ms（指数增长）。 */
  backoffMs?: number;
  /** 最后一次尝试之前的宽限期，默认 10 分钟（spec 的硬要求）。 */
  graceMs?: number;
  /** 归档体积软配额，不给就用沙箱的 `limits.diskMb`。 */
  maxArchiveBytes?: number;
  /** 可注入时钟（宽限期判断用；测试会拨快它）。 */
  now?: () => Date;
}

/**
 * 归档失败后的宽限期（spec："10 分钟宽限期后再试一次"）。
 * 它不是一个"等 10 分钟再考虑"的定时器，而是"下一次销毁请求要先看看距第一次失败过没过 10 分钟"。
 */
export const ARCHIVE_GRACE_MS = 10 * 60_000;

/** 销毁前的归档结果。`allowDestroy=false` 时 manager 会抛 `archive_failed`。 */
export interface ArchiveOutcome {
  /** 是否允许继续销毁（false = 首次失败、还在宽限期内）。 */
  allowDestroy: boolean;
  /** 产出是否已全部落到对象存储。没起来过的沙箱是 false + skipped。 */
  archived: boolean;
  /** 跳过归档的原因（`no_endpoint` / `already_destroyed`）。 */
  skipped: string | null;
  /** 宽限期过后仍然存不上去，被**强制**销毁（产出可能永远丢了）。 */
  forced: boolean;
  /** 失败的环节（`archive` / `exec_log`）。 */
  failedStep: OffloadStep | null;
  /** 上传成功的 artifacts 行。 */
  artifacts: ArtifactSummary[];
}

/** `destroySandbox()` 的结果。Phase 12 会把它写进 Run 结果（`archive_failed` 就在里面）。 */
export interface DestroyReport {
  sandboxId: string;
  /** 销毁后的状态（并发抢改时可能是别的）。 */
  state: SandboxState | "missing";
  /** 启用归档时是归档结果，否则是 null。 */
  archive: ArchiveOutcome | null;
}

export interface SandboxManagerOptions {
  db: Db;
  provider: SandboxProvider;
  /** 默认镜像，**必须是 digest 引用**（provider 会拒绝纯 tag）。 */
  image: string;
  api?: SandboxApiClient;
  /** 覆盖缺省配额（按字段合并，没给的用 DEFAULT_LIMITS）。 */
  defaultLimits?: Partial<SandboxLimits>;
  /** 看门狗宽限，默认 30s；测试会调小。 */
  watchdogGraceMs?: number;
  /** kill 之后等终态的时长，默认 15s；测试会调小。 */
  watchdogKillWaitMs?: number;
  /** Phase 10：销毁之前把产出落到对象存储。不给 = 不归档（裸跑、单测）。 */
  artifacts?: ArtifactOffloadOptions;
  log?: LogFn;
}

export interface CreateSandboxInput {
  runId: string;
  taskId?: string;
  /** 覆盖 options.image（例如同一个 run 里换一个镜像）。 */
  image?: string;
  /** 覆盖默认配额。 */
  limits?: Partial<SandboxLimits>;
}

export interface CreatedSandbox {
  sandboxId: string;
  state: SandboxState;
  endpoint: string | null;
  providerRef: string | null;
  containerName: string;
  volumeName: string;
  authToken: string | null;
  row: SandboxRow;
}

export interface ExecInSandboxRequest {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** 边收边转发（Phase 11 的实时 transcript 用）。 */
  onEvent?: (event: SseEvent) => void;
}

export interface ExecInSandboxResult {
  executionId: string;
  /** 四选一，与 `executions.state` 一致（这里不会是 running）。 */
  state: ExecutionState;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  /** 事件流里丢了内容（完整输出在日志文件里）。 */
  truncated: boolean;
  /**
   * 连**日志文件**都到顶了（沙箱侧 `SANDBOX_AGENT_MAX_LOG_BYTES`，默认 256 MiB）。
   * 这时 `logPath` 也不是完整输出——Phase 11 的 `bash` 工具要在提示里如实说明。
   */
  logTruncated: boolean;
  logPath: string | null;
  /** 收到的事件（含终态）。总量受 `maxOutputBytes` 约束，不会无界。 */
  events: SseEvent[];
}

/** 归一化之后的 exec 请求。`envKeys` 是**唯一**从 env 派生的东西，值不会进 DB。 */
interface CleanExecRequest {
  cmd: string[];
  cwd: string | null;
  env: Record<string, string>;
  envKeys: string[];
  timeoutMs: number;
  maxOutputBytes: number | undefined;
}

/** 终态事件解出来的执行结果。 */
interface TerminalInfo {
  state: ExecutionState;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  logTruncated: boolean;
  logPath: string | null;
  error: string | null;
}

export class SandboxManager {
  readonly #db: Db;
  readonly #provider: SandboxProvider;
  readonly #api: SandboxApiClient;
  readonly #image: string;
  readonly #limits: SandboxLimits;
  readonly #watchdogGraceMs: number;
  readonly #watchdogKillWaitMs: number;
  readonly #offloader: ArtifactOffloader | null;
  readonly #offload: ArtifactOffloadOptions | null;
  readonly #log: LogFn;
  /**
   * 归档失败的"第一次"时刻（宽限期从这里算）。
   *
   * 【为什么是内存】它是**策略的计时器，不是事实**：失败事实本身已经落在 DB 里
   * （`ERROR(archive_failed)` + 审计行），而"距第一次失败过了多久"可以用内存里的这个
   * 时间戳回答。CP 重启后计时重新开始 —— 最坏的影响是这台沙箱在宽限期里多活 10 分钟，
   * 而它不会让任何产出被提前删掉（归档没成功就不会销毁，除非宽限到了 → 强制销毁，
   * 而那时时钟总是 >= 10 分钟）。
   */
  readonly #archiveFailures = new Map<string, Date>();

  constructor(options: SandboxManagerOptions) {
    this.#db = options.db;
    this.#provider = options.provider;
    this.#api = options.api ?? new SandboxApiClient();
    this.#image = options.image;
    this.#limits = { ...DEFAULT_LIMITS, ...options.defaultLimits };
    this.#watchdogGraceMs = options.watchdogGraceMs ?? WATCHDOG_GRACE_MS;
    this.#watchdogKillWaitMs = options.watchdogKillWaitMs ?? WATCHDOG_KILL_WAIT_MS;
    // `#log` 要先于 offloader 构造（offloader 自己也要一根日志线）。
    this.#log = options.log ?? noopLog;
    this.#offload = options.artifacts ?? null;
    this.#offloader =
      this.#offload === null
        ? null
        : new ArtifactOffloader({
            db: this.#db,
            store: this.#offload.store,
            api: this.#api,
            ...(this.#offload.maxArchiveBytes === undefined
              ? {}
              : { maxArchiveBytes: this.#offload.maxArchiveBytes }),
            log: this.#log,
          });
  }

  get provider(): SandboxProvider {
    return this.#provider;
  }

  get api(): SandboxApiClient {
    return this.#api;
  }

  /** 读一行（对账、sweeper、测试都要）。不存在给 null，不抛。 */
  getSandbox(sandboxId: string): Promise<SandboxRow | null> {
    return getSandbox(this.#db, sandboxId);
  }

  // -------------------------------------------------------------- 创建

  /**
   * 创建沙箱。顺序**本身是设计的一部分**（Phase 8 §4）：
   *   ① 先生成 `sbx_<ulid>` 并插入一行 CREATING
   *   ② 调 `provider.create`
   *   ③ 成功 → 落 endpoint / provider_ref → transition(READY)
   *   ④ 失败 → transition(ERROR, reason)（reason 取 provider 的结构化原因）
   *
   * ①在②之前不能反：崩在 create 中途时，DB 里要有一行可对账的记录。
   */
  async createSandbox(input: CreateSandboxInput): Promise<CreatedSandbox> {
    if (typeof input.runId !== "string" || input.runId === "") {
      throw new SandboxManagerError("invalid_request", "runId 必填", { field: "runId" });
    }
    const sandboxId = prefixedId("sbx");
    const image = input.image ?? this.#image;
    const limits: SandboxLimits = { ...this.#limits, ...input.limits };
    const volumeName = workspaceVolumeName(sandboxId);

    // ① 一行 CREATING + 一条审计（NULL → CREATING）。**先于 provider**。
    await insertSandbox(this.#db, {
      id: sandboxId,
      taskId: input.taskId ?? null,
      runId: input.runId,
      provider: this.#provider.kind,
      image,
      imageDigest: imageDigestOf(image),
      limits,
      workspaceVolume: volumeName,
    });
    this.#log("info", `沙箱 ${sandboxId} 已登记（CREATING）`, { image, runId: input.runId });

    // ② provider.create。spec.labels 带上 sandboxId / runId——provider 用它命名容器与卷，
    // 对账也用它，这是"标签是唯一依据"那条规矩的起点。
    const spec: SandboxSpec = {
      image,
      limits,
      labels: {
        sandboxId,
        runId: input.runId,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      },
      workspace: { sizeMb: limits.diskMb },
    };

    let handle;
    try {
      handle = await this.#provider.create(spec);
    } catch (error) {
      // ④ 失败：结构化原因进 state_reason，审计行留下"创建失败"的痕迹。
      // provider 自己已经把半成品清掉了（Phase 5 的 rollback），这里只处理账。
      const providerError = error instanceof ProviderError ? error : asProviderError(error, "create");
      await this.#transitionOrLog(sandboxId, ["CREATING"], "ERROR", providerError.reason);
      this.#log("error", `沙箱 ${sandboxId} 创建失败`, { reason: providerError.reason, message: providerError.message });
      throw providerError;
    }

    // ③ 落事实 + 转 READY。
    const moved = await transition(this.#db, sandboxId, ["CREATING"], "READY", "create_ready", {
      provider_ref: handle.providerRef,
      endpoint: handle.endpoint,
      auth_token: handle.authToken,
      image_digest: imageDigestOf(image),
      ready_at: new Date(),
      last_active_at: new Date(),
    });
    if (!moved.ok) {
      // 极罕见：对账在 create 的中途把这行标成了 ERROR（容器当时还没起来）。
      // 现在容器起来了，但这一行已经不是 CREATING —— 留着一个无人认领的容器是最坏的结果，
      // 所以先把容器删掉，再把冲突如实报出去。
      const current = currentStateOf(moved);
      this.#log("warn", `沙箱 ${sandboxId} 的状态在对账中被改成了 ${current}，回滚刚建好的容器`);
      await this.#provider.destroy(sandboxId).catch((error: unknown) => {
        this.#log("warn", `回滚 ${sandboxId} 失败，留给下一次对账`, { error: String(error) });
      });
      throw new SandboxManagerError("state_conflict", `沙箱 ${sandboxId} 在创建完成前进入了 ${current}`, {
        state: current,
      });
    }

    const row = await getSandbox(this.#db, sandboxId);
    if (row === null) throw new SandboxManagerError("state_conflict", `沙箱 ${sandboxId} 在 READY 之后消失了`);
    this.#log("info", `沙箱 ${sandboxId} 就绪`, { endpoint: handle.endpoint, container: handle.containerName });

    return {
      sandboxId,
      state: row.state,
      endpoint: row.endpoint,
      providerRef: row.provider_ref,
      containerName: handle.containerName,
      volumeName: handle.volumeName,
      authToken: row.auth_token,
      row,
    };
  }

  // -------------------------------------------------------------- 执行

  /**
   * 在沙箱里跑一条命令并等到终态。**一次一条**：DB 的 READY→BUSY 转换就是并发闸
   * （两个并发调用只有一个能拿到 READY，另一个拿到 409）。
   *
   * 步骤与 §Phase 8 §4 一致：查状态 → transition(BUSY) → POST /exec → 消费 SSE
   * → 看门狗兜底 → 写 executions → transition(READY)。
   */
  async execInSandbox(sandboxId: string, request: ExecInSandboxRequest): Promise<ExecInSandboxResult> {
    const row = await getSandbox(this.#db, sandboxId);
    if (row === null) {
      throw new SandboxManagerError("sandbox_missing", `沙箱 ${sandboxId} 不存在`, { sandboxId });
    }
    const clean = validateExecRequest(request);

    // 状态检查先做（快速失败），真正的并发保护是下面那次 CAS 转换。
    if (row.state !== "READY") {
      throw new SandboxManagerError(
        "sandbox_not_ready",
        `沙箱 ${sandboxId} ${NOT_READY_REASONS[row.state]}`,
        { sandboxId, state: row.state },
      );
    }
    const endpoint = row.endpoint;
    const token = row.auth_token;
    if (endpoint === null || token === null) {
      throw new SandboxManagerError("sandbox_not_ready", `沙箱 ${sandboxId} 还没有 endpoint/token`, {
        sandboxId,
        state: row.state,
      });
    }

    // ① READY → BUSY（CAS）。这里也是 last_active_at 的刷新点（§Phase 8 §4 末段）。
    const acquired = await transition(this.#db, sandboxId, ["READY"], "BUSY", "exec_started", {
      last_active_at: new Date(),
    });
    if (!acquired.ok) {
      const current = currentStateOf(acquired);
      throw new SandboxManagerError("sandbox_not_ready", `沙箱 ${sandboxId} 的并发闸被抢走了（当前 ${current}）`, {
        sandboxId,
        state: current,
      });
    }

    // ② POST /exec。失败时的处理分两种，见 #rejectExec。
    let accepted: AgentExecAccepted;
    try {
      accepted = await this.#api.exec(endpoint, token, {
        cmd: clean.cmd,
        ...(clean.cwd === null ? {} : { cwd: clean.cwd }),
        ...(Object.keys(clean.env).length === 0 ? {} : { env: clean.env }),
        timeoutMs: clean.timeoutMs,
        ...(clean.maxOutputBytes === undefined ? {} : { maxOutputBytes: clean.maxOutputBytes }),
      });
    } catch (error) {
      await this.#rejectExec(sandboxId, error);
      throw error; // #rejectExec 已经把状态处理好了，原样把结构化错误抛给上层
    }

    // ③ 消费事件流（带看门狗）。#consumeExec 保证无论走哪条路都会写 executions + 收尾状态。
    return this.#consumeExec({ row, endpoint, token, clean, accepted, onEvent: request.onEvent });
  }

  /** 事件流的消费、看门狗、落记录、收尾。**每一步都要能从故障里收尾**。 */
  async #consumeExec(input: {
    row: SandboxRow;
    endpoint: string;
    token: string;
    clean: CleanExecRequest;
    accepted: AgentExecAccepted;
    onEvent?: (event: SseEvent) => void;
  }): Promise<ExecInSandboxResult> {
    const { row, endpoint, token, clean, accepted } = input;
    const sandboxId = row.id;
    const executionId = accepted.executionId;
    const events: SseEvent[] = [];
    const abort = new AbortController();
    const watchdog = { killRequested: false, killOk: false, killError: null as string | null };
    let terminal: TerminalInfo | null = null;
    let streamError: Error | null = null;
    let startedAt = new Date();

    let watchdogTimer: NodeJS.Timeout | null = null;
    let killWaitTimer: NodeJS.Timeout | null = null;

    // 看门狗：timeoutMs + 宽限。到点主动 /kill，再等 killWaitMs；还是没有终态就 abort 事件流，
    // 让下面那条"没有终态事件"的收尾路径去判 ERROR。
    watchdogTimer = setTimeout(() => {
      watchdog.killRequested = true;
      this.#log("warn", `看门狗触发：${executionId} 超过 ${clean.timeoutMs + this.#watchdogGraceMs}ms 没有终态事件`, {
        sandboxId,
        executionId,
      });
      killWaitTimer = setTimeout(() => {
        this.#log("warn", `kill 之后 ${this.#watchdogKillWaitMs}ms 仍然没有终态事件`, { sandboxId, executionId });
        abort.abort();
      }, this.#watchdogKillWaitMs);
      void this.#api.kill(endpoint, token, executionId).then(
        () => {
          watchdog.killOk = true;
        },
        (error: unknown) => {
          watchdog.killError = error instanceof Error ? error.message : String(error);
          this.#log("error", `看门狗 /kill 失败`, { sandboxId, executionId, error: watchdog.killError });
          abort.abort();
        },
      );
    }, clean.timeoutMs + this.#watchdogGraceMs);
    watchdogTimer.unref();

    try {
      for await (const event of this.#api.streamEvents(endpoint, token, executionId, {
        signal: abort.signal,
        onReconnect: (info) => {
          this.#log("warn", `事件流重连（第 ${info.attempt} 次）`, {
            sandboxId,
            executionId,
            lastEventId: info.lastEventId,
            cause: info.reason,
          });
        },
      })) {
        events.push(event);
        if (event.event === "started") {
          const ts = parseJson(event.data)["ts"];
          if (typeof ts === "string") startedAt = new Date(ts);
        }
        // 上层消费者的回调**不能**把收尾逻辑带走：它抛出来的话，我们仍然要继续读到终态
        // （否则一个 UI 的小 bug 会让一条 15 分钟的命令丢掉结果）。所以这里吞掉异常，只记日志。
        try {
          input.onEvent?.(event);
        } catch (error) {
          this.#log("warn", `exec 事件的消费者回调抛了异常（已忽略）`, {
            sandboxId,
            executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (TERMINAL_EVENTS.has(event.event)) {
          terminal = parseTerminalEvent(event);
          break;
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (watchdogTimer !== null) clearTimeout(watchdogTimer);
      if (killWaitTimer !== null) clearTimeout(killWaitTimer);
    }

    return this.#finishExec({ row, endpoint, token, clean, executionId, events, terminal, streamError, watchdog, startedAt, accepted });
  }

  /** 收尾：有终态就记终态；没有就把它杀干净、记一条"失败"并让沙箱转 ERROR。 */
  async #finishExec(input: {
    row: SandboxRow;
    endpoint: string;
    token: string;
    clean: CleanExecRequest;
    executionId: string;
    events: SseEvent[];
    terminal: TerminalInfo | null;
    streamError: Error | null;
    watchdog: { killRequested: boolean; killOk: boolean; killError: string | null };
    startedAt: Date;
    accepted: AgentExecAccepted;
  }): Promise<ExecInSandboxResult> {
    const { row, clean, executionId, events, terminal, watchdog } = input;
    const sandboxId = row.id;

    if (terminal !== null) {
      await recordExecution(this.#db, {
        id: executionId,
        sandboxId,
        runId: row.run_id,
        cmd: clean.cmd,
        cwd: clean.cwd,
        envKeys: clean.envKeys,
        state: terminal.state,
        reason: terminal.error ?? watchdogReason(terminal.state, watchdog.killRequested),
        exitCode: terminal.exitCode,
        stdoutBytes: terminal.stdoutBytes,
        stderrBytes: terminal.stderrBytes,
        truncated: terminal.truncated,
        logPath: terminal.logPath,
        startedAt: input.startedAt,
        endedAt: new Date(),
      });
      await this.#releaseBusy(sandboxId, "exec_finished");
      return {
        executionId,
        state: terminal.state,
        exitCode: terminal.exitCode,
        signal: terminal.signal,
        durationMs: terminal.durationMs,
        stdoutBytes: terminal.stdoutBytes,
        stderrBytes: terminal.stderrBytes,
        truncated: terminal.truncated,
        logTruncated: terminal.logTruncated,
        logPath: terminal.logPath,
        events,
      };
    }

    // ---- 没有终态事件。两种子情况（看门狗到点 / 事件流断了）都收敛到同一套收尾：
    // "先把它杀干净，再记一条没有退出码的执行记录，最后判 ERROR"。
    const reason = watchdog.killRequested ? "watchdog_timeout" : "stream_failed";
    let killOk = watchdog.killOk;
    if (!watchdog.killRequested) {
      // 流断了但还没到看门狗时间：补一次 kill（best effort）。
      // 不补的话，那个进程会在没人看着的情况下继续写 workspace。
      try {
        await this.#api.kill(input.endpoint, input.token, executionId);
        killOk = true;
      } catch (error) {
        this.#log("warn", `事件流断了之后的补杀失败`, {
          sandboxId,
          executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await recordExecution(this.#db, {
      id: executionId,
      sandboxId,
      runId: row.run_id,
      cmd: clean.cmd,
      cwd: clean.cwd,
      envKeys: clean.envKeys,
      // 杀掉了但没看到终态：`killed` 是最诚实的记录（退出码不可知）。
      // 连 kill 都失败：`failed` —— 我们既不知道它死了没有，也拿不到结果。
      state: killOk ? "killed" : "failed",
      reason: watchdog.killError === null ? reason : `${reason}:kill_failed`,
      exitCode: null,
      logPath: input.accepted.logPath === "" ? null : input.accepted.logPath,
      startedAt: input.startedAt,
      endedAt: new Date(),
    });

    // **沙箱一律转 ERROR**，不管 /kill 成功没成功。§D 的生命周期表写的是
    // "BUSY ──看门狗触发──► ERROR"，理由是"能接受 /exec 却不发终态事件"本身就是 agent
    // 病了的证据：放它回 READY 只会让下一条命令再等一次 timeout + 宽限，把故障拖成一个
    // 看不见的性能问题。回到可用状态需要人（或将来显式的重置流程）——这正是 ERROR 的含义。
    await this.#transitionOrLog(sandboxId, ["BUSY"], "ERROR", reason);

    const error = watchdog.killRequested
      ? new SandboxManagerError("watchdog_timeout", `执行 ${executionId} 超过时限仍然没有终态事件`, {
          sandboxId,
          executionId,
          killError: watchdog.killError,
        })
      : new SandboxManagerError("stream_failed", `执行 ${executionId} 的事件流中断且重连用尽`, {
          sandboxId,
          executionId,
          cause: input.streamError?.message ?? null,
        });
    throw error;
  }

  /**
   * `POST /exec` 失败之后的处理。
   *
   * 两种情况**必须分开**：
   *  - agent 回 `busy`：沙箱真的在跑别的命令（多半是上一次 CP 残留的执行）。
   *    DB 保持 BUSY 是诚实的（这个沙箱现在确实不能接新命令），
   *    真正的清理交给对账（kill + cp_restart）或 sweeper 的 TTL。
   *  - 其余失败（400 / 连不上）：命令根本没起来，把 BUSY 还回 READY。
   */
  async #rejectExec(sandboxId: string, error: unknown): Promise<void> {
    const agentError = error instanceof SandboxApiError ? error.agentError : null;
    if (agentError === "busy") {
      this.#log("warn", `沙箱 ${sandboxId} 在 agent 侧仍然是 BUSY，保持 BUSY 交给对账处理`);
      return;
    }
    await this.#releaseBusy(sandboxId, "exec_rejected");
  }

  /** BUSY → READY。失败只记日志：这是一个"清理"动作，不该覆盖真正的失败原因。 */
  async #releaseBusy(sandboxId: string, reason: string): Promise<void> {
    const result = await transition(this.#db, sandboxId, ["BUSY"], "READY", reason, {
      last_active_at: new Date(),
    });
    if (!result.ok) {
      const current = currentStateOf(result);
      this.#log("warn", `沙箱 ${sandboxId} 的 BUSY → READY 没有生效（当前 ${current}）`, { reason });
    }
  }

  async #transitionOrLog(
    sandboxId: string,
    from: readonly SandboxState[],
    to: SandboxState,
    reason: string,
  ): Promise<void> {
    const result = await transition(this.#db, sandboxId, from, to, reason);
    if (!result.ok) {
      const current = currentStateOf(result);
      this.#log("warn", `沙箱 ${sandboxId} 的 ${from.join("/")} → ${to} 没有生效（当前 ${current}）`, { reason });
    }
  }

  // -------------------------------------------------------------- 销毁

  /**
   * 销毁沙箱。**幂等**：provider.destroy 幂等，状态已经是 DESTROYED 时只做一次物理清理，
   * 不再写审计行（否则每次重试都会多一条"销毁"记录，轨迹就没法看了）。
   *
   * 【Phase 10 起多了一步：先归档】顺序是：
   *   ① （启用时）拉 diff → dryRun → 归档 → 执行日志，全部落到对象存储
   *   ② provider.destroy（容器 + 卷）
   *   ③ transition(DESTROYED)
   * ① 必须在 ② 前面：沙箱一销毁，`log_path` 与整个 workspace 都没有第二份了。
   *
   * 【为什么 ② 在 ③ 前面（与 spec 那一段的次序表相反）】spec 那张表写的是
   * transition(DESTROYED) → provider.destroy。反过来做的话，destroy 失败时会留下一行
   * **DESTROYED 但容器还活着**的记录——而 DESTROYED 没有出边（§D），对账又只扫
   * 非 DESTROYED 的行，那个容器会永远没人认领。先删容器再改状态，崩在中途留下的是
   * "RECORD 还在、容器已没了"，那正是 TTL 重试与对账都能处理的状态。
   *
   * 【归档失败怎么办】见 `#archiveBeforeDestroy`：重试 3 次 → `ERROR(archive_failed)`
   * 并**不销毁** → 宽限期过后再试一次 → 仍失败则强制销毁（并把 `archive_failed` 写进
   * 返回的报告与 `state_reason`）。
   */
  async destroySandbox(sandboxId: string, reason = "destroyed"): Promise<DestroyReport> {
    const row = await getSandbox(this.#db, sandboxId);
    if (row === null) {
      this.#archiveFailures.delete(sandboxId);
      throw new SandboxManagerError("sandbox_missing", `沙箱 ${sandboxId} 不存在`, { sandboxId });
    }

    // ① 归档（只在启用时）。宽限期内失败会抛 archive_failed，由调用方决定重试时机。
    const archive = this.#offloader === null ? null : await this.#archiveBeforeDestroy(row, this.#offloader);
    if (archive !== null && !archive.allowDestroy) {
      throw new SandboxManagerError("archive_failed", `沙箱 ${sandboxId} 的产出还没归档成功，暂不销毁`, {
        sandboxId,
        step: archive.failedStep,
        reason,
      });
    }

    // ② 物理销毁。provider 报 not_found = 已经没了，这不是失败。
    try {
      await this.#provider.destroy(sandboxId);
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : asProviderError(error, "destroy");
      if (providerError.reason !== "not_found") {
        await this.#transitionOrLog(
          sandboxId,
          ["CREATING", "READY", "BUSY", "ERROR"],
          "ERROR",
          "destroy_failed",
        );
        throw providerError;
      }
    }

    // ③ 状态收尾。已是 DESTROYED 的行不重复写审计（幂等）。
    if (row.state === "DESTROYED") {
      this.#archiveFailures.delete(sandboxId);
      return { sandboxId, state: "DESTROYED", archive };
    }
    const moved = await transition(this.#db, sandboxId, ["CREATING", "READY", "BUSY", "ERROR"], "DESTROYED", reason, {
      destroyed_at: new Date(),
      // 强制销毁时把"产出没存上"这件事写进 state_reason：Run 结果（Phase 12）
      // 与事后排障都要靠它，光看 DESTROYED 是看不出来产出丢了的。
      ...(archive?.forced === true ? { state_reason: "archive_failed" } : {}),
    });
    this.#archiveFailures.delete(sandboxId);
    if (!moved.ok) {
      const current = currentStateOf(moved);
      this.#log("warn", `沙箱 ${sandboxId} 的 → DESTROYED 没有生效（当前 ${current}）`, { reason });
      return { sandboxId, state: current, archive };
    }
    return { sandboxId, state: "DESTROYED", archive };
  }

  /**
   * 销毁前的归档策略（spec Phase 10 §2 的那三条）。**只在 `artifacts` 设定存在时调用**。
   *
   * 状态机视角：
   *  - 第一次失败：`{CREATING,READY,BUSY} → ERROR(archive_failed)`，本轮不销毁。
   *    行已经是 ERROR 的（比如上一轮 destroy_failed）转不了 ERROR→ERROR，这时
   *    内存里的 `#archiveFailures` 就是宽限期的唯一依据（已在字段注释里说明）。
   *  - 宽限期内：直接返回 `allowDestroy:false`，**不重复跑三次**——60 秒后的下一轮
   *    再跑一遍相同重试只是把同一份错误刷屏，不会提高成功率。
   *  - 宽限期后：最后试一次（单次，不重试）。成功 → 正常销毁；仍失败 → 强制销毁，
   *    `forced=true` 会被写进 `state_reason` 与返回的报告。
   */
  async #archiveBeforeDestroy(row: SandboxRow, offloader: ArtifactOffloader): Promise<ArchiveOutcome> {
    const notAllowDestroy = (outcome: Omit<ArchiveOutcome, "allowDestroy">): ArchiveOutcome => ({
      ...outcome,
      allowDestroy: false,
    });

    if (row.state === "DESTROYED") {
      // 已经销毁过的行（幂等重试）没有"再归档一次"的道理：沙箱可能已经不在了。
      return { allowDestroy: true, archived: false, skipped: "already_destroyed", forced: false, failedStep: null, artifacts: [] };
    }

    const failedAt = this.#archiveFailures.get(row.id) ?? null;
    if (failedAt !== null) {
      const graceMs = this.#offload?.graceMs ?? ARCHIVE_GRACE_MS;
      const elapsedMs = (this.#offload?.now?.() ?? new Date()).getTime() - failedAt.getTime();
      if (elapsedMs < graceMs) {
        this.#log("info", `沙箱 ${row.id} 的产出尚未归档成功，宽限期内暂不销毁`, { elapsedMs, graceMs });
        return notAllowDestroy({ archived: false, skipped: null, forced: false, failedStep: "archive", artifacts: [] });
      }
      // 宽限到了：最后试一次。这一步**不再重试**——它本身就是"重试 3 次失败了"之后的那次。
      try {
        const report = await offloader.offload(row);
        this.#archiveFailures.delete(row.id);
        return {
          allowDestroy: true,
          archived: report.skipped === null,
          skipped: report.skipped,
          forced: false,
          failedStep: null,
          artifacts: report.artifacts,
        };
      } catch (error) {
        this.#archiveFailures.delete(row.id);
        const step = failedStepOf(error);
        this.#log("error", `沙箱 ${row.id} 宽限期后的最后一次归档仍然失败，强制销毁`, {
          step,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          allowDestroy: true,
          archived: false,
          skipped: null,
          forced: true,
          failedStep: step,
          artifacts: [],
        };
      }
    }

    try {
      const report = await offloader.offloadWithRetries(row, {
        ...(this.#offload?.attempts === undefined ? {} : { attempts: this.#offload.attempts }),
        ...(this.#offload?.backoffMs === undefined ? {} : { backoffMs: this.#offload.backoffMs }),
      });
      return {
        allowDestroy: true,
        archived: report.skipped === null,
        skipped: report.skipped,
        forced: false,
        failedStep: null,
        artifacts: report.artifacts,
      };
    } catch (error) {
      const step = failedStepOf(error);
      this.#archiveFailures.set(row.id, this.#offload?.now?.() ?? new Date());
      // 从 ERROR 出发没有 ERROR→ERROR 这条边，所以已经是 ERROR 的行这里会静默不生效
      // （只留一条 warn 日志）——宽限期仍然由上面的内存时间戳守着。
      await this.#transitionOrLog(row.id, ["CREATING", "READY", "BUSY"], "ERROR", "archive_failed");
      this.#log("error", `沙箱 ${row.id} 归档失败，标记 ERROR 并等待宽限期`, {
        step,
        error: error instanceof Error ? error.message : String(error),
      });
      return notAllowDestroy({ archived: false, skipped: null, forced: false, failedStep: step, artifacts: [] });
    }
  }
}

// ---------------------------------------------------------------- 校验与解析

/**
 * 校验并归一化 exec 请求。**不静默截断**：越界的 timeoutMs 直接拒
 * （调用方会以为自己拿到了 30 分钟，与 Phase 1 §4 那条规矩一致）。
 */
export function validateExecRequest(request: ExecInSandboxRequest): CleanExecRequest {
  const { cmd } = request;
  if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((item) => typeof item !== "string" || item.includes("\0"))) {
    throw new SandboxManagerError("invalid_request", "cmd 必须是非空字符串数组，且不能含 NUL", { field: "cmd" });
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_EXEC_TIMEOUT_MS) {
    throw new SandboxManagerError("invalid_request", `timeoutMs 必须在 1..${MAX_EXEC_TIMEOUT_MS} 之间`, {
      field: "timeoutMs",
      value: timeoutMs,
    });
  }
  if (request.cwd !== undefined && (typeof request.cwd !== "string" || request.cwd === "" || request.cwd.includes("\0"))) {
    throw new SandboxManagerError("invalid_request", "cwd 必须是非空字符串", { field: "cwd" });
  }
  const env = request.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      throw new SandboxManagerError("invalid_request", `env[${key}] 必须是字符串`, { field: "env" });
    }
  }
  if (request.maxOutputBytes !== undefined && (!Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0)) {
    throw new SandboxManagerError("invalid_request", "maxOutputBytes 必须是正整数", { field: "maxOutputBytes" });
  }

  return {
    cmd: [...cmd],
    cwd: request.cwd ?? null,
    env: { ...env },
    // **唯一**从 env 派生的东西：key 名。值不进 DB（§G.2）。
    envKeys: Object.keys(env).sort(),
    timeoutMs,
    maxOutputBytes: request.maxOutputBytes,
  };
}

/** `OffloadError` → 失败的环节；其他异常（网络、DB 写入）归到 `archive`。 */
function failedStepOf(error: unknown): OffloadStep {
  return error instanceof OffloadError ? error.step : "archive";
}

/** 从镜像引用里取出 digest 部分（`repo@sha256:…` → `sha256:…`；裸镜像 ID 原样）。 */
export function imageDigestOf(image: string): string {
  const at = image.indexOf("@");
  if (at >= 0) return image.slice(at + 1);
  return image;
}

/** 终态事件 → 结构化的执行结果。data 不是合法 JSON 时只保留事件名。 */
function parseTerminalEvent(event: SseEvent): TerminalInfo {
  const data = parseJson(event.data);
  const numberOr = (key: string): number | null => {
    const value = data[key];
    return typeof value === "number" ? value : null;
  };
  return {
    state: event.event as ExecutionState,
    exitCode: numberOr("exit_code"),
    signal: typeof data["signal"] === "string" ? data["signal"] : null,
    durationMs: numberOr("duration_ms"),
    stdoutBytes: numberOr("stdout_bytes") ?? 0,
    stderrBytes: numberOr("stderr_bytes") ?? 0,
    truncated: data["truncated"] === true,
    logTruncated: data["log_truncated"] === true,
    logPath: typeof data["log_path"] === "string" ? data["log_path"] : null,
    error: typeof data["error"] === "string" ? data["error"] : null,
  };
}

/** 终态事件的 reason 缺省值（agent 自己给的错误码优先，见 parseTerminalEvent）。 */
function watchdogReason(state: ExecutionState, killRequested: boolean): string | null {
  if (state === "timeout") return "agent_timeout";
  if (state === "killed") return killRequested ? "watchdog_timeout" : "killed";
  return null;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
