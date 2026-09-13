/**
 * Phase 2 · 会话级沙箱租约（不需要 Docker、不需要 PG）。
 *
 * 对应 spec P2 测试要点 11–13、15、18–20：按需建、热着复用、空闲回收、回收后重建、
 * 落地失败不销毁、续时、干活中不回收、寿命到点换容器。
 *
 * 【为什么这些能纯单测】租约是策略：它只跟三个端口打交道（存储 / 沙箱读销毁 / 建与落地）。
 * 三个端口都有假实现，时钟可注入——所以"拨快 6 小时"只是改一个数字，
 * 而不是等一个真的定时器。真容器那条路径在集成测试里。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MemorySessionStore } from "@reuben-cloud/agent-runtime";
import type { FlushRequest, FlushResult, LeaseSandboxInfo, LeaseSandboxPort, ProvisionedSandbox, SandboxProvisionRequest } from "../../src/session/sandbox-lease.ts";
import { SandboxLease } from "../../src/session/sandbox-lease.ts";

// ---------------------------------------------------------------- 假世界

interface FakeSandbox {
  sandboxId: string;
  state: "READY" | "BUSY" | "DESTROYED" | "ERROR";
  endpoint: string;
  authToken: string;
  createdAt: Date;
  lastActiveAt: Date;
}

function createWorld() {
  const store = new MemorySessionStore();
  const sandboxes = new Map<string, FakeSandbox>();
  const created: SandboxProvisionRequest[] = [];
  const destroyed: Array<{ sandboxId: string; reason: string }> = [];
  const flushes: FlushRequest[] = [];
  let nowMs = new Date("2026-09-13T10:00:00.000Z").getTime();
  let seq = 0;

  let flushError: Error | null = null;
  let flushResult: FlushResult = { changed: true, headCommit: "c".repeat(40), headRef: "reuben-cloud/issue-abc" };

  const now = (): Date => new Date(nowMs);
  const advance = (ms: number): void => {
    nowMs += ms;
  };

  const port: LeaseSandboxPort = {
    async get(sandboxId) {
      const sandbox = sandboxes.get(sandboxId);
      return sandbox === undefined ? null : ({ ...sandbox } satisfies LeaseSandboxInfo);
    },
    async destroy(sandboxId, reason) {
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox !== undefined) sandbox.state = "DESTROYED";
      destroyed.push({ sandboxId, reason });
    },
  };

  let image = "reuben-cloud/env@sha256:" + "d".repeat(64);
  const provision = async (request: SandboxProvisionRequest): Promise<ProvisionedSandbox> => {
    created.push(request);
    const sandboxId = `sbx_${++seq}`;
    sandboxes.set(sandboxId, {
      sandboxId,
      state: "READY",
      endpoint: `http://${sandboxId}`,
      authToken: `tok_${sandboxId}`,
      createdAt: now(),
      lastActiveAt: now(),
    });
    return { sandboxId, endpoint: `http://${sandboxId}`, authToken: `tok_${sandboxId}` };
  };

  const flush = async (request: FlushRequest): Promise<FlushResult> => {
    flushes.push(request);
    if (flushError !== null) throw flushError;
    return flushResult;
  };

  const lease = new SandboxLease({
    store,
    sandboxes: port,
    provision,
    flush,
    image: () => image,
    now,
  });

  return {
    store,
    lease,
    sandboxes,
    created,
    destroyed,
    flushes,
    now,
    advance,
    setNow(iso: string) {
      nowMs = new Date(iso).getTime();
    },
    failFlush(error: Error | null) {
      flushError = error;
    },
    setFlushResult(result: FlushResult) {
      flushResult = result;
    },
    setImage(value: string) {
      image = value;
    },
    markBusy(sandboxId: string) {
      const sandbox = sandboxes.get(sandboxId);
      if (sandbox !== undefined) sandbox.state = "BUSY";
    },
    async newSession() {
      const { id } = await store.createSession({
        repoKey: "owner/name",
        baseCommit: "a".repeat(40),
        cwd: "/workspace/repo",
        headRef: "reuben-cloud/issue-abc",
      });
      return id;
    },
  };
}

const IDLE_TTL_MS = 30 * 60_000;

// ---------------------------------------------------------------- 用例

describe("Phase 2 · 沙箱租约", () => {
  test("11. 热着复用：连续 5 次 acquire 只建 1 个沙箱，且每次都续时", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();

    const first = await world.lease.acquire(sessionId, { runId: "run_1" });
    for (let index = 0; index < 4; index += 1) {
      world.advance(60_000);
      const again = await world.lease.acquire(sessionId, { runId: "run_1" });
      assert.equal(again.sandboxId, first.sandboxId);
    }
    assert.equal(world.created.length, 1);
    assert.equal(world.destroyed.length, 0);
    const session = await world.store.getSession(sessionId);
    assert.equal(session?.sandboxId, first.sandboxId);
    // 最后一次 acquire 把续时推到了"第 5 分钟"。
    assert.equal(session?.sandboxLastUsedAt?.toISOString(), "2026-09-13T10:04:00.000Z");
  });

  test("18. 续时：每 25 分钟用一次，跨过 30 分钟 TTL 仍然不回收", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    await world.lease.acquire(sessionId, { runId: "run_1" });

    for (let index = 0; index < 3; index += 1) {
      world.advance(25 * 60_000);
      await world.lease.acquire(sessionId, { runId: "run_1" });
      const report = await world.lease.reapIdle();
      assert.deepEqual(report.reaped, []);
    }
    assert.equal(world.created.length, 1);
    assert.equal(world.destroyed.length, 0);
  });

  test("12. 空闲回收：有改动则推分支 + 销毁 + 清掉会话上的引用", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    const sandbox = await world.lease.acquire(sessionId, { runId: "run_1" });

    world.advance(IDLE_TTL_MS + 1);
    const report = await world.lease.reapIdle();

    assert.deepEqual(report.reaped, [sessionId]);
    assert.deepEqual(report.heldSandboxIds, [sandbox.sandboxId]);
    assert.equal(world.flushes.length, 1);
    assert.equal(world.flushes[0]!.reason, "idle");
    assert.deepEqual(world.destroyed, [{ sandboxId: sandbox.sandboxId, reason: "idle" }]);
    const session = await world.store.getSession(sessionId);
    assert.equal(session?.sandboxId, null);
    // 落地成功：head_commit 跟着推到分支上的那一条。
    assert.equal(session?.headCommit, "c".repeat(40));
    assert.equal(session?.headRef, "reuben-cloud/issue-abc");
  });

  test("13. 回收后重建：下一次 acquire 建 1 个新的，仓库起点是分支 head（不是 base_commit）", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    await world.lease.acquire(sessionId, { runId: "run_1" });
    world.advance(IDLE_TTL_MS + 1);
    await world.lease.reapIdle();

    const rebuilt = await world.lease.acquire(sessionId, { runId: "run_2" });
    assert.equal(world.created.length, 2);
    assert.equal(world.created[1]!.startCommit, "c".repeat(40));
    assert.notEqual(world.created[1]!.startCommit, "a".repeat(40));
    const session = await world.store.getSession(sessionId);
    assert.equal(session?.sandboxId, rebuilt.sandboxId);
    assert.equal(session?.sandboxFlushFailures, 0);
  });

  test("15. 落地失败：沙箱**不**被销毁，标记 flush_failed；重试成功后销毁", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    const sandbox = await world.lease.acquire(sessionId, { runId: "run_1" });
    world.failFlush(new Error("push 失败：网络抖动"));

    world.advance(IDLE_TTL_MS + 1);
    const first = await world.lease.reapIdle();
    assert.deepEqual(first.reaped, []);
    assert.deepEqual(first.skipped, [{ sessionId, reason: "flush_failed" }]);
    assert.deepEqual(world.destroyed, []);
    let session = await world.store.getSession(sessionId);
    assert.equal(session?.sandboxId, sandbox.sandboxId);
    assert.equal(session?.sandboxFlushFailures, 1);
    assert.ok(session?.sandboxFlushFailedAt !== null);

    world.failFlush(null);
    world.advance(60_000);
    const second = await world.lease.reapIdle();
    assert.deepEqual(second.reaped, [sessionId]);
    assert.deepEqual(world.destroyed, [{ sandboxId: sandbox.sandboxId, reason: "idle" }]);
    session = await world.store.getSession(sessionId);
    assert.equal(session?.sandboxId, null);
    assert.equal(session?.sandboxFlushFailures, 0);
  });

  test("15b. 连续失败到阈值：走 archive 兜底后仍然销毁（不无限挂着）", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    const sandbox = await world.lease.acquire(sessionId, { runId: "run_1" });
    world.failFlush(new Error("一直失败"));

    const archived: string[] = [];
    const lease = new SandboxLease({
      store: world.store,
      sandboxes: {
        async get(id) {
          const found = world.sandboxes.get(id);
          return found === undefined ? null : { ...found };
        },
        async destroy(id, reason) {
          const found = world.sandboxes.get(id);
          if (found !== undefined) found.state = "DESTROYED";
          world.destroyed.push({ sandboxId: id, reason });
        },
      },
      provision: async () => ({ sandboxId: sandbox.sandboxId, endpoint: "http://x", authToken: "t" }),
      flush: async () => {
        throw new Error("还是失败");
      },
      archiveAndDestroy: async (_session, sandboxId) => {
        archived.push(sandboxId);
      },
      image: () => "img",
      now: world.now,
      settings: { flushRetryLimit: 3 },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      world.advance(IDLE_TTL_MS + 1);
      await lease.reapIdle();
    }
    assert.deepEqual(archived, [sandbox.sandboxId]);
    const session = await world.store.getSession(sessionId);
    assert.equal(session?.sandboxId, null);
  });

  test("19. 干活中不回收：active_run 或在跑的命令时跳过（TTL 到点也只是跳过）", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    const sandbox = await world.lease.acquire(sessionId, { runId: "run_1" });
    await world.store.acquireSessionLock(sessionId, "run_1");

    world.advance(IDLE_TTL_MS + 1);
    let report = await world.lease.reapIdle();
    assert.deepEqual(report.skipped, [{ sessionId, reason: "active_run" }]);
    assert.deepEqual(world.destroyed, []);

    await world.store.releaseSessionLock(sessionId, "run_1");
    world.markBusy(sandbox.sandboxId);
    world.advance(IDLE_TTL_MS + 1);
    report = await world.lease.reapIdle();
    assert.deepEqual(report.skipped, [{ sessionId, reason: "exec_in_flight" }]);
    assert.deepEqual(world.destroyed, []);

    // 命令跑完（沙箱回 READY、并因 exec 结束而续时）→ 从零重新数 TTL。
    world.sandboxes.get(sandbox.sandboxId)!.state = "READY";
    await world.store.touchSession(sessionId, world.now());
    report = await world.lease.reapIdle();
    assert.deepEqual(report.reaped, []);
    assert.equal(world.created.length, 1);
  });

  test("20. 寿命到点换容器：flush + destroy；下一次 acquire 新建 1 个，会话继续", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    const sandbox = await world.lease.acquire(sessionId, { runId: "run_1" });
    const headCommit = "c".repeat(40);

    // 一直在用（每 10 分钟一次），但容器活了 6 小时——空闲 TTL 永远不触发，寿命触发。
    for (let index = 0; index < 36; index += 1) {
      world.advance(10 * 60_000);
      await world.lease.acquire(sessionId, { runId: "run_1" });
    }
    // 再过一分钟（不再 acquire）：寿命刚好超过 6h，而最后一次使用才 11 分钟前。
    world.advance(60_000);
    const report = await world.lease.reapIdle();
    assert.deepEqual(report.rotated, [sessionId]);
    assert.deepEqual(world.destroyed, [{ sandboxId: sandbox.sandboxId, reason: "max_lifetime" }]);
    let session = await world.store.getSession(sessionId);
    assert.equal(session?.sandboxId, null);
    assert.equal(session?.headCommit, headCommit);

    const rebuilt = await world.lease.acquire(sessionId, { runId: "run_2" });
    assert.equal(world.created.length, 2);
    assert.equal(world.created[1]!.startCommit, headCommit);
    session = await world.store.getSession(sessionId);
    assert.equal(session?.sandboxId, rebuilt.sandboxId);
  });

  test("20b. 卡死兜底：超寿命 + 宽限仍在跑 → 强制回收（不试 flush，走 archive 兜底）", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    const sandbox = await world.lease.acquire(sessionId, { runId: "run_1" });
    world.markBusy(sandbox.sandboxId);
    // 一个跑飞的 exec：容器一直 BUSY，而时间已经过了 6h + 30min 的宽限。
    world.setNow("2026-09-13T16:31:00.000Z");

    const report = await world.lease.reapIdle();
    assert.deepEqual(report.rotated, [sessionId]);
    assert.deepEqual(world.destroyed, [{ sandboxId: sandbox.sandboxId, reason: "hard_lifetime" }]);
    assert.deepEqual(world.flushes, [], "强制回收不再尝试 flush（它只会再挂一次）");
    assert.equal((await world.store.getSession(sessionId))?.sandboxId, null);
  });

  test("沙箱硬崩（行还在但容器丢了）：清引用，下次 acquire 重建", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    const sandbox = await world.lease.acquire(sessionId, { runId: "run_1" });
    world.sandboxes.delete(sandbox.sandboxId);

    const report = await world.lease.reapIdle();
    assert.deepEqual(report.skipped, [{ sessionId, reason: "sandbox_missing" }]);
    const session = await world.store.getSession(sessionId);
    assert.equal(session?.sandboxId, null);

    const rebuilt = await world.lease.acquire(sessionId, { runId: "run_2" });
    assert.equal(world.created.length, 2);
    assert.equal(rebuilt.sandboxId, world.sandboxes.get(rebuilt.sandboxId)?.sandboxId);
  });

  test("acquire 时发现旧沙箱已经过期（sweeper 还没跑）：先落地再重建", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    await world.lease.acquire(sessionId, { runId: "run_1" });
    world.advance(IDLE_TTL_MS + 1);

    const rebuilt = await world.lease.acquire(sessionId, { runId: "run_2" });
    assert.equal(world.flushes.length, 1);
    assert.equal(world.flushes[0]!.reason, "cold");
    assert.equal(world.destroyed.length, 1);
    assert.equal(world.created.length, 2);
    assert.equal((await world.store.getSession(sessionId))?.sandboxId, rebuilt.sandboxId);
  });

  test("acquire 时落地失败：**复用旧沙箱**（改动还在容器里，不该丢）", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    const sandbox = await world.lease.acquire(sessionId, { runId: "run_1" });
    world.advance(IDLE_TTL_MS + 1);
    world.failFlush(new Error("push 失败"));

    const reused = await world.lease.acquire(sessionId, { runId: "run_2" });
    assert.equal(reused.sandboxId, sandbox.sandboxId);
    assert.equal(world.created.length, 1);
    assert.deepEqual(world.destroyed, []);
    assert.equal((await world.store.getSession(sessionId))?.sandboxFlushFailures, 1);
  });

  test("显式 release（会话结束）：先落地再销毁", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    const sandbox = await world.lease.acquire(sessionId, { runId: "run_1" });

    await world.lease.release(sessionId, "session_end");
    assert.deepEqual(world.destroyed, [{ sandboxId: sandbox.sandboxId, reason: "session_end" }]);
    assert.equal(world.flushes[0]!.reason, "session_end");
    assert.equal((await world.store.getSession(sessionId))?.sandboxId, null);
  });

  test("没有改动的回收：不推分支（changed=false 时不更新 head）", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    await world.lease.acquire(sessionId, { runId: "run_1" });
    world.setFlushResult({ changed: false, headCommit: null, headRef: null });

    world.advance(IDLE_TTL_MS + 1);
    const report = await world.lease.reapIdle();
    assert.deepEqual(report.reaped, [sessionId]);
    const session = await world.store.getSession(sessionId);
    assert.equal(session?.headCommit, null);
    assert.equal(session?.sandboxId, null);
  });

  test("镜像由 env revision 决定（acquire 每次现取）", async () => {
    const world = createWorld();
    const sessionId = await world.newSession();
    await world.lease.acquire(sessionId, { runId: "run_1" });
    assert.equal(world.created[0]!.image, "reuben-cloud/env@sha256:" + "d".repeat(64));
    world.setImage("reuben-cloud/env@sha256:" + "e".repeat(64));
    world.advance(IDLE_TTL_MS + 1);
    await world.lease.acquire(sessionId, { runId: "run_2" });
    assert.equal(world.created[1]!.image, "reuben-cloud/env@sha256:" + "e".repeat(64));
  });
});
