/**
 * Phase 5 的集成测试（`npm run test:integration`，**需要 Docker**）。
 *
 * 覆盖 spec「测试要点」那张表的 8 条，外加几条更便宜也更早暴露问题的补充断言
 * （列表与理由见 spec 的 Phase 5 实现备注）。分层的原则与 §0.5 一致：
 * 不变量（发出去的请求体长什么样、endpoint 怎么解析）在 `test/unit/` 里用毫秒级断言守着，
 * 这里只测**真的 Docker 才能回答的问题**：容器真的被加固了吗、失败真的没留垃圾吗、
 * 卷的属主对不对、销毁真幂等吗。
 *
 * 三条自己给自己定的规矩：
 *  1. 每个用例用**自己的 sandboxId**（随机后缀），所以并行跑、或者上一次跑失败留了垃圾，
 *     都不会互相踩。
 *  2. 所有创建出来的资源都登记进 CleanupRegistry，`after()` 里无条件扫一遍——
 *     一次失败的运行不应该给下一次留下"对账要处理的孤儿"。
 *  3. 每个用例结束都断言**没有残留**（标签过滤），泄漏在测试里是断言失败，不是提醒。
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { LocalDockerProvider } from "../../src/provider/local-docker.ts";
import type { SandboxSpec } from "../../src/provider/types.ts";
import {
  ProviderError,
  forwardContainerName,
  sandboxContainerName,
  workspaceVolumeName,
} from "../../src/provider/types.ts";
import {
  CleanupRegistry,
  agentExec,
  containerExists,
  delay,
  dockerAvailable,
  dockerOrThrow,
  leftoversOf,
  newSandboxId,
  rawInspect,
  resolveImageRef,
  volumeExists,
} from "../support.ts";

/** 集成测试跑之前必须能连上 daemon；连不上就直接失败，并说清楚为什么。 */
let imageRef = "";
const cleanup = new CleanupRegistry();

/** 临时造出来的"坏镜像"（CMD 是 sleep 1h）。用例 6 用，跑完删掉。 */
let badImageRef = "";

/** 一个平台的默认 provider。每个用例自己 new，避免用例之间共享状态。 */
function provider(overrides: ConstructorParameters<typeof LocalDockerProvider>[0] = {}): LocalDockerProvider {
  return new LocalDockerProvider(overrides);
}

/** 用例的 spec 工厂：把 sandboxId 之外的一切都钉死，断言才有意义。 */
function specFor(image: string, sandboxId: string, overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image,
    limits: { cpu: 1, memMb: 2048, pids: 2048, diskMb: 4096, ttlSec: 21_600 },
    labels: { sandboxId, runId: `run_${sandboxId}` },
    workspace: { sizeMb: 4096 },
    ...overrides,
  };
}

/** 断言这个 sandboxId 没有留下任何容器/卷。 */
async function assertNoLeftovers(sandboxId: string, context: string): Promise<void> {
  const leftovers = await leftoversOf(sandboxId);
  assert.deepEqual(
    leftovers,
    { containers: [], volumes: [] },
    `${context}：留下了残留（容器 ${leftovers.containers.join(",") || "无"} / 卷 ${leftovers.volumes.join(",") || "无"}）`,
  );
}

before(async () => {
  if (!(await dockerAvailable())) {
    throw new Error(
      "集成测试需要可用的 Docker daemon（npm run test:integration）。dunit 之类的东西不在本阶段范围内。",
    );
  }
  imageRef = await resolveImageRef();
  // 用例 6 要一个"起得来但 agent 不答话"的镜像。用 commit 现造一个，
  // 而不是依赖某个外部镜像——集成测试不该依赖网络。
  const staging = `rc-test-bad-staging-${process.pid}`;
  const image = `rc-test-bad:${process.pid}`;
  await dockerOrThrow(["create", "--name", staging, imageRef, "sleep", "1h"]);
  try {
    await dockerOrThrow(["commit", "--change", 'CMD ["sleep","1h"]', staging, image]);
  } finally {
    await dockerOrThrow(["rm", "-f", staging]);
  }
  cleanup.image(image);
  badImageRef = await resolveImageRef(image);
  // 本地构建/commit 出来的镜像可能带 RepoDigests（containerd 存储会记），也可能只有一个
  // 裸 digest，两者都是合法的 digest 引用——provider 只要求"必须带 @sha256:"。
  assert.match(badImageRef, /^(?:.+@)?sha256:[0-9a-f]{64}$/, `坏镜像的引用形状不对：${badImageRef}`);
});

after(async () => {
  const failed = await cleanup.sweep();
  if (failed.length > 0) console.warn(`清理时有问题（不影响结论，但下一次跑会看到它们）：\n  ${failed.join("\n  ")}`);
});

describe("LocalDockerProvider（集成）", () => {
  test("用例 1：create → health → exec → destroy 全链路", async () => {
    const sandboxId = newSandboxId();
    const local = provider();
    const handle = await local.create(specFor(imageRef, sandboxId, { env: { RC_TEST_MARK: "1" } }));
    cleanup.container(handle.containerName);
    cleanup.volume(handle.volumeName);
    if (process.platform === "darwin") cleanup.container(forwardContainerName(sandboxId));

    try {
      // handle 的形状：endpoint 必须真的能用，token 必须真的是容器里那个。
      assert.match(handle.endpoint, /^http:\/\/[0-9.]+:\d+$/);
      assert.equal(handle.containerName, sandboxContainerName(sandboxId));
      assert.equal(handle.volumeName, workspaceVolumeName(sandboxId));

      // health 直接问 agent（不走 provider），确认 handle 上的 endpoint+token 是对的。
      const health = await local.health(sandboxId);
      assert.equal(health.status, "ready");
      assert.equal(health.activeExecution, null, "空闲时不应该有 active execution");
      assert.equal(health.version, "0.0.1");

      // exec：写进卷、读回来、退出码与两路输出都要对。
      // 注意 `printenv HTTP_PROXY`：**代理变量必须能到子进程**（Phase 5 写这组用例时
      // 发现的缺口，见 sandbox-agent 的 config.ts / spawn.ts）。在 internal 网络里
      // 没有代理就等于没有网络，而这条断言是“Phase 6 会真的生效”的唯一凭据。
      const exec = await agentExec(handle.endpoint, handle.authToken, [
        "bash",
        "-lc",
        "printf 'hello\\n' > /workspace/hello.txt; cat /workspace/hello.txt; echo warn >&2; printenv HTTP_PROXY",
      ]);
      assert.equal(exec.terminal.event, "completed");
      assert.equal(exec.exitCode, 0);
      assert.equal(exec.stdout, "hello\nhttp://reuben-cloud-proxy:3128\n");
      assert.equal(exec.stderr, "warn\n");

      // spec.env 是**容器**环境（agent 自己的 env），不会自动进子进程——
      // 子进程环境是一份固定最小集合 + 代理变量。这里用 docker inspect 确认它到位了，
      // 顺便把这个语义钉下来（免得以后有人以为 spec.env 是给命令用的）。
      const inspect = await rawInspect(handle.providerRef);
      assert.ok(
        (inspect.Config.Env as string[]).includes("RC_TEST_MARK=1"),
        `容器 env 里应该有 spec.env：${JSON.stringify(inspect.Config.Env)}`,
      );
    } finally {
      await local.destroy(sandboxId);
    }
    await assertNoLeftovers(sandboxId, "用例 1 destroy 之后");
  });

  test("用例 2：inspect 断言加固参数（逐条对齐 §F.1）", async () => {
    const sandboxId = newSandboxId();
    const local = provider();
    const handle = await local.create(specFor(imageRef, sandboxId));
    cleanup.container(handle.containerName);
    cleanup.volume(handle.volumeName);
    if (process.platform === "darwin") cleanup.container(forwardContainerName(sandboxId));

    try {
      const inspect = await rawInspect(handle.providerRef);
      const host = inspect.HostConfig as Record<string, unknown>;
      const config = inspect.Config as Record<string, unknown>;

      assert.deepEqual(host.CapDrop, ["ALL"], "capability 全丢");
      assert.equal(host.ReadonlyRootfs, true, "只读根");
      assert.equal(host.Privileged, false, "非特权");
      assert.equal(host.Init, true, "tini 回收僵尸");
      assert.equal(host.Memory, 2048 * 1024 * 1024);
      assert.equal(host.MemorySwap, 2048 * 1024 * 1024, "swap 不给，否则内存上限形同虚设");
      assert.equal(host.NanoCpus, 1_000_000_000);
      assert.equal(host.PidsLimit, 2048);
      assert.equal(host.NetworkMode, "reuben-cloud-internal");
      assert.equal(config.User, "1000:1000");
      assert.equal(inspect.State.Running, true);
      const securityOpt = (host.SecurityOpt ?? []) as string[];
      assert.ok(
        securityOpt.some((item) => item.startsWith("no-new-privileges")),
        `SecurityOpt 里没有 no-new-privileges：${JSON.stringify(securityOpt)}`,
      );
      // seccomp 不能出现在这里：不写 = Docker 默认 profile。写了 unconfined 就等于关掉它。
      assert.equal(
        securityOpt.some((item) => item.startsWith("seccomp=")),
        false,
        `SecurityOpt 里不允许出现 seccomp=：${JSON.stringify(securityOpt)}`,
      );

      // 只读根 + 唯一可写点：/tmp 是 tmpfs，/workspace 是命名卷。
      const tmpfs = host.Tmpfs as Record<string, string>;
      assert.deepEqual(Object.keys(tmpfs), ["/tmp"]);
      assert.match(tmpfs["/tmp"]!, /size=512m/);
      assert.match(tmpfs["/tmp"]!, /mode=1777/);
      // **必须显式带 `exec`**：Docker 会给 tmpfs 默认加上 noexec，而 npm postinstall /
      // node-gyp / python venv 的 console script 都要从 /tmp 执行文件（§F.1 明确不加 noexec）。
      // 这个坑是 Phase 6 的 pip 用例抓到的，断言留在这里防止有人“顺手”去掉。
      assert.match(tmpfs["/tmp"]!, /(^|,)exec(,|$)/, "tmpfs 必须显式 exec，否则 Docker 会加 noexec");
      assert.deepEqual(host.Binds, [`${handle.volumeName}:/workspace`]);

      // 宿主 socket / 宿主命名空间 / bind mount：这几个字段必须都是空/假。
      // 每项都读进局部变量再断言：`assert.equal(host.X, ...)` 会收窄 host.X 的类型，
      // 同一个字段两次对比不同字面量时 tsc 会判定“不可能相等”而报错。
      const pidMode = String(host.PidMode ?? "");
      const ipcMode = String(host.IpcMode ?? "");
      const networkMode = String(host.NetworkMode);
      assert.notEqual(networkMode, "host", "不允许 host 网络命名空间");
      assert.notEqual(pidMode, "host", "不允许 host pid 命名空间");
      assert.notEqual(ipcMode, "host", "不允许 host ipc 命名空间");
      assert.equal(host.Privileged, false);

      // 沙箱容器自己**不发布任何端口**（darwin 的发布在转发容器上）。
      // 注意 Docker 在没设过端口时回的是 `{}` 而不是 null（实测），所以两种都接受。
      assert.deepEqual(Object.keys(host.PortBindings ?? {}), [], "沙箱容器不该有任何端口映射");

      // 标签是对账的唯一依据，必须全。
      const labels = config.Labels as Record<string, string>;
      assert.equal(labels["reuben-cloud.managed"], "true");
      assert.equal(labels["reuben-cloud.sandboxId"], sandboxId);
      assert.equal(labels["reuben-cloud.runId"], `run_${sandboxId}`);
      assert.equal(labels["reuben-cloud.role"], "sandbox");
    } finally {
      await local.destroy(sandboxId);
    }
    await assertNoLeftovers(sandboxId, "用例 2 之后");
  });

  test("用例 3：命名卷的属主是 1000（Dockerfile 里 chown 的兑现）", async () => {
    const sandboxId = newSandboxId();
    const local = provider();
    const handle = await local.create(specFor(imageRef, sandboxId));
    cleanup.container(handle.containerName);
    cleanup.volume(handle.volumeName);
    try {
      // 测试允许用 docker exec 做断言（产品路径不允许——exec 一律走 agent HTTP）。
      const owner = await dockerOrThrow([
        "exec",
        handle.providerRef,
        "stat",
        "-c",
        "%u:%g",
        "/workspace",
      ]);
      assert.equal(owner.trim(), "1000:1000", "卷初始化成 root 的话，uid 1000 什么都写不进去");
    } finally {
      await local.destroy(sandboxId);
    }
    await assertNoLeftovers(sandboxId, "用例 3 之后");
  });

  test("用例 4：create 失败不泄漏（不存在的 digest）", async () => {
    const sandboxId = newSandboxId();
    // pull 预算压到 20s：这个用例要的是"失败得干净"，不是"等 registry 超时"。
    const local = provider({ pullTimeoutMs: 20_000 });
    await assert.rejects(
      local.create(specFor(`reuben-cloud/definitely-not-an-image@sha256:${"0".repeat(64)}`, sandboxId)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, `抛的不是 ProviderError：${String(error)}`);
        // registry 明确拒绝（manifest 不存在）→ image_pull_failed；
        // registry 连不上/卡住 → 拉取预算先到 → image_pull_timeout。
        // 两种都是“拉镜像失败”，测试环境用哪个 registry 都能跑。
        assert.ok(
          error.reason === "image_pull_failed" || error.reason === "image_pull_timeout",
          `原因应该是 image_pull_failed / image_pull_timeout，得到 ${error.reason}`,
        );
        return true;
      },
    );
    await assertNoLeftovers(sandboxId, "用例 4 create 失败之后");
  });

  test("用例 5：destroy 幂等（连调三次都成功）", async () => {
    const sandboxId = newSandboxId();
    const local = provider();
    const handle = await local.create(specFor(imageRef, sandboxId));
    cleanup.container(handle.containerName);
    cleanup.volume(handle.volumeName);

    await local.destroy(sandboxId);
    await local.destroy(sandboxId); // 容器已经不在了：404 要当成功
    await local.destroy(sandboxId); // 卷已经不在了：404 也要当成功

    assert.equal(await containerExists(handle.containerName), false);
    assert.equal(await volumeExists(handle.volumeName), false);
    await assertNoLeftovers(sandboxId, "用例 5 之后");
  });

  test("用例 6：health 超时 → 结构化原因 + 已清理", async () => {
    const sandboxId = newSandboxId();
    // 坏镜像的 CMD 是 sleep 1h，永远不会有 agent 答话。把 15s 的创建预算压到 3s，
    // 让这个用例跑得快一点——测的是"超时后怎么办"，不是"15 秒准不准"。
    const local = provider({ createTimeoutMs: 3_000, healthIntervalMs: 200 });
    await assert.rejects(
      local.create(specFor(badImageRef, sandboxId)),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, `抛的不是 ProviderError：${String(error)}`);
        assert.equal(error.reason, "health_timeout");
        assert.match(String(error.details.endpoint), /^http:\/\//, "失败时也应该带上解析出来的 endpoint");
        return true;
      },
    );
    // 关键断言：失败路径的清理不能靠调用方记得做。
    await assertNoLeftovers(sandboxId, "用例 6 health 超时之后");
  });

  test("用例 7：冷启动计时 + 连做 10 次 create/destroy 无残留", async () => {
    const local = provider();
    const durations: number[] = [];
    const ids: string[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const sandboxId = newSandboxId();
        ids.push(sandboxId);
        const started = Date.now();
        const handle = await local.create(specFor(imageRef, sandboxId));
        durations.push(Date.now() - started);
        cleanup.container(handle.containerName);
        cleanup.volume(handle.volumeName);
        await local.destroy(sandboxId);
      }
    } finally {
      for (const id of ids) await local.destroy(id);
    }

    const sorted = [...durations].sort((left, right) => left - right);
    // p95：n=10 时按"第 10 个"算（k = ceil(0.95 * n)）。样本这么少，它就等于最大值——
    // 这是刻意的：冷启动的目标本来就看最坏情况，平均值会把偶发的慢掩盖掉。
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
    const median = sorted[Math.floor(sorted.length / 2)]!;
    console.log(
      `      冷启动：median=${median}ms p95=${p95}ms（${process.platform}，${sorted.join("/")}）`,
    );
    assert.ok(p95 < 5_000, `create 的 p95 是 ${p95}ms，超过 §J 的 5s 目标：${sorted.join("/")}`);

    for (const id of ids) await assertNoLeftovers(id, "用例 7 之后");
  });

  test("补充：endpoint 真的能通（三个平台分支里跑到的那个）", async () => {
    const sandboxId = newSandboxId();
    const local = provider();
    const handle = await local.create(specFor(imageRef, sandboxId));
    cleanup.container(handle.containerName);
    cleanup.volume(handle.volumeName);
    if (process.platform === "darwin") cleanup.container(forwardContainerName(sandboxId));
    try {
      const response = await fetch(`${handle.endpoint}/health`, {
        headers: { authorization: `Bearer ${handle.authToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(response.status, 200);
      // 没有 token 时必须 401：端点是可达的，但不公开。
      const unauthorized = await fetch(`${handle.endpoint}/health`, { signal: AbortSignal.timeout(5_000) });
      assert.equal(unauthorized.status, 401);

      if (process.platform === "darwin") {
        // darwin 上发布端口的是转发容器，而且只能发布到 127.0.0.1。
        const forwarder = await rawInspect(forwardContainerName(sandboxId));
        const bindings = forwarder.NetworkSettings.Ports["8080/tcp"] as Array<{ HostIp: string }>;
        assert.equal(bindings[0]?.HostIp, "127.0.0.1", "绝不发布到 0.0.0.0");
        // 转发容器跑的是 forward.ts，不是 agent（镜像自带的 ENTRYPOINT 是
        // docker-entrypoint.sh，它只是把 CMD 原样 exec 下去，所以只看 Cmd）。
        assert.equal(forwarder.Config.Cmd[0], "node");
        assert.equal(forwarder.Config.Cmd[1], "src/forward.ts");
      } else {
        // Linux 上沙箱容器直接在内网里，不该有任何端口映射。
        const inspect = await rawInspect(handle.providerRef);
        assert.deepEqual(Object.keys(inspect.HostConfig.PortBindings ?? {}), []);
      }
    } finally {
      await local.destroy(sandboxId);
    }
  });

  test("补充：listManaged / inspect 是对账能用的事实来源", async () => {
    const sandboxId = newSandboxId();
    const local = provider();
    const handle = await local.create(specFor(imageRef, sandboxId));
    cleanup.container(handle.containerName);
    cleanup.volume(handle.volumeName);
    if (process.platform === "darwin") cleanup.container(forwardContainerName(sandboxId));
    try {
      const managed = await local.listManaged();
      const mine = managed.filter((row) => row.sandboxId === sandboxId);
      // darwin 上会有两行：沙箱本体 + 转发容器（role 区分），所以对账必须能分辨它们。
      const expectedRoles = process.platform === "darwin" ? ["port-forward", "sandbox"] : ["sandbox"];
      assert.deepEqual(
        mine.map((row) => row.role).sort(),
        expectedRoles,
        `listManaged 没给出预期的容器：${JSON.stringify(mine)}`,
      );
      const sandboxRow = mine.find((row) => row.role === "sandbox")!;
      assert.equal(sandboxRow.running, true);
      assert.equal(sandboxRow.runId, `run_${sandboxId}`);
      assert.equal(sandboxRow.state, "running");

      const inspection = await local.inspect(sandboxId);
      assert.notEqual(inspection, null);
      assert.equal(inspection?.running, true);
      assert.equal(inspection?.agentStatus, "ready");
      assert.equal(inspection?.activeExecution, null);

      // 空闲时 activeExecution 是 null；跑一条长命令时要能看出"谁占着 BUSY"。
      const accepted = await fetch(`${handle.endpoint}/exec`, {
        method: "POST",
        headers: { authorization: `Bearer ${handle.authToken}`, "content-type": "application/json" },
        body: JSON.stringify({ cmd: ["sleep", "3"], timeoutMs: 10_000 }),
      });
      assert.equal(accepted.status, 202);
      const { execution_id: executionId } = (await accepted.json()) as { execution_id: string };

      const busy = await local.inspect(sandboxId);
      assert.equal(busy?.activeExecution, executionId, "对账靠这个字段判断 CP 重启时有没有执行在跑");

      // 收尾：杀掉它，别让 destroy 等在跑的命令。
      await fetch(`${handle.endpoint}/exec/${executionId}/kill`, {
        method: "POST",
        headers: { authorization: `Bearer ${handle.authToken}` },
      });
      await delay(300);
    } finally {
      await local.destroy(sandboxId);
    }
    // 容器没了 → inspect 返回 null（对账据此转 ERROR），不是抛异常。
    assert.equal(await local.inspect(sandboxId), null);
    await assert.rejects(local.health(sandboxId), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.reason, "not_found");
      return true;
    });
    await assertNoLeftovers(sandboxId, "补充用例之后");
  });

  test("补充：create 撞上自己的残留容器时会删掉重来（CP 崩在 create 中途的形状）", async () => {
    const sandboxId = newSandboxId();
    const local = provider();
    const first = await local.create(specFor(imageRef, sandboxId));
    cleanup.container(first.containerName);
    cleanup.volume(first.volumeName);
    if (process.platform === "darwin") cleanup.container(forwardContainerName(sandboxId));

    // 模拟"上一次 create 之后 CP 崩了"：容器还在，第二次 create 用同一个 sandboxId。
    const second = await local.create(specFor(imageRef, sandboxId));
    try {
      assert.notEqual(second.providerRef, first.providerRef, "应该是一个新容器");
      assert.equal(await containerExists(first.providerRef), false, "旧容器必须被删掉");
      const health = await local.health(sandboxId);
      assert.equal(health.status, "ready");
    } finally {
      await local.destroy(sandboxId);
    }
    await assertNoLeftovers(sandboxId, "补充用例（重建）之后");
  });

  test("补充：名字被别人占用时拒绝，绝不删别人的容器", async () => {
    const sandboxId = newSandboxId();
    const name = sandboxContainerName(sandboxId);
    // 一个"冒名顶替"的容器：名字一样，但没有我们的标签。
    await dockerOrThrow(["create", "--name", name, imageRef, "true"]);
    cleanup.container(name);

    const local = provider();
    await assert.rejects(local.create(specFor(imageRef, sandboxId)), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.reason, "container_exists");
      return true;
    });
    assert.equal(await containerExists(name), true, "别人的容器必须原样留着");
    // 卷已经建好了，所以这里要自己清一下（这正是"回滚"在失败路径上该做的事）。
    await local.destroy(sandboxId).catch(() => {});
  });
});
