/**
 * `pack.ts` —— 把 clone 目录打成 tar.gz（**流**），外加"灌入之前先自证清白"的审计。
 *
 * 【为什么用系统 tar】零依赖，而且与沙箱侧的 `/archive` 是同一个实现口径
 * （`tar czf - -C <dir> .`，macOS 的 bsdtar 与 Linux 的 GNU tar 在这组参数上一致）。
 * 为了造一个 tar 去引一个打包库，会让"归档里到底是什么"变成第二个需要验证的东西。
 *
 * 【为什么要先审计再打包】§J 的红线是"沙箱里从来没有过任何 GitHub 凭据"，而这条线
 * 唯一的现实破口就是 `.git/config` 里被写进了一个带 token 的 remote URL。
 * `auditCloneConfig()` 在打包**之前**检查它——失败时沙箱还没被污染，代价是一行报错；
 * 灌进去之后才发现，代价是销毁一个沙箱和一次已经发出去的仓库内容。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";
import { gitOrThrow, killProcessTree } from "./git.ts";
import { RepoError } from "./types.ts";

/** 打包的时限。一个很大的仓库 + 慢磁盘，5 分钟够用。 */
export const PACK_TIMEOUT_MS = 300_000;

export interface PackResult {
  bytes: number;
  sha256: string;
}

export interface PackStream {
  /** tar 的 stdout。直接交给 `PUT /files`，不进内存。 */
  stream: Readable;
  /** 流结束（或失败）之后 resolve。消费者必须 await 它，否则失败会静默。 */
  result: Promise<PackResult>;
}

/**
 * 起一个 `tar czf - -C <dir> .`，把 stdout 作为流交出去。
 *
 * 消费者提前断掉（比如上传失败）时把 tar 杀掉：不杀的话，一个还在读目录的 tar
 * 会活到读完为止，在几百 MiB 的仓库上就是几分钟的孤儿进程。
 */
export function packDirectory(dir: string, options: { timeoutMs?: number; log?: LogFn } = {}): PackStream {
  const timeoutMs = options.timeoutMs ?? PACK_TIMEOUT_MS;
  const log = options.log ?? noopLog;

  const child = spawn("tar", ["czf", "-", "-C", dir, "."], {
    // COPYFILE_DISABLE=1：macOS 的 bsdtar 默认把扩展属性写成 `._*` 的 AppleDouble
    // 条目，那些条目到 Linux 里会变成**真实文件**，于是灌进去的仓库立刻不干净
    // （`git status` 里会出现一堆 `._foo`）。这是 Apple 工具链的开关，
    // Linux 的 GNU tar 看不到它、也不用管它。（Phase 7 的 fixture 踩过同一个坑。）
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const hash = createHash("sha256");
  let bytes = 0;
  let stderr = "";
  let finished = false;
  child.stdout.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4_000);
  });

  const result = new Promise<PackResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new RepoError("pack_failed", `tar 打包超过 ${timeoutMs}ms`, { details: { dir } }));
    }, timeoutMs);
    timer.unref();

    child.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(new RepoError("pack_failed", `tar 起不来：${error.message}`, { details: { dir } }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      if (code === 0) resolve({ bytes, sha256: hash.digest("hex") });
      else reject(new RepoError("pack_failed", `tar -czf 失败（exit ${code}）：${stderr.trim()}`, { details: { dir } }));
    });
  });
  // 没人 await 的失败不该变成 unhandledRejection（上传先失败时就是这个形状）。
  result.catch(() => undefined);

  // stdout 被消费者销毁 / tar 自己写完时，只有在进程还活着的情况下才补一刀。
  child.stdout.once("close", () => {
    if (child.exitCode === null && child.signalCode === null) killProcessTree(child);
    log("info", `仓库打包结束`, { bytes });
  });

  return { stream: child.stdout, result };
}

/**
 * 打包并收进内存。**只有测试与小仓库用它**——产品路径是流式的（`packDirectory`）。
 */
export async function collectPack(
  dir: string,
  options: { timeoutMs?: number; log?: LogFn } = {},
): Promise<{ tarball: Buffer } & PackResult> {
  const { stream, result } = packDirectory(dir, options);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const packed = await result;
  return { tarball: Buffer.concat(chunks), ...packed };
}

// ---------------------------------------------------------------- 灌入前的审计

/**
 * git config 行里不该出现的东西。**匹配整行**（键 + 值）：token 写在
 * `remote.origin.url=https://x-access-token:…@github.com/…` 里的那种写法，
 * 键名看不出任何问题，值才是凭据（spec §3 的原话也是 `grep -i token` 整行）。
 */
const CREDENTIAL_LINE_PATTERN = /(token|authoriz|extraheader|password|secret|credential)/i;

export interface CloneConfigAudit {
  entries: number;
  /** 疑似凭据的**键名**（值绝不进日志、绝不进错误信息）。 */
  suspiciousKeys: string[];
}

/**
 * 灌入前的实现验证（spec §3）：`git -C <cloneDir> config -l | grep -i token` 必须为空。
 *
 * 命中的时候抛 `credentials_in_clone`，并且**只报键名**——把值打进日志等于把凭据
 * 写进日志，那正好是我们想避免的那件事。
 */
export async function auditCloneConfig(dir: string): Promise<CloneConfigAudit> {
  const output = await gitOrThrow(["-C", dir, "config", "--local", "--list"], {
    reason: "not_a_repository",
    context: { dir },
  });
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  const suspiciousKeys = lines
    .filter((line) => CREDENTIAL_LINE_PATTERN.test(line))
    .map((line) => {
      const eq = line.indexOf("=");
      return eq < 0 ? line.trim() : line.slice(0, eq).trim();
    });
  if (suspiciousKeys.length > 0) {
    throw new RepoError("credentials_in_clone", `clone 的 .git/config 里有疑似凭据的项：${suspiciousKeys.join("、")}`, {
      details: { keys: suspiciousKeys, dir },
    });
  }
  return { entries: lines.length, suspiciousKeys };
}

export interface SecretScanOptions {
  /** 单个文件超过这个大小就跳过。默认 8 MiB。 */
  maxFileBytes?: number;
  /** 一共最多读这么多字节。默认 512 MiB。 */
  maxTotalBytes?: number;
}

/**
 * 在整棵树里搜这些字符串，返回命中的相对路径。
 *
 * 这是"零凭据"这条红线的**取证工具**：测试用它证明 `clone` 之后磁盘上没有 token，
 * 也证明托盘里（`/tmp/reuben-cloud-cp`）没有任何一处泄漏。
 * 产品路径不靠它——产品靠的是"token 不进 URL、不进文件"的结构，
 * 以及灌入之前的 `auditCloneConfig()`。
 */
export async function scanForSecrets(
  root: string,
  needles: readonly string[],
  options: SecretScanOptions = {},
): Promise<string[]> {
  const needleBuffers = needles.filter((needle) => needle !== "").map((needle) => Buffer.from(needle, "utf8"));
  if (needleBuffers.length === 0) return [];
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
  let budget = options.maxTotalBytes ?? 512 * 1024 * 1024;
  const hits: string[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 读不了的目录跳过：这是一个取证工具，不该因为一个权限问题整个失败。
    }
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      // 不跟随符号链接：一个指向 / 的链接会让扫描变成"扫全盘"。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      let info;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.size > maxFileBytes || budget <= 0) continue;
      budget -= info.size;
      let content: Buffer;
      try {
        content = await readFile(full);
      } catch {
        continue;
      }
      if (needleBuffers.some((needle) => content.includes(needle))) hits.push(relative);
    }
  };

  await walk(root, "");
  return hits;
}
