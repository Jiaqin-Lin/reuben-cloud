/**
 * 查这个 GitHub App 装在哪、**installation id 是多少**、权限够不够。
 *
 * 【它解决什么】建完 App 的页面上只有 App ID 与 Client ID，**没有 installation id**——
 * 那个数字要等 App 装到某个账号上才有，而它藏在安装完成后的浏览地址里
 * （`https://github.com/settings/installations/<installation_id>`）。这个脚本用
 * 「App JWT → `GET /app/installations`」把它直接查出来，顺带把权限核对一遍：
 * 少 `pull_requests:write` 时 Phase 12 的 PR 会在第一次调用时才 403，早一步看见便宜得多。
 *
 * 【它不需要 installation id】这正是单独写一个脚本的原因：`GithubAppCredentials` 的
 * 构造需要 installationId（它要缓存到单仓的 token），而这一步只差那一个数字。
 *
 * 【用法】
 *   # 只需 App ID + 私钥（内联 PEM 或 .pem 文件路径）写进仓库根的 .env
 *   npm run app:installations
 *
 * 输出里会直接给出可以粘进 `.env` 的两行；重复跑是幂等的（只读 API，不写任何东西）。
 */

import process from "node:process";
import { createAppAuth } from "@octokit/auth-app";
import { ENV_APP_ID, privateKeyFromEnv } from "../packages/control-plane/src/repo/github-app.ts";

/** API 根。GHES 或测试用 `GITHUB_API_URL` 覆盖；默认公网。 */
const API_BASE = (process.env["GITHUB_API_URL"] ?? "https://api.github.com").replace(/\/+$/, "");

/** 我们要的三个权限（与 `github-app.ts` 的 `GITHUB_APP_PERMISSIONS` 同源）。 */
const REQUIRED_PERMISSIONS: ReadonlyArray<{ key: string; level: string; why: string }> = [
  { key: "contents", level: "write", why: "推分支" },
  { key: "pull_requests", level: "write", why: "建/更新 PR" },
  { key: "metadata", level: "read", why: "GitHub 强制要求（只读仓库元信息）" },
];

interface Installation {
  id: number;
  account: string;
  targetType: string;
  repositorySelection: string;
  permissions: Record<string, string>;
  htmlUrl: string;
}

async function main(): Promise<void> {
  const appId = process.env[ENV_APP_ID] ?? "";
  if (appId === "") {
    throw new Error(`缺 ${ENV_APP_ID}：把它写进仓库根的 .env（npm run app:installations 会自动读）`);
  }

  // 私钥先读+验解析：App ID/私钥不对的话，下面那条 API 只会给一个 401，说不清是哪一样错了。
  const privateKey = await privateKeyFromEnv();
  const auth = createAppAuth({ appId, privateKey });
  const { token: jwt } = await auth({ type: "app" });

  const response = await fetch(`${API_BASE}/app/installations`, {
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "reuben-cloud-scripts",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    const hint =
      response.status === 401
        ? `${ENV_APP_ID} 或私钥不对（401）—— 检查 .env 里的 App ID 与 PEM`
        : response.status === 404
          ? "API 根不对（404）—— 检查 GITHUB_API_URL"
          : `${response.status}`;
    throw new Error(`GET /app/installations 失败：${hint}\n${body}`);
  }

  const installations = ((await response.json()) as unknown[]).map(toInstallation);
  console.log(`✔ 私钥可用（App ID ${appId}），JWT 已签发；共 ${installations.length} 个安装`);
  if (installations.length === 0) {
    console.log(
      `\n这个 App 还没装在任何账号上。去这里装一个（只勾测试用的那个仓库）：\n  ${API_BASE.replace("api.github.com", "github.com")}/settings/apps\n安装完成后的网址里，/settings/installations/<这串数字> 就是 installation id。`,
    );
    return;
  }

  console.log("");
  for (const installation of installations) {
    const missing = REQUIRED_PERMISSIONS.filter(
      (required) => installation.permissions[required.key] !== required.level,
    );
    console.log(`installation_id = ${installation.id}   账号 ${installation.account}（${installation.targetType}）`);
    console.log(`  仓库范围：${installation.repositorySelection}   安装页：${installation.htmlUrl}`);
    console.log(
      `  权限：${REQUIRED_PERMISSIONS.map((required) => `${required.key}=${installation.permissions[required.key] ?? "无"}`).join(" ")}`,
    );
    if (missing.length > 0) {
      console.log(
        `  ⚠️ 缺权限：${missing.map((item) => `${item.key}:${item.level}（${item.why}）`).join("、")}\n` +
          `     去 App 设置里补上（Repository permissions），然后在安装页点一次 "Review request" 批准。`,
      );
    } else {
      console.log("  ✔ 三个权限齐了（contents:write / pull_requests:write / metadata:read）");
    }
    console.log("");
  }

  console.log("把它写进仓库根的 .env（挑一个你实际要用的仓库）：");
  console.log(`GITHUB_APP_ID=${appId}`);
  for (const installation of installations) {
    console.log(`GITHUB_APP_INSTALLATION_ID=${installation.id}`);
  }
  console.log("# 私钥那行你已经配好了（GITHUB_APP_PRIVATE_KEY_PATH 或内联 GITHUB_APP_PRIVATE_KEY），不用改");
  console.log("\n然后：npm run test:live -w @reuben-cloud/control-plane 前加 RUN_LIVE_PR=1 PR_FIXTURE_REPO=owner/name");
}

function toInstallation(raw: unknown): Installation {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const account = typeof record["account"] === "object" && record["account"] !== null ? (record["account"] as Record<string, unknown>) : {};
  return {
    id: typeof record["id"] === "number" ? record["id"] : Number(record["id"] ?? 0),
    account: typeof account["login"] === "string" ? `@${account["login"]}` : "(未知)",
    targetType: typeof record["target_type"] === "string" ? record["target_type"] : "?",
    repositorySelection: typeof record["repository_selection"] === "string" ? record["repository_selection"] : "?",
    permissions:
      typeof record["permissions"] === "object" && record["permissions"] !== null
        ? (record["permissions"] as Record<string, string>)
        : {},
    htmlUrl: typeof record["html_url"] === "string" ? record["html_url"] : "?",
  };
}

await main().catch((error: unknown) => {
  console.error(`\n失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
