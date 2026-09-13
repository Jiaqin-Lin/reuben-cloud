/**
 * Phase 11/12 · 手工验收：给一个真实 issue，跑完产出一个 patch（或一条 PR）。
 * Phase 13 · 加上 `--serve` 之后，同一个进程里起一个观察窗：浏览器能看到这次 Run 的实时流。
 *
 * 这不是产品代码，是把已经存在的零件按生产顺序串起来的一次性驱动：
 *   建沙箱 → clone → 灌入 → 跑 agent 循环 → 验证 → 取改动 → （可选）commit + push + PR → 销毁沙箱
 * 每一步用的都是 `docs/sandbox-spec.md` 里那几个 Phase 的实现（manager / repo / agent），
 * 而"取改动之后怎么办"那一段与集成测试共用 `agent/run.ts` 的 `finishRun()`——
 * 脚本与测试走同一条生产路径，才不会出现"手工能跑、测试测的是另一份"的漂移。
 *
 * 【用法】
 *   # 先起依赖：Postgres（状态机）+ MinIO（可选，存 transcript 与产出）
 *   npm run dev:up && export DATABASE_URL=$(npm run --silent db:url)
 *   # 模型凭据写在仓库根的 .env（npm run agent:run 会自动读它）
 *   #   DEEPSEEK_API_KEY=sk-...  REUBEN_CLOUD_PROVIDER=deepseek  REUBEN_CLOUD_MODEL=deepseek-flash
 *   npm run build:image                       # 沙箱镜像（第一次要跑）
 *   npm run proxy:up                          # 出网代理：模型要装依赖时用它
 *
 *   # ① 本地仓库 → 只产一个 patch（最省事，不需要 GitHub App）
 *   node scripts/agent-run.ts --local ~/code/my-project --base HEAD \
 *     --verify "npm test" \
 *     --issue "npm test 里 login.spec.ts 的第三条用例失败了，修好它"
 *
 *   # ② GitHub 仓库 → 一条 draft PR（需要 GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_PATH /
 *   #    GITHUB_APP_INSTALLATION_ID；同一个 --task-id 重跑会更新同一条 PR）
 *   node scripts/agent-run.ts --repo owner/name --issue-file issue.md \
 *     --verify "npm test" --pr
 *
 *   # 看它到底干了什么：--keep 留着沙箱（可以 docker exec 进去看），
 *   # transcript 在 /tmp/reuben-cloud-cp/<runId>/transcript.jsonl
 *
 *   # ③ 一边跑一边看（Phase 13）：打开它打印的地址，刷新页面能看到到目前为止的全部事件
 *   node scripts/agent-run.ts --local ~/code/my-project --issue "..." --serve
 *
 *   # ④ 调试压缩（Phase 3）：第一次轮次准备时强制压一次（不看阈值）
 *   node scripts/agent-run.ts --local ~/code/my-project --issue "..." --compact
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
import { OctokitPullRequestApi } from "../packages/control-plane/src/repo/pr.ts";
import { maxTokensFromEnv, modelFromEnv, buildContextEntries, exportSession } from "@reuben-cloud/agent-runtime";
import type { AgentMessage, StoredSession } from "@reuben-cloud/agent-runtime";
import { runAgentLoop } from "../packages/control-plane/src/agent/run.ts";
import { finishRun, taskIdForIssue } from "../packages/control-plane/src/agent/run.ts";
import { Transcript } from "../packages/control-plane/src/agent/transcript.ts";
import { PostgresSessionStore } from "../packages/control-plane/src/session/postgres.ts";
import { RequestRecorder } from "../packages/control-plane/src/session/requests.ts";
import { EntryRecorder } from "../packages/control-plane/src/session/entry-recorder.ts";
import { createSessionCompaction } from "../packages/control-plane/src/session/compaction.ts";
import { runStatusFor } from "../packages/control-plane/src/session/session-run.ts";
import { branchNameForTask } from "../packages/control-plane/src/repo/push.ts";
import { REPO_DIR, buildSystemPrompt } from "@reuben-cloud/agent-runtime";
import { createSandboxToolkit } from "../packages/control-plane/src/agent/sandbox-operations.ts";
import { RunHub } from "../packages/control-plane/src/web/hub.ts";
import type { WebServer } from "../packages/control-plane/src/web/server.ts";
import { startWebServer } from "../packages/control-plane/src/web/server.ts";
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
  taskId: string | null;
  attempt: number;
  baseBranch: string | null;
  verify: string | null;
  pr: boolean;
  draft: boolean;
  keep: boolean;
  serve: boolean;
  port: number | null;
  maxTurns: number;
  /** 续用已有会话（Phase 2 的会话是长期实体；不给就新建一个）。 */
  session: string | null;
  /** 导出整个会话的 JSONL（跨 Run，兼容 M0 的 transcript 记录类型）。 */
  exportPath: string | null;
  /** `--compact [n]`：在第 n 次轮次准备时强制压缩一次（默认 1 = 第一轮之后）。 */
  compactAfterTurn: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    local: null,
    repo: null,
    issue: "",
    base: null,
    out: "agent-patch.diff",
    taskId: null,
    attempt: 1,
    baseBranch: null,
    verify: null,
    pr: false,
    draft: true,
    keep: false,
    serve: false,
    port: null,
    maxTurns: 40,
    session: null,
    exportPath: null,
    compactAfterTurn: null,
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
      case "--task-id":
        args.taskId = next();
        break;
      case "--attempt":
        args.attempt = parsePositiveInt(current, next());
        break;
      case "--base-branch":
        args.baseBranch = next();
        break;
      case "--verify":
        args.verify = next();
        break;
      case "--pr":
        args.pr = true;
        break;
      case "--draft":
        args.draft = true;
        break;
      case "--no-draft":
        args.draft = false;
        break;
      case "--max-turns":
        args.maxTurns = parsePositiveInt(current, next());
        break;
      case "--serve":
        args.serve = true;
        break;
      case "--port":
        args.port = parsePositiveInt(current, next());
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--session":
        args.session = next();
        break;
      case "--export":
        args.exportPath = next();
        break;
      case "--compact": {
        // 可选值：`--compact`（在第一轮之后）或 `--compact 3`（第 3 次轮次准备时）。
        const value = argv[index + 1];
        if (value !== undefined && /^\d+$/.test(value)) {
          index += 1;
          args.compactAfterTurn = parsePositiveInt(current, value);
        } else {
          args.compactAfterTurn = 1;
        }
        break;
      }
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
  // PR 只能建在真远端上：`--local` 的 remote 是宿主目录，没有地方建 PR（也推不上去）。
  if (args.pr && args.repo === null) throw new Error("--pr 只支持 --repo（本地仓库没有远端可以建 PR）");
  return args;
}

function parsePositiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} 必须是正整数，收到 ${raw}`);
  return value;
}

function printUsage(): void {
  console.log(`用法：
  node scripts/agent-run.ts --local <仓库路径> --issue "<issue 正文>" [选项]
  node scripts/agent-run.ts --repo <owner/name> --issue-file <文件> [--pr] [选项]

选项：
  --out <文件>          patch 落点（默认 agent-patch.diff）
  --verify <命令>       在沙箱里跑的验证命令（shell 字符串，结果写进 PR 正文）
  --pr                  commit + push + 建/更新 draft PR（需要 GitHub App 凭据）
  --task-id <id>        同一个 Task 固定一条分支/一条 PR（默认按 issue 内容算一个稳定的 id）
  --attempt <n>         第几次尝试（写进 commit 与 PR 正文，默认 1）
  --base-branch <名>    PR 的 base（默认问 GitHub / 本地取当前分支）
  --no-draft            PR 不用 draft（默认 draft）
  --max-turns <n>       轮数上限（默认 40）
  --session <id>        续用已有会话（默认新建；续用会从会话的分支 head 接上）
  --export <文件>       把整个会话导出成 JSONL（跨 Run；--keep 时默认导出一份）
  --compact [n]         在第 n 次轮次准备时强制压缩一次（调试/验证用；默认 1 = 第一轮之后）
  --serve               同时起本地观察窗（SSE 实时 transcript，默认 127.0.0.1:8787）
  --port <n>            观察窗端口（默认 8787；--serve 才有意义）
  --keep                跑完不销毁沙箱（排障用）

环境：
  DATABASE_URL              必填（npm run dev:up && npm run db:url）
  DEEPSEEK_API_KEY          模型凭据（或 ANTHROPIC_API_KEY；两个都有时用 REUBEN_CLOUD_PROVIDER 选）
  REUBEN_CLOUD_PROVIDER     anthropic | deepseek（默认看 key / 模型名前缀）
  REUBEN_CLOUD_MODEL        可选，默认 deepseek-flash / claude-opus-4-8
  GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY_PATH   --pr 必填
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
  // `--task-id` 的缺省规则在 `agent/run.ts`（脚本 import 即执行，放这里测不了）。
  const taskId = args.taskId ?? taskIdForIssue(args.issue);

  const image = await resolveImageRef(process.env["SANDBOX_IMAGE"] ?? "reuben-cloud/sandbox-base:dev");
  const store = artifactStoreFromEnv();
  const db = new Db({ connectionString: databaseUrl });
  await runMigrations(db);
  // ---- Phase 2：会话存储。脚本是**单轮的手工验收驱动**，但它落的账与产品路径
  // （`handleUserMessage`）是同一套表——不然"手工跑能落库"就只是一句空话。
  const sessionStore = new PostgresSessionStore(db);

  // ---- Phase 13 的观察窗。**在跑任何东西之前先起来**：这样 clone / 沙箱 / 循环
  // 任何一段出问题，浏览器里都能看到（`run_error` 事件就是给这条路径的）。
  // P4 起把 `sessionStore` 也给它：页面默认渲染会话视图（读 `session_entries`），
  // 而不是只看这一次执行的实时流。
  // 起不来的话只警告（端口被占不该阻断一次 Run）。
  const hub = args.serve ? new RunHub({ log }) : null;
  let web: WebServer | null = null;
  if (hub !== null) {
    try {
      web = await startWebServer({ hub, store: sessionStore, ...(args.port === null ? {} : { port: args.port }), log });
      log("info", `观察窗：${web.url}/runs/${runId}（跑完仍然保留，Ctrl-C 退出）`);
    } catch (error) {
      log("warn", `观察窗没起来（端口被占？），这次 Run 没有实时 transcript`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const events = hub?.ensure(runId);

  // ---- GitHub 凭据（只有 --repo 才可能需要：clone 与 PR 都用它）
  const ref = args.repo === null ? null : parseRepoRef(args.repo);
  const credentials = ref === null ? null : await GithubAppCredentials.fromEnv();
  const freshToken = async (): Promise<string> => (await credentials!.tokenFor(ref!)).token;

  // ---- 出网代理：模型要装依赖时才需要。装不上就记一条警告继续——本地仓库 + 已有依赖
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
    // `repoPath` 必须给：agent 流程把仓库解到 `/workspace/repo`，而归档的 `/diff` 缺省对着
    // workspace 根——那时它会回 `not_a_git_repository`，于是 diff 永远不落对象存储
    // （只降级成一条 warning，不会阻断销毁，所以很容易一直没人发现）。
    ...(store === null ? {} : { artifacts: { store, repoPath: REPO_DIR } }),
    log,
  });

  // ---- Phase 2：会话存储（在观察窗那段之前已经建好；这里只剩工具与请求记录器）
  const requests = new RequestRecorder({ store: sessionStore, artifactStore: store, log });
  const api = new SandboxApiClient();

  // ---- clone（**先于沙箱**：会话需要一个起点 commit，沙箱要从它灌）
  const remote =
    args.local === null
      ? { url: githubCloneUrl(ref!), token: await freshToken() }
      : { url: path.resolve(args.local), token: null };
  const branch = branchNameForTask(taskId);

  // 续用已有会话：从它当前的分支 head 接上（不是原始 base——这正是热复用/重建的语义）。
  const resumed = args.session === null ? null : await requireSession(sessionStore, args.session);
  const baseCommit =
    resumed !== null
      ? (resumed.headCommit ?? resumed.baseCommit)
      : args.base ??
        (args.local === null
          ? "HEAD"
          : (await hostGit(["rev-parse", "HEAD"], path.resolve(args.local))).trim());
  const clone = await cloneRepo({
    runId,
    url: remote.url,
    commit: baseCommit,
    token: remote.token,
    log: (level, message, details) => log(level, message, details),
  });
  log("info", `仓库已 clone（base ${clone.baseSha.slice(0, 12)}）`, { dir: clone.dir });

  const session =
    resumed !== null
      ? resumed
      : await requireSession(
          sessionStore,
          (
            await sessionStore.createSession({
              repoKey:
                ref === null ? `local/${path.basename(path.resolve(args.local!))}` : `${ref.owner}/${ref.repo}`,
              baseCommit: clone.baseSha,
              cwd: REPO_DIR,
              taskId,
              headRef: branch,
              headCommit: clone.baseSha,
              title: firstLine(args.issue),
            })
          ).id,
        );
  log("info", `会话就绪：${session.id}${resumed === null ? "（新建）" : "（续用）"}`, {
    baseCommit: clone.baseSha,
    headCommit: session.headCommit,
  });

  // ---- 沙箱。归属**会话**（`sandboxes.session_id`）。
  const sandbox = await manager.createSandbox({
    runId,
    sessionId: session.id,
    ...(session.taskId === null ? {} : { taskId: session.taskId }),
  });
  await sessionStore.setSessionSandbox(session.id, { sandboxId: sandbox.sandboxId, at: new Date() });
  log("info", `沙箱就绪：${sandbox.sandboxId}`, { endpoint: sandbox.endpoint });
  const target = { endpoint: sandbox.endpoint!, authToken: sandbox.authToken!, sandboxId: sandbox.sandboxId };

  let patchPath: string | null = null;
  let summary: string | null = null;
  let exportPath: string | null = null;
  let writtenLeaf: string | null = session.leafEntryId;
  try {
    // ---- 灌进沙箱（仓库落在 /workspace/repo：工具层与提示词都按这个路径说话）
    // 【workspaceDir 必须显式传】它缺省是 workspace 根，而 Phase 11 起工具层的相对路径
    // 按 `REPO_DIR`（/workspace/repo）解析、`GET /diff?path=` 也只看那里。不传的话仓库被解到
    // `/workspace`，模型只能靠绝对路径"绕"过去，而最后取 diff 会以 `spawn_failed` 失败——
    // 这条是 §K 第 9 步手工验收第一次真跑时抓到的。
    const injected = await injectRepo({ api, target, clone, workspaceDir: REPO_DIR, log });
    log("info", `仓库已灌入沙箱（${injected.bytes} 字节，HEAD ${injected.headSha.slice(0, 12)}）`);

    // ---- 跑循环。带观察窗时，文字增量同时进 stdout 与事件流（Phase 13）。
    const transcript = await Transcript.create({ runId, log });
    const toolkit = createSandboxToolkit({
      sandboxId: sandbox.sandboxId,
      exec: manager,
      api,
      target,
      repoDir: REPO_DIR,
      ...(events === undefined ? {} : { events }),
      log,
    });
    const model = modelFromEnv();
    log("info", `agent 开始（model=${model.model}，maxTurns=${args.maxTurns}）`);

    // ---- 会话记账（Phase 2）：一次执行 + 每条消息/用量/工具调用。
    await sessionStore.startRun({
      id: runId,
      sessionId: session.id,
      sandboxId: sandbox.sandboxId,
      startEntryId: session.leafEntryId,
      provider: model.provider,
      model: model.model,
    });
    const history = buildContextEntries(await sessionStore.listEntries(session.id));
    const prompts: AgentMessage[] | null =
      history.length === 0 ? null : [{ role: "user", content: args.issue }];
    const recorder = new EntryRecorder({
      store: sessionStore,
      sessionId: session.id,
      runId,
      provider: model.provider,
      model: model.model,
      leafEntryId: session.leafEntryId,
      onActivity: () => sessionStore.touchSession(session.id),
      log,
    });
    const compaction = createSessionCompaction({
      store: sessionStore,
      sessionId: session.id,
      runId,
      model,
      appendCompaction: (input) => recorder.appendCompaction(input.payload, input.usage),
      ...(args.compactAfterTurn === null ? {} : { forceAtTurn: args.compactAfterTurn }),
      log,
    });

    const result = await runAgentLoop({
      model,
      tools: recorder.wrapTools(toolkit.tools),
      transcript,
      issue: args.issue,
      // 观察窗的会话视图靠它找到这个会话的 entries（P4）。
      sessionId: session.id,
      history,
      ...(prompts === null ? {} : { prompts }),
      system: buildSystemPrompt(),
      maxTurns: args.maxTurns,
      maxTokens: maxTokensFromEnv(model.model),
      // 压缩（P3）：与产品路径同一份构造（`createSessionCompaction`），只是强制轮次可配。
      prepareNextTurn: (turn) => compaction.prepareNextTurn(turn),
      recoverFromModelError: (turn) => compaction.recoverFromModelError(turn),
      ...(events === undefined ? {} : { events }),
      // 终端里那一段人读的输出与观察窗是两条路：观察窗从 `message_update` 事件拿增量，
      // 这里只负责写 stdout（P4 起不再手动往 sink 里塞一条 `text`）。
      onText: (delta) => process.stdout.write(delta),
      onAgentEvent: (event) => recorder.onAgentEvent(event),
      onRequest: async (info) => {
        await sessionStore.touchSession(session.id);
        await requests.record({
          sessionId: session.id,
          runId,
          turn: info.turn,
          system: info.system,
          messages: info.messages,
          tools: info.tools,
        });
      },
      log,
    });
    if (result.usage.outputTokens > 0) process.stdout.write("\n");

    writtenLeaf = recorder.leafEntryId;
    await sessionStore.endRun(runId, {
      status: runStatusFor(result.stopReason),
      stopReason: result.stopReason,
      endEntryId: writtenLeaf,
      sandboxId: sandbox.sandboxId,
    });
    await sessionStore.updateSessionHead(session.id, { leafEntryId: writtenLeaf });
    await recorder.interruptRemaining();

    // ---- transcript 上传（配了对象存储才做；PR 正文里要放它的位置）
    let transcriptUrl: string | null = null;
    if (store !== null) {
      const stored = await transcript.upload(store);
      transcriptUrl = `s3://${store.bucket}/${stored.objectKey}`;
      log("info", `transcript 已上传：${stored.objectKey}（${stored.sizeBytes} 字节）`);
    }

    // ---- 收尾：验证 → 取改动 → （PR 或 patch）。脚本与集成测试共用 `finishRun()`。
    const baseBranch =
      args.baseBranch ?? (ref === null ? await localBranchOf(args.local!) : await defaultBranchOf(ref, credentials!));
    const finished = await finishRun({
      api,
      target,
      clone,
      run: result,
      issue: args.issue,
      taskId,
      runId,
      model: model.model,
      sandboxId: sandbox.sandboxId,
      repoDir: REPO_DIR,
      verify: args.verify === null ? null : { cmd: ["bash", "-lc", args.verify] },
      patchOut: args.out,
      publish:
        args.pr && ref !== null && credentials !== null
          ? {
              ref,
              remoteUrl: githubCloneUrl(ref),
              baseBranch,
              taskTitle: firstLine(args.issue),
              token: freshToken,
              draft: args.draft,
              attempt: args.attempt,
              transcriptUrl,
              retry: { log },
            }
          : null,
      log,
    });
    patchPath = finished.patchFile;

    // 推上去了才更新会话的 head（没有 PR/patch 以外的情况：head_commit 只在"冷启动重建"时用）。
    if (finished.published !== null) {
      await sessionStore.updateSessionHead(session.id, {
        leafEntryId: writtenLeaf,
        headRef: finished.published.push.branch,
        headCommit: finished.published.push.commitSha,
      });
    }

    const published = finished.published;
    summary = [
      "",
      "──────────── 结果 ────────────",
      `Run            ${runId}`,
      `Session        ${session.id}${resumed === null ? "（新建）" : "（续用）"}`,
      `Task           ${taskId}`,
      `挂起原因       ${result.stopReason}（${result.detail}）`,
      `轮数 / 工具调用 ${result.turns} / ${result.toolCalls}`,
      `用量           in=${result.usage.inputTokens} out=${result.usage.outputTokens} ` +
        `cache_read=${result.usage.cacheReadInputTokens} cache_write=${result.usage.cacheCreationInputTokens}`,
      `改动的文件     ${finished.changes.files.length} 个（+${sum(finished.changes.files.map((file) => file.additions))} / -${sum(finished.changes.files.map((file) => file.deletions))}）`,
      `改动来源       ${finished.changes.source}${finished.changes.fallbackReason === null ? "" : `（回退原因：${finished.changes.fallbackReason}）`}`,
      `验证           ${describeVerification(finished.verification)}`,
      `patch          ${patchPath ?? "（未写入）"}`,
      `transcript     ${transcript.path}`,
      ...(published === null
        ? ["PR             未创建（没有 --pr）"]
        : [
            `PR             #${published.pullRequest.number} ${published.created ? "（新建）" : "（更新）"} ${published.pullRequest.htmlUrl}`,
            `分支           ${published.push.branch} → ${baseBranch}`,
          ]),
      `沙箱           ${args.keep ? `保留着：${sandbox.sandboxId}（用完自己 destroy）` : "即将销毁"}`,
      "──────────────────────────────",
    ].join("\n");
  } catch (error) {
    // 循环之外的失败（clone / 沙箱 / GitHub）也要让观察窗看到一句人话，
    // 否则页面会一直停在“等第一个事件”（Phase 13 的失败模式）。
    events?.emit({
      type: "run_error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    // 会话的沙箱引用先清掉：脚本是单轮的，销毁之后会话不该还指着一个不存在的沙箱。
    await sessionStore
      .setSessionSandbox(session.id, { sandboxId: null, flushFailures: 0, flushFailedAt: null })
      .catch(() => undefined);
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
    // 导出整个会话的 JSONL（Phase 2 §7）。`--keep` 时自动导一份：
    // 留着沙箱排障的人，几乎总是也想看一眼这一轮的完整轨迹。
    const exportTarget = args.exportPath ?? (args.keep ? `session-${session.id}.jsonl` : null);
    if (exportTarget !== null) {
      try {
        const jsonl = await exportSession(sessionStore, session.id, {
          readSpilled: (objectKey) => requests.readSpilled(objectKey),
          log: (level, message, details) => log(level, message, details),
        });
        await writeFile(path.resolve(exportTarget), jsonl, "utf8");
        exportPath = path.resolve(exportTarget);
        log("info", `会话已导出：${exportPath}（${Buffer.byteLength(jsonl)} 字节）`);
      } catch (error) {
        log("error", `导出会话失败`, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    await removeRunDir(runId).catch(() => undefined);
    await db.close();
    store?.close();
  }

  if (summary !== null) console.log(summary);
  if (exportPath !== null) console.log(`导出的会话 JSONL：${exportPath}`);
  if (patchPath === null) process.exitCode = 1;

  // ---- 留着观察窗（Phase 13）：Run 结束了，但页面还能把整段过程读完。
  // 不 --serve 的话脚本的行为与以前完全一样（跑完就退）。
  if (web !== null) {
    console.log(`\n观察窗仍然在 ${web.url}/runs/${runId}（Ctrl-C 退出）`);
    await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
    await web.close();
    hub?.close();
  }
}

/** 续用会话时先确认它真的存在（`--session` 写错要早报，而不是跑一半才发现）。 */
async function requireSession(store: PostgresSessionStore, sessionId: string): Promise<StoredSession> {
  const session = await store.getSession(sessionId);
  if (session === null) throw new Error(`没有这个会话：${sessionId}`);
  return session;
}

/** issue 的第一行当题面（PR 标题 / commit message 用）。太长就截断。 */
function firstLine(issue: string, maxChars = 72): string {
  const line = issue.trim().split("\n")[0]!.trim();
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

/** 本地仓库的当前分支（`--local` 模式的 base）。detached HEAD 时退回报给 `main`。 */
async function localBranchOf(dir: string): Promise<string> {
  try {
    const branch = (await hostGit(["symbolic-ref", "--short", "HEAD"], path.resolve(dir))).trim();
    return branch === "" ? "main" : branch;
  } catch {
    return "main";
  }
}

/** 远端仓库的默认分支（PR 的 base）。**问 GitHub，不猜**：`main` 与 `master` 都可能。 */
async function defaultBranchOf(ref: { owner: string; repo: string }, credentials: GithubAppCredentials): Promise<string> {
  const token = (await credentials.tokenFor(ref)).token;
  return new OctokitPullRequestApi({ token }).getDefaultBranch(ref);
}

function describeVerification(verification: { passed: boolean; cmd: string[]; state: string; exitCode: number | null } | null): string {
  if (verification === null) return "没有跑（未提供 --verify）";
  const code = verification.exitCode === null ? verification.state : `exit ${verification.exitCode}`;
  return `${verification.passed ? "通过" : "没有通过"}：${verification.cmd.join(" ")}（${code}）`;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
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
