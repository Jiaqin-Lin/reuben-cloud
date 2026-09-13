/**
 * Phase 10 的归档集成测试（`npm run test:integration`，**需要 Docker**）。
 *
 * 【这一层测什么】"产出在销毁之前落到对象存储"这件事的**全部事实**：
 * 对象真的存在且 sha256 对得上、解包出来与源一致、上传是流式的、失败会重试并
 * 按宽限期收尾、`artifacts` 行只在对象存在时才写。
 *
 * 【为什么是 MinIO 容器 + 真 Postgres + 假 agent】spec 的测试要点原文就是"用 MinIO 容器"。
 * 状态机与 `artifacts` 行只有真 Postgres 能验（唯一索引、`ON CONFLICT` 都是数据库行为），
 * 而 diff / archive / 日志这三条流用一个**真 HTTP** 的假 agent 就够——被测的是 CP 侧的
 * 编排与存储，不是沙箱侧怎么打包（那是 Phase 3 与 e2e 的 flow 组）。
 * 用例 8 例外：它要的是完整链路，所以走真容器（LocalDockerProvider + 沙箱镜像）。
 *
 * 【假 agent 里的归档用真 tar.gz】用例 2 要解包比对，所以样本用 `makeTarGz()` 在宿主上
 * 现造（与沙箱 `/archive` 的实现同一个口径），不是一段随便的字节。
 *
 * 【跑之前】`npm run build:image`（用例 8 需要；其余用例不需要镜像）。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { ArtifactOffloader, artifactKey } from "../../src/artifacts/offload.ts";
import type { ArtifactStore } from "../../src/artifacts/store.ts";
import { S3ArtifactStore } from "../../src/artifacts/store.ts";
import { SandboxApiClient } from "../../src/client/sandbox-api.ts";
import { listArtifacts } from "../../src/db/artifacts.ts";
import { Db } from "../../src/db/client.ts";
import { recordExecution } from "../../src/db/executions.ts";
import { listExecutions } from "../../src/db/executions.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { getSandbox, insertSandbox, listTransitions, transition } from "../../src/db/sandboxes.ts";
import type { SandboxRow } from "../../src/db/sandboxes.ts";
import type { ArtifactOffloadOptions } from "../../src/manager/sandbox-manager.ts";
import { SandboxManager, SandboxManagerError } from "../../src/manager/sandbox-manager.ts";
import { LocalDockerProvider } from "../../src/provider/local-docker.ts";
import { workspaceVolumeName } from "../../src/provider/types.ts";
import {
  CleanupRegistry,
  FakeProvider,
  FakeSandboxAgent,
  containerExists,
  deleteSandboxRows,
  dockerAvailable,
  makeTarGz,
  newSandboxId,
  resolveImageRef,
  startMinio,
  startPostgres,
  tarExtract,
  volumeExists,
} from "../support.ts";
import type { FakeAgentOptions, TestMinio, TestPostgres } from "../support.ts";

let pg: TestPostgres;
let minio: TestMinio;
let db: Db;
let store: S3ArtifactStore;
let imageRef = "";

const cleanup = new CleanupRegistry();
const created: string[] = [];
/** 造出来的假 agent，`after()` 里统一关。 */
const agents: FakeSandboxAgent[] = [];
/** 造出来的临时目录。 */
const tempDirs: string[] = [];

const limits = { cpu: 1, memMb: 2048, pids: 2048, diskMb: 4096, ttlSec: 21_600 };
const IMAGE = `reuben-cloud/sandbox-base@sha256:${"a".repeat(64)}`;

/** 每个用例一个的临时目录（`after()` 里统一删）。 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `rc-artifacts-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/**
 * 在 DB 里造一行 READY 的沙箱，指向给定的 endpoint（假 agent 或真容器）。
 * 归档用例不需要真的 create 容器——要的是"行里有一个活着的 agent 地址"。
 */
async function seedSandbox(options: {
  endpoint: string | null;
  token?: string | null;
  runId?: string;
  limits?: typeof limits;
}): Promise<SandboxRow> {
  const id = newSandboxId();
  created.push(id);
  await insertSandbox(db, {
    id,
    runId: options.runId ?? `run_${id}`,
    provider: "fake",
    image: IMAGE,
    imageDigest: IMAGE.split("@")[1]!,
    limits: options.limits ?? limits,
    workspaceVolume: workspaceVolumeName(id),
  });
  await transition(db, id, ["CREATING"], "READY", "create_ready", {
    endpoint: options.endpoint,
    auth_token: options.token === undefined ? "tok_test" : options.token,
  });
  const row = await getSandbox(db, id);
  assert.ok(row !== null, `seedSandbox 之后 ${id} 应该存在`);
  return row;
}

function makeManager(options: { provider?: FakeProvider; artifacts?: ArtifactOffloadOptions } = {}): {
  manager: SandboxManager;
  provider: FakeProvider;
} {
  const provider = options.provider ?? new FakeProvider();
  return {
    manager: new SandboxManager({
      db,
      provider,
      api: new SandboxApiClient(),
      image: IMAGE,
      ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    }),
    provider,
  };
}

async function startAgent(hooks: FakeAgentOptions = {}): Promise<FakeSandboxAgent> {
  const agent = new FakeSandboxAgent(hooks);
  await agent.start();
  agents.push(agent);
  return agent;
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("归档用例需要可用的 Docker daemon（npm run test:integration）");
  }
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
  minio = await startMinio();
  store = new S3ArtifactStore({
    endpoint: minio.endpoint,
    bucket: minio.bucket,
    accessKeyId: minio.accessKeyId,
    secretAccessKey: minio.secretAccessKey,
    // SDK 自己的重试会让"重试了几次"这件事变得不可数（用例 4 要数的是 offload 层），
    // 也让失败用例的时间不可预测。单测里把它关到 1。
    maxAttempts: 1,
  });
});

after(async () => {
  for (const agent of agents) await agent.close().catch(() => undefined);
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  const failed = await cleanup.sweep();
  if (failed.length > 0) console.warn(`清理时有问题：\n  ${failed.join("\n  ")}`);
  await deleteSandboxRows(db, created);
  store.close();
  await db.close();
  await pg.stop();
  await minio.stop();
});

describe("Phase 10 · 归档与对象存储", () => {
  test("用例 1/2/7：归档落对象存储、size 与 sha256 都对得上、解包与源一致、销毁后仍可下载", async () => {
    // ---- 源：一棵有构建产物的小树（§J.6 关心的就是这类文件）
    const source = await tempDir("tree");
    await mkdir(path.join(source, "src"), { recursive: true });
    await mkdir(path.join(source, "dist"), { recursive: true });
    await writeFile(path.join(source, ".gitignore"), "dist/\n", "utf8");
    await writeFile(path.join(source, "src", "index.ts"), "export const answer = 42;\n", "utf8");
    await writeFile(path.join(source, "dist", "bundle.js"), "// built artifact\n", "utf8");
    const archiveBytes = await makeTarGz(source);
    const expectedSha = createHash("sha256").update(archiveBytes).digest("hex");

    const patch = "diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1 @@\n-hi\n+hello\n";
    const agent = await startAgent({
      onDiff: () => ({
        body: {
          base: "b".repeat(40),
          head: "c".repeat(40),
          files: [{ path: "app.txt", status: "modified", additions: 1, deletions: 1, binary: false }],
          patch,
          patch_bytes: Buffer.byteLength(patch),
          truncated: false,
          patch_log_path: null,
        },
      }),
      onArchive: (query) =>
        query.get("dryRun") === "1" ? { dryRun: { size_bytes: archiveBytes.length, file_count: 4 } } : { stream: archiveBytes },
    });

    const row = await seedSandbox({ endpoint: agent.url });
    const { manager, provider } = makeManager({ artifacts: { store } });
    const result = await manager.destroySandbox(row.id, "test_destroyed");

    // ---- 归档结果
    assert.equal(result.state, "DESTROYED");
    assert.ok(result.archive !== null);
    assert.equal(result.archive.archived, true);
    assert.equal(result.archive.forced, false);
    // 销毁之前归档：destroy 已经跑完了，对象仍然在
    assert.deepEqual(provider.destroyed, [row.id]);

    const rows = await listArtifacts(db, { sandboxId: row.id });
    const archiveRow = rows.find((item) => item.kind === "workspace_archive");
    const diffRow = rows.find((item) => item.kind === "diff");
    assert.ok(archiveRow !== undefined, "应该有 workspace_archive 行");
    assert.ok(diffRow !== undefined, "应该有 diff 行");
    assert.equal(archiveRow.object_key, artifactKey.archive(row.run_id!, row.id));

    // ---- 用例 1：对象存在；size 用上传过程中算的值；sha256 与本地算的一致
    const head = await store.head(archiveRow.object_key);
    assert.ok(head !== null, "销毁之后对象必须仍然存在");
    assert.equal(head.sizeBytes, archiveRow.size_bytes);
    const downloaded = await readStream(await store.get(archiveRow.object_key));
    assert.equal(downloaded.length, archiveRow.size_bytes);
    assert.equal(createHash("sha256").update(downloaded).digest("hex"), archiveRow.sha256);
    assert.equal(archiveRow.sha256, expectedSha);

    // diff 的字节数就是 patch 本身
    const diffBytes = await readStream(await store.get(diffRow.object_key));
    assert.equal(diffBytes.toString("utf8"), patch);
    assert.equal(diffRow.size_bytes, Buffer.byteLength(patch));

    // ---- 用例 2：解包，文件清单与内容与源一致
    const restored = await tempDir("restored");
    const entries = await tarExtract(downloaded, restored);
    assert.ok(entries.some((name) => name.endsWith("dist/bundle.js")), `归档里要有构建产物：${entries.join(", ")}`);
    for (const relative of [".gitignore", "src/index.ts", "dist/bundle.js"]) {
      const [original, extracted] = await Promise.all([
        readFile(path.join(source, relative)),
        readFile(path.join(restored, relative)),
      ]);
      assert.deepEqual(extracted, original, `${relative} 的内容必须一致`);
    }

    // ---- 状态机收尾
    const finalRow = await getSandbox(db, row.id);
    assert.equal(finalRow?.state, "DESTROYED");
    assert.ok(finalRow?.destroyed_at instanceof Date);
    // 归档成功时不留 archive_failed 痕迹
    assert.notEqual(finalRow?.state_reason, "archive_failed");
  });

  test("用例 6：只转存 truncated=true 的执行日志，字节数 = stdout_bytes + stderr_bytes", async () => {
    const logBody = Buffer.concat([
      Buffer.from("1234567890"), // stdout_bytes = 10
      Buffer.from("err!!"), // stderr_bytes = 5
    ]);
    const truncatedExecution = `exe_trunc_${newSandboxId()}`;
    const completeExecution = `exe_full_${newSandboxId()}`;
    const logPath = `/tmp/reuben-cloud/exec/${truncatedExecution}.log`;

    const agent = await startAgent({
      onReadFile: (filePath) => (filePath === logPath ? { body: logBody } : {}),
    });
    const row = await seedSandbox({ endpoint: agent.url, runId: `run_logs_${newSandboxId()}` });
    await recordExecution(db, {
      id: truncatedExecution,
      sandboxId: row.id,
      runId: row.run_id,
      cmd: ["bash", "-lc", "yes"],
      state: "completed",
      reason: "exec_finished",
      exitCode: 0,
      stdoutBytes: 10,
      stderrBytes: 5,
      truncated: true,
      logPath,
    });
    // 没截断的执行：日志不该被转存（事件流里已经有完整输出了）。
    await recordExecution(db, {
      id: completeExecution,
      sandboxId: row.id,
      runId: row.run_id,
      cmd: ["bash", "-lc", "echo hi"],
      state: "completed",
      exitCode: 0,
      stdoutBytes: 3,
      stderrBytes: 0,
      truncated: false,
      logPath: `/tmp/reuben-cloud/exec/${completeExecution}.log`,
    });

    const { manager } = makeManager({ artifacts: { store } });
    await manager.destroySandbox(row.id, "test_logs");

    const rows = await listArtifacts(db, { sandboxId: row.id, kind: "exec_log" });
    assert.equal(rows.length, 1, "只该有一个 exec_log artifact");
    assert.equal(rows[0]!.object_key, artifactKey.execLog(row.run_id!, truncatedExecution));
    assert.equal(rows[0]!.size_bytes, 15);
    const bytes = await readStream(await store.get(rows[0]!.object_key));
    assert.deepEqual(bytes, logBody);
    assert.equal(rows[0]!.size_bytes, 10 + 5);

    // 本用例的假 agent 对 `/diff` 给的是"空 patch"（工作区没有改动）。空对象也要能上传：
    // 一个新建的沙箱什么都没改就被扫到销毁，这是正常路径。
    const diffRows = await listArtifacts(db, { sandboxId: row.id, kind: "diff" });
    assert.equal(diffRows.length, 1);
    assert.equal(diffRows[0]!.size_bytes, 0);
    assert.equal((await store.head(diffRows[0]!.object_key))?.sizeBytes, 0);
  });

  test("用例 4：存储不可用 → offload 重试 3 次 → ERROR(archive_failed)、无 artifacts 行", async () => {
    const agent = await startAgent();
    const row = await seedSandbox({ endpoint: agent.url });
    const recording = new RecountingStore(deadStore());
    const { manager, provider } = makeManager({ artifacts: { store: recording, attempts: 3, backoffMs: 5 } });

    const startedAt = Date.now();
    await assert.rejects(
      () => manager.destroySandbox(row.id, "ttl_expired"),
      (error: unknown) => error instanceof SandboxManagerError && error.reason === "archive_failed",
    );
    const elapsedMs = Date.now() - startedAt;
    // "MinIO 挂掉时销毁流程不会永远挂着"：三次尝试 + 退避必须在几十秒内结束。
    assert.ok(elapsedMs < 30_000, `归档失败路径耗时 ${elapsedMs}ms，应该有界`);

    // 三次 offload 尝试，每次都会先试 diff 再试归档
    assert.equal(recording.keys.filter((key) => key.endsWith(".tar.gz")).length, 3);
    assert.equal(recording.keys.filter((key) => key.endsWith("diff.patch")).length, 3);

    // 没有对象 → 一行都不能有（"只有对象、没有行"才是允许的失败形态）
    assert.deepEqual(await listArtifacts(db, { sandboxId: row.id }), []);

    const failedRow = await getSandbox(db, row.id);
    assert.equal(failedRow?.state, "ERROR");
    assert.equal(failedRow?.state_reason, "archive_failed");
    // 还没销毁：容器（这里是假 provider 的记录）必须还在
    assert.deepEqual(provider.destroyed, []);
  });

  test("用例 5：宽限期内不重复重试；宽限期后仍失败 → 强制销毁并在 state_reason 留下 archive_failed", async () => {
    const agent = await startAgent();
    const row = await seedSandbox({ endpoint: agent.url });
    const recording = new RecountingStore(deadStore());
    let nowMs = Date.now();
    const graceMs = 60_000;
    const { manager, provider } = makeManager({
      artifacts: { store: recording, attempts: 3, backoffMs: 5, graceMs, now: () => new Date(nowMs) },
    });

    // 第一次：重试 3 次失败 → ERROR(archive_failed)，容器留下
    await assert.rejects(
      () => manager.destroySandbox(row.id, "ttl_expired"),
      (error: unknown) => error instanceof SandboxManagerError && error.reason === "archive_failed",
    );
    assert.equal((await getSandbox(db, row.id))?.state, "ERROR");
    const attemptsAfterFirst = recording.keys.length;

    // 宽限期内再扫一轮：**不重试**（次数不变），也不销毁
    nowMs += graceMs - 1_000;
    await assert.rejects(
      () => manager.destroySandbox(row.id, "ttl_expired"),
      (error: unknown) => error instanceof SandboxManagerError && error.reason === "archive_failed",
    );
    assert.equal(recording.keys.length, attemptsAfterFirst, "宽限期内不该再打存储");
    assert.deepEqual(provider.destroyed, []);

    // 宽限期过后：最后一次尝试仍然失败 → 强制销毁（容器真的被删）
    nowMs += 2_000;
    const forced = await manager.destroySandbox(row.id, "ttl_expired");
    assert.equal(forced.state, "DESTROYED");
    assert.equal(forced.archive?.forced, true);
    assert.equal(forced.archive?.archived, false);
    assert.deepEqual(provider.destroyed, [row.id]);

    const finalRow = await getSandbox(db, row.id);
    assert.equal(finalRow?.state, "DESTROYED");
    // Run 结果（Phase 12）现在能读到的就是这条：产出没存上。
    assert.equal(finalRow?.state_reason, "archive_failed");
    assert.deepEqual(await listArtifacts(db, { sandboxId: row.id }), []);

    const reasons = (await listTransitions(db, row.id)).map((item) => `${item.to_state}:${item.reason}`);
    assert.ok(reasons.includes("ERROR:archive_failed"), `轨迹里要有 ERROR:archive_failed：${reasons.join(", ")}`);
    assert.ok(reasons.some((reason) => reason.startsWith("DESTROYED:")), `轨迹里要有销毁：${reasons.join(", ")}`);
  });

  test("用例 3：流式上传 256 MiB 归档，CP 不把载荷攒进内存", async () => {
    // 与 Phase 3 用例 11 同一个做法（也同一个理由）：不可压缩的随机数据，
    // 且门槛 = 传输量的一半而不是 spec 写的固定 RSS 值——RSS 量的是分配器，不是流式处理
    // （Phase 7 的 CI 第一次跑就证明过）。RSS 仍然打印，排障时有用。
    const MIB = 1024 * 1024;
    const totalBytes = 256 * MIB;
    const block = Buffer.alloc(MIB);
    // 不引 crypto.randomBytes：这里的目的是"不可压缩"，一个 LCG 就够，而且更快。
    let seed = 123456789;
    for (let i = 0; i < block.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      block.writeUInt32LE(seed, i);
    }
    const expectedHash = createHash("sha256");
    for (let i = 0; i < totalBytes / MIB; i += 1) expectedHash.update(block);
    const expectedSha = expectedHash.digest("hex");

    const agent = await startAgent({
      onArchive: (query) =>
        query.get("dryRun") === "1"
          ? { dryRun: { size_bytes: totalBytes, file_count: totalBytes / MIB } }
          : {
              stream: Readable.from(
                (async function* streamBlocks() {
                  for (let i = 0; i < totalBytes / MIB; i += 1) yield block;
                })(),
              ),
            },
    });
    const row = await seedSandbox({ endpoint: agent.url });
    const { manager } = makeManager({ artifacts: { store } });

    const before = process.memoryUsage();
    let peakArrayBuffers = before.arrayBuffers;
    let peakHeapUsed = before.heapUsed;
    let peakRss = before.rss;
    const sampler = setInterval(() => {
      const now = process.memoryUsage();
      peakArrayBuffers = Math.max(peakArrayBuffers, now.arrayBuffers);
      peakHeapUsed = Math.max(peakHeapUsed, now.heapUsed);
      peakRss = Math.max(peakRss, now.rss);
    }, 20);

    let result;
    try {
      result = await manager.destroySandbox(row.id, "test_streaming");
    } finally {
      clearInterval(sampler);
    }

    const arrayBuffersDelta = peakArrayBuffers - before.arrayBuffers;
    const heapDelta = peakHeapUsed - before.heapUsed;
    const rssDelta = peakRss - before.rss;
    const report =
      `arrayBuffers=${(arrayBuffersDelta / MIB).toFixed(1)}MiB ` +
      `heapUsed=${(heapDelta / MIB).toFixed(1)}MiB ` +
      `rss=${(rssDelta / MIB).toFixed(1)}MiB（归档 ${totalBytes / MIB} MiB）`;
    console.log(`    流式内存：${report}`);

    assert.equal(result.archive?.archived, true);
    const rows = await listArtifacts(db, { sandboxId: row.id, kind: "workspace_archive" });
    assert.equal(rows.length, 1);
    // 上传过程中算出来的 sha256/字节数必须与源头一致——这条同时验证了"分流算 hash"没漏没重
    assert.equal(rows[0]!.size_bytes, totalBytes);
    assert.equal(rows[0]!.sha256, expectedSha);

    const limit = totalBytes / 2;
    assert.ok(
      arrayBuffersDelta < limit,
      `ArrayBuffers 增量 ≥ 一半：归档被攒进了内存（${report}）`,
    );
    assert.ok(heapDelta < limit, `堆增量 ≥ 一半：归档被（用字符串之类）攒进了内存（${report}）`);
  });

  test("用例 8：§J.7 端到端 —— 真容器 → 归档落 MinIO → 销毁 → 三张表状态正确", async () => {
    imageRef = await resolveImageRef();
    const manager = new SandboxManager({
      db,
      provider: new LocalDockerProvider(),
      api: new SandboxApiClient(),
      image: imageRef,
      artifacts: { store },
    });
    const runId = `run_j7_${newSandboxId()}`;
    const createdSandbox = await manager.createSandbox({ runId });
    created.push(createdSandbox.sandboxId);
    cleanup.container(createdSandbox.containerName);
    cleanup.volume(createdSandbox.volumeName);

    // 造一份工作区：一个普通文件 + 一个被 .gitignore 排除的构建产物（§J.6 的验收点），
    // 并 `git init` + 提交一次——这样 `GET /diff` 能真的算出一份 patch（没有仓库时
    // diff 会降级成警告，那就验不到"三张表 + 产出"的完整链路了）。
    const exec = await manager.execInSandbox(createdSandbox.sandboxId, {
      cmd: [
        "bash",
        "-lc",
        "cd /workspace && printf 'dist/\\n' > .gitignore && mkdir -p dist && printf '// built\\n' > dist/bundle.js " +
          "&& printf 'hello\\n' > app.txt && git init -q && git add -A " +
          "&& git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -qm init " +
          "&& printf 'hello world\\n' > app.txt",
      ],
    });
    assert.equal(exec.state, "completed");
    assert.equal(exec.exitCode, 0);

    const result = await manager.destroySandbox(createdSandbox.sandboxId, "test_j7");
    assert.equal(result.state, "DESTROYED");
    assert.equal(result.archive?.archived, true);

    // ---- 真容器与卷真的没了
    assert.equal(await containerExists(createdSandbox.containerName), false);
    assert.equal(await volumeExists(createdSandbox.volumeName), false);

    // ---- 归档里有被 .gitignore 排除的构建产物
    const rows = await listArtifacts(db, { sandboxId: createdSandbox.sandboxId });
    const archiveRow = rows.find((item) => item.kind === "workspace_archive");
    assert.ok(archiveRow !== undefined);
    const downloaded = await readStream(await store.get(archiveRow.object_key));
    const restored = await tempDir("j7");
    const entries = await tarExtract(downloaded, restored);
    assert.ok(entries.some((name) => name.endsWith("dist/bundle.js")), `归档里要有构建产物：${entries.join(", ")}`);
    // 归档 = 销毁那一刻的 workspace，所以看到的是改过之后的 app.txt
    assert.equal((await readFile(path.join(restored, "app.txt"), "utf8")), "hello world\n");

    // ---- 三张表
    const sandboxRow = await getSandbox(db, createdSandbox.sandboxId);
    assert.equal(sandboxRow?.state, "DESTROYED");
    assert.equal(sandboxRow?.run_id, runId);

    const executionRows = await listExecutions(db, { sandboxId: createdSandbox.sandboxId });
    assert.equal(executionRows.length, 1);
    assert.equal(executionRows[0]!.state, "completed");
    assert.equal(executionRows[0]!.run_id, runId);

    const artifactRows = await listArtifacts(db, { sandboxId: createdSandbox.sandboxId });
    const diffRow = artifactRows.find((item) => item.kind === "diff");
    assert.ok(diffRow !== undefined, `diff 也要在：${artifactRows.map((item) => item.kind).join(", ")}`);
    assert.ok(artifactRows.some((item) => item.kind === "workspace_archive"));
    const diffBytes = await readStream(await store.get(diffRow.object_key));
    assert.ok(diffBytes.toString("utf8").includes("hello world"), "diff 里要有这次改动");

    const reasons = (await listTransitions(db, createdSandbox.sandboxId)).map(
      (item) => `${item.from_state ?? "null"}→${item.to_state}`,
    );
    for (const edge of ["null→CREATING", "CREATING→READY", "READY→BUSY", "BUSY→READY", "READY→DESTROYED"]) {
      assert.ok(reasons.includes(edge), `轨迹里要有 ${edge}：${reasons.join(", ")}`);
    }
  });

  test("软配额：归档体积超过沙箱配额只记警告、不阻断", async () => {
    const source = await tempDir("quota");
    await writeFile(path.join(source, "big.txt"), "x".repeat(2048), "utf8");
    const archiveBytes = await makeTarGz(source);
    const agent = await startAgent({
      onArchive: (query) =>
        query.get("dryRun") === "1"
          ? { dryRun: { size_bytes: 64 * 1024 * 1024, file_count: 1 } } // 远大于下面的 1 MiB 配额
          : { stream: archiveBytes },
    });
    // 沙箱配额 1 MiB，dryRun 报 64 MiB → overQuota，但归档照常成功
    const row = await seedSandbox({ endpoint: agent.url, limits: { ...limits, diskMb: 1 } });
    const { manager } = makeManager({ artifacts: { store } });
    const result = await manager.destroySandbox(row.id, "test_quota");
    assert.equal(result.archive?.archived, true);
    const rows = await listArtifacts(db, { sandboxId: row.id, kind: "workspace_archive" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.size_bytes, archiveBytes.length);
  });

  test("沙箱从来没有 endpoint（create 失败）时跳过归档、照常销毁", async () => {
    const row = await seedSandbox({ endpoint: null, token: null });
    const { manager, provider } = makeManager({ artifacts: { store } });
    const result = await manager.destroySandbox(row.id, "ttl_expired");
    assert.equal(result.state, "DESTROYED");
    assert.equal(result.archive?.skipped, "no_endpoint");
    assert.equal(result.archive?.archived, false);
    assert.deepEqual(provider.destroyed, [row.id]);
    assert.deepEqual(await listArtifacts(db, { sandboxId: row.id }), []);
    // 没有产出可归档不是失败：不能因此把行标成 ERROR
    assert.equal((await getSandbox(db, row.id))?.state, "DESTROYED");
  });
});

/**
 * 包一层计数：用例 4/5 要断言"offload 层重试了几次"。
 * `@aws-sdk/client-s3` 自己的重试（默认 3）会让这件事不可数，所以测试里的 store
 * 把 `maxAttempts` 设成 1，由这个 wrapper 数真正的 put 调用。
 */
class RecountingStore implements ArtifactStore {
  readonly keys: string[] = [];
  readonly #inner: ArtifactStore;

  constructor(inner: ArtifactStore) {
    this.#inner = inner;
  }

  put(objectKey: string, body: Readable): Promise<{ objectKey: string; sizeBytes: number; sha256: string }> {
    this.keys.push(objectKey);
    return this.#inner.put(objectKey, body);
  }

  get(objectKey: string): Promise<Readable> {
    return this.#inner.get(objectKey);
  }

  head(objectKey: string): Promise<{ sizeBytes: number } | null> {
    return this.#inner.head(objectKey);
  }

  close(): void {
    this.#inner.close();
  }
}

/**
 * 指向一个必然连不上的端口——模拟"MinIO 挂了"，但不真的起一个容器再杀掉。
 * 127.0.0.1:1 是保留端口，没有服务能监听它，所以连接一定被拒。
 */
function deadStore(): S3ArtifactStore {
  return new S3ArtifactStore({
    endpoint: "http://127.0.0.1:1",
    bucket: "reuben-cloud-test",
    accessKeyId: "dead",
    secretAccessKey: "dead",
    maxAttempts: 1,
    connectionTimeoutMs: 500,
    socketTimeoutMs: 500,
  });
}
