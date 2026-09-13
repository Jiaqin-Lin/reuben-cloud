/**
 * 数据库迁移入口（`npm run db:migrate`）。
 *
 * 用法：
 *   npm run db:migrate              # 把未应用的迁移跑完（幂等）
 *   npm run db:migrate -- --status  # 只打印每个迁移文件应用了没有
 *
 * 连接串来自 `DATABASE_URL`（或 PGHOST/PGDATABASE 这套 libpq 变量）。
 * 本地开发用 `npm run db:up` 起一个一次性 Postgres，它打完 URL 会把这个变量告诉你。
 *
 * 【为什么脚本这么薄】真正的逻辑在 `packages/control-plane/src/db/migrate.ts` 里，
 * 因为集成测试也要用它（测试自己起一个 Postgres 容器、自己跑迁移）。
 * 脚本只负责"从 env 读连接串、打印结果、设置退出码"。
 */

import process from "node:process";
import { Db, resolveDatabaseUrl } from "../packages/control-plane/src/db/client.ts";
import { migrationStatus, runMigrations } from "../packages/control-plane/src/db/migrate.ts";

async function main(): Promise<void> {
  const statusOnly = process.argv.includes("--status");
  const db = new Db({ connectionString: resolveDatabaseUrl() });
  try {
    if (statusOnly) {
      const rows = await migrationStatus(db);
      for (const row of rows) {
        const mark = row.appliedAt === null ? "待应用" : `已应用 ${row.appliedAt.toISOString()}`;
        console.log(`${row.filename}  ${mark}`);
      }
      return;
    }
    const report = await runMigrations(db, {
      log: (level, message, details) => {
        const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
        console.log(`[migrate:${level}] ${message}${suffix}`);
      },
    });
    if (report.applied.length > 0) console.log(`已应用 ${report.applied.length} 个迁移：${report.applied.join(", ")}`);
    else console.log(`没有待应用的迁移（跳过 ${report.skipped.length} 个）`);
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(`迁移失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
