/**
 * exec 请求的校验与归一化（**不需要 Docker、不需要 Postgres**）。
 *
 * 【为什么这一层值得有自己的单测】`validateExecRequest()` 是 CP 侧的 400 语义：
 * 它决定了"什么样的请求根本不该发到沙箱去"。它是纯函数，所以这些断言是毫秒级的，
 * 而它们保护的两条规矩都写在 spec 里：
 *  · `timeoutMs > 600_000` **拒绝，不静默截断**（§C.2 的硬上限；静默截断会让调用方
 *    以为自己拿到了 30 分钟）。
 *  · `envKeys` 是**唯一**从 env 派生的东西——值不进 DB（§G.2）。这个测试同时盯住
 *    "派生的 key 集合是排序去重的字符串数组"，因为它是写进 `executions` 列的东西。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  SandboxManagerError,
  imageDigestOf,
  validateExecRequest,
} from "../../src/manager/sandbox-manager.ts";

/** 断言被拒，并且 reason（而不是错误字符串）是 invalid_request。 */
function assertInvalid(request: Parameters<typeof validateExecRequest>[0], field?: string): void {
  assert.throws(
    () => validateExecRequest(request),
    (error: unknown) => {
      assert.ok(error instanceof SandboxManagerError, `期望 SandboxManagerError，实际 ${String(error)}`);
      assert.equal(error.reason, "invalid_request");
      if (field !== undefined) assert.equal(error.details["field"], field);
      return true;
    },
  );
}

describe("validateExecRequest", () => {
  test("缺省值：timeoutMs 120s、cwd 不传、env 为空、envKeys 为空", () => {
    const clean = validateExecRequest({ cmd: ["npm", "test"] });
    assert.deepEqual(clean.cmd, ["npm", "test"]);
    assert.equal(clean.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS);
    assert.equal(clean.cwd, null);
    assert.deepEqual(clean.env, {});
    assert.deepEqual(clean.envKeys, []);
    assert.equal(clean.maxOutputBytes, undefined);
  });

  test("env 的值保留在 env 里，但派生的 envKeys 只有 key（且排序）", () => {
    const clean = validateExecRequest({
      cmd: ["true"],
      env: { HTTP_PROXY: "http://reuben-cloud-proxy:3128", CI: "1" },
    });
    assert.deepEqual(clean.envKeys, ["CI", "HTTP_PROXY"]);
    assert.equal(clean.env["HTTP_PROXY"], "http://reuben-cloud-proxy:3128");
  });

  test("cmd：非数组 / 空数组 / 非字符串元素 / 含 NUL 一律拒", () => {
    assertInvalid({ cmd: "npm test" as unknown as string[] }, "cmd");
    assertInvalid({ cmd: [] }, "cmd");
    assertInvalid({ cmd: ["ok", 42 as unknown as string] }, "cmd");
    assertInvalid({ cmd: ["a\0b"] }, "cmd");
    // 空字符串是合法 argv（`echo ""` 那种用法），不该被拒
    assert.deepEqual(validateExecRequest({ cmd: ["echo", ""] }).cmd, ["echo", ""]);
  });

  test("timeoutMs：越界的三个方向都拒，边界值放行", () => {
    assert.equal(validateExecRequest({ cmd: ["true"], timeoutMs: MAX_EXEC_TIMEOUT_MS }).timeoutMs, MAX_EXEC_TIMEOUT_MS);
    assert.equal(validateExecRequest({ cmd: ["true"], timeoutMs: 1 }).timeoutMs, 1);
    assertInvalid({ cmd: ["true"], timeoutMs: MAX_EXEC_TIMEOUT_MS + 1 }, "timeoutMs");
    assertInvalid({ cmd: ["true"], timeoutMs: 0 }, "timeoutMs");
    assertInvalid({ cmd: ["true"], timeoutMs: 1.5 }, "timeoutMs");
    assertInvalid({ cmd: ["true"], timeoutMs: Number.NaN }, "timeoutMs");
  });

  test("cwd 与 maxOutputBytes：形状不对就拒，不猜", () => {
    assert.equal(validateExecRequest({ cmd: ["true"], cwd: "/workspace/repo" }).cwd, "/workspace/repo");
    assertInvalid({ cmd: ["true"], cwd: "" }, "cwd");
    assertInvalid({ cmd: ["true"], cwd: "/workspace\0evil" }, "cwd");
    assertInvalid({ cmd: ["true"], maxOutputBytes: 0 }, "maxOutputBytes");
    assertInvalid({ cmd: ["true"], maxOutputBytes: 1024.5 }, "maxOutputBytes");
    assert.equal(validateExecRequest({ cmd: ["true"], maxOutputBytes: 1024 }).maxOutputBytes, 1024);
  });

  test("env 的值必须是字符串（不做隐式 toString）", () => {
    assertInvalid({ cmd: ["true"], env: { PORT: 8080 as unknown as string } }, "env");
  });
});

describe("imageDigestOf", () => {
  test("`repo@sha256:…` 取 @ 之后的部分；裸镜像 ID 原样返回", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    assert.equal(imageDigestOf(`reuben-cloud/sandbox-base@${digest}`), digest);
    assert.equal(imageDigestOf(digest), digest);
    // registry 端口是唯一可能出现第二个 `:` 的地方：`host:5000/repo@sha256:…`
    assert.equal(imageDigestOf(`registry.local:5000/repo@${digest}`), digest);
  });
});
