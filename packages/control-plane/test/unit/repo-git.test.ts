/**
 * Phase 9 · git 调用层与 push 规则的单元测试（不需要 Docker、不需要网络）。
 *
 * 这里守的是三类"错了会很难查"的东西：
 *  1. **凭据只以一种方式进 argv**：`tokenAuthArgs` 产出什么、日志里被遮蔽成什么、
 *     带 userinfo 的 URL 被拒——这是 §J 红线在代码形状上的那一半。
 *  2. **patch 忠实度**：同一份改动在"另一个 clone"上应用之后，重新生成的 `git diff`
 *     必须逐字节相同。这是 Phase 9 用例 1 的内核，用两个本地目录就能守（毫秒级）。
 *  3. **push 的产品语义**：分支命名空间、`--shortstat` 的解析、清理工具的边界。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { applyPatchFile } from "../../src/repo/apply.ts";
import { assertRunId, removeRunDir, runDirOf, sweepStaleRunDirs } from "../../src/repo/clone.ts";
import {
  assertNoUserInfo,
  basicAuthHeader,
  isTransientGitError,
  looksLikeAuthFailure,
  looksLikeLeaseRejection,
  looksLikeTransientNetworkFailure,
  redactArgs,
  redactedCommand,
  retryTransientGit,
  tokenAuthArgs,
  writeWorktreeDiff,
} from "../../src/repo/git.ts";
import type { GitRunResult } from "../../src/repo/git.ts";
import { auditCloneConfig, scanForSecrets } from "../../src/repo/pack.ts";
import {
  assertPushableBranch,
  branchNameForTask,
  isTransientPushFailure,
  leaseRejectionMeansAlreadyPushed,
  looksLikePushStarted,
  lsRemoteSha,
  parseShortStat,
} from "../../src/repo/push.ts";
import { RepoError } from "../../src/repo/types.ts";
import { run } from "../support.ts";

const TOKEN = "ghs_unit_token_0123456789abcdef";

/** 临时根：一个"源仓库"、一个"目标 clone"、一个裸仓库（push/ls-remote 用）。 */
let root = "";

async function gitIn(cwd: string, args: string[], expectOk = true): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const result = await run(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
  if (expectOk && result.code !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr.trim()}`);
  return result;
}

/** 造一个带初始提交的仓库，并返回它的 sha。 */
async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await gitIn(dir, ["init", "-q", "--initial-branch", "main"]);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "greet.js"), 'module.exports = () => "hi";\n');
  await writeFile(path.join(dir, "src", "old.txt"), "rename me\n");
  await writeFile(path.join(dir, "assets.bin"), Buffer.from([0x00, 0x01, 0x02, 0x7f, 0x80]));
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "-qm", "initial"]);
  return (await gitIn(dir, ["rev-parse", "HEAD"])).stdout.trim();
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rc-repo-unit-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Phase 9 · git 参数与凭据", () => {
  test("tokenAuthArgs：只以 `-c http.extraHeader` 的形式带凭据，且可被遮蔽", () => {
    const args = tokenAuthArgs(TOKEN);
    assert.deepEqual(args.slice(0, 1), ["-c"]);
    assert.equal(args[1], `http.extraHeader=${basicAuthHeader(TOKEN)}`);
    assert.equal(basicAuthHeader(TOKEN), `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);

    // 打码：token 一个字符都不许出现在日志/错误信息里。
    const redacted = redactArgs(args).join(" ");
    assert.ok(!redacted.includes(TOKEN), "redactArgs 没有遮蔽 token");
    assert.ok(!redacted.includes("Basic "), "redactArgs 没有遮蔽 Authorization 头");
    assert.ok(redactedCommand([...args, "clone", "https://github.com/o/r.git"]).includes("http.extraHeader=<redacted>"));

    // 没有 token（本地 fixture）时不产生任何配置参数。
    assert.deepEqual(tokenAuthArgs(null), []);
    assert.deepEqual(tokenAuthArgs(undefined), []);
    assert.deepEqual(tokenAuthArgs(""), []);
    assert.deepEqual(redactArgs(["ls-remote", "https://x"]), ["ls-remote", "https://x"]);
  });

  test("assertNoUserInfo：URL 里带凭据一律拒，scp 形式与无凭据 URL 放行", () => {
    for (const bad of [
      "https://x-access-token:ghs_x@github.com/o/r.git",
      "https://ghs_x@github.com/o/r.git",
      "http://user:pass@127.0.0.1:8080/r.git",
    ]) {
      assert.throws(
        () => assertNoUserInfo(bad, "clone"),
        (error: unknown) => {
          const repoError = error as RepoError;
          assert.equal(repoError.reason, "credentials_in_url");
          // 错误信息里不能出现凭据本身。
          assert.ok(!repoError.message.includes("ghs_x"));
          assert.ok(!repoError.message.includes("pass"));
          return true;
        },
        bad,
      );
    }
    for (const ok of ["https://github.com/o/r.git", "git@github.com:o/r.git", "file:///tmp/x.git", "/tmp/x.git"]) {
      assertNoUserInfo(ok, "clone");
    }
  });

  test("git 错误的分类：认证失败 / lease 被拒", () => {
    assert.ok(looksLikeAuthFailure("fatal: Authentication failed for 'https://github.com/…'"));
    assert.ok(looksLikeAuthFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"));
    assert.ok(!looksLikeAuthFailure("fatal: not a git repository"));
    assert.ok(looksLikeLeaseRejection("!\tHEAD:refs/heads/x\t[rejected] (stale info)"));
    assert.ok(!looksLikeLeaseRejection("!\tHEAD:refs/heads/x\t[rejected] (non-fast-forward)"));
  });
});

describe("Phase 9 · push 的产品语义", () => {
  test("branchNameForTask：一个 Task 一条稳定分支，非法字符被归一", () => {
    assert.equal(branchNameForTask("task_01H"), "reuben-cloud/task_01H");
    assert.equal(branchNameForTask("Add login / v2"), "reuben-cloud/Add-login-v2");
    assert.throws(() => branchNameForTask("///"), (error: unknown) => (error as RepoError).reason === "config_invalid");
  });

  test("assertPushableBranch：只允许 reuben-cloud/*，main 与畸形名字都拒", () => {
    assertPushableBranch("reuben-cloud/task_01H");
    for (const bad of ["main", "master", "HEAD", "feature/x", "reuben-cloud/", "reuben-cloud/a..b", "reuben-cloud/x.lock", "reuben-cloud/.hidden", "reuben-cloud/a b"]) {
      assert.throws(
        () => assertPushableBranch(bad),
        (error: unknown) => (error as RepoError).reason === "protected_branch",
        `本该拒绝：${bad}`,
      );
    }
  });

  test("parseShortStat：单复数与空输出都给得出数字", () => {
    assert.deepEqual(parseShortStat(" 3 files changed, 12 insertions(+), 4 deletions(-)\n"), {
      files: 3,
      insertions: 12,
      deletions: 4,
    });
    assert.deepEqual(parseShortStat(" 1 file changed, 1 insertion(+)\n"), { files: 1, insertions: 1, deletions: 0 });
    assert.deepEqual(parseShortStat(" 1 file changed, 2 deletions(-)\n"), { files: 1, insertions: 0, deletions: 2 });
    assert.deepEqual(parseShortStat(""), { files: 0, insertions: 0, deletions: 0 });
  });

  test("lsRemoteSha：本地裸仓库上，不存在的分支是 null，存在的是 sha", async () => {
    const bare = path.join(root, "bare.git");
    await gitIn(root, ["init", "--bare", "-q", bare]);
    assert.equal(await lsRemoteSha(bare, "reuben-cloud/none", null, 30_000), null);

    const work = path.join(root, "push-work");
    const sha = await initRepo(work);
    await gitIn(work, ["push", "-q", bare, "HEAD:refs/heads/reuben-cloud/one"]);
    assert.equal(await lsRemoteSha(bare, "reuben-cloud/one", null, 30_000), sha);
  });

  test("isTransientPushFailure：超时与远端 5xx 算，保护/非快进/认证不算", () => {
    const result = (overrides: Partial<GitRunResult> = {}): GitRunResult => ({
      code: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      timedOut: false,
      overflow: false,
      spawnError: null,
      stdoutBytes: 0,
      stdoutSha256: null,
      ...overrides,
    });
    // 超时**且一点都没动**（没有 git 的进度输出）= 连接没建立起来 → 值得重试。
    assert.equal(isTransientPushFailure(result({ timedOut: true }), ""), true);
    // 超时但已经在传（大仓库真推送太慢）= 事实，不是抖动 → 不重试。
    assert.equal(
      isTransientPushFailure(result({ timedOut: true }), "Writing objects:  42% (1/2), 1.00 MiB | 20.00 KiB/s"),
      false,
    );
    assert.equal(looksLikePushStarted("remote: Resolving deltas: 100%"), true);
    assert.equal(looksLikePushStarted(""), false);
    // GitHub receive-pack 的偶发 5xx：真跑 live 时遇过 `remote: Internal Server Error`。
    assert.equal(isTransientPushFailure(result(), "remote: Internal Server Error"), true);
    assert.equal(isTransientPushFailure(result(), "error: RPC failed; curl 56 Recv failure"), true);
    // 确定性失败：重试只是把错误延后。
    assert.equal(isTransientPushFailure(result(), "! [rejected]\trefs/heads/x\t(stale info)"), false);
    assert.equal(isTransientPushFailure(result(), "remote: error: GH006: Protected branch update failed"), false);
    assert.equal(isTransientPushFailure(result(), "fatal: Authentication failed for 'https://github.com/o/r.git/'"), false);
  });

  test("leaseRejectionMeansAlreadyPushed：远端 == 本地 HEAD 才是“上一次成功了”", () => {
    const head = "a".repeat(40);
    assert.equal(leaseRejectionMeansAlreadyPushed(head, head), true);
    assert.equal(leaseRejectionMeansAlreadyPushed("b".repeat(40), head), false, "远端不是我们的 commit，不能当成功");
    assert.equal(leaseRejectionMeansAlreadyPushed(null, head), false);
    assert.equal(leaseRejectionMeansAlreadyPushed("", head), false);
  });
});

describe("Phase 12 · 弱网重试（真跑 GitHub 时踩出来的）", () => {
  test("looksLikeTransientNetworkFailure 只认网络类信号，不认认证/仓库类", () => {
    for (const transient of [
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      "error: RPC failed; curl 56 Recv failure: Connection reset by peer",
      "fatal: unable to access '...': Failed to connect to github.com port 443",
      "fatal: the remote end hung up unexpectedly",
      // `http.lowSpeed*` 把“永久挂住”变成的那条：真跑 GitHub 时见过两次。
      "fatal: unable to access 'https://github.com/o/r.git/': Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds",
    ]) {
      assert.equal(looksLikeTransientNetworkFailure(transient), true, transient);
    }
    for (const deterministic of [
      "fatal: Authentication failed for 'https://github.com/o/r.git/'",
      "remote: Repository not found.",
      "remote: error: GH006: Protected branch update failed",
      "! [rejected] main -> main (stale info)",
    ]) {
      assert.equal(looksLikeTransientNetworkFailure(deterministic), false, deterministic);
    }
  });

  test("isTransientGitError：git_timeout 算；auth_failed / protected_branch 不算", () => {
    assert.equal(isTransientGitError(new RepoError("git_timeout", "卡住了")), true);
    assert.equal(
      isTransientGitError(new RepoError("git_failed", "网络", { details: { stderr: "Recv failure: Connection reset" } })),
      true,
    );
    assert.equal(isTransientGitError(new RepoError("auth_failed", "401")), false);
    assert.equal(isTransientGitError(new RepoError("protected_branch", "GH006")), false);
    // stderr 里没有网络信号就当作确定性失败（重试只是把错误延后）。
    assert.equal(isTransientGitError(new RepoError("git_failed", "别的原因", { details: { stderr: "nope" } })), false);
    assert.equal(isTransientGitError(new Error("不是 RepoError")), false);
  });

  test("retryTransientGit：瞬时失败重试、确定性失败直接抛、用尽后抛原错", async () => {
    const warnings: string[] = [];
    const log = (_level: string, message: string): void => void warnings.push(message);

    // ① 前两次卡死，第三次成功。
    let calls = 0;
    const ok = await retryTransientGit(
      async () => {
        calls += 1;
        if (calls < 3) throw new RepoError("git_timeout", `第 ${calls} 次卡住`);
        return "done";
      },
      { attempts: 3, delayMs: 5, log },
    );
    assert.equal(ok, "done");
    assert.equal(calls, 3);

    // ② 确定性失败不重试（只调一次）。
    let authCalls = 0;
    await assert.rejects(
      retryTransientGit(
        async () => {
          authCalls += 1;
          throw new RepoError("auth_failed", "401");
        },
        { attempts: 3, delayMs: 5, log },
      ),
      (error: unknown) => (error as RepoError).reason === "auth_failed",
    );
    assert.equal(authCalls, 1, "认证失败被重试了");

    // ③ 一直瞬时失败：重试用尽后抛最后一次的原错，且每次重试前都记一条 warn。
    let always = 0;
    const retryLogs: number[] = [];
    await assert.rejects(
      retryTransientGit(
        async () => {
          always += 1;
          throw new RepoError("git_timeout", "一直卡");
        },
        { attempts: 2, delayMs: 1, log: (_level, message) => void retryLogs.push(message.length) },
      ),
      (error: unknown) => (error as RepoError).reason === "git_timeout",
    );
    assert.equal(always, 2);
    assert.equal(retryLogs.length, 1, "重试前应该记一条 warn");
  });
});

describe("Phase 9 · patch 忠实度（本地两个 clone，不需要 Docker）", () => {
  test("改一个文件 → patch → 在另一个 clone 上 apply → 两边 diff 逐字节相同", async () => {
    const source = path.join(root, "fidelity-source");
    const target = path.join(root, "fidelity-target");
    const baseSha = await initRepo(source);
    await gitIn(root, ["clone", "-q", source, target]);

    // 四类改动：修改 / 新增（未跟踪）/ 删除 / 重命名 / 二进制。
    await writeFile(path.join(source, "src", "greet.js"), 'module.exports = () => "hello";\n');
    await writeFile(path.join(source, "src", "added.txt"), "added\n");
    await rm(path.join(source, "src", "old.txt"));
    await writeFile(path.join(source, "src", "renamed.txt"), "renamed\n");
    await writeFile(path.join(source, "assets.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x10]));

    const patchFile = path.join(root, "fidelity.patch");
    const fromSource = await writeWorktreeDiff(source, baseSha, patchFile);
    assert.ok(fromSource.bytes > 0);

    await applyPatchFile(target, patchFile);
    const fromTarget = await writeWorktreeDiff(target, baseSha, path.join(root, "fidelity-target.patch"));
    assert.equal(fromTarget.sha256, fromSource.sha256, "apply 之后的 diff 与源不一致");

    // 两边的 status 也一致（重命名/删除/新增都被认出来了）。
    const sourceStatus = (await gitIn(source, ["status", "--porcelain"])).stdout.split("\n").sort();
    const targetStatus = (await gitIn(target, ["status", "--porcelain"])).stdout.split("\n").sort();
    assert.deepEqual(targetStatus, sourceStatus);
  });

  test("apply 不上时抛 apply_failed（调用方据此回退 archive）", async () => {
    const source = path.join(root, "fail-source");
    const target = path.join(root, "fail-target");
    const baseSha = await initRepo(source);
    await gitIn(root, ["clone", "-q", source, target]);

    await writeFile(path.join(source, "src", "greet.js"), 'module.exports = () => "changed";\n');
    const patchFile = path.join(root, "fail.patch");
    await writeWorktreeDiff(source, baseSha, patchFile);

    // 目标 clone 里同一行被改成了别的内容：patch 的上下文对不上。
    await writeFile(path.join(target, "src", "greet.js"), 'module.exports = () => "conflict";\n');
    await assert.rejects(
      applyPatchFile(target, patchFile),
      (error: unknown) => (error as RepoError).reason === "apply_failed",
    );
  });
});

describe("Phase 9 · 打包审计与临时目录", () => {
  test("auditCloneConfig：config 里出现 extraHeader 就抛，且只报键名不报值", async () => {
    const dir = path.join(root, "dirty-config");
    await initRepo(dir);
    await gitIn(dir, ["config", "--local", "http.extraHeader", `Authorization: Basic ${TOKEN}`]);
    await assert.rejects(
      auditCloneConfig(dir),
      (error: unknown) => {
        const repoError = error as RepoError;
        assert.equal(repoError.reason, "credentials_in_clone");
        assert.ok(!repoError.message.includes(TOKEN), "错误信息里带上了凭据的值");
        assert.ok(!JSON.stringify(repoError.details).includes(TOKEN), "details 里带上了凭据的值");
        return true;
      },
    );
    // 干净的仓库不抛。
    const clean = path.join(root, "clean-config");
    await initRepo(clean);
    const audit = await auditCloneConfig(clean);
    assert.ok(audit.entries > 0);
  });

  test("scanForSecrets：找到命中、跳过符号链接、空 needles 直接返回", async () => {
    const dir = path.join(root, "scan");
    await mkdir(path.join(dir, "sub"), { recursive: true });
    await writeFile(path.join(dir, "sub", "plain.txt"), `prefix ${TOKEN} suffix`);
    await writeFile(path.join(dir, "clean.txt"), "nothing here");
    assert.deepEqual(await scanForSecrets(dir, [TOKEN]), ["sub/plain.txt"]);
    assert.deepEqual(await scanForSecrets(dir, ["no-such-needle"]), []);
    assert.deepEqual(await scanForSecrets(dir, []), []);
  });

  test("sweepStaleRunDirs：按年龄删，新目录不碰，根不存在也不炸", async () => {
    const sweepRoot = path.join(root, "cp-root");
    const oldDir = path.join(sweepRoot, "run_old");
    const freshDir = path.join(sweepRoot, "run_fresh");
    await mkdir(oldDir, { recursive: true });
    await mkdir(freshDir, { recursive: true });
    const old = new Date(Date.now() - 7_200_000);
    await utimes(oldDir, old, old);

    const report = await sweepStaleRunDirs({ root: sweepRoot, maxAgeMs: 3_600_000 });
    assert.deepEqual(report.removed, ["run_old"]);
    assert.equal(report.kept, 1);
    assert.deepEqual(report.errors, []);
    await assert.rejects(stat(oldDir));
    await stat(freshDir);

    const missing = await sweepStaleRunDirs({ root: path.join(root, "nope"), maxAgeMs: 1 });
    assert.deepEqual(missing, { removed: [], kept: 0, errors: [] });
  });

  test("runId 是路径的一部分：不安全的写法一律拒", async () => {
    for (const bad of ["", "../escape", "a/b", "a b", "x".repeat(65)]) {
      assert.throws(() => assertRunId(bad), (error: unknown) => (error as RepoError).reason === "config_invalid", bad);
    }
    assertRunId("run_01HZZZZZZZZZZZZZZZZZZZZZZZ");
    assert.equal(runDirOf("run_1", "/tmp/rc"), path.join("/tmp/rc", "run_1"));
    // removeRunDir 幂等：目录不存在当成功（对账/重试会重复调用它）。
    await removeRunDir("run_never_created", path.join(root, "cp-root"));
  });
});
