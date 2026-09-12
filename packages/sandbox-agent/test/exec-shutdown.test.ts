/**
 * 用例 18：SIGTERM 优雅退出。
 *
 * 这个用例必须起一个真的进程（不是进程内的 server）：验的是进程收到信号之后
 * 会不会把子进程组带走、会不会释放端口、退出码是不是 0。
 * Docker stop 是先 SIGTERM、10 秒后 SIGKILL——agent 必须在这 10 秒内收干净。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { TEST_TOKEN, isAlive, waitFor, withTimeout } from "./harness.ts";

const AGENT_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("18: SIGTERM → 杀掉在跑的进程组、释放端口、退出码 0", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rc-shutdown-"));
  const child = spawn(process.execPath, [AGENT_ENTRY], {
    env: {
      ...process.env,
      SANDBOX_AGENT_TOKEN: TEST_TOKEN,
      SANDBOX_AGENT_HOST: "127.0.0.1",
      SANDBOX_AGENT_PORT: "0",
      SANDBOX_WORKSPACE_ROOT: root,
      SANDBOX_LOG_ROOT: path.join(root, "logs"),
      SANDBOX_AGENT_HOME: path.join(root, "home"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const port = await withTimeout(readPort(child), 8_000, "agent 没能在 8s 内启动");
    const baseUrl = `http://127.0.0.1:${port}`;
    const auth = { authorization: `Bearer ${TEST_TOKEN}` };

    const started = await fetch(`${baseUrl}/exec`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ cmd: ["bash", "-lc", "echo $$ > descendant.pid; sleep 300"] }),
    });
    assert.equal(started.status, 202);

    const pidFile = path.join(root, "descendant.pid");
    await waitFor(() => existsSync(pidFile), { message: "子进程组没写出 pid" });
    const descendant = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    assert.ok(isAlive(descendant), "子进程组应该还在跑");

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    child.kill("SIGTERM");
    const result = await withTimeout(exited, 8_000, "agent 收到 SIGTERM 之后没有退出");

    assert.equal(result.signal, null, "应该是自己退出的，不是被信号打死");
    assert.equal(result.code, 0);

    await waitFor(() => !isAlive(descendant), {
      timeoutMs: 3_000,
      message: `子进程组 ${descendant} 应该在 agent 退出前被杀掉`,
    });

    // 端口已经释放
    await assert.rejects(
      fetch(`${baseUrl}/health`, { headers: auth }),
      "退出之后端口不应该还能连上",
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, {
      timeoutMs: 2_000,
      message: "agent 进程没有收干净",
    }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("18b: 缺少 SANDBOX_AGENT_TOKEN → 非 0 退出且给出说明", async () => {
  const child = spawn(process.execPath, [AGENT_ENTRY], {
    env: { ...process.env, SANDBOX_AGENT_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const exit = new Promise<number | null>((resolve) => child.once("exit", resolve));
  const code = await withTimeout(exit, 8_000, "缺 token 时 agent 应该立刻退出");

  assert.notEqual(code, 0);
  assert.match(output, /SANDBOX_AGENT_TOKEN/);
});

function readPort(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match !== null) {
        child.stdout?.off("data", onData);
        resolve(Number.parseInt(match[1]!, 10));
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => reject(new Error(`agent 提前退出 code=${code}，输出：${output}`)));
  });
}
