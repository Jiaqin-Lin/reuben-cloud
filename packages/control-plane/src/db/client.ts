/**
 * Postgres 连接层：一个池、一个可注入的事务、几个按行数取结果的 helper。
 *
 * 【为什么只有一个文件、只有 `pg`】spec §0.2：Postgres 驱动没有理由自己写，
 * 而 ORM / 查询构造器都是**明确不引**的。这个文件的全部职责是"把连接管好、
 * 把事务开对"，SQL 一律写在调用处（看得见）。
 *
 * 【两处不显眼但重要的设置】
 *  - `int8`（bigint）默认会被 pg 解析成**字符串**（因为它可能超出 JS 安全整数）。
 *    这里的每一列 bigint 都是字节数（stdout_bytes / size_bytes），远小于 2^53，
 *    "读出来是数字"比"每个调用点各写一次 Number()"更不容易错。所以全局注册一个
 *    int8 → number 的解析器，并在这里写明代价：真出现超过 2^53 的字节数时会静默丢精度，
 *    而那种量级（9 PB）在本项目里不存在。
 *  - 事务用 `withTransaction` 一个入口：BEGIN / COMMIT / ROLLBACK / release 四件事
 *    写在一个地方，业务代码只需要给一个回调（对账、迁移、测试的 SET LOCAL ROLE 都用它）。
 */

import { Pool, types } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

// bigint（OID 20）→ number。理由见文件头：本项目里的 int8 全是字节数。
types.setTypeParser(20, (value: string) => Number(value));

/** 能执行 SQL 的东西。池和事务里的连接都满足它，所以 helper 只写一份。 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface DatabaseOptions {
  /** 连接串。测试与脚本用 `resolveDatabaseUrl()` 得到它。 */
  connectionString: string;
  /** 池上限。MVP 单实例，默认 5 足够（对账是串行的小查询）。 */
  max?: number;
  /** 单个连接的空闲回收时间。 */
  idleTimeoutMs?: number;
  /** 建连超时。连不上 DB 时应该快速失败，而不是让启动挂在那里。 */
  connectionTimeoutMs?: number;
  log?: LogFn;
}

/** 一个池。所有查询都从这里出。 */
export class Db implements Queryable {
  readonly pool: Pool;

  #log: LogFn;

  constructor(options: DatabaseOptions) {
    this.#log = options.log ?? noopLog;
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 5,
      idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
      // 进 pg_stat_activity 的 application_name：排障时能一眼看出连接是谁的。
      application_name: "reuben-cloud-cp",
    });
    // 池里的连接报错（DB 重启、网络断）不能变成未处理异常把进程带走。
    // 记一条日志，让下一次查询自己去失败——那才是调用方能处理的地方。
    this.pool.on("error", (error) => {
      this.#log("error", "Postgres 池上的连接出错", { error: error.message });
    });
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    return this.pool.query<R>(text, values);
  }

  /**
   * 开一个事务跑回调。回调里抛异常 → ROLLBACK 后原样抛出。
   *
   * 注意它**不是**用来包跨网络的长时间操作的（比如 create 容器 + 改状态）：
   * 那种流程没法用一个数据库事务保护，靠的是状态机 + 对账，不是长事务。
   */
  async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(new Transaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // ROLLBACK 自己的失败不能覆盖真正的原因（连接已经断了的时候它必然失败）。
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** 事务里的连接。形状与 Db 一样（只有 query），所以 helper 拿哪个都能用。 */
class Transaction implements Queryable {
  readonly #client: PoolClient;

  constructor(client: PoolClient) {
    this.#client = client;
  }

  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    return this.#client.query<R>(text, values);
  }
}

// ---------------------------------------------------------------- 结果 helper

/** 全部行。 */
export async function many<R extends QueryResultRow>(
  q: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  const result = await q.query<R>(text, values);
  return result.rows;
}

/** 最多一行：0 行给 null，多行是"查询写错了"，抛。 */
export async function maybeOne<R extends QueryResultRow>(
  q: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<R | null> {
  const rows = await many<R>(q, text, values);
  if (rows.length > 1) throw new Error(`期望至多一行，实际拿到 ${rows.length} 行`);
  return rows[0] ?? null;
}

/** 恰好一行：0 行或多行都抛（调用处应当能保证唯一性，否则就是个 bug）。 */
export async function one<R extends QueryResultRow>(
  q: Queryable,
  text: string,
  values: unknown[] = [],
): Promise<R> {
  const row = await maybeOne<R>(q, text, values);
  if (row === null) throw new Error("期望一行，实际是 0 行");
  return row;
}

// ---------------------------------------------------------------- 连接串与错误码

/**
 * 从环境里取连接串。`DATABASE_URL` 优先；否则按 libpq 的约定拼 `PG*` 变量。
 *
 * 显式写出来（而不是让 pg 自己读 PG*）的理由：**缺配置时要报一句人话**。
 * pg 在什么都没有时会去连本地 socket，报一个 `ECONNREFUSED /var/run/postgresql`，
 * 那对"忘了配数据库"的人来说毫无指向性。
 */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== "") return env.DATABASE_URL;
  const host = env.PGHOST;
  const database = env.PGDATABASE;
  if (host === undefined && database === undefined) {
    throw new Error("没有数据库配置：请设置 DATABASE_URL（或 PGHOST + PGDATABASE 等 libpq 变量）");
  }
  const user = env.PGUSER ?? "postgres";
  const password = env.PGPASSWORD;
  const port = env.PGPORT ?? "5432";
  const auth = password === undefined ? user : `${user}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${host ?? "127.0.0.1"}:${port}/${database ?? "reuben_cloud"}`;
}

/** Postgres 的 SQLSTATE。业务错误分支用它，不用错误字符串（与 ProviderError 同一条规矩）。 */
export function sqlState(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/** 23505：唯一约束冲突。 */
export function isUniqueViolation(error: unknown): boolean {
  return sqlState(error) === "23505";
}

/** 23514：CHECK 违反（我们用它兜状态与 kind 的取值）。 */
export function isCheckViolation(error: unknown): boolean {
  return sqlState(error) === "23514";
}

/** 42501：权限不足。Phase 8 的验收之一就是这条错误**必须**发生在写 state 时。 */
export function isInsufficientPrivilege(error: unknown): boolean {
  return sqlState(error) === "42501";
}
