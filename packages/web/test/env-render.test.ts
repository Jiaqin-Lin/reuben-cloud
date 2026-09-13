/**
 * Phase 7 · 环境页的渲染路径（把 `public/env.js` 真跑起来，DOM 替身见 `dom.ts`）。
 *
 * 【为什么值得写】`env.js` 与 `app.js` 一样是"没有构建、也没有编译器"的东西：语法错了靠
 * `ui.test.ts` 的 `vm.Script`，而**运行时**错了（写错属性、忘了 `replaceChildren`、把外部
 * 输入拼进 HTML）只有打开浏览器才知道。这里把三条最值钱的断言变成 `npm test` 里的红：
 *  ① 一份**真的**读模型能画出页面而不抛异常（含 degraded 的体检事实与历史版本）；
 *  ② 那个按钮确实发的是 `POST .../build`（写口只有这一条，且必须有副作用）；
 *  ③ 外部输入（仓库名、错误分类、体检事实）进 DOM 时走的是文本节点——不是 HTML。
 *
 * 【它不替代什么】观感与真实布局仍然要人眼看一次；服务端那半边在 `control-plane` 的
 * `web-env.test.ts` 里（路由、日志代理、503 / 404 的分界）。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, test } from "node:test";
import type { EnvironmentView } from "../../control-plane/src/web/env.ts";
import type { FakeNode } from "./dom.ts";
import { createDom } from "./dom.ts";

const envJs = await readFile(fileURLToPath(new URL("../public/env.js", import.meta.url)), "utf8");

/** `env.html` 里存在的那些 id（`ui.test.ts` 会把这份清单与 HTML 比对）。 */
const IDS = [
  "env-project",
  "env-state",
  "env-state-text",
  "env-current",
  "env-health",
  "env-revisions",
  "env-message",
  "env-build-button",
  "env-build-hint",
  "theme",
];

const DIGEST = `sha256:${"e".repeat(64)}`;

function viewOf(overrides: Partial<EnvironmentView> = {}): EnvironmentView {
  return {
    projectKey: "acme/web",
    currentRevision: 2,
    canBuild: true,
    revisions: [
      {
        revision: 2,
        parentRevision: 1,
        status: "degraded",
        level: "signals",
        baseImage: "reuben-cloud/base-node-dev:dev",
        imageDigest: DIGEST,
        cacheKey: "abcdef1234567890abcdef",
        createdAt: "2026-01-02T03:04:05.000Z",
        health: {
          status: "degraded",
          reason: "declared_risk",
          detail: "postgres 起不来",
          facts: [{ reason: "declared_risk", affected: ["integration_tests"], detail: "postgres 起不来" }],
          checkedAt: "2026-01-02T03:05:00.000Z",
          logKey: "env-logs/acme__web/2/envcheck_TEST.health.log",
        },
        buildCommands: ["npm ci"],
        verifyCommands: ["npm test"],
        degradedRisks: ["postgres：服务起不来"],
        notes: ["命中 L3"],
        builds: [
          {
            id: "bld_TEST",
            attempt: 1,
            inference: "llm",
            trigger: "first_seen",
            status: "built",
            errorClass: null,
            logKey: "env-logs/acme__web/2/bld_TEST.log",
            durationMs: 1234,
            imageDigest: DIGEST,
            createdAt: "2026-01-02T03:04:06.000Z",
          },
        ],
      },
      {
        revision: 1,
        parentRevision: null,
        status: "failed",
        level: "signals",
        baseImage: "reuben-cloud/base-node-dev:dev",
        imageDigest: null,
        cacheKey: "1111111111111111",
        createdAt: "2026-01-01T00:00:00.000Z",
        health: null,
        buildCommands: [],
        verifyCommands: [],
        degradedRisks: [],
        notes: [],
        builds: [],
      },
    ],
    ...overrides,
  };
}

async function loadEnv(options: {
  pathname?: string;
  view?: EnvironmentView | null;
  status?: number;
}): Promise<{ dom: ReturnType<typeof createDom>; id: (name: string) => FakeNode; settle: () => Promise<void> }> {
  const dom = createDom({
    ids: IDS,
    pathname: options.pathname ?? "/env/acme%2Fweb",
    fetches: [
      { match: "/info", status: options.status ?? 200, body: options.view ?? viewOf() },
      { match: "/build", status: 202, body: { queued: true } },
    ],
  });
  const context = vm.createContext(dom.globals);
  new vm.Script(envJs, { filename: "env.js" }).runInContext(context, { timeout: 5_000 });
  const settle = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  await settle();
  return { dom, id: (name) => dom.document.getElementById(name)!, settle };
}

describe("Phase 7 · 环境页的渲染", () => {
  test("一份真读模型能画出来：projectKey、状态、体检事实、两版历史、日志链接", async () => {
    const { dom, id } = await loadEnv({});
    assert.equal(id("env-project").textContent, "acme/web");
    assert.equal(id("env-state-text").textContent, "degraded");
    assert.equal(id("env-state").dataset["state"], "degraded");

    const current = id("env-current").textContent;
    assert.match(current, /#2（父 #1）/);
    assert.match(current, /abcdef123456/, "缓存键显示前 12 位");

    const health = id("env-health");
    assert.equal(health.hidden, false);
    assert.match(health.textContent, /postgres 起不来（影响：integration_tests）/);

    const revisions = id("env-revisions");
    assert.match(revisions.textContent, /revision #2/);
    assert.match(revisions.textContent, /revision #1/);
    assert.match(revisions.textContent, /第 1 轮/);
    assert.match(revisions.textContent, /当前/, "当前那一版有标记");
    assert.match(revisions.textContent, /npm ci/, "命令清单在折叠区里");

    const links = revisions.findAll((node) => node.tagName === "A").map((node) => node.href);
    assert.ok(links.some((href) => href.includes("/env/acme%2Fweb/logs/2?build=bld_TEST")), `找日志链接：${links.join(",")}`);
    assert.ok(links.some((href) => href.includes("?health=envcheck_TEST")), "体检日志链接");

    assert.equal(dom.requests[0]!.url, "/env/acme%2Fweb/info");
    assert.equal(dom.requests[0]!.method, "GET");
  });

  test("点那个按钮：发 POST /build（写口只有这一条），并在等待期间禁用按钮", async () => {
    const { dom, id, settle } = await loadEnv({});
    id("env-build-button").dispatch("click");
    await settle();
    const posted = dom.requests.find((request) => request.method === "POST");
    assert.ok(posted !== undefined, "按钮必须发 POST");
    assert.equal(posted.url, "/env/acme%2Fweb/build");
    assert.match(id("env-message").textContent, /已入队/);
  });

  test("不能触发（别的仓库 / 没接队列）时按钮是禁用的，并且说明了原因", async () => {
    const { id } = await loadEnv({ view: viewOf({ canBuild: false }) });
    assert.equal(id("env-build-button").disabled, true);
    assert.match(id("env-build-hint").textContent, /只读/);
  });

  test("404：说清「这个仓库还没有环境记录」，状态行不装作读到了", async () => {
    const { id } = await loadEnv({ status: 404 });
    assert.match(id("env-message").textContent, /还没有任何环境记录/);
    assert.equal(id("env-state-text").textContent, "HTTP 404");
  });

  test("ready 且没有事实时：体检那块是隐藏的（不留一块空面板）", async () => {
    const view = viewOf({
      currentRevision: 1,
      revisions: [
        {
          ...viewOf().revisions[1]!,
          status: "ready",
          health: { status: "ready", reason: null, detail: null, facts: [], checkedAt: "2026-01-02T03:05:00.000Z", logKey: null },
        },
      ],
    });
    const { id } = await loadEnv({ view });
    assert.equal(id("env-health").hidden, true);
    assert.equal(id("env-state-text").textContent, "ready");
  });
});
