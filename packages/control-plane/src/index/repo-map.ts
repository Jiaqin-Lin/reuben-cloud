/**
 * P9 · 地图编排：读索引 → 个性化 → PageRank → 渲染 → 落缓存；索引不可用时降级成文件树
 * （spec Phase 9 的接线部分；P10 的 `repo_map` 分区调用的就是 `buildRepoMap`）。
 *
 * 【为什么单独一个文件（交付物里只有 rank / render / personalize）】那三个是**纯函数**：
 * 输入到输出，没有 IO、没有时钟、没有库。把它们交给编排层去调，换来两件事：
 *  ① 排名与渲染的正确性可以在没有 Postgres 的单测里逐条验证（spec 测试要点 1–6、8）；
 *  ② 缓存与"索引不可用"这两件事只有一处实现（两份实现迟早漂，P8 的 git-port 是同一条理由）。
 *
 * 【缓存命中是"零重算"，不是"少算一点"】命中时只读 `repo_indexes` 一行（拿索引指纹）与
 * `repo_maps` 一行；符号表、边、import 候选**一个字节都不读**（重算那条路上的三次读
 * `allSymbols` / `allRefs` / `fileRefsOfKind` 一次都不发生）。
 * 之所以要读索引那一行，是因为缓存键里没有索引的身份：同一个 commit 重新索引（`--rebuild`）
 * 之后，地图会一直是旧的那一份。指纹（`repo_indexes.built_at`）一比就失效，见附录 A-57。
 *
 * 【缓存是优化，不是依赖】读失败 / 写失败 / 校验不过都只记一条 warn：地图照常返回。
 * 这一点与 P3/P4 对"观察者抛异常"的态度一致：缓存坏了不该让这次 Run 没有地图。
 *
 * 【降级（设计文档 §D.3 最后一段）】`repo_indexes.status != ready` 时给的是**文件树**：
 * 没有符号表就没有排名可言，但"这个仓库由哪些目录组成"仍然是模型开局缺的那一块信息。
 * 降级结果**不写缓存**：索引修好之后，同一个 (repo, commit, 词, 预算) 必须能拿到真正的地图，
 * 而不是当初那份树。
 *
 * 【改动标注与预算的关系】`text` = 正文 + `# 本次 Run 已改动…`。标注**不占**预算，
 * 也不进缓存（缓存键里没有 changedFiles）。理由见 `render.ts` 的文件头。
 */

import { createHash } from "node:crypto";
import { clampBudgetTokens, MAX_BUDGET_TOKENS, renderFileTree, renderRepoMap, withChangedFiles } from "./render.ts";
import type { RepoMapFileBlock, RepoMapSymbol } from "./render.ts";
import { dropVocabularyEdges, edgeKey, orderSymbols, pageRank, rankedFiles, symbolRefCounts } from "./rank.ts";
import type { RankEdge } from "./rank.ts";
import { personalizationHash, personalizationOf, taskTerms } from "./personalize.ts";
import type { RepoIndexStore, RepoMapStore, RepoSymbolRow } from "./store.ts";
import { noopLog } from "../log.ts";
import type { LogFn } from "../log.ts";

// ---------------------------------------------------------------- 常量

/** 改动文件超过这个数就值得重建（设计文档 §D.3；`render.ts` 的显示上限用的是同一个数）。 */
export const MAP_REFRESH_CHANGED_FILES = 20;

/** 距上次重建超过 5 分钟（进入新 turn 时才算）就值得重建（设计文档 §D.3）。 */
export const MAP_REFRESH_INTERVAL_MS = 5 * 60_000;

/** 每个 (repo, commit) 只留最近几条地图缓存（`pruneRepoMaps` 的口径见 010 迁移）。 */
export const DEFAULT_KEEP_MAP_COMMITS = 2;

// ---------------------------------------------------------------- 端口与结果

/** 降级的原因。`null` = 正常地图。 */
export type RepoMapDegraded = "index_missing" | "index_not_ready" | "index_error" | "empty_index" | null;

export interface RepoMapOptions {
  /** `owner/name`。 */
  repoKey: string;
  /** 地图建在哪一个快照上（会话的 base commit）。 */
  commitSha: string;
  /** 任务文本（issue 原文 + 任务书）；不给就是均匀分布，"仓库的心脏在哪"的那张图。 */
  task?: string;
  /** 本次 Run 已经改过的文件（附在末尾的一行提示，见文件头）。 */
  changedFiles?: readonly string[];
  /** token 预算；缺省 1500，硬上限 3000。 */
  budgetTokens?: number;
  /** 索引的读口（符号 / 边 / 状态）。 */
  index: RepoIndexStore;
  /** 地图缓存（010 的 `repo_maps`）。 */
  maps: RepoMapStore;
  /**
   * 全量文件清单（`discoverFiles` 的 `all`）。**只有降级文件树用得上**：
   * 索引不可用时没有符号表可以推路径。不给就退化成"只有一行说明"的空树。
   */
  files?: readonly string[];
  /** 忽略缓存重算（排障 / CLI 的 `--rebuild`）。 */
  refresh?: boolean;
  /** 写完只保留最近几个 commit 的地图。 */
  keepCommits?: number;
  log?: LogFn;
}

export interface RepoMapResult {
  repoKey: string;
  commitSha: string;
  /** 缓存键里的那半：任务词的哈希。 */
  personalizationHash: string;
  budgetTokens: number;
  /** 最终文本：正文 + 改动标注。 */
  text: string;
  /** 正文（缓存里存的那一份，不含改动标注）。 */
  body: string;
  /** 正文的 sha256。 */
  hash: string;
  /** 正文的 token 估算（`ceil(chars / 4)`）。 */
  tokens: number;
  /** 正文里的文件数（命中缓存时从正文里数：每个文件块的路径行不带缩进）。 */
  files: number;
  /** 因预算没进正文的文件数；**命中缓存时是 null**（那份统计没被缓存，不编一个 0）。 */
  omittedFiles: number | null;
  /** 有东西被截断（文件被丢 / 某个文件的签名被切）；命中缓存时是 null。 */
  truncated: boolean | null;
  cached: boolean;
  degraded: RepoMapDegraded;
  /** 命中的符号名（诊断用；命中数为 0 表示个性化退成了均匀分布）。 */
  matchedSymbols: readonly string[];
  /** 排名信息（命中缓存时为 null——那些数没被缓存）。 */
  rank: { nodes: number; iterations: number; converged: boolean } | null;
}

// ---------------------------------------------------------------- 编排

export async function buildRepoMap(options: RepoMapOptions): Promise<RepoMapResult> {
  const log = options.log ?? noopLog;
  const budgetTokens = clampBudgetTokens(options.budgetTokens);
  if (options.budgetTokens !== undefined && options.budgetTokens > MAX_BUDGET_TOKENS) {
    log("warn", `地图预算超过硬上限，已截到 ${MAX_BUDGET_TOKENS}`, {
      repoKey: options.repoKey,
      asked: options.budgetTokens,
      used: budgetTokens,
    });
  }

  const terms = taskTerms(options.task ?? "");
  const taskHash = personalizationHash(terms);
  const base = {
    repoKey: options.repoKey,
    commitSha: options.commitSha,
    personalizationHash: taskHash,
    budgetTokens,
  };
  const annotate = (body: string): string => withChangedFiles(body, options.changedFiles);

  // ---- 索引状态：缓存命中判断与降级判断都靠这一行
  let indexRow = null as Awaited<ReturnType<RepoIndexStore["get"]>>;
  try {
    indexRow = await options.index.get(options.repoKey, options.commitSha);
  } catch (error) {
    log("warn", "地图降级：读索引状态失败", { repoKey: options.repoKey, commitSha: options.commitSha, error: message(error) });
    return degraded(options, base, "index_error");
  }
  const readyRow = indexRow !== null && indexRow.status === "ready" ? indexRow : null;

  // ---- 缓存：命中就只回它（零重算）
  if (readyRow !== null && options.refresh !== true) {
    const cached = await readCache(options, base, readyRow.built_at, log);
    if (cached !== null) {
      return {
        ...base,
        text: annotate(cached.text),
        body: cached.text,
        hash: cached.hash,
        tokens: cached.tokens,
        files: countFileBlocks(cached.text),
        omittedFiles: null,
        truncated: null,
        cached: true,
        degraded: null,
        matchedSymbols: [],
        rank: null,
      };
    }
  }

  if (readyRow === null) {
    const reason: RepoMapDegraded = indexRow === null ? "index_missing" : "index_not_ready";
    log("info", "地图降级成文件树", {
      repoKey: options.repoKey,
      commitSha: options.commitSha,
      status: indexRow?.status ?? null,
      reason,
    });
    return degraded(options, base, reason);
  }

  // ---- 重算：符号 + 边 → 节点集 → 个性化 → 排名 → 渲染
  const loaded = await loadIndex(options, log);
  if (loaded === null) return degraded(options, base, "index_error");
  const { symbols, edges } = loaded;
  const nodes = nodeSet(symbols.map((row) => row.path), edges);
  if (nodes.length === 0) {
    log("info", "地图降级成文件树：索引里没有任何符号或边", { repoKey: options.repoKey, commitSha: options.commitSha });
    return degraded(options, base, "empty_index");
  }

  const personalization = personalizationOf({
    task: options.task ?? "",
    symbols: symbols.map((row) => ({ path: row.path, name: row.name })),
    files: nodes,
  });
  // 排名用过滤过的边（词汇名闸）；符号重要性用原样的边（口径不同，见 rank.ts）。
  const ranked = pageRank({ files: nodes, edges: dropVocabularyEdges(edges, loaded.importKeys), personalization: personalization.weights });
  const counts = symbolRefCounts(edges);
  const symbolsByPath = groupSymbols(symbols);
  const blocks: RepoMapFileBlock[] = rankedFiles(ranked.ranks).map((file) => ({
    path: file.path,
    symbols: orderSymbols(file.path, symbolsByPath.get(file.path) ?? [], counts),
  }));
  const rendered = renderRepoMap({ blocks, budgetTokens });
  const hash = sha256(rendered.text);

  await writeCache(options, base, { text: rendered.text, hash, tokens: rendered.tokens, indexBuiltAt: readyRow.built_at }, log);

  return {
    ...base,
    text: annotate(rendered.text),
    body: rendered.text,
    hash,
    tokens: rendered.tokens,
    files: rendered.files,
    omittedFiles: rendered.omittedFiles,
    truncated: rendered.truncated,
    cached: false,
    degraded: null,
    matchedSymbols: personalization.matchedSymbols,
    rank: { nodes: nodes.length, iterations: ranked.iterations, converged: ranked.converged },
  };
}

/**
 * 该不该重建地图（设计文档 §D.3：改动文件 > 20 或距上次重建 > 5 分钟）。
 *
 * 【P9 里没有调用方，这不是遗漏】地图是从 **base commit** 建的：agent 在沙箱里改代码不会
 * 让 CP 的 clone 变化，所以"重建"只有在"CP 重新索引了那份改过的代码"时才产生新结果——
 * 那要先把沙箱里的改动拉回 CP，属于 P10/M3 的接线。P9 把判据给出来（带测试），
 * 免得接线时随手写一个"每轮都重建"。
 */
export function mapRefreshDue(input: { changedFiles: number; lastBuiltAt: Date | null; now: number }): boolean {
  if (input.changedFiles > MAP_REFRESH_CHANGED_FILES) return true;
  if (input.lastBuiltAt === null) return true;
  return input.now - input.lastBuiltAt.getTime() > MAP_REFRESH_INTERVAL_MS;
}

// ---------------------------------------------------------------- 降级

function degraded(
  options: RepoMapOptions,
  base: { repoKey: string; commitSha: string; personalizationHash: string; budgetTokens: number },
  reason: Exclude<RepoMapDegraded, null>,
): RepoMapResult {
  const tree = renderFileTree({ files: options.files ?? [], budgetTokens: base.budgetTokens });
  return {
    ...base,
    text: withChangedFiles(tree.text, options.changedFiles),
    body: tree.text,
    hash: sha256(tree.text),
    tokens: tree.tokens,
    files: tree.files,
    omittedFiles: tree.omittedFiles,
    truncated: tree.truncated,
    cached: false,
    degraded: reason,
    matchedSymbols: [],
    rank: null,
  };
}

/** 读一个快照的全部符号、边与 import 候选（失败只记一条 warn，调用方降级）。 */
async function loadIndex(
  options: RepoMapOptions,
  log: LogFn,
): Promise<{ symbols: RepoSymbolRow[]; edges: RankEdge[]; importKeys: ReadonlySet<string> } | null> {
  try {
    const symbols = await options.index.allSymbols(options.repoKey, options.commitSha);
    const rows = await options.index.allRefs(options.repoKey, options.commitSha);
    // import 候选：只用来回答"这条边是不是作者写下的依赖"（词汇名闸要放过它们，见 rank.ts）。
    const importKeys = new Set(
      (await options.index.fileRefsOfKind(options.repoKey, options.commitSha, "import")).map((row) => edgeKey(row.path, row.symbol)),
    );
    return {
      symbols,
      importKeys,
      edges: rows.map((row) => ({
        fromPath: row.from_path,
        toPath: row.to_path,
        weight: row.weight,
        symbol: row.symbol,
      })),
    };
  } catch (error) {
    log("warn", "地图降级：读索引内容失败", { repoKey: options.repoKey, commitSha: options.commitSha, error: message(error) });
    return null;
  }
}

// ---------------------------------------------------------------- 缓存读写（失败只记 warn）

async function readCache(
  options: RepoMapOptions,
  key: { repoKey: string; commitSha: string; personalizationHash: string; budgetTokens: number },
  indexBuiltAt: Date,
  log: LogFn,
): Promise<{ text: string; hash: string; tokens: number } | null> {
  try {
    const row = await options.maps.get(key);
    if (row === null) return null;
    // 索引指纹：同一个 commit 重新索引过 → 这份地图是旧符号表上的产物。
    if (row.index_built_at.getTime() !== indexBuiltAt.getTime()) {
      log("info", "地图缓存过期（索引重建过）", { repoKey: key.repoKey, commitSha: key.commitSha });
      return null;
    }
    // 行里的正文必须与哈希对得上：缓存是派生物，坏掉就当没有（回放要比对字节，错一行都算错）。
    if (sha256(row.text) !== row.hash) {
      log("warn", "地图缓存校验不过，重算", { repoKey: key.repoKey, commitSha: key.commitSha });
      return null;
    }
    return { text: row.text, hash: row.hash, tokens: row.tokens };
  } catch (error) {
    log("warn", "地图缓存读取失败，重算", { repoKey: key.repoKey, commitSha: key.commitSha, error: message(error) });
    return null;
  }
}

async function writeCache(
  options: RepoMapOptions,
  key: { repoKey: string; commitSha: string; personalizationHash: string; budgetTokens: number },
  value: { text: string; hash: string; tokens: number; indexBuiltAt: Date },
  log: LogFn,
): Promise<void> {
  try {
    await options.maps.put({
      repo_key: key.repoKey,
      commit_sha: key.commitSha,
      personalization_hash: key.personalizationHash,
      budget_tokens: key.budgetTokens,
      text: value.text,
      hash: value.hash,
      tokens: value.tokens,
      index_built_at: value.indexBuiltAt,
    });
    await options.maps.prune(key.repoKey, options.keepCommits ?? DEFAULT_KEEP_MAP_COMMITS);
  } catch (error) {
    log("warn", "地图缓存写入失败（地图照常可用）", { repoKey: key.repoKey, commitSha: key.commitSha, error: message(error) });
  }
}

// ---------------------------------------------------------------- 小工具

/** 图里的节点：有符号的文件 ∪ 边的两端。按字典序去重（PageRank 的确定性从排序开始）。 */
function nodeSet(symbolPaths: readonly string[], edges: readonly RankEdge[]): string[] {
  const nodes = new Set<string>();
  for (const path of symbolPaths) nodes.add(path);
  for (const edge of edges) {
    nodes.add(edge.fromPath);
    nodes.add(edge.toPath);
  }
  return [...nodes].sort();
}

/** 按路径把符号行归拢成渲染用的记录（`start_line` 是排序键之一）。 */
function groupSymbols(
  rows: readonly { path: string; name: string; kind: string; signature: string; start_line: number }[],
): Map<string, RepoMapSymbol[]> {
  const byPath = new Map<string, RepoMapSymbol[]>();
  for (const row of rows) {
    const symbol: RepoMapSymbol = { name: row.name, kind: row.kind, signature: row.signature, startLine: row.start_line };
    const list = byPath.get(row.path);
    if (list === undefined) byPath.set(row.path, [symbol]);
    else list.push(symbol);
  }
  return byPath;
}

/**
 * 缓存命中时从正文里数"有几个文件"（正文字头就是 `path:` 那一行）。
 *
 * 为什么不把 files / omittedFiles 也存进 `repo_maps`：那两列是给 UI 看的派生数字，
 * 正文自己就是真相（数一遍是 O(行数)），而每多一列就多一处能写错的地方。
 */
function countFileBlocks(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) if (line !== "" && !line.startsWith(" ") && !line.startsWith("#")) count += 1;
  return count;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
