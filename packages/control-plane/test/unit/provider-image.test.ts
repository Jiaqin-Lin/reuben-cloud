/**
 * Provider 的**镜像解析**单测（`#ensureImage` 的裸镜像 ID 分支）。
 *
 * 落点很小，但它对应 CI 上真的烧过一轮的故障（Phase 7 备注 19）：经典存储
 * （overlay2 / graphdriver）下，本地构建、从未 push 的镜像没有 RepoDigests，
 * `resolveImageRef()` 只能退回镜像 `.Id`（裸 `sha256:<64>`）。这种引用**只可能**命中本地，
 * 所以 provider 的行为必须分成两种：
 *   - 本地命中（200）→ 继续 create（冒烟/CI 的真实链路，由 `npm run smoke` 覆盖）；
 *   - 本地没有（404）→ `image_not_found`，**不能**去 `POST /images/create`：
 *     registry 对裸 ID 的回应必然是一句 invalid reference format，那会把
 *     "本地这份镜像不在了"包装成"拉镜像失败"，把排障指向 registry。
 *
 * 用假 daemon（真的 unix socket HTTP server）而不是 mock，因为这里要断言的正是
 * "到底发出了哪些请求"——一个被 mock 掉的 `DockerClient` 回答不了这个问题。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LocalDockerProvider } from "../../src/provider/local-docker.ts";
import { ProviderError } from "../../src/provider/types.ts";
import { makeSpec, startFakeDaemon } from "../support.ts";

test("裸本地镜像 ID 不在本地：image_not_found，且不去 registry 拉", async () => {
  const daemon = await startFakeDaemon((_req, res) => {
    // 镜像 inspect 是 create 链路里的第一个请求，这里只模拟"本地没有"。
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "No such image" }));
  });
  try {
    const provider = new LocalDockerProvider({ socketPath: daemon.socketPath });
    const bareId = `sha256:${"c".repeat(64)}`;
    await assert.rejects(
      provider.create(makeSpec({ image: bareId })),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError, `抛的不是 ProviderError：${String(error)}`);
        assert.equal(error.reason, "image_not_found");
        assert.match(error.message, /裸镜像 ID 只可能命中本地/);
        return true;
      },
    );
    assert.deepEqual(
      daemon.requests,
      [`GET /v1.44/images/${encodeURIComponent(bareId)}/json`],
      "出现了一个 POST /images/create：裸镜像 ID 不该被拿去 registry 拉",
    );
  } finally {
    await daemon.close();
  }
});
