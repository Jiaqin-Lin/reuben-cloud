/**
 * 用例 1–4、7、16、17（外加 health 形状与环境隔离两条）。
 * 这些都不需要 Docker——Phase 1 的全部价值就在于此。
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  SseClient,
  TEST_TOKEN,
  TERMINAL_EVENTS,
  collect,
  drainExec,
  isAlive,
  killAndWait,
  runExec,
  startTestAgent,
  waitFor,
  type SseEvent,
  type TestAgent,
} from "./harness.ts";

let agent: TestAgent;

before(async () => {
  agent = await startTestAgent();
});

after(async () => {
  await agent.close();
});

test("1: 退出码 0 → completed/exit_code 0；退出码 1 也是 completed", async () => {
  const ok = await runExec(agent, { cmd: ["true"] });
  assert.equal(ok.terminal.event, "completed");
  assert.equal(ok.terminal.data.exit_code, 0);
  assert.equal(ok.terminal.data.signal, null);
  assert.equal(ok.stdout, "");

  // 非 0 退出码是 completed，不是 failed——判断成败是 CP 的事。
  const bad = await runExec(agent, { cmd: ["false"] });
  assert.equal(bad.terminal.event, "completed");
  assert.equal(bad.terminal.data.exit_code, 1);
});

test("2: stdout / stderr 分流，单流内顺序正确", async () => {
  const result = await runExec(agent, {
    cmd: ["bash", "-lc", "echo out1; echo out2; echo err1 >&2; echo err2 >&2"],
  });
  assert.equal(result.terminal.event, "completed");
  assert.equal(result.stdout, "out1\nout2\n");
  assert.equal(result.stderr, "err1\nerr2\n");
});

test("3: 长命令 POST /exec 立即返回（<100ms）", async () => {
  await agent.request("/health"); // 预热连接，别把建连时间算进去

  const startedAt = Date.now();
  const response = await agent.exec({ cmd: ["sleep", "5"] });
  const elapsed = Date.now() - startedAt;

  assert.equal(response.status, 202);
  const body = (await response.json()) as { execution_id: string; log_path: string };
  assert.match(body.execution_id, /^exe_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(body.log_path.endsWith(`${body.execution_id}.log`));
  assert.ok(elapsed < 100, `POST /exec 往返 ${elapsed}ms，应该 <100ms`);

  await killAndWait(agent, body.execution_id);
});

test("4: 进程结束之前就能收到中间输出", async () => {
  const response = await agent.exec({ cmd: ["bash", "-lc", "echo a; sleep 0.4; echo b"] });
  const { execution_id } = (await response.json()) as { execution_id: string };
  const client = await SseClient.connect(`${agent.baseUrl}/exec/${execution_id}/events`, TEST_TOKEN);

  const events: SseEvent[] = [];
  let sawAAt = 0;
  let terminalAt = 0;
  try {
    for (;;) {
      const event = await client.next();
      events.push(event);
      if (event.event === "stdout" && (event.data.chunk as string).includes("a") && sawAAt === 0) {
        sawAAt = Date.now();
      }
      if (TERMINAL_EVENTS.has(event.event)) {
        terminalAt = Date.now();
        break;
      }
    }
  } finally {
    client.close();
  }

  assert.equal(events[0]!.event, "started");
  assert.ok(sawAAt > 0, "应该收到 a");
  assert.ok(
    terminalAt - sawAAt >= 250,
    `a 必须在进程结束前到达（实际间隔 ${terminalAt - sawAAt}ms）`,
  );
  assert.equal(collect(events, "stdout"), "a\nb\n");
});

test("7: 主动 kill → killed 终态、进程组真死、接口幂等", async () => {
  const response = await agent.exec({
    cmd: ["bash", "-lc", "sleep 300 & echo $! > bg7.pid; sleep 300"],
  });
  const { execution_id } = (await response.json()) as { execution_id: string };
  const client = await SseClient.connect(`${agent.baseUrl}/exec/${execution_id}/events`, TEST_TOKEN);
  try {
    const first = await client.next();
    assert.equal(first.event, "started");

    const pidPath = path.join(agent.root, "bg7.pid");
    await waitFor(() => existsSync(pidPath), { message: "后台进程没写出 pid 文件" });

    const kill = await agent.request(`/exec/${execution_id}/kill`, { method: "POST" });
    assert.equal(kill.status, 200);
    assert.equal(((await kill.json()) as { status: string }).status, "killing");

    const events: SseEvent[] = [];
    for (;;) {
      const event = await client.next();
      events.push(event);
      if (TERMINAL_EVENTS.has(event.event)) break;
    }
    assert.equal(events.at(-1)!.event, "killed");

    const pid = Number.parseInt(await readFileText(pidPath), 10);
    await waitFor(() => !isAlive(pid), { timeoutMs: 3_000, message: `后台进程 ${pid} 应该被杀掉` });
  } finally {
    client.close();
  }

  // 幂等：已经在终态，再 kill 一次仍然 200 且返回当前状态。
  const again = await agent.request(`/exec/${execution_id}/kill`, { method: "POST" });
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { status: string }).status, "killed");

  // 未知 id → 404
  const missing = await agent.request("/exec/exe_01HZZZZZZZZZZZZZZZZZZZZZZZ/kill", {
    method: "POST",
  });
  assert.equal(missing.status, 404);
});

test("16: 可执行文件不存在 → 202 + failed 事件（不是 400）", async () => {
  const result = await runExec(agent, { cmd: ["definitely-not-a-binary-xyz"] });
  assert.equal(result.terminal.event, "failed");
  assert.equal(result.terminal.data.error, "ENOENT");
  assert.equal(result.terminal.data.exit_code, null);
});

test("17: 无隐式 shell —— 管道符原样当参数", async () => {
  const result = await runExec(agent, { cmd: ["echo", "a", "|", "b"] });
  assert.equal(result.terminal.event, "completed");
  assert.equal(result.stdout, "a | b\n");

  // 要 shell 就显式写出来
  const piped = await runExec(agent, { cmd: ["bash", "-lc", "printf 'x\\ny\\n' | wc -l"] });
  assert.equal(piped.stdout.trim(), "2");
});

test("extra: /health 形状与 activeExecution", async () => {
  const response = await agent.request("/health");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    status: string;
    version: string;
    activeExecution: string | null;
  };
  assert.equal(body.status, "ready");
  assert.equal(body.version, "0.0.1");
  assert.equal(body.activeExecution, null);

  const running = await agent.exec({ cmd: ["sleep", "5"] });
  const { execution_id } = (await running.json()) as { execution_id: string };
  const busy = (await (await agent.request("/health")).json()) as { activeExecution: string | null };
  assert.equal(busy.activeExecution, execution_id);

  await killAndWait(agent, execution_id);
  const idle = (await (await agent.request("/health")).json()) as { activeExecution: string | null };
  assert.equal(idle.activeExecution, null);
});

test("extra: cwd 默认是 workspace 根；请求里的 env 叠加在固定最小集合上", async () => {
  const pwd = await runExec(agent, { cmd: ["pwd"] });
  assert.equal(pwd.stdout.trim(), agent.realRoot);

  const env = await runExec(agent, { cmd: ["bash", "-lc", "echo $CI"], env: { CI: "1" } });
  assert.equal(env.stdout, "1\n");
});

test("extra: 子进程环境里没有 agent token，也不继承宿主 env", async () => {
  const marker = "SHOULD_NOT_LEAK_FROM_HOST";
  process.env[marker] = "1";
  try {
    const result = await runExec(agent, {
      cmd: ["bash", "-lc", "env; echo HOME=$HOME; echo LANG=$LANG"],
    });
    assert.ok(!result.stdout.includes("SANDBOX_AGENT_TOKEN"), "token 不能进子进程环境");
    assert.ok(!result.stdout.includes(marker), "不能继承宿主 env");
    assert.ok(result.stdout.includes(`HOME=${agent.config.home}`));
    assert.ok(result.stdout.includes(`LANG=${agent.config.lang}`));
  } finally {
    delete process.env[marker];
  }
});

test("extra: 代理变量（部署时由 provider 注入）会透传到子进程，请求里的 env 优先", async () => {
  // Phase 5 写集成测试时发现的缺口：provider 在容器 env 里写 HTTP_PROXY，
  // 而子进程环境是一份固定集合——不显式透传的话，internal 网络里 npm install 必定失败。
  const proxyAgent = await startTestAgent({
    env: { HTTP_PROXY: "http://reuben-cloud-proxy:3128", https_proxy: "http://reuben-cloud-proxy:3128" },
  });
  try {
    const result = await runExec(proxyAgent, {
      cmd: ["bash", "-lc", "printf '%s\\n' \"$HTTP_PROXY\"; printf '%s\\n' \"$https_proxy\""],
    });
    assert.equal(result.stdout, "http://reuben-cloud-proxy:3128\nhttp://reuben-cloud-proxy:3128\n");
    // 透传代理不等于把整个 env 泄进来：token 依然不在子进程里。
    const envDump = await runExec(proxyAgent, { cmd: ["bash", "-lc", "env"] });
    assert.ok(!envDump.stdout.includes("SANDBOX_AGENT_TOKEN"));
    // 请求里的同名变量覆盖部署值（工具层要能临时改代理）。
    const overridden = await runExec(proxyAgent, {
      cmd: ["bash", "-lc", "printf '%s\\n' \"$HTTP_PROXY\""],
      env: { HTTP_PROXY: "http://other-proxy:1" },
    });
    assert.equal(overridden.stdout, "http://other-proxy:1\n");
  } finally {
    await proxyAgent.close();
  }
});

test("extra: cwd 在 root 之内但不存在的路径 → failed 事件而不是 400", async () => {
  const result = await runExec(agent, { cmd: ["true"], cwd: path.join(agent.root, "nope") });
  assert.equal(result.terminal.event, "failed");
  assert.equal(result.terminal.data.error, "ENOENT");
});

test("extra: started 事件带 pid 与 cwd；SSE 未知 id → 404", async () => {
  const response = await agent.exec({ cmd: ["true"] });
  const { execution_id } = (await response.json()) as { execution_id: string };
  const events = await drainExec(agent, execution_id);
  const started = events[0]!;
  assert.equal(started.event, "started");
  assert.equal(typeof started.data.pid, "number");
  assert.equal(started.data.execution_id, execution_id);
  assert.match(started.data.ts, /^\d{4}-\d{2}-\d{2}T/);

  const missing = await agent.request("/exec/exe_01HZZZZZZZZZZZZZZZZZZZZZZZ/events");
  assert.equal(missing.status, 404);

  const unknownRoute = await agent.request("/nope");
  assert.equal(unknownRoute.status, 404);
});

test("extra: 输出合并 —— 大块输出被拆成多条事件且内容完整", async () => {
  const expected = "x".repeat(200_000);
  const result = await runExec(agent, {
    cmd: ["node", "-e", `process.stdout.write("x".repeat(${expected.length}))`],
  });
  const stdoutEvents = result.events.filter((event) => event.event === "stdout");
  assert.ok(stdoutEvents.length > 1, "200KB 应该被拆成多条事件");
  assert.equal(result.stdout, expected);
  for (const event of stdoutEvents) {
    assert.ok(Buffer.byteLength(event.data.chunk as string) <= agent.config.chunkBytes);
  }
});

test("extra: 日志文件与 stdout_bytes + stderr_bytes 一致", async () => {
  const result = await runExec(agent, {
    cmd: ["bash", "-lc", "echo out; echo err >&2"],
  });
  const info = await stat(result.terminal.data.log_path);
  assert.equal(info.size, result.terminal.data.stdout_bytes + result.terminal.data.stderr_bytes);
  assert.equal(info.size, Buffer.byteLength("out\nerr\n"));
});

test("extra: 未跟踪的目录也能作为 cwd（mkdir 之后立即可用）", async () => {
  const dir = path.join(agent.root, "sub dir");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "marker.txt"), "ok");
  const result = await runExec(agent, { cmd: ["cat", "marker.txt"], cwd: dir });
  assert.equal(result.stdout, "ok");
});

async function readFileText(file: string): Promise<string> {
  return readFile(file, "utf8");
}
