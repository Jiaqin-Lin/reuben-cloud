/**
 * Phase 12 · `@live`：对着**真 GitHub** 建一条 PR（默认跳过）。
 *
 * 【它为什么单独一层】这一层要 GitHub App 凭据、要往一个真仓库推分支、会在真仓库里留下
 * 一条 draft PR。它回答的是前两层答不了的那一个问题：**我们发出去的请求，真 GitHub 认不认**
 * ——installation token 有没有 `pull_requests:write`、`POST /pulls` 的字段名对不对、
 * draft 是否真的生效、`PATCH` 能不能改到已存在的那条。
 *
 * 【它为什么不需要沙箱】沙箱那一半在 `test/integration/pr-flow.integration.test.ts` 里
 * 用真容器跑完了；这一层只测"CP ↔ GitHub"那一段，所以它直接在一个真 clone 上改一个文件
 * 然后走 `publishRun()`。少一层，失败时就不用先排除"是不是沙箱的问题"。
 *
 * 【怎么跑】
 *   RUN_LIVE_PR=1 PR_FIXTURE_REPO=owner/name \
 *   GITHUB_APP_ID=... GITHUB_APP_INSTALLATION_ID=... GITHUB_APP_PRIVATE_KEY_PATH=... \
 *   npm run test:live -w @reuben-cloud/control-plane
 *
 * 【它会留下什么】一条 draft PR（分支名固定，重跑是更新同一条）。**故意不自动关掉它**：
 * §Phase 12 的验收就写着"手工看一次 PR：正文如实、draft、分支名正确"，
 * 自动清理反而把那份人工检查的对象删掉了。测试结束会把 PR 链接打出来。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { cloneRepo, removeRunDir } from "../../src/repo/clone.ts";
import { GithubAppCredentials, githubCloneUrl, parseRepoRef } from "../../src/repo/github-app.ts";
import { buildPullRequestBody, publishRun, OctokitPullRequestApi, DEFAULT_DRAFT } from "../../src/repo/pr.ts";
import type { RunVerification } from "../../src/repo/pr.ts";

const enabled = process.env["RUN_LIVE_PR"] === "1";
const repoInput = process.env["PR_FIXTURE_REPO"] ?? "";
const hasKey =
  (process.env["GITHUB_APP_PRIVATE_KEY"] ?? "") !== "" || (process.env["GITHUB_APP_PRIVATE_KEY_PATH"] ?? "") !== "";
const configured =
  enabled &&
  repoInput !== "" &&
  (process.env["GITHUB_APP_ID"] ?? "") !== "" &&
  (process.env["GITHUB_APP_INSTALLATION_ID"] ?? "") !== "" &&
  hasKey;

/** 固定分支：同一个 fixture 仓库重复跑 live 时更新同一条 PR（幂等语义的实测）。 */
const BRANCH = "reuben-cloud/live-smoke";
const MARKER = `live-${randomBytes(4).toString("hex")}`;

let tempRoot = "";
after(async () => {
  if (tempRoot !== "") await rm(tempRoot, { recursive: true, force: true });
});

describe("Phase 12 · live（@live，默认跳过）", () => {
  test(
    "对着真仓库跑一遍：draft PR 建出来，重复跑更新同一条",
    { skip: configured ? false : "需要 RUN_LIVE_PR=1 + PR_FIXTURE_REPO + GITHUB_APP_*" },
    async () => {
      const ref = parseRepoRef(repoInput);
      const credentials = await GithubAppCredentials.fromEnv();
      const defaultBranch = await new OctokitPullRequestApi({
        token: (await credentials.tokenFor(ref)).token,
      }).getDefaultBranch(ref);
      assert.ok(defaultBranch !== "", "GitHub 没有给出默认分支");

      const verification: RunVerification = {
        cmd: ["node", "--version"],
        state: "completed",
        exitCode: 0,
        passed: true,
        durationMs: 30,
        outputTail: "v24",
        truncated: false,
      };

      tempRoot = await mkdtemp(path.join(os.tmpdir(), "rc-pr-live-"));
      const runId = `run_live_pr_${MARKER}`;
      const clone = await cloneRepo({
        runId,
        url: githubCloneUrl(ref),
        commit: defaultBranch,
        token: (await credentials.tokenFor(ref)).token,
        root: tempRoot,
      });

      // 一个确定会变的文件：每次 live 跑都改它，避免 nothing_to_commit。
      const file = path.join(clone.dir, "reuben-cloud-live-smoke.md");
      await writeFile(file, `# reuben-cloud live smoke\n\nmarker: ${MARKER}\n`);

      const body = buildPullRequestBody({
        taskTitle: "live smoke",
        issue: "这是 @live 层自动生成的 PR，用来验证 CP ↔ GitHub 那一段。请忽略并关闭。",
        runId,
        attempt: 1,
        model: "deepseek-flash",
        stopReason: "end_turn",
        stopDetail: "@live 用例（没有跑模型）",
        turns: 1,
        toolCalls: 1,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        files: [{ path: "reuben-cloud-live-smoke.md", status: "added", additions: 3, deletions: 0, binary: false }],
        verification,
        transcriptUrl: null,
        sandboxId: null,
      });

      const first = await publishRun({
        ref,
        dir: clone.dir,
        remoteUrl: githubCloneUrl(ref),
        branch: BRANCH,
        baseBranch: defaultBranch,
        title: "reuben-cloud: live smoke",
        body,
        token: async () => (await credentials.tokenFor(ref)).token,
      });
      assert.equal(first.pullRequest.draft, DEFAULT_DRAFT, "PR 不是 draft");
      assert.equal(first.pullRequest.base, defaultBranch);
      assert.ok(first.pullRequest.number > 0);

      // 第二次：同一分支上再改一次 → 同一条 PR 被更新，**不新建**。
      await writeFile(file, `# reuben-cloud live smoke\n\nmarker: ${MARKER}\nrun: 2\n`);
      const second = await publishRun({
        ref,
        dir: clone.dir,
        remoteUrl: githubCloneUrl(ref),
        branch: BRANCH,
        baseBranch: defaultBranch,
        title: "reuben-cloud: live smoke",
        body: `${body}\n\n（attempt 2）`,
        token: async () => (await credentials.tokenFor(ref)).token,
      });
      assert.equal(second.created, false, "重复跑建出了第二条 PR");
      assert.equal(second.pullRequest.number, first.pullRequest.number);

      console.log(
        `[live-pr] ${first.created ? "新建" : "更新"} draft PR #${second.pullRequest.number}：${second.pullRequest.htmlUrl}\n` +
          `          分支 ${BRANCH} → ${defaultBranch}（手工看一眼正文与 draft 状态）`,
      );

      await removeRunDir(runId, tempRoot).catch(() => undefined);
    },
  );
});
