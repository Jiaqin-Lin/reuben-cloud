/**
 * 用例 5、6、8、9、10 + 日志上限一条。
 * 这一组是「进程组回收」和「大输出分层」——风险登记里排第一的那两条。
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  drainExec,
  isAlive,
  runExec,
  startTestAgent,
  waitFor,
  type TestAgent,
} from "./harness.ts";

let agent: TestAgent;

before(async () => {
  agent = await startTestAgent();
});

after(async () => {
  await agent.close();
});

test("5: 超时杀掉整个进程组，一个后台进程都不留", async () => {
  const response = await agent.exec({
    cmd: ["bash", "-lc", "sleep 300 & echo $! > bg5a.pid; sleep 300 & echo $! > bg5b.pid; wait"],
    timeoutMs: 600,
  });
  const { execution_id } = (await response.json()) as { execution_id: string };

  const pidFiles = [path.join(agent.root, "bg5a.pid"), path.join(agent.root, "bg5b.pid")];
  await waitFor(() => pidFiles.every((file) => existsSync(file)), {
    message: "后台进程没写出 pid 文件",
  });

  const startedAt = Date.now();
  const events = await drainExec(agent, execution_id);
  const terminal = events.at(-1)!;

  assert.equal(terminal.event, "timeout");
  assert.equal(terminal.data.timeout_ms, 600);
  assert.ok(
    Date.now() - startedAt < 4_000,
    "SIGTERM 应该立刻生效，不该等到 5 秒后的 SIGKILL",
  );

  for (const file of pidFiles) {
    const pid = Number.parseInt(await readFile(file, "utf8"), 10);
    assert.ok(pid > 0);
    await waitFor(() => !isAlive(pid), {
      timeoutMs: 3_000,
      message: `pid ${pid} 应该随进程组一起被杀掉`,
    });
  }
});

test("6: 正常结束不禁子进程（后台进程继续活着，清理交给 destroy）", async () => {
  const result = await runExec(agent, {
    cmd: ["bash", "-lc", "nohup sleep 300 >/dev/null 2>&1 & echo $!"],
  });

  assert.equal(result.terminal.event, "completed");
  assert.equal(result.terminal.data.exit_code, 0);

  const pid = Number.parseInt(result.stdout.trim(), 10);
  assert.ok(pid > 0, `期望 pid，实际收到 ${JSON.stringify(result.stdout)}`);
  assert.ok(isAlive(pid), "后台进程不应该被连带杀掉");

  process.kill(pid, "SIGKILL"); // 测试自己清理，别留一个 300 秒的 sleep
});

test("8: 5 MiB 输出被截断，事件流 ≤ 上限，日志文件完整", async () => {
  const total = 5 * 1024 * 1024;
  const result = await runExec(
    agent,
    { cmd: ["bash", "-lc", `yes | head -c ${total}`], maxOutputBytes: 1_048_576 },
    { timeoutMs: 30_000 },
  );

  assert.equal(result.terminal.event, "completed");
  assert.equal(result.terminal.data.truncated, true);
  assert.equal(result.terminal.data.stdout_bytes, total);

  const truncated = result.events.find((event) => event.event === "truncated");
  assert.ok(truncated !== undefined, "应该收到 truncated 事件");
  assert.equal(truncated.data.reason, "output_limit");
  assert.equal(truncated.data.limit, 1_048_576);
  assert.equal(truncated.data.log_path, result.logPath);

  // 事件流总量 ≤ maxOutputBytes（内容全是 ASCII，应该正好填满）
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 1_048_576);
  assert.equal(result.stdout.length, 1_048_576);

  // 完整内容始终在日志文件里
  const info = await stat(result.terminal.data.log_path);
  assert.equal(info.size, total);
});

test("9: 二进制输出不破坏事件流（非法字节 → 恰好一个替换字符）", async () => {
  const result = await runExec(agent, {
    cmd: ["node", "-e", "process.stdout.write(Buffer.from([0,1,0xff,0xc3,0xa9]))"],
  });

  assert.equal(result.terminal.event, "completed");
  assert.equal(result.stdout, "\u0000\u0001\uFFFD\u00e9");
  assert.equal((result.stdout.match(/\uFFFD/g) ?? []).length, 1);
});

test("10: 100KB 中文跨 chunk 重组后与源字节一致（StringDecoder）", async () => {
  const chars = 34_000;
  const expected = "中".repeat(chars);
  const result = await runExec(agent, {
    cmd: ["node", "-e", `process.stdout.write("中".repeat(${chars}))`],
  });

  assert.equal(result.terminal.event, "completed");
  assert.equal(result.stdout, expected);
  assert.equal(Buffer.byteLength(result.stdout, "utf8"), chars * 3);
  assert.ok(!result.stdout.includes("\uFFFD"));
});

test("extra: 日志超过上限后停止写，但命令继续跑完", async () => {
  const limited = await startTestAgent({ config: { maxLogBytes: 4096 } });
  try {
    const result = await runExec(
      limited,
      { cmd: ["bash", "-lc", "yes | head -c 102400"] },
      { timeoutMs: 30_000 },
    );

    assert.equal(result.terminal.event, "completed");
    assert.equal(result.terminal.data.exit_code, 0, "写日志失败不能弄死执行");
    assert.equal(result.terminal.data.log_truncated, true);
    assert.equal(result.terminal.data.stdout_bytes, 102_400);
    // 输出没超过 maxOutputBytes（默认 1MiB），所以事件流里的内容是完整的
    assert.equal(result.terminal.data.truncated, false);

    const truncated = result.events.find(
      (event) => event.event === "truncated" && event.data.reason === "log_limit",
    );
    assert.ok(truncated !== undefined, "应该收到 log_limit 的 truncated 事件");
    assert.equal(truncated.data.limit, 4096);

    const info = await stat(result.terminal.data.log_path);
    assert.equal(info.size, 4096);
  } finally {
    await limited.close();
  }
});

test("extra: stderr 独立记账，且与 stdout 共享同一份事件流预算", async () => {
  const result = await runExec(
    agent,
    {
      cmd: ["bash", "-lc", "yes | head -c 200000 | tr 'y' 'e' >&2"],
      maxOutputBytes: 1024,
    },
    { timeoutMs: 30_000 },
  );

  assert.equal(result.terminal.event, "completed");
  assert.equal(result.terminal.data.stderr_bytes, 200_000);
  assert.equal(result.terminal.data.stdout_bytes, 0);
  assert.equal(result.terminal.data.truncated, true);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 1024);
});
