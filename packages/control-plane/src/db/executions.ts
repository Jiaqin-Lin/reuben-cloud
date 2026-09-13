/**
 * `executions` 表：一次 exec 的落地记录（§G.2）。
 *
 * 【什么时候写】Phase 8 §4 的第 6 步：**收到终态事件之后**写。
 * 中途不写 `running` 行——那样会多出一种"半截记录"，而对账能覆盖的场景
 * （CP 崩了、执行还在跑）本来就是"CP 重启后由对账补一条 killed"。
 * 表里的 `running` 取值保留着（CHECK 允许它），因为它是 §G.2 词汇表的一部分，
 * 将来要在执行开始时就落行时不用改迁移。
 *
 * 【`env_keys` 只存 key 名】这是**安全约束**，不是格式偏好：env 里将来会有代理地址、
 * 凭据服务签发的短期 token 之类的值，它们不该在 DB 里留一份（§G.2 原文：
 * "只存 key 名，永不存 value"）。这个文件提供的 API 是 `envKeys: string[]`，
 * 结构上就没有传 value 的位置；`assertEnvKeys` 再挡一次形状不对的输入。
 */

import type { Queryable } from "./client.ts";
import { many, maybeOne } from "./client.ts";

/** 一次执行的状态。`running` 见文件头说明。 */
export const EXECUTION_STATES = ["running", "completed", "failed", "timeout", "killed"] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export interface ExecutionRow {
  id: string;
  sandbox_id: string;
  run_id: string | null;
  cmd: string[];
  cwd: string | null;
  env_keys: string[];
  state: ExecutionState;
  /** 终态原因：watchdog_timeout / cp_restart / exec_finished … */
  reason: string | null;
  exit_code: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  truncated: boolean;
  log_path: string | null;
  started_at: Date;
  ended_at: Date | null;
}

export interface RecordExecutionInput {
  /** 沙箱侧生成的 `exe_<ulid>`。 */
  id: string;
  sandboxId: string;
  runId?: string | null;
  /** argv 数组，原样存。 */
  cmd: string[];
  cwd?: string | null;
  /** **只有 key 名**。用 `Object.keys(env)` 得到，永远不要传 env 本体。 */
  envKeys?: string[];
  state: ExecutionState;
  reason?: string | null;
  exitCode?: number | null;
  stdoutBytes?: number;
  stderrBytes?: number;
  truncated?: boolean;
  logPath?: string | null;
  /** 取 `started` 事件的 `ts`（那是进程真的起来的时刻），而不是 POST /exec 返回的时刻。 */
  startedAt?: string | Date;
  endedAt?: string | Date | null;
}

/** 环境变量名的 POSIX 形状。 */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertEnvKeys(keys: string[]): void {
  for (const key of keys) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`env_keys 里出现了不像变量名的元素：${JSON.stringify(key)}（只允许存 key 名）`);
    }
  }
}

/**
 * 写一行执行记录。**幂等**（`ON CONFLICT (id) DO UPDATE`）：
 * 对账会在 CP 重启后为同一个 execution_id 补一条 killed，而正常路径也可能在
 * 重放时再写一次——第二次写进来的应该是更完整的终态信息，覆盖旧的没有歧义。
 */
export async function recordExecution(q: Queryable, input: RecordExecutionInput): Promise<ExecutionRow> {
  const envKeys = input.envKeys ?? [];
  assertEnvKeys(envKeys);
  const rows = await many<ExecutionRow>(
    q,
    `INSERT INTO executions
       (id, sandbox_id, run_id, cmd, cwd, env_keys, state, reason, exit_code,
        stdout_bytes, stderr_bytes, truncated, log_path, started_at, ended_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO UPDATE SET
       state        = EXCLUDED.state,
       reason       = EXCLUDED.reason,
       exit_code    = EXCLUDED.exit_code,
       stdout_bytes = EXCLUDED.stdout_bytes,
       stderr_bytes = EXCLUDED.stderr_bytes,
       truncated    = EXCLUDED.truncated,
       log_path     = EXCLUDED.log_path,
       ended_at     = EXCLUDED.ended_at
     RETURNING *`,
    [
      input.id,
      input.sandboxId,
      input.runId ?? null,
      JSON.stringify(input.cmd),
      input.cwd ?? null,
      JSON.stringify(envKeys),
      input.state,
      input.reason ?? null,
      input.exitCode ?? null,
      input.stdoutBytes ?? 0,
      input.stderrBytes ?? 0,
      input.truncated ?? false,
      input.logPath ?? null,
      input.startedAt ?? new Date(),
      input.endedAt ?? null,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("INSERT executions 没有返回结果");
  return row;
}

export function listExecutions(
  q: Queryable,
  filter: { sandboxId?: string; runId?: string; limit?: number } = {},
): Promise<ExecutionRow[]> {
  return many<ExecutionRow>(
    q,
    `SELECT * FROM executions
      WHERE ($1::text IS NULL OR sandbox_id = $1)
        AND ($2::text IS NULL OR run_id = $2)
      ORDER BY started_at DESC, id DESC
      LIMIT $3`,
    [filter.sandboxId ?? null, filter.runId ?? null, filter.limit ?? 100],
  );
}

export function getExecution(q: Queryable, id: string): Promise<ExecutionRow | null> {
  return maybeOne<ExecutionRow>(q, "SELECT * FROM executions WHERE id = $1", [id]);
}
