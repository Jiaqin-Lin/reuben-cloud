/**
 * GitHub App 凭据：签发**限定到单个仓库**的 installation token，并在 CP 进程内缓存。
 *
 * 【这一层的三条规矩，都是 §F.3 的落地】
 *  1. 私钥只在 CP 进程内（env / secret manager）。启动时就检查它能被解析——
 *     "缺私钥"必须在进程起来的那一刻暴露，而不是等到第一次 clone 才炸。
 *  2. token 的作用域由 `repositoryNames: [repo]` 限定到选定仓库，权限只要三个
 *     （contents:write / pull_requests:write / metadata:read）。多给一个权限，
 *     一次注入的收益就大一分。
 *  3. token **只在内存里**：这里返回字符串，`git.ts` 把它变成一次性 argv。
 *     没有一处把它写进文件、URL、日志或沙箱。
 *
 * 【缓存为什么自己写而不是用 @octokit/auth-app 的】spec §1 要求"提前 5 分钟过期"，
 * 而 auth-app 内置的缓存是"过期前 1 分钟"（`toad-cache`，59 分钟）。两者差 4 分钟，
 * 而在一次跑十几分钟的任务里，那 4 分钟正好是"push 的时候 token 刚过期"的概率来源。
 * 所以：auth-app 只负责签（JWT 的 RS256 与 access_tokens 请求由它做），
 * 缓存、提前续签、按仓库分键由这里管——也让"TTL 调成 0 秒会自动重签"这条可测。
 *
 * 【为什么 installationId 从 env 来，不做 installation 查找】MVP 只有一个 App、
 * 一个安装（§0.2 的边界：不做多租户）。少一条 API 路径就少一类 404 需要处理；
 * Phase 12 要按仓库自动发现时再补。
 */

import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createAppAuth } from "@octokit/auth-app";
import type { StrategyOptions } from "@octokit/auth-app";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { RepoError } from "./types.ts";
import type { RepoRef } from "./types.ts";

// ---------------------------------------------------------------- 常量

export const ENV_APP_ID = "GITHUB_APP_ID";
export const ENV_INSTALLATION_ID = "GITHUB_APP_INSTALLATION_ID";
export const ENV_PRIVATE_KEY = "GITHUB_APP_PRIVATE_KEY";
export const ENV_PRIVATE_KEY_PATH = "GITHUB_APP_PRIVATE_KEY_PATH";

/** 需要的三个权限。`metadata:read` 是 GitHub 强制的，不是我们想要的。 */
export const GITHUB_APP_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
};

/** 提前多久续签。spec §1：提前 5 分钟。 */
export const TOKEN_EARLY_REFRESH_MS = 5 * 60_000;

/**
 * 关掉 @octokit/auth-app 自带的缓存。空字符串在它那边就是"没有缓存"
 * （`if (!result) return;`），所以这就是一个诚实的 null cache。
 */
const NO_CACHE = {
  get: (): string => "",
  set: (_key: string, _value: string): string => "",
};

/**
 * 注入给 @octokit/auth-app 的 request。`@octokit/request` 的真实形状比这个宽，
 * 我们只声明自己用到的部分——单元测试的假 GitHub 就是这个形状。
 */
export type GithubAppRequest = (
  route: string,
  parameters: Record<string, unknown>,
) => Promise<{ data: Record<string, unknown> }>;

/** 一次 installation token。字段与 GitHub 的响应一一对应（少一个都不行：Phase 12 要看 expiresAt）。 */
export interface InstallationToken {
  token: string;
  createdAt: Date;
  expiresAt: Date;
  installationId: number;
  permissions: Record<string, string>;
  /** `selected` 时 `repositoryNames` 是这次 token 能访问的仓库名单。 */
  repositorySelection: string;
  repositoryNames: string[];
}

export interface GithubAppOptions {
  appId: string | number;
  /** PEM 文本（不是路径；路径在 `fromEnv` 里被读掉）。 */
  privateKey: string;
  installationId: string | number;
  /** 注入 request（测试用）。默认走 api.github.com。 */
  request?: GithubAppRequest;
  /** 注入时钟（测试 TTL 用）。 */
  now?: () => number;
  earlyRefreshMs?: number;
  log?: LogFn;
}

// ---------------------------------------------------------------- 仓库引用

const SLUG_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const SCP_PATTERN = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * 把用户给的仓库引用归一成 `{owner, repo}`。接受三种写法：
 *  - `owner/repo`（产品界面里最常见的那种）
 *  - `https://github.com/owner/repo(.git)`
 *  - `git@github.com:owner/repo(.git)`（从 git clone 那边粘过来的）
 *
 * 只认 github.com：MVP 不做 GitLab（§Phase 9 边界），而"看起来像 URL 就接受"
 * 会让一个 typosquat/内网地址悄悄变成 token 的发送目标。
 */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input.trim();
  if (trimmed === "") throw new RepoError("config_invalid", "仓库引用为空");

  const scp = SCP_PATTERN.exec(trimmed);
  if (scp !== null) return { owner: scp[1]!, repo: scp[2]! };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new RepoError("config_invalid", `仓库 URL 解析不了：${trimmed}`);
    }
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
      throw new RepoError("config_invalid", `只支持 github.com 的仓库，收到 ${url.hostname}`, {
        details: { host: url.hostname },
      });
    }
    const repo = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    const slug = SLUG_PATTERN.exec(repo);
    if (slug === null) throw new RepoError("config_invalid", `URL 里看不出 owner/repo：${trimmed}`);
    return { owner: slug[1]!, repo: slug[2]! };
  }

  const slug = SLUG_PATTERN.exec(trimmed);
  if (slug === null) {
    throw new RepoError("config_invalid", `仓库引用要写成 owner/repo 或 GitHub URL，收到：${trimmed}`);
  }
  return { owner: slug[1]!, repo: slug[2]! };
}

/** `owner/repo`。 */
export function repoSlug(ref: RepoRef): string {
  return `${ref.owner}/${ref.repo}`;
}

/** 归一化仓库引用的 clone URL（https，不带任何凭据——凭据走 `tokenAuthArgs`）。 */
export function githubCloneUrl(ref: RepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}.git`;
}

// ---------------------------------------------------------------- 凭据

export class GithubAppCredentials {
  readonly #appId: string | number;
  readonly #privateKey: string;
  readonly #installationId: number;
  readonly #auth: ReturnType<typeof createAppAuth>;
  readonly #cache = new Map<string, InstallationToken>();
  readonly #now: () => number;
  readonly #earlyRefreshMs: number;
  readonly #log: LogFn;

  constructor(options: GithubAppOptions) {
    if (options.appId === "" || options.privateKey === "" || options.installationId === "") {
      throw new RepoError("config_missing", "GitHub App 凭据不完整", { details: { field: "appId/privateKey/installationId" } });
    }
    this.#appId = options.appId;
    this.#privateKey = options.privateKey;
    this.#installationId = Number(options.installationId);
    if (!Number.isSafeInteger(this.#installationId) || this.#installationId <= 0) {
      throw new RepoError("config_invalid", `installationId 不是正整数：${String(options.installationId)}`);
    }
    this.#now = options.now ?? (() => Date.now());
    this.#earlyRefreshMs = options.earlyRefreshMs ?? TOKEN_EARLY_REFRESH_MS;
    this.#log = options.log ?? noopLog;
    this.#auth = createAppAuth({
      appId: options.appId,
      privateKey: options.privateKey,
      installationId: this.#installationId,
      // 自己的缓存（见文件头）：把 auth-app 的缓存关掉，否则它会在 59 分钟里
      // 一直返回同一个 token，我们这边的"提前 5 分钟续签"就永远不会触发。
      cache: NO_CACHE,
      ...(options.request === undefined
        ? {}
        : { request: options.request as unknown as StrategyOptions["request"] }),
    });
  }

  /**
   * 从环境变量构造，**启动时调用**：缺东西或私钥解不开就抛，
   * 让进程在"对外宣布就绪"之前退出（Phase 1 §6 的同一条规矩）。
   */
  static async fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: { log?: LogFn; now?: () => number; earlyRefreshMs?: number; request?: GithubAppRequest } = {},
  ): Promise<GithubAppCredentials> {
    const missing: string[] = [];
    const appId = env[ENV_APP_ID];
    const installationId = env[ENV_INSTALLATION_ID];
    const inlineKey = env[ENV_PRIVATE_KEY];
    const keyPath = env[ENV_PRIVATE_KEY_PATH];
    if (appId === undefined || appId === "") missing.push(ENV_APP_ID);
    if (installationId === undefined || installationId === "") missing.push(ENV_INSTALLATION_ID);
    if ((inlineKey === undefined || inlineKey === "") && (keyPath === undefined || keyPath === "")) {
      missing.push(`${ENV_PRIVATE_KEY}（或 ${ENV_PRIVATE_KEY_PATH}）`);
    }
    if (missing.length > 0) {
      throw new RepoError("config_missing", `GitHub App 配置不全：缺 ${missing.join("、")}`, { details: { missing } });
    }

    const privateKey = await privateKeyFromEnv(env);
    return new GithubAppCredentials({ appId: appId!, installationId: installationId!, privateKey, ...options });
  }

  /** 当前缓存里的 token 数（测试断言"第二次调用没有重新签发"）。 */
  get cachedTokens(): number {
    return this.#cache.size;
  }

  /** 清掉缓存。`refresh:true` 之外，测试也用它把状态归零。 */
  clearCache(): void {
    this.#cache.clear();
  }

  /**
   * 拿一个限定到 `owner/repo` 的 installation token。
   *
   * 缓存命中条件是"`expiresAt - earlyRefreshMs` 还没到"。到点之后的第一次调用会
   * 重新签发——不是等它真的过期，那时 push 会在半路 401。
   */
  async tokenFor(repo: RepoRef, options: { refresh?: boolean } = {}): Promise<InstallationToken> {
    const key = repoSlug(repo);
    const cached = this.#cache.get(key);
    if (options.refresh !== true && cached !== undefined) {
      const freshUntil = cached.expiresAt.getTime() - this.#earlyRefreshMs;
      if (freshUntil > this.#now()) return cached;
      this.#log("info", `GitHub App token 到期前 ${Math.round((cached.expiresAt.getTime() - this.#now()) / 1000)}s，续签`, {
        repo: key,
      });
    }

    const token = await this.#mint(repo);
    this.#cache.set(key, token);
    return token;
  }

  async #mint(repo: RepoRef): Promise<InstallationToken> {
    let authentication;
    try {
      authentication = await this.#auth({
        type: "installation",
        installationId: this.#installationId,
        // token 的作用域就收在这一个仓库名上。
        repositoryNames: [repo.repo],
        permissions: GITHUB_APP_PERMISSIONS,
      });
    } catch (error) {
      throw mapGithubError(error, repo);
    }
    return {
      token: authentication.token,
      createdAt: new Date(authentication.createdAt),
      expiresAt: new Date(authentication.expiresAt),
      installationId: this.#installationId,
      permissions: authentication.permissions as Record<string, string>,
      repositorySelection: authentication.repositorySelection,
      repositoryNames: authentication.repositoryNames ?? [repo.repo],
    };
  }
}

/** 私钥必须能被 Node 的 OpenSSL 解析。抛的是 RepoError（启动时就要看见）。 */
export function assertPrivateKeyParses(privateKey: string): void {
  try {
    createPrivateKey(privateKey);
  } catch (error) {
    throw new RepoError("config_invalid", `GitHub App 私钥解析失败：${messageOf(error)}`, {
      details: { hint: "PEM 文本（含 BEGIN/END 行），不是路径；env 里的 \\n 会被还原" },
    });
  }
}

/**
 * 仓库根（`packages/control-plane/src/repo` 往上四级：`repo → src → control-plane → packages → 根`）。
 * **只用于相对私钥路径的兜底解析**：
 * `.env` 是整个仓库共用的一份，而 npm workspace 脚本的 cwd 在 `packages/control-plane`、
 * 根目录脚本的 cwd 在仓库根——同一个 `./github-app.pem` 不可能同时对两边都对。
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

/**
 * 私钥路径的候选列表，按顺序试。
 *
 * 绝对路径只有一个候选；相对路径先按**进程 cwd**（`agent:run` 在仓库根，它是对的），
 * 再退到**仓库根**（`test:live` / `test:integration` 的 cwd 在 `packages/control-plane`，
 * 这一步把它们救回来）。两个都不存在时错误里会把两条路径都列出来——
 * "找不到文件"最难受的就是不知道该把它放哪。
 */
export function keyPathCandidates(
  keyPath: string,
  cwd: string = process.cwd(),
  repoRoot: string = REPO_ROOT,
): string[] {
  if (path.isAbsolute(keyPath)) return [keyPath];
  return [path.resolve(cwd, keyPath), path.resolve(repoRoot, keyPath)];
}

/**
 * 从 env 读 PEM 私钥（`GITHUB_APP_PRIVATE_KEY` 内联，或 `GITHUB_APP_PRIVATE_KEY_PATH` 指的
 * 文件）。**读、转义、验解析三件事只在这一处**。
 *
 * 单独导出是因为 `scripts/github-app-installations.ts` 需要在拿到 installation id **之前**
 * 就用私钥签 JWT（它只缺 installation id，别的都该能建），而那份脚本不该再抄一遍这里的规矩。
 */
export async function privateKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const inlineKey = env[ENV_PRIVATE_KEY];
  const keyPath = env[ENV_PRIVATE_KEY_PATH];
  if ((inlineKey === undefined || inlineKey === "") && (keyPath === undefined || keyPath === "")) {
    throw new RepoError("config_missing", `缺 ${ENV_PRIVATE_KEY}（或 ${ENV_PRIVATE_KEY_PATH}）`);
  }

  let privateKey = inlineKey ?? "";
  if (privateKey === "") {
    const candidates = keyPathCandidates(keyPath!);
    let readPath: string | null = null;
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        privateKey = await readFile(candidate, "utf8");
        readPath = candidate;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (readPath === null) {
      throw new RepoError(
        "config_invalid",
        `读不到 ${ENV_PRIVATE_KEY_PATH}=${keyPath}（试过 ${candidates.join(" 与 ")}）：${messageOf(lastError)}`,
        { details: { path: keyPath, tried: candidates } },
      );
    }
  }
  // env 里的换行常常被写成字面量 `\n`（`.env` 文件、CI secret）。只有"整串里
  // 一个真换行都没有"时才替换——否则一份正常的 PEM 会被二次转义。
  if (privateKey.includes("\\n") && !privateKey.includes("\n")) privateKey = privateKey.replace(/\\n/g, "\n");
  assertPrivateKeyParses(privateKey);
  return privateKey;
}

// ---------------------------------------------------------------- 错误映射

/**
 * GitHub API 的失败 → `RepoError`。分类的价值在 Phase 12：
 * 403 要告诉用户"缺哪个权限"，404 是"这个仓库上没装 App"，
 * 429/403+retry-after 是"等着重试就行"——三者对使用者的动作完全不同。
 */
export function mapGithubError(error: unknown, repo: RepoRef): RepoError {
  const record = asRecord(error);
  const status = typeof record["status"] === "number" ? record["status"] : null;
  const message = typeof record["message"] === "string" ? record["message"] : messageOf(error);
  const response = asRecord(record["response"]);
  const data = asRecord(response["data"]);
  const headers = asRecord(response["headers"]);
  const context = { repo: repoSlug(repo), status, documentationUrl: data["documentation_url"] ?? null };

  if (status === null) {
    return new RepoError("github_unreachable", `连不上 GitHub API：${message}`, { details: context });
  }
  if (status === 401) {
    return new RepoError("github_unauthorized", `GitHub App 认证失败（401）：${message}`, { status, details: context });
  }
  if (status === 404) {
    return new RepoError("github_not_installed", `GitHub App 没有安装在 ${repoSlug(repo)} 上（404）`, {
      status,
      details: context,
    });
  }
  if (status === 422) {
    return new RepoError("github_invalid_scope", `GitHub 不接受这次授权范围（422）：${message}`, {
      status,
      details: context,
    });
  }
  if (status === 403 || status === 429) {
    const retryAfterMs = retryAfterMillis(headers);
    const remaining = headers["x-ratelimit-remaining"];
    if (retryAfterMs !== null || remaining === "0" || /rate limit/i.test(message)) {
      return new RepoError("github_rate_limited", `GitHub 限流（${status}）：${message}`, {
        status,
        details: { ...context, retryAfterMs },
      });
    }
    return new RepoError("github_forbidden", `installation 缺少所需权限（403）：${message}`, {
      status,
      details: { ...context, required: GITHUB_APP_PERMISSIONS },
    });
  }
  return new RepoError("github_api_error", `GitHub API 返回 ${status}：${message}`, { status, details: context });
}

function retryAfterMillis(headers: Record<string, unknown>): number | null {
  const raw = headers["retry-after"];
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
