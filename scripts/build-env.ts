/**
 * Phase 6/7 · 手工验收：给一个本地仓库跑一次环境构建（推断 → LLM 生成 + 自愈 → 体检 → 落库）。
 *
 * 这不是产品代码，是把已经存在的零件按生产顺序串起来的一次性驱动——与 `agent:run` 同一个定位。
 * 它比集成测试多出来的东西只有三件：**真的连本地 Postgres**（看得见 environments / env_builds /
 * project_env_state 三张表的变化）、**真的读 .env 里的模型凭据**、以及 **真的跑一次体检**
 * （P7：构建成功 ≠ 能用）。
 *
 * 【P7 起它走的是产品路径】推断 / 缓存优先 / 重建 / 体检调度的编排全在
 * `environment/runtime.ts`（组合根），脚本只负责参数、打印与"进程级的队列"这一件事。
 * 手工验收用 `manual` 触发最诚实——它本来就是人发起的。
 *
 * 【用法】
 *   npm run dev:up && export DATABASE_URL=$(npm run --silent db:url)
 *   npm run build:base-images                 # Layer 1（生成的 Dockerfile 的 FROM 指它）
 *   # 模型凭据写在仓库根的 .env（npm run env:build 会自动读它）：
 *   #   DEEPSEEK_API_KEY=sk-...  REUBEN_CLOUD_PROVIDER=deepseek  REUBEN_CLOUD_MODEL=deepseek-flash
 *
 *   npm run env:build -- --local ~/code/my-project              # 缓存优先：第二次跑是秒回
 *   npm run env:build -- --local ~/code/my-project --rebuild    # 显式重建（跳过缓存）
 *   npm run env:build -- --local ~/code/my-project --no-model   # 只用规则生成的 Dockerfile
 *   npm run env:build -- --local ~/code/my-project --no-health  # 不体检（只验构建）
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Db, resolveDatabaseUrl } from "../packages/control-plane/src/db/client.ts";
import { runMigrations } from "../packages/control-plane/src/db/migrate.ts";
import { SandboxApiClient } from "../packages/control-plane/src/client/sandbox-api.ts";
import type { BuildLogStore } from "../packages/control-plane/src/environment/build.ts";
import {
  DEFAULT_BUILD_TIMEOUT_MS,
  DockerBuildRunner,
  envBuildLogStoreFromEnv,
  FileBuildLogStore,
} from "../packages/control-plane/src/environment/build.ts";
import { ModelDockerfileGenerator } from "../packages/control-plane/src/environment/generate.ts";
import { getProjectEnvState, listEnvBuilds, listEnvironments } from "../packages/control-plane/src/environment/store.ts";
import { ENV_BUILD_TRIGGERS } from "../packages/control-plane/src/environment/types.ts";
import type { EnvBuildTrigger } from "../packages/control-plane/src/environment/types.ts";
import type { DockerfileGenerator } from "../packages/control-plane/src/environment/generate.ts";
import { createEnvironmentSubsystem } from "../packages/control-plane/src/environment/runtime.ts";
import { SandboxManager } from "../packages/control-plane/src/manager/sandbox-manager.ts";
import { LocalDockerProvider } from "../packages/control-plane/src/provider/local-docker.ts";
import { REPO_DIR } from "@reuben-cloud/agent-runtime";
import { consoleLog } from "../packages/control-plane/src/log.ts";
import { modelFromEnv, ModelError } from "@reuben-cloud/agent-runtime";

const log = consoleLog("env-build");

interface Args {
  local: string | null;
  project: string | null;
  trigger: EnvBuildTrigger;
  /** 显式重建（跳过缓存）。 */
  rebuild: boolean;
  /** 不给模型（只看规则生成的 Dockerfile；没配 key 时的缺省行为）。 */
  noModel: boolean;
  /** 不体检（只验构建；排障构建本身时用）。 */
  noHealth: boolean;
  /** `--promote <文件>`：把这份 Dockerfile 固化成项目级的新一版（P7）。 */
  promote: string | null;
  timeoutMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    local: null,
    project: null,
    trigger: "manual",
    rebuild: false,
    noModel: false,
    noHealth: false,
    promote: null,
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
      case "--rebuild":
        args.rebuild = true;
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-ms 要给一个正数");
        break;
      case "--no-model":
        args.noModel = true;
        break;
      case "--no-health":
        args.noHealth = true;
        break;
      case "--promote":
        args.promote = next();
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
    "用法：npm run env:build -- --local <仓库路径> [--project owner/name] [--trigger manual] [--rebuild] [--no-model] [--no-health] [--timeout-ms N]",
    "",
    "  --local <path>    要推断的本地仓库目录（必填）",
    "  --project <key>   环境归属（缺省 local/<目录名>）",
    `  --trigger <name>  ${ENV_BUILD_TRIGGERS.join(" | ")}（缺省 manual）`,
    "  --rebuild         跳过缓存，显式重建一版（缺省：同键命中就直接复用）",
    "  --no-model        不调模型：直接用规则生成的 Dockerfile（不配 key 时的形态）",
    "  --no-health       不跑体检（构建成功后就停在 building）",
    "  --promote <file>  把这份 Dockerfile 固化成一版新环境（promote：跳过推断生成的文本）",
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
  const localPath = path.resolve(args.local);
  const projectKey = args.project ?? `local/${path.basename(localPath)}`;
  const startCommit = (await hostGit(["rev-parse", "HEAD"], localPath)).trim();

  const db = new Db({ connectionString: resolveDatabaseUrl() });
  try {
    await runMigrations(db);

    // ---- 日志落点与生成端口（有 key 才建；没 key 就退化成规则生成，**不是错误**）
    const logStore = envBuildLogStoreFromEnv();
    const generator = resolveGenerator(args.noModel);
    if (generator === null) console.log("没有模型：只用规则生成的 Dockerfile（自愈不可用）");

    // ---- 环境子系统（队列 + 运行时 + 日志落点）：与 `agent:run` 走**同一套装配**。
    // 体检沙箱用一个**不带归档**的 manager（见 health-sandbox.ts）。
    const provider = new LocalDockerProvider();
    const subsystem = createEnvironmentSubsystem({
      db,
      projectKey,
      cloneDir: localPath,
      healthManager: new SandboxManager({ db, provider, image: "", log }),
      api: new SandboxApiClient(),
      repo: { url: localPath, commit: startCommit, token: async () => null },
      logStore,
      builder: new DockerBuildRunner({ logStore, log }),
      generator,
      repoDir: REPO_DIR,
      timeoutMs: args.timeoutMs,
      health: !args.noHealth,
      log,
    });
    const runtime = subsystem.runtime;
    const inferred = await runtime.infer();
    console.log(
      `推断完成：level=${inferred.candidate.level} base=${inferred.candidate.baseImage} ` +
        `语言=${inferred.signals.languages.join(",") || "（无）"} cache=${inferred.cacheKey.slice(0, 12)}`,
    );
    for (const note of inferred.candidate.notes) console.log(`  · ${note}`);

    const started = Date.now();
    if (args.promote !== null) {
      // promote（设计文档 §C.5）：把一份（会话里验证有效的）Dockerfile 固化成项目级新一版。
      const dockerfile = await readFile(args.promote, "utf8");
      console.log(`promote ${args.promote}（trigger=promote）…`);
      const promoted = await runtime.promote(dockerfile);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      if (promoted.cacheHit) {
        console.log(`✓ 这份文本的产物已经在库里：直接指到 revision ${promoted.revision}（用时 ${elapsed}s）`);
      } else if (promoted.outcome?.ok === true) {
        console.log(`✓ 已固化为 revision ${promoted.revision}：${promoted.outcome.imageDigest}（用时 ${elapsed}s）`);
      } else {
        console.log(`✗ promote 的构建失败：${promoted.outcome?.errorClass ?? "未知"}——${promoted.outcome?.detail ?? ""}`);
        process.exitCode = 1;
      }
      await printHistory({ db, projectKey, revision: promoted.revision, logStore });
      return;
    }

    console.log(`${args.rebuild ? "显式重建" : "缓存优先构建"}（trigger=${args.trigger}）…`);
    const attempt = args.rebuild
      ? await runtime.rebuild(args.trigger)
      : await runtime.buildIfNeeded(args.trigger);
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    if (attempt.cacheHit) {
      console.log(`✓ 缓存命中：复用 revision ${attempt.revision} 的镜像（不构建、不体检，用时 ${elapsed}s）`);
    } else if (attempt.outcome?.ok) {
      console.log(`✓ 构建成功：${attempt.outcome.imageDigest}（${attempt.outcome.attempts} 轮，用时 ${elapsed}s）`);
    } else {
      console.log(`✗ 构建失败：${attempt.outcome?.attempts ?? 0} 轮，${attempt.outcome?.errorClass ?? "未知"}——${attempt.outcome?.detail ?? ""}`);
      process.exitCode = 1;
    }

    await printHistory({ db, projectKey, revision: attempt.revision, logStore });
  } finally {
    await db.close();
  }
}

/**
 * 分轮次的结果与体检结论：这是"人工验收"要看的东西（人类可读）。
 * 做成自由函数而不是 `main` 里的闭包：它用的是"哪一次尝试 + 落库后的行"，与 `main` 的其余
 * 状态（参数、子系统、模型）没有关系。
 */
async function printHistory(input: {
  db: Db;
  projectKey: string;
  revision: number;
  logStore: BuildLogStore;
}): Promise<void> {
  const { db, projectKey, revision, logStore } = input;
  for (const row of await listEnvBuilds(db, projectKey, revision)) {
    const duration = row.duration_ms === null ? "?" : `${(row.duration_ms / 1000).toFixed(1)}s`;
    console.log(
      `  第 ${row.attempt} 轮：${row.status}（${row.inference}） ${duration}` +
        `${row.error_class === null ? "" : ` ${row.error_class}`}` +
        `${row.log_key === null ? "" : ` 日志=${row.log_key}`}`,
    );
  }
  const rows = await listEnvironments(db, projectKey, 12);
  const current = await getProjectEnvState(db, projectKey);
  const head = rows.find((row) => row.revision === revision) ?? rows[0];
  if (head !== undefined) {
    console.log(
      `  这一版：revision ${head.revision}（父 ${head.parent_revision ?? "—"}） status=${head.status}` +
        `${head.health_reason === null ? "" : ` 原因=${head.health_reason}`}`,
    );
    const report = head.health as { facts?: Array<{ detail: string }>; steps?: Array<{ cmd: string; exitCode: number | null }> };
    for (const step of report.steps ?? []) console.log(`    体检步骤 ${step.cmd} → 退出码 ${step.exitCode}`);
    for (const fact of report.facts ?? []) console.log(`    事实：${fact.detail}`);
    if (head.health_log_key !== null) console.log(`    体检日志=${head.health_log_key}`);
  }
  console.log(`  当前 revision：${current?.current_revision ?? "（未设置）"}｜历史共 ${rows.length} 版（保留最近 10 版）`);
  if (logStore instanceof FileBuildLogStore) console.log(`  日志目录：${logStore.root}`);
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

/** 本地仓库的 HEAD（`--local` 的起点 commit）。 */
function hostGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(" ")} 失败（exit ${code}）：${stderr.trim()}`));
    });
  });
}

main().catch((error: unknown) => {
  console.error(`[env-build] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
