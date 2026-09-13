/**
 * 迁移执行器：按文件名排序、逐个在事务里跑，已应用的记在 `schema_migrations`。
 *
 * 【为什么不引迁移框架】spec §Phase 8 §1 的原话：三张表而已，不引 ORM、不引 knex。
 * 这个文件总共不到 100 行，而它要回答的问题只有两个："哪些跑过了"和"新加的这个跑没跑"。
 *
 * 【一个文件 = 一个事务】迁移跑到一半失败时，那个文件里的所有语句一起回滚，
 * 不会留下"建了两张表、第三张没建"的中间态。DDL 在 Postgres 里是事务性的，
 * 所以这条是真的能做到的（这也是选 Postgres 的一个白送的好处）。
 *
 * 【应用顺序】文件名字典序。前缀用 `001_` / `002_` 这种零填充数字，
 * 所以字典序就是数字序，不需要第二套排序规则。
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Queryable } from "./client.ts";
import { many } from "./client.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

/** 迁移文件目录。用 import.meta.url 解析，所以从任何 cwd 跑都对。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** 记账表。它自己不是迁移文件的一部分——否则就成了"要跑迁移得先有迁移表"的鸡生蛋。 */
const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

export interface MigrateOptions {
  /** 换一个迁移目录（测试里用来构造"坏迁移"这类场景）。默认是仓库里的 migrations/。 */
  dir?: string;
  log?: LogFn;
}

export interface MigrateReport {
  /** 本次真正跑了的文件（按执行顺序）。 */
  applied: string[];
  /** 已经跑过、跳过的文件。 */
  skipped: string[];
}

/**
 * 把所有未应用的迁移跑一遍。**幂等**：已经记在账上的文件直接跳过，
 * 所以可以在每次启动时无条件调用（`scripts/migrate.ts` 与集成测试都这么用）。
 */
export async function runMigrations(db: Db, options: MigrateOptions = {}): Promise<MigrateReport> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const log = options.log ?? noopLog;

  await db.query(MIGRATIONS_TABLE);
  const rows = await many<{ filename: string }>(db, "SELECT filename FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.filename));

  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const report: MigrateReport = { applied: [], skipped: [] };

  for (const file of files) {
    if (applied.has(file)) {
      report.skipped.push(file);
      continue;
    }
    const sql = await readFile(path.join(dir, file), "utf8");
    await db.withTransaction(async (tx: Queryable) => {
      // 注意：这里是无参数的 query，pg 走简单查询协议，所以一个文件里的多条语句
      // 与 DO $$ … $$ 块都能一次发过去（带参数时会退化成单语句的扩展协议）。
      await tx.query(sql);
      await tx.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
    });
    report.applied.push(file);
    log("info", `已应用迁移 ${file}`);
  }

  if (report.applied.length === 0) log("info", "数据库结构已是最新");
  return report;
}

/** 迁移状态（`npm run db:migrate -- --status` 用它打印）。 */
export async function migrationStatus(
  q: Queryable,
  options: { dir?: string } = {},
): Promise<Array<{ filename: string; appliedAt: Date | null }>> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const rows = await many<{ filename: string; applied_at: Date }>(
    q,
    "SELECT filename, applied_at FROM schema_migrations",
  );
  const applied = new Map(rows.map((row) => [row.filename, row.applied_at]));
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  return files.map((filename) => ({ filename, appliedAt: applied.get(filename) ?? null }));
}
