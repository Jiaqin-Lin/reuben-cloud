/**
 * Phase 7 · `health.ts` 的单测（`npm test`，**不需要 docker / PG / 网络**）。
 *
 * 【它拦住的是哪一类回归】三态判定是"环境能不能用"的唯一结论来源，判错的方向都很贵：
 *  · 把 failed 判成 ready → agent 在一个装不上依赖的环境里跑，三次失败之后耗尽预算（设计文档
 *    §C.6 说 degraded 是 M2 最有价值的状态，就是这个理由的反面）；
 *  · 把 degraded 判成 ready → agent 反复去跑集成测试（那是它最贵的一类尝试）；
 *  · 把 ready 判成 degraded → 明明能用却让 agent 跳过验证（产出不可信）。
 * 所以三条分支各一条用例，再加"沙箱起不来 / 可选步骤失败 / 超时"三条边界。
 *
 * 【它不替代什么】"真镜像 + 真仓库 + 真 npm ci 会得到什么结论"由集成测试里那条真沙箱用例证明；
 * 这里用假沙箱证明的是**判定逻辑**（哪个退出码走哪条分支、facts 怎么攒）。
 */

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import type { BuildLogStore } from "../../src/environment/build.ts";
import type { HealthExecInput, HealthExecResult, HealthSandboxPort } from "../../src/environment/health.ts";
import { healthFactLine, healthPlanFor, runHealthCheck } from "../../src/environment/health.ts";
import { fakeCandidate, fakeSignals } from "../environment-fakes.ts";

/** 按脚本返回结果的假沙箱：`script` 逐次对应每一步 exec（用完之后的调用一律成功）。 */
class FakeHealthSandbox implements HealthSandboxPort {
  readonly opened: Array<{ image: string; runId: string }> = [];
  readonly execs: HealthExecInput[] = [];
  readonly destroyed: string[] = [];
  openFails: string | null = null;

  readonly #script: Array<Partial<HealthExecResult>>;

  constructor(script: Array<Partial<HealthExecResult>> = []) {
    this.#script = script;
  }

  async open(input: { image: string; runId: string }): Promise<{ sandboxId: string; endpoint: string; authToken: string }> {
    this.opened.push(input);
    if (this.openFails !== null) throw new Error(this.openFails);
    return { sandboxId: "sbx_fake", endpoint: "http://127.0.0.1:1", authToken: "t" };
  }

  async exec(input: HealthExecInput): Promise<HealthExecResult> {
    const step = this.#script[this.execs.length] ?? {};
    this.execs.push(input);
    return {
      exitCode: step.exitCode === undefined ? 0 : step.exitCode,
      timedOut: step.timedOut ?? false,
      output: step.output ?? "ok\n",
      durationMs: step.durationMs ?? 12,
    };
  }

  async destroy(sandboxId: string): Promise<void> {
    this.destroyed.push(sandboxId);
  }
}

const REPO_DIR = "/workspace/repo";

/** 内存里的日志落点（体检日志是"分轮次的人类可读文本"，这里只验它真的被写出去过）。 */
class MemoryLogStore implements BuildLogStore {
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
    if (text === undefined) throw new Error(`没有这个对象：${objectKey}`);
    return Promise.resolve(Readable.from([Buffer.from(text, "utf8")]));
  }
}

function checkOf(
  sandbox: HealthSandboxPort,
  overrides: { candidate?: ReturnType<typeof fakeCandidate>; signals?: ReturnType<typeof fakeSignals>; logs?: BuildLogStore | null } = {},
) {
  const candidate = overrides.candidate ?? fakeCandidate({ buildCommands: ["npm ci"], degradedRisks: [] });
  const signals = overrides.signals ?? fakeSignals();
  return runHealthCheck({
    image: "sha256:" + "a".repeat(64),
    runId: "envcheck_TEST",
    repoDir: REPO_DIR,
    plan: healthPlanFor({ candidate, signals }),
    sandbox,
    logs: overrides.logs ?? null,
    logKey: "env-logs/acme__web/1/envcheck_TEST.health.log",
    now: () => new Date("2026-01-02T03:04:05Z"),
  });
}

describe("Phase 7 · 体检计划（按语言选命令）", () => {
  test("构建命令全部是 required；python 多一条可选的 compileall", () => {
    const plan = healthPlanFor({
      candidate: fakeCandidate({ baseImageKind: "python-dev", buildCommands: ["poetry install"] }),
      signals: fakeSignals({ languages: ["python"] }),
    });
    assert.deepEqual(
      plan.steps.map((step) => [step.cmd, step.required]),
      [
        ["poetry install", true],
        ["python3 -m compileall -q .", false],
      ],
    );
  });

  test("没有构建命令的仓库（或认不出的语言）→ 只跑一条 true（设计文档 §C.6 的表末行）", () => {
    const plan = healthPlanFor({ candidate: fakeCandidate({ baseImageKind: "ubuntu-dev", buildCommands: [] }), signals: fakeSignals() });
    assert.deepEqual(plan.steps.map((step) => step.cmd), ["true"]);
    assert.equal(plan.steps[0]!.required, true);
  });

  test("候选里没提到、但仓库信号里有服务 → 补一条事实（候选可能来自 promote / 人工）", () => {
    const plan = healthPlanFor({
      candidate: fakeCandidate({ buildCommands: ["npm ci"], degradedRisks: [] }),
      signals: fakeSignals({ services: ["postgres", "redis"] }),
    });
    assert.deepEqual(plan.facts.map((fact) => fact.reason), [
      "compose_service_unavailable",
      "compose_service_unavailable",
    ]);
    assert.match(plan.facts[0]!.detail, /postgres/);

    // 已经在 degradedRisks 里提到的服务不重复记。
    const deduped = healthPlanFor({
      candidate: fakeCandidate({ degradedRisks: ["postgres：compose 里声明了它，而沙箱里起不了服务"] }),
      signals: fakeSignals({ services: ["postgres"] }),
    });
    assert.equal(deduped.facts.length, 1);
    assert.equal(deduped.facts[0]!.reason, "declared_risk");
  });

  test("degradedRisks 变成结构化事实：浏览器的风险归 e2e，其余归集成测试", () => {
    const plan = healthPlanFor({
      candidate: fakeCandidate({
        degradedRisks: [
          "postgres：compose 里声明了它，而沙箱里起不了服务——依赖它的集成测试不可用",
          "Playwright 浏览器缺失：e2e 跑不了",
        ],
      }),
      signals: fakeSignals({ services: ["postgres"] }),
    });
    assert.deepEqual(plan.facts.map((fact) => fact.affected), [["integration_tests"], ["e2e"]]);
  });
});

describe("Phase 7 · 三态判定", () => {
  test("ready：每条 required 都过、没有风险 → ready，沙箱被销毁、日志 key 落进报告", async () => {
    const sandbox = new FakeHealthSandbox([{ exitCode: 0, output: "added 1 package\n" }]);
    const logs = new MemoryLogStore();
    const report = await checkOf(sandbox, { logs });
    assert.equal(report.status, "ready");
    assert.equal(report.reason, null);
    assert.deepEqual(report.facts, []);
    assert.equal(report.steps.length, 1);
    assert.match(report.logKey ?? "", /env-logs\/acme__web\/1\/envcheck_TEST\.health\.log/);
    assert.deepEqual(sandbox.destroyed, ["sbx_fake"], "一次性沙箱必须销毁");
    assert.equal(sandbox.execs[0]!.cwd, REPO_DIR, "体检命令要在仓库根里跑");
    assert.deepEqual(sandbox.execs[0]!.cmd, ["bash", "-lc", "npm ci"]);
    assert.equal(report.checkedAt, "2026-01-02T03:04:05.000Z");
    // 体检日志人类可读：有步骤名、有退出码、有结论（验收标准"日志可取回并人类可读"）。
    const text = logs.objects.get(report.logKey!)!;
    assert.match(text, /# 环境体检/);
    assert.match(text, /npm ci/);
    assert.match(text, /added 1 package/);
    assert.match(text, /# 结论：ready/);
  });

  test("degraded：required 都过但命中一条降级风险（compose 的服务不可用）", async () => {
    const sandbox = new FakeHealthSandbox([{ exitCode: 0 }]);
    const report = await checkOf(sandbox, {
      candidate: fakeCandidate({ buildCommands: ["npm ci"], degradedRisks: ["postgres：服务起不来"] }),
    });
    assert.equal(report.status, "degraded");
    assert.equal(report.reason, "declared_risk");
    assert.equal(report.facts.length, 1);
    assert.deepEqual(report.facts[0]!.affected, ["integration_tests"]);
    assert.match(report.detail ?? "", /postgres/);
  });

  test("degraded：可选步骤失败（环境能用，但验证类命令不保证可信）", async () => {
    const sandbox = new FakeHealthSandbox([{ exitCode: 0 }, { exitCode: 1, output: "SyntaxError: x.py\n" }]);
    const report = await checkOf(sandbox, {
      candidate: fakeCandidate({ baseImageKind: "python-dev", buildCommands: ["poetry install"] }),
    });
    assert.equal(report.status, "degraded");
    assert.equal(report.reason, "optional_step_failed");
    assert.deepEqual(report.facts[0]!.affected, ["verification"]);
    assert.equal(report.steps.length, 2, "可选步骤失败不提前退出");
  });

  test("failed：required 失败 → 记下退出码与日志尾部，后面的步骤不再跑", async () => {
    const sandbox = new FakeHealthSandbox([{ exitCode: 1, output: "npm error 404 Not Found\n" }]);
    const report = await checkOf(sandbox, {
      candidate: fakeCandidate({ buildCommands: ["npm ci", "npm run build"] }),
    });
    assert.equal(report.status, "failed");
    assert.equal(report.reason, "step_failed");
    assert.match(report.detail ?? "", /npm ci/);
    assert.match(report.detail ?? "", /404/);
    assert.equal(report.steps.length, 1, "第一条 required 失败就是结论");
    assert.deepEqual(sandbox.destroyed, ["sbx_fake"]);
  });

  test("failed：超时（分类是 step_timeout，不是 step_failed）", async () => {
    const sandbox = new FakeHealthSandbox([{ exitCode: null, timedOut: true, output: "" }]);
    const report = await checkOf(sandbox);
    assert.equal(report.status, "failed");
    assert.equal(report.reason, "step_timeout");
  });

  test("沙箱起不来：结论是 failed（不是异常），而且没有可销毁的东西", async () => {
    const sandbox = new FakeHealthSandbox();
    sandbox.openFails = "provider 拒绝了镜像";
    const report = await checkOf(sandbox);
    assert.equal(report.status, "failed");
    assert.equal(report.reason, "sandbox_unavailable");
    assert.match(report.detail ?? "", /provider 拒绝了镜像/);
    assert.deepEqual(sandbox.destroyed, []);
    assert.deepEqual(sandbox.execs, []);
  });

  test("销毁失败不改变结论（一次性沙箱留给 sweeper）", async () => {
    const sandbox = new FakeHealthSandbox([{ exitCode: 0 }]);
    sandbox.destroy = async () => {
      throw new Error("docker 挂了");
    };
    const report = await checkOf(sandbox);
    assert.equal(report.status, "ready");
  });
});

describe("Phase 7 · 事实 → system 一行", () => {
  test("确定性：同样的 facts 两次拼出同一行；空 facts 给 null（不产生空分区）", () => {
    const facts = [
      { reason: "declared_risk", affected: ["integration_tests"], detail: "postgres 起不来" },
      { reason: "declared_risk", affected: ["e2e"], detail: "浏览器缺失" },
    ];
    const line = healthFactLine(facts);
    assert.equal(line, healthFactLine([...facts]));
    assert.match(line!, /postgres 起不来（影响：integration_tests）/);
    assert.match(line!, /浏览器缺失（影响：e2e）/);
    assert.equal(healthFactLine([]), null);
  });
});
