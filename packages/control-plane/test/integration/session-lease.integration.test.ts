/**
 * Phase 2 的会话租约集成测试（`npm run test:integration`，**需要 Docker + Postgres**）。
 *
 * 【它回答什么】单元测试用假端口证明了租约的**策略**（何时复用、何时回收、失败怎么办）；
 * 这一条走真实现：`createSandboxProvisioner`（clone → 建容器 → 灌仓库）与
 * `createSandboxFlusher`（取 diff → apply → push）。spec P2 测试要点 12/13 的原话是
 * "有改动则推分支 + 销毁 + sessions.sandbox_id = null" 与 "回收后重建，仓库起点 =
 * 任务分支 head（不是 base_commit）"——这两句只有真的 git 远端能回答。
 *
 * 【远端为什么是本地 smart-HTTP fixture】与 Phase 9 同一条理由：CI 里没有 GitHub App，
 * 而"改动真的进了分支"这件事需要一个真的 git 服务端（`git http-backend`）。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { REPO_DIR } from "@reuben-cloud/agent-runtime";
import { SandboxApiClient } from "../../src/client/sandbox-api.ts";
import { Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { SandboxManager } from "../../src/manager/sandbox-manager.ts";
import { LocalDockerProvider } from "../../src/provider/local-docker.ts";
import { removeRunDir } from "../../src/repo/clone.ts";
import { lsRemoteSha } from "../../src/repo/push.ts";
import { SandboxLease } from "../../src/session/sandbox-lease.ts";
import { PostgresSessionStore } from "../../src/session/postgres.ts";
import { createSandboxFlusher, createSandboxProvisioner, managerSandboxPort } from "../../src/session/provision.ts";
import { createGitFixtureRepo, dockerAvailable, resolveImageRef, startGitHttpServer, startPostgres } from "../support.ts";
import type { GitFixtureRepo, GitHttpServer, TestPostgres } from "../support.ts";

const api = new SandboxApiClient();
const provider = new LocalDockerProvider();

let pg: TestPostgres;
let db: Db;
let store: PostgresSessionStore;
let manager: SandboxManager;
let server: GitHttpServer;
let fixture: GitFixtureRepo;
let tempRoot = "";
let image = "";
let lease: SandboxLease;
/** 测试里建出来的沙箱，after 里逐个销毁（真容器不留给下一轮）。 */
const created: string[] = [];
/** 会话的 clone 落在 `/tmp/reuben-cloud-cp/<sessionId>/`，after 里删掉。 */
const sessionDirs: string[] = [];

/** fixture 远端的 token（服务器会校验它；**这个串不会进沙箱**）。 */
const TEST_TOKEN = `ghs_lease_${randomBytes(8).toString("hex")}`;

/** 注入时钟：租约的"拨快 30 分钟"只是改一个数字。 */
let nowMs = Date.now();
const now = (): Date => new Date(nowMs);

const BRANCH = "reuben-cloud/lease-test";
const IDLE_TTL_MS = 30 * 60_000;

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("会话租约的集成测试需要可用的 Docker daemon（npm run test:integration）。");
  }
  image = await resolveImageRef();
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
  store = new PostgresSessionStore(db);
  manager = new SandboxManager({ db, provider, image });

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "rc-lease-"));
  server = await startGitHttpServer({ root: path.join(tempRoot, "git"), token: TEST_TOKEN });
  fixture = await createGitFixtureRepo({ server });

  const token = async (): Promise<string> => TEST_TOKEN;
  lease = new SandboxLease({
    store,
    sandboxes: managerSandboxPort(manager),
    provision: createSandboxProvisioner({
      manager,
      api,
      repo: { url: fixture.url, token },
      workspaceDir: REPO_DIR,
    }),
    flush: createSandboxFlusher({
      api,
      repo: { url: fixture.url, token },
      branch: BRANCH,
      title: "会话租约集成测试",
    }),
    image: () => image,
    now,
    settings: { idleTtlMs: IDLE_TTL_MS },
  });
});

after(async () => {
  for (const sandboxId of created) {
    await manager.destroySandbox(sandboxId, "lease_test_cleanup").catch(() => undefined);
  }
  for (const sessionId of sessionDirs) {
    await removeRunDir(sessionId).catch(() => undefined);
  }
  await server?.close().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  await db?.close().catch(() => undefined);
  await pg?.stop().catch(() => undefined);
});

describe("Phase 2 · 会话租约（真沙箱 + 真 git）", () => {
  test("12/13. 热着复用 → 空闲回收（推分支 + 销毁）→ 重建时接得上", async () => {
    const { id: sessionId } = await store.createSession({
      repoKey: "fixture/repo",
      baseCommit: fixture.baseSha,
      cwd: REPO_DIR,
      taskId: "lease-test",
      headRef: BRANCH,
      headCommit: fixture.baseSha,
    });
    sessionDirs.push(sessionId);

    // ---- 第一次 acquire：真的建容器、真的灌仓库。
    const runId = `run_${randomBytes(6).toString("hex")}`;
    const first = await lease.acquire(sessionId, { runId });
    created.push(first.sandboxId);
    assert.ok(first.endpoint.startsWith("http"), "沙箱没有 endpoint");
    assert.equal((await store.getSession(sessionId))?.sandboxId, first.sandboxId);

    // 会话的 clone 落在会话自己的目录里（回收后重建要用）。
    await store.setSessionSandbox(sessionId, { at: now() });

    // ---- 五次工具调用式的 acquire：还是同一个沙箱（热着复用）。
    for (let index = 0; index < 5; index += 1) {
      nowMs += 60_000;
      const again = await lease.acquire(sessionId, { runId });
      assert.equal(again.sandboxId, first.sandboxId);
    }

    // ---- 在沙箱里改一个文件（模拟 agent 干活）。
    const changed = fixture.files[0]!;
    await api.putFile(
      first.endpoint,
      first.authToken,
      `${REPO_DIR}/${changed}`,
      Readable.from([Buffer.from("// 会话租约改过这里\nmodule.exports = 1;\n", "utf8")]),
    );

    // ---- 拨快 31 分钟（不再 acquire）→ 回收：取 diff → apply → push → 销毁。
    nowMs += IDLE_TTL_MS + 60_000;
    const report = await lease.reapIdle();
    assert.deepEqual(report.reaped, [sessionId], `reapIdle 没有回收：${JSON.stringify(report)}`);
    assert.deepEqual(report.heldSandboxIds, [first.sandboxId]);

    const session = await store.getSession(sessionId);
    assert.equal(session?.sandboxId, null, "回收之后会话不该还指着旧沙箱");
    assert.ok(
      session?.headCommit !== null && session.headCommit !== fixture.baseSha,
      "head_commit 没有被推到新的 commit",
    );
    // 远端真的有了这条分支，且就是我们记下的那个 commit。
    assert.equal(
      await lsRemoteSha(fixture.url, BRANCH, TEST_TOKEN, 15_000),
      session!.headCommit,
      "任务分支的 head 与 sessions.head_commit 对不上",
    );

    // ---- 重建：新沙箱，仓库起点是**任务分支 head**（不是 base_commit），改动接得上。
    const second = await lease.acquire(sessionId, { runId: `run_${randomBytes(6).toString("hex")}` });
    created.push(second.sandboxId);
    assert.notEqual(second.sandboxId, first.sandboxId, "回收之后应该是一台新沙箱");
    const stream = await api.readRaw(second.endpoint, second.authToken, `${REPO_DIR}/${changed}`);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    assert.match(Buffer.concat(chunks).toString("utf8"), /会话租约改过这里/, "重建的工作区里没有上次的改动");

    // ---- 没有改动的回收：不推空 commit（head 不动）。
    const headBefore = (await store.getSession(sessionId))!.headCommit;
    nowMs += IDLE_TTL_MS + 60_000;
    const secondReport = await lease.reapIdle();
    assert.deepEqual(secondReport.reaped, [sessionId]);
    assert.equal((await store.getSession(sessionId))?.headCommit, headBefore);
    assert.equal(await lsRemoteSha(fixture.url, BRANCH, TEST_TOKEN, 15_000), headBefore);
  });
});
