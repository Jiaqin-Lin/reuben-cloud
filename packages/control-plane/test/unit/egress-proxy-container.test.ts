/**
 * Phase 6 单元测试之三：代理容器的创建请求体（**不需要 Docker**）。
 *
 * 与 Phase 5 的 `hardening.test.ts` 同一套分层原则：这里断言"我们**发出去**的请求体"，
 * 集成测试再断言"容器**实际是**什么"。两边都做才有意义——
 * 只有一边的话，"我们发的"和"容器是的"可能不是一回事，而这个差距正好是安全事故的形状。
 *
 * 代理容器是全局唯一的、经过**所有沙箱**流量的那个容器，所以它的加固要求和沙箱一样严：
 * 非 root、只读根、cap-drop ALL、no-new-privileges、不发布任何端口。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PROXY_IMAGE,
  EXTERNAL_NETWORK,
  PROXY_ALLOWLIST_PATH,
  buildProxyContainerRequest,
  resolveLocalImageReference,
} from "../../src/provider/egress-proxy.ts";
import type { DockerClient } from "../../src/provider/docker-api.ts";
import {
  INTERNAL_NETWORK,
  PROXY_CONTAINER_NAME,
  PROXY_PORT,
  ProviderError,
} from "../../src/provider/types.ts";

const ALLOWLIST_HOST_PATH = "/repo/deploy/egress-proxy/allowlist.txt";
const IMAGE_REF = `reuben-cloud/egress-proxy@sha256:${"b".repeat(64)}`;

test("代理容器请求：加固参数逐条对齐 §F.1", () => {
  const body = buildProxyContainerRequest({
    image: IMAGE_REF,
    networkName: INTERNAL_NETWORK,
    allowlistPath: ALLOWLIST_HOST_PATH,
  });

  assert.equal(body.Image, IMAGE_REF);
  assert.equal(body.User, "1000:1000", "非 root");
  assert.equal(body.WorkingDir, "/app");

  const host = body.HostConfig;
  assert.deepEqual(host.CapDrop, ["ALL"], "capability 全丢（监听 3128 不需要任何 capability）");
  assert.equal(host.ReadonlyRootfs, true, "只读根");
  assert.equal(host.Privileged, false, "非特权");
  assert.equal(host.Init, true, "tini 回收僵尸");
  assert.equal(host.Memory, 256 * 1024 * 1024);
  assert.equal(host.MemorySwap, 256 * 1024 * 1024, "swap 不给，否则内存上限形同虚设");
  assert.equal(host.NanoCpus, 500_000_000);
  assert.equal(host.PidsLimit, 256);
  assert.equal(host.NetworkMode, EXTERNAL_NETWORK, "主网络要有出口路由（内网靠 EndpointsConfig 附加）");

  assert.ok(
    host.SecurityOpt.some((item) => item.startsWith("no-new-privileges")),
    `SecurityOpt 里没有 no-new-privileges：${JSON.stringify(host.SecurityOpt)}`,
  );
  assert.equal(
    host.SecurityOpt.some((item) => item.startsWith("seccomp=")),
    false,
    `不允许出现 seccomp=（不写 = Docker 默认 profile）：${JSON.stringify(host.SecurityOpt)}`,
  );

  // 可写点只有 /tmp，而且是 noexec：代理不执行任何东西。
  assert.deepEqual(Object.keys(host.Tmpfs), ["/tmp"]);
  assert.match(host.Tmpfs["/tmp"]!, /size=16m/);
  assert.match(host.Tmpfs["/tmp"]!, /noexec/);
});

test("代理容器请求：绝不发布端口（发布出去 = 绕过白名单的一条路）", () => {
  const body = buildProxyContainerRequest({
    image: IMAGE_REF,
    networkName: INTERNAL_NETWORK,
    allowlistPath: ALLOWLIST_HOST_PATH,
  });
  assert.deepEqual(Object.keys(body.ExposedPorts ?? {}), [`${PROXY_PORT}/tcp`]);
  assert.equal(body.HostConfig.PortBindings, undefined, "代理只能在共用内网上可见");
});

test("代理容器请求：白名单是唯一一处 bind mount，且只读", () => {
  const body = buildProxyContainerRequest({
    image: IMAGE_REF,
    networkName: INTERNAL_NETWORK,
    allowlistPath: ALLOWLIST_HOST_PATH,
  });
  assert.deepEqual(body.HostConfig.Binds, [`${ALLOWLIST_HOST_PATH}:${PROXY_ALLOWLIST_PATH}:ro`]);
  const env = body.Env ?? [];
  assert.ok(env.includes(`EGRESS_PROXY_ALLOWLIST=${PROXY_ALLOWLIST_PATH}`));
  assert.ok(env.includes(`EGRESS_PROXY_PORT=${PROXY_PORT}`));
  assert.ok(env.includes("EGRESS_PROXY_HOST=0.0.0.0"), "容器里必须监听 0.0.0.0 才能被沙箱访问");
});

test("代理容器请求：挂在共用内网上，别名就是沙箱 HTTP_PROXY 里的那个名字", () => {
  const body = buildProxyContainerRequest({
    image: IMAGE_REF,
    networkName: INTERNAL_NETWORK,
    allowlistPath: ALLOWLIST_HOST_PATH,
  });
  // 主网络也必须列出来：只列内网的话容器没有默认路由（Docker 把 NetworkMode 的 "bridge"
  // 当成"没指定"）。这条断言是踩过坑之后加的，见 egress-proxy.ts 文件头。
  assert.deepEqual(body.NetworkingConfig?.EndpointsConfig, {
    [EXTERNAL_NETWORK]: {},
    [INTERNAL_NETWORK]: { Aliases: [PROXY_CONTAINER_NAME] },
  });
  assert.equal(PROXY_CONTAINER_NAME, "reuben-cloud-proxy");
});

test("代理容器请求：标签能让对账认出它（managed + role=egress-proxy，且没有 sandboxId）", () => {
  const body = buildProxyContainerRequest({
    image: IMAGE_REF,
    networkName: INTERNAL_NETWORK,
    allowlistPath: ALLOWLIST_HOST_PATH,
  });
  assert.equal(body.Labels?.["reuben-cloud.managed"], "true");
  assert.equal(body.Labels?.["reuben-cloud.role"], "egress-proxy");
  assert.equal(body.Labels?.["reuben-cloud.sandboxId"], undefined, "代理不是沙箱，不该有 sandboxId 标签");
});

test("代理容器请求：日志轮转 100m × 5（全部出网审计都在这一份里）", () => {
  const body = buildProxyContainerRequest({
    image: IMAGE_REF,
    networkName: INTERNAL_NETWORK,
    allowlistPath: ALLOWLIST_HOST_PATH,
  });
  assert.equal(body.HostConfig.LogConfig.Type, "json-file");
  assert.equal(body.HostConfig.LogConfig.Config["max-size"], "100m");
  assert.equal(body.HostConfig.LogConfig.Config["max-file"], "5");
});

test("resolveLocalImageReference：优先 RepoDigests，其次 Id，404 报 image_not_found", async () => {
  const repoDigest = `reuben-cloud/egress-proxy@sha256:${"c".repeat(64)}`;
  const fromDigests = await resolveLocalImageReference(
    stubDocker({ Id: `sha256:${"d".repeat(64)}`, RepoDigests: ["other/image@sha256:0", repoDigest] }),
    DEFAULT_PROXY_IMAGE,
  );
  assert.equal(fromDigests, repoDigest, "同一个仓库的 RepoDigest 优先");

  const idFallback = `sha256:${"d".repeat(64)}`;
  const fromId = await resolveLocalImageReference(
    stubDocker({ Id: idFallback, RepoDigests: [] }),
    DEFAULT_PROXY_IMAGE,
  );
  assert.equal(fromId, idFallback, "本地构建的镜像常常只有 Id");

  await assert.rejects(
    resolveLocalImageReference(stubDocker(null, 404), DEFAULT_PROXY_IMAGE),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.reason, "image_not_found");
      assert.match(error.message, /build:proxy-image/, "错误信息要告诉人下一步做什么");
      return true;
    },
  );
});

/** 只实现 `json()` 的替身。`resolveLocalImageReference` 只用到这一个方法。 */
function stubDocker(payload: unknown, status = 200): DockerClient {
  return {
    json: async () => {
      if (status !== 200) {
        const { DockerApiError } = await import("../../src/provider/docker-api.ts");
        throw new DockerApiError(status, "/images/x/json", "No such image");
      }
      return payload;
    },
  } as unknown as DockerClient;
}
