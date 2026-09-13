/**
 * Phase 6 · 手工验收：给一个本地仓库跑一次环境构建（推断 → LLM 生成 + 自愈 → 落库）。
 *
 * 这不是产品代码，是把已经存在的零件按生产顺序串起来的一次性驱动——与 `agent:run` 同一个定位。
 * 它比集成测试多出来的东西只有两件：**真的连本地 Postgres**（看得到 environments / env_builds
 * 两张表的变化）与**真的读 .env 里的模型凭据**（集成测试用脚本化模型，不许要 key）。
 *
 * 【用法】
 *   npm run dev:up && export DATABASE_URL=$(npm run --silent db:url)
 *   npm run build:image                       # Layer 1（生成的 Dockerfile 的 FROM 指它）
 *   # 模型凭据写在仓库根的 .env（npm run env:build 会自动读它）：
 *   #   DEEPSEEK_API_KEY=sk-...  REUBEN_CLOUD_PROVIDER=deepseek  REUBEN_CLOUD_MODEL=deepseek-flash
 *
 *   npm run env:build -- --local ~/code/my-project
 *   npm run env:build -- --local ~/code/my-project --project acme/web --trigger manual
 *   npm run env:build -- --local ~/code/my-project --no-model      # 只用规则生成的 Dockerfile
 *   npm run env:build -- --local ~/code/my-project --timeout-ms 60000
 *
 * 【为什么不给 trigger 加更多候选】三个触发源是设计文档 §C.8 写死的（first_seen / manual /
 * promote）。手工验收用 manual 最诚实——它本来就是人发起的；first_seen 要留给 P7 的会话接线。
 */

import path from "node:path";
import process from "node:process";
import { Db, resolveDatabaseUrl } from "../packages/control-plane/src/db/client.ts";
import { runMigrations } from "../packages/control-plane/src/db/migrate.ts";
import {
  DEFAULT_BUILD_TIMEOUT_MS,
  DockerBuildRunner,
  envBuildLogStoreFromEnv,
  FileBuildLogStore,
} from "../packages/control-plane/src/environment/build.ts";
import { ModelDockerfileGenerator } from "../packages/control-plane/src/environment/generate.ts";
import { inferFromClone } from "../packages/control-plane/src/environment/infer.ts";
import { BuildQueue } from "../packages/control-plane/src/environment/queue.ts";
import { insertEnvironment, listEnvBuilds, pgEnvBuildStore } from "../packages/control-plane/src/environment/store.ts";
import { ENV_BUILD_TRIGGERS } from "../packages/control-plane/src/environment/types.ts";
import type { EnvBuildTrigger } from "../packages/control-plane/src/environment/types.ts";
import type { DockerfileGenerator } from "../packages/control-plane/src/environment/generate.ts";
import { consoleLog } from "../packages/control-plane/src/log.ts";
import { modelFromEnv, ModelError } from "@reuben-cloud/agent-runtime";

const log = consoleLog("env-build");

interface Args {
  local: string | null;
  project: string | null;
  trigger: EnvBuildTrigger;
  /** 不给模型（只看规则生成的 Dockerfile；没配 key 时的缺省行为）。 */
  noModel: boolean;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    local: null,
    project: null,
    trigger: "manual",
    noModel: false,
    timeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${item} 需要一个值`);
      index += 1;
      return value;
    };
    switch (item) {
      case "--local":
        args.local = next();
        break;
      case "--project":
        args.project = next();
        break;
      case "--trigger": {
        const value = next();
        if (!(ENV_BUILD_TRIGGERS as readonly string[]).includes(value)) {
          throw new Error(`--trigger 只能是 ${ENV_BUILD_TRIGGERS.join(" / ")}`);
        }
        args.trigger = value as EnvBuildTrigger;
        break;
      }
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-ms 要给一个正数");
        break;
      case "--no-model":
        args.noModel = true;
        break;
      case "--help":
      case "-h":
        args.local = null;
        break;
      default:
        throw new Error(`未知参数：${item}（--help 看用法）`);
    }
  }
  return args;
}

function usage(): string {
  return [
    "用法：npm run env:build -- --local <仓库路径> [--project owner/name] [--trigger manual] [--no-model] [--timeout-ms N]",
    "",
    "  --local <path>    要推断的本地仓库目录（必填）",
    "  --project <key>   环境归属（缺省 local/<目录名>）",
    `  --trigger <name>  ${ENV_BUILD_TRIGGERS.join(" | ")}（缺省 manual）`,
    "  --no-model        不调模型：直接用规则生成的 Dockerfile（不配 key 时的形态）",
    `  --timeout-ms N    单轮构建超时（缺省 ${DEFAULT_BUILD_TIMEOUT_MS} = 10 分钟）`,
    "",
    "需要 DATABASE_URL（或 PGHOST/PGDATABASE）与可用的 docker daemon。",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.local === null) {
    console.log(usage());
    process.exitCode = 1;
    return;
  }
  const projectKey = args.project ?? `local/${path.basename(path.resolve(args.local))}`;

  // ---- 推断（毫秒级、只读文件）
  const inference = await inferFromClone(args.local);
  console.log(
    `推断完成：level=${inference.candidate.level} base=${inference.candidate.baseImage} ` +
      `语言=${inference.signals.languages.join(",") || "（无）"}`,
  );
  for (const note of inference.candidate.notes) console.log(`  · ${note}`);

  // ---- 落库：一行环境定义（P6 不建表结构上的父子关系，那是 P7 的 revision.ts）
  const db = new Db({ connectionString: resolveDatabaseUrl() });
  try {
    await runMigrations(db);
    const environment = await insertEnvironment(db, {
      projectKey,
      candidate: inference.candidate,
      signals: inference.signals,
      status: "draft",
    });
    console.log(`环境定义：${environment.id}（${projectKey} revision ${environment.revision}）`);

    // ---- 生成端口：有 key 才建；没 key 就退化成规则生成（不是错误）
    const generator = resolveGenerator(args.noModel);
    if (generator === null) console.log("没有模型：只用规则生成的 Dockerfile（自愈不可用）");

    // ---- 队列（并发 1、按 project_key 去重）
    const logStore = envBuildLogStoreFromEnv();
    const builder = new DockerBuildRunner({ logStore, log });
    const queue = new BuildQueue({
      builder,
      store: pgEnvBuildStore(db),
      generator,
      timeoutMs: args.timeoutMs,
      log,
    });

    const started = Date.now();
    console.log(`构建开始（trigger=${args.trigger}）…`);
    const outcome = await queue.enqueue({
      projectKey,
      revision: environment.revision,
      candidate: inference.candidate,
      signals: inference.signals,
      trigger: args.trigger,
    });

    // ---- 分轮次的结果：这是"人工验收"要看的东西（人类可读）
    const rows = await listEnvBuilds(db, projectKey, environment.revision);
    for (const row of rows) {
      const duration = row.duration_ms === null ? "?" : `${(row.duration_ms / 1000).toFixed(1)}s`;
      console.log(
        `  第 ${row.attempt} 轮：${row.status}（${row.inference}） ${duration}` +
          `${row.error_class === null ? "" : ` ${row.error_class}`}` +
          `${row.log_key === null ? "" : ` 日志=${row.log_key}`}`,
      );
    }
    console.log("");
    if (outcome.ok) {
      console.log(`✓ 构建成功：${outcome.imageDigest}（${outcome.attempts} 轮，用时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
      console.log("  环境状态留在 building：能不能用由 P7 的健康检查决定（设计文档 §C.6）");
    } else {
      console.log(`✗ 构建失败：${outcome.attempts} 轮，${outcome.errorClass}——${outcome.detail ?? ""}`);
      process.exitCode = 1;
    }
    if (logStore instanceof FileBuildLogStore) console.log(`  日志目录：${logStore.root}`);
    console.log(`  下一版环境：revision ${environment.revision + 1}（同一仓库再跑一次就是新 revision）`);
  } finally {
    await db.close();
  }
}

/** 有模型就给一个生成器；没配 key 给 null（**不是错误**：规则生成那条路仍然可用）。 */
function resolveGenerator(noModel: boolean): DockerfileGenerator | null {
  if (noModel) return null;
  try {
    return new ModelDockerfileGenerator({ model: modelFromEnv() });
  } catch (error) {
    if (error instanceof ModelError && error.reason === "config_missing") return null;
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(`[env-build] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
