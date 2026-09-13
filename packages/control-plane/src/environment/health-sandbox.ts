/**
 * `environment/health-sandbox.ts` —— `HealthSandboxPort` 的生产实现：一次性沙箱 + 灌仓库 + exec。
 *
 * 【为什么单独一个文件（spec P7 的交付物里只有 `health.ts`）】体检的**判定**是纯的（`health.ts`
 * 只认三个动作：open / exec / destroy），而这三个动作在 CP 侧是三件真事：用环境镜像建沙箱、
 * 把 CP 手上的仓库灌进去、跑命令。把它们与判定放在一起，`health.ts` 就会认识 manager / docker /
 * git——那正是 `queue.ts` 与 `build.ts` 分开的同一条理由（见 P6 的实现备注）。
 *
 * 【为什么体检沙箱要单独一个 manager】归档（Phase 10 的 offload）对一个刚建出来、仓库还没被
 * 改过的沙箱没有意义，但每次体检都往对象存储里塞一份归档是真实的噪声与开销。所以调用方给
 * 一个**不带 artifacts** 的 manager（`env:build` / `agent:run` 都是这么装的）。
 *
 * 【为什么要重新 clone 一次】体检要的是"这个仓库在这个 commit 上的样子"，而 Run 侧那份 clone
 * 可能是别的 commit（会话热复用时会前进）。clone 落在 `/tmp/reuben-cloud-cp/envcheck_<ulid>/`，
 * 与 Run 的目录天然隔离，两边不会互相踩。
 *
 * 【为什么用 `execAndWait` 而不是 manager 的 `execInSandbox`】后者会写 DB 的 executions 行
 * （它是"agent 的工具调用"那条路径的记账），而体检命令不是模型发起的工具调用。参考
 * `inject.ts` 的同一条注释：沙箱侧的单执行闸仍然在拦并发，只是没有 DB 记账。
 */

import { SandboxApiClient } from "../client/sandbox-api.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { SandboxManager } from "../manager/sandbox-manager.ts";
import type { RepoApi } from "../repo/types.ts";
import { cloneRepo, removeRunDir } from "../repo/clone.ts";
import { injectRepo } from "../repo/inject.ts";
import { prefixedId } from "../ulid.ts";
import type { HealthExecInput, HealthExecResult, HealthSandboxHandle, HealthSandboxPort } from "./health.ts";

export interface HealthSandboxPortOptions {
  /** **不带 artifacts 的** manager（见文件头）。 */
  manager: SandboxManager;
  /** 灌仓库用的沙箱 HTTP 客户端；缺省新建一个。 */
  api?: RepoApi & SandboxApiClient;
  /** 仓库来源：体检要在大致同一个 commit 上做（与 Run 的起点一致）。 */
  repo: { url: string; commit: string; token: () => Promise<string | null> };
  workspaceDir?: string;
  log?: LogFn;
}

/** 体检沙箱的 run id 前缀（`sandboxes.run_id` 是自由文本；用它区分体检与真执行）。 */
const HEALTH_RUN_PREFIX = "envcheck";

/**
 * 体检沙箱的出口。
 *
 * 【为什么 clone 每次 open 都做一次】`open()` 的契约是"给我一个装好这个仓库的沙箱"，
 * 而 clone 是它最便宜的一部分（相对于一次 `npm ci`）。缓存一份 clone 会让"体检用的 commit"
 * 与调用方以为的那个悄悄漂开——那是要花好几个小时才能查出来的一类错。
 */
export function createHealthSandboxPort(options: HealthSandboxPortOptions): HealthSandboxPort {
  const log = options.log ?? noopLog;
  const api = options.api ?? new SandboxApiClient();

  return {
    async open(input): Promise<HealthSandboxHandle> {
      const runId = prefixedId(HEALTH_RUN_PREFIX);
      const clone = await cloneRepo({
        runId,
        url: options.repo.url,
        commit: options.repo.commit,
        token: await options.repo.token(),
        log,
      });
      let sandboxId: string | null = null;
      try {
        const sandbox = await options.manager.createSandbox({ runId, image: input.image });
        sandboxId = sandbox.sandboxId;
        const endpoint = sandbox.endpoint ?? "";
        const authToken = sandbox.authToken ?? "";
        if (endpoint === "" || authToken === "") {
          throw new Error(`体检沙箱 ${sandbox.sandboxId} 建好了但没有 endpoint/token`);
        }
        await injectRepo({
          api,
          target: { endpoint, authToken, sandboxId: sandbox.sandboxId },
          clone,
          ...(options.workspaceDir === undefined ? {} : { workspaceDir: options.workspaceDir }),
          log,
        });
        return { sandboxId: sandbox.sandboxId, endpoint, authToken };
      } catch (error) {
        // 半成品容器不能留在那里等 sweeper（它也许要等半小时）。**但也不吞原始错误**。
        if (sandboxId !== null) {
          await options.manager
            .destroySandbox(sandboxId, "env_health_open_failed")
            .catch((inner: unknown) => log("warn", "体检沙箱回滚失败（留给 sweeper）", { sandboxId, error: String(inner) }));
        }
        throw error;
      } finally {
        await removeRunDir(runId).catch(() => undefined);
      }
    },

    async exec(input: HealthExecInput): Promise<HealthExecResult> {
      const outcome = await api.execAndWait(
        input.endpoint,
        input.authToken,
        { cmd: input.cmd, cwd: input.cwd, timeoutMs: input.timeoutMs },
        { maxCaptureBytes: HEALTH_MAX_OUTPUT_BYTES },
      );
      return {
        exitCode: outcome.exitCode,
        timedOut: outcome.state === "timeout" || outcome.state === "killed",
        output: [outcome.stdout, outcome.stderr].filter((part) => part !== "").join("\n"),
        durationMs: outcome.durationMs ?? 0,
      };
    },

    async destroy(sandboxId: string): Promise<void> {
      try {
        await options.manager.destroySandbox(sandboxId, "env_health_checked");
      } catch (error) {
        if ((error as { reason?: string }).reason === "sandbox_missing") return;
        throw error;
      }
    },
  };
}

/**
 * 单条命令收下来的输出上限。体检要的是退出码与一段可读的失败信息，
 * 不是完整的构建日志（完整的那份由 `health.ts` 自己写进日志落点）。
 */
export const HEALTH_MAX_OUTPUT_BYTES = 256 * 1024;
