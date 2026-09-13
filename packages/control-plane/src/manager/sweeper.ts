/**
 * TTL 清扫：超时的沙箱先归档、再销毁（§D 超时表的最后一行 + Phase 8 §4 末段）。
 *
 * 【TTL 是安全兜底，不是调度器】§D 的原话。它的存在理由是"一个跑飞的 agent 不能
 * 无限占着容器"：到点无论什么状态都销毁，in-flight 的 exec 会在容器停掉时收到 killed。
 * 所以这个类不做任何"智能"判断——没有优先级、没有宽限、不看 CPU。
 *
 * 【归档必须成功才销毁】归档是任务的产出凭证（§G.3：沙箱销毁后卷就没了）。
 * `archive` 钩子抛异常时这一轮**跳过销毁**，下一轮（60s 后）重试——
 * "先删后归档"会永久丢掉那份产出，是本项目里最不能接受的一种失败。
 * Phase 8 不传这个钩子（归档是 Phase 10 的事），传了就用。
 *
 * 【Phase 10 之后这个钩子与生产路径的关系】生产的归档在 `SandboxManager.destroySandbox()`
 * 里（它能拿到 provider/agent 与重试策略，还带 10 分钟宽限期）。这个钩子是**更早的、
 * 更通用的钩子**：Phase 8 的测试用它验证"失败就跳过销毁"这条语义，将来若有不经过
 * manager 的销毁路径也可以用它。两边同时配会归档两次——目前没有这样的调用方，
 * 真出现时应该删掉一边，而不是让两套策略同时跑。
 *
 * 【只扫候选状态】DESTROYED 不在候选里（已经不需要销毁了）。ERROR 在：
 * 一个反复销毁失败的沙箱要靠下一轮 TTL 重试（这也是自愈的一部分）。
 *
 * 【Phase 2 起多了一步：先跑会话租约】会话持有的沙箱由租约回收（它会先落地再销毁），
 * 通用 TTL 这一轮看到的"会话沙箱"直接跳过。两者共用一个 60 秒定时器——
 * 两个定时器只会让"谁先跑"变成一个偶发的竞态。
 */

import type { Db } from "../db/client.ts";
import { listExpiredSandboxes } from "../db/sandboxes.ts";
import type { SandboxRow } from "../db/sandboxes.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { SandboxManager } from "./sandbox-manager.ts";
import type { LeaseReport } from "../session/sandbox-lease.ts";

/** 扫描间隔（§Phase 8 §4：每 60 秒扫一次）。 */
export const SWEEP_INTERVAL_MS = 60_000;

/** 缺省 TTL：6h（§D）。沙箱的 `limits.ttlSec` 优先，缺了才用这个。 */
export const DEFAULT_TTL_SEC = 21_600;

export interface SandboxSweeperOptions {
  db: Db;
  manager: SandboxManager;
  /** 缺省 TTL（秒）。默认 6h。 */
  defaultTtlSec?: number;
  /** 扫描间隔。默认 60s。 */
  intervalMs?: number;
  /** 一次最多处理几个（免得一轮扫太久）。默认 50。 */
  batchSize?: number;
  /** TTL 到点、销毁之前调用的钩子（可选）。抛异常 = 这一轮不销毁。生产归档见文件头。 */
  archive?: (sandbox: SandboxRow) => Promise<void>;
  /**
   * 会话级的沙箱租约（Phase 2）。**先跑它、再跑通用 TTL**：租约回收会先落地
   * （取 diff → apply → push）再销毁，而通用 TTL 不会。会话持有的沙箱在租约这一轮
   * 被看到时不进 TTL 的候选——否则就是把"先落地"这条规则绕过去。
   */
  sessionLease?: { reapIdle(): Promise<LeaseReport> };
  /** 可注入的时钟（测试用）。 */
  now?: () => Date;
  log?: LogFn;
}

export interface SweepReport {
  /** 这一轮看过多少个过期沙箱。 */
  scanned: number;
  archived: string[];
  destroyed: string[];
  failures: Array<{ sandboxId: string; message: string }>;
  /** 这一轮跳过的、由会话租约持有的沙箱（见 `sessionLease`）。 */
  skippedSessionOwned: string[];
  /** 租约那一轮的回收报告（配了才非空）。 */
  sessionLease: LeaseReport | null;
}

export class SandboxSweeper {
  readonly #db: Db;
  readonly #manager: SandboxManager;
  readonly #defaultTtlSec: number;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #archive: ((sandbox: SandboxRow) => Promise<void>) | undefined;
  readonly #sessionLease: { reapIdle(): Promise<LeaseReport> } | undefined;
  readonly #now: () => Date;
  readonly #log: LogFn;

  #timer: NodeJS.Timeout | null = null;

  constructor(options: SandboxSweeperOptions) {
    this.#db = options.db;
    this.#manager = options.manager;
    this.#defaultTtlSec = options.defaultTtlSec ?? DEFAULT_TTL_SEC;
    this.#intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
    this.#batchSize = options.batchSize ?? 50;
    this.#archive = options.archive;
    this.#sessionLease = options.sessionLease;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? noopLog;
  }

  /**
   * 跑一轮。**测试直接调它**（不必等 60 秒），生产由 `start()` 定时调。
   *
   * 单个沙箱的失败只记进报告：一轮里有一个归档失败，不该让其余过期的沙箱继续占着资源。
   */
  async sweepOnce(): Promise<SweepReport> {
    const report: SweepReport = {
      scanned: 0,
      archived: [],
      destroyed: [],
      failures: [],
      skippedSessionOwned: [],
      sessionLease: null,
    };

    // ① 会话租约先跑：它会把"真闲着的会话沙箱"落地 + 销毁，并交回本轮它看到的
    //    所有会话沙箱 id。这些 id 不进制 TTL 的候选（规则 3：必须先落地再销毁）。
    const held = new Set<string>();
    if (this.#sessionLease !== undefined) {
      try {
        const leaseReport = await this.#sessionLease.reapIdle();
        report.sessionLease = leaseReport;
        for (const sandboxId of leaseReport.heldSandboxIds) held.add(sandboxId);
      } catch (error) {
        // 租约那一轮整体失败不该弄死通用 TTL（它是安全兜底）。
        report.failures.push({ sandboxId: "-", message: `会话租约回收失败：${error instanceof Error ? error.message : String(error)}` });
        this.#log("error", "会话租约回收这一轮失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const expired = await listExpiredSandboxes(this.#db, {
      defaultTtlSec: this.#defaultTtlSec,
      now: this.#now(),
      limit: this.#batchSize,
    });
    report.scanned = expired.length;

    for (const sandbox of expired) {
      if (held.has(sandbox.id)) {
        report.skippedSessionOwned.push(sandbox.id);
        continue;
      }
      // ② 归档（Phase 10 才有实现）。失败 → 这一轮不销毁。
      if (this.#archive !== undefined) {
        try {
          await this.#archive(sandbox);
          report.archived.push(sandbox.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report.failures.push({ sandboxId: sandbox.id, message: `归档失败：${message}` });
          this.#log("error", `沙箱 ${sandbox.id} 归档失败，本轮不销毁`, { error: message });
          continue;
        }
      }
      // ③ 销毁 + 转 DESTROYED。manager 负责审计与幂等。
      try {
        await this.#manager.destroySandbox(sandbox.id, "ttl_expired");
        report.destroyed.push(sandbox.id);
        this.#log("info", `沙箱 ${sandbox.id} 因 TTL 过期被销毁`, {
          state: sandbox.state,
          lastActiveAt: sandbox.last_active_at,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.failures.push({ sandboxId: sandbox.id, message });
        this.#log("error", `沙箱 ${sandbox.id} 销毁失败`, { error: message });
      }
    }
    return report;
  }

  /** 起定时器。**重复调用是幂等的**（第二次什么都不做）。 */
  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.sweepOnce().catch((error: unknown) => {
        this.#log("error", "TTL 清扫这一轮整体失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.#intervalMs);
    // unref：清扫定时器不该成为"进程为什么还活着"的答案（与 Phase 1 的定时器同一条规矩）。
    this.#timer.unref();
    this.#log("info", `TTL 清扫已启动`, { intervalMs: this.#intervalMs, defaultTtlSec: this.#defaultTtlSec });
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 定时器在不在跑（测试与运维看一眼用）。 */
  get running(): boolean {
    return this.#timer !== null;
  }
}
