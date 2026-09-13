/**
 * Phase 9 的集成测试（`npm run test:integration`，**需要 Docker 与宿主 git**）。
 *
 * 覆盖 spec「测试要点」那张表：clone → tar → 灌入 → 改动 → `/diff` → apply → push，
 * 外加两条红线（token 不落盘、沙箱内零凭据）与 archive 回退。
 *
 * 【为什么"远端"是一个本地 smart-HTTP git 服务器而不是 GitHub】CI 里没有 GitHub App
 * 的私钥，而本阶段两条红线的牙齿恰恰在于"token 真的被用过、但没有落在任何地方"。
 * `startGitHttpServer()`（`test/support.ts`）用 git 自带的 `git http-backend` 搭了一个
 * **会校验 Authorization 头**的真 HTTP 远端：clone / push 走的是真实的 smart-HTTP，
 * 错误 token 会拿到 401，而磁盘上找不到那串 token——这比对着 file:// 断言有意义得多。
 *
 * 【为什么用真沙箱】灌入（tar 解包 + HEAD 自检）、`/diff` 的 base 语义、`/archive`
 * 的解包结构，这三件事只有真容器能回答。不带 Postgres：这一阶段不碰 DB（状态机是
 * Phase 8 的事），provider + agent HTTP 就够了。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { SandboxApiClient } from "../../src/client/sandbox-api.ts";
import type { AgentExecOutcome } from "../../src/client/sandbox-api.ts";
import { LocalDockerProvider } from "../../src/provider/local-docker.ts";
import type { SandboxHandle } from "../../src/provider/types.ts";
import { cloneRepo, removeRunDir, runDirOf } from "../../src/repo/clone.ts";
import type { RepoClone } from "../../src/repo/clone.ts";
import { injectRepo } from "../../src/repo/inject.ts";
import { collectSandboxChanges } from "../../src/repo/apply.ts";
import { auditCloneConfig, scanForSecrets } from "../../src/repo/pack.ts";
import { commitAndPush, lsRemoteSha } from "../../src/repo/push.ts";
import type { PushResult } from "../../src/repo/push.ts";
import type { RepoError } from "../../src/repo/types.ts";
import type { SandboxTarget } from "../../src/repo/types.ts";
import {
  CleanupRegistry,
  createGitFixtureRepo,
  dockerAvailable,
  newSandboxId,
  pushCommitToFixture,
  resolveImageRef,
  run,
  startGitHttpServer,
} from "../support.ts";
import type { GitFixtureRepo, GitHttpServer } from "../support.ts";

/**
 * fixture token。**随机**是关键：它是一个只在这次运行里存在的字符串，
 * "磁盘上搜不到它"才是真的搜过（写死一个 `ghs_token` 的话，任何地方都可能碰巧不含它）。
 */
const TEST_TOKEN = `ghs_fixture_${randomBytes(12).toString("hex")}`;

/** 沙箱里改完之后 `src/greet.js` 的内容（不用双引号包住 backtick，省掉一层转义）。 */
const GREET_AFTER = 'module.exports = (name) => "hello " + name + "!";\n';
/** 沙箱里改完之后 `assets/blob.bin` 的内容：与初始值逐字节不同，且含 NUL 与非法 UTF-8。 */
const BLOB_AFTER = Buffer.from([0x00, 0xff, 0x01, 0xfe, 0x02, 0xfd, 0x00, 0x00, 0x7f, 0x80, 0x0a]);

const api = new SandboxApiClient();
const provider = new LocalDockerProvider();
const cleanup = new CleanupRegistry();

const sandboxId = newSandboxId();
const runId = `run_${randomBytes(6).toString("hex")}`;
/** archive 回退用例用第二个 run（干净的 clone，不受前面 push 出来的 commit 影响）。 */
const fallbackRunId = `run_${randomBytes(6).toString("hex")}`;
const branch = "reuben-cloud/repo-flow";

let image = "";
let tempRoot = "";
let cpRoot = "";
let server: GitHttpServer;
let fixture: GitFixtureRepo;
let handle: SandboxHandle;
let target: SandboxTarget;
let clone: RepoClone;
let pushed: PushResult;

/** 沙箱里跑一条必须成功的命令。 */
async function execOk(cmd: string[]): Promise<AgentExecOutcome> {
  const outcome = await api.execAndWait(target.endpoint, target.authToken, { cmd, timeoutMs: 120_000 });
  assert.equal(outcome.state, "completed", `${cmd.join(" ")} 的终态是 ${outcome.state}：${outcome.stderr}`);
  assert.equal(outcome.exitCode, 0, `${cmd.join(" ")} 退出码 ${outcome.exitCode}：${outcome.stderr}`);
  return outcome;
}

/** 在沙箱里跑一段 bash 并拿 stdout。 */
async function bash(script: string): Promise<string> {
  return (await execOk(["bash", "-lc", script])).stdout;
}

/** 读一个沙箱文件（raw 流）的完整字节。 */
async function readSandboxFile(sandboxPath: string): Promise<Buffer> {
  const stream = await api.readRaw(target.endpoint, target.authToken, sandboxPath);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function exists(target_: string): Promise<boolean> {
  try {
    await stat(target_);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("Phase 9 的集成测试需要可用的 Docker daemon（npm run test:integration）。");
  }
  image = await resolveImageRef();

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "rc-repo-flow-"));
  cpRoot = path.join(tempRoot, "cp");
  server = await startGitHttpServer({ root: path.join(tempRoot, "git"), token: TEST_TOKEN });
  fixture = await createGitFixtureRepo({ server });

  handle = await provider.create({
    image,
    limits: { cpu: 1, memMb: 2048, pids: 2048, diskMb: 4096, ttlSec: 3600 },
    labels: { sandboxId, runId },
    workspace: { sizeMb: 4096 },
  });
  cleanup.container(handle.containerName);
  cleanup.volume(handle.volumeName);
  target = { endpoint: handle.endpoint, authToken: handle.authToken, sandboxId };
});

after(async () => {
  await provider.destroy(sandboxId).catch(() => undefined);
  await cleanup.sweep();
  await rm(cpRoot, { recursive: true, force: true }).catch(() => undefined);
  await server?.close().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
});

describe("Phase 9 · 仓库进出", () => {
  test("1 · clone：走带 token 的 smart-HTTP，磁盘上一个字节都不留", async () => {
    clone = await cloneRepo({ runId, url: fixture.url, commit: fixture.baseSha, token: TEST_TOKEN, root: cpRoot });
    assert.equal(clone.baseSha, fixture.baseSha, "checkout 之后不是请求的那个 commit");
    assert.equal(clone.dir, path.join(runDirOf(runId, cpRoot), "repo"), "clone 的落点不是 <runId>/repo");

    // 真的走了 HTTP 且带了 token（`authorized` 由服务器校验 Authorization 头得出）。
    const authorized = server.requests.filter((request) => request.authorized && request.path.includes("/info/refs"));
    assert.ok(authorized.length > 0, "没有任何一次带正确 Authorization 头的 info/refs 请求——token 根本没被用上");

    // 红线之一：token 不在 clone 的 config 里（URL 里带 token 的写法会在这里现形）。
    const config = (await run(["git", "-C", clone.dir, "config", "--local", "--list"])).stdout;
    assert.ok(!config.includes(TEST_TOKEN), `.git/config 里有 token：\n${config}`);
    assert.ok(config.includes(fixture.url), "remote.origin.url 不是我们给的地址");
    await auditCloneConfig(clone.dir); // 不抛 = 通过

    // 红线之二的另一半：整个 CP 临时目录里搜不到这串 token。
    assert.deepEqual(await scanForSecrets(cpRoot, [TEST_TOKEN]), [], "clone 之后磁盘上出现了 token");

    // 错误 token：走的是同一个 HTTP 远端，401 → auth_failed，而且不留半个仓库。
    const badRunId = `run_${randomBytes(6).toString("hex")}`;
    await assert.rejects(
      cloneRepo({ runId: badRunId, url: fixture.url, commit: fixture.baseSha, token: "ghs_wrong_token", root: cpRoot }),
      (error: unknown) => (error as RepoError).reason === "auth_failed",
      "错误 token 没有按 auth_failed 失败",
    );
    assert.equal(await exists(path.join(runDirOf(badRunId, cpRoot), "repo", ".git")), false, "失败的 clone 留下了半个仓库");
  });

  test("2 · 灌入：tar 流进沙箱、HEAD 自检通过、tar 用完即删、沙箱内零凭据", async () => {
    const injected = await injectRepo({ api, target, clone });
    assert.equal(injected.headSha, fixture.baseSha, "解包之后的 HEAD 与 clone 不一致");
    assert.ok(injected.bytes > 0, "灌进去的 tar 是空的");

    // 工作区干净：`.git` 与文件都是 clone 里的那一份。
    assert.equal((await bash("git -C /workspace status --porcelain")).trim(), "", "解包之后工作区不干净");
    assert.equal((await bash("git -C /workspace rev-parse HEAD")).trim(), fixture.baseSha);

    // tar 用完即删。
    assert.equal((await bash("test -f /workspace/repo.tar.gz && echo present || echo gone")).trim(), "gone", "repo.tar.gz 留在沙箱里了");

    // 红线：沙箱里没有任何 GitHub 凭据。
    // （注意：这条命令把 fixture token 当成了 grep 的参数——产品代码绝不许把真 token
    //  送进沙箱 argv，这里是测试用的一次性假 token，值得用最直接的办法证伪。）
    assert.equal((await bash(`grep -r -F -l ${TEST_TOKEN} /workspace || true`)).trim(), "", "沙箱 workspace 里出现了 token");
    const config = await bash("git -C /workspace config --local --list");
    assert.ok(!config.includes(TEST_TOKEN), `沙箱里的 .git/config 有 token：\n${config}`);
    const env = await bash("env");
    assert.ok(!env.includes(TEST_TOKEN), "沙箱 env 里出现了 token");
    assert.ok(!env.includes("GITHUB_APP"), "沙箱 env 里出现了 GITHUB_APP* 变量");
  });

  test("3 · 改动 → /diff → apply → sha256 忠实效验（含二进制/新增/删除/重命名）", async () => {
    // 四种改动各来一个，覆盖 --binary patch 的四个边角。
    await api.putFile(target.endpoint, target.authToken, "/workspace/src/greet.js", Readable.from(Buffer.from(GREET_AFTER)));
    await api.putFile(target.endpoint, target.authToken, "/workspace/src/added.txt", Readable.from(Buffer.from("brand new\n")));
    await api.putFile(target.endpoint, target.authToken, "/workspace/assets/blob.bin", Readable.from(BLOB_AFTER));
    await execOk(["mv", "/workspace/src/old-name.txt", "/workspace/src/new-name.txt"]);
    await execOk(["rm", "-f", "/workspace/src/delete-me.txt"]);

    const collected = await collectSandboxChanges({ api, target, clone });
    assert.equal(collected.source, "patch", `本该走 patch 应用，实际是 ${collected.source}：${collected.fallbackReason ?? ""}`);
    assert.equal(collected.patch.sha256, collected.sandboxPatchSha256, "CP 重算的 diff 与沙箱的 patch 不一致");
    assert.ok(collected.patch.bytes > 0, "patch 是空的");

    const statuses = new Map(collected.files.map((file) => [file.path, file.status]));
    assert.equal(statuses.get("src/greet.js"), "modified");
    assert.equal(statuses.get("src/added.txt"), "added");
    assert.equal(statuses.get("assets/blob.bin"), "modified");
    assert.equal(statuses.get("src/delete-me.txt"), "deleted");
    assert.equal(statuses.get("src/new-name.txt"), "renamed", `重命名没被识别：${JSON.stringify([...statuses])}`);

    // 两侧的 status 逐行一致（都把 /diff 的 `add -A -N` 算进去了）。
    const sandboxStatus = (await bash("git -C /workspace status --porcelain")).trim().split("\n").sort();
    const cpStatus = (await run(["git", "-C", clone.dir, "status", "--porcelain"])).stdout.trim().split("\n").sort();
    assert.deepEqual(cpStatus, sandboxStatus, "CP 与沙箱的工作区状态不一致");

    // 二进制文件逐字节相同（`git apply --binary` 的最终判据）。
    assert.deepEqual(await readFile(path.join(clone.dir, "assets/blob.bin")), BLOB_AFTER, "二进制文件没有忠实还原");
    assert.deepEqual(await readFile(path.join(clone.dir, "assets/blob.bin")), await readSandboxFile("/workspace/assets/blob.bin"));
    assert.equal(await readFile(path.join(clone.dir, "src/greet.js"), "utf8"), GREET_AFTER);
  });

  test("4 · push：远端出现 reuben-cloud/<task>，内容与沙箱里验证过的一致", async () => {
    pushed = await commitAndPush({
      dir: clone.dir,
      url: fixture.url,
      branch,
      token: TEST_TOKEN,
      message: "reuben-cloud: Phase 9 集成用例",
      body: `run: ${runId}\nattempt: 1`,
    });
    assert.equal(pushed.remoteShaBefore, null, "第一次推的时候远端不该已经有这条分支");

    const remoteSha = await lsRemoteSha(fixture.url, branch, TEST_TOKEN, 60_000);
    assert.equal(remoteSha, pushed.commitSha, "远端 sha 与本地 commit 不一致");

    // 从远端拉一份下来核对内容：这是"推上去的代码和沙箱里验证过的是同一份"的最终证据。
    const verifyDir = await mkdtemp(path.join(tempRoot, "verify-"));
    const cloned = await run(["git", "clone", "-q", "--branch", branch, fixture.bareDir, verifyDir]);
    assert.equal(cloned.code, 0, `核对用的 clone 失败：${cloned.stderr}`);
    assert.equal(await readFile(path.join(verifyDir, "src/greet.js"), "utf8"), GREET_AFTER);
    assert.deepEqual(await readFile(path.join(verifyDir, "assets/blob.bin")), BLOB_AFTER);
    assert.equal(await exists(path.join(verifyDir, "src/delete-me.txt")), false, "被删除的文件又回到了远端");
    assert.equal(await exists(path.join(verifyDir, "src/new-name.txt")), true, "重命名后的文件不在远端");
    assert.equal(await readFile(path.join(verifyDir, "src/added.txt"), "utf8"), "brand new\n");
  });

  test("5 · force-with-lease：第三方改过分支 → 推被拒，远端一个字节都不动", async () => {
    const thirdParty = await pushCommitToFixture({
      bareDir: fixture.bareDir,
      branch,
      message: "第三方改动了这条分支",
      files: { "src/third-party.txt": "not ours\n" },
    });

    await writeFile(path.join(clone.dir, "src/after-lease.txt"), "ours\n");
    await assert.rejects(
      // 显式给一个**过时**的期望值：这正是"我们上次推的是 sha X，而远端已经不是 X"的形状。
      commitAndPush({
        dir: clone.dir,
        url: fixture.url,
        branch,
        token: TEST_TOKEN,
        message: "reuben-cloud: 不该成功的推",
        expectedRemoteSha: pushed.commitSha,
      }),
      (error: unknown) => {
        const repoError = error as RepoError;
        assert.equal(repoError.reason, "push_lease_rejected", `拒绝的原因不是 lease：${repoError.reason}`);
        assert.equal(repoError.details["actual"], thirdParty, "拒绝时报告的远端实际 sha 不对");
        return true;
      },
    );
    assert.equal(await lsRemoteSha(fixture.url, branch, TEST_TOKEN, 60_000), thirdParty, "被拒的推送居然动了远端");
  });

  test("6 · archive 回退：patch 应用不上时，用整棵树修复且结果与沙箱一致", async () => {
    const fallbackClone = await cloneRepo({
      runId: fallbackRunId,
      url: fixture.url,
      commit: fixture.baseSha,
      token: TEST_TOKEN,
      root: cpRoot,
    });
    // 人为制造一次"应用不上"：clone 里的 greet.js 被改成了另一个内容，
    // 沙箱的 patch 拿它当上下文就会失败（真实的 CRLF / 空白差异就是这个形状）。
    await writeFile(path.join(fallbackClone.dir, "src/greet.js"), "module.exports = () => 'conflict';\n");

    const collected = await collectSandboxChanges({ api, target, clone: fallbackClone });
    assert.equal(collected.source, "archive", `本该回退 archive，实际走了 ${collected.source}`);
    assert.ok(collected.fallbackReason !== null, "回退没有给出原因");
    assert.ok(collected.archive !== null && collected.archive.bytes > 0, "没有记录归档的字节数");

    // 回退之后的工作区就是沙箱的那棵树：冲突没了，二进制也对。
    assert.equal(await readFile(path.join(fallbackClone.dir, "src/greet.js"), "utf8"), GREET_AFTER, "回退没有用沙箱的内容覆盖冲突");
    assert.deepEqual(await readFile(path.join(fallbackClone.dir, "assets/blob.bin")), BLOB_AFTER);
    assert.equal(await exists(path.join(fallbackClone.dir, "src/delete-me.txt")), false, "回退没有让删除生效");
    assert.equal(await exists(path.join(fallbackClone.dir, "src/new-name.txt")), true, "回退没有保留重命名");

    // 这一次的树与沙箱一致，所以回退后重新生成的 patch 与沙箱那份**逐字节相同**——
    // 这是"archive 不只是能看，而且真的能当 patch 的兜底"的判据。
    assert.equal(
      collected.patch.sha256,
      collected.sandboxPatchSha256,
      "回退后 CP 生成的 patch 与沙箱的 patch 不一致（说明归档出来的树不同）",
    );
  });

  test("7 · 临时目录：成功路径与失败路径都不留 <runId>", async () => {
    await removeRunDir(runId, cpRoot);
    assert.equal(await exists(runDirOf(runId, cpRoot)), false, "成功路径留下了 run 目录");
    // 失败路径在用例 1 里断言过（错误 token 的那个 runId），这里把它也清掉：
    // “清理”的判据是目录真的没了，而不是断言里少写一行的自我安慰。
    await removeRunDir(fallbackRunId, cpRoot);
    assert.equal(await exists(runDirOf(fallbackRunId, cpRoot)), false, "回退路径留下了 run 目录");
  });
});
