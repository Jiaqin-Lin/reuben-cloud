/**
 * Phase 7 · 容器里的 exec 链路（`--tag=exec`）。
 *
 * Phase 1 已经把这些行为在**宿主机裸跑**里测透了（`packages/sandbox-agent/test/exec-*.test.ts`）。
 * 这一份不是重复：它验的是"同一套代码在**容器里**还成不成立"——只读根 + tmpfs 的 /tmp +
 * 非 root + cgroup 限额 + 代理变量，这几件事都可能让裸跑时正确的东西变形
 * （Phase 6 发现的 tmpfs noexec 就是这么被发现的：裸跑永远测不出来）。
 *
 * 覆盖 §J 功能闭环里的 2/3/7 三条：正确的退出码与两路输出、长命令执行中就能拿到中间输出、
 * 大输出被截断且日志文件完整。
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SmokeSandbox, execOk, smokeGroup } from "../src/harness.ts";

smokeGroup("exec（容器内）", { tags: ["exec"] }, () => {
  let box: SmokeSandbox;

  before(async () => {
    box = await SmokeSandbox.create({ label: "exec" });
  });

  after(async () => {
    await box?.destroy();
  });

  test("E1 · 事件流形状：started → stdout/stderr 分流 → completed，退出码与 cwd 正确", async () => {
    const result = await box.exec(["bash", "-c", "printf 'out-line\\n'; printf 'err-line\\n' >&2; pwd"]);
    assert.equal(result.terminal.event, "completed", `终态不是 completed：${result.terminal.event}`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);

    // 第一条事件必须是 started：CP 靠它知道"命令真的起来了"、以及在哪儿跑的。
    assert.equal(result.events[0]?.event, "started", `第一条事件不是 started：${result.events[0]?.event}`);
    assert.equal(result.events[0]?.data.cwd, "/workspace", `cwd 不是 workspace 根：${String(result.events[0]?.data.cwd)}`);

    // 两路输出各自成章，没有串台。
    assert.equal(result.stdout, "out-line\n/workspace\n");
    assert.equal(result.stderr, "err-line\n");
  });

  test("E2 · 长命令执行中就能拿到中间输出（不是等结束才一次性吐出来）", async () => {
    // 故意 sleep 一下再打第二行：能不能在进程结束**之前**收到第一行，
    // 完全取决于 agent 的输出合并器（100ms flush）与管道接线是不是真的在流式工作。
    const result = await box.exec(["bash", "-c", "echo first; sleep 1.5; echo second"], { timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0);

    const first = result.events.find(
      (event) => event.event === "stdout" && String(event.data.chunk).includes("first"),
    );
    assert.ok(first !== undefined, `没收到第一行输出：stdout=${JSON.stringify(result.stdout)}`);
    const leadMs = result.terminal.at - first.at;
    assert.ok(
      leadMs >= 1_000,
      `第一行输出只比终态早 ${leadMs}ms——输出大概率卡在管道缓冲里，实时性是假的`,
    );
  });

  test("E3 · 超时：终态是 timeout，且整棵进程树（含后台子孙）都真的死了", async () => {
    const result = await box.exec(["bash", "-c", "sleep 47 & sleep 48"], { timeoutMs: 2_000 });
    assert.equal(result.terminal.event, "timeout", `终态不是 timeout：${result.terminal.event}`);
    assert.equal(result.exitCode, null, "被信号杀掉的进程不该有退出码");
    assert.ok(
      result.signal === "SIGTERM" || result.signal === "SIGKILL",
      `信号不是 SIGTERM/SIGKILL：${String(result.signal)}`,
    );

    // 关键的一条：超时杀的是**进程组**，不只是直接子进程。
    // pgrep 的模式写成 `sleep 4[78]`：这样它不会匹配到自身所在 bash 的 argv（那里面是字面量
    // `sleep 4[78]`，与正则不匹配），也不会匹配 pgrep 自己（pgrep 不列自身）。
    const leftover = await execOk(box, ["bash", "-c", "pgrep -af 'sleep 4[78]' || echo none"]);
    assert.equal(leftover.stdout.trim(), "none", `超时之后还有残留进程：${leftover.stdout.trim()}`);
  });

  test("E4 · 大输出：事件流标 truncated，日志文件里有完整内容", async () => {
    // 300 KB 的输出配 64 KiB 的内联预算：必然溢出（§C.2 的输出外置规则）。
    const result = await box.exec(["bash", "-c", "head -c 300000 /dev/zero | tr '\\0' x"], {
      maxOutputBytes: 65_536,
      timeoutMs: 60_000,
    });
    assert.equal(result.exitCode, 0);

    const truncated = result.events.find((event) => event.event === "truncated");
    assert.ok(truncated !== undefined, "输出超预算了却没有 truncated 事件");
    assert.equal(truncated.data.reason, "output_limit", `截断原因不是 output_limit：${String(truncated.data.reason)}`);

    // 完整内容在日志文件里，而且能通过 /files?raw=1（读根包含 logRoot）原样读回来。
    const logPath = String(result.terminal.data.log_path ?? "");
    assert.match(logPath, /^\/tmp\/reuben-cloud\/exec\/exe_/, `日志路径不在预期位置：${logPath}`);
    const log = await box.readRaw(logPath);
    assert.ok(
      log.length >= 300_000,
      `日志文件只有 ${log.length} 字节，完整输出（≥300000）没落盘`,
    );
    assert.equal(log[0], 0x78, "日志开头不是被 x 填充的内容");
  });
});
