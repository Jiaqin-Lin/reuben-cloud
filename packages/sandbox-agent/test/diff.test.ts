/**
 * Phase 3 的 diff 用例（对应 spec Phase 3 测试要点 1–5，外加参数校验与并发闸的补充）。
 *
 * 全部跑在真实 agent 上：临时目录当 workspace，真的起 git、真的把 patch apply 回去。
 * 不碰 Docker、不碰网络。
 *
 * 【为什么每个用例一个自己的 repo】diff 的基准是 commit，用例之间共享仓库会互相污染
 * base；每个用例在 workspace 里建一个子目录当仓库，用 `?path=` 指给端点。
 *
 * 【为什么 git 要用一套固定环境】沙箱里跑的 git 只有 PATH/HOME/LANG/TERM 这几个变量
 * （见 exec/spawn.ts 的 buildEnv），测试这边也必须一样——不然宿主机的用户级 git 配置
 * （autocrlf、diff 算法、重命名阈值）会让两边的 diff 对不上，得到假的失败。
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiffResponse } from "../src/types.ts";
import { runCommand, startTestAgent, waitFor, type TestAgent } from "./harness.ts";

let agent: TestAgent;
/** 临时目录：日志、外置 patch、HOME 都放这儿，不能落在 repo 里（会污染 diff 与归档）。 */
let scratch: string;
/** 测试自己跑 git 时用的空 HOME，和沙箱里那份环境保持一致。 */
let gitHome: string;

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "rc-diff-"));
  gitHome = path.join(scratch, "home");
  await mkdir(gitHome, { recursive: true });
  agent = await startTestAgent({
    env: {
      // scratch 是读根：外置 patch 落在这里面，CP（测试）才能用 /files?raw=1 读回来。
      SANDBOX_AGENT_READ_ROOTS: scratch,
      SANDBOX_LOG_ROOT: path.join(scratch, "logs"),
      SANDBOX_AGENT_DIFF_ROOT: path.join(scratch, "diff"),
      SANDBOX_AGENT_HOME: gitHome,
    },
  });
});

after(async () => {
  await agent.close();
  await rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 工具

function gitEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: gitHome, LANG: "C.UTF-8", TERM: "dumb" };
}

/** 跑一条 git（允许失败）。 */
function git(args: string[], cwd: string) {
  return runCommand(["git", "--no-pager", ...args], { cwd, env: gitEnv() });
}

/** 跑一条 git，失败就断言失败（带上 stderr）。 */
async function mustGit(args: string[], cwd: string): Promise<Buffer> {
  const result = await git(args, cwd);
  assert.equal(result.code, 0, `git ${args.join(" ")} 应该成功，stderr=${result.stderr}`);
  return result.stdout;
}

/** 建一个带初始 commit 的仓库，返回仓库目录与 base sha。 */
async function makeRepo(
  name: string,
  initial: Record<string, string | Buffer>,
): Promise<{ dir: string; base: string }> {
  const dir = path.join(agent.realRoot, name);
  await mkdir(dir, { recursive: true });
  await mustGit(["init", "-q", "-b", "main"], dir);
  await mustGit(["config", "user.email", "test@example.com"], dir);
  await mustGit(["config", "user.name", "Test"], dir);
  // autocrlf 关掉：patch 的忠实度比较的是字节，宿主机的换行配置不能掺进来。
  await mustGit(["config", "core.autocrlf", "false"], dir);
  for (const [relative, content] of Object.entries(initial)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mustGit(["add", "-A"], dir);
  await mustGit(["commit", "-q", "-m", "init"], dir);
  return { dir, base: (await mustGit(["rev-parse", "HEAD"], dir)).toString("utf8").trim() };
}

function getDiff(base: string, dir: string): Promise<Response> {
  return agent.request(`/diff?base=${encodeURIComponent(base)}&path=${encodeURIComponent(dir)}`);
}

async function diffBody(response: Response): Promise<DiffResponse> {
  if (response.status !== 200) {
    assert.fail(`expected 200, got ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as DiffResponse;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 把一棵树（跳过 .git）拍成可比较的 "相对路径 + 内容 sha256" 列表。 */
async function treeFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await treeFiles(root, relative)));
      continue;
    }
    const full = path.join(root, relative);
    if (entry.isSymbolicLink()) out.push(`${relative} link:${await readlink(full)}`);
    else out.push(`${relative} ${sha256(await readFile(full))}`);
  }
  return out.sort();
}

/**
 * 在另一份 clone 上应用 patch，然后做忠实度比较。
 * 这是 spec 里"两边 `git diff <base>` 的 sha256 相等"那条的落地：
 * clone 侧也要先 `add -A -N`，否则未跟踪的新文件不会出现在它的 diff 里。
 */
async function applyInClone(sourceDir: string, base: string, patch: Buffer, cloneName: string): Promise<void> {
  const clone = path.join(scratch, cloneName);
  await rm(clone, { recursive: true, force: true });
  await mustGit(["clone", "-q", sourceDir, clone], scratch);

  const patchFile = path.join(scratch, `${cloneName}.patch`);
  await writeFile(patchFile, patch);
  const applied = await git(["apply", "--binary", patchFile], clone);
  assert.equal(applied.code, 0, `git apply 失败：${applied.stderr}`);

  const cloneDiff = await mustGit(["add", "-A", "-N"], clone).then(() =>
    mustGit(["diff", "--binary", base], clone),
  );
  const sourceDiff = await mustGit(["add", "-A", "-N"], sourceDir).then(() =>
    mustGit(["diff", "--binary", base], sourceDir),
  );
  assert.equal(sha256(cloneDiff), sha256(sourceDiff), "apply 之后两边的 diff 不一致");
  // 再加上一层内容比较：diff 相等但落盘内容不同（比如 symlink 变成普通文件）也要抓住
  assert.deepEqual(await treeFiles(clone), await treeFiles(sourceDir));
}

// ---------------------------------------------------------------- 1–3：apply 往返

test("1-2: apply 往返 —— 修改 + 新增未跟踪文件，两边 sha256 相等", async () => {
  const { dir, base } = await makeRepo("roundtrip", {
    "src/a.txt": "one\ntwo\nthree\n",
    "keep.txt": "keep\n",
  });

  await writeFile(path.join(dir, "src/a.txt"), "one\nTWO\nthree\n");
  await writeFile(path.join(dir, "added.txt"), "brand new\n");

  const body = await diffBody(await getDiff(base, dir));
  assert.equal(body.base, base);
  assert.equal(body.head, base);
  assert.equal(body.truncated, false);
  assert.equal(body.patch_log_path, null);
  assert.ok(body.patch !== null && body.patch.includes("TWO"), "patch 里应该有改动");
  assert.ok(body.patch.includes("added.txt"), "未跟踪的新文件必须出现在 patch 里");

  // 文件列表：状态、增删行数、二进制标记
  const files = new Map(body.files.map((file) => [file.path, file]));
  assert.deepEqual(files.get("added.txt"), {
    path: "added.txt",
    status: "added",
    additions: 1,
    deletions: 0,
    binary: false,
  });
  assert.equal(files.get("src/a.txt")?.status, "modified");
  assert.equal(files.get("src/a.txt")?.additions, 1);
  assert.equal(files.get("src/a.txt")?.deletions, 1);

  // 端点返回的 patch 必须和直接跑 git 逐字节一致（端点已经 add -A -N 过，所以这里直接 diff）
  const direct = await mustGit(["diff", "--binary", base], dir);
  assert.equal(body.patch_bytes, direct.length);
  assert.equal(body.patch, direct.toString("utf8"));

  await applyInClone(dir, base, direct, "roundtrip-clone");
});

test("3: 删除 / 重命名 / 二进制改动都能 apply 回去，内容一致", async () => {
  const { dir, base } = await makeRepo("changes", {
    "delete-me.txt": "bye\n",
    "old-name.txt": "rename me\nsecond line\n",
    // 随机字节：几乎必然含 NUL，git 才会把它当二进制处理
    "image.bin": randomBytes(4096),
  });

  await rm(path.join(dir, "delete-me.txt"));
  await rename(path.join(dir, "old-name.txt"), path.join(dir, "new-name.txt"));
  await writeFile(path.join(dir, "image.bin"), randomBytes(4096));

  const body = await diffBody(await getDiff(base, dir));
  const files = new Map(body.files.map((file) => [file.path, file]));
  assert.equal(files.get("delete-me.txt")?.status, "deleted");
  assert.equal(files.has("old-name.txt"), false, "旧路径不该单独出现（存在检测到就该算 renamed）");
  assert.ok(files.has("new-name.txt"), "重命名后的新路径必须在列表里");
  assert.equal(files.get("image.bin")?.binary, true);

  // 二进制改动必须走 GIT binary patch，否则 apply 不回去
  const direct = await mustGit(["diff", "--binary", base], dir);
  assert.ok(direct.toString("utf8").includes("GIT binary patch"), "二进制改动没有生成 binary patch");

  await applyInClone(dir, base, direct, "changes-clone");
});

// ---------------------------------------------------------------- 4–5：大 patch 与失败路径

test("4: 大 patch（> 2 MiB）外置 —— patch_log_path 可读，字节与 git 一致", async () => {
  const { dir, base } = await makeRepo("large", { "seed.txt": "seed\n" });
  const big = path.join(dir, "big.txt");
  await writeFile(big, "x".repeat(3 * 1024 * 1024));

  const body = await diffBody(await getDiff(base, dir));
  assert.equal(body.truncated, true, "3 MiB 的 patch 不该内联");
  assert.equal(body.patch, null);
  assert.ok(body.patch_log_path !== null && body.patch_log_path.startsWith(agent.config.diffRoot));

  // CP 拿回完整 patch 走的就是这条路
  const raw = await agent.request(
    `/files?path=${encodeURIComponent(body.patch_log_path)}&raw=1`,
  );
  assert.equal(raw.status, 200);
  const bytes = Buffer.from(await raw.arrayBuffer());
  assert.equal(body.patch_bytes, bytes.length);

  const direct = await mustGit(["diff", "--binary", base], dir);
  assert.ok(bytes.equals(direct), "外置 patch 与 git 自己产出的 diff 不一致");
  assert.ok(bytes.toString("utf8").includes("big.txt"));

  await rm(big);
});

test("4b: patch 不是合法 UTF-8 时也外置 —— 原字节不能被换成 U+FFFD", async () => {
  const { dir, base } = await makeRepo("binary-text", { "seed.txt": "seed\n" });
  // 0xff 0xfe 不是合法 UTF-8，但也没有 NUL，git 会当成文本文件——这类文件的 diff
  // 里带着原始字节，JSON 装不下，必须走文件。
  const weird = Buffer.from([0xff, 0xfe, 0x20, 0x61, 0x62, 0x63, 0x0a]);
  await writeFile(path.join(dir, "weird.txt"), weird);

  const body = await diffBody(await getDiff(base, dir));
  assert.equal(body.truncated, true, "非 UTF-8 的 patch 必须外置");
  assert.equal(body.patch, null);

  const raw = await agent.request(`/files?path=${encodeURIComponent(body.patch_log_path!)}&raw=1`);
  const bytes = Buffer.from(await raw.arrayBuffer());
  const direct = await mustGit(["diff", "--binary", base], dir);
  assert.ok(bytes.equals(direct));

  await rm(path.join(dir, "weird.txt"));
});

test("4c: 外置 patch 超上限 → 413 patch_too_large（让 CP 走 archive 回退）", async () => {
  const small = await startTestAgent({
    env: { SANDBOX_AGENT_MAX_PATCH_BYTES: "256", SANDBOX_AGENT_MAX_PATCH_SPILL_BYTES: "1024" },
  });
  try {
    const dir = path.join(small.root, "repo");
    await mkdir(dir, { recursive: true });
    await mustGit(["init", "-q", "-b", "main"], dir);
    await mustGit(["config", "user.email", "test@example.com"], dir);
    await mustGit(["config", "user.name", "Test"], dir);
    await writeFile(path.join(dir, "seed.txt"), "seed\n");
    await mustGit(["add", "-A"], dir);
    await mustGit(["commit", "-q", "-m", "init"], dir);
    const base = (await mustGit(["rev-parse", "HEAD"], dir)).toString("utf8").trim();

    await writeFile(path.join(dir, "big.txt"), "y".repeat(4096));
    const response = await small.request(`/diff?base=${base}&path=${encodeURIComponent(dir)}`);
    assert.equal(response.status, 413);
    const body = (await response.json()) as { error: string; limit: number };
    assert.equal(body.error, "patch_too_large");
    assert.equal(body.limit, 1024);

    // 半成品外置文件必须删掉：留下一个"看起来能读"的半个 patch 比 413 更糟
    const leftovers = await readdir(small.config.diffRoot).catch(() => [] as string[]);
    assert.deepEqual(leftovers, []);
  } finally {
    await small.close();
  }
});

test("5: base 不认识 / 参数非法 / 不是仓库 → 各自的 400", async () => {
  const { dir } = await makeRepo("base-errors", { "f.txt": "x\n" });

  const unknown = await getDiff("0123456789abcdef0123456789abcdef01234567", dir);
  assert.equal(unknown.status, 400);
  assert.equal(((await unknown.json()) as { error: string }).error, "unknown_base");

  // base 是调用方给的，不能让它变成 git 的命令行开关
  const invalid = await getDiff("--upload-pack=touch /tmp/pwn", dir);
  assert.equal(invalid.status, 400);
  assert.equal(((await invalid.json()) as { error: string }).error, "invalid_base");

  const empty = await agent.request(`/diff?base=&path=${encodeURIComponent(dir)}`);
  assert.equal(empty.status, 400);
  assert.equal(((await empty.json()) as { error: string }).error, "invalid_base");

  // 目录存在但不是 git 仓库
  const plain = path.join(agent.realRoot, "not-a-repo");
  await mkdir(plain, { recursive: true });
  const notRepo = await agent.request(`/diff?path=${encodeURIComponent(plain)}`);
  assert.equal(notRepo.status, 400);
  assert.equal(((await notRepo.json()) as { error: string }).error, "not_a_git_repository");

  // 路径越界：和文件 API 用同一套 RootResolver，所以同样是 path_out_of_bounds
  const outside = await agent.request(`/diff?path=${encodeURIComponent("/etc")}`);
  assert.equal(outside.status, 400);
  assert.equal(((await outside.json()) as { error: string }).error, "path_out_of_bounds");
});

// ---------------------------------------------------------------- 补充：并发闸与超时

test("补充: 没有改动 —— 200 + 空 patch + 空文件列表（不是 404/400）", async () => {
  const { dir, base } = await makeRepo("clean", { "f.txt": "x\n" });

  const body = await diffBody(await getDiff(base, dir));
  assert.deepEqual(body.files, []);
  assert.equal(body.patch, "");
  assert.equal(body.patch_bytes, 0);
  assert.equal(body.truncated, false);
  assert.equal(body.patch_log_path, null);
});

test("补充: 超过 streamTimeoutMs → 504 stream_timeout，且槽要还回来", async () => {
  // 1ms 的时限：git 连 fork+exec 都走不完，第一道命令必然被杀。
  const fast = await startTestAgent({ env: { SANDBOX_AGENT_STREAM_TIMEOUT_MS: "1" } });
  try {
    const dir = path.join(fast.root, "repo");
    await mkdir(dir, { recursive: true });
    await mustGit(["init", "-q", "-b", "main"], dir);

    const response = await fast.request(`/diff?path=${encodeURIComponent(dir)}`);
    assert.equal(response.status, 504);
    assert.equal(((await response.json()) as { error: string }).error, "stream_timeout");

    // 超时不能把槽连着一起漏掉
    const health = (await (await fast.request("/health")).json()) as { activeExecution: string | null };
    assert.equal(health.activeExecution, null);
  } finally {
    await fast.close();
  }
});

test("补充: exec 在跑时 /diff 409，带占槽的 exec id", async () => {
  const exec = await agent.exec({ cmd: ["sleep", "30"] });
  assert.equal(exec.status, 202);
  const accepted = (await exec.json()) as { execution_id: string };

  try {
    const blocked = await agent.request(`/diff`);
    assert.equal(blocked.status, 409);
    const body = (await blocked.json()) as { error: string; activeExecution: string };
    assert.equal(body.error, "busy");
    assert.equal(body.activeExecution, accepted.execution_id);
  } finally {
    await agent.request(`/exec/${accepted.execution_id}/kill`, { method: "POST" });
    await waitFor(() => agent.registry.get(accepted.execution_id)?.status !== "running", {
      message: "exec 没有在超时前进入终态",
    });
  }

  // 槽还回来了：/diff 恢复可用，/health 也回到 null
  const health = (await (await agent.request("/health")).json()) as { activeExecution: string | null };
  assert.equal(health.activeExecution, null);
});
