/**
 * Phase 10 的纯函数单测（`npm test`，**不需要 Docker / MinIO**）。
 *
 * 【为什么这几条值得单独测】`artifactStoreConfigFromEnv()` 的失败模式只有两种，
 * 但都很贵：
 *  - "一个都没给"必须给 null（否则每个没配对象存储的部署都会在启动时炸）；
 *  - "给了一半"必须立刻报错。半份配置的后果是**第一次上传时才失败**——而那一刻
 *    沙箱已经在等销毁了，错误发生在离原因最远的地方。
 * 这两条在没有 MinIO 的机器上也测得了，所以放在这一层。
 *
 * 【为什么也测 key 布局】它是 CP 与"将来读这些对象的人"（Phase 12 的 Run 结果、
 * 排障时的 `mc ls`）之间的约定，改一个字都是在改协议。放一条断言在这里，
 * 比让两处代码各记得一份便宜。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactKey } from "../../src/artifacts/offload.ts";
import { ArtifactStoreError, artifactStoreConfigFromEnv, artifactStoreFromEnv } from "../../src/artifacts/store.ts";

const REQUIRED = {
  S3_ENDPOINT: "http://127.0.0.1:9000",
  S3_BUCKET: "reuben-cloud",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
};

test("配置：四个 env 齐全 → 一份带缺省的配置", () => {
  const config = artifactStoreConfigFromEnv({ ...REQUIRED });
  assert.ok(config !== null);
  assert.equal(config.endpoint, REQUIRED.S3_ENDPOINT);
  assert.equal(config.bucket, REQUIRED.S3_BUCKET);
  assert.equal(config.accessKeyId, "key");
  assert.equal(config.secretAccessKey, "secret");
  // 缺省值本身就是协议的一部分：MinIO 不校验 region、且需要 path-style。
  assert.equal(config.region, "us-east-1");
  assert.equal(config.forcePathStyle, true);
});

test("配置：可选 env 能覆盖 region 与 path-style（只有显式 false 才关）", () => {
  const config = artifactStoreConfigFromEnv({ ...REQUIRED, S3_REGION: "ap-northeast-1", S3_FORCE_PATH_STYLE: "false" });
  assert.ok(config !== null);
  assert.equal(config.region, "ap-northeast-1");
  assert.equal(config.forcePathStyle, false);
  // 拼错的写法不该被当成 false：那会让 MinIO 的路由方式被一个手滑的开关换掉。
  const misspelled = artifactStoreConfigFromEnv({ ...REQUIRED, S3_FORCE_PATH_STYLE: "nope" });
  assert.equal(misspelled?.forcePathStyle, true);
});

test("配置：一个 env 都没给 → null（合法的『没有对象存储』部署）", () => {
  assert.equal(artifactStoreConfigFromEnv({}), null);
  assert.equal(artifactStoreFromEnv({}), null);
  // 空串视同没给（compose / CI 里常见的 `S3_BUCKET=`）。
  assert.equal(artifactStoreConfigFromEnv({ S3_ENDPOINT: "", S3_BUCKET: "" }), null);
});

test("配置：只给了一部分 → config_missing，并把缺的名字列出来", () => {
  assert.throws(
    () => artifactStoreConfigFromEnv({ S3_ENDPOINT: REQUIRED.S3_ENDPOINT, S3_BUCKET: REQUIRED.S3_BUCKET }),
    (error: unknown) =>
      error instanceof ArtifactStoreError &&
      error.reason === "config_missing" &&
      JSON.stringify(error.details.missing) === JSON.stringify(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]),
  );
});

test("配置：齐全时能从 env 建出 store（这一步不碰网络）", () => {
  const store = artifactStoreFromEnv({ ...REQUIRED });
  assert.ok(store !== null);
  assert.equal(store.bucket, REQUIRED.S3_BUCKET);
  store.close();
});

test("key 布局：一次 Run 的产出都落在 runs/<runId>/ 下", () => {
  assert.equal(artifactKey.diff("run_1"), "runs/run_1/diff.patch");
  assert.equal(artifactKey.archive("run_1", "sbx_1"), "runs/run_1/workspace-sbx_1.tar.gz");
  assert.equal(artifactKey.execLog("run_1", "exe_1"), "runs/run_1/exec/exe_1.log");
  assert.equal(artifactKey.transcript("run_1"), "runs/run_1/transcript.jsonl");
  // 归档必须带 sandboxId：同一次 Run 换沙箱重跑时，两份归档不是同一件东西。
  assert.notEqual(artifactKey.archive("run_1", "sbx_1"), artifactKey.archive("run_1", "sbx_2"));
});
