/**
 * `apply.ts` —— 把沙箱里的改动变成 CP 这边**可验证的一份工作区**。
 *
 * 流程（spec §4）：
 *   1. `GET /diff?base=<sha>` 拿 patch（超上限时它是外置文件，用 `GET /files?raw=1` 取回）
 *   2. 在 CP 的 clone 上 `git apply --binary`
 *   3. **忠实效验**：CP 自己再算一次 `git diff <base>` 的 sha256，必须等于沙箱返回的 patch
 *      的 sha256。不等就说明应用不完整（CRLF、filemode、空白丢失），
 *      绝不能推出一个"和沙箱里验证过的不是同一份"的 commit。
 *   4. 任何一步失败 → **archive 回退**：`GET /archive` → 空目录里解包 →
 *      用整棵树替换 clone 的工作区 → 从这棵树上生成 patch。
 *
 * 【为什么回退也要覆盖 `/diff` 自己失败的情况】Phase 3 备注 4：外置 patch 有第二道
 * 上限（`MAX_PATCH_SPILL_BYTES`，256 MiB），超了回 413。那条上限存在的意义就是
 * "CP 还有 archive 这条路"——所以 413 必须在**这里**被接住，而不是变成一个失败的任务。
 * 反过来，`unreachable`（连不上沙箱）不回退：archive 是同一条链路，回退只会把
 * 真正的错误（沙箱没了）换成一个更难读的错误。
 *
 * 【为什么替换工作区时保留 `.git`】archive 是 workspace 的整棵树，里面有沙箱自己那份
 * `.git`（从 CP 灌进去的）。我们**不要**它：CP 这边的 `.git` 才是要生成 commit 的那份，
 * 而且沙箱内的 index 带着 `git add -A -N` 的 intent-to-add 状态。
 * 所以归档请求带 `exclude=.git`，替换时也只保留自己这一份。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AgentDiff, AgentDiffFile } from "../client/sandbox-api.ts";
import { SandboxApiError } from "../client/sandbox-api.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import type { RepoClone } from "./clone.ts";
import { gitOrThrow, killProcessTree, writeWorktreeDiff } from "./git.ts";
import { RepoError } from "./types.ts";
import type { RepoApi, SandboxTarget } from "./types.ts";

/** 取回外置 patch / 解包归档的时限。 */
export const APPLY_TIMEOUT_MS = 300_000;

export interface CollectSandboxChangesInput {
  api: RepoApi;
  target: SandboxTarget;
  clone: RepoClone;
  /** `/diff?path=` 的参数（仓库在沙箱里的位置）。缺省不传 = 写根（Phase 9 把仓库解到 `/workspace`）。 */
  repoPath?: string;
  timeoutMs?: number;
  log?: LogFn;
}

export interface CollectedChanges {
  /** clone 工作区现在的状态：apply 或 archive 回退之后的树。 */
  dir: string;
  baseSha: string;
  /** 最终用来 push 的那份 patch（CP 侧生成，落在 run 目录里）。 */
  patch: { file: string; bytes: number; sha256: string };
  /** 改动的文件（来自沙箱的 `/diff`；`/diff` 直接失败时是空数组）。 */
  files: AgentDiffFile[];
  /** `patch` = 沙箱的 patch 应用并验证通过；`archive` = 走了回退。 */
  source: "patch" | "archive";
  /** 沙箱返回的那份 patch 的 sha256；`/diff` 直接失败时是 null。 */
  sandboxPatchSha256: string | null;
  /** 回退时归档的字节数与 sha256（本身也是 Phase 10 的 artifact 素材）。 */
  archive: { bytes: number; sha256: string } | null;
  /** 发生了什么导致回退（只有 source=archive 时有值）。进日志与 PR 正文。 */
  fallbackReason: string | null;
}

/** 一次 `/diff` 结果在磁盘上的形态。 */
interface PatchOnDisk {
  file: string;
  bytes: number;
  sha256: string;
}

/**
 * 取回沙箱的改动并落到 CP 的工作区。**这是"出来"那条路的唯一入口**：
 * 调用方不需要知道这次到底是 patch 应用成功的、还是走 archive 回退的——
 * 它只需要知道 `clone.dir` 现在是一棵可信的树，`patch` 是它的证明。
 */
export async function collectSandboxChanges(input: CollectSandboxChangesInput): Promise<CollectedChanges> {
  const { api, target, clone } = input;
  const log = input.log ?? noopLog;
  const timeoutMs = input.timeoutMs ?? APPLY_TIMEOUT_MS;
  const runDir = path.dirname(clone.dir);
  const worktreePatchFile = path.join(runDir, "worktree.patch");

  // ---- 1. /diff。失败分两类：
  //   - `http_error`（413 patch_too_large、git_error…）→ archive 回退（见文件头）
  //   - `unreachable` / `invalid_response` → 直接抛：回退走的是同一条链路/同一种协议
  let diff: AgentDiff | null = null;
  let diffError: SandboxApiError | null = null;
  try {
    diff = await api.diff(target.endpoint, target.authToken, {
      base: clone.baseSha,
      ...(input.repoPath === undefined ? {} : { path: input.repoPath }),
    });
  } catch (error) {
    if (!(error instanceof SandboxApiError) || error.reason !== "http_error") throw error;
    diffError = error;
    log("warn", `GET /diff 失败（${error.agentError ?? error.status}），改用 archive 回退`, {
      sandboxId: target.sandboxId ?? null,
      message: error.message,
    });
  }

  // ---- 2. patch 落盘（内联写文件 / 外置流式取回）。这一步失败也是回退的候选：
  // 外置 patch 读不回来时，archive 还在。
  let sandboxPatch: PatchOnDisk | null = null;
  if (diff !== null) {
    try {
      sandboxPatch = await materializePatch(api, target, diff, path.join(runDir, "sandbox.patch"), timeoutMs);
    } catch (error) {
      log("warn", "取回 patch 失败，改用 archive 回退", {
        sandboxId: target.sandboxId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---- 3. 应用 + 忠实效验。
  let fallbackReason: string | null = null;
  if (sandboxPatch !== null) {
    try {
      await applyPatchFile(clone.dir, sandboxPatch.file);
      const tree = await writeWorktreeDiff(clone.dir, clone.baseSha, worktreePatchFile);
      if (tree.sha256 === sandboxPatch.sha256) {
        log("info", "沙箱改动已应用且忠实效验通过", {
          sandboxId: target.sandboxId ?? null,
          bytes: tree.bytes,
          sha256: tree.sha256,
        });
        return {
          dir: clone.dir,
          baseSha: clone.baseSha,
          patch: { file: worktreePatchFile, bytes: tree.bytes, sha256: tree.sha256 },
          files: diff?.files ?? [],
          source: "patch",
          sandboxPatchSha256: sandboxPatch.sha256,
          archive: null,
          fallbackReason: null,
        };
      }
      fallbackReason = "patch_sha256_mismatch";
      log("warn", "忠实效验失败：CP 重算的 diff 与沙箱的 patch 不一致，改用 archive 回退", {
        sandboxId: target.sandboxId ?? null,
        sandboxPatch: { bytes: sandboxPatch.bytes, sha256: sandboxPatch.sha256 },
        cpTree: { bytes: tree.bytes, sha256: tree.sha256 },
      });
    } catch (error) {
      fallbackReason = error instanceof RepoError && error.reason === "apply_failed" ? "apply_failed" : "apply_error";
      log("warn", "patch 应用失败，改用 archive 回退", {
        sandboxId: target.sandboxId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    fallbackReason ??= diffError === null ? "patch_unavailable" : `diff_${diffError.agentError ?? diffError.status}`;
  }

  // ---- 4. archive 回退。
  const archive = await replaceWorktreeFromArchive({
    api,
    target,
    clone,
    archiveDir: path.join(runDir, "archive"),
    timeoutMs,
    log,
  });
  const tree = await writeWorktreeDiff(clone.dir, clone.baseSha, worktreePatchFile);
  log("info", "archive 回退完成", {
    sandboxId: target.sandboxId ?? null,
    reason: fallbackReason,
    archiveBytes: archive.bytes,
    patchBytes: tree.bytes,
  });

  return {
    dir: clone.dir,
    baseSha: clone.baseSha,
    patch: { file: worktreePatchFile, bytes: tree.bytes, sha256: tree.sha256 },
    // `/diff` 成功过的话，它的文件列表仍然是最准确的描述（回退只换内容的来源，没换内容）。
    files: diff?.files ?? [],
    source: "archive",
    sandboxPatchSha256: sandboxPatch?.sha256 ?? null,
    archive,
    fallbackReason,
  };
}

/**
 * 把一次 `/diff` 的结果变成磁盘上的一个 patch 文件。
 *
 * 内联的 patch 是 JSON 字符串——它能被内联，说明沙箱那边确认过它是合法 UTF-8，
 * 所以 `Buffer.from(patch, "utf8")` 与 git 的原始字节逐字节相同（Phase 3 备注 5）。
 * 外置的用 `GET /files?raw=1` 流式取回，边收边算 sha256。
 */
async function materializePatch(
  api: RepoApi,
  target: SandboxTarget,
  diff: AgentDiff,
  destFile: string,
  timeoutMs: number,
): Promise<PatchOnDisk> {
  if (diff.truncated) {
    if (diff.patchLogPath === null) {
      throw new RepoError("patch_unfaithful", "沙箱说 patch 没有内联，但没给 patch_log_path");
    }
    const stream = await api.readRaw(target.endpoint, target.authToken, diff.patchLogPath, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const written = await streamToFile(stream, destFile);
    if (written.bytes !== diff.patchBytes) {
      throw new RepoError(
        "patch_unfaithful",
        `外置 patch 的字节数与 /diff 报的不一致：${written.bytes} != ${diff.patchBytes}`,
        { details: { bytes: written.bytes, declared: diff.patchBytes } },
      );
    }
    return { file: destFile, ...written };
  }

  const text = diff.patch ?? "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length !== diff.patchBytes) {
    throw new RepoError(
      "patch_unfaithful",
      `内联 patch 的字节数与 /diff 报的不一致：${bytes.length} != ${diff.patchBytes}`,
      { details: { bytes: bytes.length, declared: diff.patchBytes } },
    );
  }
  await mkdir(path.dirname(destFile), { recursive: true });
  await writeFile(destFile, bytes);
  return { file: destFile, bytes: bytes.length, sha256: sha256Of(bytes) };
}

/** `git apply --binary <patch>`。失败抛 `apply_failed`（调用方据此回退 archive）。 */
export async function applyPatchFile(dir: string, patchFile: string): Promise<void> {
  await gitOrThrow(["-C", dir, "apply", "--binary", patchFile], {
    reason: "apply_failed",
    context: { dir, patchFile },
  });
}

export interface ReplaceFromArchiveInput {
  api: RepoApi;
  target: SandboxTarget;
  clone: RepoClone;
  /** 解包的空目录（spec：在空目录里解）。 */
  archiveDir: string;
  timeoutMs?: number;
  log?: LogFn;
  /** 归档要排除的路径组件。默认 `[".git"]`（见文件头）。 */
  exclude?: readonly string[];
}

/**
 * `GET /archive` → 空目录里解包 → 用整棵树替换 clone 的工作区。
 *
 * 三件事都按 Phase 3 的提醒做：`--no-same-owner`、**不加** `-P/--absolute-names`、
 * 在空目录里解。加上 `exclude=.git`：沙箱那份 `.git` 对我们没有用（见文件头）。
 */
export async function replaceWorktreeFromArchive(
  input: ReplaceFromArchiveInput,
): Promise<{ bytes: number; sha256: string }> {
  const timeoutMs = input.timeoutMs ?? APPLY_TIMEOUT_MS;
  const log = input.log ?? noopLog;
  const exclude = input.exclude ?? [".git"];

  const stream = await input.api.readArchive(input.target.endpoint, input.target.authToken, {
    exclude,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const extracted = await extractTarGz(stream, input.archiveDir, timeoutMs);

  // 归档解出来是空的：要么沙箱的 workspace 真的空了（那 diff 也是空的），
  // 要么这条路本身出了问题。两种都不该继续往下走（会产出一次"什么都没改"的 push）。
  const entries = await readdir(input.archiveDir);
  if (entries.length === 0) {
    throw new RepoError("pack_failed", "archive 解出来是空的，拒绝用它替换工作区", {
      details: { archiveDir: input.archiveDir },
    });
  }

  await replaceWorktree(input.clone.dir, input.archiveDir);
  log("info", "已用 archive 替换 clone 的工作区", {
    archiveBytes: extracted.bytes,
    paths: entries.length,
    dir: input.clone.dir,
  });
  return extracted;
}

/** 把 tar.gz 流解开到 `destDir`（必须空）。返回 gzip 字节的字节数与 sha256。 */
async function extractTarGz(source: Readable, destDir: string, timeoutMs: number): Promise<{ bytes: number; sha256: string }> {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });

  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });

  const child = spawn("tar", ["xzf", "-", "--no-same-owner", "-C", destDir], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
  });
  const timer = setTimeout(() => killProcessTree(child), timeoutMs);
  timer.unref();

  // 顺序：先喂流，再看退出码。tar 提前退出时 pipeline 会以 EPIPE 拒绝——
  // 那种情况下真正的原因在 stderr 里，所以先抓住退出码再判断。
  const piped = pipeline(source, meter, child.stdin).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  const pipeError = await piped;

  if (code !== 0) {
    throw new RepoError("pack_failed", `解包 archive 失败（tar exit ${code}）：${stderr.trim()}`, {
      details: { destDir, pipeError: pipeError?.message ?? null },
    });
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** 替换工作区：删掉除了 `keep` 之外的所有东西，再把源目录的内容拷进去。 */
async function replaceWorktree(dir: string, sourceDir: string): Promise<void> {
  const kept = new Set([".git"]);
  for (const entry of await readdir(dir)) {
    if (kept.has(entry)) continue;
    await rm(path.join(dir, entry), { recursive: true, force: true });
  }
  // 符号链接按链接本体拷（dereference:false 是 fs.cp 的默认值，写出来是为了别被"顺手优化"掉）。
  await cp(sourceDir, dir, { recursive: true, force: true, dereference: false });
}

/** 流 → 文件，边写边算 sha256。 */
async function streamToFile(source: Readable, destFile: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  await mkdir(path.dirname(destFile), { recursive: true });
  await pipeline(source, meter, createWriteStream(destFile));
  return { bytes, sha256: hash.digest("hex") };
}

function sha256Of(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
