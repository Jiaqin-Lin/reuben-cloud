/**
 * Phase 8 的真容器集成测试（`npm run test:integration`，**需要 Docker + 沙箱镜像**）。
 *
 * 【它和 `manager.integration.test.ts` 的分工】那一份用假 agent / 假 provider 测
 * **故障路径**（毫秒级、可控）；这一份只测"只有真容器才能回答的问题"：
 *  · provider + DB 的状态机是不是真的同步（create → exec → destroy 的完整轨迹）
 *  · `docker rm -f` 掉一个沙箱之后，对账能不能把它标成 ERROR（验收标准第 2 条）
 *  · 手工起一个带标签的孤儿容器，对账能不能删掉它（验收标准第 3 条）
 *  · **CP 被 kill -9 时正在跑的 exec**，重启后对账能不能杀掉它并补上记录（用例 10）
 *
 * 【跑之前】`npm run build:image`（用 `resolveImageRef()` 把 tag 解析成 digest）。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { SandboxApiClient } from "../../src/client/sandbox-api.ts";
import { Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { getExecution, listExecutions } from "../../src/db/executions.ts";
import { getSandbox, listTransitions } from "../../src/db/sandboxes.ts";
import { reconcile } from "../../src/manager/reconcile.ts";
import { SandboxManager } from "../../src/manager/sandbox-manager.ts";
import { LocalDockerProvider } from "../../src/provider/local-docker.ts";
import {
  forwardContainerName,
  sandboxContainerName,
  workspaceVolumeName,
} from "../../src/provider/types.ts";
import {
  CleanupRegistry,
  containerExists,
  deleteSandboxRows,
  dockerAvailable,
  dockerOrThrow,
  leftoversOf,
  newSandboxId,
  resolveImageRef,
  startPostgres,
  waitFor,
} from "../support.ts";
import type { TestPostgres } from "../support.ts";

let pg: TestPostgres;
let db: Db;
let imageRef = "";

const cleanup = new CleanupRegistry();
/** 所有造出来的 sandboxId（数据清理由 after() 统一做）。 */
const created: string[] = [];

const limits = { cpu: 1, memMb: 2048, pids: 2048, diskMb: 4096, ttlSec: 21_600 };

/** 每个用例一个 manager（provider 与 api 都是新的，模拟"CP 重启"）。 */
function newManager(): SandboxManager {
  return new SandboxManager({
    db,
    provider: new LocalDockerProvider(),
    api: new SandboxApiClient(),
    image: imageRef,
  });
}

async function createSandbox(runId?: string) {
  const created_ = await newManager().createSandbox({ runId: runId ?? `run_${newSandboxId()}` });
  created.push(created_.sandboxId);
  cleanup.container(created_.containerName);
  cleanup.volume(created_.volumeName);
  if (process.platform === "darwin") cleanup.container(forwardContainerName(created_.sandboxId));
  return created_;
}

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("真容器用例需要可用的 Docker daemon（npm run test:integration）");
  }
  imageRef = await resolveImageRef();
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
});

after(async () => {
  // 先删容器/卷，再删数据行（行删了之后就没有 sandboxId 可用了）。
  const failed = await cleanup.sweep();
  if (failed.length > 0) console.warn(`清理时有问题：\n  ${failed.join("\n  ")}`);
  await deleteSandboxRows(db, created);
  await db.close();
  await pg.stop();
});

describe("Phase 8 · 真容器全链路", () => {
  test("create → exec → destroy：状态机的完整轨迹 + 无残留", async () => {
    const manager = newManager();
    const created_ = await createSandbox("run_flow");
    const sandboxId = created_.sandboxId;

    // createSandbox 自己就断言了 CREATING 先于容器（实现顺序），这里看结果：
    assert.equal(created_.state, "READY");
    assert.match(created_.endpoint ?? "", /^http:\/\/[0-9.]+:\d+$/);
    const createdRow = await getSandbox(db, sandboxId);
    assert.equal(createdRow?.provider, "local-docker");
    assert.equal(createdRow?.image_digest, imageRef.split("@").pop());
    assert.ok(createdRow?.provider_ref !== null && createdRow?.provider_ref !== undefined);
    assert.equal(createdRow?.workspace_volume, workspaceVolumeName(sandboxId));
    assert.equal(createdRow?.ready_at instanceof Date, true, "READY 时要落 ready_at");

    const result = await manager.execInSandbox(sandboxId, {
      cmd: ["bash", "-lc", "echo out; echo err >&2"],
      env: { RC_TEST_MARK: "1" },
    });
    assert.equal(result.state, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutBytes > 0, true);
    assert.equal(result.stderrBytes > 0, true);
    assert.equal(result.truncated, false);
    const stdout = result.events
      .filter((event) => event.event === "stdout")
      .map((event) => (JSON.parse(event.data) as { chunk: string }).chunk)
      .join("");
    assert.equal(stdout, "out\n");

    const executions = await listExecutions(db, { sandboxId });
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.state, "completed");
    assert.equal(executions[0]?.exit_code, 0);
    assert.deepEqual(executions[0]?.env_keys, ["RC_TEST_MARK"]);
    assert.equal(executions[0]?.log_path, result.logPath);
    assert.equal(executions[0]?.reason, null);
    assert.ok(executions[0]?.ended_at instanceof Date);

    // 验收标准：审计表里能看到 CREATING→READY→BUSY→READY→DESTROYED 的完整轨迹
    await manager.destroySandbox(sandboxId, "manual");
    assert.equal((await getSandbox(db, sandboxId))?.state, "DESTROYED");
    assert.deepEqual(
      (await listTransitions(db, sandboxId)).map((row) => [row.from_state, row.to_state, row.reason]),
      [
        [null, "CREATING", "created"],
        ["CREATING", "READY", "create_ready"],
        ["READY", "BUSY", "exec_started"],
        ["BUSY", "READY", "exec_finished"],
        ["READY", "DESTROYED", "manual"],
      ],
    );

    // 物理资源真的没了
    assert.equal(await containerExists(sandboxContainerName(sandboxId)), false);
    assert.deepEqual(await leftoversOf(sandboxId), { containers: [], volumes: [] });
  });

  test("超时（沙箱侧权威）→ executions 记 timeout → 沙箱回 READY", async () => {
    const manager = newManager();
    const created_ = await createSandbox();
    const result = await manager.execInSandbox(created_.sandboxId, {
      cmd: ["bash", "-lc", "sleep 30"],
      timeoutMs: 1_000,
    });
    assert.equal(result.state, "timeout");
    assert.equal(result.signal, "SIGTERM");
    const executions = await listExecutions(db, { sandboxId: created_.sandboxId });
    assert.equal(executions[0]?.state, "timeout");
    assert.equal(executions[0]?.reason, "agent_timeout");
    assert.equal((await getSandbox(db, created_.sandboxId))?.state, "READY");
  });

  test("并发闸：长命令进行中，第二次 exec 被拒（409 语义）", async () => {
    const manager = newManager();
    const created_ = await createSandbox();
    const first = manager.execInSandbox(created_.sandboxId, { cmd: ["bash", "-lc", "sleep 2"], timeoutMs: 20_000 });
    // 等 DB 进入 BUSY（POST /exec 与状态转换几乎同时发生，轮询比 sleep 稳）
    await waitFor(async () => (await getSandbox(db, created_.sandboxId))?.state === "BUSY", {
      timeoutMs: 10_000,
      message: "沙箱没有进入 BUSY",
    });
    await assert.rejects(
      manager.execInSandbox(created_.sandboxId, { cmd: ["true"] }),
      (error: unknown) => {
        const typed = error as { reason?: string; details?: Record<string, unknown> };
        assert.equal(typed.reason, "sandbox_not_ready");
        assert.equal(typed.details?.["state"], "BUSY");
        return true;
      },
    );
    assert.equal((await first).state, "completed");
    assert.equal((await getSandbox(db, created_.sandboxId))?.state, "READY");
  });
});

describe("Phase 8 · 对账（真容器）", () => {
  test("验收标准 2：手工删掉容器 → 对账把它标成 ERROR(container_lost)", async () => {
    const created_ = await createSandbox();
    await dockerOrThrow(["rm", "-f", sandboxContainerName(created_.sandboxId)]);

    const report = await reconcile({ db, provider: new LocalDockerProvider(), api: new SandboxApiClient() });
    const row = await getSandbox(db, created_.sandboxId);
    assert.equal(row?.state, "ERROR");
    assert.equal(row?.state_reason, "container_lost");
    assert.ok(report.transitions.some((item) => item.sandboxId === created_.sandboxId && item.reason === "container_lost"));
  });

  test("验收标准 3：手工起一个带标签的孤儿容器 → 对账删掉它", async () => {
    // 直接走 provider（不写 DB）：这就是"上一次 CP 崩在 create 中途"留下的那种容器。
    const orphanId = newSandboxId();
    const provider = new LocalDockerProvider();
    const handle = await provider.create({
      image: imageRef,
      limits,
      labels: { sandboxId: orphanId, runId: `run_orphan_${orphanId}` },
      workspace: { sizeMb: 4096 },
    });
    cleanup.container(handle.containerName);
    cleanup.volume(handle.volumeName);
    if (process.platform === "darwin") cleanup.container(forwardContainerName(orphanId));

    const report = await reconcile({ db, provider, api: new SandboxApiClient() });
    assert.ok(report.orphansDestroyed.includes(orphanId), `孤儿容器没被删：${JSON.stringify(report.orphansDestroyed)}`);
    assert.equal(await containerExists(handle.containerName), false);
    assert.equal((await leftoversOf(orphanId)).volumes.length, 0);
    // 幂等：第二次不该再删任何东西
    const second = await reconcile({ db, provider, api: new SandboxApiClient() });
    assert.deepEqual(second.orphansDestroyed, []);
  });

  test("用例 10：CP 被 kill -9 时正在跑的 exec → 重启后对账杀掉它、补一条 killed/cp_restart、回 READY", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/dangling-cp.ts", import.meta.url));
    const child = spawn(process.execPath, [fixture], {
      env: { ...process.env, DATABASE_URL: pg.url, RC_TEST_IMAGE: imageRef },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childStderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      childStderr += chunk.toString("utf8");
    });

    let announced: { sandboxId: string; executionId: string } | null = null;
    try {
      const line = await waitForJsonLine(child, 60_000, () => childStderr);
      if (typeof line["error"] === "string") throw new Error(`夹具报错：${line["error"]}\n${childStderr}`);
      announced = { sandboxId: String(line["sandboxId"]), executionId: String(line["executionId"]) };
    } finally {
      child.kill("SIGKILL");
    }
    await waitForExit(child);
    assert.ok(announced !== null, `夹具没有报出 sandboxId/executionId\n${childStderr}`);
    const { sandboxId, executionId } = announced;
    created.push(sandboxId);
    cleanup.container(sandboxContainerName(sandboxId));
    cleanup.volume(workspaceVolumeName(sandboxId));
    if (process.platform === "darwin") cleanup.container(forwardContainerName(sandboxId));

    // kill -9 之后：DB 里是 BUSY，容器里那条 sleep 300 还在跑。
    assert.equal((await getSandbox(db, sandboxId))?.state, "BUSY");
    const provider = new LocalDockerProvider();
    const api = new SandboxApiClient();
    const before = await provider.inspect(sandboxId);
    assert.equal(before?.activeExecution, executionId, "对账之前 agent 应该还占着 BUSY 槽");

    const report = await reconcile({ db, provider, api });

    // ① 对账杀掉了它
    assert.deepEqual(report.killed, [{ sandboxId, executionId }]);
    // ② 补了一条 killed/cp_restart 的执行记录（cmd 是空数组：命令本体随上个进程消失了）
    const execution = await getExecution(db, executionId);
    assert.equal(execution?.state, "killed");
    assert.equal(execution?.reason, "cp_restart");
    assert.deepEqual(execution?.cmd, []);
    assert.equal(execution?.sandbox_id, sandboxId);
    // ③ 状态回到 READY（不是 ERROR：执行被清掉了，沙箱本身是好的）
    assert.equal((await getSandbox(db, sandboxId))?.state, "READY");
    assert.equal((await getSandbox(db, sandboxId))?.state_reason, "cp_restart");
    // ④ agent 的槽真的释放了（/kill 的 SIGTERM→SIGKILL 阶梯跑完了）
    await waitFor(
      async () => (await provider.inspect(sandboxId))?.activeExecution === null,
      { timeoutMs: 20_000, message: "对账 kill 之后 agent 仍然占着 BUSY 槽" },
    );
    // ⑤ 对账幂等：第二次不再产生任何变化
    const second = await reconcile({ db, provider, api });
    assert.deepEqual(second.transitions, []);
    assert.deepEqual(second.killed, []);
  });
});

// ---------------------------------------------------------------- 夹具的进程工具

/** 等子进程打出一行 JSON。 */
function waitForJsonLine(
  child: ChildProcess,
  timeoutMs: number,
  stderr: () => string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      reject(new Error(`子进程 ${timeoutMs}ms 内没有输出 JSON 行。stderr：\n${stderr()}`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`子进程输出的不是 JSON：${buffer.slice(0, newline)}（${String(error)}）`));
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`子进程提前退出（code=${code}, signal=${signal}）。stderr：\n${stderr()}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}
