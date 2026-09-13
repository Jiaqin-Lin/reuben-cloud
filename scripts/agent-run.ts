/**
 * Phase 11 · 手工验收：给一个真实 issue，产出一个 patch（spec §K 第 9 步）。
 *
 * 这不是产品代码，是把已经存在的零件按生产顺序串起来的一次性驱动：
 *   建沙箱 → clone → 灌入 → 跑 agent 循环 → 取 diff → 落 patch → 销毁沙箱
 * 每一步用的都是 `docs/sandbox-spec.md` 里那几个 Phase 的实现（manager / repo / agent），
 * 所以它同时是"这些零件能不能拼起来"的验证。
 *
 * 【用法】
 *   # 先起依赖：Postgres（状态机）+ MinIO（可选，存 transcript 与产出）
 *   npm run dev:up && export DATABASE_URL=$(npm run --silent db:url)
 *   export ANTHROPIC_API_KEY=sk-...
 *   npm run build:image                       # 沙箱镜像（第一次要跑）
 *   npm run proxy:up                          # 出网代理：模型要装依赖时用它
 *
 *   # 本地仓库（最省事，不需要 GitHub App）
 *   node scripts/agent-run.ts --local ~/code/my-project --base HEAD \
 *     --issue "npm test 里 login.spec.ts 的第三条用例失败了，修好它"
 *
 *   # GitHub 仓库（需要 GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_PATH / GITHUB_APP_INSTALLATION_ID）
 *   node scripts/agent-run.ts --repo owner/name --issue-file issue.md
 *
 *   # 看它到底干了什么：--keep 留着沙箱（可以 docker exec 进去看），
 *   # transcript 在 /tmp/reuben-cloud-cp/<runId>/transcript.jsonl
 *
 * 【它不做的事】不 commit、不 push、不建 PR —— 那些是 Phase 12。这里只产出 patch。
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { SandboxApiClient } from "../packages/control-plane/src/client/sandbox-api.ts";
import { Db } from "../packages/control-plane/src/db/client.ts";
import { runMigrations } from "../packages/control-plane/src/db/migrate.ts";
import { SandboxManager } from "../packages/control-plane/src/manager/sandbox-manager.ts";
import { LocalDockerProvider } from "../packages/control-plane/src/provider/local-docker.ts";
import { EgressProxy } from "../packages/control-plane/src/provider/egress-proxy.ts";
import { artifactStoreFromEnv } from "../packages/control-plane/src/artifacts/store.ts";
import { cloneRepo, removeRunDir } from "../packages/control-plane/src/repo/clone.ts";
import { githubCloneUrl, GithubAppCredentials, parseRepoRef } from "../packages/control-plane/src/repo/github-app.ts";
import { injectRepo } from "../packages/control-plane/src/repo/inject.ts";
import { anthropicFromEnv, maxTokensFromEnv } from "../packages/control-plane/src/agent/model.ts";
import { runAgentLoop } from "../packages/control-plane/src/agent/loop.ts";
import { Transcript } from "../packages/control-plane/src/agent/transcript.ts";
import { REPO_DIR, buildSystemPrompt } from "../packages/control-plane/src/agent/prompt.ts";
import { createToolkit } from "../packages/control-plane/src/agent/tools/index.ts";
import { consoleLog } from "../packages/control-plane/src/log.ts";
import { prefixedId } from "../packages/control-plane/src/ulid.ts";
import { resolveImageRef } from "../packages/control-plane/test/support.ts";

const log = consoleLog("agent-run");

interface Args {
  local: string | null;
  repo: string | null;
  issue: string;
  base: string | null;
  out: string;
  keep: boolean;
  maxTurns: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    local: null,
    repo: null,
    issue: "",
    base: null,
    out: "agent-patch.diff",
    keep: false,
    maxTurns: 40,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${current} 后面要跟一个值`);
      index += 1;
      return value;
    };
    switch (current) {
      case "--local":
        args.local = next();
        break;
      case "--repo":
        args.repo = next();
        break;
      case "--issue":
        args.issue = next();
        break;
      case "--issue-file":
        args.issue = readIssueFile(next());
        break;
      case "--base":
        args.base = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--max-turns":
        args.maxTurns = Number(next());
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`不认识的参数：${current}`);
    }
  }
  if (args.local === null && args.repo === null) throw new Error("必须给 --local 或 --repo");
  if (args.issue.trim() === "") throw new Error("必须给 --issue 或 --issue-file");
  return args;
}

function printUsage(): void {
  console.log(`用法：
  node scripts/agent-run.ts --local <仓库路径> --issue "<issue 正文>" [--base <sha>]
  node scripts/agent-run.ts --repo <owner/name> --issue-file <文件> [--base <sha>]

选项：
  --out <文件>       patch 落点（默认 agent-patch.diff）
  --max-turns <n>    轮数上限（默认 40）
  --keep             跑完不销毁沙箱（排障用）

环境：
  DATABASE_URL              必填（npm run dev:up && npm run db:url）
  ANTHROPIC_API_KEY         必填（只在 CP 里）
  REUBEN_CLOUD_MODEL        可选，默认 claude-opus-4-8
  SANDBOX_IMAGE             可选，默认 reuben-cloud/sandbox-base:dev
  S3_ENDPOINT/S3_BUCKET/…   可选，给了就把 transcript 与产出上传`);
}

/** 读 issue 文件（同步：参数解析阶段，失败就直接把用法打出来退出）。 */
function readIssueFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`读不了 issue 文件 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function hostGit(args: string[], cwd?: string): Promise<string> {
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("缺 DATABASE_URL（先 npm run dev:up，再 export DATABASE_URL=$(npm run --silent db:url)）");
  }

  const runId = prefixedId("run");
  const image = await resolveImageRef(process.env["SANDBOX_IMAGE"] ?? "reuben-cloud/sandbox-base:dev");
  const store = artifactStoreFromEnv();
  const db = new Db({ connectionString: databaseUrl });
  await runMigrations(db);

  // 出网代理：模型要装依赖时才需要。装不上就记一条警告继续——本地仓库 + 已有依赖
  // 的场景不需要它，为它中断一次真实 Run 不值。
  try {
    const proxy = new EgressProxy({
      allowlistPath: path.resolve("deploy/egress-proxy/allowlist.txt"),
      image: process.env["EGRESS_PROXY_IMAGE"] ?? "reuben-cloud/egress-proxy:dev",
      log: (level, message, details) => log(level, message, details),
    });
    const status = await proxy.ensureRunning();
    log("info", `出网代理就绪（${status.containerName}）`);
  } catch (error) {
    log("warn", `出网代理没起来，沙箱内装依赖会失败（npm run proxy:up 可以修）`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const provider = new LocalDockerProvider();
  const manager = new SandboxManager({
    db,
    provider,
    image,
    ...(store === null ? {} : { artifacts: { store } }),
    log,
  });

  const sandbox = await manager.createSandbox({ runId });
  log("info", `沙箱就绪：${sandbox.sandboxId}`, { endpoint: sandbox.endpoint });
  const target = { endpoint: sandbox.endpoint!, authToken: sandbox.authToken!, sandboxId: sandbox.sandboxId };

  let patchPath: string | null = null;
  let summary: string | null = null;
  try {
    // ---- clone
    const remote =
      args.local === null
        ? await githubRemoteFor(args.repo!)
        : { url: path.resolve(args.local), token: null };
    const base =
      args.base ??
      (args.local === null
        ? "HEAD"
        : (await hostGit(["rev-parse", "HEAD"], path.resolve(args.local))).trim());
    const clone = await cloneRepo({
      runId,
      url: remote.url,
      commit: base,
      token: remote.token,
      log: (level, message, details) => log(level, message, details),
    });
    log("info", `仓库已 clone（base ${clone.baseSha.slice(0, 12)}）`, { dir: clone.dir });

    // ---- 灌进沙箱（仓库落在 /workspace/repo：工具层与提示词都按这个路径说话）
    const injected = await injectRepo({ api: new SandboxApiClient(), target, clone, log });
    log("info", `仓库已灌入沙箱（${injected.bytes} 字节，HEAD ${injected.headSha.slice(0, 12)}）`);

    // ---- 跑循环
    const api = new SandboxApiClient();
    const transcript = await Transcript.create({ runId, log });
    const toolkit = createToolkit({ sandboxId: sandbox.sandboxId, exec: manager, api, target, log });
    const model = anthropicFromEnv();
    const textChunks: string[] = [];
    log("info", `agent 开始（model=${model.model}，maxTurns=${args.maxTurns}）`);

    const result = await runAgentLoop({
      model,
      tools: toolkit,
      transcript,
      issue: args.issue,
      system: buildSystemPrompt(),
      maxTurns: args.maxTurns,
      maxTokens: maxTokensFromEnv(),
      onText: (delta) => {
        textChunks.push(delta);
        process.stdout.write(delta);
      },
      log,
    });
    if (textChunks.length > 0) process.stdout.write("\n");

    // ---- 产出：diff → patch 文件
    const diff = await api.diff(target.endpoint, target.authToken, { base: clone.baseSha, path: REPO_DIR });
    const patch =
      diff.truncated && diff.patchLogPath !== null
        ? await readStream(await api.readRaw(target.endpoint, target.authToken, diff.patchLogPath))
        : Buffer.from(diff.patch ?? "", "utf8");
    const outPath = path.resolve(args.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, patch);
    patchPath = outPath;

    // ---- transcript 上传（配了对象存储才做）
    if (store !== null) {
      const stored = await transcript.upload(store);
      log("info", `transcript 已上传：${stored.objectKey}（${stored.sizeBytes} 字节）`);
    }

    summary = [
      "",
      "──────────── 结果 ────────────",
      `Run            ${runId}`,
      `挂起原因       ${result.stopReason}（${result.detail}）`,
      `轮数 / 工具调用 ${result.turns} / ${result.toolCalls}`,
      `用量           in=${result.usage.inputTokens} out=${result.usage.outputTokens} ` +
        `cache_read=${result.usage.cacheReadInputTokens} cache_write=${result.usage.cacheCreationInputTokens}`,
      `改动的文件     ${diff.files.length} 个（+${sum(diff.files.map((file) => file.additions))} / -${sum(diff.files.map((file) => file.deletions))}）`,
      `patch          ${outPath}（${patch.length} 字节）`,
      `transcript     ${transcript.path}`,
      `沙箱           ${args.keep ? `保留着：${sandbox.sandboxId}（用完自己 destroy）` : "即将销毁"}`,
      "──────────────────────────────",
    ].join("\n");
  } finally {
    if (!args.keep) {
      try {
        const report = await manager.destroySandbox(sandbox.sandboxId, "agent_run_finished");
        log("info", `沙箱已销毁（归档：${report.archive === null ? "未启用" : JSON.stringify(report.archive.failedStep ?? "ok")}）`);
      } catch (error) {
        log("error", `销毁沙箱失败（留给 sweeper / 对账处理）`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await removeRunDir(runId).catch(() => undefined);
    await db.close();
    store?.close();
  }

  if (summary !== null) console.log(summary);
  if (patchPath === null) process.exitCode = 1;
}

/** GitHub 模式下现签一个限定到单仓的 installation token（只在 CP 内存里用一次）。 */
async function githubRemoteFor(repoInput: string): Promise<{ url: string; token: string | null }> {
  const ref = parseRepoRef(repoInput);
  const credentials = await GithubAppCredentials.fromEnv();
  const token = await credentials.tokenFor(ref);
  return { url: githubCloneUrl(ref), token: token.token };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

await main().catch((error: unknown) => {
  console.error(`\n失败：${error instanceof Error ? error.message : String(error)}`);
  // 堆栈只在显式要的时候打：这里的失败绝大多数是配置/网络/API 错误，
  // 它们的 message 已经说清了原因，一串 CP 内部的调用栈只会盖住它。
  if (process.env["RC_AGENT_DEBUG"] === "1" && error instanceof Error && error.stack !== undefined) {
    console.error(error.stack);
  }
  process.exit(1);
});
