/**
 * P9 · `RepoMapStore` 的**契约测试体**（内存版与 Postgres 版跑同一份）。
 *
 * 【为什么是一个函数而不是一个 .test.ts】两个实现（`memoryRepoMapStore` 与
 * `postgresRepoMapStore`）必须跑同一份断言——AGENTS.md §5 的那条习惯。这个文件不匹配
 * `test/*.test.ts` 的 glob，所以不会被单独跑；两个 .test.ts 各自 import 它、塞自己的实现进去。
 *
 * 【它断言什么】只断言**可观察行为**：键是什么、upsert 覆盖哪些列、`latestBuiltAt` 取哪一行、
 * `prune` 删哪些行。不 assert SQL、不 assert 内部结构——那正是"两个实现可以不同"的地方。
 *
 * 【为什么每条用例用一个独立的 repo_key】真库不能随手清表（同一个容器里还跑着别的用例），
 * 而"行少了"与"键错了"是两种完全不同的 bug——用独立的键，断言才落在行为上。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RepoMapRow, RepoMapStore } from "../src/index/store.ts";

/** 两次写入之间的最小间隔：PG 的 `now()` 在同一毫秒里会给出相同的时间戳，而 prune 按时间排。 */
const WRITE_GAP_MS = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function row(input: {
  repoKey: string;
  commitSha: string;
  personalizationHash?: string;
  budgetTokens?: number;
  text: string;
  indexBuiltAt: Date;
}): Omit<RepoMapRow, "built_at"> {
  return {
    repo_key: input.repoKey,
    commit_sha: input.commitSha,
    personalization_hash: input.personalizationHash ?? "task-hash",
    budget_tokens: input.budgetTokens ?? 1500,
    text: input.text,
    hash: `hash(${input.text})`,
    tokens: Math.ceil(input.text.length / 4),
    index_built_at: input.indexBuiltAt,
  };
}

export function repoMapStoreContract(name: string, makeStore: () => RepoMapStore, repoKeyPrefix: string): void {
  describe(`${name} · RepoMapStore 契约`, () => {
    test("1. put → get 逐字段一致；不存在的主键返回 null", async () => {
      const store = makeStore();
      const repoKey = `${repoKeyPrefix}-roundtrip`;
      const indexBuiltAt = new Date("2026-01-02T03:04:05.678Z");
      await store.put(row({ repoKey, commitSha: "c1", text: "src/a.ts:\n  function a()", indexBuiltAt }));

      const read = await store.get({ repoKey, commitSha: "c1", personalizationHash: "task-hash", budgetTokens: 1500 });
      assert.notEqual(read, null);
      assert.equal(read!.text, "src/a.ts:\n  function a()");
      assert.equal(read!.hash, "hash(src/a.ts:\n  function a())");
      assert.equal(read!.tokens, Math.ceil("src/a.ts:\n  function a()".length / 4));
      assert.equal(read!.index_built_at.getTime(), indexBuiltAt.getTime());
      assert.ok(read!.built_at instanceof Date);

      // 主键的四个部分少一个都不算命中。
      assert.equal(await store.get({ repoKey, commitSha: "c1", personalizationHash: "other", budgetTokens: 1500 }), null);
      assert.equal(await store.get({ repoKey, commitSha: "c1", personalizationHash: "task-hash", budgetTokens: 3000 }), null);
      assert.equal(await store.get({ repoKey, commitSha: "c2", personalizationHash: "task-hash", budgetTokens: 1500 }), null);
      assert.equal(await store.get({ repoKey: `${repoKey}-other`, commitSha: "c1", personalizationHash: "task-hash", budgetTokens: 1500 }), null);
    });

    test("2. upsert：同一主键的第二次写入覆盖 text / hash / tokens / 索引指纹，行数不变", async () => {
      const store = makeStore();
      const repoKey = `${repoKeyPrefix}-upsert`;
      const key = { repoKey, commitSha: "c1", personalizationHash: "task-hash", budgetTokens: 1500 };
      await store.put(row({ ...key, text: "旧地图", indexBuiltAt: new Date("2026-01-01T00:00:00Z") }));
      await store.put(row({ ...key, text: "新地图（索引重建过）", indexBuiltAt: new Date("2026-02-02T00:00:00Z") }));

      const read = await store.get(key);
      assert.equal(read!.text, "新地图（索引重建过）");
      assert.equal(read!.hash, "hash(新地图（索引重建过）)");
      assert.equal(read!.index_built_at.getTime(), new Date("2026-02-02T00:00:00Z").getTime());
      assert.equal(await store.get({ ...key, budgetTokens: 3000 }), null, "另一预算仍然没有行（upsert 没有串键）");
    });

    test("3. latestBuiltAt：没有行 → null；有行 → 这个 (repo, commit) 上最近的一次渲染", async () => {
      const store = makeStore();
      const repoKey = `${repoKeyPrefix}-latest`;
      assert.equal(await store.latestBuiltAt(repoKey, "c1"), null);

      await store.put(row({ repoKey, commitSha: "c1", personalizationHash: "h1", text: "一", indexBuiltAt: new Date(0) }));
      await sleep(WRITE_GAP_MS);
      await store.put(row({ repoKey, commitSha: "c1", personalizationHash: "h2", text: "二", indexBuiltAt: new Date(0) }));
      await sleep(WRITE_GAP_MS);
      await store.put(row({ repoKey, commitSha: "c2", personalizationHash: "h1", text: "别的 commit", indexBuiltAt: new Date(0) }));

      const latest = await store.latestBuiltAt(repoKey, "c1");
      assert.notEqual(latest, null);
      const second = await store.get({ repoKey, commitSha: "c1", personalizationHash: "h2", budgetTokens: 1500 });
      assert.equal(latest!.getTime(), second!.built_at.getTime(), "取的是 h2 那一次（最后一次写入）");
      assert.equal(await store.latestBuiltAt(repoKey, "c3"), null);
    });

    test("4. prune：只留最近 keep 个 commit 的地图，更老的整段删掉（别的仓库不动）", async () => {
      const store = makeStore();
      const repoKey = `${repoKeyPrefix}-prune`;
      const otherRepo = `${repoKeyPrefix}-prune-other`;
      for (const commitSha of ["c1", "c2", "c3"]) {
        await store.put(row({ repoKey, commitSha, text: `地图 ${commitSha}`, indexBuiltAt: new Date(0) }));
        await sleep(WRITE_GAP_MS);
      }
      // 同一个 commit 上两条（不同任务词）要一起留下。
      await store.put(row({ repoKey, commitSha: "c3", personalizationHash: "h2", text: "地图 c3 之二", indexBuiltAt: new Date(0) }));
      await sleep(WRITE_GAP_MS);
      await store.put(row({ repoKey: otherRepo, commitSha: "c1", text: "别的仓库", indexBuiltAt: new Date(0) }));

      const deleted = await store.prune(repoKey, 2);
      assert.equal(deleted, 1, "只该删掉 c1 那一条");
      assert.equal(await store.get({ repoKey, commitSha: "c1", personalizationHash: "task-hash", budgetTokens: 1500 }), null);
      assert.notEqual(await store.get({ repoKey, commitSha: "c2", personalizationHash: "task-hash", budgetTokens: 1500 }), null);
      assert.notEqual(await store.get({ repoKey, commitSha: "c3", personalizationHash: "task-hash", budgetTokens: 1500 }), null);
      assert.notEqual(await store.get({ repoKey, commitSha: "c3", personalizationHash: "h2", budgetTokens: 1500 }), null);
      assert.notEqual(
        await store.get({ repoKey: otherRepo, commitSha: "c1", personalizationHash: "task-hash", budgetTokens: 1500 }),
        null,
        "prune 按 repo_key 隔离",
      );

      assert.equal(await store.prune(`${repoKeyPrefix}-empty`, 2), 0, "没有行的仓库删 0 条（不报错）");
    });
  });
}
