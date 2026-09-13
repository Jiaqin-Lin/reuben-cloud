/**
 * Phase 7 · 隔离红线（`--tag=isolation`）。
 *
 * 逐条对应 spec Phase 7 §2 那张表（I1–I10），也就是 §J「隔离（红线，全过才算）」那张表在
 * 实现层的落点。两条自我约束：
 *
 *  1. **全部通过 `/exec` 在容器里跑**（除了 I10 那条 `docker inspect`），
 *     所以这份文件顺带把 exec 链路也测了——spec 的原话是"顺带把 exec 也测了"。
 *  2. **默认只在 Linux 上跑**。`linuxOnly` 的理由是 §J 末尾那句：macOS 的 Docker Desktop
 *     用不同的内核与 seccomp 行为，本机通过不代表生产通过。所以在这台 mac 上它整组跳过；
 *     想要一份参考结论就 `SMOKE_ANY_PLATFORM=1 npm run smoke -- --tag=isolation`。
 *
 * I7/I8 单独一组、用自己的沙箱：它们一个要把内存打爆、一个要把进程数打爆，
 * 拉上别的用例共用沙箱只会让"是不是我把它弄死了"变成一个额外变量。
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  INTERNAL_NETWORK_NAME,
  SMOKE_LIMITS,
  SmokeSandbox,
  execFail,
  execOk,
  smokeGroup,
  waitFor,
} from "../src/harness.ts";
import { dockerOrThrow, rawInspect } from "../../control-plane/test/support.ts";
import { LABEL_MANAGED, LABEL_ROLE, LABEL_SANDBOX_ID } from "../../control-plane/src/provider/types.ts";

/**
 * 凭据扫描的脚本。
 *
 * 为什么分两段、而不是一条 `grep -r EXPR /`：**镜像里的第三方文档本身就含这些词**。
 * 实测 `/usr/local/lib/node_modules/npm/docs/...` 里有 `-----BEGIN PRIVATE KEY-----` 的
 * 示例（内容是一串 XXXX），全局搜私钥头必然假阳性。所以：
 *  - 第一段扫全盘（`/`，排除 proc/sys/dev）找**凭据的形状**：GitHub token 前缀与
 *    `x-access-token`（GitHub App 安装 token 进 URL 的唯一写法）。这两类词在整镜像里
 *    实测零命中，可以直接当红线断言。
 *  - 第二段只在"凭据真落下来的地方"找私钥头：workspace、/tmp（HOME 在 /tmp/agent 下）、
 *    /etc、/app、/home、/root。第三方文档不在这些地方。
 */
const CREDENTIAL_SCAN = [
  'echo "== tokens =="',
  "grep -rIlE 'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|x-access-token' / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | head -20 || true",
  'echo "== private-keys =="',
  "grep -rIl 'PRIVATE KEY' /workspace /tmp /etc /app /home /root 2>/dev/null | head -20 || true",
  'echo "== scan-done =="',
].join("\n");

/** 取出两个标记之间的行（去掉空行）。 */
function between(text: string, start: string, end: string): string[] {
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from < 0 || to < 0) throw new Error(`扫描输出里缺少标记 ${start} / ${end}：\n${text}`);
  return text
    .slice(from + start.length, to)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

smokeGroup("隔离红线 · 基础（I1–I6、I9、I10）", { tags: ["isolation"], linuxOnly: true }, () => {
  let box: SmokeSandbox;

  before(async () => {
    box = await SmokeSandbox.create({ label: "iso" });
  });

  after(async () => {
    await box?.destroy();
  });

  test("I1 · id -u 是 1000（非 root）", async () => {
    const result = await execOk(box, ["id", "-u"]);
    assert.equal(result.stdout.trim(), "1000", `id -u 得到 ${result.stdout.trim()}：沙箱必须是非 root`);
    // 顺带看一眼 uid 0 确实不是我们：容器里只有 uid 1000 跑得动 agent。
    const whoami = await execOk(box, ["id"]);
    assert.match(whoami.stdout, /uid=1000/, `id 的输出里没有 uid=1000：${whoami.stdout.trim()}`);
  });

  test("I2 · 只读根：touch /nope 失败，且错误是 EROFS", async () => {
    const result = await execFail(box, ["touch", "/nope"]);
    assert.match(
      result.stderr,
      /read-only file system/i,
      `失败原因不是只读文件系统（说明容器没有 --read-only）：${result.stderr.trim()}`,
    );
    // /etc 也是根文件系统的一部分：换一个路径确认不是"只有 / 顶层不可写"。
    const etc = await execFail(box, ["touch", "/etc/rc-smoke-should-fail"]);
    assert.match(etc.stderr, /read-only file system/i, `/etc 竟然可写：${etc.stderr.trim()}`);
  });

  test("I3 · /workspace、/tmp、$HOME 都可写", async () => {
    const result = await execOk(box, [
      "bash",
      "-c",
      // $HOME 也要打印出来：这一条断言的语义是"agent 给子进程的那个 HOME 是可写的"，
      // 不打印的话，将来 HOME 被改成别处时没人知道测的是哪儿。
      'echo "HOME=$HOME"; touch /workspace/rc-smoke-a && touch /tmp/rc-smoke-b && touch "$HOME/rc-smoke-c" && echo "I3-OK"',
    ]);
    assert.match(result.stdout, /HOME=\/tmp\/agent/, `HOME 不是软件里那个可写点：${result.stdout.trim()}`);
    assert.match(result.stdout, /I3-OK/, `三个可写点没有全部写成功：${result.stdout.trim()}`);
  });

  test("I4 · 宿主机 docker socket 没有暴露进容器", async () => {
    const result = await execOk(box, [
      "bash",
      "-c",
      'test ! -e /var/run/docker.sock && test ! -e /run/docker.sock && ! command -v docker >/dev/null && echo "I4-OK"',
    ]);
    assert.match(result.stdout, /I4-OK/, "容器里能看到 docker socket 或 docker CLI");
  });

  test("I5 · 非白名单域名不可达：curl https://github.com 必须失败", async () => {
    const result = await execFail(box, ["curl", "-sS", "-o", "/dev/null", "--max-time", "20", "https://github.com"]);
    // 必须证明确实是被代理**拒绝**了，而不是"DNS 挂了"或"没有路由"——
    // 后者在配错代理时也会出现，但它不是白名单在起作用（而且是"看起来也安全"的假象）。
    const combined = `${result.stderr}\n${result.stdout}`;
    assert.match(
      combined,
      /403|forbidden|not allowed|不在白名单/i,
      `github.com 不是被代理 403 拒掉的（错误看起来是别的原因）：${combined.trim()}`,
    );
  });

  test("I6 · 白名单域名可达：curl https://registry.npmjs.org/left-pad 成功", async () => {
    // 拿一个**包的文档**而不是 registry 根：根路径在 curl 请求下返回 `{}`（实测，
    // 与 Accept 头有关），那种 200 证明不了什么。包文档是 npm 真要拿的东西。
    const result = await execOk(box, [
      "curl",
      "-sS",
      "--max-time",
      "30",
      "-w",
      "\\n%{http_code}\\n",
      "https://registry.npmjs.org/left-pad",
    ]);
    assert.match(result.stdout, /"name"\s*:\s*"left-pad"/, "registry 的响应里没有包文档");
    assert.match(result.stdout, /\n200\s*$/, `HTTP 状态码不是 200：${result.stdout.slice(-200)}`);
  });

  test("I9 · 沙箱里没有任何 GitHub 凭据（env + 全盘关键词搜索）", async () => {
    // ---- 子进程环境。agent 给子进程的是一份固定最小集合 + 代理变量，
    //      SANDBOX_AGENT_TOKEN（agent 自己的 token）都不该出现在里面。
    const env = await execOk(box, [
      "bash",
      "-c",
      "env | grep -iE 'gh[pousr]_|x-access-token|github|_TOKEN=|secret' || true",
    ]);
    assert.equal(env.stdout.trim(), "", `子进程环境里出现了可疑变量：\n${env.stdout}`);

    // ---- 先证明扫描器真的有牙齿：放一个假 token 进去，它必须被找到。
    await execOk(box, [
      "bash",
      "-c",
      'printf "ghp_%s\\n" "$(head -c 36 /dev/zero | tr "\\0" a)" > /workspace/rc-fake-token.txt',
    ]);
    const withFake = await execOk(box, ["bash", "-c", CREDENTIAL_SCAN]);
    assert.deepEqual(
      between(withFake.stdout, "== tokens ==", "== private-keys =="),
      ["/workspace/rc-fake-token.txt"],
      `扫描器没有找到故意放进去的假 token——那它后面的"干净"就什么都不证明：\n${withFake.stdout}`,
    );
    await execOk(box, ["rm", "-f", "/workspace/rc-fake-token.txt"]);

    // ---- 真正的红线：全盘找凭据形状，必须一条都没有。
    const clean = await execOk(box, ["bash", "-c", CREDENTIAL_SCAN]);
    assert.deepEqual(
      between(clean.stdout, "== tokens ==", "== private-keys =="),
      [],
      `沙箱里搜到了 GitHub token 的形状：\n${clean.stdout}`,
    );
    assert.deepEqual(
      between(clean.stdout, "== private-keys ==", "== scan-done =="),
      [],
      `沙箱里搜到了私钥：\n${clean.stdout}`,
    );
  });

  test("I10 · docker inspect 复核 Phase 5 的加固参数表（逐条）", async () => {
    const inspect = await rawInspect(box.handle.containerName);
    const config = (inspect.Config ?? {}) as Record<string, any>;
    const hostConfig = (inspect.HostConfig ?? {}) as Record<string, any>;
    const labels = (config.Labels ?? {}) as Record<string, string>;

    // —— 身份与只读
    assert.equal(config.User, "1000:1000", "Config.User 必须是 1000:1000");
    assert.equal(hostConfig.ReadonlyRootfs, true, "ReadonlyRootfs 必须是 true");

    // —— capability 与提权
    // 这条断言的名字里必须有 "CapDrop"：CI 的反向验证 job 靠它确认
    // "失败原因正是被故意拿掉的那一项"，而不是碰巧挂在别的地方。
    assert.deepEqual(
      hostConfig.CapDrop,
      ["ALL"],
      'CapDrop 必须是 ["ALL"]：反向验证（SMOKE_NEGATIVE_CONTROL）就是把它清空，读到这里必须失败',
    );
    assert.equal(hostConfig.Privileged, false, "Privileged 必须是 false");
    const securityOpt = (hostConfig.SecurityOpt ?? []) as string[];
    assert.ok(
      securityOpt.some((item) => item.startsWith("no-new-privileges")),
      `SecurityOpt 里缺 no-new-privileges：${JSON.stringify(securityOpt)}`,
    );
    assert.ok(
      securityOpt.includes("apparmor=docker-default"),
      `SecurityOpt 里缺 apparmor=docker-default：${JSON.stringify(securityOpt)}`,
    );
    // seccomp：**必须什么都不写**，不写才是 Docker 的默认 profile（§F.1 的"不能是 unconfined"）。
    assert.ok(
      !securityOpt.some((item) => item.startsWith("seccomp=")),
      `SecurityOpt 里出现了 seccomp=，那等于自己指定了 profile：${JSON.stringify(securityOpt)}`,
    );

    // —— 资源上限（数字与 spec 里那张表逐个对齐）
    const mib = 1024 * 1024;
    assert.equal(hostConfig.Memory, SMOKE_LIMITS.memMb * mib, "Memory 与 spec 的 memMb 不符");
    assert.equal(
      hostConfig.MemorySwap,
      hostConfig.Memory,
      "MemorySwap 不等于 Memory，等于给 swap 留了口子，内存上限形同虚设",
    );
    assert.equal(hostConfig.NanoCpus, SMOKE_LIMITS.cpu * 1_000_000_000, "NanoCpus 与 spec 的 cpu 不符");
    assert.equal(hostConfig.PidsLimit, SMOKE_LIMITS.pids, "PidsLimit 与 spec 的 pids 不符");
    assert.equal(hostConfig.Init, true, "Init 必须是 true（tini 收僵尸进程）");

    // —— /tmp：必须是可执行的 tmpfs（附录里那条 noexec 的坑）
    const tmpfs = String(hostConfig.Tmpfs?.["/tmp"] ?? "");
    assert.match(tmpfs, /(^|,)exec(,|$)/, `/tmp 没有显式 exec（npm postinstall / venv 会 Permission denied）：${tmpfs}`);
    assert.doesNotMatch(tmpfs, /noexec/, `/tmp 被加了 noexec：${tmpfs}`);
    assert.match(tmpfs, /size=512m/, `/tmp 的 size 不是 512m：${tmpfs}`);
    assert.match(tmpfs, /mode=1777/, `/tmp 的 mode 不是 1777：${tmpfs}`);

    // —— 挂载：只有命名卷，且只有 /workspace 一个落点
    assert.deepEqual(
      hostConfig.Binds,
      [`${box.handle.volumeName}:/workspace`],
      `Binds 不是唯一的命名卷（bind mount 只允许出现在 egress-proxy 上）：${JSON.stringify(hostConfig.Binds)}`,
    );
    assert.equal(hostConfig.NetworkMode, INTERNAL_NETWORK_NAME, "NetworkMode 必须只挂共用内网");
    // 端口：沙箱容器在任何平台上都不发布端口（darwin 的转发在另一个容器里）。
    // `PortBindings` 是空的；`NetworkSettings.Ports` 里会看到 `8080/tcp: null`——
    // 那是镜像 `EXPOSE` 的产物（"声明了但没发布"），不代表有映射，所以断言的是
    // **每个值都是 null**，而不是这个对象为空。
    assert.deepEqual(hostConfig.PortBindings ?? {}, {}, "沙箱容器发布了端口");
    const ports = (inspect.NetworkSettings?.Ports ?? {}) as Record<string, unknown>;
    assert.deepEqual(
      Object.entries(ports).filter(([, value]) => value !== null),
      [],
      `沙箱容器有宿主端口映射：${JSON.stringify(ports)}`,
    );

    // —— 网络真的只有内网一张，而且那张网真的是 internal
    assert.deepEqual(
      Object.keys(inspect.NetworkSettings?.Networks ?? {}),
      [INTERNAL_NETWORK_NAME],
      "容器挂在了内网之外的网络上",
    );
    const internal = await dockerOrThrow(["network", "inspect", INTERNAL_NETWORK_NAME, "--format", "{{.Internal}}"]);
    assert.equal(internal.trim(), "true", `${INTERNAL_NETWORK_NAME} 不是 internal 网络——整个隔离模型的地基`);

    // —— 重启与日志
    assert.equal(hostConfig.RestartPolicy?.Name, "no", "RestartPolicy 必须是 no");
    assert.ok(!hostConfig.AutoRemove, "AutoRemove 不能打开（对账要靠死掉的容器认出问题）");
    assert.equal(hostConfig.LogConfig?.Type, "json-file", "日志驱动必须是 json-file");
    assert.equal(hostConfig.LogConfig?.Config?.["max-size"], "10m", "日志轮转 max-size 不是 10m");
    assert.equal(hostConfig.LogConfig?.Config?.["max-file"], "3", "日志轮转 max-file 不是 3");

    // —— 标签（对账的唯一依据）与 token
    assert.equal(labels[LABEL_MANAGED], "true", `缺 ${LABEL_MANAGED} 标签`);
    assert.equal(labels[LABEL_ROLE], "sandbox", `缺 ${LABEL_ROLE}=sandbox 标签`);
    assert.equal(labels[LABEL_SANDBOX_ID], box.sandboxId, `缺 ${LABEL_SANDBOX_ID} 标签`);
    const tokenEntry = ((config.Env ?? []) as string[]).find((item) => item.startsWith("SANDBOX_AGENT_TOKEN="));
    assert.equal(
      tokenEntry,
      `SANDBOX_AGENT_TOKEN=${box.handle.authToken}`,
      "容器 env 里的 agent token 与 handle 上的不一致",
    );
  });
});

smokeGroup("隔离红线 · 资源上限（I7/I8）", { tags: ["isolation"], linuxOnly: true }, () => {
  let box: SmokeSandbox;

  before(async () => {
    box = await SmokeSandbox.create({ label: "iso-limits" });
  });

  after(async () => {
    await box?.destroy();
  });

  test("I7 · 申请超过上限的内存被 OOM kill，容器与 agent 仍存活", async () => {
    // 用 Buffer（V8 之外的内存）而不是数组塞满对象：它更接近"真在申请内存"，
    // 也不会先撞上 V8 的 old-space 上限而变成一个跟 cgroup 无关的失败。
    const result = await box.exec(
      [
        "bash",
        "-c",
        'node -e "const held=[];for(;;)held.push(Buffer.alloc(64*1024*1024,1))"; echo "exit=$?"',
      ],
      { timeoutMs: 60_000 },
    );
    assert.notEqual(result.terminal.event, "timeout", "申请内存的进程没有在时限内被杀——内存上限可能没生效");
    assert.match(
      result.stdout,
      /exit=137/,
      `进程不是被 SIGKILL 带走的（137 = 128+9）：exit=${String(result.exitCode)} stdout=${result.stdout.trim()} stderr=${result.stderr.trim()}`,
    );

    // 容器还活着、agent 还答话：这是"宿主机不受影响"在沙箱侧的可观测形式。
    await waitFor(
      async () => (await box.health()).status === "ready",
      { timeoutMs: 20_000, message: "OOM 之后 agent 没有回到 ready" },
    );
    const alive = await execOk(box, ["bash", "-c", "echo I7-ALIVE"]);
    assert.match(alive.stdout, /I7-ALIVE/);

    // 宿主机侧也确认一遍（Docker daemon 还能正常应答）。
    assert.notEqual((await dockerOrThrow(["version", "--format", "{{.Server.Version}}"])).trim(), "");
  });

  test("I8 · fork 炸弹被 pids-limit 挡下，agent 仍然响应 /health", async () => {
    // 先看上限真的在容器里：cgroup v2 与 v1 两条路径都试一遍。
    const pidsMax = await execOk(box, [
      "bash",
      "-c",
      "cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max 2>/dev/null",
    ]);
    assert.equal(
      pidsMax.stdout.trim(),
      String(SMOKE_LIMITS.pids),
      `容器看不到 pids 上限（或值不对）：得到 ${JSON.stringify(pidsMax.stdout.trim())}`,
    );

    // 经典的 bash fork 炸弹。它的终态不重要（可能 completed 也可能被时限兜住）——
    // 重要的是它没能把容器打穿。
    await box.exec(["bash", "-c", ":(){ :|:& };:"], { timeoutMs: 30_000 });

    await waitFor(
      async () => (await box.health()).status === "ready",
      { timeoutMs: 30_000, message: "fork 炸弹之后 agent 不再响应 /health" },
    );

    // agent 还能真的跑一条新命令（不只是答了 /health）。这里要**重试**：炸弹的余波里
    // 进程表可能还是满的，`/health` 由已存在的 agent 直接答（不用 fork），而新命令要
    // fork——一开始失败、随后恢复，恰好是"上限挡住了攻击、系统没有被打死"的样子。
    await waitFor(
      async () => {
        const probe = await box.exec(["bash", "-c", "echo I8-ALIVE"], { timeoutMs: 30_000 });
        return probe.exitCode === 0 && probe.stdout.includes("I8-ALIVE");
      },
      { timeoutMs: 30_000, intervalMs: 500, message: "fork 炸弹之后沙箱再也起不了新进程" },
    );
  });
});
