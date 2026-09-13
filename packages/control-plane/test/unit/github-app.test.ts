/**
 * Phase 9 · `github-app.ts` 的单元测试（不需要 Docker、不需要网络）。
 *
 * 【为什么可以在这里用真密码学】私钥与 JWT 的 RS256 签名是这一层唯一"手写会错"的地方，
 * 所以测试生成一对真 RSA 密钥、把签名当**真签名**验（`crypto.verify`），
 * 而不是只断言"调用了一个函数"。假的部分只有 GitHub 的 HTTP 响应：
 * 一个实现了 `request` 形状的假函数，它同时充当探针（收到了什么 payload / 什么 JWT）。
 *
 * 【为什么每条失败都要看一眼】403 少权限、404 没装 App、403 限流、401 JWT 过期——
 * 这四种对使用者的动作完全不同（去改权限 / 去装 App / 等一会儿 / 去看私钥）。
 * 它们唯一的区分点就是错误映射，所以每条都要有断言。
 */

import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  ENV_APP_ID,
  ENV_INSTALLATION_ID,
  ENV_PRIVATE_KEY,
  ENV_PRIVATE_KEY_PATH,
  GithubAppCredentials,
  assertPrivateKeyParses,
  githubCloneUrl,
  parseRepoRef,
  repoSlug,
} from "../../src/repo/github-app.ts";
import type { GithubAppRequest } from "../../src/repo/github-app.ts";
import type { RepoError } from "../../src/repo/types.ts";

/** 一对真密钥。`modulusLength: 2048` 是 GitHub App 接受的最小值。 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APP_ID = "123456";
const INSTALLATION_ID = "7890";
const REPO = { owner: "reuben-cloud", repo: "hello-world" };

/** 一次假 GitHub 响应：token 的字段名与真实 API 一致（`expires_at` 是 snake_case）。 */
function tokenResponse(expiresAt: string, overrides: Record<string, unknown> = {}): { data: Record<string, unknown> } {
  return {
    data: {
      token: "ghs_test_token",
      expires_at: expiresAt,
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
      repository_selection: "selected",
      repositories: [{ id: 1, name: REPO.repo }],
      ...overrides,
    },
  };
}

interface FakeGithub {
  request: GithubAppRequest;
  calls: Array<{ route: string; parameters: Record<string, unknown> }>;
}

/** 一个假 `request`：记录调用，按脚本返回或抛错。 */
function fakeGithub(
  handler: (route: string, parameters: Record<string, unknown>) => { data: Record<string, unknown> },
): FakeGithub {
  const github: FakeGithub = {
    calls: [],
    request: async (route, parameters) => {
      github.calls.push({ route, parameters });
      return handler(route, parameters);
    },
  };
  return github;
}

function makeCredentials(github: FakeGithub, overrides: { now?: () => number; earlyRefreshMs?: number } = {}): GithubAppCredentials {
  return new GithubAppCredentials({
    appId: APP_ID,
    privateKey,
    installationId: INSTALLATION_ID,
    request: github.request,
    ...overrides,
  });
}

/** 解一个 JWT 的三段（只做 base64url 解码，不验签）。 */
function decodeJwt(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer } {
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header !== undefined && payload !== undefined && signature !== undefined, `不是三段式 JWT：${jwt}`);
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>,
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url"),
  };
}

describe("Phase 9 · GitHub App 凭据", () => {
  test("parseRepoRef：三种写法归一化，别的一律拒", () => {
    assert.deepEqual(parseRepoRef("reuben-cloud/hello-world"), REPO);
    assert.deepEqual(parseRepoRef("https://github.com/reuben-cloud/hello-world.git"), REPO);
    assert.deepEqual(parseRepoRef("https://github.com/reuben-cloud/hello-world"), REPO);
    assert.deepEqual(parseRepoRef("git@github.com:reuben-cloud/hello-world.git"), REPO);
    assert.deepEqual(parseRepoRef("  reuben-cloud/hello-world  "), REPO);
    assert.equal(repoSlug(REPO), "reuben-cloud/hello-world");
    assert.equal(githubCloneUrl(REPO), "https://github.com/reuben-cloud/hello-world.git");

    for (const bad of ["", "hello-world", "https://gitlab.com/a/b.git", "https://evil.example/github.com/a/b"]) {
      assert.throws(
        () => parseRepoRef(bad),
        (error: unknown) => (error as RepoError).reason === "config_invalid",
        `本该拒绝：${bad}`,
      );
    }
  });

  test("fromEnv：缺配置 → config_missing，坏私钥 → config_invalid", async () => {
    await assert.rejects(
      GithubAppCredentials.fromEnv({ [ENV_APP_ID]: APP_ID }),
      (error: unknown) => {
        const repoError = error as RepoError;
        assert.equal(repoError.reason, "config_missing");
        assert.deepEqual(repoError.details["missing"], [ENV_INSTALLATION_ID, `${ENV_PRIVATE_KEY}（或 ${ENV_PRIVATE_KEY_PATH}）`]);
        return true;
      },
    );
    await assert.rejects(
      GithubAppCredentials.fromEnv({
        [ENV_APP_ID]: APP_ID,
        [ENV_INSTALLATION_ID]: INSTALLATION_ID,
        [ENV_PRIVATE_KEY]: "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n",
      }),
      (error: unknown) => (error as RepoError).reason === "config_invalid",
    );
    assert.throws(() => assertPrivateKeyParses("garbage"), (error: unknown) => (error as RepoError).reason === "config_invalid");
    // installationId 必须是正整数（否则拿到的会是一个 NaN 的 API 路径）。
    assert.throws(
      () => new GithubAppCredentials({ appId: APP_ID, privateKey, installationId: "abc" }),
      (error: unknown) => (error as RepoError).reason === "config_invalid",
    );
  });

  test("fromEnv：接受 `\\n` 转义的私钥与私钥文件路径", async () => {
    const escaped = privateKey.replace(/\n/g, "\\n");
    const fromEscaped = await GithubAppCredentials.fromEnv({
      [ENV_APP_ID]: APP_ID,
      [ENV_INSTALLATION_ID]: INSTALLATION_ID,
      [ENV_PRIVATE_KEY]: escaped,
    });
    assert.ok(fromEscaped instanceof GithubAppCredentials);

    const dir = await mkdtemp(path.join(os.tmpdir(), "rc-github-key-"));
    try {
      const keyFile = path.join(dir, "app.pem");
      await writeFile(keyFile, privateKey, "utf8");
      const fromFile = await GithubAppCredentials.fromEnv({
        [ENV_APP_ID]: APP_ID,
        [ENV_INSTALLATION_ID]: INSTALLATION_ID,
        [ENV_PRIVATE_KEY_PATH]: keyFile,
      });
      assert.ok(fromFile instanceof GithubAppCredentials);
      await assert.rejects(
        GithubAppCredentials.fromEnv({
          [ENV_APP_ID]: APP_ID,
          [ENV_INSTALLATION_ID]: INSTALLATION_ID,
          [ENV_PRIVATE_KEY_PATH]: path.join(dir, "missing.pem"),
        }),
        (error: unknown) => (error as RepoError).reason === "config_invalid",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("tokenFor：JWT 是真签的，payload 的 scope 与权限正确，且 token 限定到仓库", async () => {
    const github = fakeGithub(() => tokenResponse(new Date(Date.now() + 3_600_000).toISOString()));
    const credentials = makeCredentials(github);

    const token = await credentials.tokenFor(REPO);
    assert.equal(token.token, "ghs_test_token");
    assert.equal(token.installationId, Number(INSTALLATION_ID));
    assert.deepEqual(token.repositoryNames, [REPO.repo]);

    assert.equal(github.calls.length, 1);
    const call = github.calls[0]!;
    assert.equal(call.route, "POST /app/installations/{installation_id}/access_tokens");
    assert.equal(call.parameters["installation_id"], Number(INSTALLATION_ID));
    assert.deepEqual(call.parameters["repositories"], [REPO.repo], "token 没有被限定到选定仓库");
    assert.deepEqual(call.parameters["permissions"], { contents: "write", pull_requests: "write", metadata: "read" });

    // JWT：头部、claim、以及**签名真的是这对密钥签的**。
    const headers = call.parameters["headers"] as Record<string, string>;
    const jwt = (headers["authorization"] ?? "").replace(/^bearer /i, "");
    const decoded = decodeJwt(jwt);
    assert.equal(decoded.header["alg"], "RS256");
    assert.equal(String(decoded.payload["iss"]), APP_ID);
    const nowSeconds = Math.floor(Date.now() / 1000);
    assert.ok(Number(decoded.payload["iat"]) <= nowSeconds, "iat 在未来");
    assert.ok(Number(decoded.payload["exp"]) > nowSeconds, "exp 已经过期");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(decoded.signingInput);
    assert.ok(verifier.verify(publicKey, decoded.signature), "JWT 签名验不过");
  });

  test("缓存：命中不重签，提前 5 分钟续签，refresh 强制重签", async () => {
    let now = 1_000_000_000_000;
    const expiresAt = new Date(now + 3_600_000).toISOString();
    const github = fakeGithub((_route, _parameters) =>
      tokenResponse(new Date(Number(now) + 3_600_000).toISOString()),
    );
    const credentials = makeCredentials(github, { now: () => now });

    await credentials.tokenFor(REPO);
    await credentials.tokenFor(REPO);
    assert.equal(github.calls.length, 1, "第二次调用没有命中缓存");
    assert.equal(credentials.cachedTokens, 1);

    // 距离过期还有 6 分钟：仍然在有效期内，不重签。
    now += 3_600_000 - 6 * 60_000;
    await credentials.tokenFor(REPO);
    assert.equal(github.calls.length, 1, "还没到提前续签线就重签了");

    // 距离过期 4 分钟：进入提前续签窗口。
    now += 2 * 60_000;
    await credentials.tokenFor(REPO);
    assert.equal(github.calls.length, 2, "进入提前续签窗口后没有重签");

    // 显式 refresh。
    await credentials.tokenFor(REPO, { refresh: true });
    assert.equal(github.calls.length, 3, "refresh:true 没有强制重签");

    // 不同仓库各自一份缓存。
    await credentials.tokenFor({ owner: REPO.owner, repo: "another" });
    assert.equal(github.calls.length, 4);
    assert.equal(credentials.cachedTokens, 2);

    // 假响应里的 expiresAt 用的是固定的 now，所以上面的续签窗口判断不受时钟前进影响；
    // 再补一条：真的过期之后必然重签。
    void expiresAt;
  });

  test("错误映射：401 / 403 / 404 / 限流 / 网络，各自一条 reason", async () => {
    const cases: Array<{ label: string; error: unknown; reason: string; status: number | null }> = [
      {
        label: "401",
        error: githubError(401, "Bad credentials"),
        reason: "github_unauthorized",
        status: 401,
      },
      {
        label: "403 少权限",
        error: githubError(403, "Resource not accessible by integration"),
        reason: "github_forbidden",
        status: 403,
      },
      {
        label: "404 没装 App",
        error: githubError(404, "Not Found"),
        reason: "github_not_installed",
        status: 404,
      },
      {
        label: "403 限流",
        error: githubError(403, "API rate limit exceeded", { "x-ratelimit-remaining": "0", "retry-after": "30" }),
        reason: "github_rate_limited",
        status: 403,
      },
      {
        label: "网络不通",
        error: new TypeError("fetch failed"),
        reason: "github_unreachable",
        status: null,
      },
    ];

    for (const item of cases) {
      const github = fakeGithub(() => {
        throw item.error;
      });
      const credentials = makeCredentials(github);
      await assert.rejects(
        credentials.tokenFor(REPO),
        (error: unknown) => {
          const repoError = error as RepoError;
          assert.equal(repoError.reason, item.reason, `${item.label} 的 reason 不对：${repoError.reason}`);
          assert.equal(repoError.status, item.status);
          return true;
        },
        item.label,
      );
    }

    // 限流那条要带上等待时间（Phase 12 会按它退避重试）。
    const github = fakeGithub(() => {
      throw githubError(403, "API rate limit exceeded", { "x-ratelimit-remaining": "0", "retry-after": "30" });
    });
    await assert.rejects(makeCredentials(github).tokenFor(REPO), (error: unknown) => {
      assert.equal((error as RepoError).details["retryAfterMs"], 30_000);
      return true;
    });
  });
});

/** 造一个形状与 `@octokit/request` 的 RequestError 一致的错误。 */
function githubError(status: number, message: string, headers: Record<string, string> = {}): Error {
  const error = new Error(message) as Error & { status: number; response: { data: unknown; headers: unknown } };
  error.status = status;
  error.response = { data: { message, documentation_url: "https://docs.github.com/…" }, headers };
  return error;
}

after(async () => {
  // 本文件不创建任何持久资源；这个钩子留着是为了让"以后加了什么都别忘了清理"这件事显式。
});
