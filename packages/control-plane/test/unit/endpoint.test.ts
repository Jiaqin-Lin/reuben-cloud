/**
 * `resolveEndpoint()` 的单测（spec 测试要点第 8 条）。
 *
 * 它是**唯一一处平台差异**：Linux 读容器 IP，darwin 读发布到宿主的端口。
 * 把它做成纯函数，就是为了能拿两份真实的 inspect JSON 直接喂进来——
 * 不用起容器、不用两台机器，就能证明"两个平台解析出来的都是对的"。
 *
 * 下面两份 JSON 是**从真实容器上抄下来的形状**（只留我们读的字段）：
 *  - Linux：容器在 `reuben-cloud-internal` 上有 IP，没有任何端口发布
 *  - darwin：转发容器发布到 `127.0.0.1` 的随机端口
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveEndpoint } from "../../src/provider/local-docker.ts";
import type { DockerContainerInspect } from "../../src/provider/docker-api.ts";

/** Linux 上的沙箱容器：只在内网上有地址，没有发布端口。 */
const linuxInspect: DockerContainerInspect = {
  Id: "c0ffee",
  Name: "/reuben-cloud-sbx-sbx_1",
  NetworkSettings: {
    Networks: {
      "reuben-cloud-internal": { IPAddress: "172.22.0.3", Gateway: "" },
    },
    Ports: {},
  },
};

/** darwin 上的转发容器：没有内网地址（在 NetworkSettings 里也是有的），发布了一个随机端口。 */
const darwinInspect: DockerContainerInspect = {
  Id: "beef",
  Name: "/reuben-cloud-sbx-sbx_1-fwd",
  NetworkSettings: {
    Networks: {
      bridge: { IPAddress: "172.17.0.2", Gateway: "172.17.0.1" },
      "reuben-cloud-internal": { IPAddress: "172.22.0.4", Gateway: "" },
    },
    Ports: {
      "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49218" }],
    },
  },
};

test("Linux：直接走内网 IP，不发布端口", () => {
  const result = resolveEndpoint(linuxInspect, {
    platform: "linux",
    networkName: "reuben-cloud-internal",
    port: 8080,
  });
  assert.deepEqual(result, { ok: true, endpoint: "http://172.22.0.3:8080" });
});

test("darwin：走宿主回环上的发布端口", () => {
  const result = resolveEndpoint(darwinInspect, {
    platform: "darwin",
    networkName: "reuben-cloud-internal",
    port: 8080,
  });
  assert.deepEqual(result, { ok: true, endpoint: "http://127.0.0.1:49218" });
});

test("Linux：容器不在目标网络上 → 失败，而不是回退到别的地址", () => {
  const result = resolveEndpoint(
    { ...linuxInspect, NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.2" } } } },
    { platform: "linux", networkName: "reuben-cloud-internal", port: 8080 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "container_ip_missing");
});

test("darwin：没有发布端口 → 失败（internal 网络上的容器不会自动发布）", () => {
  const result = resolveEndpoint(
    { ...darwinInspect, NetworkSettings: { ...darwinInspect.NetworkSettings, Ports: { "8080/tcp": [] } } },
    { platform: "darwin", networkName: "reuben-cloud-internal", port: 8080 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "published_port_missing");
  assert.match(result.ok === false ? result.detail : "", /没有发布/);
});

test("darwin：发布到 0.0.0.0 → 拒绝（绝不把 agent 暴露到局域网上）", () => {
  const result = resolveEndpoint(
    {
      ...darwinInspect,
      NetworkSettings: {
        ...darwinInspect.NetworkSettings,
        Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "49218" }] },
      },
    },
    { platform: "darwin", networkName: "reuben-cloud-internal", port: 8080 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "unsafe_host_ip");
});

test("darwin：空 HostPort 的绑定被跳过（Docker 可能给一条占位）", () => {
  const result = resolveEndpoint(
    {
      ...darwinInspect,
      NetworkSettings: {
        ...darwinInspect.NetworkSettings,
        Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }, { HostIp: "127.0.0.1", HostPort: "50000" }] },
      },
    },
    { platform: "darwin", networkName: "reuben-cloud-internal", port: 8080 },
  );
  assert.deepEqual(result, { ok: true, endpoint: "http://127.0.0.1:50000" });
});
