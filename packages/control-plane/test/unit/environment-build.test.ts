/**
 * Phase 6 · `build.ts` 的单测（`npm test`，**不需要 docker / PG / 网络**）。
 *
 * 【它证明什么】
 *  ① **错误分类表**对真实日志样本逐条正确（fixture 是从真 docker 输出摘的形态），
 *     并且"两种模式同时出现"时优先级是对的（DNS 失败 → apt 也报看不到包）；
 *  ② **超时真的会杀掉整个进程组**：把 `docker` 换成一个 sleep 脚本，用 150ms 的超时验证
 *     它在睡眠结束前就被杀（脚本里"醒来后写文件"那一步没有发生）；
 *  ③ **构建上下文里只有 Dockerfile**（测试要点 8），且跑完就删；
 *  ④ 日志真的边跑边写到了落点（`FileBuildLogStore` 能读回同一份字节），
 *     落点写不进去**不影响构建结果**（日志是证据，不是产物）；
 *  ⑤ 构建进程的 env 里没有凭据。
 *
 * 【它不替代什么】真 docker 的行为（buildkit 的措辞、iidfile 的形态、镜像真的建出来）
 * 只能由 `test/integration/environment-build.integration.test.ts` 证明；这里用的假 docker
 * 只是一个"会写 iidfile、会睡、会吐日志"的 sh 脚本。
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import {
  buildProcessEnv,
  classifyBuildFailure,
  DockerBuildRunner,
  envBuildLogKey,
  envImageTag,
  FileBuildLogStore,
  logTail,
  prepareBuildContext,
  runProcess,
} from "../../src/environment/build.ts";
import type { BuildLogStore } from "../../src/environment/build.ts";
import { FAKE_DIGEST } from "../environment-fakes.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/build-logs/", import.meta.url));

/** 日志样本 → 期望分类。文件名与期望分类一一对应（另加一个优先级样本）。 */
const CLASSIFICATION_CASES: Array<{ file: string; klass: string; detail: RegExp | null }> = [
  { file: "unknown-base-image.log", klass: "unknown_base_image", detail: /nonexistent-base:99/ },
  { file: "apt-package-missing.log", klass: "apt_package_missing", detail: /libvips42-dev/ },
  { file: "npm-404.log", klass: "npm_404", detail: /left-padx/ },
  { file: "pypi-404.log", klass: "pypi_404", detail: /nonexistent-package-xyz/ },
  { file: "network-timeout.log", klass: "network_timeout", detail: /deb\.debian\.org/ },
  { file: "build-context-error.log", klass: "build_context_error", detail: /package\.json/ },
  { file: "permission-denied.log", klass: "permission_denied", detail: /\/opt\/tools\/marker/ },
  { file: "syntax-error.log", klass: "syntax_error", detail: /第 3 行/ },
  // 同一个日志里既有 DNS 失败又有"看不到包"：必须先报网络（见 build.ts 文件头）。
  { file: "apt-missing-after-dns.log", klass: "network_timeout", detail: /deb\.debian\.org/ },
];

describe("Phase 6 · 错误分类", () => {
  for (const item of CLASSIFICATION_CASES) {
    test(`${item.file} → ${item.klass}`, async () => {
      const log = await readFile(path.join(FIXTURES, item.file), "utf8");
      const failure = classifyBuildFailure({ log });
      assert.equal(failure.klass, item.klass);
      if (item.detail !== null) {
        assert.match(failure.detail ?? "", item.detail, `detail 不对：${JSON.stringify(failure.detail)}`);
      }
      assert.notEqual(failure.advice.trim(), "", "每一类都要有一句可行动的建议");
    });
  }

  test("超时优先于日志内容（build_timeout）", () => {
    const failure = classifyBuildFailure({ log: "E: Unable to locate package x", timedOut: true });
    assert.equal(failure.klass, "build_timeout");
    assert.match(failure.advice, /10 分钟/);
  });

  test("没有可识别的模式时落到 unknown，并带日志最后一行非空内容", () => {
    const failure = classifyBuildFailure({ log: "#1 DONE 0.1s\n\nsomething went very wrong\n\n" });
    assert.equal(failure.klass, "unknown");
    assert.equal(failure.detail, "something went very wrong");
  });

  test("logTail：取尾部 n 行、去掉结尾空行", () => {
    const log = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n") + "\n\n";
    const tail = logTail(log, 3);
    assert.equal(tail, "line-48\nline-49\nline-50");
  });
});

describe("Phase 6 · 命名与上下文", () => {
  test("tag 与日志 key：project_key 里的斜杠与怪字符都被 slug 化（tag 里不能有 /）", () => {
    assert.equal(envImageTag("acme/web", 3), "reuben-cloud/env-acme__web-r3:build");
    assert.equal(envImageTag("local/my repo!", 1), "reuben-cloud/env-local__my__repo-r1:build");
    assert.equal(envBuildLogKey("acme/web", 3, "bld_01H"), "env-logs/acme__web/3/bld_01H.log");
  });

  test("构建上下文里只有 Dockerfile，且能被删掉", async () => {
    const dir = await prepareBuildContext("FROM reuben-cloud/base-node-dev:dev\n");
    assert.deepEqual(await readdir(dir), ["Dockerfile"]);
    assert.equal(await readFile(path.join(dir, "Dockerfile"), "utf8"), "FROM reuben-cloud/base-node-dev:dev\n");
    await rm(dir, { recursive: true, force: true });
    await assert.rejects(stat(dir));
  });

  test("构建进程的 env 里没有凭据（白名单）", () => {
    const env = buildProcessEnv({
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      GITHUB_TOKEN: "ghp_x",
      ANTHROPIC_API_KEY: "sk-x",
      DEEPSEEK_API_KEY: "sk-y",
      HOME: "/root",
    });
    assert.deepEqual(env, { PATH: "/usr/bin", DOCKER_HOST: "unix:///var/run/docker.sock", HOME: "/root" });
  });

  test("FileBuildLogStore：写进去能读回来，越界的 key 直接抛", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rc-env-logs-test-"));
    try {
      const store = new FileBuildLogStore(root);
      const written = await store.put("env-logs/a/1/b.log", Readable.from(["hello\n", "world\n"]));
      assert.equal(written.sizeBytes, 12);
      const text = await readFile(path.join(root, "env-logs/a/1/b.log"), "utf8");
      assert.equal(text, "hello\nworld\n");
      await assert.rejects(store.put("../escape.log", Readable.from(["x"])), /越出/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Phase 6 · 真构建器（用假 docker 脚本跑进程与超时）", () => {
  let dir: string;
  let logDir: string;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "rc-env-fakedocker-"));
    logDir = await mkdtemp(path.join(os.tmpdir(), "rc-env-fakelogs-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(logDir, { recursive: true, force: true });
  });

  /** 造一个假 docker：`body` 是 sh 脚本主体（`$@` 是传给它的参数）。 */
  async function fakeDocker(name: string, body: string): Promise<string> {
    const file = path.join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`, "utf8");
    await chmod(file, 0o755);
    return file;
  }

  /** 假 docker 的公共主体：从参数里认 `--iidfile`、写一个固定 digest、吐两行日志（stderr 也走一遍）。 */
  function fakeDockerBody(): string {
    return [
      'iid=""',
      'prev=""',
      'for arg in "$@"; do if [ "$prev" = "--iidfile" ]; then iid="$arg"; fi; prev="$arg"; done',
      'echo "#6 [2/2] RUN apt-get update"',
      'echo "#6 DONE 0.3s" >&2',
      `printf '%s' "${FAKE_DIGEST}" > "$iid"`,
      "exit 0",
    ].join("\n");
  }

  test("超时：整组被杀，脚本没有机会跑完（marker 不会出现）", async () => {
    const marker = path.join(dir, "marker-timeout");
    const docker = await fakeDocker(
      "docker-sleep.sh",
      `sleep 30\necho done > "${marker}"\nexit 0`,
    );
    const runner = new DockerBuildRunner({ docker, logStore: new FileBuildLogStore(logDir) });
    const startedAt = Date.now();
    const result = await runner.build({
      dockerfile: "FROM reuben-cloud/base-node-dev:dev\n",
      tag: "reuben-cloud/env-test-r1:build",
      logKey: "env-logs/test/1/timeout.log",
      timeoutMs: 150,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.ok(elapsed < 5_000, `超时应该在 150ms 左右生效，实际 ${elapsed}ms`);
    // 等一会儿确认"醒来后写文件"那一步真的没发生（进程组整个被杀，不是只杀了 CLI）。
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(stat(marker), "被杀的脚本不应写 marker");
    assert.equal(classifyBuildFailure({ log: result.log, timedOut: result.timedOut }).klass, "build_timeout");
  });

  test("成功：跑完、拿到 iidfile 里的 digest、日志落到 store 里", async () => {
    const docker = await fakeDocker("docker-ok.sh", fakeDockerBody());
    const store = new FileBuildLogStore(logDir);
    const runner = new DockerBuildRunner({ docker, logStore: store });
    const result = await runner.build({
      dockerfile: "FROM reuben-cloud/base-node-dev:dev\n",
      tag: "reuben-cloud/env-test-r2:build",
      logKey: "env-logs/test/2/ok.log",
    });
    assert.equal(result.ok, true, `errorMessage=${result.errorMessage}`);
    assert.equal(result.imageDigest, FAKE_DIGEST);
    assert.equal(result.logKey, "env-logs/test/2/ok.log");
    // stdout 与 stderr 都被采到（合并成一份日志）。
    assert.match(result.log, /apt-get update/);
    assert.match(result.log, /DONE 0.3s/);
    const persisted = await readFile(path.join(logDir, "env-logs/test/2/ok.log"), "utf8");
    assert.match(persisted, /apt-get update/);
    assert.match(persisted, /DONE 0.3s/);
  });

  test("日志落点写不进去不影响构建结果（log_key 为空 + 一条 warn）", async () => {
    const docker = await fakeDocker("docker-logfail.sh", fakeDockerBody());
    const broken: BuildLogStore = {
      put() {
        return Promise.reject(new Error("MinIO 挂了"));
      },
      get() {
        return Promise.reject(new Error("MinIO 挂了"));
      },
    };
    const warnings: string[] = [];
    const runner = new DockerBuildRunner({
      docker,
      logStore: broken,
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
    });
    const result = await runner.build({
      dockerfile: "FROM reuben-cloud/base-node-dev:dev\n",
      tag: "reuben-cloud/env-test-r3:build",
      logKey: "env-logs/test/3/x.log",
    });
    assert.equal(result.ok, true);
    assert.equal(result.imageDigest, FAKE_DIGEST, "没有日志不代表没有镜像");
    assert.equal(result.logKey, null);
    assert.deepEqual(warnings, ["环境构建日志上传失败（构建结果不受影响）"]);
  });

  test("runProcess：spawn 失败（可执行文件不在）是结果不是异常", async () => {
    const outcome = await runProcess([path.join(dir, "does-not-exist.sh")], { timeoutMs: 1000 });
    assert.notEqual(outcome.spawnError, null);
    assert.equal(outcome.timedOut, false);
  });

  test("FileBuildLogStore.get 能拿回同一份字节（集成测试的读取方式）", async () => {
    const store = new FileBuildLogStore(logDir);
    await store.put("env-logs/test/4/read.log", Readable.from(["abc"]));
    const chunks: Buffer[] = [];
    for await (const chunk of await store.get("env-logs/test/4/read.log")) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "abc");
  });
});
