/**
 * Phase 7 · 环境页的 HTTP 面（真 `node:http` + 真 `fetch`，只在回环上）。
 *
 * 【它拦住的是哪一类回归】环境页有三条容易写错又能造成真实损害的地方：
 *  ① **路由**：`project_key` 是 `owner/name`，URL 里被编码成 `owner%2Fname`——按段 split 的
 *     常规解析会把它当两段（于是 404）。这里把"含斜杠的键能进、别的东西进不来"钉住；
 *  ② **日志只读代理**：key 必须由服务端用**校验过的段**拼出来（`env-logs/` 前缀是结构性质，
 *     不是一条 if）。传一个越界的 key / 两个参数都给 / 都不给都要有明确的拒绝；
 *  ③ **写口只有一条**：`POST /env/{key}/build` 是唯一的非 GET；观察窗那几条路径仍然回 405
 *     （别让一次重构把 POST 放进了 `/runs/...`）。
 *
 * 【它不替代什么】真 PG 上的读模型（三张表的组合）由集成测试证明；这里用内存替身证明路由与
 * 响应形状。前端那半边（DOM 渲染）在 `packages/web/test/ui.test.ts` 与 render 测试里。
 */

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import type { BuildLogStore } from "../../src/environment/build.ts";
import type { EnvironmentRuntime } from "../../src/environment/runtime.ts";
import { FakePromotionStore, fakeCandidate, fakeHealthReport, fakeSignals } from "../environment-fakes.ts";
import { RunHub } from "../../src/web/hub.ts";
import type { EnvironmentWebPort, EnvironmentView } from "../../src/web/env.ts";
import { readEnvironmentLog } from "../../src/web/env.ts";
import type { WebServer } from "../../src/web/server.ts";
import { parseEnvRoute, startWebServer } from "../../src/web/server.ts";

/** 内存日志落点：`get()` 只认真实写过的 key（读不存在的回 undefined → 路由回 404）。 */
class MemoryLogs implements BuildLogStore {
  readonly objects = new Map<string, string>();

  async put(objectKey: string, body: Readable): Promise<{ sizeBytes: number; sha256: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    this.objects.set(objectKey, text);
    return { sizeBytes: Buffer.byteLength(text), sha256: "x" };
  }

  get(objectKey: string): Promise<Readable> {
    const text = this.objects.get(objectKey);
    if (text === undefined) return Promise.reject(new Error("no such object"));
    return Promise.resolve(Readable.from([Buffer.from(text, "utf8")]));
  }
}

const store = new FakePromotionStore();
const logs = new MemoryLogs();
/** 被触发的构建（`manual` 是唯一会从这里进来的触发源）。 */
const triggered: string[] = [];
let server: WebServer;
let base = "";

const PROJECT = "acme/web";

/** 触发口的替身：只记"谁被点了、用什么触发源"，不真跑构建。 */
const runtime: EnvironmentRuntime = {
  projectKey: PROJECT,
  async rebuild(trigger: string) {
    triggered.push(trigger);
    return { cacheHit: false, revision: 3, environment: null, cacheKey: "cache-3", outcome: null };
  },
} as never;

function environmentPort(): EnvironmentWebPort {
  return {
    store: {
      listEnvironments: async (projectKey) =>
        [...store.rows.values()].filter((row) => row.project_key === projectKey).sort((a, b) => b.revision - a.revision),
      getProjectEnvState: (projectKey) => store.getProjectEnvState(projectKey),
      listEnvBuilds: async () => [
        {
          id: "bld_TEST",
          project_key: PROJECT,
          revision: 2,
          attempt: 1,
          inference: "llm",
          trigger: "first_seen",
          status: "built",
          error_class: null,
          dockerfile: "FROM reuben-cloud/base-node-dev:dev\n",
          log_key: `env-logs/acme__web/2/bld_TEST.log`,
          duration_ms: 1234,
          image_digest: `sha256:${"e".repeat(64)}`,
          created_at: new Date("2026-01-02T03:04:05Z"),
        },
      ],
    },
    runtime,
    logs,
  };
}

before(async () => {
  await store.insertEnvironment({ projectKey: PROJECT, candidate: fakeCandidate(), signals: fakeSignals() });
  store.rows.set(1, { ...store.rows.get(1)!, status: "ready", image_digest: `sha256:${"d".repeat(64)}`, cache_key: "cache-1" });
  await store.insertEnvironment({ projectKey: PROJECT, candidate: fakeCandidate(), signals: fakeSignals() });
  store.rows.set(2, {
    ...store.rows.get(2)!,
    status: "degraded",
    image_digest: `sha256:${"e".repeat(64)}`,
    cache_key: "cache-2",
    health: fakeHealthReport("degraded", [
      { reason: "declared_risk", affected: ["integration_tests"], detail: "postgres 起不来" },
    ]),
    health_reason: "declared_risk",
    health_checked_at: new Date("2026-01-02T03:05:00Z"),
    health_log_key: "env-logs/acme__web/2/envcheck_TEST.health.log",
  });
  store.currentRevision = 2;
  logs.objects.set("env-logs/acme__web/2/bld_TEST.log", "第 1 轮 ok\n");
  logs.objects.set("env-logs/acme__web/2/envcheck_TEST.health.log", "# 环境体检\n# 结论：degraded\n");

  server = await startWebServer({ hub: new RunHub(), port: 0, environments: environmentPort() });
  base = server.url;
});

after(async () => {
  await server.close();
});

// ---------------------------------------------------------------- 路由解析

describe("Phase 7 · 环境页路由", () => {
  test("project_key 里的斜杠（编码成 %2F）能进来；越界的形态进不来", () => {
    assert.deepEqual(parseEnvRoute("/env/acme%2Fweb"), { kind: "page", projectKey: PROJECT, revision: null });
    assert.deepEqual(parseEnvRoute("/env/acme%2Fweb/info"), { kind: "info", projectKey: PROJECT, revision: null });
    assert.deepEqual(parseEnvRoute("/env/acme%2Fweb/logs/2"), { kind: "logs", projectKey: PROJECT, revision: 2 });
    assert.equal(parseEnvRoute("/env/"), null);
    assert.equal(parseEnvRoute("/env/acme%2F..%2Fetc"), null, "路径穿越要挡在解析这一层");
    assert.equal(parseEnvRoute("/env/acme%2Fweb/logs/abc"), null, "revision 必须是数字");
    assert.equal(parseEnvRoute("/runs/x"), null, "别的路由不该被这里接走");
  });

  test("日志的两个参数二选一（都给 / 都不给都不合法）", async () => {
    const ok = await readEnvironmentLog({ store: environmentPort().store, logs }, { projectKey: PROJECT, revision: 2, buildId: "bld_TEST" });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.key, "env-logs/acme__web/2/bld_TEST.log");
      assert.match(ok.text, /第 1 轮/);
    }
    const missing = await readEnvironmentLog({ store: environmentPort().store, logs }, { projectKey: PROJECT, revision: 2, buildId: "bld_NOPE" });
    assert.deepEqual(missing, { ok: false, reason: "missing" });
  });
});

// ---------------------------------------------------------------- HTTP

async function get(pathname: string): Promise<Response> {
  return fetch(`${base}${pathname}`);
}

describe("Phase 7 · 环境页的 HTTP 面", () => {
  test("GET /env/{key} 回页面（静态白名单里的 env.html）", async () => {
    const response = await get(`/env/${encodeURIComponent(PROJECT)}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /env\.js/);
  });

  test("GET /env/{key}/info 回读模型：当前指针、两版历史、体检事实、分轮构建", async () => {
    const response = await get(`/env/${encodeURIComponent(PROJECT)}/info`);
    assert.equal(response.status, 200);
    const view = (await response.json()) as EnvironmentView;
    assert.equal(view.projectKey, PROJECT);
    assert.equal(view.currentRevision, 2);
    assert.equal(view.canBuild, true);
    assert.deepEqual(view.revisions.map((revision) => revision.revision), [2, 1]);
    assert.equal(view.revisions[0]!.health?.facts[0]!.detail, "postgres 起不来");
    assert.equal(view.revisions[0]!.builds[0]!.id, "bld_TEST");
  });

  test("没有这个仓库 → 404（不是空视图）", async () => {
    const response = await get(`/env/${encodeURIComponent("nobody/nothing")}/info`);
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { error: string }).error, "environment_not_found");
  });

  test("GET 日志：构建日志与体检日志都能读回原文；缺参数 / 不存在的对象有明确状态码", async () => {
    const build = await get(`/env/${encodeURIComponent(PROJECT)}/logs/2?build=bld_TEST`);
    assert.equal(build.status, 200);
    assert.match(await build.text(), /第 1 轮 ok/);

    const health = await get(`/env/${encodeURIComponent(PROJECT)}/logs/2?health=envcheck_TEST`);
    assert.equal(health.status, 200);
    assert.match(await health.text(), /结论：degraded/);

    assert.equal((await get(`/env/${encodeURIComponent(PROJECT)}/logs/2`)).status, 400);
    assert.equal((await get(`/env/${encodeURIComponent(PROJECT)}/logs/2?build=bld_TEST&health=envcheck_TEST`)).status, 400);
    assert.equal((await get(`/env/${encodeURIComponent(PROJECT)}/logs/2?build=bld_MISSING`)).status, 404);
  });

  test("写口只有 POST /env/{key}/build；观察窗那几条路径仍然只认 GET", async () => {
    const posted = await fetch(`${base}/env/${encodeURIComponent(PROJECT)}/build`, { method: "POST" });
    assert.equal(posted.status, 202, "入队就返回，不等构建");
    assert.deepEqual(await posted.json(), { queued: true, projectKey: PROJECT });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(triggered, ["manual"], "按钮走的是 manual 触发（跳过缓存那条路）");

    // 别的仓库不能从这里触发（这个进程只认识自己那个）。
    const other = await fetch(`${base}/env/${encodeURIComponent("other/repo")}/build`, { method: "POST" });
    assert.equal(other.status, 409);

    // 页面不能是 POST（它有副作用的那一条是 build）。
    assert.equal((await fetch(`${base}/env/${encodeURIComponent(PROJECT)}`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/runs/run_x`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/runs/run_x/info`, { method: "POST" })).status, 405);
    // 只读页面对别的仓库也回 200（页面自己用 /info 说"没有这个仓库"）。
    assert.equal((await get(`/env/${encodeURIComponent("other/repo")}`)).status, 200);
  });

  test("没有接环境子系统时 /env/... 回 503（而不是假装没有这个仓库）", async () => {
    const bare = await startWebServer({ hub: new RunHub(), port: 0 });
    try {
      const response = await fetch(`${bare.url}/env/acme%2Fweb/info`);
      assert.equal(response.status, 503);
      assert.equal(((await response.json()) as { error: string }).error, "environments_unavailable");
    } finally {
      await bare.close();
    }
  });
});
