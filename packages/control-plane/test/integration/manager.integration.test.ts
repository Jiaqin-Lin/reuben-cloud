/**
 * Phase 8 的 manager 集成测试（`npm run test:integration`）。
 *
 * 【这一层测什么】`SandboxManager` / `reconcile` / `SandboxSweeper` 的**业务逻辑**：
 * 状态机的收尾、看门狗、对账的四条规则、TTL 清扫。它需要**真 Postgres**
 * （状态机的权威在那里），但**不需要真容器**——容器那一侧的接口由
 * `FakeSandboxAgent`（真 HTTP）+ `FakeProvider`（只实现对账看见的三个方法）顶上。
 *
 * 【为什么要用假 agent / 假 provider】因为这一层要测的是"**故障路径**"：
 * 一个永远不给终态事件的 agent、一个不答话的 agent、一个容器已经没了的沙箱。
 * 用真 agent 造这些状态要么要等 15 秒（看门狗），要么要 kill -9 一个进程。
 * 假 agent 走的是**真 HTTP**（不是 mock 一个函数），所以"看门狗真的发了 POST /kill"
 * 这件事是被验证过的。真容器的全链路在 `sandbox-flow.integration.test.ts` 里。
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SandboxApiClient } from "../../src/client/sandbox-api.ts";
import { Db } from "../../src/db/client.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { listExecutions } from "../../src/db/executions.ts";
import { getSandbox, insertSandbox, listTransitions, transition } from "../../src/db/sandboxes.ts";
import { reconcile } from "../../src/manager/reconcile.ts";
import { SandboxManager } from "../../src/manager/sandbox-manager.ts";
import { SandboxSweeper } from "../../src/manager/sweeper.ts";
import {
  FakeProvider,
  FakeSandboxAgent,
  deleteSandboxRows,
  fakeInspection,
  fakeManaged,
  newSandboxId,
  startPostgres,
} from "../support.ts";
import type { TestPostgres } from "../support.ts";

let pg: TestPostgres;
let db: Db;

/** 所有造出来的 sandboxId，`after()` 里统一清掉。 */
const created: string[] = [];

const limits = { cpu: 1, memMb: 2048, pids: 2048, diskMb: 4096, ttlSec: 21_600 };

/** 造一行沙箱并推进到目标状态（走合法的边：CREATING → READY → BUSY）。 */
async function seedSandbox(options: {
  state?: "CREATING" | "READY" | "BUSY";
  endpoint?: string | null;
  token?: string | null;
  limits?: typeof limits;
  runId?: string;
} = {}): Promise<string> {
  const id = newSandboxId();
  created.push(id);
  await insertSandbox(db, {
    id,
    runId: options.runId ?? `run_${id}`,
    provider: "fake",
    image: `reuben-cloud/sandbox-base@sha256:${"a".repeat(64)}`,
    imageDigest: `sha256:${"a".repeat(64)}`,
    limits: options.limits ?? limits,
    workspaceVolume: `reuben-cloud-ws-${id}`,
  });
  if (options.state === "CREATING") return id;
  await transition(db, id, ["CREATING"], "READY", "create_ready", {
    endpoint: options.endpoint ?? "http://127.0.0.1:1",
    auth_token: options.token ?? "tok_test",
  });
  if (options.state === "BUSY") await transition(db, id, ["READY"], "BUSY", "exec_started");
  return id;
}

/**
 * 把库清空。**只有独占一个 Postgres 容器的测试才敢这么干**（本文件就是）。
 * 对账用例断言的是"扫到几行、转了几次"，上一个用例留下的行会让这些数字失去意义。
 */
async function resetDatabase(): Promise<void> {
  await db.query("DELETE FROM executions");
  await db.query("DELETE FROM sandbox_state_transitions");
  await db.query("DELETE FROM sandboxes");
}

/** 一个只用来拿 manager 的 provider（对账/清扫用例不会真的建容器）。 */
function fakeProvider(): FakeProvider {
  return new FakeProvider();
}

function managerWith(options: {
  provider?: FakeProvider;
  watchdogGraceMs?: number;
  watchdogKillWaitMs?: number;
} = {}): SandboxManager {
  return new SandboxManager({
    db,
    provider: options.provider ?? fakeProvider(),
    api: new SandboxApiClient(),
    image: `reuben-cloud/sandbox-base@sha256:${"a".repeat(64)}`,
    watchdogGraceMs: options.watchdogGraceMs,
    watchdogKillWaitMs: options.watchdogKillWaitMs,
  });
}

before(async () => {
  pg = await startPostgres();
  db = new Db({ connectionString: pg.url });
  await runMigrations(db);
});

after(async () => {
  await deleteSandboxRows(db, created);
  await db.close();
  await pg.stop();
});

describe("Phase 8 · SandboxManager.execInSandbox", () => {
  test("正常终态：事件流到 completed → 写 executions → 回 READY", async () => {
    const agent = new FakeSandboxAgent({
      onEvents: (executionId) =>
        [
          `id: 1\nevent: started\ndata: ${JSON.stringify({
            execution_id: executionId,
            pid: 42,
            ts: new Date().toISOString(),
            cwd: "/workspace",
            cmd: ["bash", "-lc", "echo hi"],
          })}\n\n`,
          'id: 2\nevent: stdout\ndata: {"chunk":"hi\\n"}\n\n',
          `id: 3\nevent: completed\ndata: ${JSON.stringify({
            exit_code: 0,
            signal: null,
            duration_ms: 12,
            stdout_bytes: 3,
            stderr_bytes: 0,
            truncated: false,
            log_truncated: false,
            log_path: `/tmp/reuben-cloud/exec/${executionId}.log`,
          })}\n\n`,
        ],
    });
    await agent.start();
    const sandboxId = await seedSandbox({ endpoint: agent.url, token: "tok_test" });

    const seen: string[] = [];
    const result = await managerWith().execInSandbox(sandboxId, {
      cmd: ["bash", "-lc", "echo hi"],
      cwd: "/workspace",
      env: { HTTP_PROXY: "http://reuben-cloud-proxy:3128" },
      timeoutMs: 5_000,
      onEvent: (event) => seen.push(event.event),
    });
    await agent.close();

    assert.equal(result.state, "completed");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdoutBytes, 3);
    assert.equal(result.truncated, false);
    assert.equal(result.logPath, `/tmp/reuben-cloud/exec/${result.executionId}.log`);
    assert.deepEqual(result.events.map((event) => event.event), ["started", "stdout", "completed"]);
    assert.deepEqual(seen, ["started", "stdout", "completed"], "onEvent 应该按顺序收到每一条");

    const executions = await listExecutions(db, { sandboxId });
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.state, "completed");
    assert.equal(executions[0]?.exit_code, 0);
    assert.equal(executions[0]?.stdout_bytes, 3);
    assert.deepEqual(executions[0]?.cmd, ["bash", "-lc", "echo hi"]);
    assert.deepEqual(executions[0]?.env_keys, ["HTTP_PROXY"]);
    assert.ok(!JSON.stringify(executions[0]).includes("reuben-cloud-proxy"), "env 的值不该进 DB");

    assert.equal((await getSandbox(db, sandboxId))?.state, "READY");
    const trail = (await listTransitions(db, sandboxId)).map((row) => [row.from_state, row.to_state, row.reason]);
    assert.deepEqual(trail, [
      [null, "CREATING", "created"],
      ["CREATING", "READY", "create_ready"],
      ["READY", "BUSY", "exec_started"],
      ["BUSY", "READY", "exec_finished"],
    ]);
  });

  test("用例 8：看门狗到点 → 调 /kill → 仍然没有终态 → ERROR", async () => {
    // 默认行为就是"永不给终态事件"——那正是看门狗存在的理由。
    const agent = new FakeSandboxAgent();
    await agent.start();
    const sandboxId = await seedSandbox({ endpoint: agent.url, token: "tok_test" });
    const manager = managerWith({ watchdogGraceMs: 60, watchdogKillWaitMs: 120 });

    await assert.rejects(
      manager.execInSandbox(sandboxId, { cmd: ["sleep", "300"], timeoutMs: 100 }),
      (error: unknown) => {
        assert.equal((error as { reason?: string }).reason, "watchdog_timeout");
        return true;
      },
    );
    await agent.close();

    assert.equal(agent.killCalls.length, 1, "看门狗必须调一次 /kill");
    const executions = await listExecutions(db, { sandboxId });
    assert.equal(executions.length, 1);
    assert.equal(executions[0]?.state, "killed");
    assert.equal(executions[0]?.reason, "watchdog_timeout");
    assert.equal(executions[0]?.exit_code, null);
    assert.equal((await getSandbox(db, sandboxId))?.state, "ERROR");
    assert.deepEqual(
      (await listTransitions(db, sandboxId)).map((row) => [row.from_state, row.to_state, row.reason]),
      [
        [null, "CREATING", "created"],
        ["CREATING", "READY", "create_ready"],
        ["READY", "BUSY", "exec_started"],
        ["BUSY", "ERROR", "watchdog_timeout"],
      ],
    );
  });

  test("事件流被掐断且重连用尽 → 补杀一次 → executions 记 killed/stream_failed → 沙箱 ERROR", async () => {
    const agent = new FakeSandboxAgent({ closeAfterFrames: true });
    await agent.start();
    const sandboxId = await seedSandbox({ endpoint: agent.url, token: "tok_test" });
    const api = new SandboxApiClient({ reconnectDelayMs: 5 });
    const manager = new SandboxManager({
      db,
      provider: fakeProvider(),
      api,
      image: `reuben-cloud/sandbox-base@sha256:${"a".repeat(64)}`,
    });

    await assert.rejects(manager.execInSandbox(sandboxId, { cmd: ["true"] }), (error: unknown) => {
      assert.equal((error as { reason?: string }).reason, "stream_failed");
      return true;
    });
    await agent.close();

    // 首连 + 3 次重连（§Phase 8 §4：最多重连 3 次），每次都不带游标（从没收到过事件）。
    assert.equal(agent.eventConnections.length, 4);
    assert.deepEqual([...new Set(agent.eventConnections.map((item) => item.lastEventId))], [null]);
    assert.equal(agent.killCalls.length, 1, "流断了之后应该补一次 /kill，免得没人看着的进程继续写文件");
    const executions = await listExecutions(db, { sandboxId });
    assert.equal(executions[0]?.state, "killed");
    assert.equal(executions[0]?.reason, "stream_failed");
    const row = await getSandbox(db, sandboxId);
    assert.equal(row?.state, "ERROR");
    assert.equal(row?.state_reason, "stream_failed");
  });

  test("agent 回 409 busy：沙箱**保持 BUSY**，交给对账/ TTL 处理", async () => {
    const agent = new FakeSandboxAgent({
      onExec: () => ({ status: 409, body: { error: "busy", activeExecution: "exe_other" } }),
    });
    await agent.start();
    const sandboxId = await seedSandbox({ endpoint: agent.url });
    await assert.rejects(
      managerWith().execInSandbox(sandboxId, { cmd: ["true"] }),
      (error: unknown) => {
        assert.equal((error as { agentError?: string }).agentError, "busy");
        return true;
      },
    );
    await agent.close();
    assert.equal((await getSandbox(db, sandboxId))?.state, "BUSY");
  });

  test("agent 连不上：命令根本没起来 → BUSY 还回 READY", async () => {
    // 127.0.0.1:1 上不会有任何东西在听。
    const sandboxId = await seedSandbox({ endpoint: "http://127.0.0.1:1" });
    await assert.rejects(managerWith().execInSandbox(sandboxId, { cmd: ["true"] }), (error: unknown) => {
      assert.equal((error as { reason?: string }).reason, "unreachable");
      return true;
    });
    assert.equal((await getSandbox(db, sandboxId))?.state, "READY");
  });

  test("状态不对 / 沙箱不存在 / 参数非法：三种错误码要能分开", async () => {
    const manager = managerWith();
    const busy = await seedSandbox({ state: "BUSY" });
    await assert.rejects(manager.execInSandbox(busy, { cmd: ["true"] }), (error: unknown) => {
      const typed = error as { reason?: string; details?: Record<string, unknown> };
      assert.equal(typed.reason, "sandbox_not_ready");
      assert.equal(typed.details?.["state"], "BUSY");
      return true;
    });
    await assert.rejects(manager.execInSandbox("sbx_missing", { cmd: ["true"] }), (error: unknown) => {
      assert.equal((error as { reason?: string }).reason, "sandbox_missing");
      return true;
    });

    const ready = await seedSandbox({});
    for (const request of [
      { cmd: [] },
      { cmd: ["a\0b"] },
      { cmd: ["true"], timeoutMs: 600_001 },
      { cmd: ["true"], timeoutMs: 0 },
      { cmd: ["true"], maxOutputBytes: -1 },
    ]) {
      await assert.rejects(manager.execInSandbox(ready, request as { cmd: string[] }), (error: unknown) => {
        assert.equal((error as { reason?: string }).reason, "invalid_request", `请求 ${JSON.stringify(request)} 应该被拒`);
        return true;
      });
    }
    // 被拒的请求不能留下任何痕迹
    assert.equal((await listExecutions(db, { sandboxId: ready })).length, 0);
    assert.equal((await getSandbox(db, ready))?.state, "READY");
  });
});

describe("Phase 8 · 启动对账", () => {
  test("用例 4/5/6/7：四条规则 + 孤儿 + 幂等", async () => {
    await resetDatabase();
    // ① 容器丢了
    const lost = await seedSandbox({});
    // ② 一切正常
    const healthy = await seedSandbox({});
    // ③ BUSY 且真的有执行在跑（CP 重启前遗留）
    const ghostAgent = new FakeSandboxAgent();
    await ghostAgent.start();
    const busy = await seedSandbox({ state: "BUSY", endpoint: ghostAgent.url, token: "tok_test" });
    // 让假 agent 先"接收"一条 exec：它才会有一个 activeExecution 可以上报。
    const accepted = await fetch(`${ghostAgent.url}/exec`, {
      method: "POST",
      headers: { authorization: "Bearer tok_test", "content-type": "application/json" },
      body: JSON.stringify({ cmd: ["sleep", "300"] }),
    });
    assert.equal(accepted.status, 202);
    // ④ CREATING 而 agent 已经起来了
    const creating = await seedSandbox({ state: "CREATING" });
    // ⑤ agent 报 error
    const broken = await seedSandbox({});
    // ⑥ agent 不答话
    const silent = await seedSandbox({});
    // ⑦ 孤儿容器：DB 里没有这一行
    const orphan = newSandboxId();
    // ⑧ DESTROYED 但容器还在
    const leftover = await seedSandbox({});
    await transition(db, leftover, ["READY"], "DESTROYED", "destroyed");

    const provider = fakeProvider();
    provider.inspections.set(healthy, fakeInspection(healthy));
    // 假 agent 上报的"正在跑的 execution"必须和它自己发出去的 id 一致（下一步读 ghostAgent.executions）。
    provider.inspections.set(busy, fakeInspection(busy, { activeExecution: ghostAgent.executions[0] }));
    provider.inspections.set(creating, fakeInspection(creating));
    provider.inspections.set(broken, fakeInspection(broken, { agentStatus: "error" }));
    provider.inspections.set(silent, fakeInspection(silent, { agentStatus: "unreachable" }));
    provider.inspections.set(orphan, fakeInspection(orphan));
    provider.inspections.set(leftover, fakeInspection(leftover));
    provider.managed = [
      fakeManaged(healthy),
      fakeManaged(busy),
      fakeManaged(creating),
      fakeManaged(broken),
      fakeManaged(silent),
      fakeManaged(orphan),
      fakeManaged(leftover),
      // 出网代理：有 managed 标签但没有 sandboxId，**绝不能**被当成孤儿删掉。
      fakeManaged(null, { role: "egress-proxy", containerName: "reuben-cloud-proxy" }),
      // darwin 的端口转发容器：同一个 sandboxId，destroy 一次就够。
      fakeManaged(healthy, { role: "port-forward", containerName: `reuben-cloud-sbx-${healthy}-fwd` }),
    ];

    const first = await reconcile({ db, provider, api: new SandboxApiClient() });
    await ghostAgent.close();

    assert.equal(first.scanned, 6, "扫描 CREATING/READY/BUSY 六行");
    assert.equal((await getSandbox(db, lost))?.state, "ERROR");
    assert.equal((await getSandbox(db, lost))?.state_reason, "container_lost");
    assert.equal((await getSandbox(db, healthy))?.state, "READY");
    assert.equal((await getSandbox(db, busy))?.state, "READY");
    assert.equal((await getSandbox(db, busy))?.state_reason, "cp_restart");
    assert.equal((await getSandbox(db, creating))?.state, "READY");
    assert.equal((await getSandbox(db, broken))?.state, "ERROR");
    assert.equal((await getSandbox(db, broken))?.state_reason, "agent_error");
    assert.deepEqual(first.unreachable, [silent]);
    assert.equal((await getSandbox(db, silent))?.state, "READY", "不答话的 agent：状态不动");
    assert.deepEqual(first.orphansDestroyed.sort(), [leftover, orphan].sort());
    // destroy 的调用记录正好是那两个：正常沙箱、转发容器、出网代理一个都没碰。
    assert.deepEqual([...provider.destroyed].sort(), [leftover, orphan].sort());

    // ③ 的执行被 kill 掉了，并且补了一条 killed/cp_restart 的记录
    const ghostExecutionId = ghostAgent.executions[0]!;
    assert.deepEqual(first.killed, [{ sandboxId: busy, executionId: ghostExecutionId }]);
    assert.deepEqual(ghostAgent.killCalls, [ghostExecutionId]);
    const ghostExecutions = await listExecutions(db, { sandboxId: busy });
    assert.equal(ghostExecutions.length, 1);
    assert.equal(ghostExecutions[0]?.id, ghostExecutionId);
    assert.equal(ghostExecutions[0]?.state, "killed");
    assert.equal(ghostExecutions[0]?.reason, "cp_restart");
    assert.deepEqual(ghostExecutions[0]?.cmd, [], "命令本体已经随上一个 CP 进程消失");

    // 用例 7：第二次跑不产生任何变化
    const second = await reconcile({ db, provider, api: new SandboxApiClient() });
    assert.deepEqual(second.transitions, [], "第二次对账不应该产生状态变化");
    assert.deepEqual(second.orphansDestroyed, []);
    assert.deepEqual(second.killed, []);
    assert.deepEqual(second.failures, []);
    assert.equal(second.unchanged.length, 3, "healthy / busy / creating 三行不再需要动作");

    // 审计轨迹能看出对账做过什么
    const trail = (await listTransitions(db, lost)).map((row) => [row.from_state, row.to_state, row.reason]);
    assert.deepEqual(trail, [
      [null, "CREATING", "created"],
      ["CREATING", "READY", "create_ready"],
      ["READY", "ERROR", "container_lost"],
    ]);
  });

  test("容器在但退出了 → ERROR(container_exited)（spec 表格之外的细分，见 reconcile 注释）", async () => {
    await resetDatabase();
    const stopped = await seedSandbox({});
    const provider = fakeProvider();
    provider.inspections.set(stopped, fakeInspection(stopped, { running: false, state: "exited", agentStatus: "unreachable" }));
    provider.managed = [fakeManaged(stopped, { running: false, state: "exited" })];
    const report = await reconcile({ db, provider, api: new SandboxApiClient() });
    assert.equal((await getSandbox(db, stopped))?.state, "ERROR");
    assert.equal((await getSandbox(db, stopped))?.state_reason, "container_exited");
    assert.deepEqual(report.orphansDestroyed, [], "ERROR 的行还在，容器不能被当孤儿删掉");
  });

  test("单行失败不带走整场对账", async () => {
    await resetDatabase();
    const failing = await seedSandbox({});
    const healthy = await seedSandbox({});
    const provider = fakeProvider();
    provider.inspections.set(failing, fakeInspection(failing));
    provider.inspections.set(healthy, fakeInspection(healthy));
    // 让 listManaged 之外的 inspect 正常，destroy 抛错（孤儿那一步的失败路径）。
    const orphan = newSandboxId();
    provider.inspections.set(orphan, fakeInspection(orphan));
    provider.managed = [fakeManaged(orphan)];
    provider.destroyError = new Error("docker daemon 不干了");
    const report = await reconcile({ db, provider, api: new SandboxApiClient() });
    assert.equal((await getSandbox(db, healthy))?.state, "READY");
    assert.deepEqual(report.orphansDestroyed, []);
    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0]!.message, /docker daemon/);
  });
});

describe("Phase 8 · TTL 清扫", () => {
  test("用例 9：过期的沙箱被销毁，没过期的不动", async () => {
    const provider = fakeProvider();
    const manager = managerWith({ provider });
    const sweeper = new SandboxSweeper({ db, manager, defaultTtlSec: 60 });

    const expired = await seedSandbox({ limits: { ...limits, ttlSec: 60 } });
    const fresh = await seedSandbox({ limits: { ...limits, ttlSec: 60 } });
    // 造"过期"：把 last_active_at 往回拨（provider 的 limits 下限就是 60s，不能设 5）。
    await db.query("UPDATE sandboxes SET last_active_at = now() - interval '2 hours' WHERE id = $1", [expired]);

    const report = await sweeper.sweepOnce();
    assert.deepEqual(report.destroyed, [expired]);
    assert.deepEqual(provider.destroyed, [expired]);
    const row = await getSandbox(db, expired);
    assert.equal(row?.state, "DESTROYED");
    assert.equal(row?.state_reason, "ttl_expired");
    assert.ok(row?.destroyed_at instanceof Date);
    assert.deepEqual(
      (await listTransitions(db, expired)).map((item) => [item.from_state, item.to_state, item.reason]),
      [
        [null, "CREATING", "created"],
        ["CREATING", "READY", "create_ready"],
        ["READY", "DESTROYED", "ttl_expired"],
      ],
    );
    assert.equal((await getSandbox(db, fresh))?.state, "READY");

    // 再扫一轮：已经 DESTROYED 的不再是候选，fresh 还没过期
    const again = await sweeper.sweepOnce();
    assert.deepEqual(again.scanned, 0);
  });

  test("归档失败 → 这一轮不销毁（产出丢了是比占资源更坏的失败）", async () => {
    const provider = fakeProvider();
    const manager = managerWith({ provider });
    const archiveCalls: string[] = [];
    const sweeper = new SandboxSweeper({
      db,
      manager,
      defaultTtlSec: 60,
      archive: async (sandbox) => {
        archiveCalls.push(sandbox.id);
        throw new Error("对象存储连不上");
      },
    });
    const expired = await seedSandbox({ limits: { ...limits, ttlSec: 60 } });
    const persisted = await seedSandbox({ limits: { ...limits, ttlSec: 60 } });
    const alsoExpired = await seedSandbox({ limits: { ...limits, ttlSec: 60 } });
    await db.query("UPDATE sandboxes SET last_active_at = now() - interval '2 hours' WHERE id = ANY ($1::text[])", [
      [expired, alsoExpired],
    ]);

    const report = await sweeper.sweepOnce();
    assert.deepEqual(archiveCalls.sort(), [alsoExpired, expired].sort());
    assert.deepEqual(report.destroyed, [], "归档失败时一个都不能删");
    assert.equal(report.failures.length, 2);
    assert.equal((await getSandbox(db, expired))?.state, "READY");
    assert.equal((await getSandbox(db, alsoExpired))?.state, "READY");
    assert.equal((await getSandbox(db, persisted))?.state, "READY");

    // 下一轮归档成功了 → 才销毁
    const okSweeper = new SandboxSweeper({ db, manager, defaultTtlSec: 60, archive: async () => {} });
    const okReport = await okSweeper.sweepOnce();
    assert.deepEqual(okReport.destroyed.sort(), [alsoExpired, expired].sort());
    assert.deepEqual(okReport.archived.sort(), [alsoExpired, expired].sort());
  });

  test("start()/stop() 幂等，定时器不吊住进程", () => {
    const sweeper = new SandboxSweeper({ db, manager: managerWith(), intervalMs: 60_000 });
    assert.equal(sweeper.running, false);
    sweeper.start();
    sweeper.start();
    assert.equal(sweeper.running, true);
    sweeper.stop();
    sweeper.stop();
    assert.equal(sweeper.running, false);
  });

  test("destroySandbox 幂等：销毁两次不会多写审计行", async () => {
    const provider = fakeProvider();
    const manager = managerWith({ provider });
    const id = await seedSandbox({});
    await manager.destroySandbox(id, "manual");
    const afterFirst = await listTransitions(db, id);
    await manager.destroySandbox(id, "manual");
    assert.deepEqual(await listTransitions(db, id), afterFirst);
    assert.equal((await getSandbox(db, id))?.state, "DESTROYED");
    assert.equal(provider.destroyed.length, 2, "物理清理照做（幂等），但状态只写一次");
  });

  test("destroySandbox 对不存在的沙箱 → sandbox_missing", async () => {
    await assert.rejects(managerWith().destroySandbox("sbx_missing"), (error: unknown) => {
      assert.equal((error as { reason?: string }).reason, "sandbox_missing");
      return true;
    });
  });
});
