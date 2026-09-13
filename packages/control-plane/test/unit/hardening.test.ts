/**
 * Provider 层的单元测试第 1 组：**发出去的请求体**里加固参数是否齐全。
 *
 * 【为什么在没有 Docker 的情况下也要测这个】§F.1 那张表是这个方案里最不能出错的一页：
 * 少一个 `CapDrop` 或者多一个 `seccomp=unconfined`，功能测试全绿、隔离红线全红。
 * 这里断言的是**构造出来的请求体**（纯函数，毫秒级），集成测试再断言真容器的 inspect 结果。
 * 两层都要有：只有集成测试的话，在没装 Docker 的机器上（CI 的类型检查、别人的笔记本）
 * 这组不变量就没人守；只有单测的话，"我们发的"和"容器实际是"可能不是一回事。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  LIMIT_MAX_CPU,
  LIMIT_MAX_MEM_MB,
  LIMIT_MAX_PIDS,
  LocalDockerProvider,
  buildForwarderContainerRequest,
  buildHostConfig,
  buildSandboxContainerRequest,
  validateSpec,
} from "../../src/provider/local-docker.ts";
import type { SandboxSpec } from "../../src/provider/types.ts";
import { ProviderError } from "../../src/provider/types.ts";
import { makeSpec } from "../support.ts";

test("加固参数：HostConfig 逐条对齐 §F.1", () => {
  const hostConfig = buildHostConfig({
    networkName: "reuben-cloud-internal",
    memoryMb: 2048,
    nanoCpus: 1_000_000_000,
    pids: 2048,
    binds: ["vol:/workspace"],
    tmpfsMb: 512,
  });

  assert.equal(hostConfig.ReadonlyRootfs, true, "只读根文件系统");
  assert.deepEqual(hostConfig.CapDrop, ["ALL"], "丢弃全部 capability");
  assert.equal(hostConfig.Privileged, false, "永不特权");
  assert.equal(hostConfig.Init, true, "tini 回收僵尸");
  assert.equal(hostConfig.Memory, 2048 * 1024 * 1024);
  assert.equal(hostConfig.MemorySwap, 2048 * 1024 * 1024, "MemorySwap 必须等于 Memory，否则 swap 可用");
  assert.equal(hostConfig.NanoCpus, 1_000_000_000);
  assert.equal(hostConfig.PidsLimit, 2048);
  assert.equal(hostConfig.NetworkMode, "reuben-cloud-internal");
  assert.equal(hostConfig.AutoRemove, false, "AutoRemove 会让失败容器凭空消失，对账就看不到它了");
  assert.deepEqual(hostConfig.Binds, ["vol:/workspace"]);
  assert.deepEqual(hostConfig.RestartPolicy, { Name: "no" });
  assert.deepEqual(hostConfig.LogConfig, {
    Type: "json-file",
    Config: { "max-size": "10m", "max-file": "3" },
  });

  // no-new-privileges 用「以它开头」判断，免得被两种拼法（=true / :true）绊住。
  assert.equal(
    hostConfig.SecurityOpt.some((item) => item.startsWith("no-new-privileges")),
    true,
    "必须阻断 setuid 提权",
  );
  assert.equal(
    hostConfig.SecurityOpt.includes("apparmor=docker-default"),
    true,
    "AppArmor 显式写出，防止被意外关掉",
  );
  // seccomp 这一项**必须不出现**：不传 = 用 Docker 默认 profile。
  // 写了 `seccomp=unconfined` 就是把 §F.1 里"必须确认没被关掉"那一条关掉了。
  assert.equal(
    hostConfig.SecurityOpt.some((item) => item.startsWith("seccomp=")),
    false,
    "不能出现 seccomp=（出现即意味着可能被 unconfined 关掉）",
  );

  // 可写点只有 /tmp 一个，且是 1777（uid 1000 要在里面自建 $HOME）。
  assert.deepEqual(Object.keys(hostConfig.Tmpfs), ["/tmp"]);
  assert.match(hostConfig.Tmpfs["/tmp"]!, /mode=1777/);
  assert.match(hostConfig.Tmpfs["/tmp"]!, /size=512m/);
  // 必须显式写 exec：Docker 会给 tmpfs 默认加 noexec（Phase 6 的 pip 用例踩到过）。
  assert.match(hostConfig.Tmpfs["/tmp"]!, /(^|,)exec(,|$)/);

  // 沙箱容器自己不发布任何端口（darwin 的端口发布在转发容器上）。
  assert.equal(hostConfig.PortBindings, undefined);
});

test("沙箱容器请求：镜像用 digest、用户是 1000、env 里每沙箱一个 token", () => {
  const spec = validateSpec(makeSpec({ env: { CI: "1" } }));
  const request = buildSandboxContainerRequest({
    spec,
    token: "tok_abc",
    volumeName: "reuben-cloud-ws-sbx_x",
    networkName: "reuben-cloud-internal",
    proxyUrl: "http://reuben-cloud-proxy:3128",
  });

  assert.equal(request.Image, spec.image);
  assert.equal(request.User, "1000:1000");
  assert.equal(request.WorkingDir, "/workspace");
  assert.deepEqual(request.Labels, {
    "reuben-cloud.managed": "true",
    "reuben-cloud.sandboxId": "sbx_01HZZZZZZZZZZZZZZZZZZZZZZZ",
    "reuben-cloud.runId": "run_01HZZZZZZZZZZZZZZZZZZZZZZZ",
    "reuben-cloud.role": "sandbox",
  });

  const env = request.Env ?? [];
  assert.ok(env.includes("SANDBOX_AGENT_TOKEN=tok_abc"), "token 通过 env 注入");
  assert.ok(env.includes("HTTP_PROXY=http://reuben-cloud-proxy:3128"));
  assert.ok(env.includes("HTTPS_PROXY=http://reuben-cloud-proxy:3128"));
  assert.ok(env.includes("CI=1"), "spec.env 会被带上");
  assert.ok(
    (env.find((item) => item.startsWith("NO_PROXY=")) ?? "").includes("127.0.0.1"),
    "NO_PROXY 必须含 localhost，否则 agent 自己的探活会被代理掉",
  );
  // 不继承 CP 自己的 process.env：这里出现的每一项都必须是显式写出来的。
  // 7 个固定项（token + 5 个代理变量） + 1 个 spec.env。
  assert.equal(env.length, 7 + 1, `env 数量变了，检查有没有把宿主环境透传进来：${env.join(",")}`);
});

test("转发容器请求：只发布到 127.0.0.1，双网卡，跑的是 forward.ts", () => {
  const spec = validateSpec(makeSpec());
  const request = buildForwarderContainerRequest({
    spec,
    sandboxId: spec.labels.sandboxId,
    networkName: "reuben-cloud-internal",
    targetHost: "reuben-cloud-sbx-sbx_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  });

  assert.deepEqual(request.Cmd, [
    "node",
    "src/forward.ts",
    "--listen",
    "8080",
    "--target",
    "reuben-cloud-sbx-sbx_01HZZZZZZZZZZZZZZZZZZZZZZZ:8080",
  ]);
  assert.deepEqual(request.HostConfig.PortBindings, {
    "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
  });
  assert.equal(request.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(request.HostConfig.CapDrop, ["ALL"]);
  assert.deepEqual(request.HostConfig.Binds, [], "转发容器不挂任何卷");
  assert.equal(request.HostConfig.Memory, 128 * 1024 * 1024);
  // 双网卡：内网（到 agent）+ 默认 bridge（端口发布能生效）。
  assert.deepEqual(Object.keys(request.NetworkingConfig?.EndpointsConfig ?? {}).sort(), [
    "bridge",
    "reuben-cloud-internal",
  ]);
  assert.equal(request.Labels?.["reuben-cloud.role"], "port-forward");
  // 转发容器的 /tmp 不需要执行任何东西。
  assert.match(request.HostConfig.Tmpfs["/tmp"]!, /noexec/);
});

test("spec 校验：逐条拒绝非法输入，且都不碰 Docker", () => {
  const rejects = (spec: SandboxSpec, fragment: string): void => {
    assert.throws(
      () => validateSpec(spec),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, `抛的不是 ProviderError：${String(error)}`);
        assert.equal(error.reason, "invalid_spec");
        assert.match(error.message, new RegExp(fragment));
        return true;
      },
    );
  };

  // tag-only 镜像：tag 可变，"验证过的版本"和"下次跑的版本"无法证明是同一个。
  rejects(makeSpec({ image: "reuben-cloud/sandbox-base:dev" }), "必须带 digest");
  rejects(makeSpec({ image: `${"x"}` }), "必须带 digest");
  // digest 长度不对 / 形状不对。
  rejects(makeSpec({ image: "repo@sha256:abc" }), "必须带 digest");
  // 裸镜像 ID 也不能因为"看起来像本地的"就放行：长度与字符集必须对。
  rejects(makeSpec({ image: `sha256:${"a".repeat(63)}` }), "必须带 digest");
  rejects(makeSpec({ image: `sha256:${"g".repeat(64)}` }), "必须带 digest");

  rejects(makeSpec({ limits: { ...makeSpec().limits, cpu: 0 } }), "limits.cpu");
  rejects(makeSpec({ limits: { ...makeSpec().limits, cpu: LIMIT_MAX_CPU + 1 } }), "limits.cpu");
  rejects(makeSpec({ limits: { ...makeSpec().limits, memMb: 64 } }), "limits.memMb");
  rejects(makeSpec({ limits: { ...makeSpec().limits, memMb: LIMIT_MAX_MEM_MB + 1 } }), "limits.memMb");
  rejects(makeSpec({ limits: { ...makeSpec().limits, pids: LIMIT_MAX_PIDS + 1 } }), "limits.pids");
  rejects(makeSpec({ limits: { ...makeSpec().limits, ttlSec: 5 } }), "limits.ttlSec");

  // 标签会进容器名与卷名，也是对账的唯一依据。
  rejects(makeSpec({ labels: { sandboxId: "", runId: "r" } }), "labels.sandboxId");
  rejects(makeSpec({ labels: { sandboxId: "sbx/a", runId: "r" } }), "labels.sandboxId");
  rejects(makeSpec({ labels: { sandboxId: "sbx", runId: "r x" } }), "labels.runId");

  // env：token 只能由 provider 生成；NUL 会截断 env 值。
  rejects(makeSpec({ env: { SANDBOX_AGENT_TOKEN: "x" } }), "SANDBOX_AGENT_TOKEN");
  rejects(makeSpec({ env: { sandbox_agent_token: "x" } }), "SANDBOX_AGENT_TOKEN");
  rejects(makeSpec({ env: { "BAD KEY": "x" } }), "env 的键不合法");
  rejects(makeSpec({ env: { KEY: "a\0b" } }), "不含 NUL");
});

test("spec 校验：合法输入被放行，env 归一化成空对象", () => {  const clean = validateSpec(makeSpec());
  assert.deepEqual(clean.env, {});
  assert.equal(clean.image, makeSpec().image);

  // 裸本地镜像 ID（经典存储下 `resolveImageRef()` 的兜底形态）也是合法输入：
  // 它和 `repo@sha256:` 一样钉住一个确切镜像，只是没有 registry 名字可拉（Phase 7 备注 19）。
  const bareId = `sha256:${"b".repeat(64)}`;
  assert.equal(validateSpec(makeSpec({ image: bareId })).image, bareId);

  // 边界值：恰好等于上限时要通过（上限是"允许的最大值"，不是"必须小于"）。
  const atLimit = validateSpec(
    makeSpec({ limits: { cpu: LIMIT_MAX_CPU, memMb: LIMIT_MAX_MEM_MB, pids: LIMIT_MAX_PIDS, diskMb: 0, ttlSec: 60 } }),
  );
  assert.equal(atLimit.limits.cpu, LIMIT_MAX_CPU);

  // taskId 可选，给了就进标签。
  const withTask = validateSpec(makeSpec({ labels: { sandboxId: "sbx_x", runId: "run_x", taskId: "task_1" } }));
  assert.equal(withTask.labels.taskId, "task_1");
});

test("DOCKER_HOST 指向远程时构造器直接拒绝（不静默连到别的机器上）", () => {
  const saved = process.env.DOCKER_HOST;
  try {
    process.env.DOCKER_HOST = "tcp://10.0.0.5:2375";
    assert.throws(
      () => new LocalDockerProvider(),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, `抛的不是 ProviderError：${String(error)}`);
        assert.equal(error.reason, "unsupported_docker_host");
        assert.match(error.message, /tcp:\/\/10\.0\.0\.5:2375/);
        return true;
      },
    );
  } finally {
    if (saved === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = saved;
  }
});
