/**
 * Phase 7 冒烟脚本的公共脚手架：标签过滤、平台门槛、沙箱生命周期、agent HTTP、fixture 仓库。
 *
 * 【它是哪一层】spec §0.5 把测试分三层，这是第三层：**冒烟**。它要 Docker、要两个镜像、
 * 要出网代理**在跑**，跑的是"provider + sandbox-agent + egress-proxy"这一整套。
 * 所以它不进 `npm test`（那条命令永远不需要 Docker），也不进 `npm run test:integration`
 * （那一层只起单个容器、不经过 provider 的完整生命周期）。
 *
 * 【它测什么】§J 的两张表，按标签分组：
 *  - `isolation`  隔离红线（I1–I10），本地 macOS 默认整组跳过（见下面的平台门槛）
 *  - `network`    出网白名单的正反面：github 不可达、registry 可达、真装一个包
 *  - `exec`       把 Phase 1 的 API 放进真容器里再走一遍（事件流、中间输出、超时杀进程组、截断与日志）
 *  - `files`      把 Phase 2 的 API 放进真容器里再走一遍（二进制往返、越界拒绝）
 *  - `flow`       §J 的业务链路：tar 灌入 → `npm ci && npm test` → diff → archive → destroy
 *
 * 【为什么不经过 CP 业务层】Phase 7 时 Phase 8–10 还没落地（没有 DB、没有 manager、
 * 没有 repo/artifacts）。script 直接拿 provider 造沙箱、直接打 agent HTTP——spec 原文
 * 就是这个意思（"这个阶段的冒烟脚本直接调 provider + agent HTTP，不经过 CP 业务层"）。
 * 属于 CP 业务层的两件事（三张表的状态、归档落对象存储）已经在 Phase 8/10 落地，
 * 但它们的验证在 `control-plane/test/integration/` 里（那里有真 Postgres 与真 MinIO）；
 * 这一组仍然只断言"沙箱侧看得见"的那些事实（归档流本身合法、容器与卷真的没了）。
 *
 * 【为什么复用 CP 的测试脚手架】`dockerOrThrow` / `resolveImageRef` / `agentExec` /
 * `rawInspect` 这些已经在 Phase 5/6 的集成测试里跑熟了，再写第二份只会让"怎么解析 digest"、
 * "SSE 怎么读"这类细节多出一个会漂移的实现。`scripts/sandbox-image-check.ts` 已经开了
 * 先例（它 import 的是 sandbox-agent 的 harness）。产品代码不许这么互相 import，
 * 测试脚手架之间可以。
 *
 * 【有意不 import agent 的类型】`sandbox-agent/src/types.ts` 里的 `ExecRequest` / `DiffResponse`
 * 是**那一侧**的契约（spec §0.4：两层之间只有 HTTP 契约，类型各自描述、故意重复）。
 * 冒烟脚本在这一刻扮演的是 CP 的消费者，所以它按自己读到的字段描述响应——
 * 少写几个字段没关系，import 过来就等于把"类型不许共享"这条规矩悄悄废掉。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe } from "node:test";
import { LocalDockerProvider } from "../../control-plane/src/provider/local-docker.ts";
import { INTERNAL_NETWORK } from "../../control-plane/src/provider/types.ts";
import type { SandboxHandle, SandboxHealth, SandboxLimits } from "../../control-plane/src/provider/types.ts";
import {
  DEFAULT_IMAGE_TAG,
  agentExec,
  delay,
  docker,
  dockerAvailable,
  dockerOrThrow,
  resolveImageRef,
  waitFor,
} from "../../control-plane/test/support.ts";
import type { ExecOutcome } from "../../control-plane/test/support.ts";

// ---------------------------------------------------------------- 标签与平台门槛

/** `SMOKE_TAGS`（由 src/smoke.ts 从 `--tag=` 翻译过来）：空 = 全跑。 */
const SELECTED_TAGS: string[] = (process.env.SMOKE_TAGS ?? "")
  .split(",")
  .map((tag) => tag.trim())
  .filter((tag) => tag !== "");

/** 当前标签选择是否命中这组标签。 */
function tagSelected(tags: string[]): boolean {
  return SELECTED_TAGS.length === 0 || tags.some((tag) => SELECTED_TAGS.includes(tag));
}

export interface SmokeGroupOptions {
  /** 这组用例属于哪些标签（`--tag=` 按它筛选）。 */
  tags: string[];
  /**
   * 只在 Linux 上有验证力。§J 末尾那句："macOS 的 Docker Desktop 使用不同的内核和
   * seccomp 行为，本机通过不代表生产通过。"所以隔离红线默认在别的平台上整组跳过。
   *
   * 一个例外：`SMOKE_ANY_PLATFORM=1` 可以把它强行打开。存在的理由是**反向验证也要能
   * 在本地做**（"手工把 CapDrop 去掉再跑一次，本地也变红"）——否则那一条验收就只能等 CI。
   * 打开了也只是"跑了"，脚本会打一行提示说结论仅供参考。
   */
  linuxOnly?: boolean;
}

/**
 * 注册一组冒烟用例。标签不匹配、或平台不满足时**整组跳过**——
 * 注意跳过的是 `describe`：`before`/`after` 也不会执行，所以不会白建一个沙箱。
 * （这一点专门验证过：被 skip 的 suite 里的 before/after 一次都不跑。）
 */
export function smokeGroup(title: string, options: SmokeGroupOptions, fn: () => void): void {
  const reason = skipReason(options);
  describe(title, reason === null ? {} : { skip: reason }, fn);
}

function skipReason(options: SmokeGroupOptions): string | null {
  if (!tagSelected(options.tags)) {
    return `标签不匹配（本次 SMOKE_TAGS=${SELECTED_TAGS.join(",") || "(空 = 全部)"}，本组是 ${options.tags.join(",")}）`;
  }
  if (options.linuxOnly === true && process.platform !== "linux" && process.env.SMOKE_ANY_PLATFORM !== "1") {
    if (process.env.CI) {
      // CI 上不许静默跳过：GitHub Actions 只有 ubuntu-latest 才允许跑冒烟（spec Phase 7 §4）。
      // 抛在加载期，整个测试文件会以失败收场——比"全绿但是什么都没测"诚实得多。
      throw new Error(
        `冒烟必须在 Linux 上跑，当前是 ${process.platform}。CI 里不允许静默跳过隔离红线（spec Phase 7 §4）。`,
      );
    }
    return `只在 Linux 上有验证力（当前平台 ${process.platform}）；本地要看参考结论就加 SMOKE_ANY_PLATFORM=1`;
  }
  return null;
}

// ---------------------------------------------------------------- 沙箱

/**
 * 冒烟沙箱的配额。**和 Phase 5 集成测试的值不同**，是刻意的：
 *  - `memMb: 1024`：I7 要一个能被 4 GiB 分配打爆的容器，2 GiB 太浪费；
 *  - `pids: 256`：I8 的 fork 炸弹要撞到 pids 上限，256 足够 agent + 一次 npm 跑起来，
 *    又足够小到让炸弹在几秒内撞墙；
 *  - `cpu: 1` / `diskMb: 4096`：与真实 sandbox 的默认档位同一量级。
 */
export const SMOKE_LIMITS: SandboxLimits = { cpu: 1, memMb: 1024, pids: 256, diskMb: 4096, ttlSec: 3600 };

export interface SmokeSandboxOptions {
  /** 进 sandboxId 的短标签（`sbx_smoke_<label>_<rand>`），出问题时一眼知道是哪个组的。 */
  label: string;
}

/** 每个测试文件一个进程，所以镜像解析一次就够（`docker image inspect` 每次都要 fork）。 */
let cachedImageRef: string | null = null;

async function smokeImageRef(): Promise<string> {
  cachedImageRef ??= await resolveImageRef(
    process.env.SANDBOX_IMAGE ?? DEFAULT_IMAGE_TAG,
    "npm run build:image",
  );
  return cachedImageRef;
}

/**
 * 一个冒烟用的沙箱。包装 provider 的 create/destroy + agent 的 HTTP 面，
 * 让用例读起来是"在容器里做一件事"，而不是一屏 fetch 参数。
 */
export class SmokeSandbox {
  readonly handle: SandboxHandle;
  readonly provider: LocalDockerProvider;
  #destroyed = false;

  private constructor(provider: LocalDockerProvider, handle: SandboxHandle) {
    this.provider = provider;
    this.handle = handle;
  }

  get sandboxId(): string {
    return this.handle.sandboxId;
  }

  /**
   * 造一个沙箱。走的是**产品路径**（LocalDockerProvider.create），所以加固参数、
   * 内网、卷、health 轮询全都真的经过一遍——这正是冒烟要覆盖的东西。
   */
  static async create(options: SmokeSandboxOptions): Promise<SmokeSandbox> {
    const image = await smokeImageRef();
    const sandboxId = `sbx_smoke_${options.label}_${randomBytes(4).toString("hex")}`;
    const provider = new LocalDockerProvider({
      // info 也打出来：CI 日志里"卡在哪一步"往往就是靠这几行判断的。
      log: (level, message, details) => {
        const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
        console.log(`  [provider:${level}] ${message}${suffix}`);
      },
    });
    const handle = await provider.create({
      image,
      // 所有冒烟沙箱用同一份配额（见 SMOKE_LIMITS）：I10 直接拿它当断言基准，
      // 所以"配额"在这份脚本里只有一个来源。
      limits: SMOKE_LIMITS,
      labels: { sandboxId, runId: "run_smoke" },
      workspace: { sizeMb: 4096 },
    });
    return new SmokeSandbox(provider, handle);
  }

  /**
   * 销毁。**幂等**（provider.destroy 本身也幂等）：用例可以在断言结束前自己调一次，
   * `after()` 里还会兜一次。
   */
  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    await this.provider.destroy(this.sandboxId);
  }

  /** provider 视角的 health（探的是 agent 的 `/health`）。 */
  health(): Promise<SandboxHealth> {
    return this.provider.health(this.sandboxId);
  }

  /**
   * 在沙箱里跑一条命令，读到终态事件。
   *
   * 409 要重试：exec / diff / archive 共用**同一个 BUSY 槽**（附录 A-5），而槽是在终态
   * 事件之后才还回来的——上一条命令刚读完 SSE 就立刻发下一条，偶尔会撞上。
   * CP 遇到这个也是"等一会儿再来"，冒烟脚本没理由更着急。
   */
  async exec(
    cmd: string[],
    options: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> } = {},
  ): Promise<ExecOutcome> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        return await agentExec(this.handle.endpoint, this.handle.authToken, cmd, options);
      } catch (error) {
        // support.ts 的 agentExec 对非 202 只抛一句带状态码的 Error，所以这里按状态码认。
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("得到 409") || Date.now() > deadline) throw error;
        await delay(100);
      }
    }
  }

  /** 带 token 打一条 agent 路由。默认不给超时——`/archive` 是流，超时得由调用方说了算。 */
  async request(pathname: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs, ...rest } = init;
    return fetch(`${this.handle.endpoint}${pathname}`, {
      ...rest,
      headers: {
        authorization: `Bearer ${this.handle.authToken}`,
        ...(rest.headers ?? {}),
      },
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
    });
  }

  /** GET 一条 JSON 路由；非 200 直接抛（带响应体，方便定位）。 */
  async getJson<T>(pathname: string, options: { timeoutMs?: number } = {}): Promise<T> {
    const response = await this.request(pathname, options);
    if (!response.ok) throw new Error(`GET ${pathname} 得到 ${response.status}：${await response.text()}`);
    return (await response.json()) as T;
  }

  /** 期待一条失败响应：返回状态码与解析后的错误体，由调用方断言具体是哪一种错。 */
  async errorOf(
    pathname: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await this.request(pathname, init);
    const text = await response.text();
    return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }

  /** `PUT /files`（裸字节）。 */
  async putFile(target: string, body: Uint8Array | string): Promise<FileWritePayload> {
    const response = await this.request(`/files?path=${encodeURIComponent(target)}`, {
      method: "PUT",
      body: typeof body === "string" ? body : Buffer.from(body),
      timeoutMs: 120_000,
    });
    if (!response.ok) throw new Error(`PUT ${target} 得到 ${response.status}：${await response.text()}`);
    return (await response.json()) as FileWritePayload;
  }

  /** `GET /files?raw=1`：拿到原始字节（大日志、二进制都用它）。 */
  async readRaw(target: string): Promise<Buffer> {
    const response = await this.request(`/files?raw=1&path=${encodeURIComponent(target)}`, {
      timeoutMs: 120_000,
    });
    if (!response.ok) throw new Error(`GET ${target} (raw) 得到 ${response.status}：${await response.text()}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** `GET /diff?base=…`。 */
  diff(query = ""): Promise<DiffResponse> {
    return this.getJson<DiffResponse>(`/diff${query}`, { timeoutMs: 120_000 });
  }

  /** `GET /archive` 的原始响应（调用方自己读流）。 */
  async archive(query = ""): Promise<Response> {
    const response = await this.request(`/archive${query}`, { timeoutMs: 300_000 });
    if (!response.ok) throw new Error(`GET /archive 得到 ${response.status}：${await response.text()}`);
    return response;
  }
}

// ---------------------------------------------------------------- agent 响应的本地描述

/**
 * 下面这几个 interface 是**冒烟脚本自己**对 agent HTTP 契约的描述（见文件头：
 * 有意不 import agent 的类型）。只写用得到的字段。
 */

export interface FileWritePayload {
  path: string;
  size: number;
  sha256: string;
}

export interface FileReadPayload {
  path: string;
  size: number;
  sha256: string;
  encoding: "utf8" | "base64";
  offset: number;
  bytes: number;
  content: string;
}

export interface FileListPayload {
  path: string;
  entries: Array<{ name: string; type: string; size: number; mtime: number }>;
  truncated: boolean;
}

export interface DiffPayload {
  base: string;
  head: string;
  files: Array<{
    path: string;
    old_path?: string;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
  }>;
  patch: string | null;
  patch_bytes: number;
  truncated: boolean;
  patch_log_path: string | null;
}

/** `/diff` 与 `/archive` 的类型别名，避免用例 import 两遍。 */
export type DiffResponse = DiffPayload;

// ---------------------------------------------------------------- 命令断言

export interface ExecOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

/** 跑一条命令，要求它成功（exit 0）。失败时把 stderr 带进断言消息——不然只剩一句 exit=1。 */
export async function execOk(box: SmokeSandbox, cmd: string[], options: ExecOptions = {}): Promise<ExecOutcome> {
  const result = await box.exec(cmd, options);
  assert.equal(
    result.exitCode,
    0,
    `命令应该成功却失败了（exit=${String(result.exitCode)} signal=${String(result.signal)} terminal=${result.terminal.event}）：` +
      `${cmd.join(" ")}\nstderr: ${result.stderr.slice(0, 2_000)}`,
  );
  return result;
}

/** 跑一条命令，要求它失败（非 0 退出，不含超时）。返回结果供调用方断言细节。 */
export async function execFail(box: SmokeSandbox, cmd: string[], options: ExecOptions = {}): Promise<ExecOutcome> {
  const result = await box.exec(cmd, options);
  assert.notEqual(
    result.exitCode,
    0,
    `命令本该失败却成功了：${cmd.join(" ")}\nstdout: ${result.stdout.slice(0, 2_000)}`,
  );
  return result;
}

// ---------------------------------------------------------------- fixture 仓库

/**
 * fixture 仓库的内容。**零依赖**是刻意的：
 *  - `npm ci` 在没有 package-lock 的依赖要装时才会碰网络，而"真实装包"这件事由
 *    `network` 组和 Phase 6 的集成测试分别验证过了（两处都真的走代理下载过 npm 包）；
 *  - flow 组要验证的是**链路**（tar 灌入 → npm ci → npm test → diff → archive → destroy），
 *    不是网络。依赖越少，失败时的原因越唯一。
 *
 * `package-lock.json` 必须和 `package.json` 的 name/version 对得上，否则 `npm ci` 会拒绝
 * （lockfileVersion 3 + 空的 packages[""] 就是"零依赖"的合法写法，实测离线可跑）。
 */
const FIXTURE_FILES: Record<string, string> = {
  "package.json": `${JSON.stringify(
    {
      name: "rc-smoke-fixture",
      version: "1.0.0",
      private: true,
      scripts: { test: "node run-tests.js" },
    },
    null,
    2,
  )}\n`,
  "package-lock.json": `${JSON.stringify(
    {
      name: "rc-smoke-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "rc-smoke-fixture", version: "1.0.0" } },
    },
    null,
    2,
  )}\n`,
  "src/greet.js": 'module.exports = (name) => `hi ${name}`;\n',
  "run-tests.js": [
    'const assert = require("node:assert/strict");',
    'const greet = require("./src/greet.js");',
    'assert.equal(greet("smoke"), "hi smoke");',
    'console.log("fixture: 1 test passed");',
    "",
  ].join("\n"),
  "README.md": "# rc-smoke-fixture\n\nPhase 7 冒烟脚本灌进沙箱的测试仓库。\n",
  // 被忽略的目录：archive 必须包含它（§J.6），而 diff 不该看见它（未跟踪且被忽略）。
  ".gitignore": "dist/\nnode_modules/\n",
};

export interface FixtureRepo {
  /** 整个仓库（含 `.git`）的 tar.gz，直接 `PUT /files` → `tar xzf`。 */
  tarball: Buffer;
  /** 初始 commit 的 sha：`GET /diff?base=<它>` 用得上。 */
  baseSha: string;
}

/**
 * 在宿主上现造一个 fixture 仓库并打包。
 *
 * 为什么不在仓库里放一个 tar 文件：二进制进 git 看不出内容、改不动、还会随用例一起腐败。
 * 为什么不在沙箱里 `git init`：那样 `.git` 的形态与"CP clone 之后灌进去"差别太大，
 * 而 §J 的业务链路要的正是"仓库是被搬进去的"这件事。
 *
 * 用**系统 tar**（`tar -czf - -C <dir> .`）：与 `/archive` 的实现同一个口径
 * （macOS 的 bsdtar 与 Linux 的 GNU tar 在这个用法上一致），也避免为了造一个 tar
 * 去引一个打包库。
 */
export async function buildFixtureRepo(): Promise<FixtureRepo> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rc-smoke-fixture-"));
  try {
    for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
      const target = path.join(dir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }

    // git 的身份与签名开关都显式传：CI runner 上没有全局 git 配置，
    // 而且 `commit.gpgsign=true` 的开发者机器不该让冒烟脚本挂掉。
    const git = async (args: string[]): Promise<string> => {
      const result = await runBinary(
        ["git", "-c", "user.name=smoke", "-c", "user.email=smoke@example.com", "-c", "commit.gpgsign=false", ...args],
        { cwd: dir },
      );
      assert.equal(result.code, 0, `git ${args.join(" ")} 失败：${result.stderr.trim()}`);
      return result.stdout.toString("utf8");
    };
    await git(["init", "-q"]);
    await git(["add", "-A"]);
    await git(["commit", "-qm", "fixture: 初始提交"]);
    const baseSha = (await git(["rev-parse", "HEAD"])).trim();

    const tarred = await runBinary(["tar", "-czf", "-", "-C", dir, "."], {
      // macOS 的 bsdtar 默认把扩展属性（quarantine / provenance 这些）写成 `._*`
      // AppleDouble 条目；这些条目到 Linux 里会变成**真实文件**，于是 `git status`
      // 立刻不干净（实测就是这么被坑的）。COPYFILE_DISABLE 是 Apple 工具链的开关，
      // Linux 上的 GNU tar 看不到它也不用管它。
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    assert.equal(tarred.code, 0, `tar 打包 fixture 失败：${tarred.stderr.trim()}`);
    return { tarball: tarred.stdout, baseSha };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 列出一个 tar.gz 里的条目名（宿主上的 tar）。顺带验证它真的是合法的 gzip tar。 */
export async function tarList(gzipped: Buffer): Promise<string[]> {
  const result = await runBinary(["tar", "-tzf", "-"], { stdin: gzipped });
  assert.equal(result.code, 0, `tar -tzf 失败（归档不是合法的 tar.gz？）：${result.stderr.trim()}`);
  return result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

interface BinaryResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * 跑一条宿主命令并拿到**原始字节**。support.ts 里的 `run()` 会把 stdout 解成 utf8，
 * 对 tar.gz 这种二进制流是把内容弄坏——所以脚手架自己有一份。
 */
function runBinary(
  argv: string[],
  options: { cwd?: string; stdin?: Buffer; env?: NodeJS.ProcessEnv } = {},
): Promise<BinaryResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr }));
    // stdin 一律接上再立刻关：git 不读它，tar -tzf 读它。
    child.stdin.end(options.stdin);
  });
}

// ---------------------------------------------------------------- 残留清理

/**
 * 清掉**上一次冒烟跑崩**留下的沙箱（进程被 Ctrl-C、断言把 after 也弄挂了等等）。
 *
 * 只认 `sbx_smoke_` 这个前缀：那是冒烟脚本自己造的 sandboxId，不会碰到开发者的手工沙箱。
 * 由 `src/smoke.ts` 在起测试进程之前调用一次——那一刻没有任何测试在跑，所以不存在
 * "删掉别人正在用的容器"的风险（`--test-concurrency` 大于 1 时多个文件会并发建沙箱，
 * 所以这个清理**不能**放进测试文件里做）。
 */
export async function sweepSmokeLeftovers(): Promise<string[]> {
  if (!(await dockerAvailable())) return [];
  const removed: string[] = [];

  const containers = await dockerOrThrow([
    "ps",
    "-a",
    "--filter",
    "name=reuben-cloud-sbx-sbx_smoke_",
    "--format",
    "{{.Names}}",
  ]);
  for (const name of splitLines(containers)) {
    const result = await docker(["rm", "-f", name]);
    if (result.code === 0) removed.push(`容器 ${name}`);
  }

  const volumes = await dockerOrThrow([
    "volume",
    "ls",
    "--filter",
    "name=reuben-cloud-ws-sbx_smoke_",
    "--format",
    "{{.Name}}",
  ]);
  for (const name of splitLines(volumes)) {
    const result = await docker(["volume", "rm", name]);
    if (result.code === 0) removed.push(`卷 ${name}`);
  }

  return removed;
}

/** 断言某个 sandboxId 什么都没留下（容器 + 卷，含 darwin 的转发容器）。 */
export async function assertNoLeftovers(sandboxId: string, context: string): Promise<void> {
  const containers = await dockerOrThrow([
    "ps",
    "-a",
    "--filter",
    `label=reuben-cloud.sandboxId=${sandboxId}`,
    "--format",
    "{{.Names}}",
  ]);
  const volumes = await dockerOrThrow([
    "volume",
    "ls",
    "--filter",
    `label=reuben-cloud.sandboxId=${sandboxId}`,
    "--format",
    "{{.Name}}",
  ]);
  assert.deepEqual(
    { containers: splitLines(containers), volumes: splitLines(volumes) },
    { containers: [], volumes: [] },
    `${context}：销毁之后还有残留`,
  );
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** 轮询等待一个条件（转发自 support.ts，用例里少 import 一个文件）。 */
export { waitFor };

/** 内网名（I10 要断言容器只挂在这一张网上）。 */
export const INTERNAL_NETWORK_NAME = INTERNAL_NETWORK;
