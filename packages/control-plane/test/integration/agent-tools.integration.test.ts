/**
 * Phase 11 的真容器集成测试（`npm run test:integration`，**需要 Docker + 沙箱镜像 + Postgres**）。
 *
 * 【它测什么】只有真容器能回答的那部分：
 *  · 四个工具在真沙箱里的完整往返（list → read → write → bash 跑测试 → 修好 → 再跑）
 *  · `bash` 的 tail 截断 + **按 offset 从 exec 日志续读**（读的是沙箱自己的日志文件）
 *  · 越界路径在真沙箱里被拒（工具层的错误翻译）
 *  · §F.3 的红线：**沙箱里搜不到模型 API key**（容器 config 的 env + 容器内全盘 grep）
 *
 * 【为什么模型 API key 那条要在这里测】它是"CP 的 env 有没有漏进沙箱"的唯一验证点。
 * 单测能证明的只是"我们没写这行代码"，而这条红线要的是"容器里真的没有"——
 * 它必须对着一个**真的启动起来**的容器搜一遍。测试在 CP 进程里塞一个哨兵值，
 * 然后按生产路径建沙箱；将来谁往 `SandboxSpec.env` 里加了这个 key，这条会立刻红。
 *
 * 【可选的真模型用例】`RUN_LIVE_AGENT=1` 且环境里有模型凭据时，会真的跑一遍
 * agent 循环（spec 测试要点 8 与 §K 第 9 步："给一个真实 issue，产出一个 patch"）。
 * provider 由 `modelFromEnv()` 选（看 key / `REUBEN_CLOUD_PROVIDER`）。
 * 默认跳过：它要花钱，而且结果不完全确定。
 *
 * 【跑之前】`npm run build:image`（`resolveImageRef()` 把 tag 解析成 digest）。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { SandboxApiClient } from "../../src/client/sandbox-api.ts";
import { Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { SandboxManager } from "../../src/manager/sandbox-manager.ts";
import { LocalDockerProvider } from "../../src/provider/local-docker.ts";
import { forwardContainerName, sandboxContainerName } from "../../src/provider/types.ts";
import { cloneRepo, removeRunDir } from "../../src/repo/clone.ts";
import { injectRepo } from "../../src/repo/inject.ts";
import { modelFromEnv, selectProvider } from "../../src/agent/model.ts";
import { runAgentLoop } from "../../src/agent/loop.ts";
import { Transcript } from "../../src/agent/transcript.ts";
import { REPO_DIR, buildSystemPrompt } from "../../src/agent/prompt.ts";
import { createToolkit } from "../../src/agent/tools/index.ts";
import { createReadAnchors } from "../../src/agent/tools/types.ts";
import type { ToolContext } from "../../src/agent/tools/types.ts";
import { runBash } from "../../src/agent/tools/bash.ts";
import { runList } from "../../src/agent/tools/list.ts";
import { runRead } from "../../src/agent/tools/read.ts";
import { runWrite } from "../../src/agent/tools/write.ts";
import {
  CleanupRegistry,
  deleteSandboxRows,
  dockerAvailable,
  dockerOrThrow,
  resolveImageRef,
  startPostgres,
} from "../support.ts";
import type { TestPostgres } from "../support.ts";

let pg: TestPostgres;
let db: Db;
let imageRef = "";
let tempRoot = "";
const cleanup = new CleanupRegistry();
const created: string[] = [];

/** 修好之后的 `src/math.js`。 */
const FIXED_MATH = "exports.add = (a, b) => a + b;\n";
/** buggy 版本（fixture 的初始状态）。 */
const BUGGY_MATH = "exports.add = (a, b) => a - b; // BUG: 应该相加\n";

/**
 * §F.3 的哨兵。**每次运行随机生成**：写死一个字符串的话，"搜不到"可能只是因为它碰巧
 * 不在任何文件里；随机值能保证"搜不到"是真的搜过（Phase 9 的 token 用例同一条理由）。
 */
const API_KEY_SENTINEL = `sk-ant-sentinel-${randomBytes(12).toString("hex")}`;

/**
 * 模块加载时先看清环境里到底有没有真凭据。
 *
 * 【为什么要在 before() 之前捕获】红线用例会把 CP 自己的两个 key 环境变量都换成哨兵
 * （随机串——写死一个字符串的话，"搜不到"可能只是因为它碰巧不在任何文件里）。
 * 而真模型用例需要那把**真** key：它在 before() 之后跑，所以必须先把原值留下来。
 * （这也是 Phase 11 原来的一个 bug：哨兵覆盖了真 key，`RUN_LIVE_AGENT=1` 跑起来会 401。）
 */
const liveSelection = selectProvider(process.env);
const liveRealKey = liveSelection === null ? "" : (process.env[liveSelection.apiKeyEnv] ?? "");
/** 红线用例要确认哨兵真的在 CP 环境里，用的是这个变量名。 */
const liveKeyEnv = liveSelection?.apiKeyEnv ?? "ANTHROPIC_API_KEY";

/** 在宿主上造一个带失败测试的小仓库。 */
async function makeFixtureRepo(): Promise<{ dir: string; baseSha: string }> {
  const dir = await mkdtemp(path.join(tempRoot, "repo-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "README.md"), "# fixture\n\nPhase 11 的工具集成测试用它。\n");
  await writeFile(
    path.join(dir, "package.json"),
    `${JSON.stringify({ name: "rc-agent-fixture", version: "1.0.0", scripts: { test: "node test.js" } }, null, 2)}\n`,
  );
  await writeFile(path.join(dir, "src/math.js"), BUGGY_MATH);
  await writeFile(
    path.join(dir, "test.js"),
    [
      'const { add } = require("./src/math.js");',
      "const actual = add(2, 3);",
      "if (actual !== 5) {",
      '  console.error("FAIL: add(2, 3) =", actual, "(expected 5)");',
      "  process.exit(1);",
      "}",
      'console.log("ok");',
      "",
    ].join("\n"),
  );
  await git(dir, ["init", "-q", "--initial-branch", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "init"]);
  const baseSha = (await git(dir, ["rev-parse", "HEAD"])).trim();
  return { dir, baseSha };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run(["git", ...args], { cwd });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr.trim()}`);
  return result.stdout;
}

/** 宿主命令（造 fixture 用；产品代码不走这里）。 */
function run(argv: string[], options: { cwd?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

let manager: SandboxManager;
let api: SandboxApiClient;
/** 这一次 Run 的 id（clone 的临时目录按它命名，after 里要删）。 */
let runId = "";
let sandboxId = "";
let endpoint = "";
let authToken = "";
let context: ToolContext;

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("Phase 11 的集成测试需要可用的 Docker daemon（npm run test:integration）。");
  }
  imageRef = await resolveImageRef();
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "rc-agent-tools-"));

  api = new SandboxApiClient();
  manager = new SandboxManager({ db, provider: new LocalDockerProvider(), api, image: imageRef });

  // CP 的进程环境里**故意**放上哨兵 key：这条红线测的是"它没有漏进沙箱"。
  // 两个 provider 的变量都塞：不管这次用的是哪一家，容器里的搜索都覆盖到了。
  process.env["ANTHROPIC_API_KEY"] = API_KEY_SENTINEL;
  process.env["DEEPSEEK_API_KEY"] = API_KEY_SENTINEL;

  const fixture = await makeFixtureRepo();
  runId = `run_agent_${randomBytes(4).toString("hex")}`;
  const createdSandbox = await manager.createSandbox({ runId });
  sandboxId = createdSandbox.sandboxId;
  created.push(sandboxId);
  cleanup.container(createdSandbox.containerName);
  cleanup.volume(createdSandbox.volumeName);
  if (process.platform === "darwin") cleanup.container(forwardContainerName(sandboxId));
  endpoint = createdSandbox.endpoint ?? "";
  authToken = createdSandbox.authToken ?? "";
  assert.ok(endpoint !== "" && authToken !== "", "沙箱没有 endpoint/token");

  // 仓库进沙箱：clone（本地 fixture，无凭据）→ tar → PUT /files → 解到 /workspace/repo。
  const clone = await cloneRepo({ runId, url: fixture.dir, commit: fixture.baseSha });
  const injected = await injectRepo({
    api,
    target: { endpoint, authToken, sandboxId },
    clone,
    workspaceDir: REPO_DIR,
  });
  assert.equal(injected.headSha, fixture.baseSha);

  context = {
    sandboxId,
    exec: manager,
    api,
    target: { endpoint, authToken, sandboxId },
    repoDir: REPO_DIR,
    anchors: createReadAnchors(),
    log: () => undefined,
  };
});

after(async () => {
  const failed = await cleanup.sweep();
  if (failed.length > 0) console.warn(`清理时有问题：\n  ${failed.join("\n  ")}`);
  await deleteSandboxRows(db, created);
  await db.close();
  await pg.stop();
  if (tempRoot !== "") await rm(tempRoot, { recursive: true, force: true });
  if (runId !== "") await removeRunDir(runId).catch(() => undefined);
});

describe("Phase 11 · 工具在真沙箱里", () => {
  test("list → read → write → bash：修好一个失败的测试", async () => {
    const listing = await runList({ path: "." }, context);
    assert.equal(listing.isError, false, listing.content);
    assert.equal(listing.content.includes("package.json"), true, listing.content);
    assert.equal(listing.content.includes("src/"), true, listing.content);

    const before = await runRead({ path: "src/math.js" }, context);
    assert.equal(before.isError, false);
    // 行式读的返回值不带末尾换行（行被 join 起来），所以比对 trimEnd 之后的内容。
    assert.equal(before.content, BUGGY_MATH.trimEnd());

    // 先跑一次失败的命令：非 0 退出不是 is_error，但模型能看到 [exit 1] 与错误正文。
    const failing = await runBash({ cmd: ["node", "test.js"], cwd: "src/.." }, context);
    assert.equal(failing.isError, false, failing.content);
    assert.equal(failing.content.includes("FAIL: add(2, 3) = -1"), true, failing.content);
    assert.equal(failing.content.includes("[exit 1]"), true, failing.content);

    const written = await runWrite({ path: "src/math.js", content: FIXED_MATH }, context);
    assert.equal(written.isError, false, written.content);
    assert.match(written.content, /^Wrote 31 bytes \(1 line\) to \/workspace\/repo\/src\/math\.js/);

    const after = await runRead({ path: "src/math.js" }, context);
    assert.equal(after.content, FIXED_MATH.trimEnd());

    const passing = await runBash({ cmd: ["node", "test.js"] }, context);
    assert.equal(passing.isError, false, passing.content);
    assert.equal(passing.content.includes("ok"), true, passing.content);
    assert.equal(passing.content.includes("[exit"), false, passing.content);

    // 产出：diff 里能看到这次改动（Phase 9/12 的接口就是这么接的）
    const diff = await api.diff(endpoint, authToken, { base: "HEAD", path: REPO_DIR });
    assert.equal(diff.files.some((file) => file.path === "src/math.js"), true, JSON.stringify(diff.files));
    assert.equal(diff.patch?.includes("exports.add"), true);
  });

  test("bash 大输出：tail + 从 exec 日志按 offset 续读", async () => {
    const result = await runBash({ cmd: ["seq", "1", "3000"] }, context);
    assert.equal(result.isError, false, result.content);
    const noticeAt = result.content.indexOf("\n\n[");
    assert.ok(noticeAt > 0, "3000 行应当被截断");
    const shown = result.content.slice(0, noticeAt).split("\n");
    assert.equal(shown.length, 2000);
    assert.equal(shown[0], "1001");
    assert.equal(shown.at(-1), "3000");
    const notice = result.content.slice(noticeAt + 2);
    assert.match(notice, /^\[Showing lines 1001-3000 of 3000\. Full output: \/tmp\/reuben-cloud\/exec\/exe_[A-Z0-9]+\.log\]$/);

    // 从日志里读回开头——`Full output` 那条路径在真沙箱里真的能走通。
    const logPath = /Full output: (\S+)\]/.exec(notice)![1]!;
    const head = await runRead({ path: logPath, offset: 1, limit: 3 }, context);
    assert.equal(head.isError, false, head.content);
    assert.equal(head.content.startsWith("1\n2\n3"), true, head.content);
  });

  test("越界路径在真沙箱里被拒，错误翻译成人话", async () => {
    const outside = await runRead({ path: "/etc/passwd" }, context);
    assert.equal(outside.isError, true);
    assert.match(outside.content, /越界/);

    const writeOutside = await runWrite({ path: "/tmp/pwn.txt", content: "x" }, context);
    assert.equal(writeOutside.isError, true);
    assert.match(writeOutside.content, /越界/);
  });

  test("§F.3 红线：沙箱的容器 env 里没有模型 API key", async () => {
    const containerEnv = await dockerOrThrow([
      "inspect",
      "--format",
      "{{json .Config.Env}}",
      sandboxContainerName(sandboxId),
    ]);
    assert.equal(containerEnv.includes(API_KEY_SENTINEL), false, `容器 env 里有哨兵：${containerEnv}`);
    assert.equal(containerEnv.includes("ANTHROPIC_API_KEY"), false, containerEnv);
    assert.equal(containerEnv.includes("DEEPSEEK_API_KEY"), false, containerEnv);
  });

  test("§F.3 红线：在容器里全盘搜不到模型 API key（含 /proc/*/environ）", async () => {
    // 搜索范围覆盖"能被写进文件的一切地方"（镜像根只读，但读得到）+ 进程环境。
    // `|| true` 是必要的：grep 一个都不匹配时返回 1，那是**期望**的结果。
    const found = await api.execAndWait(
      endpoint,
      authToken,
      {
        cmd: [
          "bash",
          "-lc",
          `grep -rl -- '${API_KEY_SENTINEL}' /workspace /tmp /etc /home /opt /srv /usr/local 2>/dev/null || true`,
        ],
        timeoutMs: 60_000,
      },
      { maxCaptureBytes: 64 * 1024 },
    );
    assert.equal(found.exitCode, 0, found.stderr);
    assert.equal(found.stdout.trim(), "", `容器里搜到了哨兵：${found.stdout}`);

    const procs = await api.execAndWait(
      endpoint,
      authToken,
      { cmd: ["bash", "-lc", `cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c '${API_KEY_SENTINEL}' || true`] },
      { maxCaptureBytes: 4096 },
    );
    assert.equal(procs.stdout.trim(), "0", `某个进程的环境里有哨兵：${procs.stdout}`);

    // 顺便确认哨兵**确实**在 CP 的进程环境里（否则上面两条断言是空转）
    assert.equal(process.env[liveKeyEnv], API_KEY_SENTINEL, `CP 环境里的 ${liveKeyEnv} 不是哨兵`);
  });
});

describe("Phase 11 · 真模型跑一遍（RUN_LIVE_AGENT=1 才跑）", () => {
  const live = process.env["RUN_LIVE_AGENT"] === "1" && liveRealKey !== "";

  test(
    "§K 第 9 步：给一个真实 issue，跑完产出一个 patch",
    { skip: live ? false : `需要 RUN_LIVE_AGENT=1 且 ${liveKeyEnv} 有真 key` },
    async () => {
      // 把前面红线用例换掉的哨兵换回真 key（见 liveRealKey 的注释）。
      process.env[liveKeyEnv] = liveRealKey;
      // 把 fixture 恢复到"测试失败"的状态，让模型有活可干。
      const reset = await runWrite({ path: "src/math.js", content: BUGGY_MATH }, context);
      assert.equal(reset.isError, false, reset.content);

      const transcript = await Transcript.create({
        runId: "run_live_agent",
        path: path.join(tempRoot, "transcript-live.jsonl"),
      });
      const toolkit = createToolkit({ sandboxId, exec: manager, api, target: { endpoint, authToken, sandboxId } });
      const result = await runAgentLoop({
        model: modelFromEnv(),
        tools: toolkit,
        transcript,
        system: buildSystemPrompt(),
        issue:
          "运行 `node test.js` 会失败。找出原因并修好它，然后重新运行确认测试通过。" +
          "只改必要的代码，不要改测试。",
        maxTurns: 20,
        wallClockMs: 15 * 60_000,
      });

      assert.equal(result.ok, true, `${result.stopReason}: ${result.detail}`);
      const fixed = await runBash({ cmd: ["node", "test.js"] }, context);
      assert.equal(fixed.content.includes("ok"), true, fixed.content);

      const diff = await api.diff(endpoint, authToken, { base: "HEAD", path: REPO_DIR });
      assert.equal(diff.files.length > 0, true, "模型跑完了但没有产出 patch");
      assert.equal(diff.patch?.includes("src/math.js"), true, diff.patch ?? "");
      console.log(
        `[live-agent] turns=${result.turns} tools=${result.toolCalls} patch_bytes=${diff.patchBytes} ` +
          `transcript=${transcript.path}`,
      );
    },
  );
});
