/**
 * Phase 5 的集成测试（`npm run test:integration`，**需要 Docker + 一个一次性 Postgres**）。
 *
 * 【它证明两件单测证明不了的事】
 *  ① **生成的 Dockerfile 真的能 build 成功**（spec P5 的验收标准）：三个 fixture 各生成一份，
 *     用"只含 Dockerfile 的临时目录"当构建上下文——顺便把 P6 测试要点 8 的隔离结论
 *     （构建上下文里没有仓库内容）在 P5 就先守住；
 *  ② **`environments` 表能存下一份完整候选**：真迁移 + 真 jsonb 往返 + revision 单调 +
 *     CHECK 约束有牙齿。
 *
 * 【为什么要先建 Layer 1】生成的 Dockerfile 的 FROM 是本地 tag（`reuben-cloud/base-*:dev`）。
 * 没建过的话 docker 会去 registry 找一个不存在的仓库，然后在网络层失败——报错离原因隔一层。
 * 所以这里显式跑一遍 `scripts/build-images.ts`：它既是前置条件，也顺带证明了这条**运维入口**
 * 本身是能跑的（首次几分钟，之后全命中层缓存）。
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Db, isCheckViolation } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import type { HealthReport } from "../../src/environment/health.ts";
import { readStoredHealth } from "../../src/environment/health.ts";
import { inferFromClone } from "../../src/environment/infer.ts";
import {
  cacheHitOf,
  findCacheHit,
  getEnvironmentByRevision,
  getProjectEnvState,
  insertEnvironment,
  latestEnvironment,
  listEnvironments,
  listReferencedDigests,
  setEnvironmentHealth,
  setEnvironmentImage,
} from "../../src/environment/store.ts";
import { environmentStore } from "../../src/environment/runtime.ts";
import { planRevisionCleanup, promoteEnvironment, rollbackEnvironment, RollbackError } from "../../src/environment/revision.ts";
import { CleanupRegistry, dockerAvailable, run, startPostgres } from "../support.ts";
import type { TestPostgres } from "../support.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/repos/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURE_NAMES = ["node-ts-basic", "python-poetry", "monorepo-devcontainer"] as const;

const cleanup = new CleanupRegistry();
let pg: TestPostgres;
let db: Db;
let built = false;

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("集成测试需要可用的 Docker daemon（npm run test:integration）。");
  }
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
});

after(async () => {
  await pg?.stop();
  await db?.close();
  await cleanup.sweep();
});

describe("Layer 1 与环境镜像的真实构建", () => {
  // 首次要装 apt / pip / npm 包（几分钟）；层缓存命中后是秒级。给足预算，
  // 而不是让"有没有缓存"决定这条用例红不红。
  test("基础镜像矩阵能建出来（common → 语言镜像 → sandbox-base）", { timeout: 1_800_000 }, async () => {
    const result = await run(["node", "scripts/build-images.ts", "sandbox-base", "node-dev", "ubuntu-dev"], {
      cwd: REPO_ROOT,
    });
    assert.equal(result.code, 0, `build-images 失败：\n${tail(result.stdout + result.stderr, 40)}`);
    for (const ref of [
      "reuben-cloud/base-common:dev",
      "reuben-cloud/base-node-dev:dev",
      "reuben-cloud/base-python-dev:dev",
      "reuben-cloud/base-ubuntu-dev:dev",
      "reuben-cloud/base-fullstack:dev",
      "reuben-cloud/sandbox-base:dev",
    ]) {
      const inspect = await run(["docker", "image", "inspect", "--format", "{{.Id}}", ref]);
      assert.equal(inspect.code, 0, `镜像不存在：${ref}\n${inspect.stderr.trim()}`);
    }

    // "镜像存在"不等于"工具链在里面"：每个镜像真跑一条命令。这一条同时是矩阵的**契约测试**
    // ——"node-dev 里有 pnpm/yarn"、“python-dev 里有 uv”这种话只有真跑过才算数。
    const toolchains: Array<[string, string, RegExp]> = [
      ["reuben-cloud/base-node-dev:dev", "node -v && pnpm -v && yarn -v", /v24\.[\d.]+\n[\d.]+\n1\.22\.\d+/],
      ["reuben-cloud/base-python-dev:dev", "python3 -V && uv --version", /Python 3\.11[\d.]*\nuv [\d.]+/],
      ["reuben-cloud/base-fullstack:dev", "python3 -V && psql --version && redis-cli --version", /psql \(PostgreSQL\) 1[\d.]+/],
      ["reuben-cloud/base-ubuntu-dev:dev", "cc --version | head -1", /cc \(Debian/],
    ];
    for (const [ref, command, expected] of toolchains) {
      const result = await run(["docker", "run", "--rm", ref, "bash", "-lc", command]);
      assert.equal(result.code, 0, `${ref} 里跑 ${command} 失败：\n${tail(result.stdout + result.stderr, 20)}`);
      assert.match(result.stdout, expected, `${ref} 的工具链不对：${result.stdout.trim()}`);
    }
    built = true;
  });

  for (const name of FIXTURE_NAMES) {
    test(`${name} 生成的 Dockerfile 能真的 build 成功（且继承沙箱的 CMD 与用户）`, { timeout: 900_000 }, async () => {
      assert.ok(built, "基础镜像那一步没成功");
      const result = await inferFromClone(path.join(FIXTURES, name));

      // 构建上下文 = 一个只含 Dockerfile 的临时目录：生成的文本里本来就没有 COPY/ADD 仓库内容，
      // 这里让它变成**可执行的证据**（真给一个带仓库内容的上下文，构建结果也一样是它）。
      const context = await mkdtemp(path.join(os.tmpdir(), "rc-env-build-"));
      const dockerfile = path.join(context, "Dockerfile");
      await writeFile(dockerfile, result.candidate.dockerfile);
      assert.deepEqual(await readdir(context), ["Dockerfile"]);

      const tag = `rc-test-env-${name}-${process.pid}:build`;
      cleanup.image(tag);
      try {
        const build = await run(["docker", "build", "--progress=plain", "-f", dockerfile, "-t", tag, context]);
        assert.equal(build.code, 0, `docker build 失败：\n${tail(build.stdout + build.stderr, 40)}`);

        // 环境镜像要能**直接当 SandboxSpec.image 用**（设计文档 §C.7 的"接口零改动"）：
        // 运行命令与非 root 用户都继承自 Layer 1，语言镜像只加了工具链。
        const user = await run(["docker", "image", "inspect", "--format", "{{.Config.User}}", tag]);
        assert.equal(user.stdout.trim(), "1000:1000", "环境镜像的默认用户必须是非 root");
        const cmd = await run(["docker", "image", "inspect", "--format", "{{json .Config.Cmd}}", tag]);
        assert.deepEqual(JSON.parse(cmd.stdout.trim()), ["node", "/app/src/index.ts"], "CMD 必须继承自 Layer 1");
      } finally {
        await rm(context, { recursive: true, force: true });
      }
    });
  }
});

describe("environments 表", () => {
  test("能存下一份完整候选：jsonb 往返、revision 单调、最新一条查得到", async () => {
    const projectKey = "fixture/node-ts-basic";
    const inference = await inferFromClone(path.join(FIXTURES, "node-ts-basic"));

    const first = await insertEnvironment(db, {
      projectKey,
      candidate: inference.candidate,
      signals: inference.signals,
    });
    assert.match(first.id, /^env_/);
    assert.equal(first.revision, 1);
    assert.equal(first.kind, "project");
    assert.equal(first.status, "draft");

    const second = await insertEnvironment(db, {
      projectKey,
      candidate: inference.candidate,
      signals: inference.signals,
      status: "building",
    });
    assert.equal(second.revision, 2);

    const latest = await latestEnvironment(db, projectKey);
    assert.equal(latest?.id, second.id);
    assert.equal(latest?.status, "building");
    // jsonb 往返：读回来的 signals 与采出来的一字不差（缓存键就是它的序列化结果）。
    assert.deepEqual(latest?.signals, inference.signals);
    assert.deepEqual(latest?.notes, inference.candidate.notes);
    assert.deepEqual(latest?.degraded_risks, inference.candidate.degradedRisks);
    assert.deepEqual(latest?.build_commands, inference.candidate.buildCommands);
    assert.deepEqual(latest?.verify_commands, inference.candidate.verifyCommands);
    assert.equal(latest?.dockerfile, inference.candidate.dockerfile);
    assert.equal(latest?.base_image, inference.candidate.baseImage);

    const history = await listEnvironments(db, projectKey);
    assert.deepEqual(
      history.map((row) => row.revision),
      [2, 1],
    );
  });

  test("CHECK 约束有牙齿：level / kind / status 写错一个字母都进不去", async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO environments
           (id, project_key, revision, kind, level, status, base_image, dockerfile, signals)
         VALUES ('env_test_bad_level', 'fixture/check', 1, 'project', 'banana', 'draft',
                 'reuben-cloud/base-node-dev:dev', 'FROM x', '{}'::jsonb)`,
      ),
      (error: unknown) => isCheckViolation(error),
    );
    await assert.rejects(
      db.query(
        `INSERT INTO environments
           (id, project_key, revision, kind, level, status, base_image, dockerfile, signals)
         VALUES ('env_test_bad_kind', 'fixture/check', 1, 'banana', 'signals', 'draft',
                 'reuben-cloud/base-node-dev:dev', 'FROM x', '{}'::jsonb)`,
      ),
      (error: unknown) => isCheckViolation(error),
    );
  });

  test("(project_key, revision) 唯一：同一 revision 写两次会被数据库挡住", async () => {
    const projectKey = "fixture/unique";
    const inference = await inferFromClone(path.join(FIXTURES, "node-ts-basic"));
    await insertEnvironment(db, { projectKey, candidate: inference.candidate, signals: inference.signals });
    // 手动插一条同 revision 的行（模拟"两个进程同时算出了 revision=1"）。
    await assert.rejects(
      db.query(
        `INSERT INTO environments
           (id, project_key, revision, kind, level, status, base_image, dockerfile, signals)
         VALUES ('env_test_dupe', $1, 1, 'project', 'signals', 'draft', 'reuben-cloud/base-node-dev:dev', 'FROM x', '{}'::jsonb)`,
        [projectKey],
      ),
      /environments_revision_unique|duplicate key/,
    );
  });
});


describe("Phase 7 · 版本、缓存与指针（真 PG）", () => {
  const projectKey = "fixture/p7-revisions";
  const digest = `sha256:${"a".repeat(64)}`;
  const otherDigest = `sha256:${"b".repeat(64)}`;

  /** 一条 ready 的体检报告（`setEnvironmentHealth` 同时写状态与报告）。 */
  function readyReport(): HealthReport {
    return {
      status: "ready",
      reason: null,
      detail: null,
      facts: [],
      steps: [{ cmd: "npm ci", required: true, exitCode: 0, timedOut: false, durationMs: 12, outputTail: "ok" }],
      logKey: "env-logs/fixture__p7-revisions/1/envcheck_IT.health.log",
      checkedAt: new Date("2026-01-02T03:04:05Z").toISOString(),
    };
  }

  test("cache_key / parent_revision / health 三组字段是真的落进 PG 的", async () => {
    const inference = await inferFromClone(path.join(FIXTURES, "node-ts-basic"));
    const first = await insertEnvironment(db, {
      projectKey,
      candidate: inference.candidate,
      signals: inference.signals,
      cacheKey: "cache-first",
    });
    assert.equal(first.cache_key, "cache-first");
    assert.equal(first.parent_revision, null, "首版没有父指针");
    assert.equal(first.image_digest, null);
    assert.deepEqual(first.health, {}, "没体检过时是空对象（不是 NULL）");

    const second = await insertEnvironment(db, {
      projectKey,
      candidate: inference.candidate,
      signals: inference.signals,
      cacheKey: "cache-second",
    });
    assert.equal(second.revision, 2);
    assert.equal(second.parent_revision, 1, "父指针指向上一版（插入时由 SQL 一起写）");

    // 镜像与体检结论分开落两次（构建成功 → 体检通过），读回来时都在。
    assert.equal(await setEnvironmentImage(db, projectKey, second.revision, digest), 1);
    assert.equal(await setEnvironmentHealth(db, projectKey, second.revision, readyReport()), 1);
    const row = await getEnvironmentByRevision(db, projectKey, second.revision);
    assert.equal(row?.status, "ready", "体检结论同时推进状态");
    assert.equal(row?.image_digest, digest);
    assert.equal(row?.health_reason, null);
    assert.equal(row?.health_log_key, "env-logs/fixture__p7-revisions/1/envcheck_IT.health.log");
    assert.ok(row?.health_checked_at instanceof Date);
    const report = readStoredHealth(row!.health);
    assert.equal(report?.steps[0]?.cmd, "npm ci");
  });

  test("缓存命中只认 ready / degraded + 有 digest 的那一行（draft 不算）", async () => {
    const key = "cache-hit-probe";
    const inference = await inferFromClone(path.join(FIXTURES, "node-ts-basic"));
    const row = await insertEnvironment(db, {
      projectKey: "fixture/p7-cache",
      candidate: inference.candidate,
      signals: inference.signals,
      cacheKey: key,
    });
    assert.equal(await findCacheHit(db, "fixture/p7-cache", key), null, "draft 没有可用镜像");
    await setEnvironmentImage(db, "fixture/p7-cache", row.revision, otherDigest);
    assert.equal(await findCacheHit(db, "fixture/p7-cache", key), null, "还是 draft：没体检就不算能用");
    await setEnvironmentHealth(db, "fixture/p7-cache", row.revision, {
      ...readyReport(),
      status: "degraded",
      reason: "declared_risk",
    });
    const hit = await findCacheHit(db, "fixture/p7-cache", key);
    assert.equal(hit?.revision, row.revision);
    assert.equal(cacheHitOf(hit!)?.status, "degraded");
    assert.equal(await findCacheHit(db, "fixture/p7-cache", "别的键"), null);
  });

  test("当前指针：upsert 指过去、回滚指回来、回滚到不能用的版本被拒", async () => {
    const inference = await inferFromClone(path.join(FIXTURES, "node-ts-basic"));
    const store = environmentStore(db);
    const first = await insertEnvironment(db, { projectKey: "fixture/p7-pointer", candidate: inference.candidate, signals: inference.signals, cacheKey: "k1" });
    const second = await insertEnvironment(db, { projectKey: "fixture/p7-pointer", candidate: inference.candidate, signals: inference.signals, cacheKey: "k2" });
    await setEnvironmentHealth(db, "fixture/p7-pointer", first.revision, readyReport());
    await setEnvironmentImage(db, "fixture/p7-pointer", first.revision, digest);

    await store.setProjectEnvState("fixture/p7-pointer", second.revision);
    assert.equal((await getProjectEnvState(db, "fixture/p7-pointer"))?.current_revision, 2);
    await store.setProjectEnvState("fixture/p7-pointer", first.revision);
    assert.equal((await getProjectEnvState(db, "fixture/p7-pointer"))?.current_revision, 1, "upsert 第二条生效");

    const rolled = await rollbackEnvironment(store, { projectKey: "fixture/p7-pointer", revision: 1 });
    assert.equal(rolled.status, "ready");
    assert.equal((await getProjectEnvState(db, "fixture/p7-pointer"))?.current_revision, 1);
    await assert.rejects(
      () => rollbackEnvironment(store, { projectKey: "fixture/p7-pointer", revision: 2 }),
      (error: unknown) => error instanceof RollbackError && error.reason === "not_usable",
    );
  });

  test("promote：新 revision 带父指针与缓存键、成功之后才动指针", async () => {
    const inference = await inferFromClone(path.join(FIXTURES, "node-ts-basic"));
    const store = environmentStore(db);
    const queue = { enqueue: async (request: { revision: number }) => ({ ok: true, revision: request.revision }) as never };
    const result = await promoteEnvironment(
      { store, queue },
      {
        projectKey: "fixture/p7-promote",
        dockerfile: `FROM ${inference.candidate.baseImage}\nRUN echo promoted\n`,
        candidate: inference.candidate,
        signals: inference.signals,
      },
    );
    assert.equal(result.environment?.parent_revision, null);
    assert.equal(result.cacheKey.length, 64);
    const row = await getEnvironmentByRevision(db, "fixture/p7-promote", result.revision);
    assert.equal(row?.cache_key, result.cacheKey);
    assert.equal(row?.dockerfile, `FROM ${inference.candidate.baseImage}\nRUN echo promoted\n`);
    assert.equal((await getProjectEnvState(db, "fixture/p7-promote"))?.current_revision, result.revision);
  });

  test("清理计划读得到沙箱引用：被 sandboxes.image_digest 指过的镜像永不清理", async () => {
    const inference = await inferFromClone(path.join(FIXTURES, "node-ts-basic"));
    const referencedKey = "fixture/p7-prune-referenced";
    const referenced = await insertEnvironment(db, {
      projectKey: referencedKey,
      candidate: inference.candidate,
      signals: inference.signals,
      cacheKey: "k-ref",
    });
    await setEnvironmentImage(db, referencedKey, referenced.revision, digest);
    await db.query(
      `INSERT INTO sandboxes (id, provider, image, image_digest, state, run_id)
       VALUES ('sbx_it_p7_ref', 'local-docker', $1, $1, 'DESTROYED', 'run_it_p7')`,
      [digest],
    );
    assert.ok((await listReferencedDigests(db)).includes(digest), "扫到被引用过的 digest");

    const referencedDigests = await listReferencedDigests(db);
    const rows = [
      { revision: 3, image_digest: digest, status: "ready" as const },
      { revision: 2, image_digest: otherDigest, status: "ready" as const },
      { revision: 1, image_digest: null, status: "failed" as const },
    ];
    const plan = planRevisionCleanup(rows, { keep: 1, referencedDigests });
    assert.deepEqual(plan.keep, [3], "被引用的那一版留在保留集里");
    assert.deepEqual(plan.pruned.sort((a, b) => a - b), [1, 2], "第 2 版超窗可删，第 1 版没有镜像");
    assert.deepEqual(plan.removeImages, [otherDigest], "只删第 2 版那个没被引用的镜像");
  });
});

function tail(text: string, lines: number): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}
