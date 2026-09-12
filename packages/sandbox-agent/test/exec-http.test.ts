/**
 * 用例 13、14、15：并发闸、鉴权、参数校验。
 * 收敛点：越界是 400、不存在是 failed 事件、超时上限不静默截断。
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { killAndWait, runExec, startTestAgent, TEST_TOKEN, type TestAgent } from "./harness.ts";

let agent: TestAgent;

before(async () => {
  agent = await startTestAgent();
});

after(async () => {
  await agent.close();
});

test("13: 单执行闸 —— 第二个请求 409 且带 activeExecution", async () => {
  const first = await agent.exec({ cmd: ["sleep", "5"] });
  assert.equal(first.status, 202);
  const { execution_id } = (await first.json()) as { execution_id: string };

  const second = await agent.exec({ cmd: ["true"] });
  assert.equal(second.status, 409);
  const body = (await second.json()) as { error: string; activeExecution: string };
  assert.equal(body.error, "busy");
  assert.equal(body.activeExecution, execution_id);

  await killAndWait(agent, execution_id);

  // 槽位释放之后立刻可以再跑
  const third = await runExec(agent, { cmd: ["true"] });
  assert.equal(third.terminal.event, "completed");
});

test("14: 鉴权 —— 缺失 / 错误 / 长度不等 / 方案不对 一律 401", async () => {
  const wrongSameLength = "x".repeat(TEST_TOKEN.length);
  const cases: Array<[string, string | null]> = [
    ["没有 Authorization", null],
    ["token 不对但长度相同", wrongSameLength],
    ["token 长度不等", "short"],
    ["空 token", ""],
    ["不是 Bearer 方案", "Basic dXNlcjpwYXNz"],
  ];

  for (const [name, token] of cases) {
    const response = await agent.request("/health", { token });
    assert.equal(response.status, 401, `${name} 应该 401`);
    assert.equal(((await response.json()) as { error: string }).error, "unauthorized");
  }

  // 鉴权在所有路由之前生效：/exec 与 SSE 也一样
  const exec = await agent.request("/exec", { method: "POST", token: null, body: "{}" });
  assert.equal(exec.status, 401);

  const events = await agent.request("/exec/exe_01HZZZZZZZZZZZZZZZZZZZZZZZ/events", { token: null });
  assert.equal(events.status, 401);

  // 正确 token 正常通过
  const ok = await agent.request("/health");
  assert.equal(ok.status, 200);
});

test("15: 参数校验 —— 该 400 的都 400，且错误码稳定", async () => {
  const cases: Array<[string, unknown, string]> = [
    ["cmd 缺失", {}, "invalid_cmd"],
    ["cmd 不是数组", { cmd: "echo hi" }, "invalid_cmd"],
    ["cmd 是空数组", { cmd: [] }, "invalid_cmd"],
    ["cmd 元素不是字符串", { cmd: ["echo", 1] }, "invalid_cmd"],
    ["cmd[0] 是空字符串", { cmd: [""] }, "invalid_cmd"],
    ["cmd 含 NUL", { cmd: ["echo", "a\0b"] }, "invalid_cmd"],
    ["timeoutMs 超硬上限", { cmd: ["true"], timeoutMs: 600_001 }, "timeout_exceeds_max"],
    ["timeoutMs 是 0", { cmd: ["true"], timeoutMs: 0 }, "invalid_timeout"],
    ["timeoutMs 不是整数", { cmd: ["true"], timeoutMs: 1.5 }, "invalid_timeout"],
    ["cwd 绝对路径越界", { cmd: ["true"], cwd: "/etc" }, "path_out_of_bounds"],
    ["cwd 相对路径越界", { cmd: ["true"], cwd: "../../etc" }, "path_out_of_bounds"],
    ["cwd 前缀绕过", { cmd: ["true"], cwd: `${agent.realRoot}-evil` }, "path_out_of_bounds"],
    ["cwd 是空字符串", { cmd: ["true"], cwd: "" }, "invalid_cwd"],
    ["env 值不是字符串", { cmd: ["true"], env: { A: 1 } }, "invalid_env"],
    ["env 不是对象", { cmd: ["true"], env: ["A"] }, "invalid_env"],
    ["maxOutputBytes 非正", { cmd: ["true"], maxOutputBytes: -1 }, "invalid_max_output_bytes"],
  ];

  for (const [name, body, error] of cases) {
    const response = await agent.exec(body);
    assert.equal(response.status, 400, `${name} 应该 400，实际 ${response.status}`);
    assert.equal(((await response.json()) as { error: string }).error, error, name);
  }
});

test("15b: 请求体不是 JSON 对象 → 400；timeoutMs 上边界可用", async () => {
  const notJson = await agent.request("/exec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(notJson.status, 400);
  assert.equal(((await notJson.json()) as { error: string }).error, "invalid_json");

  const arrayBody = await agent.request("/exec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "[]",
  });
  assert.equal(arrayBody.status, 400);
  assert.equal(((await arrayBody.json()) as { error: string }).error, "invalid_body");

  const emptyBody = await agent.request("/exec", { method: "POST" });
  assert.equal(emptyBody.status, 400);

  // 硬上限本身是可用的（不是「>= 就拒」）
  const boundary = await runExec(agent, { cmd: ["true"], timeoutMs: 600_000 });
  assert.equal(boundary.terminal.event, "completed");
});

test("15c: cwd 存在性不影响策略判定（不存在 → 202 + failed）", async () => {
  // runExec 内部会断言 POST 拿到的是 202（而不是 400）
  const result = await runExec(agent, { cmd: ["true"], cwd: `${agent.realRoot}/definitely-missing` });
  assert.equal(result.terminal.event, "failed");
  assert.equal(result.terminal.data.error, "ENOENT");
});
