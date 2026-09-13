/**
 * 启动对账：把 DB 里的状态和真实世界对齐（§D「CP 重启后的对账」+ Phase 8 §5）。
 *
 * 【为什么必须有它】CP 是单进程、无状态的决策方；它可以随时被杀掉重启。重启之后
 * 内存里的东西全没了，而真实世界还在：容器可能还在跑、可能已经没了、可能正跑着一条
 * 上一个进程留下的命令。DB 是唯一的记忆，对账就是"把记忆和现实对一遍"。
 *
 * 【四条规则，全部走 transition()】
 *  1. 容器不在 → `ERROR(container_lost)`
 *  2. 容器在但没在跑 / agent 报 error → `ERROR(container_exited / agent_error)`
 *  3. BUSY 且 agent 报 `activeExecution` 非空 → **最麻烦的一种**：一条执行在跑，
 *     而它的 SSE 消费者已经不在了。做法是 kill 掉、补一条 `killed/cp_restart` 的
 *     执行记录、再转 READY。保守但诚实——总比留下一个没人看、结果也拿不到的执行好。
 *  4. 其余（CREATING/READY/BUSY 而 agent 空闲）→ READY
 *
 * 【孤儿容器】`provider.listManaged()` 里 DB 没有记录的容器直接删：它们多半是上次
 * CP 崩在 create 中途留下的。DB 里 DESTROYED 但容器还在的也走同一条路。
 *
 * 【幂等且可重入】这是硬要求（用例 7）：第二次跑不能产生任何状态变化。
 * 做法是"只在状态真的需要变时才 transition"——READY 且一切正常的行会被跳过，
 * 所以第二次跑既不写审计行也不写 UPDATE。
 */

import { SandboxApiError, SandboxApiClient } from "../client/sandbox-api.ts";
import type { Db } from "../db/client.ts";
import { recordExecution } from "../db/executions.ts";
import { currentStateOf, getSandbox, listSandboxes, transition } from "../db/sandboxes.ts";
import type { SandboxRow, SandboxState } from "../db/sandboxes.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { ProviderError } from "../provider/types.ts";
import type { SandboxProvider } from "../provider/types.ts";

/** 需要被对账的状态：DESTROYED / ERROR 的行已经"落定"了，不再由启动对账动它们。 */
export const RECONCILE_STATES: readonly SandboxState[] = ["CREATING", "READY", "BUSY"];

/** 一次扫描的行数上限。见 `scanLimit` 的说明：被截断时**必须**在报告里说出来。 */
const SCAN_LIMIT = 1000;

export interface ReconcileOptions {
  db: Db;
  provider: SandboxProvider;
  api?: SandboxApiClient;
  log?: LogFn;
}

export interface ReconcileTransition {
  sandboxId: string;
  from: SandboxState;
  to: SandboxState;
  reason: string;
}

export interface ReconcileReport {
  /** 扫了多少行（CREATING/READY/BUSY）。 */
  scanned: number;
  /** 真的发生了的状态变化。第二次跑应该是空的（幂等）。 */
  transitions: ReconcileTransition[];
  /** 因为"CP 重启时还有执行在跑"而被 kill 的执行。 */
  killed: Array<{ sandboxId: string; executionId: string }>;
  /** 被删掉的孤儿容器（DB 里没有记录，或记录已 DESTROYED）。 */
  orphansDestroyed: string[];
  /** 容器在、agent 不答话：**不动它**（我们无法确认任何事，见 #checkSandbox）。 */
  unreachable: string[];
  /** 一切正常、不需要动作的行。 */
  unchanged: string[];
  /** 单个沙箱上的失败。对账不因为一行失败而整体中止。 */
  failures: Array<{ sandboxId: string; message: string }>;
  /** 扫描被行数上限截断时为 true（此时报告不完整，运维要看得见）。 */
  truncated: boolean;
}

/**
 * 跑一次对账。**只在启动时跑一次**（spec 的「技术边界」：定时对账是可选的加强）。
 */
export async function reconcile(options: ReconcileOptions): Promise<ReconcileReport> {
  const { db, provider } = options;
  const api = options.api ?? new SandboxApiClient();
  const log = options.log ?? noopLog;

  const report: ReconcileReport = {
    scanned: 0,
    transitions: [],
    killed: [],
    orphansDestroyed: [],
    unreachable: [],
    unchanged: [],
    failures: [],
    truncated: false,
  };

  const rows = await listSandboxes(db, { states: RECONCILE_STATES, limit: SCAN_LIMIT });
  report.scanned = rows.length;
  if (rows.length === SCAN_LIMIT) {
    report.truncated = true;
    log("warn", `对账扫描被 ${SCAN_LIMIT} 行上限截断，报告不完整`);
  }

  for (const row of rows) {
    try {
      await checkSandbox({ row, provider, api, db, report, log });
    } catch (error) {
      // 单行失败不能把整次对账带走：其余的行仍然要对齐。
      report.failures.push({ sandboxId: row.id, message: error instanceof Error ? error.message : String(error) });
      log("error", `对账处理 ${row.id} 失败`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await sweepOrphans({ db, provider, report, log });
  log("info", "对账完成", {
    scanned: report.scanned,
    transitions: report.transitions.length,
    killed: report.killed.length,
    orphans: report.orphansDestroyed.length,
    failures: report.failures.length,
  });
  return report;
}

/** 单行对账。四种结局见文件头。 */
async function checkSandbox(input: {
  row: SandboxRow;
  provider: SandboxProvider;
  api: SandboxApiClient;
  db: Db;
  report: ReconcileReport;
  log: LogFn;
}): Promise<void> {
  const { row, provider, api, db, report, log } = input;
  const inspection = await provider.inspect(row.id);

  // ① 容器不在：DB 里那一行已经没有对应物了。
  if (inspection === null) {
    await moveState({ db, report, log }, row.id, ["CREATING", "READY", "BUSY"], "ERROR", "container_lost");
    return;
  }

  // ② 容器在，但没在跑（exited/dead/paused）。agent 必然连不上，标 ERROR 才是诚实的。
  //    spec 的表格里没有这一条（它只区分"容器不在"与"agent error"），这里细分出来，
  //    因为"容器退出了"和"容器丢了"在排障时是两条完全不同的线索，而"标成 READY"是错的：
  //    下一次 exec 只会得到一次 connection refused。
  if (!inspection.running) {
    await moveState({ db, report, log }, row.id, ["CREATING", "READY", "BUSY"], "ERROR", "container_exited");
    return;
  }

  // ③ agent 明确报错。
  if (inspection.agentStatus === "error") {
    await moveState({ db, report, log }, row.id, ["CREATING", "READY", "BUSY"], "ERROR", "agent_error");
    return;
  }

  // ④ agent 不答话（容器在跑，但 /health 连不上）。**不动它**：
  //    "agent 还没起来"和"agent 挂了"在这一刻无法区分，而任何猜测都可能把
  //    一个正在启动的沙箱误伤成 ERROR（风险登记表里的"对账误伤"）。
  //    真正的兜底是 sweeper 的 TTL：它会在一段时间之后无条件销毁。
  if (inspection.agentStatus === "unreachable") {
    report.unreachable.push(row.id);
    log("warn", `对账：${row.id} 的 agent 不答话，保持 ${row.state} 不动`);
    return;
  }

  // ⑤ agent ready，而 DB 说 BUSY：看看它到底有没有在执行。
  if (row.state === "BUSY") {
    if (inspection.activeExecution !== null) {
      await killRestartedExecution({ row, inspection, api, db, report, log });
      return;
    }
    // 执行已经结束了（终态事件当时没人收），把状态放回可用。
    await moveState({ db, report, log }, row.id, ["BUSY"], "READY", "reconcile_idle");
    return;
  }

  // ⑥ CREATING 而 agent 已经 ready：创建其实成功了，只是那一刻 CP 没来得及转状态。
  if (row.state === "CREATING") {
    await moveState({ db, report, log }, row.id, ["CREATING"], "READY", "reconcile_ready");
    return;
  }

  // ⑦ READY 且一切正常：**什么都不做**。这一条是幂等的关键。
  report.unchanged.push(row.id);
}

/**
 * CP 重启时还有执行在跑：kill 掉、补记录、回到 READY。
 * `executions` 里那条记录的 `started_at` 用 `last_active_at`——
 * 那是我们最后一次刷新它的时刻（exec 开始），也是唯一还留在 DB 里的时间线索。
 */
async function killRestartedExecution(input: {
  row: SandboxRow;
  inspection: { activeExecution: string | null; endpoint: string | null };
  api: SandboxApiClient;
  db: Db;
  report: ReconcileReport;
  log: LogFn;
}): Promise<void> {
  const { row, inspection, api, db, report, log } = input;
  const executionId = inspection.activeExecution!;
  const endpoint = row.endpoint ?? inspection.endpoint;
  const token = row.auth_token;

  if (endpoint === null || token === null) {
    // 没有 endpoint/token 就没法跟 agent 说话。转 ERROR 比假装 READY 好：
    // 这个沙箱现在既接不了新命令，也停不掉那条执行。
    await moveState({ db, report, log }, row.id, ["BUSY"], "ERROR", "agent_unreachable");
    return;
  }

  try {
    await api.kill(endpoint, token, executionId);
  } catch (error) {
    const message = error instanceof SandboxApiError ? `${error.reason}: ${error.message}` : String(error);
    report.failures.push({ sandboxId: row.id, message: `kill ${executionId} 失败：${message}` });
    log("error", `对账：kill ${executionId} 失败，保持 BUSY`, { sandboxId: row.id, error: message });
    return;
  }

  await recordExecution(db, {
    id: executionId,
    sandboxId: row.id,
    runId: row.run_id,
    // 命令本体随着上一个 CP 进程一起消失了；空 argv + reason:"cp_restart" 是这里最诚实的表达。
    cmd: [],
    cwd: null,
    envKeys: [],
    state: "killed",
    reason: "cp_restart",
    exitCode: null,
    startedAt: row.last_active_at,
    endedAt: new Date(),
  });
  report.killed.push({ sandboxId: row.id, executionId });
  log("info", `对账：杀掉了 CP 重启前遗留的执行 ${executionId}`, { sandboxId: row.id });

  await moveState({ db, report, log }, row.id, ["BUSY"], "READY", "cp_restart");
}

/** 孤儿容器：DB 里没有记录（或记录已 DESTROYED）的容器直接删。 */
async function sweepOrphans(input: {
  db: Db;
  provider: SandboxProvider;
  report: ReconcileReport;
  log: LogFn;
}): Promise<void> {
  const { db, provider, report, log } = input;
  const managed = await provider.listManaged();

  // 同一个 sandboxId 的多个容器（沙箱本体 + darwin 的转发容器）只删一次：
  // provider.destroy 一次就把它们一起带走了。
  const alive = new Set<string>();
  for (const item of managed) {
    // 出网代理是全局常驻的基础设施，不是沙箱：它带着 managed 标签但没有 sandboxId（Phase 6）。
    if (item.sandboxId === null || item.role === "egress-proxy") continue;
    alive.add(item.sandboxId);
  }

  for (const sandboxId of alive) {
    // 逐个查而不是一次性 `SELECT *`：一次性查询有行数上限，被截断时会把"DB 里其实有记录"
    // 的容器当成孤儿删掉——那是对账能造成的最坏伤害（风险登记表）。
    const row = await getSandbox(db, sandboxId);
    if (row !== null && row.state !== "DESTROYED") continue;
    try {
      await provider.destroy(sandboxId);
      report.orphansDestroyed.push(sandboxId);
      log("info", `对账：删掉了孤儿容器 ${sandboxId}`, { hadRow: row !== null });
    } catch (error) {
      const message = error instanceof ProviderError ? error.reason : String(error);
      report.failures.push({ sandboxId, message: `destroy 失败：${message}` });
      log("error", `对账：删孤儿容器 ${sandboxId} 失败`, { error: message });
    }
  }
}

/** 做一次状态转换并记进报告（只有真的变了才算"变化"）。 */
async function moveState(
  input: { db: Db; report: ReconcileReport; log: LogFn },
  sandboxId: string,
  from: readonly SandboxState[],
  to: SandboxState,
  reason: string,
): Promise<void> {
  const result = await transition(input.db, sandboxId, from, to, reason);
  if (result.ok) {
    input.report.transitions.push({ sandboxId, from: result.from, to, reason });
    input.log("info", `对账：${sandboxId} ${result.from} → ${to}`, { reason });
    return;
  }
  const current = currentStateOf(result);
  if (current === "missing") {
    input.report.failures.push({ sandboxId, message: "行在对账过程中消失了" });
    return;
  }
  // 状态在扫描与处理之间被改了（另一个实例、或者 sweeper）。记下来但不算失败：
  // 下一轮对账会重新看它。
  input.report.unchanged.push(sandboxId);
  input.log("warn", `对账：${sandboxId} 想转 ${to} 时状态已经是 ${current}`, { reason });
}
