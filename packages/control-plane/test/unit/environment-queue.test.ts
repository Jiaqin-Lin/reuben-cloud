/**
 * Phase 6 · `queue.ts` 的单测（`npm test`，**不需要 docker / PG / 网络**）。
 *
 * 【它证明什么】自愈循环与队列的每一条行为：轮数上限、规则/模型的分工、约束拦截、
 * 错误分类进存储与 prompt、成本记账、状态推进、按仓库去重、失败不阻塞、串行（并发 1）。
 * 这些行为用真 docker 测一次要几十分钟（每一轮都是一次真构建），而且失败原因不可控；
 * 用"假 builder + 脚本化模型 + 内存 store"测则是毫秒级、且每条分支都能精确命中。
 *
 * 【它不替代什么】真构建那条路（docker 真的失败、日志真的长这样、iidfile 真的能读）由
 * `test/integration/environment-build.integration.test.ts` 证明。这里所有"日志"都是 fixture
 * 里的样本字符串——分类函数本身在 `environment-build.test.ts` 里对着真日志样本测过。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import type { BuildRunner } from "../../src/environment/build.ts";
import { BuildQueue } from "../../src/environment/queue.ts";
import {
  FakeBuildRunner,
  fakeCandidate,
  fakeSignals,
  MemoryEnvBuildStore,
  noDockerfileBlockStep,
  ScriptedDockerfileGenerator,
} from "../environment-fakes.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/build-logs/", import.meta.url));

/** 读一个真日志样本当前一轮的失败日志。 */
async function logFixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), "utf8");
}

function requestOf(overrides: {
  projectKey?: string;
  revision?: number;
  candidate?: ReturnType<typeof fakeCandidate>;
} = {}) {
  return {
    projectKey: overrides.projectKey ?? "acme/web",
    revision: overrides.revision ?? 1,
    candidate: overrides.candidate ?? fakeCandidate(),
    signals: fakeSignals(),
    trigger: "first_seen" as const,
  };
}

describe("Phase 6 · 自愈循环", () => {
  test("第 1 轮失败、第 2 轮成功：2 行 attempt、最终 built、成功文本写回环境定义", async () => {
    const aptLog = await logFixture("apt-package-missing.log");
    const builder = new FakeBuildRunner([{ ok: false, log: aptLog, exitCode: 1 }]);
    const store = new MemoryEnvBuildStore();
    const fixed = "FROM reuben-cloud/base-node-dev:dev\nUSER root\nRUN apt-get update && apt-get install -y jq\nUSER 1000:1000\n";
    const generator = new ScriptedDockerfileGenerator([
      { dockerfile: "FROM reuben-cloud/base-node-dev:dev\nRUN apt-get install -y libvips42-dev\n" },
      { dockerfile: fixed },
    ]);
    const queue = new BuildQueue({ builder, store, generator });

    const outcome = await queue.enqueue(requestOf());

    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 2);
    assert.equal(outcome.imageDigest, builder.requests.length === 2 ? "sha256:" + "a".repeat(64) : "");
    assert.equal(store.builds.length, 2, "收满 2 行 env_builds");
    assert.equal(store.builds[0]!.status, "failed");
    assert.equal(store.builds[0]!.errorClass, "apt_package_missing");
    assert.match(store.builds[0]!.logKey ?? "", /^env-logs\/acme__web\/1\/bld_/);
    assert.equal(store.builds[1]!.status, "built");
    assert.equal(store.builds[1]!.errorClass, null);
    assert.equal(store.builds[1]!.imageDigest, outcome.imageDigest);
    // 第二次尝试的 Dockerfile 正是修好的那份。
    assert.equal(builder.requests[1]!.dockerfile, fixed);
    // 环境状态：开始 building，成功之后**不**收尾（P7 的健康检查才决定 ready/degraded）。
    assert.deepEqual(store.statuses, [{ projectKey: "acme/web", revision: 1, status: "building" }]);
    // 自愈改过的文本写回了环境定义（P7 的缓存键读它）。
    assert.deepEqual(store.dockerfileWrites, [{ projectKey: "acme/web", revision: 1, dockerfile: fixed }]);
    // 两次生成各记一行账（signals 级第一轮就是模型生成）。
    assert.equal(store.usage.length, 2);
    assert.equal(store.usage[0]!.kind, "env_build");
    assert.equal(store.usage[0]!.sessionId, null);
    assert.equal(store.usage[0]!.runId, null);
    assert.equal(store.usage[0]!.inputTokens, 100);
    // 第二轮拿着第一轮的分类与日志去生成。
    assert.equal(generator.inputs[1]!.retry?.failure.klass, "apt_package_missing");
    assert.match(generator.inputs[1]!.retry?.failure.advice ?? "", /libvips42-dev/);
    assert.match(generator.inputs[1]!.retry?.logTail ?? "", /Unable to locate package libvips42-dev/);
  });

  test("3 轮全失败：3 行 attempt、3 行账、环境收在 failed、最后一轮的分类是结论", async () => {
    const npmLog = await logFixture("npm-404.log");
    const builder = new FakeBuildRunner([
      { ok: false, log: npmLog },
      { ok: false, log: npmLog },
      { ok: false, log: npmLog },
    ]);
    const store = new MemoryEnvBuildStore();
    const generator = new ScriptedDockerfileGenerator([
      { dockerfile: "FROM reuben-cloud/base-node-dev:dev\nRUN npm install -g left-padx\n" },
      { dockerfile: "FROM reuben-cloud/base-node-dev:dev\nRUN npm install -g left-padx\n" },
      { dockerfile: "FROM reuben-cloud/base-node-dev:dev\nRUN npm install -g left-padx\n" },
    ]);
    const queue = new BuildQueue({ builder, store, generator });

    const outcome = await queue.enqueue(requestOf());

    assert.equal(outcome.ok, false);
    assert.equal(outcome.attempts, 3);
    assert.equal(outcome.errorClass, "npm_404");
    assert.match(outcome.detail ?? "", /left-padx/);
    assert.equal(store.builds.length, 3);
    assert.deepEqual(
      store.builds.map((row) => row.attempt),
      [1, 2, 3],
    );
    assert.ok(store.builds.every((row) => row.status === "failed" && row.logKey !== null), "每行日志 key 都在");
    assert.equal(store.usage.length, 3, "三轮自愈 → 三行账（每轮一次 LLM 生成）");
    assert.deepEqual(store.statuses.at(-1), { projectKey: "acme/web", revision: 1, status: "failed" });
    assert.equal(store.dockerfileWrites.length, 0, "没有成功就不该写回 Dockerfile");
  });

  test("devcontainer / dockerfile 级：第一轮用规则生成的文本，失败之后才上模型", async () => {
    const dnsLog = await logFixture("network-timeout.log");
    const builder = new FakeBuildRunner([{ ok: false, log: dnsLog }, { ok: true }]);
    const store = new MemoryEnvBuildStore();
    const candidate = fakeCandidate({
      level: "devcontainer",
      dockerfile: "FROM reuben-cloud/base-node-dev:dev\nUSER root\nRUN apt-get install -y gh\nUSER 1000:1000\n",
    });
    const generator = new ScriptedDockerfileGenerator([
      { dockerfile: "FROM reuben-cloud/base-node-dev:dev\nRUN echo healed\n" },
      { dockerfile: "FROM reuben-cloud/base-node-dev:dev\nRUN echo healed\n" },
    ]);
    const queue = new BuildQueue({ builder, store, generator });

    const outcome = await queue.enqueue(requestOf({ candidate }));

    assert.equal(outcome.ok, true);
    assert.equal(builder.requests[0]!.dockerfile, candidate.dockerfile, "第一轮是规则生成的");
    assert.equal(store.builds[0]!.inference, "devcontainer");
    assert.equal(builder.requests[1]!.dockerfile, "FROM reuben-cloud/base-node-dev:dev\nRUN echo healed\n");
    assert.equal(store.builds[1]!.inference, "llm");
    assert.equal(generator.calls, 1, "规则那一轮不花模型调用");
    assert.equal(store.usage.length, 1);
  });

  test("硬约束违规：不进构建，并把它当作下一轮的错误分类喂回去", async () => {
    const builder = new FakeBuildRunner([{ ok: true }]);
    const store = new MemoryEnvBuildStore();
    const bad = "FROM reuben-cloud/base-node-dev:dev\nCMD [\"node\", \"index.ts\"]\n";
    const generator = new ScriptedDockerfileGenerator([
      { dockerfile: bad },
      { dockerfile: "FROM reuben-cloud/base-node-dev:dev\n" },
    ]);
    const queue = new BuildQueue({ builder, store, generator });

    const outcome = await queue.enqueue(requestOf());

    assert.equal(outcome.ok, true);
    assert.equal(builder.calls, 1, "违规那一轮不能进 build");
    assert.equal(store.builds[0]!.status, "failed");
    assert.equal(store.builds[0]!.errorClass, "constraint_violation");
    assert.equal(store.builds[0]!.dockerfile, bad);
    assert.equal(store.builds[0]!.logKey, null);
    assert.equal(generator.inputs[1]!.retry?.failure.klass, "constraint_violation");
    assert.match(generator.inputs[1]!.retry?.failure.advice ?? "", /CMD/);
  });

  test("生成失败（模型没给代码块）：每轮记一行 generation_failed，原文进 dockerfile 列", async () => {
    const builder = new FakeBuildRunner([{ ok: true }]);
    const store = new MemoryEnvBuildStore();
    const generator = new ScriptedDockerfileGenerator([noDockerfileBlockStep("先装 libvips。")]);
    const queue = new BuildQueue({ builder, store, generator });

    const outcome = await queue.enqueue(requestOf());

    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorClass, "generation_failed");
    assert.equal(builder.calls, 0, "没有代码块就没得构建");
    // 三轮都会重试（下一轮模型可能就按格式给了），每轮失败如实记一行。
    assert.equal(store.builds.length, 3);
    assert.equal(store.builds[0]!.dockerfile, "先装 libvips。");
    assert.ok(store.builds.every((row) => row.errorClass === "generation_failed" && row.logKey === null));
    assert.equal(store.usage.length, 3, "调用失败也要记调用（用量能拿多少算多少）");
  });

  test("超时：假 builder 卡住 → build_timeout（由 timedOut 标志分类，不看日志）", async () => {
    const builder = new FakeBuildRunner([
      { ok: false, timedOut: true, log: "#1 still running\n" },
      { ok: false, timedOut: true, log: "#1 still running\n" },
      { ok: false, timedOut: true, log: "#1 still running\n" },
    ]);
    const store = new MemoryEnvBuildStore();
    const queue = new BuildQueue({ builder, store, generator: null });

    const outcome = await queue.enqueue(requestOf());

    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorClass, "build_timeout");
    assert.equal(outcome.attempts, 3, "超时不在 spec 的单类重试上限里（只有 network_timeout 有）");
    assert.equal(store.builds[0]!.errorClass, "build_timeout");
  });

  test("网络类故障最多重试 1 次（第 2 轮再失败就停，不烧第 3 轮）", async () => {
    const dnsLog = await logFixture("network-timeout.log");
    const builder = new FakeBuildRunner([
      { ok: false, log: dnsLog },
      { ok: false, log: dnsLog },
      { ok: true },
    ]);
    const store = new MemoryEnvBuildStore();
    const generator = new ScriptedDockerfileGenerator([
      { dockerfile: "FROM reuben-cloud/base-node-dev:dev\n" },
      { dockerfile: "FROM reuben-cloud/base-node-dev:dev\n" },
      { dockerfile: "FROM reuben-cloud/base-node-dev:dev\n" },
    ]);
    const queue = new BuildQueue({ builder, store, generator });

    const outcome = await queue.enqueue(requestOf());

    assert.equal(outcome.ok, false);
    assert.equal(outcome.attempts, 2, "第三次尝试不值得，直接停");
    assert.equal(builder.calls, 2);
    assert.equal(outcome.errorClass, "network_timeout");
  });

  test("构建成功但拿不到 digest：按不可用处理（不再重试）", async () => {
    const builder = new FakeBuildRunner([{ ok: true, imageDigest: null }]);
    const store = new MemoryEnvBuildStore();
    const queue = new BuildQueue({ builder, store, generator: null });

    const outcome = await queue.enqueue(requestOf());

    assert.equal(outcome.ok, false);
    assert.equal(outcome.imageDigest, null);
    assert.equal(outcome.errorClass, "unknown");
    assert.match(outcome.detail ?? "", /digest/);
    assert.equal(builder.calls, 1, "重试拿不到 digest 的概率不会更高");
    assert.deepEqual(store.statuses.at(-1), { projectKey: "acme/web", revision: 1, status: "failed" });
  });

  test("没有模型端口时不报错：退化成规则生成的 Dockerfile", async () => {
    const builder = new FakeBuildRunner([{ ok: true }]);
    const store = new MemoryEnvBuildStore();
    const candidate = fakeCandidate({ level: "signals", dockerfile: "FROM reuben-cloud/base-node-dev:dev\n" });
    const queue = new BuildQueue({ builder, store, generator: null });

    const outcome = await queue.enqueue(requestOf({ candidate }));

    assert.equal(outcome.ok, true);
    assert.equal(outcome.usedModel, false);
    assert.equal(builder.requests[0]!.dockerfile, candidate.dockerfile);
    assert.equal(store.usage.length, 0);
  });

  test("构建器抛异常：记一行、停下，不重试一个坏掉的 runner", async () => {
    const throwing: BuildRunner = {
      name: "throwing",
      build() {
        throw new Error("runner 内部炸了");
      },
    };
    const store = new MemoryEnvBuildStore();
    const queue = new BuildQueue({ builder: throwing, store, generator: null });

    const outcome = await queue.enqueue(requestOf());

    assert.equal(outcome.ok, false);
    assert.equal(outcome.attempts, 1, "重试一个坏掉的 runner 不会变好");
    assert.match(outcome.detail ?? "", /runner 内部炸了/);
    assert.equal(store.builds.length, 1);
    assert.equal(store.builds[0]!.errorClass, "unknown");
    assert.deepEqual(store.statuses.at(-1), { projectKey: "acme/web", revision: 1, status: "failed" });
  });

  test("环境行不存在时记一条 warn，但构建照跑", async () => {
    const npmLog = await logFixture("npm-404.log");
    const builder = new FakeBuildRunner([
      { ok: false, log: npmLog },
      { ok: false, log: npmLog },
      { ok: false, log: npmLog },
    ]);
    const store = new MemoryEnvBuildStore();
    store.environmentExists = false;
    const warnings: string[] = [];
    const queue = new BuildQueue({
      builder,
      store,
      generator: null,
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });

    const outcome = await queue.enqueue(requestOf());

    assert.equal(outcome.ok, false);
    // 开始与收尾两次推进都撞上了"那一版环境行不在"，两次都要说出来。
    assert.deepEqual(warnings, ["环境行不存在，状态没能推进", "环境行不存在，失败状态没能落库"]);
  });
});

describe("Phase 6 · 队列", () => {
  test("去重：同一个 project_key 连发两次 → 只建一次、两个调用拿到同一个结果", async () => {
    const builder = new FakeBuildRunner([{ ok: true, delayMs: 30 }]);
    const store = new MemoryEnvBuildStore();
    const queue = new BuildQueue({ builder, store, generator: null });

    const first = queue.enqueue(requestOf());
    const second = queue.enqueue(requestOf());
    assert.equal(first, second, "复用同一个 promise");
    const [a, b] = await Promise.all([first, second]);

    assert.equal(a, b);
    assert.equal(builder.calls, 1);
    assert.equal(store.builds.length, 1);
    assert.equal(queue.pendingCount, 0, "跑完就从进行中表里摘掉");
  });

  test("失败不阻塞：第一个仓库失败 → 第二个照常被构建；且两者串行（不并发）", async () => {
    const npmLog = await logFixture("npm-404.log");
    const builder = new FakeBuildRunner([
      { ok: false, log: npmLog, delayMs: 15 },
      { ok: false, log: npmLog, delayMs: 15 },
      { ok: false, log: npmLog, delayMs: 15 },
      { ok: true, delayMs: 15 },
    ]);
    const store = new MemoryEnvBuildStore();
    const queue = new BuildQueue({ builder, store, generator: null });

    const failing = queue.enqueue(requestOf({ projectKey: "acme/broken", revision: 1 }));
    const healthy = queue.enqueue(requestOf({ projectKey: "acme/healthy", revision: 1 }));
    const [a, b] = await Promise.all([failing, healthy]);

    assert.equal(a.ok, false);
    assert.equal(a.errorClass, "npm_404");
    assert.equal(b.ok, true);
    // 串行 = 每段构建区间都排在前一段之后（并发 1 是 spec 的硬约束：docker daemon 是共享资源）。
    assert.equal(builder.spans.length, 4);
    for (let index = 1; index < builder.spans.length; index += 1) {
      assert.ok(
        builder.spans[index]!.startedAt >= builder.spans[index - 1]!.endedAt,
        `第 ${index + 1} 次构建应当排在前一次之后：${JSON.stringify(builder.spans)}`,
      );
    }
  });

  test("drain()：等队列跑空", async () => {
    const builder = new FakeBuildRunner([{ ok: true, delayMs: 30 }]);
    const store = new MemoryEnvBuildStore();
    const queue = new BuildQueue({ builder, store, generator: null });

    void queue.enqueue(requestOf());
    await queue.drain();
    assert.equal(queue.pendingCount, 0);
    assert.equal(builder.calls, 1);
  });
});
