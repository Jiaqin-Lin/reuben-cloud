/**
 * Phase 9 · `collectSandboxChanges`（取回沙箱改动）的单元测试。
 *
 * 用假的 `RepoApi` 顶替沙箱的 HTTP，但 git 与 tar 都是真的：
 * 于是"内联 patch / 外置 patch / 应用失败 / 忠实度不一致 → archive 回退"这条
 * 全部分支都能在没有 Docker 的情况下被跑到——而这条分支正是 Phase 9 最容易写错、
 * 也最贵的部分（错了会推出一份"和沙箱里验证过的不是同一份"的代码）。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { SandboxApiError } from "../../src/client/sandbox-api.ts";
import type { AgentDiff } from "../../src/client/sandbox-api.ts";
import { collectSandboxChanges } from "../../src/repo/apply.ts";
import type { RepoClone } from "../../src/repo/clone.ts";
import { runGit } from "../../src/repo/git.ts";
import { collectPack } from "../../src/repo/pack.ts";
import type { RepoApi, SandboxTarget } from "../../src/repo/types.ts";
import { run } from "../support.ts";

const TARGET: SandboxTarget = { endpoint: "http://fake:8080", authToken: "tok", sandboxId: "sbx_unit" };

let root = "";

async function gitIn(cwd: string, args: string[]): Promise<string> {
  const result = await run(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd });
  assert.equal(result.code, 0, `git ${args.join(" ")} 失败：${result.stderr.trim()}`);
  return result.stdout;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 造一个"CP 的 clone"：一个在 base commit 上的仓库。 */
async function makeClone(name: string): Promise<RepoClone> {
  const dir = path.join(root, name, "repo");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await gitIn(dir, ["init", "-q", "--initial-branch", "main"]);
  await writeFile(path.join(dir, "src", "a.txt"), "one\n");
  await writeFile(path.join(dir, "src", "old.txt"), "rename me\n");
  await gitIn(dir, ["add", "-A"]);
  await gitIn(dir, ["commit", "-qm", "initial"]);
  const baseSha = (await gitIn(dir, ["rev-parse", "HEAD"])).trim();
  return { runId: name, dir, url: "https://example.invalid/repo.git", commit: baseSha, baseSha };
}

/** 一个假的沙箱 API：只实现被这条路径用到的两个方法，其它一律炸（"不该被调用"也是断言）。 */
function fakeApi(overrides: Partial<RepoApi>): RepoApi {
  const notUsed = (name: string) => (): never => {
    throw new Error(`fake RepoApi：${name} 不该被调用`);
  };
  return {
    putFile: notUsed("putFile") as RepoApi["putFile"],
    execAndWait: notUsed("execAndWait") as RepoApi["execAndWait"],
    diff: notUsed("diff") as RepoApi["diff"],
    readRaw: notUsed("readRaw") as RepoApi["readRaw"],
    readArchive: notUsed("readArchive") as RepoApi["readArchive"],
    ...overrides,
  };
}

/** 一份 `/diff` 的 payload（各用例只改自己关心的字段）。 */
function diffPayload(overrides: Partial<AgentDiff>): AgentDiff {
  return {
    base: "base",
    head: "head",
    files: [],
    patch: null,
    patchBytes: 0,
    truncated: false,
    patchLogPath: null,
    ...overrides,
  };
}

function apiError(status: number, agentError: string): SandboxApiError {
  return new SandboxApiError("http_error", `${status} ${agentError}`, { status, agentError });
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "rc-repo-apply-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Phase 9 · 取回改动与 archive 回退", () => {
  test("内联 patch：应用 + 忠实效验通过，全程不碰 archive", async () => {
    const clone = await makeClone("inline");
    // 在"沙箱"里做一处改动，并用与沙箱相同的命令生成 patch。
    await writeFile(path.join(clone.dir, "src", "a.txt"), "two\n");
    await gitIn(clone.dir, ["add", "-A", "-N"]);
    const patchText = (await gitIn(clone.dir, ["--no-pager", "diff", "--binary", "-M", clone.baseSha])).toString();
    // 把工作区（含 index）还原成 base——CP 这边还没应用任何东西。
    await gitIn(clone.dir, ["reset", "--hard", clone.baseSha]);
    await gitIn(clone.dir, ["clean", "-fd"]);

    const api = fakeApi({
      diff: async () =>
        diffPayload({
          base: clone.baseSha,
          patch: patchText,
          patchBytes: Buffer.byteLength(patchText),
          files: [{ path: "src/a.txt", status: "modified", additions: 1, deletions: 1, binary: false }],
        }),
    });
    const collected = await collectSandboxChanges({ api, target: TARGET, clone });
    assert.equal(collected.source, "patch");
    assert.equal(collected.fallbackReason, null);
    assert.equal(collected.patch.sha256, collected.sandboxPatchSha256);
    assert.equal(collected.patch.sha256, sha256(Buffer.from(patchText)));
    assert.equal(await readFile(path.join(clone.dir, "src", "a.txt"), "utf8"), "two\n");
    assert.equal(collected.files.length, 1);
  });

  test("外置 patch（truncated）：用 GET /files?raw=1 取回，内容完整的当内联处理", async () => {
    const clone = await makeClone("spill");
    await writeFile(path.join(clone.dir, "src", "a.txt"), "spilled\n");
    await gitIn(clone.dir, ["add", "-A", "-N"]);
    const patchBytes = Buffer.from(await gitIn(clone.dir, ["--no-pager", "diff", "--binary", "-M", clone.baseSha]));
    await gitIn(clone.dir, ["reset", "--hard", clone.baseSha]);
    await gitIn(clone.dir, ["clean", "-fd"]);

    let rawPath = "";
    const api = fakeApi({
      diff: async () =>
        diffPayload({
          base: clone.baseSha,
          patch: null,
          patchBytes: patchBytes.length,
          truncated: true,
          patchLogPath: "/tmp/reuben-cloud/diff/diff_unit.patch",
        }),
      readRaw: async (_endpoint, _token, filePath) => {
        rawPath = filePath;
        // 拆成两段发：证明取回是流式的（不是一次性 Buffer）。
        return Readable.from([patchBytes.subarray(0, 10), patchBytes.subarray(10)]);
      },
    });
    const collected = await collectSandboxChanges({ api, target: TARGET, clone });
    assert.equal(rawPath, "/tmp/reuben-cloud/diff/diff_unit.patch");
    assert.equal(collected.source, "patch");
    assert.equal(collected.patch.sha256, sha256(patchBytes));
    assert.equal(await readFile(path.join(clone.dir, "src", "a.txt"), "utf8"), "spilled\n");
  });

  test("`/diff` 回 413（patch_too_large）→ 直接走 archive 回退", async () => {
    const clone = await makeClone("too-large");
    // "沙箱里的那棵树"：a.txt 改了，old.txt 改名了。
    const tree = path.join(root, "too-large-target");
    await mkdir(path.join(tree, "src"), { recursive: true });
    await writeFile(path.join(tree, "src", "a.txt"), "archive wins\n");
    await writeFile(path.join(tree, "src", "renamed.txt"), "rename me\n");
    const packed = await collectPack(tree);

    const api = fakeApi({
      diff: async () => {
        throw apiError(413, "patch_too_large");
      },
      readArchive: async (_endpoint, _token, options) => {
        assert.deepEqual(options?.exclude, [".git"], "回退时没有排除 .git");
        return Readable.from(packed.tarball);
      },
    });

    const collected = await collectSandboxChanges({ api, target: TARGET, clone });
    assert.equal(collected.source, "archive");
    assert.equal(collected.fallbackReason, "diff_patch_too_large");
    assert.equal(collected.sandboxPatchSha256, null, "diff 都没成功，不该有 sandbox patch 的 sha");
    assert.deepEqual(collected.archive, { bytes: packed.bytes, sha256: packed.sha256 });
    assert.equal(await readFile(path.join(clone.dir, "src", "a.txt"), "utf8"), "archive wins\n");
    assert.equal(await readFile(path.join(clone.dir, "src", "renamed.txt"), "utf8"), "rename me\n");
    await assert.rejects(readFile(path.join(clone.dir, "src", "old.txt")));
    assert.ok(collected.files.length === 0, "diff 失败时文件列表留空（上层的 push 会自己算 shortstat）");
  });

  test("连不上沙箱（unreachable）**不回退**：同一条链路的 archive 只会把真正的错误换掉", async () => {
    const clone = await makeClone("unreachable");
    let archiveCalls = 0;
    const api = fakeApi({
      diff: async () => {
        throw new SandboxApiError("unreachable", "连不上沙箱");
      },
      readArchive: async () => {
        archiveCalls += 1;
        return Readable.from(Buffer.alloc(0));
      },
    });
    await assert.rejects(
      collectSandboxChanges({ api, target: TARGET, clone }),
      (error: unknown) => error instanceof SandboxApiError && error.reason === "unreachable",
    );
    assert.equal(archiveCalls, 0, "unreachable 时不该去试 archive");
  });

  test("应用到一半发现忠实度不一致（非规范 diff）→ archive 回退，且回退后的 patch 是规范的", async () => {
    const clone = await makeClone("mismatch");
    // 造一份"能应用、但和 git 规范输出不同"的 patch：把重命名写成 删除+新增。
    // （真实的 CRLF / 空白差异在 git 眼里就是这个形状：树对了，patch 的表示不同。）
    await gitIn(clone.dir, ["mv", "src/old.txt", "src/renamed.txt"]);
    // 注意这里**不带 `-M`**：显式的 `-M` 会把 renames 又打开，那样拿到的还是规范 patch。
    const nonCanonical = await runGit([
      "-c",
      "diff.renames=false",
      "-C",
      clone.dir,
      "--no-pager",
      "diff",
      "--binary",
      clone.baseSha,
    ]);
    const nonCanonicalPatch = nonCanonical.stdout;
    await gitIn(clone.dir, ["reset", "--hard", clone.baseSha]);
    await gitIn(clone.dir, ["clean", "-fd"]);

    const tree = path.join(root, "mismatch-tree");
    await mkdir(path.join(tree, "src"), { recursive: true });
    await writeFile(path.join(tree, "src", "a.txt"), "one\n");
    await writeFile(path.join(tree, "src", "renamed.txt"), "rename me\n");
    const packed = await collectPack(tree);

    const api = fakeApi({
      diff: async () =>
        diffPayload({
          base: clone.baseSha,
          patch: nonCanonicalPatch.toString("utf8"),
          patchBytes: nonCanonicalPatch.length,
        }),
      readArchive: async () => Readable.from(packed.tarball),
    });

    const collected = await collectSandboxChanges({ api, target: TARGET, clone });
    assert.equal(collected.source, "archive");
    assert.equal(collected.fallbackReason, "patch_sha256_mismatch");
    assert.equal(await readFile(path.join(clone.dir, "src", "renamed.txt"), "utf8"), "rename me\n");
    await assert.rejects(readFile(path.join(clone.dir, "src", "old.txt")));

    // 回退之后生成的 patch 是**规范**的（rename 而不是 delete+add），所以与沙箱那份不等。
    assert.notEqual(collected.patch.sha256, collected.sandboxPatchSha256);
  });
});
