/**
 * Phase 7 · `resolve.ts` 的单测（`npm test`，**不需要 docker / PG / 网络**）。
 *
 * 【它拦住的是哪一类回归】Run 侧解析是"用户的第一句话"与"10 分钟构建"之间的那道闸，
 * 四条分支的错法各有各的贵：
 *  · 该回退却等了构建 → 用户要等十分钟（设计文档 §C.8 明令禁止）；
 *  · 该用 Layer 1 却用了旧环境 → agent 在缺依赖的环境里跑，而且**没有任何线索**知道这一点；
 *  · 入队失败被冒泡成异常 → 用户那句话没人处理（"环境没建起来"不该等于"任务失败"）；
 *  · `--env-revision` 指到一个不能用的版本却静默降级 → 人显式要的东西被悄悄换掉。
 *
 * 【它不替代什么】真 SQL（指针 upsert、按 cache_key 命中）由集成测试证明；这里证明的是分支。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { computeCacheKey } from "../../src/environment/cache.ts";
import type { EnqueueRequest } from "../../src/environment/queue.ts";
import type { HealthReport } from "../../src/environment/health.ts";
import { pendingEnvironmentFact, resolveEnvironment, ResolveError } from "../../src/environment/resolve.ts";
import { FakePromotionStore, fakeCandidate, fakeEnvironmentRow, fakeSignals } from "../environment-fakes.ts";

const BASE_DIGEST = `sha256:${"b".repeat(64)}`;
const ENV_DIGEST = `sha256:${"e".repeat(64)}`;

/** 一版可用的环境（ready + digest + 可选体检报告）。 */
function usableRow(revision: number, cacheKey: string, health: HealthReport | null = null) {
  return fakeEnvironmentRow({
    revision,
    status: "ready",
    cache_key: cacheKey,
    image_digest: ENV_DIGEST,
    health: health ?? {},
  });
}

function degradedReport(): HealthReport {
  return {
    status: "degraded",
    reason: "declared_risk",
    detail: "postgres 起不来",
    facts: [{ reason: "declared_risk", affected: ["integration_tests"], detail: "postgres 起不来" }],
    steps: [],
    logKey: null,
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** 推断的替身：固定返回一份候选 + 信号，缓存键由 `computeCacheKey` 算（与生产同一条公式）。 */
function inferPort(candidate = fakeCandidate(), signals = fakeSignals()) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    infer: async () => {
      calls += 1;
      return { candidate, signals };
    },
    cacheKey: computeCacheKey({ baseImage: candidate.baseImage, signals, dockerfileText: candidate.dockerfile }),
  };
}

interface EnqueueRecord {
  requests: EnqueueRequest[];
  fail: boolean;
}

function enqueuePort(record: EnqueueRecord) {
  return async (request: EnqueueRequest) => {
    record.requests.push(request);
    if (record.fail) throw new Error("数据库写不进去");
    return {
      projectKey: request.projectKey,
      revision: request.revision,
      ok: true,
      imageDigest: ENV_DIGEST,
      attempts: 1,
      errorClass: null,
      detail: null,
      buildIds: [],
      usedModel: false,
      cached: false,
      health: null,
    };
  };
}

const baseImageFor = async (): Promise<string | null> => BASE_DIGEST;

describe("Phase 7 · Run 侧解析", () => {
  test("当前 revision 命中缓存键 → 用它的 digest，并把 degraded 的事实带出来", async () => {
    const store = new FakePromotionStore();
    const inferred = inferPort();
    store.rows.set(2, usableRow(2, inferred.cacheKey, degradedReport()));
    store.currentRevision = 2;
    const record: EnqueueRecord = { requests: [], fail: false };

    const resolution = await resolveEnvironment(
      { store, infer: inferred.infer, enqueue: enqueuePort(record), baseImageFor },
      { projectKey: "acme/web" },
    );

    assert.equal(resolution.source, "project");
    assert.equal(resolution.image, ENV_DIGEST);
    assert.equal(resolution.revision, 2);
    assert.equal(resolution.queued, false);
    assert.equal(resolution.facts[0]!.reason, "declared_risk");
    assert.equal(record.requests.length, 0, "命中就不该入队");
  });

  test("当前 revision 是旧的（cache_key 不匹配）但别处有同键的可用版本 → 缓存命中并把指针指过去", async () => {
    const store = new FakePromotionStore();
    const inferred = inferPort();
    store.rows.set(1, usableRow(1, inferred.cacheKey));
    store.rows.set(2, usableRow(2, "别的键"));
    store.currentRevision = 2;
    const record: EnqueueRecord = { requests: [], fail: false };

    const resolution = await resolveEnvironment(
      { store, infer: inferred.infer, enqueue: enqueuePort(record), baseImageFor },
      { projectKey: "acme/web" },
    );

    assert.equal(resolution.source, "cache");
    assert.equal(resolution.revision, 1);
    assert.deepEqual(store.current, [["acme/web", 1]], "命中之后指针跟着走");
    assert.equal(record.requests.length, 0);
  });

  test("什么都没命中 → 落一版 draft、异步入队 first_seen、用 Layer 1 的镜像 + 一句事实", async () => {
    const store = new FakePromotionStore();
    const inferred = inferPort();
    const record: EnqueueRecord = { requests: [], fail: false };

    const resolution = await resolveEnvironment(
      { store, infer: inferred.infer, enqueue: enqueuePort(record), baseImageFor },
      { projectKey: "acme/web" },
    );

    assert.equal(resolution.source, "base");
    assert.equal(resolution.image, BASE_DIGEST);
    assert.equal(resolution.revision, null);
    assert.equal(resolution.queued, true);
    assert.deepEqual(resolution.facts, [pendingEnvironmentFact()]);
    // 入队是异步的：await 一个 tick 之后应该已经发生（它没有阻塞这次解析）。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(record.requests.length, 1);
    assert.equal(record.requests[0]!.trigger, "first_seen");
    assert.equal(record.requests[0]!.cacheKey, inferred.cacheKey);
    assert.equal(store.inserted.length, 1, "落了一版 draft（构建结果之后再补）");
    assert.equal(store.rows.get(1)!.status, "draft");
    // 异步那次构建成功之后，指针要跟着走（"只往前走"，见 resolve.ts 的说明）。
    assert.deepEqual(store.current, [["acme/web", 1]]);
  });

  test("入队失败（存储/队列的基础设施错误）→ 只记 warn，解析照样返回 Layer 1", async () => {
    const store = new FakePromotionStore();
    const inferred = inferPort();
    const record: EnqueueRecord = { requests: [], fail: true };
    const warns: string[] = [];

    const resolution = await resolveEnvironment(
      {
        store,
        infer: inferred.infer,
        enqueue: enqueuePort(record),
        baseImageFor,
        log: (level, message) => {
          if (level === "warn") warns.push(message);
        },
      },
      { projectKey: "acme/web" },
    );

    assert.equal(resolution.source, "base");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warns.length, 1, "入队失败要留下痕迹，但不冒泡给用户");
    assert.deepEqual(store.current, [], "构建没成，指针不动");
  });

  test("`--env-revision`：可用的版本直接用（source=forced，不查缓存）", async () => {
    const store = new FakePromotionStore();
    const inferred = inferPort();
    store.rows.set(1, usableRow(1, "任意键"));
    const record: EnqueueRecord = { requests: [], fail: false };

    const resolution = await resolveEnvironment(
      { store, infer: inferred.infer, enqueue: enqueuePort(record), baseImageFor },
      { projectKey: "acme/web", forcedRevision: 1 },
    );

    assert.equal(resolution.source, "forced");
    assert.equal(resolution.revision, 1);
    assert.equal(inferred.calls, 0, "显式指定 revision 时不需要推断");
  });

  test("`--env-revision`：不存在的版本 / 不能用的版本 → 明确报错，不静默降级", async () => {
    const store = new FakePromotionStore();
    const inferred = inferPort();
    store.rows.set(2, fakeEnvironmentRow({ revision: 2, status: "building", image_digest: null }));
    const record: EnqueueRecord = { requests: [], fail: false };
    const deps = { store, infer: inferred.infer, enqueue: enqueuePort(record), baseImageFor };

    await assert.rejects(
      () => resolveEnvironment(deps, { projectKey: "acme/web", forcedRevision: 9 }),
      (error: unknown) => error instanceof ResolveError && error.reason === "revision_not_found",
    );
    await assert.rejects(
      () => resolveEnvironment(deps, { projectKey: "acme/web", forcedRevision: 2 }),
      (error: unknown) => error instanceof ResolveError && error.reason === "revision_not_usable",
    );
  });

  test("Layer 1 镜像本地没有 → 报错（回一个 tag 只会让创建沙箱时报更远的错）", async () => {
    const store = new FakePromotionStore();
    const inferred = inferPort();
    const record: EnqueueRecord = { requests: [], fail: false };
    await assert.rejects(
      () =>
        resolveEnvironment(
          { store, infer: inferred.infer, enqueue: enqueuePort(record), baseImageFor: async () => null },
          { projectKey: "acme/web" },
        ),
      (error: unknown) => error instanceof ResolveError && error.reason === "base_image_missing",
    );
  });
});
