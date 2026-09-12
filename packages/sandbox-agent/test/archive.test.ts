/**
 * Phase 3 的 archive 用例（对应 spec Phase 3 测试要点 6–11，外加 dryRun / exclude / 上限）。
 *
 * 全部跑在真实 agent 上：真的起系统 tar、真的走 HTTP、真的解包回来比对。
 * 不碰 Docker、不碰网络。
 *
 * 【为什么有一个专门的 temp agent 而不是复用别的测试文件】archive 打的是**整个 workspace**，
 * 用例之间只要共享一个 workspace 就会互相看见对方的残留。这个文件自己起一个 agent，
 * 每个用例在里面建自己的子目录、并在结束时删掉自己的大文件。
 *
 * 【关于 `pgrep -x tar`】用例 9 靠它验证"断开之后没有残留 tar"。它看到的是全系统的
 * tar 进程，所以这个文件里的用例必须串行（node:test 同文件默认就是串行），
 * 别的测试文件也不起 tar。这不是完美的隔离，但足够抓住"忘了杀进程"这一类回归。
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommand, startTestAgent, TEST_TOKEN, waitFor, type TestAgent } from "./harness.ts";

const MIB = 1024 * 1024;

let agent: TestAgent;
/** 临时目录：解包结果与临时 tar 文件都放这里，**在 workspace 之外**——在里面会污染归档本身。 */
let scratch: string;

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), "rc-archive-"));
  agent = await startTestAgent({
    env: {
      SANDBOX_AGENT_READ_ROOTS: scratch,
      SANDBOX_LOG_ROOT: path.join(scratch, "logs"),
      SANDBOX_AGENT_DIFF_ROOT: path.join(scratch, "diff"),
      SANDBOX_AGENT_HOME: path.join(scratch, "home"),
    },
  });
});

after(async () => {
  await agent.close();
  await rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 工具

function fetchArchive(query = "", target = agent, token = TEST_TOKEN): Promise<Response> {
  return fetch(`${target.baseUrl}/archive${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 把响应体读成 Buffer。归档只有几百 MiB 的情况下测试里读进来没问题。 */
async function readAll(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

/** 把一份归档解到一个空目录里。用系统 tar，和 CP 侧解包走同一套工具。 */
async function extractTar(buffer: Buffer, target: string): Promise<void> {
  const archive = path.join(scratch, `archive-${randomBytes(4).toString("hex")}.tar.gz`);
  await writeFile(archive, buffer);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  try {
    // --no-same-owner 是 CP 侧解包的同款约定（Phase 10）；测试里也用它。
    const result = await runCommand(["tar", "xzf", archive, "--no-same-owner", "-C", target]);
    assert.equal(result.code, 0, `tar 解包失败：${result.stderr}`);
  } finally {
    await rm(archive, { force: true });
  }
}

/** 把一整棵树拍成可比较的清单：目录、符号链接目标、每个文件的 sha256。 */
async function snapshot(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      out.push(`link ${relative} -> ${await readlink(path.join(root, relative))}`);
    } else if (entry.isDirectory()) {
      out.push(`dir ${relative}`);
      out.push(...(await snapshot(root, relative)));
    } else {
      const hash = createHash("sha256")
        .update(await readFile(path.join(root, relative)))
        .digest("hex");
      out.push(`file ${relative} ${hash}`);
    }
  }
  return out.sort();
}

/** 分块写随机（不可压缩）数据，避免在内存里一次性分配几百 MiB。 */
async function writeRandomFile(target: string, totalBytes: number): Promise<void> {
  const handle = await open(target, "w");
  try {
    for (let written = 0; written < totalBytes; written += MIB) {
      await handle.write(randomBytes(Math.min(MIB, totalBytes - written)));
    }
  } finally {
    await handle.close();
  }
}

/** 当前系统里叫 tar 的进程号。pgrep 没命中时退出码是 1、输出为空——那不是错误。 */
async function tarProcesses(): Promise<string[]> {
  const result = await runCommand(["pgrep", "-x", "tar"]);
  return result.stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");
}

/** archive 用例只在一个地方要 git（造一个真的忽略规则），所以就地写一个小封装。 */
function git(args: string[], cwd: string) {
  return runCommand(["git", "--no-pager", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: path.join(scratch, "home"), LANG: "C.UTF-8", TERM: "dumb" },
  });
}

// ---------------------------------------------------------------- 6、7、8：内容正确性

test("6: archive 包含被 .gitignore 排除的构建产物；?exclude= 能排掉", async () => {
  const repo = path.join(agent.realRoot, "ignored-repo");
  await mkdir(path.join(repo, "dist"), { recursive: true });
  await mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(repo, ".gitignore"), "dist/\nnode_modules/\n");
  await writeFile(path.join(repo, "src.js"), "console.log(1)\n");
  await writeFile(path.join(repo, "dist", "bundle.js"), "built\n");
  await writeFile(path.join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["add", "-A"],
    ["commit", "-q", "-m", "init"],
  ]) {
    const result = await git(args, repo);
    assert.equal(result.code, 0, `git ${args.join(" ")} 失败：${result.stderr}`);
  }

  // 先确认 git 真的把它们当忽略文件（不然这个用例测不到东西）
  const status = await git(["status", "--porcelain"], repo);
  assert.equal(status.stdout.toString().trim(), "", "被忽略的文件不该出现在 git status 里");

  const all = path.join(scratch, "ignored-all");
  await extractTar(await readAll(await fetchArchive()), all);
  assert.ok(existsSync(path.join(all, "ignored-repo", "dist", "bundle.js")), "构建产物必须在归档里");
  assert.ok(
    existsSync(path.join(all, "ignored-repo", "node_modules", "pkg", "index.js")),
    "node_modules 必须在归档里",
  );

  const excluded = path.join(scratch, "ignored-excluded");
  await extractTar(await readAll(await fetchArchive("?exclude=node_modules")), excluded);
  assert.ok(existsSync(path.join(excluded, "ignored-repo", "dist", "bundle.js")));
  assert.equal(existsSync(path.join(excluded, "ignored-repo", "node_modules")), false);
});

test("7: archive 往返 —— 解包后清单与每个文件 sha256 与源一致", async () => {
  const dir = path.join(agent.realRoot, "roundtrip");
  await mkdir(path.join(dir, "nested", "deep"), { recursive: true });
  await writeFile(path.join(dir, "text.txt"), "你好，世界\n");
  await writeFile(path.join(dir, "empty.txt"), "");
  await writeFile(path.join(dir, "binary.bin"), randomBytes(8192));
  await writeFile(path.join(dir, "nested", "deep", "x.txt"), "x\n");

  // 源快照是整个 workspace：里面已经有前面用例建的东西，正好一起验
  const source = await snapshot(agent.realRoot);
  const extractDir = path.join(scratch, "roundtrip-extract");
  await extractTar(await readAll(await fetchArchive()), extractDir);
  assert.deepEqual(await snapshot(extractDir), source);
});

test("8: 空目录与符号链接 —— symlink 以链接本体存入，不展开", async () => {
  const dir = path.join(agent.realRoot, "edges");
  await mkdir(path.join(dir, "empty-dir"), { recursive: true });
  await writeFile(path.join(dir, "target.txt"), "target\n");
  await symlink("target.txt", path.join(dir, "relative-link"));
  await symlink("/etc/hosts", path.join(dir, "absolute-link"));

  const extractDir = path.join(scratch, "edges-extract");
  await extractTar(await readAll(await fetchArchive()), extractDir);
  const base = path.join(extractDir, "edges");

  // 空目录本身要被保留（tar 默认会存目录项）
  assert.ok((await stat(path.join(base, "empty-dir"))).isDirectory());
  // 链接按本体存：指向哪就是哪，既没被展开成文件，也没被改成相对路径
  assert.equal(await readlink(path.join(base, "relative-link")), "target.txt");
  assert.equal(await readlink(path.join(base, "absolute-link")), "/etc/hosts");
});

// ---------------------------------------------------------------- 补充：dryRun

test("补充: dryRun 报体积与文件数，能配 exclude；dryRun 不占 BUSY 槽", async () => {
  const dir = path.join(agent.realRoot, "measure");
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "big.js"), "x".repeat(10_000));
  await writeFile(path.join(dir, "a.txt"), "hello");

  const response = await fetchArchive("?dryRun=1");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const measured = (await response.json()) as { size_bytes: number; file_count: number };
  assert.ok(measured.size_bytes >= 10_005, `size_bytes 应该至少 10005，实际 ${measured.size_bytes}`);
  assert.ok(measured.file_count >= 2, `file_count 应该至少 2，实际 ${measured.file_count}`);

  const withoutNodeModules = (await (await fetchArchive("?dryRun=1&exclude=node_modules")).json()) as {
    size_bytes: number;
  };
  assert.ok(
    measured.size_bytes - withoutNodeModules.size_bytes >= 10_000,
    "exclude=node_modules 之后体积应该少掉那 10000 字节",
  );

  // 参数拼错要 400，不静默当成 false
  assert.equal((await fetchArchive("?dryRun=maybe")).status, 400);
  assert.equal((await fetchArchive("?exclude=")).status, 400);

  // dryRun 不占槽：exec 在跑的时候也应该给得出来——CP 恰恰是这时候最需要这个数字
  const exec = await agent.exec({ cmd: ["sleep", "30"] });
  const accepted = (await exec.json()) as { execution_id: string };
  try {
    const during = await fetchArchive("?dryRun=1");
    assert.equal(during.status, 200);
  } finally {
    await agent.request(`/exec/${accepted.execution_id}/kill`, { method: "POST" });
    await waitFor(() => agent.registry.get(accepted.execution_id)?.status !== "running", {
      message: "exec 没有在超时前进入终态",
    });
  }
});

// ---------------------------------------------------------------- 9、10、11：中断、闸、内存

test("9: 中断传输 —— 断开之后没有残留的 tar 进程", async () => {
  const big = path.join(agent.realRoot, "interrupt.bin");
  await writeRandomFile(big, 64 * MIB);

  const controller = new AbortController();
  try {
    const response = await fetch(`${agent.baseUrl}/archive`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.ok(first.value !== undefined && first.value.byteLength > 0, "应该先收到一块归档数据");
    controller.abort();

    await waitFor(async () => (await tarProcesses()).length === 0, {
      timeoutMs: 5_000,
      message: "断开连接之后还有 tar 进程在跑",
    });
  } finally {
    await rm(big, { force: true });
  }
});

test("10: 并发闸 —— exec 在跑时 /archive 409；archive 在跑时 /health 报 archive_", async () => {
  // 第一半：exec 占着槽
  const exec = await agent.exec({ cmd: ["sleep", "30"] });
  const accepted = (await exec.json()) as { execution_id: string };
  try {
    const blocked = await fetchArchive();
    assert.equal(blocked.status, 409);
    const body = (await blocked.json()) as { error: string; activeExecution: string };
    assert.equal(body.error, "busy");
    assert.equal(body.activeExecution, accepted.execution_id);

    const health = (await (await agent.request("/health")).json()) as { activeExecution: string | null };
    assert.equal(health.activeExecution, accepted.execution_id);
  } finally {
    await agent.request(`/exec/${accepted.execution_id}/kill`, { method: "POST" });
    await waitFor(() => agent.registry.get(accepted.execution_id)?.status !== "running", {
      message: "exec 没有在超时前进入终态",
    });
  }

  // 第二半：archive 占着槽。故意不读响应体——背压会让 tar 卡住，槽就一直被占着。
  const big = path.join(agent.realRoot, "gate.bin");
  await writeRandomFile(big, 32 * MIB);
  const controller = new AbortController();
  try {
    const response = await fetch(`${agent.baseUrl}/archive`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);

    await waitFor(
      async () => {
        const health = (await (await agent.request("/health")).json()) as { activeExecution: string | null };
        return health.activeExecution !== null && health.activeExecution.startsWith("archive_");
      },
      { timeoutMs: 5_000, message: "/health 没显示出 archive_ 占槽" },
    );

    // 槽是共用的：diff 也要被挡，而且错误里能看出是谁占着
    const blocked = await agent.request("/diff");
    assert.equal(blocked.status, 409);
    const body = (await blocked.json()) as { activeExecution: string };
    assert.ok(body.activeExecution.startsWith("archive_"), `activeExecution=${body.activeExecution}`);
  } finally {
    controller.abort();
    await rm(big, { force: true });
    // 断开之后槽必须还回来，否则沙箱永久 409
    await waitFor(
      async () => {
        const health = (await (await agent.request("/health")).json()) as { activeExecution: string | null };
        return health.activeExecution === null;
      },
      { timeoutMs: 5_000, message: "archive 结束之后 BUSY 槽没有还回来" },
    );
  }
});

test("11: 流式内存 —— 256 MiB 不可压缩数据，agent RSS 增量 < 50 MiB", async () => {
  const big = path.join(agent.realRoot, "memory.bin");
  // 为什么不是 1 GiB 零字节：零字节 gzip 之后只有 1 MiB 上下，客户端和服务端都轻松放下，
  // 断言就对"有没有在流式处理"完全免疫了。不可压缩的随机数据才有几百 MiB 的 stdout 流量。
  await writeRandomFile(big, 256 * MIB);

  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 20);

  try {
    const response = await fetch(`${agent.baseUrl}/archive`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(response.status, 200);
    // 客户端只丢字节、不在内存里攒——被测的是服务端有没有把整个归档读进内存
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      void chunk;
    }
  } finally {
    clearInterval(sampler);
    await rm(big, { force: true });
  }

  const delta = peak - baseline;
  assert.ok(
    delta < 50 * MIB,
    `RSS 增量 ${(delta / MIB).toFixed(1)} MiB，超过 50 MiB —— 归档没有流式处理`,
  );
});

// ---------------------------------------------------------------- 补充：超上限

test("补充: 流出字节超上限 → 连接被断开，槽要还回来", async () => {
  const small = await startTestAgent({
    env: { SANDBOX_AGENT_MAX_ARCHIVE_BYTES: "4096" },
  });
  try {
    await writeRandomFile(path.join(small.root, "big.bin"), 64 * 1024);

    let failed = false;
    try {
      const response = await fetch(`${small.baseUrl}/archive`, {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      // 头可能已经流出来了，但 body 一定读不完——超限时服务端会 destroy 连接
      await response.arrayBuffer();
    } catch {
      failed = true;
    }
    assert.ok(failed, "超上限时连接应该被断开，而不是给出一份半截归档");

    // 关键：断连接之后 BUSY 槽必须还回来，否则后面所有请求都 409
    await waitFor(
      async () => {
        const health = (await (await small.request("/health")).json()) as { activeExecution: string | null };
        return health.activeExecution === null;
      },
      { timeoutMs: 5_000, message: "超限之后 BUSY 槽没有还回来" },
    );
  } finally {
    await small.close();
  }
});
