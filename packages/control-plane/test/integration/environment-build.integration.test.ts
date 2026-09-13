/**
 * Phase 6 的集成测试（`npm run test:integration`，**需要 Docker + 一个一次性 Postgres**）。
 *
 * 【它证明两件单测证明不了的事】
 *  ① **真 docker 的失败长这样**：一份坏了包名的 Dockerfile 真的构建失败，真日志落进 store、
 *     真的被分类成 `apt_package_missing`，第 2 轮修好后真的建出镜像、真的拿到 digest
 *     （spec 测试要点 7 与验收标准"人为缺一个依赖的仓库能在 ≤3 轮内构建成功"）；
 *  ② **SQL 那条路径**：`pgEnvBuildStore` 把 attempt 行、环境状态、成功后的文本写回与账本
 *     真的落进了 Postgres（单测用的是内存替身，SQL 只有在真 PG 上才算被跑过）。
 *
 * 【为什么模型是脚本化的】集成测试不许有模型 key、也不该依赖模型当天的脾气（AGENTS.md 的
 * 测试分层）。这里要验的是"构建与编排"，模型只负责给出两份文本——真模型那条路由
 * `npm run test:live` 覆盖。
 *
 * 【为什么要先确认 Layer 1 在本地】生成的 Dockerfile 的 FROM 是本地 tag
 * （`reuben-cloud/base-node-dev:dev`）。没建过的话 docker 会去 registry 找一个不存在的仓库，
 * 报错离原因隔一层——那正是 Phase 12 备注 12 说的"看起来像网络问题"。
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { SandboxApiClient } from "../../src/client/sandbox-api.ts";
import { DockerBuildRunner, FileBuildLogStore } from "../../src/environment/build.ts";
import type { HealthSandboxPort } from "../../src/environment/health.ts";
import { runHealthCheck } from "../../src/environment/health.ts";
import { createHealthSandboxPort } from "../../src/environment/health-sandbox.ts";
import { computeCacheKey } from "../../src/environment/cache.ts";
import { inferFromClone } from "../../src/environment/infer.ts";
import { BuildQueue } from "../../src/environment/queue.ts";
import {
  getEnvironmentByRevision,
  insertEnvironment,
  latestEnvironment,
  listEnvBuilds,
  pgEnvBuildStore,
  setEnvironmentHealth,
} from "../../src/environment/store.ts";
import { LocalDockerProvider } from "../../src/provider/local-docker.ts";
import { SandboxManager } from "../../src/manager/sandbox-manager.ts";
import { REPO_DIR } from "@reuben-cloud/agent-runtime";
import type { RepoSignals } from "../../src/environment/types.ts";
import { CleanupRegistry, dockerAvailable, resolveImageRef, run, startPostgres } from "../support.ts";
import type { TestPostgres } from "../support.ts";
import { FakeBuildRunner, ScriptedDockerfileGenerator } from "../environment-fakes.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/repos/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const BASE_IMAGE = "reuben-cloud/base-node-dev:dev";

const cleanup = new CleanupRegistry();
let pg: TestPostgres;
let db: Db;
let logRoot: string;

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("集成测试需要可用的 Docker daemon（npm run test:integration）。");
  }
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
  logRoot = await mkdtemp(path.join(os.tmpdir(), "rc-env-it-logs-"));

  const inspect = await run(["docker", "image", "inspect", "--format", "{{.Id}}", BASE_IMAGE]);
  if (inspect.code !== 0) {
    const built = await run(["node", "scripts/build-images.ts", "node-dev"], { cwd: REPO_ROOT });
    assert.equal(built.code, 0, `Layer 1 建不出来：\n${built.stdout}${built.stderr}`);
  }
});

after(async () => {
  await pg?.stop();
  await db?.close();
  await cleanup.sweep();
  if (logRoot !== undefined) await rm(logRoot, { recursive: true, force: true });
});

/** 推断结果 → 缓存键（队列入队时要有它）。 */
function cacheKeyOf(inference: Awaited<ReturnType<typeof inferFromClone>>): string {
  return computeCacheKey({
    baseImage: inference.candidate.baseImage,
    signals: inference.signals,
    dockerfileText: inference.candidate.dockerfile,
  });
}

/** 读一个流（日志取回用）。 */
async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** 当前临时目录里我们自己的构建目录（上下文 / iid）。用来断言"跑完没留下东西"。 */
async function buildTempDirs(): Promise<string[]> {
  return (await readdir(os.tmpdir())).filter((name) => name.startsWith("rc-env-ctx-") || name.startsWith("rc-env-iid-"));
}

describe("Phase 6 · 真 docker 的自愈", () => {
  test(
    "第 1 轮包名不存在（真日志真分类）→ 第 2 轮修好：两行 attempt、日志可取回、digest 可用",
    { timeout: 900_000 },
    async () => {
      const projectKey = "fixture/node-ts-basic-p6";
      const inference = await inferFromClone(path.join(FIXTURES, "node-ts-basic"));
      assert.equal(inference.candidate.level, "signals", "这个 fixture 是 signals 级（第一轮就上模型）");
      const environment = await insertEnvironment(db, {
        projectKey,
        candidate: inference.candidate,
        signals: inference.signals,
      });

      const beforeTemp = await buildTempDirs();
      const usageBefore = await countEnvUsage();

      const logStore = new FileBuildLogStore(logRoot);
      const builder = new DockerBuildRunner({ logStore });
      // 第 1 轮：模型猜错了包名（bookworm 里没有 libvips42-dev）；第 2 轮：改成存在的包。
      const broken = `FROM ${BASE_IMAGE}\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends libvips42-dev\nUSER 1000:1000\n`;
      const fixed = `FROM ${BASE_IMAGE}\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends jq\nUSER 1000:1000\n`;
      const generator = new ScriptedDockerfileGenerator([{ dockerfile: broken }, { dockerfile: fixed }]);
      const queue = new BuildQueue({ builder, store: pgEnvBuildStore(db), generator, timeoutMs: 600_000 });

      const outcome = await queue.enqueue({
        projectKey,
        revision: environment.revision,
        candidate: inference.candidate,
        signals: inference.signals,
        trigger: "manual",
        cacheKey: cacheKeyOf(inference),
      });

      assert.equal(outcome.ok, true, `构建应当自愈成功：${outcome.detail ?? ""}`);
      assert.equal(outcome.attempts, 2);
      assert.match(outcome.imageDigest ?? "", /^sha256:[0-9a-f]{64}$/);

      // ---- 真 PG：两行 attempt，失败那行有分类与日志 key，成功那行有 digest。
      const rows = await listEnvBuilds(db, projectKey, environment.revision);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.status, "failed");
      assert.equal(rows[0]!.error_class, "apt_package_missing");
      assert.equal(rows[0]!.inference, "llm");
      assert.equal(rows[0]!.trigger, "manual");
      assert.match(rows[0]!.log_key ?? "", /^env-logs\/fixture__node-ts-basic-p6\/1\/bld_.*\.log$/);
      assert.equal(rows[1]!.status, "built");
      assert.equal(rows[1]!.image_digest, outcome.imageDigest);

      // ---- 日志真的落在 store 里，而且人类可读（有 docker 的分步输出与 apt 的报错原文）。
      const log = await readStream(await logStore.get(rows[0]!.log_key!));
      assert.match(log, /E: Unable to locate package libvips42-dev/);
      assert.match(log, /did not complete successfully/);

      // ---- 环境定义写回成第二轮真正构建的那份；状态留给 P7 的健康检查（仍是 building）。
      const latest = await latestEnvironment(db, projectKey);
      assert.equal(latest?.dockerfile, fixed);
      assert.equal(latest?.status, "building");

      // ---- digest 指向本地一个真的存在的镜像（provider 的 resolveImageRef 走同一条路）。
      const inspect = await run(["docker", "image", "inspect", "--format", "{{.Id}}", outcome.imageDigest!]);
      assert.equal(inspect.code, 0, `digest 在本地找不到：${outcome.imageDigest}`);
      assert.equal(inspect.stdout.trim(), outcome.imageDigest);

      // ---- 账本：两轮 LLM 生成各一行（kind='env_build'）。
      assert.equal((await countEnvUsage()) - usageBefore, 2);

      // ---- 构建上下文与 iidfile 的临时目录都清干净了（测试要点 8 的收尾一半）。
      assert.deepEqual(await buildTempDirs(), beforeTemp);

      // ---- 收尾：删掉这一版环境与镜像（集成测试不该在宿主上留垃圾）。
      cleanup.image(outcome.imageDigest!);
    },
  );
});

describe("Phase 6 · 队列行为走真 PG", () => {
  test("同仓库去重、失败不阻塞、usage 落库（假 builder + 真 SQL）", { timeout: 120_000 }, async () => {
    const inference = await inferFromClone(path.join(FIXTURES, "node-ts-basic"));
    const signals: RepoSignals = inference.signals;
    const keys = { dup: "fixture/p6-dup", broken: "fixture/p6-broken", healthy: "fixture/p6-healthy" };
    const revisions = new Map<string, number>();
    for (const key of Object.values(keys)) {
      const row = await insertEnvironment(db, {
        projectKey: key,
        candidate: inference.candidate,
        signals,
      });
      revisions.set(key, row.revision);
    }

    const usageBefore = await countEnvUsage();
    const npmLog = await readFile(fileURLToPath(new URL("../fixtures/build-logs/npm-404.log", import.meta.url)), "utf8");
    const builder = new FakeBuildRunner([
      { ok: true, delayMs: 20 }, // dup（第 1 次）
      { ok: false, log: npmLog }, // broken
      { ok: false, log: npmLog },
      { ok: false, log: npmLog },
      { ok: true }, // healthy
    ]);
    const generator = new ScriptedDockerfileGenerator([{ dockerfile: `FROM ${BASE_IMAGE}\n` }]);
    const queue = new BuildQueue({ builder, store: pgEnvBuildStore(db), generator });

    // 同一个仓库连发两次（测试要点 9 / P7 测试要点 10 的同一个行为）：只建一次。
    const dup1 = queue.enqueue({ projectKey: keys.dup, revision: revisions.get(keys.dup)!, candidate: inference.candidate, signals, trigger: "first_seen", cacheKey: cacheKeyOf(inference) });
    const dup2 = queue.enqueue({ projectKey: keys.dup, revision: revisions.get(keys.dup)!, candidate: inference.candidate, signals, trigger: "first_seen", cacheKey: cacheKeyOf(inference) });
    assert.equal(dup1, dup2, "第二个入队复用进行中的那次");

    const broken = queue.enqueue({ projectKey: keys.broken, revision: revisions.get(keys.broken)!, candidate: inference.candidate, signals, trigger: "first_seen", cacheKey: cacheKeyOf(inference) });
    const healthy = queue.enqueue({ projectKey: keys.healthy, revision: revisions.get(keys.healthy)!, candidate: inference.candidate, signals, trigger: "first_seen", cacheKey: cacheKeyOf(inference) });
    const [a, b, c] = await Promise.all([dup1, broken, healthy]);

    assert.equal(a.ok, true);
    assert.equal(b.ok, false, "坏仓库自己失败");
    assert.equal(b.errorClass, "npm_404");
    assert.equal(c.ok, true, "失败不阻塞后面排队的");

    // 真 SQL：行数与状态都对，且坏仓库那一版的 environments.status 收在 failed。
    const dupRows = await listEnvBuilds(db, keys.dup, revisions.get(keys.dup)!);
    assert.equal(dupRows.length, 1, "去重之后只有一个 attempt");
    assert.equal(dupRows[0]!.trigger, "first_seen");
    const brokenRows = await listEnvBuilds(db, keys.broken, revisions.get(keys.broken)!);
    assert.equal(brokenRows.length, 3);
    assert.equal((await latestEnvironment(db, keys.broken))?.status, "failed");
    assert.equal((await latestEnvironment(db, keys.healthy))?.status, "building");

    // usage：dup 1 次 + broken 3 次 + healthy 1 次（脚本化生成器每次都带 usage）。
    assert.equal((await countEnvUsage()) - usageBefore, 5);
  });
});

/** 数一数账本里 kind='env_build' 的行（测试用增量断言，避免依赖别的用例的余量）。 */
async function countEnvUsage(): Promise<number> {
  const result = await db.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM usage_ledger WHERE kind = 'env_build'",
  );
  return result.rows[0]?.count ?? 0;
}

describe("Phase 7 · 真沙箱里的体检", () => {
  test(
    "一次性沙箱：起容器 → 灌入 fixture 仓库 → exec → ready 落库 → 沙箱销毁",
    { timeout: 900_000 },
    async () => {
      const projectKey = "fixture/node-ts-basic-p7-health";
      const inference = await inferFromClone(path.join(FIXTURES, "node-ts-basic"));
      const environment = await insertEnvironment(db, {
        projectKey,
        candidate: inference.candidate,
        signals: inference.signals,
        cacheKey: "p7-health-cache",
      });

      // 这一版的"产物"用 Layer 1 的 digest：**构建**那条真路径在 P6 的用例里证过了，
      // 这里要证的是 P7 那三段真动作（起一次性沙箱 / 灌仓库 / exec / 销毁）。
      const image = await resolveImageRef(BASE_IMAGE);

      // 体检要在一个真 git 仓库上跑：把 fixture 拷出来做一个本地仓库（cloneRepo 直接 clone 它）。
      const repoDir = await mkdtemp(path.join(os.tmpdir(), "rc-p7-health-repo-"));
      const local = await run(["bash", "-lc", `cp -r ${path.join(FIXTURES, "node-ts-basic")}/. ${repoDir}/`]);
      assert.equal(local.code, 0, `拷 fixture 失败：${local.stderr}`);
      for (const gitArgs of [
        ["init", "-q", "--initial-branch", "main"],
        ["add", "-A"],
        ["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "commit", "-qm", "fixture"],
      ]) {
        const result = await run(["git", "-C", repoDir, ...gitArgs]);
        assert.equal(result.code, 0, `git ${gitArgs.join(" ")} 失败：${result.stderr}`);
      }
      const commit = (await run(["git", "-C", repoDir, "rev-parse", "HEAD"])).stdout.trim();

      const provider = new LocalDockerProvider();
      // 体检沙箱用一个**不带 artifacts** 的 manager（体检没有产出要归档）。
      const manager = new SandboxManager({ db, provider, image });
      const sandbox = createHealthSandboxPort({
        manager,
        api: new SandboxApiClient(),
        repo: { url: repoDir, commit, token: async () => null },
        workspaceDir: REPO_DIR,
      });
      const tracked = trackSandboxes(sandbox);
      const logKey = "env-logs/fixture__node-ts-basic-p7-health/1/envcheck_it.health.log";

      try {
        const report = await runHealthCheck({
          image,
          runId: "envcheck_it_p7",
          repoDir: REPO_DIR,
          // 体检计划换成一条**不依赖网络**的命令：这条用例要验的是"仓库真的在沙箱里、
          // 命令真的在仓库根里跑、结论真的落库"，而不是 npm registry 今天通不通（那是 P6 的事）。
          plan: {
            steps: [
              { cmd: "test -f package.json && test -d .git && pwd", required: true, purpose: "仓库灌进来了、cwd 对" },
            ],
            facts: [],
          },
          sandbox: tracked,
          logs: new FileBuildLogStore(logRoot),
          logKey,
        });

        assert.equal(report.status, "ready", `体检没通过：${JSON.stringify(report.steps)}`);
        assert.match(report.steps[0]!.outputTail, new RegExp(REPO_DIR));
        assert.equal(report.logKey, logKey);
        // 日志真的落到盘上（"日志可取回并人类可读"这条验收的真实形态）。
        const text = await readStream(await new FileBuildLogStore(logRoot).get(logKey));
        assert.match(text, /test -f package.json/);
        assert.match(text, /# 结论：ready/);

        // ---- 结论落库：状态与报告一起写，Run 侧的解析才拿得到 status=ready + digest。
        assert.equal(await setEnvironmentHealth(db, projectKey, environment.revision, report), 1);
        const row = await getEnvironmentByRevision(db, projectKey, environment.revision);
        assert.equal(row?.status, "ready");
        assert.ok(row?.health_checked_at instanceof Date);
        assert.match(row?.health_log_key ?? "", /envcheck_it\.health\.log$/);

        // ---- 一次性沙箱真的销毁了（不是留给 sweeper）。
        assert.deepEqual(tracked.destroyed, tracked.opened);
        const sbx = await db.query<{ state: string }>("SELECT state FROM sandboxes WHERE id = $1", [tracked.opened[0]]);
        assert.equal(sbx.rows[0]?.state, "DESTROYED");
      } finally {
        await rm(repoDir, { recursive: true, force: true });
      }
    },
  );
});

/** 包一层：记下体检真的建了哪个沙箱、真的销毁了哪个（断言"跑完即焚"）。 */
function trackSandboxes(port: HealthSandboxPort): HealthSandboxPort & { opened: string[]; destroyed: string[] } {
  const opened: string[] = [];
  const destroyed: string[] = [];
  return {
    opened,
    destroyed,
    async open(input: { image: string; runId: string }) {
      const handle = await port.open(input);
      opened.push(handle.sandboxId);
      return handle;
    },
    exec: (input) => port.exec(input),
    async destroy(sandboxId: string, reason: string) {
      destroyed.push(sandboxId);
      await port.destroy(sandboxId, reason);
    },
  };
}
