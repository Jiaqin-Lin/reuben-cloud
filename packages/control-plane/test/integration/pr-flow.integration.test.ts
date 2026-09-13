/**
 * Phase 12 的集成测试（`npm run test:integration`，**需要 Docker 与宿主 git**）。
 *
 * 【它测什么】`finishRun()` 这条收尾路径的完整形状——**真沙箱** + **真 smart-HTTP 远端**，
 * 只有 GitHub 本身是假的：
 *   沙箱里改代码 → 验证命令真跑 → `/diff` 取回并应用到 CP 的 clone → commit → force-with-lease
 *   push → 幂等地建/更新 PR
 *
 * 【为什么 GitHub 用假的，git 远端用真的】真 GitHub 需要 App 私钥（CI 里没有），而这条
 * 链路里唯一值得"真的"验的是**推上去了什么、推之前查了什么**：`startGitHttpServer()` 会
 * 校验 Authorization 头，`push.ts` 的 lease 是服务端行为——这两件事对着 `file://` 测
 * 等于没测。PR 那一侧的逻辑（幂等、draft、正文、限流、权限）在单测里用真列表的假 API
 * 跑完了；这里只断言"收尾流程把它们接对了"。真 GitHub 那一层在 `test/live/pr-live.live.ts`。
 *
 * 【为什么不用 Postgres】收尾流程不碰 DB（状态机是 Phase 8 的事），provider + agent HTTP
 * 就够了。少一个容器，这个文件跑起来快很多。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { SandboxApiClient } from "../../src/client/sandbox-api.ts";
import { LocalDockerProvider } from "../../src/provider/local-docker.ts";
import type { SandboxHandle } from "../../src/provider/types.ts";
import { cloneRepo, removeRunDir } from "../../src/repo/clone.ts";
import type { RepoClone } from "../../src/repo/clone.ts";
import { injectRepo } from "../../src/repo/inject.ts";
import { branchNameForTask } from "../../src/repo/push.ts";
import type { SandboxTarget } from "../../src/repo/types.ts";
import { REPO_DIR } from "../../src/agent/prompt.ts";
import { finishRun } from "../../src/agent/run.ts";
import type { AgentLoopResult } from "../../src/agent/loop.ts";
import {
  CleanupRegistry,
  createGitFixtureRepo,
  dockerAvailable,
  FakePullRequestApi,
  newSandboxId,
  resolveImageRef,
  run,
  startGitHttpServer,
} from "../support.ts";
import type { GitFixtureRepo, GitHttpServer } from "../support.ts";

/** fixture token：随机串，"磁盘上搜不到它"才是真的搜过（与 Phase 9 同一条理由）。 */
const TEST_TOKEN = `ghs_fixture_${randomBytes(12).toString("hex")}`;
const API = new SandboxApiClient();
const PROVIDER = new LocalDockerProvider();
const CLEANUP = new CleanupRegistry();

const sandboxId = newSandboxId();
let tempRoot = "";
let cpRoot = "";
let server: GitHttpServer;
let fixture: GitFixtureRepo;
let handle: SandboxHandle;
let target: SandboxTarget;
let image = "";

/** 沙箱里那个"模型改过"的文件内容。 */
const FIXED_MATH = "exports.add = (a, b) => a + b;\n";
const BUGGY_MATH = "exports.add = (a, b) => a - b;\n";

/** 一次 Run 的假结果：这里不跑真模型（那条在 agent-tools 的 `RUN_LIVE_AGENT=1` 里），
 * 但结果对象必须是真的——`finishRun` 要从它拿轮数、用量与结束原因写进 PR 正文。 */
function fakeRunResult(overrides: Partial<AgentLoopResult> = {}): AgentLoopResult {
  return {
    ok: true,
    stopReason: "end_turn",
    detail: "模型在第 4 轮正常收工",
    turns: 4,
    toolCalls: 6,
    finalText: "修好了",
    usage: { inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 900, cacheCreationInputTokens: 0 },
    messages: [],
    transcriptPath: "/tmp/reuben-cloud-cp/run_x/transcript.jsonl",
    transcriptFailure: null,
    ...overrides,
  };
}

/** 在沙箱里写一个文件（模拟模型的 write 工具）。 */
async function writeInSandbox(relative: string, content: string): Promise<void> {
  await API.putFile(
    target.endpoint,
    target.authToken,
    `${REPO_DIR}/${relative}`,
    Readable.from(Buffer.from(content, "utf8")),
  );
}

/** 从远端拉一份下来读某个文件（断言"推上去的与沙箱里验证过的是同一份"）。 */
async function readFromRemote(relative: string, branch: string): Promise<string> {
  const dir = await mkdtemp(path.join(tempRoot, "verify-"));
  const cloned = await run(["git", "clone", "-q", "--branch", branch, fixture.bareDir, dir]);
  assert.equal(cloned.code, 0, `核对用的 clone 失败：${cloned.stderr}`);
  const content = await run(["cat", path.join(dir, relative)]);
  return content.stdout;
}

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("Phase 12 的集成测试需要可用的 Docker daemon（npm run test:integration）。");
  }
  image = await resolveImageRef();
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "rc-pr-flow-"));
  cpRoot = path.join(tempRoot, "cp");
  server = await startGitHttpServer({ root: path.join(tempRoot, "git"), token: TEST_TOKEN });
  fixture = await createGitFixtureRepo({
    server,
    files: {
      "package.json": `${JSON.stringify({ name: "pr-fixture", scripts: { test: "node test.js" } }, null, 2)}\n`,
      "src/math.js": BUGGY_MATH,
      "test.js": [
        'const { add } = require("./src/math.js");',
        "if (add(2, 3) !== 5) { console.error('FAIL'); process.exit(1); }",
        "console.log('ok');",
        "",
      ].join("\n"),
    },
  });

  handle = await PROVIDER.create({
    image,
    limits: { cpu: 1, memMb: 2048, pids: 2048, diskMb: 4096, ttlSec: 3600 },
    labels: { sandboxId, runId: `run_${randomBytes(4).toString("hex")}` },
    workspace: { sizeMb: 4096 },
  });
  CLEANUP.container(handle.containerName);
  CLEANUP.volume(handle.volumeName);
  target = { endpoint: handle.endpoint, authToken: handle.authToken, sandboxId };
});

after(async () => {
  await PROVIDER.destroy(sandboxId).catch(() => undefined);
  await CLEANUP.sweep();
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  await server?.close().catch(() => undefined);
});

describe("Phase 12 · Run 收尾（真沙箱 + 真远端 + 假 GitHub）", () => {
  test("沙箱改动 → 验证 → 取回 → push → 建 draft PR，正文是真数", async () => {
    const runId = `run_${randomBytes(4).toString("hex")}`;
    const clone = await cloneRepo({ runId, url: fixture.url, commit: fixture.baseSha, token: TEST_TOKEN, root: cpRoot });
    await injectRepo({ api: API, target, clone, workspaceDir: REPO_DIR });

    // 沙箱里的"模型改动"：修好 bug + 加一个新文件（新文件必须出现在 patch 里）。
    await writeInSandbox("src/math.js", FIXED_MATH);
    await writeInSandbox("src/added.txt", "brand new\n");

    const prApi = new FakePullRequestApi();
    const taskId = "pr-flow-1";
    const finished = await finishRun({
      api: API,
      target,
      clone,
      run: fakeRunResult(),
      issue: "运行 node test.js 会失败，修好它，不要改测试。",
      taskId,
      runId,
      model: "deepseek-flash",
      sandboxId,
      repoDir: REPO_DIR,
      verify: { cmd: ["node", "test.js"], timeoutMs: 60_000 },
      patchOut: path.join(cpRoot, "pr-flow.patch"),
      publish: {
        ref: { owner: "fixture", repo: "repo" },
        remoteUrl: fixture.url,
        baseBranch: fixture.branch,
        taskTitle: "修好 add",
        token: async () => TEST_TOKEN,
        api: prApi,
        draft: true,
        transcriptUrl: `s3://reuben-cloud/runs/${runId}/transcript.jsonl`,
      },
    });

    // ---- 取回与验证
    assert.equal(finished.changes.source, "patch", `本该走 patch 应用：${finished.changes.fallbackReason ?? ""}`);
    assert.equal(finished.verification?.passed, true, JSON.stringify(finished.verification));
    assert.equal(finished.verification?.cmd.join(" "), "node test.js");
    assert.match(finished.verification?.outputTail ?? "", /ok/);
    // CP 的 clone 现在与沙箱一致（bug 修好、新文件在）。
    assert.equal(await readFile(path.join(clone.dir, "src/math.js"), "utf8"), FIXED_MATH);
    assert.equal(finished.patchFile, path.join(cpRoot, "pr-flow.patch"));

    // ---- push
    assert.equal(finished.branch, branchNameForTask(taskId));
    assert.equal(finished.published?.push.branch, finished.branch);
    assert.equal(await readFromRemote("src/math.js", finished.branch!), `${FIXED_MATH}`);
    assert.equal(await readFromRemote("src/added.txt", finished.branch!), "brand new\n");

    // ---- PR
    assert.equal(finished.published?.created, true);
    assert.equal(finished.published?.pullRequest.draft, true, "PR 不是 draft（附录 A-13 要求默认 draft）");
    assert.equal(finished.published?.pullRequest.base, fixture.branch);
    assert.equal(prApi.pullRequests.length, 1);
    assert.equal(prApi.creates.length, 1);
    assert.equal(prApi.creates[0]!.draft, true);

    // ---- 正文里的真数
    const body = finished.body;
    assert.match(body, /2 个文件（\+\d+ \/ -\d+）/);
    assert.match(body, /`src\/math\.js`（modified/);
    assert.match(body, /`src\/added\.txt`（added/);
    assert.match(body, /✅ `node test\.js` 退出码 0/);
    assert.match(body, /模型：`deepseek-flash`/);
    assert.match(body, /attempt 1/);
    assert.match(body, /transcript：s3:\/\/reuben-cloud\/runs\//);
    assert.match(body, /人工 review/);
  });

  test("重复 Run：同一条分支同一条 PR，attempt 递增、不新建（测试要点 4）", async () => {
    const runId = `run_${randomBytes(4).toString("hex")}`;
    const clone = await cloneRepo({ runId, url: fixture.url, commit: fixture.baseSha, token: TEST_TOKEN, root: cpRoot });
    await injectRepo({ api: API, target, clone, workspaceDir: REPO_DIR });
    await writeInSandbox("src/math.js", "exports.add = (a, b) => a + b; // attempt 2\n");

    const prApi = new FakePullRequestApi();
    // 先"调查"一条已经存在的 PR：把上一次尝试的结果喂进去（跨进程时它来自真 GitHub）。
    const first = await prApi.create(
      { owner: "fixture", repo: "repo" },
      {
        head: branchNameForTask("pr-flow-1"),
        base: fixture.branch,
        title: "reuben-cloud: 修好 add",
        body: "attempt 1",
        draft: true,
      },
    );
    prApi.calls.length = 0;

    const finished = await finishRun({
      api: API,
      target,
      clone,
      run: fakeRunResult({ turns: 6, stopReason: "end_turn", detail: "模型在第 6 轮正常收工" }),
      issue: "运行 node test.js 会失败，修好它，不要改测试。",
      taskId: "pr-flow-1",
      runId,
      model: "deepseek-flash",
      sandboxId,
      repoDir: REPO_DIR,
      verify: { cmd: ["node", "test.js"], timeoutMs: 60_000 },
      publish: {
        ref: { owner: "fixture", repo: "repo" },
        remoteUrl: fixture.url,
        baseBranch: fixture.branch,
        taskTitle: "修好 add",
        token: async () => TEST_TOKEN,
        api: prApi,
        attempt: 2,
      },
    });

    assert.equal(finished.published?.created, false, "重复 Run 又建了一条 PR");
    assert.equal(finished.published?.pullRequest.number, first.number);
    assert.equal(prApi.pullRequests.length, 1);
    assert.match(finished.body, /attempt 2/);
    // lease 是覆盖式的（同一个 Task 固定一条分支），远端 tip 现在是第二次的 commit。
    assert.equal(await readFromRemote("src/math.js", finished.branch!), "exports.add = (a, b) => a + b; // attempt 2\n");
  });

  test("验证不过：如实写进 PR 正文（不假装通过），但流程照常产出", async () => {
    const runId = `run_${randomBytes(4).toString("hex")}`;
    const clone = await cloneRepo({ runId, url: fixture.url, commit: fixture.baseSha, token: TEST_TOKEN, root: cpRoot });
    await injectRepo({ api: API, target, clone, workspaceDir: REPO_DIR });
    // 故意不修 bug：验证命令会以 exit 1 结束。
    await writeInSandbox("src/notes.txt", "有人动过这里\n");

    const prApi = new FakePullRequestApi();
    const finished = await finishRun({
      api: API,
      target,
      clone,
      run: fakeRunResult({ ok: false, stopReason: "max_turns", detail: "达到轮数上限（40 轮）" }),
      issue: "修好它",
      taskId: "pr-flow-failing",
      runId,
      model: "deepseek-flash",
      sandboxId,
      repoDir: REPO_DIR,
      verify: { cmd: ["node", "test.js"], timeoutMs: 60_000 },
      publish: {
        ref: { owner: "fixture", repo: "repo" },
        remoteUrl: fixture.url,
        baseBranch: fixture.branch,
        taskTitle: "没修好",
        token: async () => TEST_TOKEN,
        api: prApi,
      },
    });

    assert.equal(finished.verification?.passed, false);
    assert.equal(finished.verification?.exitCode, 1);
    assert.match(finished.body, /❌ `node test\.js` 退出码 1/);
    assert.match(finished.body, /结束原因：`max_turns`/);
    // PR 仍然建出来了——"没修好"是要人看的结论，不是流程失败。
    assert.equal(finished.published?.created, true);
    assert.equal(finished.published?.pullRequest.draft, true);
  });
});
