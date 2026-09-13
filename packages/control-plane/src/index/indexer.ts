/**
 * P8 · 索引编排：增量判定 → 解析（worker）→ 引用边 → 落库（spec Phase 8 §5/§6）。
 *
 * 【这个文件要守住的一条不变量】**增量结果 == 全量结果**（spec 测试要点 5 的哈希断言）。
 * 做法不是"两条路径写得一样小心"，而是让两条路径共用同一段算边代码：增量只是少解析一些文件、
 * 少读一些行，把上一版的行读回来当"这次解析出来的那些"，之后走的是**同一个** `edgesFor()`。
 * 于是"相等"来自结构，不来自纪律。
 *
 * 【增量到底省了什么、没省什么】
 *  - 省：**解析**（WASM 上下文里最贵的一步）、**没变化的行不重写**（用 `INSERT … SELECT` 在库里搬）；
 *  - 没省：算边的逻辑（它是内存里的纯计算，几千条边是毫秒级）。
 *
 * 【增量需要重算哪些边（这一段是本文件唯一复杂的地方）】
 *  ① `changed` 文件的**全部**边：候选集变了；
 *  ② 不变文件里"候选名字的定义集变了"的那些边：定义集只可能被变化文件改动，所以受影响的名字
 *     `affectedNames` = 变化文件在**上一版与这一版**里定义过的名字。受影响的行直接从
 *     `repo_file_refs` 按名字查（这正是那张表存在的理由）；
 *  ③ 不变文件里"import 解析结果变了"的那些 import 边：非相对 import 的解析依赖**文件集**
 *     （多一个同名模块就变歧义、少一个就唯一了），所以要用上一版文件集与新文件集各解析一次来对比。
 *     不比对就会留下过期边——这是"增量 == 全量"最容易漏掉的一角，所以这里喷了一次
 *     `repo_file_refs(kind='import')` 的全量读（每个文件 1–5 行，可接受）。
 *
 * 【解析失败的文件不保留旧结果】超时 / 崩掉 / 太大 / 读不动的文件在这次索引里就是"没有符号、
 * 没有引用"：一半的索引比一份自相矛盾的索引好（它的旧定义可能是错的，而地图会当真）。
 *
 * 【阈值与降级】变化集 / 可解析文件数 ≥ 30%（spec §5）就全量重建；空变化集走纯复制（一次解析都不做）。
 * 总预算 90s / 单文件 200ms / worker 崩溃都只影响这一次索引：落 `failed`（崩）或
 * `ready + partial_timeout`（超时），Run 侧照常继续——索引是派生物，没有它只是"这次没有地图"。
 */

import { gitIndexPort } from "./git-port.ts";
import { discoverFiles, parseBatch } from "./parse.ts";
import type { DiscoveredFile, ParseOutcome, ParsedFile } from "./parse.ts";
import { createEdgeContext, edgesFor } from "./refs.ts";
import type { FileCandidates, FileSymbols, RefEdge } from "./refs.ts";
import type { LanguageId, SymbolKind, SymbolRecord } from "./symbols.ts";
import type { RepoFileRefRow, RepoIndexRow, RepoIndexStore, RepoSymbolRow } from "./store.ts";
import type { LogFn } from "../log.ts";
import { noopLog } from "../log.ts";

// ---------------------------------------------------------------- 端口

export interface DiffEntry {
  path: string;
  status: "added" | "modified" | "deleted";
}

/** 增量判定要问 git 的三件事（真实现见 `git-port.ts`；单测用假实现）。 */
export interface IndexGitPort {
  diff(fromSha: string, toSha: string): Promise<DiffEntry[]>;
  /** `fromSha` 是不是 `toSha` 的祖先（force push / 换分支 → 不是 → 全量重建）。 */
  isAncestor(fromSha: string, toSha: string): Promise<boolean>;
  head(): Promise<string>;
}

/** 一批文件的解析器（真实现是 `parseBatch`（子进程）；单测传一个假的）。 */
export type BatchParser = (input: {
  root: string;
  files: readonly DiscoveredFile[];
  vendorDir?: string;
  totalBudgetMs?: number;
  perFileBudgetMs?: number;
}) => Promise<ParseOutcome>;

export interface RepoIndexBudgets {
  /** 全量索引的总预算（spec §6：90s 硬超时 → `partial_timeout`）。 */
  totalMs?: number;
  /** 单文件预算（spec §6：200ms → 跳过该文件）。 */
  perFileMs?: number;
  /** 单文件体积上限（spec §3：1 MiB）。 */
  maxFileBytes?: number;
  /** 扫描文件数上限。 */
  maxFiles?: number;
}

// ---------------------------------------------------------------- 结果

export type RepoIndexMode = "full" | "incremental" | "reuse" | "skipped";

export interface RepoIndexResult {
  repoKey: string;
  commitSha: string;
  mode: RepoIndexMode;
  status: "ready" | "unsupported" | "failed";
  /** 扫描到的文件数（含不认识的语言）。 */
  files: number;
  symbols: number;
  edges: number;
  languages: Record<string, number>;
  durationMs: number;
  /** `partial_timeout` / `partial_max_files` / 失败原因；正常是 null。 */
  error: string | null;
  /** 上一版（增量的基准）；全量与纯复制以外的情形为 null。 */
  previousCommitSha: string | null;
  /** 这次真的解析了多少个文件（增量时远小于 `files`）。 */
  parsedFiles: number;
}

export interface IndexRepositoryOptions {
  /** `owner/name`。 */
  repoKey: string;
  /** 要索引的 commit；不给就取 clone 里的 HEAD。 */
  commitSha?: string;
  /** CP 的 clone 目录（`repo/clone.ts` 的产物）。 */
  cloneDir: string;
  store: RepoIndexStore;
  /** `vendor/tree-sitter/`；缺省就是仓库里的那一个（`vendor.ts`）。 */
  vendorDir?: string;
  git?: IndexGitPort;
  parser?: BatchParser;
  budgets?: RepoIndexBudgets;
  /** 忽略上一版、强制全量（`--rebuild`）。 */
  rebuild?: boolean;
  /** 索引成功之后只保留最近几版（默认 2：当前 + 上一版）。 */
  keepCommits?: number;
  log?: LogFn;
}

/** 变化集占可解析文件数的比例超过它就不再"增量"（spec §5 的 30%）。 */
export const REBUILD_RATIO = 0.3;

/**
 * 建一次索引。**不抛异常**：失败一律是 `status:"failed"` 的结果或 `null` + 一行日志。
 *
 * `null` 的来源（spec §6 的"索引失败不阻塞 Run"）：clone 里没有 git、增量判定失败、
 * worker 崩了、落库失败。调用方拿到 null 只需要继续跑——这次没有地图而已。
 */
export async function indexRepository(options: IndexRepositoryOptions): Promise<RepoIndexResult | null> {
  const log = options.log ?? noopLog;
  const git = options.git ?? gitIndexPort(options.cloneDir);
  const parser = options.parser ?? parseBatch;
  const startedAt = Date.now();
  const vendorDir = options.vendorDir;

  let commitSha: string;
  try {
    commitSha = (options.commitSha ?? (await git.head())).trim();
  } catch (error) {
    log("warn", "索引跳过：拿不到 clone 的 HEAD", { repoKey: options.repoKey, error: message(error) });
    return null;
  }
  if (commitSha === "") {
    log("warn", "索引跳过：commit 是空的", { repoKey: options.repoKey });
    return null;
  }

  const discovery = await discoverFiles(options.cloneDir, { maxFiles: options.budgets?.maxFiles });
  const indexablePaths = discovery.indexable.map((file) => file.path);
  const languages = discovery.byLanguage;
  const base = { repoKey: options.repoKey, commitSha, files: discovery.all.length, languages };

  // ---- 增量判定之前先看"是不是已经索引过这一版"（同一个 commit 重复索引 = 幂等，不重写任何行）
  const previous = options.rebuild === true ? null : await options.store.latestReady(options.repoKey);
  if (previous !== null && previous.commit_sha === commitSha) {
    log("info", "索引已经是这一版，跳过", { repoKey: options.repoKey, commitSha });
    return {
      ...base,
      mode: "skipped",
      status: previous.status === "unsupported" ? "unsupported" : "ready",
      symbols: previous.symbols,
      edges: previous.edges,
      durationMs: 0,
      error: previous.error,
      previousCommitSha: null,
      parsedFiles: 0,
    };
  }

  const plan = await planIndex({
    previous,
    commitSha,
    git,
    indexablePaths,
    rebuild: options.rebuild === true,
  });
  if (plan === null) {
    // git 不可用 / diff 失败：宁可不索引，也不要"猜"哪些文件变了。
    log("warn", "索引跳过：增量判定失败", { repoKey: options.repoKey, commitSha });
    return null;
  }

  await options.store.start({ repoKey: options.repoKey, commitSha, files: base.files, languages });

  // ---- reuse：变化集为空，整段复制（不解析、不算边）
  if (plan.mode === "reuse" && previous !== null) {
    const status = previous.status === "unsupported" ? ("unsupported" as const) : ("ready" as const);
    return finish(options, base, {
      mode: "reuse",
      copyFromCommitSha: previous.commit_sha,
      symbols: [],
      fileRefs: [],
      edges: [],
      excludeSymbolPaths: [],
      excludeFileRefPaths: [],
      excludeRefPaths: [],
      excludeRefPairs: [],
      status,
      error: previous.error,
      parsedFiles: 0,
      previousCommitSha: previous.commit_sha,
      startedAt,
      log,
    });
  }

  // ---- 解析：全量 = 所有可解析文件；增量 = 变化集里的 A/M
  const toParse =
    plan.mode === "full" ? discovery.indexable : discovery.indexable.filter((file) => plan.parsePaths.has(file.path));
  let outcome: ParseOutcome;
  try {
    outcome =
      toParse.length === 0
        ? { files: [], timedOut: false, crashed: false, exitCode: 0, stderr: "", parseMs: 0, wallMs: 0, timedOutFiles: [] }
        : await parser({
            root: options.cloneDir,
            files: toParse,
            vendorDir,
            totalBudgetMs: options.budgets?.totalMs,
            perFileBudgetMs: options.budgets?.perFileMs,
          });
  } catch (error) {
    await failQuietly(options.store, { ...base, error: `parser_failed: ${message(error)}`, durationMs: Date.now() - startedAt }, log);
    return null;
  }

  if (outcome.crashed) {
    const stderr = outcome.stderr.trim();
    await failQuietly(
      options.store,
      { ...base, error: stderr === "" ? "worker_crashed" : `worker_crashed: ${stderr.slice(-300)}`, durationMs: Date.now() - startedAt },
      log,
    );
    return null;
  }

  const newSymbols = symbolsOf(outcome.files);
  const newCandidates = candidatesOf(outcome.files);
  const error = outcome.timedOut ? "partial_timeout" : discovery.truncated ? "partial_max_files" : null;
  // 一个我们完全不认识语言的仓库：`unsupported`（不是错误，P9 的地图退化成文件树）。
  const unsupported = Object.keys(languages).length === 0;

  // ---- 增量：只把"要重算的那部分"从上一版读回来
  let affectedRows: RepoFileRefRow[] = [];
  let importPairs: { path: string; symbol: string }[] = [];
  let affectedNames: string[] = [];

  if (plan.mode === "incremental" && previous !== null) {
    const touched = [...plan.touchedPaths];
    // ② 受影响的名字 = 变化文件在上一版里定义过的 + 这一版里定义过的
    const touchedSymbols = await options.store.symbolsInPaths(options.repoKey, previous.commit_sha, touched);
    affectedNames = unique([...touchedSymbols.map((row) => row.name), ...newSymbols.map((symbol) => symbol.name)]);
    affectedRows =
      affectedNames.length === 0 ? [] : await options.store.fileRefsInSymbols(options.repoKey, previous.commit_sha, affectedNames);

    // ③ import 解析结果变了的不变文件：上一版文件集与新文件集各解析一次再对比
    const importRows = await options.store.fileRefsOfKind(options.repoKey, previous.commit_sha, "import");
    const previousFiles = new Set(indexablePaths);
    for (const added of plan.addedPaths) previousFiles.delete(added);
    for (const deleted of plan.deletedPaths) previousFiles.add(deleted);
    const before = createEdgeContext({ files: [...previousFiles], symbols: [] });
    const after = createEdgeContext({ files: indexablePaths, symbols: [] });
    for (const row of importRows) {
      if (plan.touchedPaths.has(row.path)) continue;
      if (before.resolve(row.path, row.symbol) === after.resolve(row.path, row.symbol)) continue;
      importPairs.push({ path: row.path, symbol: row.symbol });
    }
  }

  // ---- 算边：全量与增量共用 `edgesFor`（见文件头的不变量）
  const dirtyCandidates = incrementalCandidates({ plan, newCandidates, affectedRows, importPairs });
  const namesToResolve = unique(dirtyCandidates.flatMap((file) => file.refs.identifiers));
  const definitionRows =
    plan.mode === "incremental" && previous !== null && namesToResolve.length > 0
      ? await options.store.symbolsInNames(options.repoKey, previous.commit_sha, namesToResolve)
      : [];
  const context = createEdgeContext({
    files: indexablePaths,
    symbols: groupSymbols([
      ...definitionRows.filter((row) => !plan.touchedPaths.has(row.path)).map(toSymbolRecord),
      ...newSymbols,
    ]),
  });
  const edges = edgesFor(dirtyCandidates, context);

  return finish(options, base, {
    mode: plan.mode,
    copyFromCommitSha: plan.mode === "incremental" && previous !== null ? previous.commit_sha : null,
    symbols: newSymbols,
    fileRefs: newFileRefs(newCandidates),
    edges,
    excludeSymbolPaths: [...plan.touchedPaths],
    excludeFileRefPaths: [...plan.touchedPaths],
    excludeRefPaths: [...plan.touchedPaths],
    excludeRefPairs: incrementalPairs(plan, affectedRows, importPairs),
    status: unsupported ? "unsupported" : "ready",
    error,
    parsedFiles: new Set(outcome.files.map((file) => file.path)).size,
    previousCommitSha: plan.mode === "incremental" && previous !== null ? previous.commit_sha : null,
    startedAt,
    log,
  });
}

// ---------------------------------------------------------------- 增量判定

interface IndexPlan {
  mode: "full" | "incremental" | "reuse";
  /** 需要重新解析的文件（A/M 且是能解析的语言）。 */
  parsePaths: Set<string>;
  /** 上一版里"动过"的路径（A/M/D）：复制时要排除掉它们的旧行。 */
  touchedPaths: Set<string>;
  /** 这一版里**新加**的路径（只用来重建"上一版文件集"，好对比 import 解析结果）。 */
  addedPaths: string[];
  /** 这一版里**删掉**的路径（同上）。 */
  deletedPaths: string[];
}

async function planIndex(input: {
  previous: RepoIndexRow | null;
  commitSha: string;
  git: IndexGitPort;
  indexablePaths: readonly string[];
  rebuild: boolean;
}): Promise<IndexPlan | null> {
  const full = (): IndexPlan => ({
    mode: "full",
    parsePaths: new Set(input.indexablePaths),
    touchedPaths: new Set(),
    addedPaths: [],
    deletedPaths: [],
  });
  if (input.rebuild || input.previous === null) return full();

  let ancestor: boolean;
  try {
    ancestor = await input.git.isAncestor(input.previous.commit_sha, input.commitSha);
  } catch {
    return null;
  }
  // 非祖先（force push / 换分支）：上一版的键与这一版的路径没有可比性，全量。
  if (!ancestor) return full();

  let diff: DiffEntry[];
  try {
    diff = await input.git.diff(input.previous.commit_sha, input.commitSha);
  } catch {
    return null;
  }

  const addedPaths = diff.filter((entry) => entry.status === "added").map((entry) => entry.path);
  const deletedPaths = diff.filter((entry) => entry.status === "deleted").map((entry) => entry.path);
  const changedPaths = diff.filter((entry) => entry.status !== "deleted").map((entry) => entry.path);
  // 被删掉的文件已经不在 `indexablePaths` 里了，但它在上一版的符号表 / 候选表里：算影响面要带上它。
  const touchedPaths = new Set([...changedPaths, ...deletedPaths]);

  if (touchedPaths.size === 0) {
    return { mode: "reuse", parsePaths: new Set(), touchedPaths, addedPaths, deletedPaths };
  }
  const ratio = touchedPaths.size / Math.max(input.indexablePaths.length, 1);
  if (ratio >= REBUILD_RATIO) return full();

  // 只有"现在是可解析文件"的变化文件才需要解析（删掉的不存在，语言不认识的没有语法文件）。
  // `changedPaths` 转成 Set：两万个文件 × 几百个变化文件时，`includes` 是二次方的。
  const changedSet = new Set(changedPaths);
  const parsePaths = new Set(input.indexablePaths.filter((file) => changedSet.has(file)));
  return { mode: "incremental", parsePaths, touchedPaths, addedPaths, deletedPaths };
}

// ---------------------------------------------------------------- 增量辅助

/**
 * 要重算的候选：变化文件的全部候选 + 受影响文件里**只挑受影响的那些名字**。
 *
 * 【为什么不是"受影响文件的全部候选"】那会把每个受影响文件的每条边都重算一遍，代价随仓库大小
 * 线性增长——而真正变了的只有那几个名字。挑出来之后，写入口那边的排除集也是同一组
 * `(path, symbol)`（`incrementalPairs`），两边由同一份数据决定，不会出现"排除了却没重算"。
 */
function incrementalCandidates(input: {
  plan: IndexPlan;
  newCandidates: readonly FileCandidates[];
  affectedRows: readonly RepoFileRefRow[];
  importPairs: readonly { path: string; symbol: string }[];
}): FileCandidates[] {
  if (input.plan.mode !== "incremental") return [...input.newCandidates];

  const byPath = new Map<string, { identifiers: Set<string>; imports: Set<string> }>();
  const push = (path: string, kind: "identifier" | "import", symbol: string): void => {
    let entry = byPath.get(path);
    if (entry === undefined) {
      entry = { identifiers: new Set(), imports: new Set() };
      byPath.set(path, entry);
    }
    if (kind === "identifier") entry.identifiers.add(symbol);
    else entry.imports.add(symbol);
  };
  for (const row of input.affectedRows) {
    if (!input.plan.touchedPaths.has(row.path)) push(row.path, row.kind, row.symbol);
  }
  for (const pair of input.importPairs) push(pair.path, "import", pair.symbol);

  const affected: FileCandidates[] = [...byPath.entries()].map(([path, entry]) => ({
    path,
    refs: { identifiers: [...entry.identifiers].sort(), imports: [...entry.imports].sort() },
  }));
  return [...input.newCandidates, ...affected];
}

/** 与 `incrementalCandidates` 同一组数据：写入口不要复制的那些边。 */
function incrementalPairs(
  plan: IndexPlan,
  affectedRows: readonly RepoFileRefRow[],
  importPairs: readonly { path: string; symbol: string }[],
): { path: string; symbol: string }[] {
  if (plan.mode !== "incremental") return [];
  const pairs: { path: string; symbol: string }[] = [];
  for (const row of affectedRows) {
    if (!plan.touchedPaths.has(row.path)) pairs.push({ path: row.path, symbol: row.symbol });
  }
  for (const pair of importPairs) pairs.push(pair);
  return pairs;
}

// ---------------------------------------------------------------- 收尾

async function finish(
  options: IndexRepositoryOptions,
  base: { repoKey: string; commitSha: string; files: number; languages: Record<string, number> },
  input: {
    mode: RepoIndexMode;
    symbols: readonly (SymbolRecord & { path: string; lang: LanguageId })[];
    fileRefs: readonly { path: string; symbol: string; kind: "identifier" | "import" }[];
    edges: readonly RefEdge[];
    copyFromCommitSha: string | null;
    excludeSymbolPaths: readonly string[];
    excludeFileRefPaths: readonly string[];
    excludeRefPaths: readonly string[];
    excludeRefPairs: readonly { path: string; symbol: string }[];
    status: "ready" | "unsupported";
    error: string | null;
    parsedFiles: number;
    previousCommitSha: string | null;
    startedAt: number;
    log: LogFn;
  },
): Promise<RepoIndexResult | null> {
  const durationMs = Date.now() - input.startedAt;
  try {
    await options.store.writeIndex({
      repoKey: base.repoKey,
      commitSha: base.commitSha,
      copyFromCommitSha: input.copyFromCommitSha,
      excludeSymbolPaths: input.excludeSymbolPaths,
      excludeFileRefPaths: input.excludeFileRefPaths,
      excludeRefPaths: input.excludeRefPaths,
      excludeRefPairs: input.excludeRefPairs,
      symbols: input.symbols,
      fileRefs: input.fileRefs,
      edges: input.edges,
      status: input.status,
      files: base.files,
      languages: base.languages,
      durationMs,
      error: input.error,
      keepCommits: options.keepCommits ?? 2,
    });
  } catch (error) {
    input.log("error", "索引落库失败", { repoKey: base.repoKey, commitSha: base.commitSha, error: message(error) });
    await failQuietly(options.store, { ...base, error: `write_failed: ${message(error)}`, durationMs }, input.log);
    return null;
  }

  const stored = await options.store.get(base.repoKey, base.commitSha).catch(() => null);
  return {
    ...base,
    mode: input.mode,
    status: input.status,
    symbols: stored?.symbols ?? input.symbols.length,
    edges: stored?.edges ?? input.edges.length,
    durationMs,
    error: input.error,
    previousCommitSha: input.previousCommitSha,
    parsedFiles: input.parsedFiles,
  };
}

async function failQuietly(
  store: RepoIndexStore,
  input: { repoKey: string; commitSha: string; files: number; languages: Record<string, number>; error: string; durationMs: number },
  log: LogFn,
): Promise<void> {
  try {
    await store.fail(input);
  } catch (error) {
    log("error", "索引失败状态也写不进去", { repoKey: input.repoKey, commitSha: input.commitSha, error: message(error) });
  }
}

// ---------------------------------------------------------------- 小工具

function symbolsOf(files: readonly ParsedFile[]): (SymbolRecord & { path: string; lang: LanguageId })[] {
  const out: (SymbolRecord & { path: string; lang: LanguageId })[] = [];
  for (const file of files) {
    if (file.status !== "ok") continue;
    for (const symbol of file.symbols) out.push({ ...symbol, path: file.path, lang: file.lang });
  }
  return out;
}

function candidatesOf(files: readonly ParsedFile[]): FileCandidates[] {
  return files
    .filter((file) => file.status === "ok")
    .map((file) => ({ path: file.path, refs: { identifiers: file.identifiers, imports: file.imports } }));
}

function newFileRefs(files: readonly FileCandidates[]): { path: string; symbol: string; kind: "identifier" | "import" }[] {
  const out: { path: string; symbol: string; kind: "identifier" | "import" }[] = [];
  for (const file of files) {
    for (const symbol of file.refs.identifiers) out.push({ path: file.path, symbol, kind: "identifier" });
    for (const symbol of file.refs.imports) out.push({ path: file.path, symbol, kind: "import" });
  }
  return out;
}

/** 数据库行 → 符号记录（增量路径用）。 */
function toSymbolRecord(row: RepoSymbolRow): SymbolRecord & { path: string } {
  return {
    path: row.path,
    name: row.name,
    kind: row.kind as SymbolKind,
    signature: row.signature,
    startLine: row.start_line,
    endLine: row.end_line,
  };
}

/** 按路径把符号记录归拢成 `FileSymbols`（算边的输入形状）。 */
function groupSymbols(rows: readonly (SymbolRecord & { path: string })[]): FileSymbols[] {
  const byPath = new Map<string, SymbolRecord[]>();
  for (const row of rows) {
    const list = byPath.get(row.path);
    const { path: _path, ...symbol } = row;
    if (list === undefined) byPath.set(row.path, [symbol]);
    else list.push(symbol);
  }
  return [...byPath.entries()].map(([path, symbols]) => ({ path, symbols }));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
