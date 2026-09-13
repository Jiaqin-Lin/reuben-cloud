/**
 * Phase 7 · `revision.ts` 的单测（`npm test`，**不需要 docker / PG / 网络**）。
 *
 * 【它拦住的是哪一类回归】这一层管三件"错了就要花很久才发现"的事：
 *  · **清理**：判错一边是磁盘被旧镜像吃满，另一边是正在生效 / 被历史执行引用的镜像被删掉
 *    （后者的症状是"上次那版环境不见了"，而它可能正是一条已开的 PR 的依据）；
 *  · **promote 的指针**：只有成功之后才该动。动早了，一次失败的重建就把正在用的环境换成了
 *    一个不能用的版本；
 *  · **回滚**：只允许回滚到 ready / degraded——回滚到一个 failed 的版本不是回滚，是把环境
 *    推回未知状态。
 *
 * 【它不替代什么】真 SQL 上的父子关系与 upsert 由集成测试证明（`environment.integration.test.ts`）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { BuildOutcome, EnqueueRequest } from "../../src/environment/queue.ts";
import { computeCacheKey } from "../../src/environment/cache.ts";
import type { CacheHit, EnvironmentRow } from "../../src/environment/store.ts";
import {
  DEFAULT_KEEP_REVISIONS,
  planRevisionCleanup,
  promoteEnvironment,
  rollbackEnvironment,
  RollbackError,
} from "../../src/environment/revision.ts";
import { FakePromotionStore, fakeCandidate, fakeSignals } from "../environment-fakes.ts";

function digestOf(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

/** 每个 revision 一个互不相同的 digest（80 位以上的真实形态用不到，这里只要可区分）。 */
function uniqueDigest(revision: number): string {
  return `sha256:${revision.toString(16).padStart(2, "0").repeat(32)}`;
}

/** 一行环境记录的最小形态（清理只看这三列）。 */
function view(revision: number, digest: string | null, status: EnvironmentRow["status"] = "ready") {
  return { revision, image_digest: digest, status };
}

describe("Phase 7 · 清理计划", () => {
  test("12 个 revision、没人引用 → 留最近 10 个，删掉最旧两个的镜像", () => {
    const rows = Array.from({ length: 12 }, (_, index) => view(index + 1, uniqueDigest(index + 1)));
    const plan = planRevisionCleanup(rows, { keep: DEFAULT_KEEP_REVISIONS });
    assert.equal(plan.keep.length, 10);
    assert.deepEqual(plan.pruned.sort((a, b) => a - b), [1, 2]);
    assert.deepEqual(plan.removeImages.sort(), [uniqueDigest(1), uniqueDigest(2)].sort());
  });

  test("被沙箱引用过的 digest 永不清理（哪怕超出窗口）", () => {
    const rows = Array.from({ length: 12 }, (_, index) => view(index + 1, uniqueDigest(index + 1)));
    const plan = planRevisionCleanup(rows, {
      keep: DEFAULT_KEEP_REVISIONS,
      referencedDigests: [uniqueDigest(1)],
    });
    assert.equal(plan.keep.includes(1), true, "被引用的那一版留在保留集里");
    assert.deepEqual(plan.pruned, [2], "另一个旧版本仍然可清");
    assert.deepEqual(plan.removeImages, [uniqueDigest(2)]);
  });

  test("同一个 digest 还被窗口内的版本拿着 → 不删（删了会弄坏正在用的那一版）", () => {
    const rows = [
      ...Array.from({ length: 11 }, (_, index) => view(index + 2, uniqueDigest(index + 2))),
      // 第 1 版与第 12 版共用同一个镜像（回滚 / promote 之后重复指向的常态）。
      view(1, uniqueDigest(12)),
    ];
    const plan = planRevisionCleanup(rows, { keep: DEFAULT_KEEP_REVISIONS });
    assert.equal(plan.keep.includes(1), true, "第 1 版超出窗口，但它的镜像还被第 12 版用着");
    assert.equal(plan.pruned.includes(1), false);
    // 同一批里真正可删的只有第 2 版——第 1 版因为共用被排除在外。
    assert.deepEqual(plan.pruned, [2]);
    assert.deepEqual(plan.removeImages, [uniqueDigest(2)]);
  });

  test("没有 digest 的行只会被标记 pruned（没镜像可删）", () => {
    const rows = Array.from({ length: 12 }, (_, index) => view(index + 1, index < 2 ? null : uniqueDigest(index + 1)));
    const plan = planRevisionCleanup(rows, { keep: DEFAULT_KEEP_REVISIONS });
    assert.deepEqual(plan.pruned.sort((a, b) => a - b), [1, 2]);
    assert.deepEqual(plan.removeImages, []);
  });
});

describe("Phase 7 · promote", () => {
  test("缓存命中：不产生新 revision，把指针指过去", async () => {
    const store = new FakePromotionStore();
    const signals = fakeSignals();
    const dockerfile = "FROM reuben-cloud/base-node-dev:dev\nRUN echo promoted\n";
    const cacheKey = computeCacheKey({ baseImage: fakeCandidate().baseImage, signals, dockerfileText: dockerfile });
    const hit: CacheHit = { revision: 7, imageDigest: digestOf("7"), health: null, status: "ready", cacheKey };
    store.cacheHits.set(cacheKey, hit);
    const queue = new RecordingQueue();

    const result = await promoteEnvironment({ store, queue: queue.asQueue() }, {
      projectKey: "acme/web",
      dockerfile,
      candidate: fakeCandidate(),
      signals,
    });

    assert.equal(result.cacheHit, true);
    assert.equal(result.environment, null);
    assert.equal(result.revision, 7);
    assert.deepEqual(store.inserted, [], "命中不落新行");
    assert.deepEqual(store.current, [["acme/web", 7]]);
    assert.equal(queue.requests.length, 0, "命中不构建");
  });

  test("未命中：落新 revision（带缓存键）、以 promote 入队、成功后才动指针", async () => {
    const store = new FakePromotionStore();
    const queue = new RecordingQueue();
    const result = await promoteEnvironment({ store, queue: queue.asQueue() }, {
      projectKey: "acme/web",
      dockerfile: "FROM reuben-cloud/base-node-dev:dev\nRUN echo hi\n",
      candidate: fakeCandidate(),
      signals: fakeSignals(),
    });

    assert.equal(result.cacheHit, false);
    assert.equal(result.environment?.revision, 1);
    assert.equal(store.inserted[0]!.cacheKey, result.cacheKey);
    assert.equal(queue.requests[0]!.trigger, "promote");
    assert.equal(queue.requests[0]!.cacheKey, result.cacheKey);
    assert.deepEqual(store.current, [["acme/web", 1]], "构建 + 体检成功 → 指针指过去");
  });

  test("构建失败：新行留在库里，指针一动不动（正在生效的那一版不能被弄坏）", async () => {
    const store = new FakePromotionStore();
    store.currentRevision = 3;
    const queue = new RecordingQueue([outcomeOf({ ok: false, errorClass: "npm_404" })]);
    const result = await promoteEnvironment({ store, queue: queue.asQueue() }, {
      projectKey: "acme/web",
      dockerfile: "FROM reuben-cloud/base-node-dev:dev\nRUN false\n",
      candidate: fakeCandidate(),
      signals: fakeSignals(),
    });
    assert.equal(result.outcome?.ok, false);
    assert.equal(store.current.length, 0, "指针没有被移动");
    assert.equal(store.inserted.length, 1, "失败的那一版仍然留了记录");
  });

  test("dryRun：只落一行 revision、不入队", async () => {
    const store = new FakePromotionStore();
    const queue = new RecordingQueue();
    const result = await promoteEnvironment({ store, queue: queue.asQueue() }, {
      projectKey: "acme/web",
      dockerfile: "FROM reuben-cloud/base-node-dev:dev\n",
      candidate: fakeCandidate(),
      signals: fakeSignals(),
      dryRun: true,
    });
    assert.equal(result.outcome, null);
    assert.equal(queue.requests.length, 0);
    assert.equal(store.current.length, 0);
  });
});

describe("Phase 7 · 回滚", () => {
  test("指回旧 revision（不删任何行）", async () => {
    const store = new FakePromotionStore();
    store.rows.set(1, rowOf({ revision: 1, status: "ready", image_digest: digestOf("1") }));
    store.currentRevision = 3;
    const row = await rollbackEnvironment(store, { projectKey: "acme/web", revision: 1 });
    assert.equal(row.revision, 1);
    assert.deepEqual(store.current, [["acme/web", 1]]);
    assert.equal(store.rows.size, 1, "行一个都没删");
  });

  test("回滚到一个 failed / building 的版本 → 明确拒绝（那不是回滚）", async () => {
    const store = new FakePromotionStore();
    store.rows.set(2, rowOf({ revision: 2, status: "failed", image_digest: null }));
    await assert.rejects(
      () => rollbackEnvironment(store, { projectKey: "acme/web", revision: 2 }),
      (error: unknown) => error instanceof RollbackError && error.reason === "not_usable",
    );
  });

  test("回滚到一个不存在的版本 → not_found", async () => {
    const store = new FakePromotionStore();
    await assert.rejects(
      () => rollbackEnvironment(store, { projectKey: "acme/web", revision: 9 }),
      (error: unknown) => error instanceof RollbackError && error.reason === "not_found",
    );
  });
});

// ---------------------------------------------------------------- 替身

/** 入队记录的队列替身：只记请求、按脚本返回结果（promote / 构建入口的测试都用得上的那一小部分）。 */
class RecordingQueue {
  readonly requests: EnqueueRequest[] = [];
  readonly #script: BuildOutcome[];

  constructor(script: BuildOutcome[] = []) {
    this.#script = script;
  }

  async enqueue(request: EnqueueRequest): Promise<BuildOutcome> {
    this.requests.push(request);
    return this.#script.shift() ?? outcomeOf({ ok: true, revision: request.revision });
  }

  asQueue(): { enqueue(request: EnqueueRequest): Promise<BuildOutcome> } {
    return { enqueue: (request) => this.enqueue(request) };
  }
}

function outcomeOf(input: { ok: boolean; errorClass?: BuildOutcome["errorClass"]; revision?: number }): BuildOutcome {
  return {
    projectKey: "acme/web",
    revision: input.revision ?? 1,
    ok: input.ok,
    imageDigest: input.ok ? digestOf("9") : null,
    attempts: input.ok ? 1 : 3,
    errorClass: input.errorClass ?? null,
    detail: null,
    buildIds: [],
    usedModel: false,
    cached: false,
    health: null,
  };
}

/** 一行 `EnvironmentRow` 的最小形态（回滚只读 status / image_digest / revision）。 */
function rowOf(overrides: Partial<EnvironmentRow> & { revision: number }): EnvironmentRow {
  return {
    id: `env_${String(overrides.revision).padStart(4, "0")}`,
    project_key: "acme/web",
    kind: "project",
    level: "signals",
    status: "ready",
    base_image: "reuben-cloud/base-node-dev:dev",
    dockerfile: "FROM reuben-cloud/base-node-dev:dev\n",
    signals: fakeSignals(),
    notes: [],
    degraded_risks: [],
    build_commands: [],
    verify_commands: [],
    image_digest: null,
    cache_key: null,
    parent_revision: null,
    health: {},
    health_reason: null,
    health_checked_at: null,
    health_log_key: null,
    created_at: new Date(0),
    ...overrides,
  } as EnvironmentRow;
}
