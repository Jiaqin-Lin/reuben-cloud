/**
 * `sandboxes` 表：状态机的唯一写入口。
 *
 * 【这个文件为什么这么重要】§D 说"状态转换必须写成独立函数，不允许在业务代码里直接
 * UPDATE 状态字段"。落到实现上有三道门，这个文件是第一道：
 *
 *  1. TS 层：`transition()` 是这里唯一会改 state 的函数，别的模块只能调它。
 *  2. 测试层：`test/unit/state-write.test.ts` 保证"`UPDATE sandboxes` 与 `sandbox_transition(`
 *     的调用点都只出现在这个文件里"——它能拦住新来的同学（Phase 8 §3 的"兜底"）。
 *  3. 数据库层：state 列的 UPDATE 权限已经从应用角色上收掉，真正的写操作在
 *     `sandbox_transition()`（SECURITY DEFINER）里。这一条能拦住所有人，包括一次手工 psql。
 *
 * **第 3 条是重点**：这个文件里没有一句 `UPDATE sandboxes SET state = …`，
 * 只有一次函数调用。想绕过去得先有属主权限，而那已经不在"业务代码"的讨论范围里了。
 */

import type { Db, Queryable } from "./client.ts";
import { many, maybeOne, one } from "./client.ts";

/** 五个状态，没有 PAUSED / SUSPENDED / SNAPSHOTTING（§D 收窄状态集换来的好处）。 */
export const SANDBOX_STATES = ["CREATING", "READY", "BUSY", "ERROR", "DESTROYED"] as const;

export type SandboxState = (typeof SANDBOX_STATES)[number];

/**
 * `limits` 列的 jsonb 形状。**与 `provider/types.ts` 的 `SandboxLimits` 结构相同、
 * 有意重复**：db 层不 import provider（provider 是唯一碰 docker socket 的地方，
 * 反过来依赖没有意义）。哪个字段的**类型**变了，manager 里那一行赋值会编译不过。
 */
export interface SandboxLimitsRecord {
  cpu: number;
  memMb: number;
  pids: number;
  diskMb: number;
  ttlSec: number;
}

/** 一行沙箱。列名保持 snake_case：pg 就是这么回来的，多一层驼峰映射只会多一处能写错的地方。 */
export interface SandboxRow {
  id: string;
  task_id: string | null;
  run_id: string | null;
  provider: string;
  provider_ref: string | null;
  endpoint: string | null;
  auth_token: string | null;
  image: string;
  image_digest: string;
  state: SandboxState;
  state_reason: string | null;
  limits: SandboxLimitsRecord;
  workspace_volume: string | null;
  last_active_at: Date;
  created_at: Date;
  ready_at: Date | null;
  destroyed_at: Date | null;
}

/**
 * `transition()` 可以顺带改的列。**没有 state**——它由 `to` 参数决定；
 * 也没有 id / created_at（那几个不是"可以顺带改"的东西）。
 * 这份列表与 `002_transition.sql` 里的白名单是同一份语义，改一处必须改另一处。
 */
export interface SandboxPatch {
  task_id?: string | null;
  run_id?: string | null;
  provider?: string;
  provider_ref?: string | null;
  endpoint?: string | null;
  auth_token?: string | null;
  image?: string;
  image_digest?: string;
  limits?: SandboxLimitsRecord;
  workspace_volume?: string | null;
  state_reason?: string;
  last_active_at?: string | Date;
  ready_at?: string | Date | null;
  destroyed_at?: string | Date | null;
}

/** 审计表里的一行。 */
export interface SandboxTransitionRow {
  id: number;
  sandbox_id: string;
  from_state: SandboxState | null;
  to_state: SandboxState;
  reason: string;
  at: Date;
}

/**
 * `transition()` 的结果。三种情况**必须**能区分：
 *  - `ok:true`：转换发生了，`from` 是真正的旧状态（调用方可能不知道它，比如对账）。
 *  - `ok:false, current`：行在，但状态不在期望集合里 → 调用方转 409。
 *  - `ok:false, current, illegal:true`：状态对得上，但这条边在 §D 的状态机里不存在
 *    （READY→CREATING 这类）。两种失败都是"什么都没改"，区别在语义：
 *    前者重试可能成功，后者是调用方的 bug。
 *  - `ok:false, missing`：行不存在。spec 的签名里没有这一条，但"行没了"和"状态不对"
 *    是两种不同的处理（404 vs 409），混在一起就没法给出正确的错误码。
 */
export type TransitionResult =
  | { ok: true; from: SandboxState }
  | { ok: false; current: SandboxState; illegal?: true }
  | { ok: false; missing: true };

/**
 * 把失败结果里的"当前状态"取出来（行没了就是 `"missing"`）。
 *
 * 存在这个 helper 是因为 `TransitionResult` 的 `{ok:false}` 两个分支没有共同的判别字段
 * （spec 给的形状就是 `current` 或 `missing`，其中一个不存在），TS 需要 `in` 才能收窄。
 * 把这个收窄写在一个地方，调用处就只是一句 `const current = currentStateOf(result)`。
 */
export function currentStateOf(result: TransitionResult): SandboxState | "missing" {
  if (result.ok) throw new Error("transition 成功了，没有 current");
  return "current" in result ? result.current : "missing";
}

export interface InsertSandboxInput {
  id: string;
  taskId?: string | null;
  runId?: string | null;
  provider: string;
  image: string;
  imageDigest: string;
  limits: SandboxLimitsRecord;
  workspaceVolume: string | null;
}

/**
 * 插入一行 `CREATING`，并在同一个事务里补一条 `NULL → CREATING` 的审计行。
 *
 * 【为什么先插 DB 再调 provider】Phase 8 §4 的顺序要求：崩在 create 中途时，
 * DB 里要有一行可对账的记录，而不是一个没人知道的孤儿容器。
 * 审计行的 from 是 NULL：创建没有前驱，但它是这条轨迹的起点，值得被记下来
 * （"这个沙箱什么时候出现的"不用去读 created_at）。
 */
export async function insertSandbox(db: Db, input: InsertSandboxInput): Promise<SandboxRow> {
  return db.withTransaction(async (tx) => {
    const row = await one<SandboxRow>(
      tx,
      `INSERT INTO sandboxes
         (id, task_id, run_id, provider, image, image_digest, state, state_reason, limits, workspace_volume)
       VALUES ($1, $2, $3, $4, $5, $6, 'CREATING', 'created', $7::jsonb, $8)
       RETURNING *`,
      [
        input.id,
        input.taskId ?? null,
        input.runId ?? null,
        input.provider,
        input.image,
        input.imageDigest,
        JSON.stringify(input.limits),
        input.workspaceVolume,
      ],
    );
    await tx.query(
      `INSERT INTO sandbox_state_transitions (sandbox_id, from_state, to_state, reason)
       VALUES ($1, NULL, 'CREATING', 'created')`,
      [input.id],
    );
    return row;
  });
}

export function getSandbox(q: Queryable, id: string): Promise<SandboxRow | null> {
  return maybeOne<SandboxRow>(q, "SELECT * FROM sandboxes WHERE id = $1", [id]);
}

/**
 * 按状态 / id 列沙箱。两个过滤条件都是可选的（传 null = 不过滤），
 * 因为对账要"全部行"、sweeper 要"过期的行"、测试要"刚刚造的那几个"。
 */
export async function listSandboxes(
  q: Queryable,
  options: { states?: readonly SandboxState[]; ids?: readonly string[]; limit?: number } = {},
): Promise<SandboxRow[]> {
  return many<SandboxRow>(
    q,
    `SELECT * FROM sandboxes
      WHERE ($1::text[] IS NULL OR state = ANY ($1::text[]))
        AND ($2::text[] IS NULL OR id = ANY ($2::text[]))
      ORDER BY created_at, id
      LIMIT $3`,
    [options.states ?? null, options.ids ?? null, options.limit ?? 1000],
  );
}

/**
 * 过期的沙箱（sweeper 用）。TTL 是**逐行**的：`limits.ttlSec` 优先，缺省用 `defaultTtlSec`。
 *
 * 关于索引：`(state, last_active_at)` 在这里提供的是按 state 的剪枝；
 * per-row 的 ttlSec 是个表达式，`last_active_at` 用不上范围扫描。表里同时存在的
 * 沙箱是几十个量级，这点差距换来的是"每个沙箱可以有自己的 TTL"。
 */
export async function listExpiredSandboxes(
  q: Queryable,
  options: { defaultTtlSec: number; now?: Date; limit?: number },
): Promise<SandboxRow[]> {
  return many<SandboxRow>(
    q,
    `SELECT * FROM sandboxes
      WHERE state = ANY ($1::text[])
        AND last_active_at
            < $2::timestamptz - make_interval(secs => CASE
                WHEN jsonb_typeof(limits -> 'ttlSec') = 'number' THEN (limits ->> 'ttlSec')::numeric
                ELSE $3::numeric
              END)
      ORDER BY last_active_at ASC
      LIMIT $4`,
    [
      // DESTROYED 不在候选里：它已经不需要销毁了。ERROR 在候选里：
      // 一个反复销毁失败的沙箱要靠下一轮 TTL 重试（§D：TTL 是安全兜底）。
      ["CREATING", "READY", "BUSY", "ERROR"],
      options.now ?? new Date(),
      options.defaultTtlSec,
      options.limit ?? 50,
    ],
  );
}

/**
 * 唯一的改状态入口。实现在 `sandbox_transition()`（SQL）里，这里只负责类型与结果分类。
 *
 * @param from 期望的当前状态集合。"不在这个集合里"是**正常结果**（并发、状态已变），
 *             不是异常——调用方拿 `current` 去决定是重试、报 409 还是记录日志。
 */
export async function transition(
  q: Queryable,
  id: string,
  from: readonly SandboxState[],
  to: SandboxState,
  reason: string,
  patch: SandboxPatch = {},
): Promise<TransitionResult> {
  const rows = await many<{ result: TransitionResult | string }>(
    q,
    "SELECT sandbox_transition($1::text, $2::text[], $3::text, $4::text, $5::jsonb) AS result",
    [id, from, to, reason, JSON.stringify(patch)],
  );
  const raw = rows[0]?.result;
  if (raw === undefined) throw new Error("sandbox_transition 没有返回结果");
  // jsonb 一般已经被 pg 解析成对象；字符串分支留着是因为"换驱动/换列类型"不该让这里静默失效。
  const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  if (parsed.ok === true) return { ok: true, from: parsed.from as SandboxState };
  if (parsed.missing === true) return { ok: false, missing: true };
  // `illegal` 是"状态对得上、但这条边不存在"（SQL 函数里那第二道检查）。
  return parsed.illegal === true
    ? { ok: false, current: parsed.current as SandboxState, illegal: true }
    : { ok: false, current: parsed.current as SandboxState };
}

/** 一个沙箱的状态轨迹（按时间，同毫秒靠 id 定序）。对账与验收都读它。 */
export function listTransitions(q: Queryable, sandboxId: string): Promise<SandboxTransitionRow[]> {
  return many<SandboxTransitionRow>(
    q,
    `SELECT * FROM sandbox_state_transitions
      WHERE sandbox_id = $1
      ORDER BY at, id`,
    [sandboxId],
  );
}
