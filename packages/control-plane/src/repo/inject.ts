/**
 * `inject.ts` —— 把 CP 手上的仓库灌进沙箱。
 *
 * 五步（§C.2「仓库怎么进沙箱」的 CP 侧实现）：
 *   1. 审计 clone 的 `.git/config`（有凭据就别往下走了）
 *   2. `tar czf -` 打包 → 流式 `PUT /files?path=/workspace/repo.tar.gz`
 *   3. `POST /exec ["mkdir","-p",workspaceDir]`（`tar -C` 要求目录已存在；Phase 11 起落点是
 *      `/workspace/repo`，镜像里没有这个子目录）
 *   4. `POST /exec ["tar","xzf",…,"-C",workspaceDir]`
 *   5. `POST /exec ["rm","-f",…]`（无论成败）+ 校验收包后的 HEAD
 *
 * 【为什么 tar 落在 `/workspace/repo.tar.gz`】§Phase 2 只允许写 `/workspace`（写单根），
 * 而 tar 不能写进仓库自己（会污染 diff 与归档）。放在工作区根、用完立刻删，
 * 是"既不越界又不进产出"的唯一位置；`finally` 里的 `rm` 保证失败也不会留下它。
 *
 * 【为什么记下 HEAD】灌入之后沙箱里的 HEAD 就是后面 `/diff?base=` 的 base。
 * 校验它等于 `clone.baseSha` 是这条链路的自检：不相等说明 tar 解包错了、
 * 或者沙箱里本来就有别的东西——两种情况都不该继续。
 *
 * 【内部命令不走 manager 的 BUSY 闸】这几条命令是 CP 自己搬仓库用的，
 * 发生在工具循环之前（Phase 11）或之后。它们通过 `client.execAndWait` 直接调
 * sandbox-agent：沙箱侧的单执行闸仍然在拦第二条并发命令，但没有 DB 记账——
 * 原因在 `client/sandbox-api.ts` 的 `execAndWait` 注释里。
 */

import type { AgentExecOutcome } from "../client/sandbox-api.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { RepoClone } from "./clone.ts";
import { auditCloneConfig, packDirectory } from "./pack.ts";
import { RepoError } from "./types.ts";
import type { RepoApi, SandboxTarget } from "./types.ts";

/** tar 在沙箱里的落点（spec §3）。 */
export const DEFAULT_TAR_PATH = "/workspace/repo.tar.gz";

/**
 * 解包目标。**缺省是 workspace 根**（Phase 9 的口径）；Phase 11 起 agent 流程传
 * `/workspace/repo`（agent-runtime 的 `prompt/system.ts` 的 `REPO_DIR`），工具层与提示词都按那个路径说话。
 */
export const DEFAULT_WORKSPACE_DIR = "/workspace";

/** 内部命令的时限。`tar xzf` 一个几百 MiB 的仓库可能要几十秒到几分钟。 */
export const INJECT_EXEC_TIMEOUT_MS = 300_000;

export interface InjectRepoInput {
  api: RepoApi;
  target: SandboxTarget;
  clone: RepoClone;
  /** tar 的落点，必须在写根 `/workspace` 之下。 */
  tarPath?: string;
  /** `tar xzf … -C <workspaceDir>` 的目标。 */
  workspaceDir?: string;
  timeoutMs?: number;
  log?: LogFn;
}

export interface InjectRepoResult {
  /** 实际传进沙箱的字节数（与 `sha256` 一起构成"送进去的是哪份 tar"的证据）。 */
  bytes: number;
  sha256: string;
  /** 解包之后沙箱里的 HEAD（等于 `clone.baseSha`）。 */
  headSha: string;
  /** 内部命令的 execution id，顺序：`tar xzf`、`git rev-parse`、（最后追加）`rm`。 */
  executions: string[];
}

/** 灌入。失败时沙箱里的 tar 也会被删掉（`finally`），残留只有一个"半解开的仓库"。 */
export async function injectRepo(input: InjectRepoInput): Promise<InjectRepoResult> {
  const { api, target, clone } = input;
  const tarPath = input.tarPath ?? DEFAULT_TAR_PATH;
  const workspaceDir = input.workspaceDir ?? DEFAULT_WORKSPACE_DIR;
  const timeoutMs = input.timeoutMs ?? INJECT_EXEC_TIMEOUT_MS;
  const log = input.log ?? noopLog;
  const executions: string[] = [];

  // ① 打包之前先自证清白。这一步失败时沙箱还没被污染——代价只是一行报错。
  await auditCloneConfig(clone.dir);

  // ② 打包 → 上传。tar 在产出字节，PUT 在消费它们，两边同时推进。
  const { stream, result } = packDirectory(clone.dir, { timeoutMs, log });
  const write = await api
    .putFile(target.endpoint, target.authToken, tarPath, stream)
    .catch(async (error: unknown) => {
      // 上传失败：把 tar 的流掐掉，等它的失败结果，再原样抛上传的错误
      // （上传的错误包含 HTTP 状态与沙箱的 error code，比 tar 的 EPIPE 有用得多）。
      stream.destroy();
      await result.catch(() => undefined);
      throw error;
    });
  const packed = await result;
  if (write.size !== packed.bytes || write.sha256 !== packed.sha256) {
    throw new RepoError(
      "sandbox_upload_mismatch",
      `灌进沙箱的字节与 tar 对不上：发出 ${packed.bytes}/${packed.sha256}，沙箱报 ${write.size}/${write.sha256}`,
      { details: { sent: packed, received: write } },
    );
  }

  try {
    // ③ 解包。cwd 用 `-C` 显式给，不依赖沙箱的默认 cwd。
    // 先建目录：`tar -C <dir>` 要求 <dir> 已经存在，而 Phase 11 起仓库的落点是
    // `/workspace/repo`（workspace 根下的子目录，镜像里没有它）。幂等，代价一次 exec。
    const ready = await execOrThrow(api, target, ["mkdir", "-p", workspaceDir], { timeoutMs });
    executions.push(ready.executionId);
    const untar = await execOrThrow(api, target, ["tar", "xzf", tarPath, "-C", workspaceDir], { timeoutMs });
    executions.push(untar.executionId);

    // ④ 自检：沙箱里的 HEAD 必须就是我们 clone 的那个 commit。
    const head = await execOrThrow(api, target, ["git", "-C", workspaceDir, "rev-parse", "HEAD"], { timeoutMs });
    executions.push(head.executionId);
    const headSha = head.stdout.trim();
    if (headSha !== clone.baseSha) {
      throw new RepoError("sandbox_head_mismatch", `解包之后的 HEAD（${headSha}）不是 base commit（${clone.baseSha}）`, {
        details: { expected: clone.baseSha, actual: headSha, sandboxId: target.sandboxId ?? null },
      });
    }

    log("info", "仓库已灌入沙箱", { bytes: packed.bytes, baseSha: headSha, sandboxId: target.sandboxId ?? null });
    return { bytes: packed.bytes, sha256: packed.sha256, headSha, executions };
  } finally {
    // ④′ 无论成败都把 tar 删掉。留在 /workspace 里会进 diff、进归档——
    // 而它是一份 100% 冗余的几百 MiB。
    await execBestEffort(api, target, ["rm", "-f", tarPath], { timeoutMs, log, executions });
  }
}

/** 跑一条必须成功的内部命令。非 0 退出 → `sandbox_command_failed`（带 stderr 尾部）。 */
async function execOrThrow(
  api: RepoApi,
  target: SandboxTarget,
  cmd: string[],
  options: { timeoutMs: number },
): Promise<AgentExecOutcome> {
  const outcome = await api.execAndWait(target.endpoint, target.authToken, { cmd, timeoutMs: options.timeoutMs });
  if (outcome.state !== "completed" || outcome.exitCode !== 0) {
    throw new RepoError(
      "sandbox_command_failed",
      `沙箱命令失败（${cmd.join(" ")}）：state=${outcome.state} exit=${String(outcome.exitCode)} ${tail(outcome.stderr)}`,
      {
        details: {
          cmd,
          state: outcome.state,
          exitCode: outcome.exitCode,
          stdout: tail(outcome.stdout),
          stderr: tail(outcome.stderr),
          logPath: outcome.logPath,
        },
      },
    );
  }
  return outcome;
}

/** 清理类命令：失败只记日志（不覆盖真正的失败原因），并把 execution id 记进同一个数组。 */
async function execBestEffort(
  api: RepoApi,
  target: SandboxTarget,
  cmd: string[],
  options: { timeoutMs: number; log: LogFn; executions: string[] },
): Promise<void> {
  try {
    const outcome = await api.execAndWait(target.endpoint, target.authToken, {
      cmd,
      timeoutMs: options.timeoutMs,
    });
    options.executions.push(outcome.executionId);
    if (outcome.state !== "completed" || outcome.exitCode !== 0) {
      options.log("warn", `清理命令没有成功：${cmd.join(" ")}`, {
        state: outcome.state,
        exitCode: outcome.exitCode,
        stderr: tail(outcome.stderr),
      });
    }
  } catch (error) {
    options.log("warn", `清理命令没能执行：${cmd.join(" ")}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 截断一段输出供错误信息使用。 */
function tail(text: string, limit = 800): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(trimmed.length - limit)}`;
}
