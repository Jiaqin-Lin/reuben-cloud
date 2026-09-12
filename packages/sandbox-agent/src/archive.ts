/**
 * `GET /archive` —— 把整个 workspace 流式打成 tar.gz 吐出去。
 *
 * 【为什么走流】归档是二进制大对象：base64 进 JSON 会膨胀 33%，进事件流会触发截断，
 * 都不能用。CP 直接把它转给对象存储（Phase 10），沙箱这一侧不落盘。
 *
 * 【默认不排除任何东西】§J.6 明确要求包含被 `.gitignore` 排除的构建产物——这正是它
 * 作为 patch 兜底方案的价值。GNU tar 的 `--exclude-vcs-ignores` 是可选开关、默认不读
 * `.gitignore`，所以"什么都不传"就是对的。要排除就由 CP 自己用 `?exclude=` 说。
 *
 * 【dryRun】CP 在拉一个 2 GiB 的归档之前要知道它有多大（附录 A-6），所以有
 * `?dryRun=1`：只数一遍目录树，返回 `{size_bytes, file_count}`，不发流。
 * 它在 Node 里走目录，不调 `du -sb`——后者是 GNU 专有（macOS 的 BSD du 没有 `-b`），
 * 而且 `file_count` 本来也得自己数。dryRun 不占 BUSY 槽：它不产生流、不会撕裂归档，
 * 而 CP 最需要这个数字的时刻恰恰可能是沙箱正忙的时候。
 *
 * 【三者都要能被打断】客户端断开 → 杀掉 tar 进程组；超过 `streamTimeoutMs` → 同理；
 * 流出字节超过 `maxArchiveBytes` → 断连接。少了第一条，客户端一断就留下一个继续打包的
 * tar，反复几次就能把容器塞满（tar 的 stdout 是全量 workspace，不是小数目）。
 *
 * 【在链路中的位置】server.ts 转交 `GET /archive`；本文件负责
 * 「数体积或占槽 → 起 tar → 边流边数 → 收尾」，异常路径由 finally 兜住。
 */

import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import type { Config } from "./config.ts";
import type { ExecutionRegistry } from "./exec/registry.ts";
import { sendError, sendJson } from "./http.ts";
import { beginJob, spawnManaged, waitForDrain, type ChildExit, type JobGuard } from "./stream.ts";
import type { ArchiveDryRunResponse } from "./types.ts";

/** `?exclude=` 最多几项。argv 的长度得有头，不然一个请求就能把进程参数撑爆。 */
const MAX_EXCLUDE_ITEMS = 64;
/** 单个 exclude 项最多几个字符。 */
const MAX_EXCLUDE_ITEM_CHARS = 256;

/**
 * 处理一条 `GET /archive`。响应完全由本函数发出（成功/失败都是），
 * server.ts 只负责把 URL 转交过来。
 */
export async function handleArchive(
  res: ServerResponse,
  url: URL,
  registry: ExecutionRegistry,
  config: Config,
): Promise<void> {
  const dryRun = parseFlag(url.searchParams.get("dryRun"));
  if (dryRun === "invalid") {
    sendError(res, 400, "invalid_dry_run", "dryRun must be `1`/`true` or `0`/`false`");
    return;
  }

  const excludes = parseExcludes(url.searchParams.get("exclude"));
  if (excludes === null) {
    sendError(
      res,
      400,
      "invalid_exclude",
      `exclude must be a comma-separated list of at most ${MAX_EXCLUDE_ITEMS} names`,
    );
    return;
  }

  if (dryRun) {
    // 见文件头：dryRun 不占 BUSY 槽。
    try {
      sendJson(res, 200, await measureTree(config.workspaceRoot, excludes));
    } catch (error) {
      sendError(res, 500, "internal_error", error instanceof Error ? error.message : String(error));
    }
    return;
  }

  const job = beginJob(registry, config, res, "archive");
  if (!job.ok) {
    sendJson(res, job.status, job.body);
    return;
  }
  const guard = job.guard;

  try {
    await streamArchive(res, guard, config, excludes);
  } catch (error) {
    // 兜底：streamArchive 自己处理了所有已知错误，这里只是不让 BUSY 槽跟着异常一起漏掉。
    sendError(res, 500, "internal_error", error instanceof Error ? error.message : String(error));
  } finally {
    guard.finish();
  }
}

/**
 * 打包并流出去。
 *
 * 输出的形状是 `tar czf - -C <workspaceRoot> [--exclude=…] .`：
 * 归档顶层是 workspace 根（`./...`），不是某个 repo 子目录——CP 解包时按这个结构走。
 * 用系统 tar + spawn：零依赖，而且 macOS 的 bsdtar 与 Linux 的 GNU tar 在这个用法上一致。
 */
async function streamArchive(
  res: ServerResponse,
  guard: JobGuard,
  config: Config,
  excludes: string[],
): Promise<void> {
  const cmd = [
    "tar",
    "czf",
    "-",
    "-C",
    config.workspaceRoot,
    // 排除项放在文件列表之前：tar 的模式匹配按出现顺序生效。
    ...excludes.map((item) => `--exclude=${item}`),
    ".",
  ];
  const spawned = await spawnManaged(guard, { cmd, cwd: config.workspaceRoot, config });
  if (!spawned.ok) {
    // ENOENT 之类在发任何字节之前就被 spawnManaged 收住了，所以还能回一个结构化错误。
    sendError(res, 500, "spawn_failed", `tar could not be started: ${spawned.error.message}`);
    return;
  }
  const proc = spawned.proc;

  let headersSent = false;
  let streamed = 0;
  let overflow = false;
  let readError: Error | null = null;

  try {
    for await (const chunk of proc.stdout) {
      // 超时/断线：guard 已经把进程组杀了，不必再读。
      if (guard.abortReason !== null) break;

      const buf = chunk as Buffer;
      streamed += buf.length;
      if (streamed > config.maxArchiveBytes) {
        overflow = true;
        guard.killAll();
        break;
      }

      if (!headersSent) {
        // 第一个字节到了才开响应头：在那之前 tar 还可能起不来/立刻失败，JSON 500 还来得及发。
        // 先开 200 再发现失败，客户端就只看到一个空的成功响应，那是最难查的一类故障。
        res.writeHead(200, {
          "Content-Type": "application/gzip",
          "Cache-Control": "no-store",
        });
        headersSent = true;
      }

      // 背压：内核缓冲满了就等 drain。waitForDrain 会和中止赛跑，不会死等。
      if (!res.write(buf)) {
        await waitForDrain(res, guard);
        if (guard.abortReason !== null) break;
      }
    }
  } catch (error) {
    // 客户端断了 / 进程被杀：下面按 guard.abortReason 统一收尾。
    readError = error as Error;
  }

  const exit = await proc.exited;

  if (guard.abortReason !== null) {
    if (!res.writableEnded) res.destroy();
    if (guard.abortReason === "timeout") {
      console.error(`[sandbox-agent] archive timed out after ${guard.timeoutMs}ms`);
    }
    return;
  }

  if (overflow) {
    if (!res.writableEnded) res.destroy();
    console.error(`[sandbox-agent] archive exceeded ${config.maxArchiveBytes} bytes; connection aborted`);
    return;
  }

  if (readError !== null) {
    if (!res.writableEnded) res.destroy();
    console.error(`[sandbox-agent] archive read failed: ${readError.message}`);
    return;
  }

  if (!headersSent) {
    // 一个字节都没出来：没有可以承诺的流式响应，老老实实回一个结构化错误。
    sendError(res, 500, "archive_failed", archiveFailureMessage(exit, proc.stderrText()));
    return;
  }

  if (exit.code !== null && exit.code >= 2) {
    // tar 认为这次归档失败了。响应已经流了一半，唯一诚实的收尾是把连接拆掉——
    // 正常 end() 会让 CP 把一份残缺的 tar 当成完整产物。
    res.destroy();
    console.error(`[sandbox-agent] archive failed: ${archiveFailureMessage(exit, proc.stderrText())}`);
    return;
  }

  // 0 = 成功；1 = "有些文件读的时候变了"这类警告——归档本身是完整的，照常收尾，只记一笔。
  if (exit.code === 1) {
    console.error(`[sandbox-agent] archive warnings: ${proc.stderrText().trim()}`);
  }
  res.end();
}

/**
 * 数一遍目录树，供 dryRun 用。
 *
 * 口径：每个条目的 `lstat().st_size` 累加（目录本身也算，符号链接按链接长度算），
 * 不跟随符号链接——和 tar 的默认行为、以及 `du -sb` 的口径一致。
 * `file_count` 只数非目录条目（普通文件 + 符号链接 + FIFO 这类"其他"）。
 *
 * excludes 按**路径组件名**匹配（任何深度），和 tar 对不带斜杠的 `--exclude` 模式
 * 的语义一致。带通配符的项在 dryRun 里按字面名匹配，可能把体积算大——这是刻意的：
 * dryRun 只服务一个"要不要拉"的软判断，宁可高估。
 */
async function measureTree(root: string, excludes: string[]): Promise<ArchiveDryRunResponse> {
  let sizeBytes = 0;
  let fileCount = 0;

  const walk = async (dir: string): Promise<void> => {
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      // 读不了的目录跳过：dryRun 是个估计值，不因为一个权限问题整个失败（tar 那边会如实报错）。
      return;
    }

    for (const item of items) {
      if (excludes.includes(item.name)) continue;
      const full = path.join(dir, item.name);
      const stats = await lstat(full).catch(() => null);
      if (stats === null) continue; // 竞争：刚列出来就没了
      sizeBytes += stats.size;
      if (item.isDirectory()) await walk(full);
      else fileCount += 1;
    }
  };

  await walk(root);
  return { size_bytes: sizeBytes, file_count: fileCount };
}

/** 解析 `dryRun`。缺省 false；传了但值不认识返回 "invalid"（宁可 400 也不要把拼错当成 false）。 */
function parseFlag(raw: string | null): boolean | "invalid" {
  if (raw === null) return false;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return "invalid";
}

/**
 * 解析 `?exclude=.git,node_modules`。返回 null = 参数不合法（400）。
 * 缺省 = 空数组（什么都不排除）；重复项去重，顺序保留——它会直接变成 tar 的 argv。
 */
function parseExcludes(raw: string | null): string[] | null {
  if (raw === null) return [];
  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (items.length === 0 || items.length > MAX_EXCLUDE_ITEMS) return null;
  for (const item of items) {
    if (item.length > MAX_EXCLUDE_ITEM_CHARS || item.includes("\0")) return null;
  }
  return [...new Set(items)];
}

/** tar 的失败原因：优先用 stderr 的最后一行（前面是警告，最后一行才是致命的）。 */
function archiveFailureMessage(exit: ChildExit, stderr: string): string {
  const lines = stderr.trim().split("\n");
  const last = lines[lines.length - 1]?.trim();
  if (last !== undefined && last !== "") return last;
  if (exit.code === null && exit.signal !== null) return `tar was killed by ${exit.signal}`;
  return `tar exited with code ${exit.code ?? "null"}`;
}
