/**
 * Phase 6 集成测试（`npm run test:integration -w @reuben-cloud/control-plane`，需要 Docker + **外网**）。
 *
 * 覆盖 spec「测试要点」那张表的 12 条。和 Phase 1–5 同一套分层原则：
 * 白名单规则、代理转发、403、字节计数、重载语义在 `test/unit/egress-proxy-*.test.ts` 里
 * 用毫秒级断言守着；这里只回答**只有容器才能回答**的问题——从沙箱里到底能不能出去、
 * 出去的域名长什么样、npm/pip 能不能真装包。
 *
 * 【三条自己给自己定的规矩】
 *  1. 大部分策略用例走一个**本地 origin 容器**（内网别名 `rc-origin-<pid>`），
 *     这样"放行 / 拒绝 / 重载"都不依赖外网；只有 spec 明确要求的"真实装包"用例才出网。
 *  2. 代理容器用生产的名字 `reuben-cloud-proxy`：沙箱里注入的 `HTTP_PROXY` 就是指向它的，
 *     换个名字测的就不是同一条链路了。代价是**测试会短暂接管这台机器上的代理**，
 *     所以 `after()` 一定会用仓库里那份 `deploy/egress-proxy/allowlist.txt` 把它恢复回去。
 *  3. 沙箱、origin 容器、卷全部登记进 CleanupRegistry，断言失败也不会留下垃圾。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { DockerClient, resolveDockerSocketPath } from "../../src/provider/docker-api.ts";
import { EgressProxy } from "../../src/provider/egress-proxy.ts";
import { LocalDockerProvider, ensureInternalNetwork } from "../../src/provider/local-docker.ts";
import type { SandboxHandle } from "../../src/provider/types.ts";
import { INTERNAL_NETWORK, PROXY_CONTAINER_NAME, ProviderError } from "../../src/provider/types.ts";
import {
  CleanupRegistry,
  DEFAULT_PROXY_IMAGE_TAG,
  agentExec,
  docker,
  dockerAvailable,
  dockerOrThrow,
  newSandboxId,
  rawInspect,
  resolveImageRef,
  waitFor,
} from "../support.ts";

const SHIPPED_ALLOWLIST = fileURLToPath(new URL("../../../../deploy/egress-proxy/allowlist.txt", import.meta.url));

/** 本地 origin 的响应体。域名与端口都要能在断言里一眼认出来。 */
const ORIGIN_SCRIPT = `require("http").createServer((req,res)=>{res.setHeader("content-type","text/plain");res.end("ORIGIN "+req.method+" "+req.url)}).listen(8080,"0.0.0.0")`;

let sandboxImageRef = "";
let proxyImageRef = "";
let dockerClient: DockerClient;
let sandboxId = "";
let handle: SandboxHandle;
let originContainer = "";
let originAlias = "";
let originExtraAlias = "";
let allowlistDir = "";
let allowlistPath = "";

const cleanup = new CleanupRegistry();
const provider = new LocalDockerProvider();

/** 拼一份测试用的白名单：仓库里那份 + 本地 origin 别名（**不含** originExtraAlias，重载用例要用它）。 */
function initialAllowlist(): string {
  const shipped = readFileSync(SHIPPED_ALLOWLIST, "utf8");
  return `${shipped}\n# ---- Phase 6 集成测试追加（只在这台测试机上生效）----\n${originAlias}\n`;
}

/** 重载用例用的那份内容：初始清单 + 第二个 origin 别名。 */
function allowlistContentWithExtra(): string {
  return `${initialAllowlist()}\n${originExtraAlias}\n`;
}

/** 原地覆盖白名单文件（bind mount 认 inode，rename 换文件容器里看不到）。 */
function rewriteAllowlist(text: string): void {
  writeFileSync(allowlistPath, text);
}

/** 等容器里那份挂载文件真的变成期望内容（macOS 的 bind mount 有几十毫秒传播延迟）。 */
async function waitForAllowlistVisible(text: string): Promise<void> {
  await waitFor(
    async () => (await dockerOrThrow(["exec", PROXY_CONTAINER_NAME, "cat", "/app/allowlist.txt"])).trim() === text.trim(),
    { timeoutMs: 5_000, message: "容器里看不到新的白名单内容" },
  );
}

/** 在沙箱里跑一次 curl。返回退出码、body 状态码（`%{http_code}`）与 stderr。 */
async function sandboxCurl(
  url: string,
  options: { timeoutSec?: number; extraArgs?: string[] } = {},
): Promise<{ code: number | null; httpCode: string; stderr: string; terminal: string }> {
  const outcome = await agentExec(
    handle.endpoint,
    handle.authToken,
    [
      "curl",
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "--max-time",
      String(options.timeoutSec ?? 25),
      ...(options.extraArgs ?? []),
      url,
    ],
    { timeoutMs: 120_000 },
  );
  return {
    code: outcome.exitCode,
    httpCode: outcome.stdout.trim(),
    stderr: outcome.stderr.trim(),
    terminal: outcome.terminal.event,
  };
}

/** 读代理容器的日志（测试允许用 docker CLI 做断言；产品路径不走这里）。 */
async function proxyLogLines(): Promise<Array<Record<string, unknown>>> {
  const text = await dockerOrThrow(["logs", PROXY_CONTAINER_NAME]);
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error("Phase 6 集成测试需要可用的 Docker daemon（npm run test:integration）。");
  }
  sandboxImageRef = await resolveImageRef();
  proxyImageRef = await resolveImageRef(DEFAULT_PROXY_IMAGE_TAG, "npm run build:proxy-image");

  dockerClient = new DockerClient({ socketPath: resolveDockerSocketPath() });
  // 内网通常已经由 Phase 5 的 provider 建好了；这里直接调同一个实现，幂等。
  await ensureInternalNetwork(dockerClient, INTERNAL_NETWORK);

  // 本地 origin：两个别名，一个进初始名单，一个只在重载用例里加进去。
  const suffix = process.pid.toString(36);
  originContainer = `rc-test-origin-${suffix}`;
  originAlias = `rc-origin-${suffix}`;
  originExtraAlias = `rc-origin-extra-${suffix}`;
  await dockerOrThrow([
    "run",
    "-d",
    "--name",
    originContainer,
    "--network",
    INTERNAL_NETWORK,
    "--network-alias",
    originAlias,
    "--network-alias",
    originExtraAlias,
    sandboxImageRef,
    "node",
    "-e",
    ORIGIN_SCRIPT,
  ]);
  cleanup.container(originContainer);
  await waitFor(async () => (await rawInspect(originContainer)).State.Running === true, {
    message: "本地 origin 容器没有起来",
  });

  allowlistDir = mkdtempSync(join(tmpdir(), "rc-egress-"));
  allowlistPath = join(allowlistDir, "allowlist.txt");
  rewriteAllowlist(initialAllowlist());

  // 起代理。用生产名字：沙箱里注入的 HTTP_PROXY 指向的就是它（见文件头规矩 2）。
  const proxy = new EgressProxy({ allowlistPath, image: proxyImageRef, containerName: PROXY_CONTAINER_NAME });
  const status = await proxy.ensureRunning();
  assert.equal(status.running, true);
  assert.notEqual(status.internalAddress, null, "代理必须拿到内网 IP（否则沙箱找不到它）");

  sandboxId = newSandboxId();
  handle = await provider.create({
    image: sandboxImageRef,
    limits: { cpu: 1, memMb: 2048, pids: 2048, diskMb: 4096, ttlSec: 21_600 },
    labels: { sandboxId, runId: `run_${sandboxId}` },
    workspace: { sizeMb: 4096 },
  });
  cleanup.container(handle.containerName);
  cleanup.volume(handle.volumeName);
});

after(async () => {
  // 把生产代理恢复成仓库里的那份清单（规矩 2）。失败不影响结论，但要说出来。
  try {
    await new EgressProxy({ allowlistPath: SHIPPED_ALLOWLIST, image: proxyImageRef }).ensureRunning();
  } catch (error) {
    console.warn(`恢复生产代理失败（跑 \`npm run proxy:up\`）：${error instanceof Error ? error.message : String(error)}`);
  }
  await provider.destroy(sandboxId).catch(() => {});
  const failed = await cleanup.sweep();
  if (failed.length > 0) console.warn(`清理时有问题：\n  ${failed.join("\n  ")}`);
  if (allowlistDir !== "") rmSync(allowlistDir, { recursive: true, force: true });
});

describe("egress-proxy（集成）", () => {
  test("用例 1：白名单域名可达（registry.npmjs.org）", async () => {
    const result = await sandboxCurl("https://registry.npmjs.org/");
    assert.equal(result.terminal, "completed");
    assert.equal(result.httpCode, "200", `npm registry 应该通：${result.stderr}`);
  });

  test("用例 2：github.com 不可达（§F.2 红线：沙箱不碰 GitHub）", async () => {
    const result = await sandboxCurl("https://github.com/");
    // curl 对 CONNECT 被拒的退出码是 56，stderr 里带 "response 403"。
    assert.notEqual(result.code, 0, "github.com 必须失败");
    assert.match(result.stderr, /403/, `应该是被代理拒绝（403），得到：${result.stderr}`);
    assert.match(result.stderr, /CONNECT/i);
  });

  test("用例 3：CONNECT 到 IP 一律 403（哪怕端口上真有人）", async () => {
    const result = await sandboxCurl("https://1.1.1.1/");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /403/, `IP 直连必须被拒：${result.stderr}`);
  });

  test("用例 4：非白名单域名 403", async () => {
    const result = await sandboxCurl("http://example.com/");
    assert.equal(result.httpCode, "403");
  });

  test("用例 5：大小写与尾点绕过被归一化（防绕过）", async () => {
    // 尾点是最锋利的一条：不归一化时 `rc-origin-xxx.` 不匹配任何规则 → 403。
    const dotted = await sandboxCurl(`http://${originAlias}.:8080/hello`);
    assert.equal(dotted.httpCode, "200", `尾点应该被归一化后放行：${dotted.stderr}`);

    const upper = await sandboxCurl(`http://${originAlias.toUpperCase()}:8080/hello`);
    assert.equal(upper.httpCode, "200", `大小写应该被归一化后放行：${upper.stderr}`);

    // 再确认日志里记的是归一化之后的域名（而不是原样把大写/尾点写进审计）。
    const lines = await proxyLogLines();
    assert.ok(
      lines.some(
        (line) => line.kind === "http" && line.host === originAlias && line.decision === "allow" && line.port === 8080,
      ),
      `日志里应该有归一化后的 ${originAlias}:8080：${JSON.stringify(lines.slice(-5))}`,
    );
  });

  test("用例 6：明文 HTTP 转发（apt 走的这条；deb.debian.org 是 http 源）", async () => {
    const result = await sandboxCurl("http://deb.debian.org/debian/dists/stable/Release");
    assert.equal(result.terminal, "completed");
    assert.equal(result.httpCode, "200", `apt 源应该通：${result.stderr}`);
  });

  test("用例 7：日志里能看到域名、决策、字节数与耗时", async () => {
    const lines = await proxyLogLines();

    const allowed = lines.find(
      (line) => line.kind === "connect" && line.host === "registry.npmjs.org" && line.decision === "allow",
    );
    assert.notEqual(allowed, undefined, "registry.npmjs.org 的放行记录应该在日志里");
    assert.equal(allowed!.port, 443);
    assert.equal(typeof allowed!.in, "number");
    assert.equal(typeof allowed!.out, "number");
    assert.ok((allowed!.out as number) > 0, `出方向字节数应该大于 0：${JSON.stringify(allowed)}`);
    assert.equal(typeof allowed!.ms, "number");
    assert.equal(allowed!.rule, "registry.npmjs.org");
    // 不记录路径与请求体：字段表里只该有这些键。
    assert.equal("path" in allowed!, false);
    assert.equal("body" in allowed!, false);

    for (const host of ["github.com", "example.com"]) {
      const denied = lines.find((line) => line.host === host && line.decision === "deny");
      assert.notEqual(denied, undefined, `${host} 的拒绝记录应该在日志里`);
      assert.equal(denied!.reason, "not_allowlisted");
      assert.equal(denied!.in, 0);
      assert.equal(denied!.out, 0);
    }
    const ipDenied = lines.find((line) => line.decision === "deny" && line.reason === "ip_literal");
    assert.notEqual(ipDenied, undefined, "IP 直连的拒绝理由应该是 ip_literal");
  });

  test("用例 8：真实装包 —— npm install（走代理到 registry.npmjs.org）", async () => {
    const outcome = await agentExec(
      handle.endpoint,
      handle.authToken,
      [
        "bash",
        "-lc",
        // 断言用"能不能 require 到装好的包"，而不是 grep npm 的措辞：npm 的输出会因为
        // 版本不同而变（notice / added N packages / up to date），包在不在才是契约。
        "cd /tmp && rm -rf npmtest && mkdir npmtest && cd npmtest && npm install --no-audit --no-fund left-pad >/dev/null 2>&1 && node -e \"console.log('npm-ok', require('/tmp/npmtest/node_modules/left-pad/package.json').version)\"" 
      ],
      { timeoutMs: 240_000 },
    );
    assert.equal(outcome.terminal.event, "completed");
    assert.equal(outcome.exitCode, 0, `npm install 失败：${outcome.stdout}${outcome.stderr}`);
    assert.match(outcome.stdout, /npm-ok \d+\.\d+/, `left-pad 没有真的装进 workspace：${outcome.stdout}${outcome.stderr}`);
  });

  test("用例 9：真实装包 —— pip install（PyPI 白名单生效）", async () => {
    // 【为什么用 venv 而不是裸 `pip install requests`】Debian 12 的 python3 带
    // PEP 668 的 EXTERNALLY-MANAGED 标记，裸装会被 pip 自己拒绝；而且容器根文件系统是只读的，
    // 系统 site-packages 本来就写不进去。venv 是官方推荐的路径，验证的是同一条出网链路
    // （pypi.org + files.pythonhosted.org），这也是 spec 用例 9 真正想证明的东西。
    const outcome = await agentExec(
      handle.endpoint,
      handle.authToken,
      [
        "bash",
        "-lc",
        'python3 -m venv /tmp/venv && /tmp/venv/bin/pip install --no-cache-dir -q requests && /tmp/venv/bin/python -c "import requests; print(\'pip-ok\', requests.__version__)"',
      ],
      { timeoutMs: 300_000 },
    );
    assert.equal(outcome.terminal.event, "completed");
    assert.equal(outcome.exitCode, 0, `pip install 失败：${outcome.stdout}${outcome.stderr}`);
    assert.match(outcome.stdout, /pip-ok \d+\.\d+/, `pip 的输出不像成功：${outcome.stdout}`);
  });

  test("用例 10：内网没有外部 DNS；代理的服务名能解析", async () => {
    const leaked = await agentExec(handle.endpoint, handle.authToken, ["getent", "hosts", "registry.npmjs.org"]);
    assert.notEqual(leaked.exitCode, 0, "内网不该能解析外部域名（Docker 的内网 DNS 不转发）");

    const proxyDns = await agentExec(handle.endpoint, handle.authToken, ["getent", "hosts", PROXY_CONTAINER_NAME]);
    assert.equal(proxyDns.exitCode, 0, `沙箱必须能用服务名找到代理：${proxyDns.stderr}`);
    assert.match(proxyDns.stdout, /\d+\.\d+\.\d+\.\d+/, `服务名应该解析出内网 IP：${proxyDns.stdout}`);
  });

  test("用例 11：裸 `*` 的白名单在容器里也拒绝启动", async () => {
    const badPath = join(allowlistDir, "allowlist-bad.txt");
    writeFileSync(badPath, "*\n");
    const bad = new EgressProxy({
      allowlistPath: badPath,
      image: proxyImageRef,
      containerName: `rc-test-proxy-bad-${process.pid.toString(36)}`,
    });
    cleanup.container(`rc-test-proxy-bad-${process.pid.toString(36)}`);
    await assert.rejects(bad.ensureRunning(), (error: unknown) => {
      assert.ok(error instanceof ProviderError, `抛的不是 ProviderError：${String(error)}`);
      assert.equal(error.reason, "container_start_failed");
      return true;
    });
    // 注意用 docker() 而不是 dockerOrThrow()：代理的启动失败信息是 console.error 写的，
    // 走的是容器的 stderr 流，`docker logs` 也把它放在 stderr 上。
    const logs = await docker(["logs", `rc-test-proxy-bad-${process.pid.toString(36)}`]);
    const text = `${logs.stdout}${logs.stderr}`;
    assert.match(text, /裸 `\*`/, `日志里要说清楚为什么拒绝启动：${text}`);
  });

  test("用例 12：SIGHUP 重载 —— 加一行后新域名生效", async () => {
    // 重载前：第二个别名不在名单里。
    const before403 = await sandboxCurl(`http://${originExtraAlias}:8080/`);
    assert.equal(before403.httpCode, "403", "重载前应该是 403");

    // 原地追加一行 → HUP → 同一个请求变成 200。
    rewriteAllowlist(allowlistContentWithExtra());
    const proxy = new EgressProxy({ allowlistPath, image: proxyImageRef, containerName: PROXY_CONTAINER_NAME });
    // 写入 → 等容器里真的看见新内容 → 再 HUP。
    // 【为什么必须等】白名单是宿主文件 bind mount 进容器的，容器看到新内容会比宿主写入晚
    // 几十毫秒（Docker Desktop 的 gRPC-FUSE 实测如此，Linux 上是实时的）。不等这一步的话，
    // SIGHUP 会让代理重读到**旧文件**，表现为"重载成功但规则没变"——一个只有 mac 上出现的假失败。
    await waitForAllowlistVisible(allowlistContentWithExtra());
    await proxy.reload();
    let last = "";
    await waitFor(
      async () => {
        const probe = await sandboxCurl(`http://${originExtraAlias}:8080/`);
        if (probe.httpCode === "200") return true;
        // 失败时把代理最近几行日志带上——只一句"还是 403"根本区分不出
        // “没重载”和“重载了但上游连不上”。
        const tail = (await proxyLogLines()).slice(-2);
        last = `${probe.httpCode} ${probe.stderr} ${JSON.stringify(tail)}`;
        return false;
      },
      { timeoutMs: 10_000, message: `重载之后新域名仍然不通（最后一次：${last}）` },
    );

    // 恢复原样，别把状态留给后面的用例（也顺带证明重载是双向的）。
    rewriteAllowlist(initialAllowlist());
    await waitForAllowlistVisible(initialAllowlist());
    await proxy.reload();
    const after403 = await sandboxCurl(`http://${originExtraAlias}:8080/`);
    assert.equal(after403.httpCode, "403", "移掉那一行之后应该重新变成 403");
  });

  test("补充：代理容器本身是加固过的、双网络、不发布端口、别名正确", async () => {
    const inspect = await rawInspect(PROXY_CONTAINER_NAME);
    const host = inspect.HostConfig as Record<string, unknown>;
    const config = inspect.Config as Record<string, unknown>;

    assert.deepEqual(host.CapDrop, ["ALL"]);
    assert.equal(host.ReadonlyRootfs, true);
    assert.equal(host.Privileged, false);
    assert.equal(host.Init, true);
    assert.equal(config.User, "1000:1000");
    assert.equal(host.Memory, host.MemorySwap, "swap 不给，否则内存上限形同虚设");
    assert.equal((host.SecurityOpt as string[]).some((item) => item.startsWith("seccomp=")), false);
    assert.equal((host.LogConfig as { Config: Record<string, string> }).Config["max-size"], "100m");
    // 绝不发布端口：发布出去等于给"绕过白名单"开了一条路（§F.2 已知边界）。
    assert.deepEqual(Object.keys(host.PortBindings ?? {}), []);
    // 白名单是唯一一处 bind mount，只读。
    assert.match(String((host.Binds as string[])[0]), /allowlist.*:ro/);

    const networks = Object.keys((inspect.NetworkSettings as Record<string, any>).Networks);
    assert.ok(networks.includes(INTERNAL_NETWORK), `代理要挂在内网上：${networks}`);
    assert.ok(networks.includes("bridge"), `代理要有出口路由（bridge）：${networks}`);

    // 别名 = 容器名，沙箱的 HTTP_PROXY 才能命中它。
    const networkInfo = JSON.parse(
      await dockerOrThrow(["network", "inspect", INTERNAL_NETWORK, "--format", "{{json .Containers}}"]),
    ) as Record<string, { Name: string }>;
    const entries = Object.values(networkInfo);
    assert.ok(
      entries.some((entry) => entry.Name === PROXY_CONTAINER_NAME),
      `内网上应该能按 ${PROXY_CONTAINER_NAME} 找到代理：${JSON.stringify(entries)}`,
    );

    // ensureRunning 幂等：再调一次不该换容器。
    const proxy = new EgressProxy({ allowlistPath, image: proxyImageRef, containerName: PROXY_CONTAINER_NAME });
    const status = await proxy.ensureRunning();
    assert.equal(status.running, true);
    assert.equal(status.providerRef, inspect.Id, "配置没变时应该复用同一个容器");
    assert.equal(status.internalAddress, inspect.NetworkSettings.Networks[INTERNAL_NETWORK].IPAddress);
  });
});
