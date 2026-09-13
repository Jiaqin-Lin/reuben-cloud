/**
 * `session/sandbox-lease.ts` —— 会话级的沙箱租约（Phase 2 §6；设计文档 §A.1）。
 *
 * 【一句话】沙箱不是"一次执行一个"，而是**会话的工作区**：
 *  · 按需创建——第一次真的要读/写/跑命令时才建（讨论二十句需求 = 0 个容器）；
 *  · 热着复用——会话还活跃时，后面几十句都用这一个；
 *  · 空闲回收——沉默超过 TTL 就"落地 + 销毁"，下次要用再建。
 *
 * 【两道时间闸，语义不同（设计文档 §A.1 的表格）】
 *  · 空闲 TTL（默认 30 分钟）：**滑动窗口**，任何动作都把倒计时归零。只在真闲时生效。
 *  · 容器寿命（默认 6 小时）：**固定**，从创建那一刻算。到点在干活就等它干完（+30 分钟宽限），
 *    换容器不砍任务。
 *
 * 【三条硬规则（spec P2 §6 原话）】
 *  ① 一个会话同时只有一次执行在跑（靠 `sessions.active_run_id`）——回收时见 `active_run_id`
 *     非空就跳过；
 *  ② 空闲 TTL 从**最后一次活动**算，续时是自动的（用户发言 / 模型调用 / 工具调用都续时）；
 *  ③ **回收前必须落地**：flush 失败 → 不销毁，标 `flush_failed`，下个周期重试；
 *     连续 3 次仍失败 → 走 M0 Phase 10 的 archive 兜底（它自带"归档失败不销毁"）。
 *
 * 【为什么这些策略不写进 SandboxManager】manager 管的是"一台容器的一生"（状态机 + 看门狗），
 * 租约管的是"会话与容器之间的归属"。把 TTL 塞进 manager 会让"谁在等这台容器"这个问题
 * 没有答案——而这正是 §A.1 里最容易设计错的那一点。
 *
 * 【acquire 在 flush 失败时为什么仍然复用旧沙箱】这不是妥协，是选择：flush 失败意味着
 * 改动还在容器里、还没进分支；此时销毁或新建都会**丢掉用户的活**。旧的还在、workspace
 * 还有效，继续用它是对的——失败标记只影响"下一次回收再试"。
 */

import type { SessionStore, StoredSession } from "@reuben-cloud/agent-runtime";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

// ---------------------------------------------------------------- 常量与配置

/** 空闲 TTL（30 分钟）。任何动作都会把倒计时重置。 */
export const DEFAULT_IDLE_TTL_MS = 30 * 60_000;

/** 容器寿命（6 小时）：到点是**换容器**，不是砍任务。 */
export const DEFAULT_MAX_LIFETIME_MS = 6 * 60 * 60_000;

/** 寿命到点又在干活时的宽限（30 分钟 = 单次执行自己的墙钟上限）。宽限后强杀。 */
export const DEFAULT_MAX_LIFETIME_GRACE_MS = 30 * 60_000;

/** 连续几次落地失败后走 archive 兜底。 */
export const DEFAULT_FLUSH_RETRY_LIMIT = 3;

export interface LeaseSettings {
  idleTtlMs: number;
  maxLifetimeMs: number;
  maxLifetimeGraceMs: number;
  flushRetryLimit: number;
}

/** 从 env 读配置（`REUBEN_CLOUD_SESSION_*` / `REUBEN_CLOUD_SANDBOX_MAX_LIFETIME_MS`）。 */
export function leaseSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): LeaseSettings {
  return {
    idleTtlMs: positiveInt(env["REUBEN_CLOUD_SESSION_IDLE_TTL_MS"], DEFAULT_IDLE_TTL_MS),
    maxLifetimeMs: positiveInt(env["REUBEN_CLOUD_SANDBOX_MAX_LIFETIME_MS"], DEFAULT_MAX_LIFETIME_MS),
    maxLifetimeGraceMs: positiveInt(env["REUBEN_CLOUD_SANDBOX_MAX_LIFETIME_GRACE_MS"], DEFAULT_MAX_LIFETIME_GRACE_MS),
    flushRetryLimit: positiveInt(env["REUBEN_CLOUD_SESSION_FLUSH_RETRIES"], DEFAULT_FLUSH_RETRY_LIMIT),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// ---------------------------------------------------------------- 端口

/** 沙箱在 DB 里的样子（租约判断"还能不能用"要的全部字段）。 */
export interface LeaseSandboxInfo {
  sandboxId: string;
  state: string;
  endpoint: string | null;
  authToken: string | null;
  createdAt: Date;
  lastActiveAt: Date;
}

/** 建沙箱 + 灌仓库的入口（生产 = manager.createSandbox + clone + inject；测试 = 假的）。 */
export interface SandboxProvisionRequest {
  session: StoredSession;
  /** 哪一次执行触发了这次创建。 */
  runId: string;
  /** 当前 env revision 的镜像 digest。 */
  image: string;
  /** 仓库起点：`head_commit ?? base_commit`（热着的时候不需要它）。 */
  startCommit: string;
  /** 工作分支（推上去用的那条）。 */
  headRef: string | null;
}

export interface ProvisionedSandbox {
  sandboxId: string;
  endpoint: string;
  authToken: string;
}

/** 落地（flush）：取 diff → apply → push。实现在 CP 的 repo 层（见 §7 的说明）。 */
export interface FlushRequest {
  session: StoredSession;
  sandboxId: string;
  endpoint: string;
  authToken: string;
  /** `cold`：工具层要用沙箱时发现旧的那台已经不能用（过期/失效），先落地再重建。 */
  reason: "idle" | "rotate" | "release" | "session_end" | "cold";
}

export interface FlushResult {
  /** 有没有改动（没有改动时不推、不产生空 commit）。 */
  changed: boolean;
  /** 落地后分支的 head commit（没有改动就是 null）。 */
  headCommit: string | null;
  /** 落地的分支（没有改动就是 null）。 */
  headRef: string | null;
}

export interface LeaseSandboxPort {
  /** **幂等**销毁（含归档）。 */
  destroy(sandboxId: string, reason: string): Promise<void>;
  /** 读一台沙箱（不存在给 null）。 */
  get(sandboxId: string): Promise<LeaseSandboxInfo | null>;
}

export interface SandboxLeaseOptions {
  store: SessionStore;
  sandboxes: LeaseSandboxPort;
  provision: (request: SandboxProvisionRequest) => Promise<ProvisionedSandbox>;
  flush: (request: FlushRequest) => Promise<FlushResult>;
  /** 镜像（当前 env revision 的 digest）。可以给函数（P7 之后要看 revision）。 */
  image: () => string | Promise<string>;
  /** 连续落地失败后的兜底：归档再销毁（M0 Phase 10 的路径）。不给 = 直接销毁并记 error。 */
  archiveAndDestroy?: (session: StoredSession, sandboxId: string, reason: string) => Promise<void>;
  settings?: Partial<LeaseSettings>;
  now?: () => Date;
  log?: LogFn;
}

export interface LeaseReport {
  /** 看过的"有沙箱的会话"数。 */
  scanned: number;
  /** 真闲、被落地回收的会话。 */
  reaped: string[];
  /** 寿命到点、被换容器的会话。 */
  rotated: string[];
  /** 明确跳过（正在跑 / 有在跑的命令 / 落地失败暂不销毁）。 */
  skipped: Array<{ sessionId: string; reason: string }>;
  failures: Array<{ sessionId: string; message: string }>;
  /**
   * 本轮看到的**会话持有的沙箱 id**（不管回收没回收）。
   * TTL 清扫器拿它跳过这些行：会话的沙箱归租约管，而租约会先落地再销毁；
   * 让通用 TTL 抢在前面销毁会跳过落地（spec P2 §6 规则 3）。
   */
  heldSandboxIds: string[];
}

/** 落地失败（还没到兜底阈值）。调用方（sweeper / acquire）按它的存在决定要不要记一条。 */
export class LeaseFlushError extends Error {
  readonly sessionId: string;
  readonly sandboxId: string;
  readonly attempts: number;

  constructor(sessionId: string, sandboxId: string, attempts: number, cause: unknown) {
    super(`会话 ${sessionId} 的改动落地失败（第 ${attempts} 次）：${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "LeaseFlushError";
    this.sessionId = sessionId;
    this.sandboxId = sandboxId;
    this.attempts = attempts;
  }
}

// ---------------------------------------------------------------- 租约

/**
 * 会话级沙箱租约。**一个进程一个实例**（回收循环在进程内，与 sweeper 同一个定时器）。
 */
export class SandboxLease {
  readonly #store: SessionStore;
  readonly #sandboxes: LeaseSandboxPort;
  readonly #provision: (request: SandboxProvisionRequest) => Promise<ProvisionedSandbox>;
  readonly #flush: (request: FlushRequest) => Promise<FlushResult>;
  readonly #image: () => string | Promise<string>;
  readonly #archiveAndDestroy: ((session: StoredSession, sandboxId: string, reason: string) => Promise<void>) | null;
  readonly #settings: LeaseSettings;
  readonly #now: () => Date;
  readonly #log: LogFn;

  constructor(options: SandboxLeaseOptions) {
    this.#store = options.store;
    this.#sandboxes = options.sandboxes;
    this.#provision = options.provision;
    this.#flush = options.flush;
    this.#image = options.image;
    this.#archiveAndDestroy = options.archiveAndDestroy ?? null;
    this.#settings = {
      idleTtlMs: options.settings?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
      maxLifetimeMs: options.settings?.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS,
      maxLifetimeGraceMs: options.settings?.maxLifetimeGraceMs ?? DEFAULT_MAX_LIFETIME_GRACE_MS,
      flushRetryLimit: options.settings?.flushRetryLimit ?? DEFAULT_FLUSH_RETRY_LIMIT,
    };
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? noopLog;
  }

  /**
   * 工具层第一次要用沙箱时调它。**这是"按需建"的唯一入口**——
   * 讨论型的一句从头到尾都不会碰它（spec 测试要点 10 的"20 句纯讨论 → 0 个容器"）。
   *
   * 三条路径：
   *  ① 热着且没超两道闸 → 续时后直接返回（不重建）；
   *  ② 沙箱已经不在了 / 进了终态 → 清掉引用，建一台新的；
   *  ③ 还活着但过了空闲 TTL 或寿命 → 先落地再销毁，然后建新的；
   *     落地失败 → **复用旧的**（见文件头：差一次推送不应变成用户的活没了）。
   */
  async acquire(sessionId: string, options: { runId: string } = { runId: "unknown" }): Promise<ProvisionedSandbox> {
    const session = await this.#requireSession(sessionId);
    const now = this.#now();

    if (session.sandboxId !== null) {
      const info = await this.#sandboxes.get(session.sandboxId);
      if (info !== null && isUsable(info, session, now, this.#settings)) {
        await this.#store.touchSession(sessionId, now);
        return targetOf(info);
      }
      const retired = await this.#retire(session, info, now, "cold");
      if (retired === "kept") {
        // 落地失败：旧沙箱还活着、workspace 还有效——继续用它比新建一台（丢掉未落地的改动）好。
        const alive = await this.#sandboxes.get(session.sandboxId);
        if (alive !== null && alive.endpoint !== null && alive.authToken !== null) {
          await this.#store.touchSession(sessionId, now);
          return targetOf(alive);
        }
      }
    }

    const image = await this.#image();
    // provision = 建容器 + 灌仓库（两个动作分不开：一个只有空 workspace 的容器不是"工作区"）。
    const provisioned = await this.#provision({
      session,
      runId: options.runId,
      image,
      startCommit: session.headCommit ?? session.baseCommit,
      headRef: session.headRef,
    });
    await this.#store.setSessionSandbox(sessionId, {
      sandboxId: provisioned.sandboxId,
      at: now,
      flushFailures: 0,
      flushFailedAt: null,
    });
    this.#log("info", `会话 ${sessionId} 新建沙箱 ${provisioned.sandboxId}`, {
      image,
      startCommit: session.headCommit ?? session.baseCommit,
    });
    return provisioned;
  }

  /** 续时（工具层每次调用都会走 acquire，所以这里主要是给"模型调用"用的显式入口）。 */
  async touch(sessionId: string, at?: Date): Promise<void> {
    await this.#store.touchSession(sessionId, at ?? this.#now());
  }

  /**
   * 显式释放（会话结束 / 用户主动关）。与回收走同一条"先落地再销毁"的路径——
   * 少了这条，用户关会话时正在做的改动就永远留在容器里了。
   */
  async release(sessionId: string, reason: FlushRequest["reason"] = "release"): Promise<void> {
    const session = await this.#requireSession(sessionId);
    if (session.sandboxId === null) return;
    const info = await this.#sandboxes.get(session.sandboxId);
    await this.#retire(session, info, this.#now(), reason);
  }

  /**
   * 一轮回收（挂在 sweeper 的 60 秒定时器上；测试直接调它，不必等时钟）。
   *
   * 每一步都先问"现在真的闲着吗"：`active_run_id` 非空 → 跳过；沙箱 BUSY（有在跑的命令）
   * → 跳过。到点也不回收——只有真闲着才动。这是"一句话跑 50 分钟不会被砍"的实现。
   */
  async reapIdle(): Promise<LeaseReport> {
    const report: LeaseReport = { scanned: 0, reaped: [], rotated: [], skipped: [], failures: [], heldSandboxIds: [] };
    const now = this.#now();
    const sessions = await this.#store.listSessions({ limit: 500 });
    for (const session of sessions) {
      if (session.sandboxId === null) continue;
      report.scanned += 1;
      report.heldSandboxIds.push(session.sandboxId);
      if (session.activeRunId !== null) {
        report.skipped.push({ sessionId: session.id, reason: "active_run" });
        continue;
      }
      const info = await this.#sandboxes.get(session.sandboxId);
      if (info === null) {
        // 容器没了（硬崩 / 手工删掉）：引用清掉，下次工具调用会重建。
        await this.#store.setSessionSandbox(session.id, { sandboxId: null, flushFailures: 0, flushFailedAt: null });
        report.skipped.push({ sessionId: session.id, reason: "sandbox_missing" });
        continue;
      }
      if (info.state === "BUSY") {
        // 有命令在跑：绝不回收（连"续时"都不做——命令结束时的 exec 会自己刷新 last_active_at）。
        // **唯一的例外是真卡死**：超过总寿命再加宽限仍没结束 → 强制回收（设计文档 §A.1 的第三行）。
        const hardDeadline = info.createdAt.getTime() + this.#settings.maxLifetimeMs + this.#settings.maxLifetimeGraceMs;
        if (now.getTime() <= hardDeadline) {
          report.skipped.push({ sessionId: session.id, reason: "exec_in_flight" });
          continue;
        }
        const forced = await this.#retire(session, info, now, "rotate", "hard_lifetime", { force: true });
        if (forced === "kept") report.skipped.push({ sessionId: session.id, reason: "flush_failed" });
        else report.rotated.push(session.id);
        continue;
      }
      // 寿命先看：到点了要换容器（flush + destroy），即使它刚刚还在被用。
      if (lifetimeExpired(info, now, this.#settings)) {
        const outcome = await this.#retire(session, info, now, "rotate", "max_lifetime");
        if (outcome === "retired" || outcome === "forced") report.rotated.push(session.id);
        else report.skipped.push({ sessionId: session.id, reason: "flush_failed" });
        continue;
      }
      if (idleExpired(info, session, now, this.#settings)) {
        const outcome = await this.#retire(session, info, now, "idle");
        if (outcome === "retired") report.reaped.push(session.id);
        else report.skipped.push({ sessionId: session.id, reason: "flush_failed" });
      }
    }
    return report;
  }

  /** 会话当前挂着的沙箱（测试与排障用）。 */
  async currentSandboxId(sessionId: string): Promise<string | null> {
    const session = await this.#store.getSession(sessionId);
    return session?.sandboxId ?? null;
  }

  // -------------------------------------------------------------- 内部

  /**
   * 落地 + 销毁 + 清引用。**四种结果**：
   *  · `retired`——正常完成（或沙箱已经不在，没什么可落地）；
   *  · `kept`——落地失败，**沙箱不销毁**（引用被保留，下一轮重试）；
   *  · `forced`——连续失败到阈值，走了 archive 兜底后仍然销毁了；
   *  · `retired`（`force` 时）——跳过 flush 直接走 archive 兜底（卡死兜底专用）。
   */
  async #retire(
    session: StoredSession,
    info: LeaseSandboxInfo | null,
    now: Date,
    reason: FlushRequest["reason"],
    destroyReason: string = reason,
    options: { force?: boolean } = {},
  ): Promise<"retired" | "kept" | "forced"> {
    const sandboxId = session.sandboxId;
    if (sandboxId === null) return "retired";

    // 沙箱已经不在 / 进了终态：没有可落地的改动，直接清引用。
    if (info === null || info.state === "DESTROYED" || info.state === "ERROR") {
      await this.#store.setSessionSandbox(session.id, { sandboxId: null, flushFailures: 0, flushFailedAt: null });
      if (info !== null && info.state !== "DESTROYED") {
        // ERROR 的沙箱不该留着占资源；销毁失败也只是一条日志（TTL 会兜底）。
        await this.#safeDestroy(sandboxId, "lease_error_state");
      }
      return "retired";
    }

    if (info.endpoint === null || info.authToken === null) {
      // 没有 endpoint 就没法落地（也不可能有改动——创建还没成功过）。清引用即可。
      await this.#store.setSessionSandbox(session.id, { sandboxId: null, flushFailures: 0, flushFailedAt: null });
      return "retired";
    }

    // 【卡死兜底】flush 需要沙箱还能响应；对一个已经挂住的 exec，它只会再挂一次。
    // 直接走 archive（那是 M0 Phase 10 的数据保底路径）再销毁——这条是给跑飞的进程准备的。
    if (options.force === true) {
      this.#log("warn", `会话 ${session.id} 的沙箱超过总寿命 + 宽限仍在干活，强制回收`, { sandboxId });
      await this.#safeArchiveAndDestroy(session, sandboxId, destroyReason);
      await this.#store.setSessionSandbox(session.id, { sandboxId: null, flushFailures: 0, flushFailedAt: null });
      return "retired";
    }

    try {
      const result = await this.#flush({
        session,
        sandboxId,
        endpoint: info.endpoint,
        authToken: info.authToken,
        reason,
      });
      if (result.changed && result.headCommit !== null) {
        await this.#store.updateSessionHead(session.id, {
          headCommit: result.headCommit,
          ...(result.headRef === null ? {} : { headRef: result.headRef }),
        });
      }
      await this.#safeDestroy(sandboxId, destroyReason);
      await this.#store.setSessionSandbox(session.id, { sandboxId: null, flushFailures: 0, flushFailedAt: null });
      this.#log("info", `会话 ${session.id} 的沙箱已落地并销毁`, {
        sandboxId,
        reason: destroyReason,
        changed: result.changed,
        headCommit: result.headCommit,
      });
      return "retired";
    } catch (error) {
      const attempts = session.sandboxFlushFailures + 1;
      const firstFailureAt = session.sandboxFlushFailedAt ?? now;
      await this.#store.setSessionSandbox(session.id, {
        flushFailures: attempts,
        flushFailedAt: firstFailureAt,
      });
      this.#log("error", `会话 ${session.id} 的改动落地失败（第 ${attempts} 次，沙箱**不销毁**）`, {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempts < this.#settings.flushRetryLimit) return "kept";

      // 兜底：M0 Phase 10 的 archive 路径（归档失败它自己会拒绝销毁）。
      await this.#safeArchiveAndDestroy(session, sandboxId, "flush_failed");
      await this.#store.setSessionSandbox(session.id, { sandboxId: null, flushFailures: 0, flushFailedAt: null });
      return "forced";
    }
  }

  /** 销毁的 best-effort 包装：失败只记日志（TTL 会兜底，不该让回收循环整体挂掉）。 */
  async #safeDestroy(sandboxId: string, reason: string): Promise<void> {
    try {
      await this.#sandboxes.destroy(sandboxId, reason);
    } catch (error) {
      this.#log("warn", `销毁沙箱 ${sandboxId} 失败（留给 TTL 兜底）`, {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #safeArchiveAndDestroy(session: StoredSession, sandboxId: string, reason: string): Promise<void> {
    if (this.#archiveAndDestroy !== null) {
      try {
        await this.#archiveAndDestroy(session, sandboxId, reason);
        return;
      } catch (error) {
        this.#log("error", `会话 ${session.id} 的归档兜底也失败了，仍然销毁`, {
          sandboxId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.#safeDestroy(sandboxId, reason);
  }

  async #requireSession(sessionId: string): Promise<StoredSession> {
    const session = await this.#store.getSession(sessionId);
    if (session === null) throw new Error(`会话不存在：${sessionId}`);
    return session;
  }
}

// ---------------------------------------------------------------- 判定（纯函数，测试直接覆盖）

/**
 * 热着的沙箱还能不能直接用。
 *
 * 【BUSY 为什么算"能用"】它意味着沙箱里正在跑命令（多半就是我们这次执行自己的工具）。
 * 这时候谈 TTL 没有意义——"正在用"就是最活跃的状态。真正的并发保护在 manager 的
 * READY→BUSY 转换上（同一时刻只有一条命令）。
 */
export function isUsable(info: LeaseSandboxInfo, session: StoredSession, now: Date, settings: LeaseSettings): boolean {
  if (info.state === "BUSY") return true;
  if (info.state !== "READY") return false;
  if (info.endpoint === null || info.authToken === null) return false;
  if (lifetimeExpired(info, now, settings)) return false;
  return !idleExpired(info, session, now, settings);
}

/** 空闲判定：**从 `sandbox_last_used_at`（会话上的续时字段）算**，不是从容器创建算。 */
export function idleExpired(info: LeaseSandboxInfo, session: StoredSession, now: Date, settings: LeaseSettings): boolean {
  const lastUsed = session.sandboxLastUsedAt ?? info.lastActiveAt;
  return now.getTime() - lastUsed.getTime() > settings.idleTtlMs;
}

/** 寿命判定：从容器创建算，固定，不续时。 */
export function lifetimeExpired(info: LeaseSandboxInfo, now: Date, settings: LeaseSettings): boolean {
  return now.getTime() - info.createdAt.getTime() > settings.maxLifetimeMs;
}

function targetOf(info: LeaseSandboxInfo): ProvisionedSandbox {
  if (info.endpoint === null || info.authToken === null) {
    throw new Error(`沙箱 ${info.sandboxId} 没有 endpoint/token，不能用`);
  }
  return { sandboxId: info.sandboxId, endpoint: info.endpoint, authToken: info.authToken };
}
