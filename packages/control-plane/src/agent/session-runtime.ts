/**
 * `session-runtime.ts` —— 多轮对话的两个入口（Phase 1 §8；设计文档 §A.1）。
 *
 * ```
 * handleUserMessage(sessionId, text)   // 用户发来一句话 → 开一次执行（Run）
 * steer(runId, message)                // 一句还在处理中，用户插话 → 注入当前执行
 * ```
 *
 * 【为什么这两个入口必须在 P1 就定下】它们是"多轮对话"与"中途插话"两个不同场景的接口。
 * 合成一个（"每来一句话就开一次执行"）会让历史与成本失控：讨论二十句需求就会留下二十次
 * 执行记录、二十份上下文；而"插话"应该是往**当前这一次**执行里塞一条消息，不打断正在
 * 跑的工具（设计文档 §A.1 的表）。
 *
 * 【锁在 P2 换成了端口】P1 是一个 `Map<sessionId, ActiveRun>`（单进程有效）；
 * P2 把它抽成 `SessionLock` 端口：缺省的内存实现保留（单测、本地单实例），
 * 生产传 `PostgresSessionLock`（`UPDATE sessions SET active_run_id = $runId
 * WHERE id = $id AND active_run_id IS NULL`：抢不到就是 `session_busy`，**不排队**——排队是 M3）。
 * 换的是锁的实现，`handleUserMessage` / `steer` 的接口与语义一个字没变。
 *
 * 【这里为什么不知道沙箱】沙箱是"会话的工作区"，**用到才建**（设计文档 §A.1）：
 * 用户可能先讨论二十句，那一句都不该建容器。所以这个文件里没有 `acquireSandbox`——
 * 建沙箱的时机在工具层第一次真的要读/写/跑命令时（P2 的 `sandbox-lease.ts`）。
 * 一个只说话的执行（模型只回文字）从头到尾都不会碰它。
 *
 * 【"跑"由调用方注入】`start` 是一个函数：生产环境里它建工具、调 `runAgentLoop`；
 * 测试里它是一个脚本。这让"锁 / 插话队列 / 不建沙箱"这三件事可以在**没有 Docker、
 * 没有模型**的情况下被完整验证——它们才是不变量，具体跑什么不是。
 */

import type { AgentMessage, Usage } from "@reuben-cloud/agent-runtime";
import { emptyUsage } from "@reuben-cloud/agent-runtime";
import { prefixedId } from "../ulid.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

// ---------------------------------------------------------------- 插话队列

/**
 * 一次执行的插话队列。**只有进出两个动作**：
 * 循环在每个合适的时机调 `drain()`（每轮工具跑完、下一轮模型调用之前），
 * `steer()` 往里面 `push()`。队列本身不关心消息是什么。
 */
export interface SteeringQueue {
  push(message: AgentMessage): void;
  /** 取走当前排队的全部消息（循环会逐条注入）。 */
  drain(): AgentMessage[];
  readonly size: number;
}

/** 建一个插话队列（`drain()` 之后队列就空了：消息要么被注入要么不存在）。 */
export function createSteeringQueue(): SteeringQueue {
  let pending: AgentMessage[] = [];
  return {
    push(message) {
      pending.push(message);
    },
    drain() {
      const drained = pending;
      pending = [];
      return drained;
    },
    get size() {
      return pending.length;
    },
  };
}

// ---------------------------------------------------------------- 类型

/** 一次执行的终态（与 `AgentLoopResult` 的公共字段一致；这里不依赖 CP 的 run.ts，避免循环 import）。 */
export interface RunOutcome {
  ok: boolean;
  stopReason: string;
  detail: string;
  turns: number;
  toolCalls: number;
  usage: Usage;
}

/** 起一次执行时要交给"跑"的东西。**没有沙箱字段**——建不建由工具层决定（见文件头）。 */
export interface SessionRunStartInput {
  runId: string;
  sessionId: string;
  /** 用户这一句话的原文。 */
  text: string;
  /** 插话队列：循环的 `getSteeringMessages` 从这里取。 */
  steering: SteeringQueue;
  /** 取消这一次执行（P1 还没人调它；P2 的会话关闭会调）。 */
  signal: AbortSignal;
}

/** `handleUserMessage` 的返回值：runId 立即可用（可以拿它去 `steer`），结果在 result 上。 */
export interface UserMessageHandle {
  runId: string;
  result: Promise<RunOutcome>;
}

/** 同一个会话同时来了两句话：**直接拒绝**（不是排队，也不能静默串行）。 */
export class SessionBusyError extends Error {
  readonly code = "session_busy";
  readonly sessionId: string;
  readonly activeRunId: string;

  constructor(sessionId: string, activeRunId: string) {
    super(`会话 ${sessionId} 正在处理 ${activeRunId}，这一句被拒绝（同一个会话同时只有一次执行）`);
    this.name = "SessionBusyError";
    this.sessionId = sessionId;
    this.activeRunId = activeRunId;
  }
}

export interface SessionRuntimeOptions {
  /**
   * 怎么跑一次执行。生产 = 建沙箱工具 + `runAgentLoop`；测试 = 脚本。
   * 契约：不抛异常时返回终态；抛异常时这一句算失败（锁照样释放）。
   */
  start(input: SessionRunStartInput): Promise<RunOutcome>;
  /** 生成 runId（测试给确定值）。 */
  newRunId?: () => string;
  /**
   * 会话锁。缺省是内存实现（单进程）；生产给 PG 的条件更新
   * （`UPDATE sessions SET active_run_id = $runId WHERE id = $id AND active_run_id IS NULL`）。
   * 接口不变、换的是锁的实现——这是 P1 对 P2 的承诺（spec P1 §8）。
   */
  lock?: SessionLock;
  log?: LogFn;
}

/** 抢锁的结果。抢不到时把**当前持有者**带回来（日志与 409 正文都要它）。 */
export type SessionLockResult = { ok: true } | { ok: false; activeRunId: string | null };

/**
 * 会话锁的端口。**只有进出两个动作**，因为它背后可能是内存 Map（单进程测试）、
 * 也可能是一条 SQL（生产）。把"怎么抢"和"抢什么"分开，编排层就不知道 DB 的存在。
 */
export interface SessionLock {
  acquire(sessionId: string, runId: string): Promise<SessionLockResult>;
  release(sessionId: string, runId: string): Promise<void>;
}

/** 内存锁：单进程有效（P1 的行为，单测与本地单实例用它）。 */
export function createMemorySessionLock(): SessionLock {
  const held = new Map<string, string>();
  return {
    async acquire(sessionId, runId) {
      const current = held.get(sessionId) ?? null;
      if (current !== null) return { ok: false, activeRunId: current };
      held.set(sessionId, runId);
      return { ok: true };
    },
    async release(sessionId, runId) {
      if (held.get(sessionId) === runId) held.delete(sessionId);
    },
  };
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  steering: SteeringQueue;
  controller: AbortController;
}

// ---------------------------------------------------------------- 会话运行时

/**
 * 会话的执行协调器。**一个进程一个实例**（P1 的内存锁；P2 换 PG 条件更新）。
 * `SessionStore`（会话历史）是 P2 的事——P1 这里只管"谁在跑、能不能插话"。
 */
export class SessionRuntime {
  readonly #options: SessionRuntimeOptions;
  readonly #log: LogFn;
  readonly #newRunId: () => string;
  readonly #lock: SessionLock;
  /** sessionId → 正在跑的执行。 */
  readonly #bySession = new Map<string, ActiveRun>();
  /** runId → 正在跑的执行（`steer` 按它查）。 */
  readonly #byRun = new Map<string, ActiveRun>();

  constructor(options: SessionRuntimeOptions) {
    this.#options = options;
    this.#log = options.log ?? noopLog;
    this.#newRunId = options.newRunId ?? (() => prefixedId("run_"));
    this.#lock = options.lock ?? createMemorySessionLock();
  }

  /**
   * 用户发来一句话。
   *
   * @returns `{ runId, result }`：`runId` 立即可用（可以接着 `steer`），`result` 是终态。
   * @throws `SessionBusyError` 这个会话已经有一次执行在跑（P2 会换成 PG 的条件更新）。
   */
  async handleUserMessage(sessionId: string, text: string): Promise<UserMessageHandle> {
    const runId = this.#newRunId();
    // 抢锁。生产是 PG 的条件更新（跨进程也有效）；抢不到 → 明确拒绝，**不排队**（排队是 M3）。
    const acquired = await this.#lock.acquire(sessionId, runId);
    if (!acquired.ok) {
      const holder = acquired.activeRunId ?? this.#bySession.get(sessionId)?.runId ?? null;
      this.#log("warn", "会话正忙，拒绝这一句", { sessionId, activeRunId: holder });
      throw new SessionBusyError(sessionId, holder ?? "未知");
    }

    const steering = createSteeringQueue();
    const controller = new AbortController();
    const run: ActiveRun = { runId, sessionId, steering, controller };
    this.#bySession.set(sessionId, run);
    this.#byRun.set(runId, run);
    this.#log("info", "开始一次执行", { sessionId, runId });

    const result = this.#run(run, text);
    return { runId, result };
  }

  /**
   * 往一次正在跑的执行里插话。**不新开执行、不打断当前工具**：消息进队列，
   * 循环在"这一轮工具跑完、下一轮模型调用之前"取走它（设计文档 §A.1）。
   *
   * @returns 消息有没有被投递（执行已经结束就是 false）。
   */
  steer(runId: string, message: string): boolean {
    const active = this.#byRun.get(runId);
    if (active === undefined) return false;
    active.steering.push({ role: "user", content: message });
    this.#log("info", "用户插话已入队", { sessionId: active.sessionId, runId, pending: active.steering.size });
    return true;
  }

  /** 这个会话当前在跑哪个执行（没有就是 null）。 */
  activeRunId(sessionId: string): string | null {
    return this.#bySession.get(sessionId)?.runId ?? null;
  }

  /** 会话忙不忙（HTTP 层用它决定要不要回 409）。 */
  isBusy(sessionId: string): boolean {
    return this.#bySession.has(sessionId);
  }

  /** 跑一次执行并保证**无论如何**释放锁。 */
  async #run(run: ActiveRun, text: string): Promise<RunOutcome> {
    try {
      return await this.#options.start({
        runId: run.runId,
        sessionId: run.sessionId,
        text,
        steering: run.steering,
        signal: run.controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#log("error", "执行失败（锁已释放）", { runId: run.runId, error: message });
      return {
        ok: false,
        stopReason: "run_error",
        detail: message,
        turns: 0,
        toolCalls: 0,
        usage: emptyUsage(),
      };
    } finally {
      // 只清掉"还是这一次"的条目（PG 版本靠 active_run_id = runId 的条件更新）。
      if (this.#bySession.get(run.sessionId)?.runId === run.runId) this.#bySession.delete(run.sessionId);
      if (this.#byRun.get(run.runId)?.runId === run.runId) this.#byRun.delete(run.runId);
      // 锁的释放必须在**所有**路径上发生（异常、abort、正常收工）。
      await this.#lock.release(run.sessionId, run.runId).catch((error: unknown) => {
        this.#log("error", "会话锁释放失败（会由 TTL / 人工清掉）", {
          sessionId: run.sessionId,
          runId: run.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      this.#log("info", "执行结束，会话锁已释放", { sessionId: run.sessionId, runId: run.runId });
    }
  }
}
