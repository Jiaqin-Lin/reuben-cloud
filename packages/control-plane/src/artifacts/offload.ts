/**
 * 归档的编排（Phase 10 §2/§3）：**在沙箱被销毁之前**，把它这一生做出来的东西
 * 全部落到对象存储里。
 *
 * 【顺序是设计的一部分】差、存档、日志三步必须按这个顺序做：
 *   ① `GET /diff`        → `runs/<runId>/diff.patch`（小、快，毁了也最不心疼）
 *   ② `GET /archive?dryRun=1` → 体积软配额（只看一眼，不阻断）
 *   ③ `GET /archive`     → `runs/<runId>/workspace-<sandboxId>.tar.gz`（大头）
 *   ④ `truncated=true` 的执行日志 → `runs/<runId>/exec/<executionId>.log`
 * 反向做的话，最贵的归档会先失败、而便宜又独立的 diff 白丢一次机会。
 *
 * 【为什么 diff / dryRun 的失败不阻断，归档与日志的失败要阻断】
 *  - diff：归档里**本来就包含**同一份改动（归档是整个 workspace）。diff 只是一份更小、
 *    更适合贴进 PR 的视图。它拉不下来是缺了一份方便，不是丢了产出。
 *  - dryRun：它只是个体积估计，拿不到就跳过配额检查，不影响能不能存。
 *  - archive：它是产出的**兜底载体**，这一份没上去，销毁之后就真的没有第二份了。
 *  - exec_log：只有 `truncated=true` 的执行才转存，而那种执行的完整输出**事件流里没有**。
 *    它失败等于永久丢掉那段输出——所以除"日志本来就不在了"（404）以外都要抛，
 *    交给上层去重试/宽限（见 `SandboxManager` 的销毁流程）。
 *
 * 【为什么每个对象都在上传成功之后才写 artifacts 行】`db/artifacts.ts` 的注释写得很直白：
 * 一行"指向不存在对象的 artifact"比没有这行更坏。这里遵守它——`#record` 只在上传的
 * Promise resolve 之后才被调用，失败路径上不写任何行。
 *
 * 【重试与幂等】`offloadWithRetries` 就是 spec 的"指数退避重试 3 次"。重试会把 diff 再传
 * 一遍、归档再传一遍——对象 key 是固定的（同一次运行的同一个产物），`artifacts` 表上的
 * 唯一索引让第二次写变成 UPDATE（见 `003_artifact_object_key.sql`），所以不会留下
 * 两行指向同一个对象。
 */

import { Readable } from "node:stream";
import type { ArtifactKind } from "../db/artifacts.ts";
import { insertArtifact } from "../db/artifacts.ts";
import type { Db } from "../db/client.ts";
import type { ExecutionRow } from "../db/executions.ts";
import { listExecutions } from "../db/executions.ts";
import type { SandboxRow } from "../db/sandboxes.ts";
import { SandboxApiError, SandboxApiClient } from "../client/sandbox-api.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { prefixedId } from "../ulid.ts";
import type { ArtifactStore, StoredObject } from "./store.ts";

// ---------------------------------------------------------------- Key 布局

/**
 * 对象 key 的布局（spec Phase 10 §1）。
 *
 * 【为什么 diff 的 key 里没有 sandboxId，归档的却有】同一次 Run 重新换一个沙箱再跑时，
 * `diff.patch` 代表"这次 Run 最新的产出"——后一次覆盖前一次是**语义正确的**
 * （权威产出永远是最后一次）。而归档是某一台沙箱的完整快照，两台沙箱的归档不是同一件
 * 东西，必须能共存。`transcript.jsonl` 是 Phase 11 的，放在这里是为了让"key 长什么样"
 * 只有一个出处。
 */
export const artifactKey = {
  diff: (runId: string): string => `runs/${runId}/diff.patch`,
  archive: (runId: string, sandboxId: string): string => `runs/${runId}/workspace-${sandboxId}.tar.gz`,
  execLog: (runId: string, executionId: string): string => `runs/${runId}/exec/${executionId}.log`,
  /** Phase 11：一次 Run 的 transcript（同样的布局约定，这里只声明）。 */
  transcript: (runId: string): string => `runs/${runId}/transcript.jsonl`,
} as const;

// ---------------------------------------------------------------- 类型

/** 上传成功的一条产物（artifacts 行的摘要）。 */
export interface ArtifactSummary {
  id: string;
  kind: ArtifactKind;
  objectKey: string;
  sizeBytes: number;
  sha256: string;
}

/** 失败在哪个环节。`archive` / `exec_log` 会阻断销毁，`diff` / `dry_run` 只记警告。 */
export type OffloadStep = "diff" | "archive" | "exec_log";

export class OffloadError extends Error {
  readonly step: OffloadStep;

  constructor(step: OffloadStep, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OffloadError";
    this.step = step;
  }
}

export interface OffloadReport {
  sandboxId: string;
  /** 实际用的 key 前缀（`run_id` 缺失时退化成 sandboxId，见 `offload()`）。 */
  runId: string;
  /** 上传成功的产物（按上传顺序）。 */
  artifacts: ArtifactSummary[];
  /** diff 的结构化摘要（拿不到就是 null）。 */
  diff: { files: number; patchBytes: number; truncated: boolean } | null;
  /** `dryRun` 的体积估计（拿不到就是 null）。 */
  archiveEstimate: { sizeBytes: number; fileCount: number } | null;
  /** 归档体积超过软配额。**只警告**，不影响归档是否成功。 */
  overQuota: boolean;
  /** 上传成功的 `exec_log` 条数。 */
  execLogs: number;
  /** 没做成但不阻断销毁的环节（目前只有 diff 与 dryRun）。 */
  warnings: string[];
  /** 跳过归档的原因（沙箱从没起来过）。有值时其余字段都是空的。 */
  skipped: string | null;
}

export interface OffloadRetryPolicy {
  /** 总尝试次数（含第一次）。默认 3。 */
  attempts?: number;
  /** 第一次重试前的等待；后续按 factor 指数增长。默认 500ms。 */
  backoffMs?: number;
  /** 退避倍数。默认 2。 */
  backoffFactor?: number;
}

export const DEFAULT_OFFLOAD_ATTEMPTS = 3;
export const DEFAULT_OFFLOAD_BACKOFF_MS = 500;

export interface ArtifactOffloaderOptions {
  db: Db;
  store: ArtifactStore;
  api?: SandboxApiClient;
  /**
   * 归档体积的**软**配额（字节）。不给就用沙箱自己的 `limits.diskMb`——
   * 卷的大小是"这份归档大概能长到多大"最自然的参照物（附录 A-6）。
   */
  maxArchiveBytes?: number;
  log?: LogFn;
}

// ---------------------------------------------------------------- 实现

/**
 * 一台沙箱的产出 → 对象存储。**单次尝试，不重试**（重试是上层的事，见
 * `offloadWithRetries`）。调用方要么拿到"全部完成"的报告，要么拿到一个
 * 指明失败环节的 `OffloadError`。
 */
export class ArtifactOffloader {
  readonly #db: Db;
  readonly #store: ArtifactStore;
  readonly #api: SandboxApiClient;
  readonly #maxArchiveBytes: number | null;
  readonly #log: LogFn;

  constructor(options: ArtifactOffloaderOptions) {
    this.#db = options.db;
    this.#store = options.store;
    this.#api = options.api ?? new SandboxApiClient();
    this.#maxArchiveBytes = options.maxArchiveBytes ?? null;
    this.#log = options.log ?? noopLog;
  }

  /**
   * 跑一次完整的归档。**流式**：`/archive` 与执行日志都是"沙箱的响应体 → store 的上传"，
   * 中间只在管道里（不是内存里）经过。
   */
  async offload(sandbox: SandboxRow): Promise<OffloadReport> {
    // `run_id` 可空（M3 之前 tasks/runs 表还不存在）。key 仍然要稳定且唯一：
    // 用 sandboxId 顶上，并在报告里如实写出用的是哪个前缀。
    const runId = sandbox.run_id ?? sandbox.id;
    const report: OffloadReport = {
      sandboxId: sandbox.id,
      runId,
      artifacts: [],
      diff: null,
      archiveEstimate: null,
      overQuota: false,
      execLogs: 0,
      warnings: [],
      skipped: null,
    };

    const endpoint = sandbox.endpoint;
    const token = sandbox.auth_token;
    if (endpoint === null || token === null) {
      // 从没起来过的沙箱（create 失败、CREATING 就被扫到）没有任何产出可归档。
      // 这不是失败：**它连 agent 都没有**，硬要去连只会得到一次没有意义的连接错误。
      report.skipped = "no_endpoint";
      return report;
    }

    // ---- ① diff：非致命
    try {
      const diff = await this.#api.diff(endpoint, token);
      // 超限的 patch 正文不在 JSON 里（Phase 3 备注 4）：走 raw 读回来，
      // 与归档同样是流式的。内联的 patch 本来就只有 2 MiB 上限，直接包成流即可。
      const body =
        diff.truncated && diff.patchLogPath !== null
          ? await this.#api.readRaw(endpoint, token, diff.patchLogPath)
          : Readable.from([diff.patch ?? ""]);
      const stored = await this.#store.put(artifactKey.diff(runId), body);
      report.artifacts.push(await this.#record(sandbox, "diff", stored));
      report.diff = { files: diff.files.length, patchBytes: diff.patchBytes, truncated: diff.truncated };
    } catch (error) {
      // 见文件头：归档里也有同一份改动，所以这里只降级成警告。
      const message = `diff 转存失败（归档继续）：${messageOf(error)}`;
      report.warnings.push(message);
      this.#log("warn", `沙箱 ${sandbox.id} ${message}`);
    }

    // ---- ② dryRun：非致命，只做软配额判断
    try {
      report.archiveEstimate = await this.#api.archiveStats(endpoint, token);
    } catch (error) {
      const message = `归档体积估计失败（跳过配额检查）：${messageOf(error)}`;
      report.warnings.push(message);
      this.#log("warn", `沙箱 ${sandbox.id} ${message}`);
    }
    const quotaBytes = this.#maxArchiveBytes ?? sandbox.limits.diskMb * 1024 * 1024;
    if (report.archiveEstimate !== null && report.archiveEstimate.sizeBytes > quotaBytes) {
      report.overQuota = true;
      // 软限制：超过就记一条，**不阻断**。归档的价值高于那一点空间占用。
      this.#log("warn", `沙箱 ${sandbox.id} 的归档体积超过软配额，仍然会存`, {
        sizeBytes: report.archiveEstimate.sizeBytes,
        quotaBytes,
      });
    }

    // ---- ③ archive：致命。这一份没上去，销毁之后就没有第二份了。
    try {
      const stream = await this.#api.readArchive(endpoint, token);
      const stored = await this.#store.put(artifactKey.archive(runId, sandbox.id), stream);
      report.artifacts.push(await this.#record(sandbox, "workspace_archive", stored));
    } catch (error) {
      throw new OffloadError("archive", `归档上传失败：${messageOf(error)}`, { cause: error });
    }

    // ---- ④ truncated=true 的执行日志：致命（除日志本来就不在了）
    const LOG_LIMIT = 500;
    const executions = await listExecutions(this.#db, { sandboxId: sandbox.id, limit: LOG_LIMIT });
    if (executions.length === LOG_LIMIT) {
      // 一次 TTL 清扫里的沙箱通常只有几条执行；撞上限说明出了别的事，
      // 只转最新的 500 条，并留下一条能被搜到的警告（不能静默截断）。
      const message = `执行记录超过 ${LOG_LIMIT} 条，只转存最新的这些`;
      report.warnings.push(message);
      this.#log("warn", `沙箱 ${sandbox.id} ${message}`);
    }
    for (const execution of executions) {
      if (!shouldTransferLog(execution)) continue;
      try {
        const stream = await this.#api.readRaw(endpoint, token, execution.log_path!);
        const stored = await this.#store.put(artifactKey.execLog(runId, execution.id), stream);
        report.artifacts.push(await this.#record(sandbox, "exec_log", stored));
        report.execLogs += 1;
      } catch (error) {
        if (isMissingLog(error)) {
          // 日志文件已经不在沙箱里了（tmpfs 被清、agent 重启）。这时候连沙箱自己都
          // 给不出这份输出，重试不会让事情变好——降级成警告，别把销毁拖住。
          const message = `执行 ${execution.id} 的日志已经不在了：${messageOf(error)}`;
          report.warnings.push(message);
          this.#log("warn", `沙箱 ${sandbox.id} ${message}`);
          continue;
        }
        throw new OffloadError("exec_log", `执行 ${execution.id} 的日志转存失败：${messageOf(error)}`, {
          cause: error,
        });
      }
    }

    return report;
  }

  /**
   * 带指数退避的归档（spec：重试 3 次）。**最后一次失败原样抛出去**，
   * 由调用方决定"标记 ERROR 等宽限"还是"强制销毁"。
   */
  async offloadWithRetries(sandbox: SandboxRow, policy: OffloadRetryPolicy = {}): Promise<OffloadReport> {
    const attempts = Math.max(1, policy.attempts ?? DEFAULT_OFFLOAD_ATTEMPTS);
    const backoffMs = policy.backoffMs ?? DEFAULT_OFFLOAD_BACKOFF_MS;
    const factor = policy.backoffFactor ?? 2;

    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.offload(sandbox);
      } catch (error) {
        lastError = error;
        if (attempt >= attempts) break;
        const waitMs = Math.round(backoffMs * factor ** (attempt - 1));
        this.#log("warn", `沙箱 ${sandbox.id} 归档第 ${attempt}/${attempts} 次失败，${waitMs}ms 后重试`, {
          error: messageOf(error),
        });
        await delay(waitMs);
      }
    }
    throw lastError;
  }

  /** 上传成功之后写一行 artifacts。唯一索引让"同一个对象重复上传"落到 UPDATE 上。 */
  async #record(sandbox: SandboxRow, kind: ArtifactKind, stored: StoredObject): Promise<ArtifactSummary> {
    const row = await insertArtifact(this.#db, {
      id: prefixedId("art"),
      runId: sandbox.run_id,
      sandboxId: sandbox.id,
      kind,
      objectKey: stored.objectKey,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
    });
    return { id: row.id, kind: row.kind, objectKey: row.object_key, sizeBytes: row.size_bytes, sha256: row.sha256 };
  }
}

/**
 * 这条执行要不要转存日志。**只有 `truncated=true` 的才要**（spec 的重点）：
 * 没截断的输出在事件流里已经完整送到 CP 了，再存一份是纯粹的重复。
 * `running` 的执行不转存（日志还在写，转存一个半截文件没有意义）。
 */
function shouldTransferLog(execution: ExecutionRow): boolean {
  return execution.truncated && execution.state !== "running" && execution.log_path !== null;
}

/** `readRaw` 的 404：日志已经不在了（见上面那段注释）。 */
function isMissingLog(error: unknown): boolean {
  return error instanceof SandboxApiError && error.reason === "http_error" && error.status === 404;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
