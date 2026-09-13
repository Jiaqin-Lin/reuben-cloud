/**
 * Phase 12 · PR 发布层的单元测试（不需要 Docker、不需要网络、不需要 GitHub App）。
 *
 * 这里守的是 spec Phase 12「测试要点」里除端到端之外的全部条目——它们全都是
 * **逻辑**，没有一条需要真的连 GitHub：
 *  2. PR 是 draft（默认）
 *  3. 正文含实数（文件数、+/-、测试结果、transcript 链接）
 *  4. 重复 Run：不产生第二条 PR，attempt 递增（同一条被 PATCH）
 *  5. 权限不足 → 结构化错误（不是字符串）
 *  6. force-with-lease 保护（用真的本地裸仓库验证：第三方动过分支 → 拒绝 + 不建 PR）
 *  7. token 过期 → 流程不中断（每次要 token 都重新取，publishRun 一共取两次）
 *  8. rate limit：mock 403 + retry-after → 等待后重试（sleep 注入，不真睡）
 *
 * 【为什么 push 那条能在单测里跑】`commitAndPush` 面对的"远端"只是一个 git URL。
 * 用一个本地裸仓库当远端，走的就是真的 `git push` 与真的 `ls-remote`（包括 lease 的
 * compare-and-swap），只是没有网络。真正需要 HTTP 远端的是 token 怎么进 argv——那条
 * 红线在 Phase 9 的集成测试里（`startGitHttpServer` 会校验 Authorization 头）。
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { AgentExecOutcome } from "../../src/client/sandbox-api.ts";
import {
  DEFAULT_DRAFT,
  MAX_BODY_FILES,
  OUR_COMMITTER_EMAIL,
  OctokitPullRequestApi,
  PR_BODY_MAX_CHARS,
  assertCleanWorktree,
  buildPullRequestBody,
  findOrCreatePullRequest,
  mapPullRequestError,
  publishRun,
  retryAfterMillis,
  retryOnRateLimit,
  tailForReport,
  verifyInSandbox,
  worktreeStatus,
} from "../../src/repo/pr.ts";
import type {
  CreatePullRequestInput,
  PullRequestApi,
  PullRequestRecord,
  RunVerification,
  UpdatePullRequestInput,
} from "../../src/repo/pr.ts";
import { RepoError } from "../../src/repo/types.ts";
import { GithubAppCredentials } from "../../src/repo/github-app.ts";
import type { RepoApi, RepoRef } from "../../src/repo/types.ts";
import { FakePullRequestApi } from "../support.ts";
import { run } from "../support.ts";

const REF: RepoRef = { owner: "acme", repo: "widgets" };

// ---------------------------------------------------------------- 假 PR API

/** 一条带 `retry-after` 的 403（GitHub 次要限流的标准形状）。 */
function rateLimited(seconds: number): RepoError {
  return new RepoError("pr_rate_limited", "You have exceeded a secondary rate limit", {
    status: 403,
    details: { retryAfterMs: seconds * 1000 },
  });
}

const FAKE_VERIFICATION: RunVerification = {
  cmd: ["npm", "test"],
  state: "completed",
  exitCode: 0,
  passed: true,
  durationMs: 12_300,
  outputTail: "ok",
  truncated: false,
};

describe("Phase 12 · PR 正文（测试要点 3）", () => {
  test("正文含实数：文件数 / +/- / 验证命令与退出码 / transcript 链接 / 模型与 attempt", () => {
    const body = buildPullRequestBody({
      taskTitle: "修 login 用例",
      issue: "第三条用例失败了",
      runId: "run_01ABC",
      attempt: 2,
      model: "deepseek-flash",
      stopReason: "end_turn",
      stopDetail: "模型在第 7 轮正常收工",
      turns: 7,
      toolCalls: 11,
      usage: { inputTokens: 1599, outputTokens: 807, cacheReadInputTokens: 14464, cacheCreationInputTokens: 0 },
      files: [
        { path: "src/login.ts", status: "modified", additions: 12, deletions: 3, binary: false },
        { path: "src/login.test.ts", status: "modified", additions: 4, deletions: 0, binary: false },
      ],
      verification: FAKE_VERIFICATION,
      transcriptUrl: "s3://reuben-cloud/runs/run_01ABC/transcript.jsonl",
      sandboxId: "sbx_01ABC",
    });

    assert.match(body, /2 个文件（\+16 \/ -3）/);
    assert.match(body, /`src\/login\.ts`（modified，\+12\/-3）/);
    assert.match(body, /✅ `npm test` 退出码 0（12\.3s）/);
    assert.match(body, /```\nok\n```/);
    assert.match(body, /模型：`deepseek-flash`/);
    assert.match(body, /（attempt 2）/);
    assert.match(body, /轮数 \/ 工具调用：7 \/ 11/);
    assert.match(body, /transcript：s3:\/\/reuben-cloud\/runs\/run_01ABC\/transcript\.jsonl/);
    assert.match(body, /人工 review/);
  });

  test("验证失败 / 没跑验证 / archive 回退 / 没配对象存储，都如实写", () => {
    const base = {
      taskTitle: "t",
      issue: "i",
      runId: "run_x",
      attempt: 1,
      model: "m",
      stopReason: "end_turn",
      stopDetail: "d",
      turns: 1,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 1, binary: false }],
      sandboxId: null,
    };
    const failed = buildPullRequestBody({
      ...base,
      verification: { ...FAKE_VERIFICATION, passed: false, exitCode: 1, outputTail: "1 failing" },
      transcriptUrl: null,
    });
    assert.match(failed, /❌ `npm test` 退出码 1/);
    assert.match(failed, /1 failing/);
    assert.match(failed, /transcript：未上传（没有配对象存储）/);

    const notRun = buildPullRequestBody({ ...base, verification: null, transcriptUrl: null });
    assert.match(notRun, /没有跑验证命令/);
    assert.match(notRun, /测试结果未知/);

    const fellBack = buildPullRequestBody({
      ...base,
      verification: FAKE_VERIFICATION,
      fallbackReason: "apply_failed",
      transcriptUrl: null,
    });
    assert.match(fellBack, /整棵 workspace 归档（apply_failed）/);
  });

  test("文件清单封顶（超过 50 个只列前 50 个）", () => {
    const many = Array.from({ length: MAX_BODY_FILES + 7 }, (_unused, index) => ({
      path: `src/file-${index}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
    }));
    const body = buildPullRequestBody({
      taskTitle: "t",
      issue: "i",
      runId: "run_x",
      attempt: 1,
      model: "m",
      stopReason: "end_turn",
      stopDetail: "d",
      turns: 1,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      files: many,
      verification: null,
      transcriptUrl: null,
    });
    assert.equal(body.includes("还有 7 个文件"), true);
    assert.equal(body.includes("`src/file-49.ts`"), true);
    assert.equal(body.includes("`src/file-50.ts`"), false, "列出的文件超过了上限");
  });

  test("正文超长时截断（不让 GitHub 的 422 成为建 PR 的失败原因）", () => {
    // 只有文件路径是不受其它上限约束的长字段：50 个 1.4 KB 的路径就足以把正文推过 60k。
    const longDir = "src/" + "very-long-directory-name/".repeat(60);
    const many = Array.from({ length: MAX_BODY_FILES }, (_unused, index) => ({
      path: `${longDir}file-${index}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      binary: false,
    }));
    const body = buildPullRequestBody({
      taskTitle: "t",
      issue: "i".repeat(20_000),
      runId: "run_x",
      attempt: 1,
      model: "m",
      stopReason: "end_turn",
      stopDetail: "d",
      turns: 1,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      files: many,
      verification: null,
      transcriptUrl: null,
    });
    assert.ok(body.length <= PR_BODY_MAX_CHARS, `正文 ${body.length} 字符，超过上限`);
    assert.match(body, /正文超过 GitHub 上限，已截断/);
  });
});

describe("Phase 12 · 幂等建 PR（测试要点 2、4）", () => {
  test("默认 draft，且 head/base 按参数走", async () => {
    const api = new FakePullRequestApi();
    const result = await findOrCreatePullRequest({
      api,
      ref: REF,
      branch: "reuben-cloud/task-1",
      base: "main",
      title: "reuben-cloud: title",
      body: "body",
    });
    assert.equal(result.created, true);
    assert.equal(result.pullRequest.draft, DEFAULT_DRAFT);
    assert.equal(result.pullRequest.base, "main");
    assert.equal(result.pullRequest.head, "acme:reuben-cloud/task-1");
    assert.deepEqual(api.calls, ["list:reuben-cloud/task-1", "create:reuben-cloud/task-1:draft=true"]);
  });

  test("重复 Run：只更新同一条 PR，attempt 递增（不产生第二条）", async () => {
    const api = new FakePullRequestApi();
    const first = await findOrCreatePullRequest({
      api,
      ref: REF,
      branch: "reuben-cloud/task-1",
      base: "main",
      title: "reuben-cloud: title",
      body: "attempt 1",
    });
    const second = await findOrCreatePullRequest({
      api,
      ref: REF,
      branch: "reuben-cloud/task-1",
      base: "main",
      title: "reuben-cloud: title",
      body: "attempt 2",
    });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(api.pullRequests.length, 1, "重复 Run 建出了第二条 PR");
    assert.equal(api.pullRequests[0]!.body, "attempt 2");
    assert.deepEqual(api.calls, [
      "list:reuben-cloud/task-1",
      "create:reuben-cloud/task-1:draft=true",
      "list:reuben-cloud/task-1",
      "update:101",
    ]);
  });

  test("正文一模一样时不发多余的 PATCH；base 变了则更新 base 而不是重建", async () => {
    const api = new FakePullRequestApi();
    await findOrCreatePullRequest({
      api,
      ref: REF,
      branch: "b",
      base: "main",
      title: "t",
      body: "same",
    });
    const noop = await findOrCreatePullRequest({ api, ref: REF, branch: "b", base: "main", title: "t", body: "same" });
    assert.equal(noop.created, false);
    assert.equal(noop.baseUpdated, false);
    assert.equal(api.calls.filter((call) => call.startsWith("update")).length, 0, "无变化时不该发 PATCH");

    const rebased = await findOrCreatePullRequest({ api, ref: REF, branch: "b", base: "release", title: "t", body: "same" });
    assert.equal(rebased.created, false);
    assert.equal(rebased.baseUpdated, true);
    assert.equal(rebased.pullRequest.base, "release");
    assert.equal(api.pullRequests.length, 1, "base 变了也不该重建 PR");
  });
});

describe("Phase 12 · 限流与错误分类（测试要点 5、8）", () => {
  test("retry-after 优先，其次 x-ratelimit-reset，都没有则 null", () => {
    assert.equal(retryAfterMillis({ "retry-after": "30" }), 30_000);
    assert.equal(retryAfterMillis({ "retry-after": 12 }), 12_000);
    assert.equal(retryAfterMillis({ "x-ratelimit-reset": String(1_700_000_100) }, 1_700_000_000_000), 100_000);
    assert.equal(retryAfterMillis({}), null);
  });

  test("403 + retry-after：等待之后重试成功（测试要点 8）", async () => {
    const api = new FakePullRequestApi();
    api.listFailures = [rateLimited(2)];
    const waited: number[] = [];
    const result = await findOrCreatePullRequest({
      api,
      ref: REF,
      branch: "b",
      base: "main",
      title: "t",
      body: "b",
      retry: { sleep: async (ms) => void waited.push(ms), maxRetries: 3 },
    });
    assert.equal(result.created, true);
    assert.deepEqual(waited, [2_000], "没有按 retry-after 等待");
    assert.equal(api.calls.length, 3, "第一次失败 + 第二次成功 + create");
  });

  test("重试用尽之后抛原来的限流错误；等待超过上限则不等（如实报告）", async () => {
    const api = new FakePullRequestApi();
    api.listFailures = [rateLimited(1), rateLimited(1)];
    await assert.rejects(
      findOrCreatePullRequest({
        api,
        ref: REF,
        branch: "b",
        base: "main",
        title: "t",
        body: "b",
        retry: { sleep: async () => undefined, maxRetries: 1 },
      }),
      (error: unknown) => (error as RepoError).reason === "pr_rate_limited",
    );

    const tooLong = new FakePullRequestApi();
    tooLong.listFailures = [rateLimited(9_999)];
    const waited: number[] = [];
    await assert.rejects(
      findOrCreatePullRequest({
        api: tooLong,
        ref: REF,
        branch: "b",
        base: "main",
        title: "t",
        body: "b",
        retry: { sleep: async (ms) => void waited.push(ms), maxWaitMs: 60_000 },
      }),
      (error: unknown) => (error as RepoError).reason === "pr_rate_limited",
    );
    assert.deepEqual(waited, [], "等待超过上限时不该睡下去");
  });

  test("非限流错误不重试（权限不足重试一百次还是权限不足）", async () => {
    const api = new FakePullRequestApi();
    api.createFailures = [
      new RepoError("pr_permission_denied", "installation 缺少 pull_requests:write（403）", {
        status: 403,
        details: { required: { pull_requests: "write" } },
      }),
    ];
    let slept = 0;
    await assert.rejects(
      findOrCreatePullRequest({
        api,
        ref: REF,
        branch: "b",
        base: "main",
        title: "t",
        body: "b",
        retry: { sleep: async () => void (slept += 1) },
      }),
      (error: unknown) => {
        const repoError = error as RepoError;
        assert.equal(repoError.reason, "pr_permission_denied");
        assert.deepEqual(repoError.details["required"], { pull_requests: "write" });
        return true;
      },
    );
    assert.equal(slept, 0, "权限错误不该被当成限流重试");
  });

  test("retryOnRateLimit 只吃 RepoError.pr_rate_limited", async () => {
    let attempts = 0;
    const ok = await retryOnRateLimit(
      async () => {
        attempts += 1;
        if (attempts === 1) throw rateLimited(0);
        return "done";
      },
      { sleep: async () => undefined },
    );
    assert.equal(ok, "done");
    assert.equal(attempts, 2);

    await assert.rejects(
      retryOnRateLimit(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
  });
});

describe("Phase 12 · GitHub 错误分类（测试要点 5）", () => {
  test("mapPullRequestError：404 / 422 / 401 / 403 / 限流 / 网络各归各类", () => {
    const notFound = mapPullRequestError({ status: 404, message: "Not Found" }, REF);
    assert.equal(notFound.reason, "pr_not_found");

    const conflict = mapPullRequestError({ status: 422, message: "Validation Failed" }, REF);
    assert.equal(conflict.reason, "pr_conflict");

    assert.equal(mapPullRequestError({ status: 401, message: "Bad credentials" }, REF).reason, "github_unauthorized");

    const forbidden = mapPullRequestError({ status: 403, message: "Resource not accessible" }, REF);
    assert.equal(forbidden.reason, "pr_permission_denied");
    assert.deepEqual(forbidden.details["required"], { pull_requests: "write" });

    const limited = mapPullRequestError(
      { status: 403, message: "API rate limit exceeded", response: { headers: { "retry-after": "5" } } },
      REF,
    );
    assert.equal(limited.reason, "pr_rate_limited");
    assert.equal(limited.details["retryAfterMs"], 5_000);

    assert.equal(mapPullRequestError({ message: "socket hang up" }, REF).reason, "github_unreachable");
    // 已经是 RepoError 的原样透出（不重复包装）。
    const passthrough = new RepoError("pr_not_found", "x");
    assert.equal(mapPullRequestError(passthrough, REF), passthrough);
  });

  test("OctokitPullRequestApi：字段映射与默认分支（注入假 client，不碰网络）", async () => {
    const calls: string[] = [];
    const client = {
      rest: {
        pulls: {
          list: async (params: Record<string, unknown>) => {
            calls.push(`list:${params["head"]}`);
            return {
              data: [
                {
                  number: 7,
                  html_url: "https://github.com/acme/widgets/pull/7",
                  state: "open",
                  draft: true,
                  title: "t",
                  body: "b",
                  head: { label: "acme:reuben-cloud/x", ref: "reuben-cloud/x" },
                  base: { ref: "main" },
                },
              ],
            };
          },
          create: async (params: Record<string, unknown>) => {
            calls.push(`create:draft=${params["draft"]}`);
            return {
              data: {
                number: 8,
                html_url: "u",
                state: "open",
                draft: params["draft"],
                title: params["title"],
                body: params["body"],
                head: { label: `acme:${String(params["head"])}` },
                base: { ref: String(params["base"]) },
              },
            };
          },
          update: async (params: Record<string, unknown>) => {
            calls.push(`update:${params["pull_number"]}:base=${String(params["base"])}`);
            return {
              data: {
                number: params["pull_number"],
                html_url: "u",
                state: "open",
                draft: true,
                title: "t",
                body: "b",
                head: { label: "acme:b" },
                base: { ref: String(params["base"] ?? "main") },
              },
            };
          },
        },
        repos: {
          get: async () => {
            calls.push("repos.get");
            return { data: { default_branch: "trunk" } };
          },
        },
      },
    };
    const api = new OctokitPullRequestApi({ token: "t", client: client as never });

    const found = await api.listOpenByHead(REF, "reuben-cloud/x");
    assert.equal(found[0]!.number, 7);
    assert.equal(found[0]!.draft, true);
    assert.equal(found[0]!.head, "acme:reuben-cloud/x");

    const created = await api.create(REF, { head: "b", base: "main", title: "T", body: "B", draft: true });
    assert.equal(created.number, 8);
    assert.equal(created.draft, true);

    const updated = await api.update(REF, { number: 7, base: "release" });
    assert.equal(updated.base, "release");

    assert.equal(await api.getDefaultBranch(REF), "trunk");
    assert.deepEqual(calls, ["list:acme:reuben-cloud/x", "create:draft=true", "update:7:base=release", "repos.get"]);
  });

  test("OctokitPullRequestApi：客户端抛错时被翻译成结构化 RepoError", async () => {
    const client = {
      rest: {
        pulls: {
          list: async () => {
            throw { status: 403, message: "Resource not accessible by integration", response: { headers: {} } };
          },
        },
        repos: { get: async () => ({ data: {} }) },
      },
    };
    const api = new OctokitPullRequestApi({ token: "t", client: client as never });
    await assert.rejects(
      api.listOpenByHead(REF, "b"),
      (error: unknown) => {
        assert.equal((error as RepoError).reason, "pr_permission_denied");
        assert.equal((error as RepoError).status, 403);
        return true;
      },
    );
    // 默认分支缺失时不能猜：给一个带 reason 的错误。
    await assert.rejects(api.getDefaultBranch(REF), (error: unknown) => (error as RepoError).reason === "pr_api_error");
  });
});

describe("Phase 12 · 工作区校验与验证命令", () => {
  let root = "";
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "rc-pr-unit-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("worktreeStatus / assertCleanWorktree：干净放行、脏了给结构化错误", async () => {
    const dir = path.join(root, "repo");
    await mkdir(dir, { recursive: true });
    await run(["git", "init", "-q", "--initial-branch", "main"], { cwd: dir });
    assert.equal((await worktreeStatus(dir)).clean, true);
    await assertCleanWorktree(dir);

    await writeFile(path.join(dir, "junk.txt"), "cp temp file\n");
    const dirty = await worktreeStatus(dir);
    assert.equal(dirty.clean, false);
    assert.equal(dirty.entries.some((entry) => entry.includes("junk.txt")), true);
    await assert.rejects(
      assertCleanWorktree(dir),
      (error: unknown) => {
        const repoError = error as RepoError;
        assert.equal(repoError.reason, "dirty_worktree");
        assert.ok(Array.isArray(repoError.details["entries"]));
        return true;
      },
    );
  });

  test("verifyInSandbox：只认「跑完了且退出码 0」；输出取尾部", async () => {
    const outcomes: AgentExecOutcome[] = [
      makeOutcome({ state: "completed", exitCode: 0, stdout: "TAP version 13\nok 1 - works\nok 2\n" }),
      makeOutcome({ state: "completed", exitCode: 1, stdout: "not ok 1\n", stderr: "AssertionError" }),
      makeOutcome({ state: "timeout", exitCode: null, signal: "SIGKILL" }),
    ];
    const api = {
      execAndWait: async (): Promise<AgentExecOutcome> => outcomes.shift()!,
    } as unknown as RepoApi;

    const passed = await verifyInSandbox({ api, target: TARGET, cmd: ["npm", "test"] });
    assert.equal(passed.passed, true);
    assert.equal(passed.exitCode, 0);
    assert.match(passed.outputTail, /ok 2/);

    const failed = await verifyInSandbox({ api, target: TARGET, cmd: ["npm", "test"] });
    assert.equal(failed.passed, false);
    assert.equal(failed.exitCode, 1);
    assert.match(failed.outputTail, /--- stderr ---/);
    assert.match(failed.outputTail, /AssertionError/);

    // 被超时杀掉不是"通过了"：exitCode 是 null，passed 必须是 false。
    const timedOut = await verifyInSandbox({ api, target: TARGET, cmd: ["npm", "test"] });
    assert.equal(timedOut.passed, false);
    assert.equal(timedOut.exitCode, null);
  });

  test("tailForReport：只留最后 N 行，长行被剪", () => {
    const text = Array.from({ length: 50 }, (_unused, index) => `line ${index}`).join("\n");
    const tail = tailForReport(text, { lines: 3 });
    assert.equal(tail, "line 47\nline 48\nline 49");
    assert.equal(tailForReport("x".repeat(1_000)).length, 501);
  });
});

describe("Phase 12 · publishRun 收尾（测试要点 6、7）", () => {
  let root = "";
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "rc-pr-publish-"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("commit → push → PR：token 每次现取（push 一次、PR 一次），lease 用真远端", async () => {
    const { remote, work } = await makeRemoteAndWorktree(root, "happy");
    const api = new FakePullRequestApi();
    let tokenCalls = 0;
    const tokensSeenByFactory: string[] = [];
    // 有东西可提交 (没有改动时 commitAndPush 会抛 nothing_to_commit——那是另一条语义)。
    await writeFile(path.join(work, "src/added.txt"), "brand new\n");

    const result = await publishRun({
      ref: REF,
      dir: work,
      remoteUrl: remote,
      branch: "reuben-cloud/task-happy",
      baseBranch: "main",
      title: "reuben-cloud: 修点东西",
      body: "body",
      token: async () => {
        tokenCalls += 1;
        return `ghs_token_${tokenCalls}`;
      },
      // 用 apiFactory 而不是直接注入 api：这样生产路径上"用新 token 建 PR 客户端"
      // 那一行也会被真的走到（测试要点 7 的形状）。
      apiFactory: (token) => {
        tokensSeenByFactory.push(token);
        return api;
      },
      log: () => undefined,
    });

    assert.equal(result.created, true);
    assert.equal(result.pullRequest.draft, true);
    assert.equal(result.push.branch, "reuben-cloud/task-happy");
    assert.equal(result.push.remoteShaBefore, null);
    assert.equal(result.worktreeClean, true);
    // 测试要点 7 的形状：每次要 token 都重新取（GithubAppCredentials 负责续签），
    // 所以 push 与建 PR 各自拿到一把，中间隔着一次可能很慢的 push。
    assert.equal(tokenCalls, 2, `publishRun 只要了 ${tokenCalls} 次 token`);
    assert.deepEqual(tokensSeenByFactory, ["ghs_token_2"], "PR 客户端用的不是重新签的那把 token");
    // 远端真的有了这条分支，且内容就是工作区里的那份。
    const remoteHead = await lsRemote(remote, "reuben-cloud/task-happy");
    assert.equal(remoteHead, result.push.commitSha);
    const content = await run(["git", "-C", work, "show", "HEAD:src/greet.js"]);
    assert.equal(content.stdout, GREET_FIXED);
  });

  test("token 过期自动重签，发布流程不中断（测试要点 7）", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    let now = 1_700_000_000_000;
    const mints: string[] = [];
    // 一个“TTL 为 0 秒”的凭据：`expires_at` 就是现在、提前续签窗口也是 0，
    // 于是**每一次** tokenFor() 都会重新签发（这正是测试要点 7 要的形状）。
    const credentials = new GithubAppCredentials({
      appId: "1",
      privateKey,
      installationId: "1",
      now: () => now,
      earlyRefreshMs: 0,
      request: async () => {
        mints.push(`ghs_${mints.length + 1}`);
        return {
          data: {
            token: mints.at(-1),
            expires_at: new Date(now).toISOString(),
            permissions: { contents: "write", pull_requests: "write", metadata: "read" },
            repository_selection: "selected",
            repositories: [{ id: 1, name: REF.repo }],
          },
        };
      },
    });

    const { remote, work } = await makeRemoteAndWorktree(root, "ttl");
    await writeFile(path.join(work, "src/ttl.txt"), "change\n");
    now += 60_000;
    const result = await publishRun({
      ref: REF,
      dir: work,
      remoteUrl: remote,
      branch: "reuben-cloud/task-ttl",
      baseBranch: "main",
      title: "t",
      body: "b",
      token: async () => (await credentials.tokenFor(REF)).token,
      // 用 apiFactory（而不是直接注入 api）才会走到"建 PR 前重新取一次 token"那一行。
      apiFactory: () => new FakePullRequestApi(),
      log: () => undefined,
    });
    // push 与 PR 各现签一次：两次都过期 → 两次都重签，但流程一次没重试就完成了。
    assert.equal(result.created, true);
    assert.equal(mints.length, 2, `只签发了 ${mints.length} 次 token`);
  });

  test("远端分支上有别人的提交 → 拒绝覆盖并报告，**不建 PR**（测试要点 6）", async () => {
    const { remote, work } = await makeRemoteAndWorktree(root, "lease");
    const api = new FakePullRequestApi();
    await writeFile(path.join(work, "src/lease.txt"), "first\n");
    // 先成功推一次（我们是这条分支的作者）。
    const first = await publishRun({
      ref: REF,
      dir: work,
      remoteUrl: remote,
      branch: "reuben-cloud/task-lease",
      baseBranch: "main",
      title: "t",
      body: "body",
      token: async () => "ghs_token",
      api,
      log: () => undefined,
    });
    api.calls.length = 0;

    // 第三方（另一个 committer）往远端同一条分支上推了一个 commit。
    const thirdParty = await pushToBranch(remote, "reuben-cloud/task-lease", {
      email: "someone@example.com",
      message: "user's manual commit",
    });
    assert.notEqual(thirdParty, first.push.commitSha);

    // 我们这边再改一次并尝试推：tip 不是我们推的 → 拒绝，远端一个字节不该动。
    await writeFile(path.join(work, "src/lease.txt"), "second\n");
    await assert.rejects(
      publishRun({
        ref: REF,
        dir: work,
        remoteUrl: remote,
        branch: "reuben-cloud/task-lease",
        baseBranch: "main",
        title: "t",
        body: "body",
        token: async () => "ghs_token",
        api,
        log: () => undefined,
      }),
      (error: unknown) => {
        const repoError = error as RepoError;
        assert.equal(repoError.reason, "branch_owned_by_others");
        assert.equal(repoError.details["sha"], thirdParty);
        assert.equal(repoError.details["committerEmail"], "someone@example.com");
        return true;
      },
    );
    assert.deepEqual(api.calls, [], "拒绝覆盖之后还去动了 PR");
    assert.equal(await lsRemote(remote, "reuben-cloud/task-lease"), thirdParty, "被拒的推送动了远端");
  });

  test("归属校验通过但 lease 期望值过时（并发写）→ push 被拒，远端不动", async () => {
    const { remote, work } = await makeRemoteAndWorktree(root, "stale");
    const api = new FakePullRequestApi();
    await writeFile(path.join(work, "src/stale.txt"), "first\n");
    const first = await publishRun({
      ref: REF,
      dir: work,
      remoteUrl: remote,
      branch: "reuben-cloud/task-stale",
      baseBranch: "main",
      title: "t",
      body: "body",
      token: async () => "ghs_token",
      api,
      log: () => undefined,
    });
    api.calls.length = 0;

    // 一个**我们自己身份**的 commit 上了远端（模拟上一次 attempt 的残留，或 CI 的另一条进程）。
    // 归属校验会放行，但显式传入的过时期望值会让 lease 在服务端拒绝。
    const ours = await pushToBranch(remote, "reuben-cloud/task-stale", {
      email: OUR_COMMITTER_EMAIL,
      message: "previous attempt",
    });
    await writeFile(path.join(work, "src/stale.txt"), "second\n");
    await assert.rejects(
      publishRun({
        ref: REF,
        dir: work,
        remoteUrl: remote,
        branch: "reuben-cloud/task-stale",
        baseBranch: "main",
        title: "t",
        body: "body",
        token: async () => "ghs_token",
        api,
        expectedRemoteSha: first.push.commitSha,
        log: () => undefined,
      }),
      (error: unknown) => {
        const repoError = error as RepoError;
        assert.equal(repoError.reason, "push_lease_rejected");
        assert.equal(repoError.details["expected"], first.push.commitSha);
        assert.equal(repoError.details["actual"], ours);
        return true;
      },
    );
    assert.deepEqual(api.calls, []);
    assert.equal(await lsRemote(remote, "reuben-cloud/task-stale"), ours);
  });
});

// ---------------------------------------------------------------- 脚手架

const TARGET = { endpoint: "http://127.0.0.1:1", authToken: "t", sandboxId: "sbx_unit" };
const GREET_FIXED = 'module.exports = () => "fixed";\n';

function makeOutcome(overrides: Partial<AgentExecOutcome>): AgentExecOutcome {
  return {
    executionId: "exe_unit",
    state: "completed",
    exitCode: 0,
    signal: null,
    durationMs: 100,
    stdout: "",
    stderr: "",
    truncated: false,
    logPath: null,
    ...overrides,
  };
}

/** 造一个裸仓库当远端 + 一个 clone 当工作区（初始文件与 Phase 9 的 fixture 同形）。 */
async function makeRemoteAndWorktree(root: string, name: string): Promise<{ remote: string; work: string }> {
  const remote = path.join(root, `${name}-remote.git`);
  const work = path.join(root, `${name}-work`);
  await run(["git", "init", "-q", "--bare", "--initial-branch", "main", remote]);
  await run(["git", "init", "-q", "--initial-branch", "main", work]);
  await mkdir(path.join(work, "src"), { recursive: true });
  await writeFile(path.join(work, "README.md"), "# fixture\n");
  await writeFile(path.join(work, "src/greet.js"), GREET_FIXED);
  await git(work, ["add", "-A"]);
  await git(work, ["commit", "-qm", "initial"]);
  return { remote, work };
}

/**
 * 站在"别人"的位置往远端某条分支上推一个 commit。
 * `email` 决定它是**第三方**（默认，另一个身份）还是"我们自己上一次的推送"（传 bot 邮箱）。
 */
async function pushToBranch(remote: string, branch: string, options: { email: string; message: string }): Promise<string> {
  const scratch = path.join(path.dirname(remote), `other-${Math.random().toString(16).slice(2)}`);
  await run(["git", "clone", "-q", remote, scratch]);
  // 先把工作区切到目标分支（clone 落在默认分支上，直接推过去不是 fast-forward）。
  await git(scratch, ["checkout", "-q", "-B", branch, `origin/${branch}`]);
  await writeFile(path.join(scratch, "other.txt"), `${options.message}\n`);
  await git(scratch, ["add", "-A"]);
  await run(
    [
      "git",
      "-c",
      "user.name=someone",
      "-c",
      `user.email=${options.email}`,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      options.message,
    ],
    { cwd: scratch },
  ).then((result) => {
    if (result.code !== 0) throw new Error(`commit 失败：${result.stderr.trim()}`);
  });
  const sha = (await git(scratch, ["rev-parse", "HEAD"])).trim();
  await git(scratch, ["push", "-q", "--no-verify", "origin", `HEAD:refs/heads/${branch}`]);
  await rm(scratch, { recursive: true, force: true });
  return sha;
}

async function lsRemote(remote: string, branch: string): Promise<string | null> {
  const result = await run(["git", "ls-remote", "--heads", remote, `refs/heads/${branch}`]);
  const sha = result.stdout.trim().split(/\s+/)[0] ?? "";
  return sha === "" ? null : sha;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run(
    ["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd },
  );
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr.trim()}`);
  return result.stdout;
}
