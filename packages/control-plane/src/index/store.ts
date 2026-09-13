/**
 * `index/store.ts` —— 009 迁移那四张表的读写（spec Phase 8 §1/§5，以及增量需要的 `repo_file_refs`）。
 *
 * 【谁写、谁只读】写入方只有 `indexer.ts` 一个（它把"解析 → 边 → 落库"包在一次事务里）；
 * 读取方是增量重建（上一版的符号 / 候选 / 边）、P9 的排名与渲染、以及"某个符号定义在哪几个文件里"
 * 这类查询。**其它模块不许自己拼这四张表的 SQL**——SQL 只放在这里，与 §0.3 的边界同一条理由。
 *
 * 【为什么"先删后插 + 整段复制"是最小写入】增量重建里，没变化的那几千个文件的行**一个字节都不该动**：
 * 从 PG 读回 JS 再插回去，等于把"复制"变成"一次全表往返"。所以增量走的是
 * `INSERT INTO … SELECT … FROM 同一张表 WHERE commit_sha = 上一版`（`copyRepoIndexRows`），
 * 数据库内部搬行，网络上一个字节的数据都不传。
 *
 * 【两个 count 为什么在 SQL 里算】`repo_indexes.symbols / edges` 是"这张表里到底有多少行"，
 * 而写入方（复制 + 新插入）算不准——复制的行数只有数据库知道。在同一个事务里 `count(*)` 是
 * 唯一不会漂的答案（也算不上慢：`(repo_key, commit_sha)` 是主键前缀）。
 *
 * 【列名为什么是 snake_case】与 `db/sandboxes.ts` / `environment/store.ts` 同一条理由：
 * pg 回来的就是这样，多一层驼峰映射只是多一处能写错的地方。
 */

import type { Db, Queryable } from "../db/client.ts";
import { many, maybeOne } from "../db/client.ts";
import type { LanguageId, SymbolKind, SymbolRecord } from "./symbols.ts";
import type { RefEdge } from "./refs.ts";

// ---------------------------------------------------------------- 行类型

export type RepoIndexStatus = "building" | "ready" | "failed" | "unsupported";

export const REPO_INDEX_STATUSES: readonly RepoIndexStatus[] = ["building", "ready", "failed", "unsupported"];

/** 一行 `repo_indexes`。字段与 009 迁移一一对应。 */
export interface RepoIndexRow {
  repo_key: string;
  commit_sha: string;
  status: RepoIndexStatus;
  files: number;
  symbols: number;
  edges: number;
  languages: Record<string, number>;
  duration_ms: number | null;
  error: string | null;
  built_at: Date;
}

export interface RepoSymbolRow {
  repo_key: string;
  commit_sha: string;
  path: string;
  lang: string;
  name: string;
  kind: SymbolKind;
  signature: string;
  start_line: number;
  end_line: number;
}

export interface RepoRefRowRow {
  repo_key: string;
  commit_sha: string;
  from_path: string;
  to_path: string;
  symbol: string;
  weight: number;
}

export interface RepoFileRefRow {
  repo_key: string;
  commit_sha: string;
  path: string;
  symbol: string;
  kind: "identifier" | "import";
}

/** 一行 `repo_maps`（010）。`index_built_at` 是索引指纹，见 010 迁移的文件头。 */
// ---------------------------------------------------------------- 写入

/**
 * 记下"这个 commit 开始建索引了"（独立于后面的数据事务）。
 *
 * 用处只有一个：进程中途死掉时，这一行会留在 `building` 上——比"什么都没有"多一句可查的事实。
 * `latestRepoIndex()` 只认 ready / unsupported，所以半截的 building 不会被当成增量基准。
 */
export async function startRepoIndex(
  q: Queryable,
  input: { repoKey: string; commitSha: string; files: number; languages: Record<string, number> },
): Promise<void> {
  await q.query(
    `INSERT INTO repo_indexes (repo_key, commit_sha, status, files, languages)
     VALUES ($1, $2, 'building', $3, $4::jsonb)
     ON CONFLICT (repo_key, commit_sha) DO UPDATE
       SET status = 'building', files = EXCLUDED.files, languages = EXCLUDED.languages,
           symbols = 0, edges = 0, duration_ms = NULL, error = NULL, built_at = now()`,
    [input.repoKey, input.commitSha, input.files, JSON.stringify(input.languages)],
  );
}

/** 收尾：状态 + 统计（两个 count 在同一个事务里从表里数，见文件头）。 */
export async function finishRepoIndex(
  q: Queryable,
  input: {
    repoKey: string;
    commitSha: string;
    status: Exclude<RepoIndexStatus, "building">;
    files: number;
    languages: Record<string, number>;
    durationMs: number;
    error?: string | null;
  },
): Promise<void> {
  await q.query(
    `UPDATE repo_indexes
        SET status = $3, files = $4, languages = $5::jsonb, duration_ms = $6, error = $7, built_at = now(),
            symbols = (SELECT count(*) FROM repo_symbols   WHERE repo_key = $1 AND commit_sha = $2),
            edges   = (SELECT count(*) FROM repo_refs      WHERE repo_key = $1 AND commit_sha = $2)
      WHERE repo_key = $1 AND commit_sha = $2`,
    [
      input.repoKey,
      input.commitSha,
      input.status,
      input.files,
      JSON.stringify(input.languages),
      input.durationMs,
      input.error ?? null,
    ],
  );
}

/** 索引失败：落一行 failed（解析崩了、库里写不进去都走这里）。 */
export async function failRepoIndex(
  q: Queryable,
  input: { repoKey: string; commitSha: string; files: number; languages: Record<string, number>; error: string; durationMs: number },
): Promise<void> {
  await q.query(
    `INSERT INTO repo_indexes (repo_key, commit_sha, status, files, languages, duration_ms, error)
     VALUES ($1, $2, 'failed', $3, $4::jsonb, $5, $6)
     ON CONFLICT (repo_key, commit_sha) DO UPDATE
       SET status = 'failed', files = EXCLUDED.files, languages = EXCLUDED.languages,
           symbols = 0, edges = 0, duration_ms = EXCLUDED.duration_ms, error = EXCLUDED.error, built_at = now()`,
    [input.repoKey, input.commitSha, input.files, JSON.stringify(input.languages), input.durationMs, input.error],
  );
}

/** 清掉某个 commit 的数据行（幂等写入的第一步；`repo_indexes` 那行不动，收尾时更新）。 */
export async function clearRepoIndexRows(q: Queryable, repoKey: string, commitSha: string): Promise<void> {
  for (const table of ["repo_symbols", "repo_refs", "repo_file_refs"]) {
    await q.query(`DELETE FROM ${table} WHERE repo_key = $1 AND commit_sha = $2`, [repoKey, commitSha]);
  }
}

/**
 * 增量：把上一版的行整段复制到新版（数据库内部搬，见文件头）。
 *
 * 三个排除集各有各的理由：
 *  - `excludeSymbolPaths`：变化文件的符号要重新解析（其余文件的符号不可能变）；
 *  - `excludeFileRefPaths`：变化文件的候选要重新提取；
 *  - `excludeRefFromPaths`：**变化文件 + 受影响文件**的边要重算（受影响 = 候选里有"定义集变了"的名字的文件）。
 */
export async function copyRepoIndexRows(
  q: Queryable,
  input: {
    repoKey: string;
    fromCommitSha: string;
    toCommitSha: string;
    excludeSymbolPaths?: readonly string[];
    excludeFileRefPaths?: readonly string[];
    excludeRefFromPaths?: readonly string[];
    /** 只重算某几个名字的边（受影响文件）：这些 `(path, symbol)` 不复制。 */
    excludeRefPairs?: readonly { path: string; symbol: string }[];
  },
): Promise<void> {
  await q.query(
    `INSERT INTO repo_symbols (repo_key, commit_sha, path, lang, name, kind, signature, start_line, end_line)
     SELECT repo_key, $3, path, lang, name, kind, signature, start_line, end_line
       FROM repo_symbols
      WHERE repo_key = $1 AND commit_sha = $2 AND NOT (path = ANY($4::text[]))`,
    [input.repoKey, input.fromCommitSha, input.toCommitSha, [...(input.excludeSymbolPaths ?? [])]],
  );
  const pairs = input.excludeRefPairs ?? [];
  await q.query(
    `INSERT INTO repo_refs (repo_key, commit_sha, from_path, to_path, symbol, weight)
     SELECT repo_key, $3, from_path, to_path, symbol, weight
       FROM repo_refs
      WHERE repo_key = $1 AND commit_sha = $2
        AND NOT (from_path = ANY($4::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM unnest($5::text[], $6::text[]) AS pair(path, symbol)
           WHERE pair.path = repo_refs.from_path AND pair.symbol = repo_refs.symbol
        )`,
    [
      input.repoKey,
      input.fromCommitSha,
      input.toCommitSha,
      [...(input.excludeRefFromPaths ?? [])],
      pairs.map((pair) => pair.path),
      pairs.map((pair) => pair.symbol),
    ],
  );
  await q.query(
    `INSERT INTO repo_file_refs (repo_key, commit_sha, path, symbol, kind)
     SELECT repo_key, $3, path, symbol, kind
       FROM repo_file_refs
      WHERE repo_key = $1 AND commit_sha = $2 AND NOT (path = ANY($4::text[]))`,
    [input.repoKey, input.fromCommitSha, input.toCommitSha, [...(input.excludeFileRefPaths ?? [])]],
  );
}

/** 插入符号行（分批：一次几千行，避免超过 PG 的参数上限）。 */
export async function insertRepoSymbols(
  q: Queryable,
  repoKey: string,
  commitSha: string,
  symbols: readonly (SymbolRecord & { path: string; lang: LanguageId })[],
): Promise<void> {
  await insertChunked(
    q,
    "repo_symbols",
    ["repo_key", "commit_sha", "path", "lang", "name", "kind", "signature", "start_line", "end_line"],
    symbols.map((symbol) => [
      repoKey,
      commitSha,
      symbol.path,
      symbol.lang,
      symbol.name,
      symbol.kind,
      symbol.signature,
      symbol.startLine,
      symbol.endLine,
    ]),
  );
}

export async function insertRepoRefs(q: Queryable, repoKey: string, commitSha: string, edges: readonly RefEdge[]): Promise<void> {
  await insertChunked(
    q,
    "repo_refs",
    ["repo_key", "commit_sha", "from_path", "to_path", "symbol", "weight"],
    edges.map((edge) => [repoKey, commitSha, edge.fromPath, edge.toPath, edge.symbol, edge.weight]),
  );
}

export async function insertRepoFileRefs(
  q: Queryable,
  repoKey: string,
  commitSha: string,
  refs: readonly { path: string; symbol: string; kind: "identifier" | "import" }[],
): Promise<void> {
  await insertChunked(
    q,
    "repo_file_refs",
    ["repo_key", "commit_sha", "path", "symbol", "kind"],
    refs.map((ref) => [repoKey, commitSha, ref.path, ref.symbol, ref.kind]),
  );
}

/**
 * 分批多行插入。表名与列名都是调用处的常量（不是用户输入），所以字符串拼接在这里是安全的；
 * 参数永远走 `$n`。
 */
async function insertChunked(
  q: Queryable,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  chunkSize = 500,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk
      .map((_, rowIndex) => `(${columns.map((__, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(", ")})`)
      .join(", ");
    const values = chunk.flat();
    // 空表不插：`INSERT … VALUES` 至少要有值，而且"没有行"本来就是正常情况。
    await q.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`, values);
  }
}

// ---------------------------------------------------------------- 读取

export async function getRepoIndex(q: Queryable, repoKey: string, commitSha: string): Promise<RepoIndexRow | null> {
  return maybeOne<RepoIndexRow>(
    q,
    "SELECT * FROM repo_indexes WHERE repo_key = $1 AND commit_sha = $2",
    [repoKey, commitSha],
  );
}

/**
 * 最近一次"可以当基准用"的索引。
 *
 * 只认 ready / unsupported（`unsupported` 是"这个仓库没有我们认识的语言"，它的空符号表同样是
 * 一个完整的事实）；`building` / `failed` 一律不算——拿半截结果做增量，增量出来的东西必然是错的。
 */
export async function latestRepoIndex(
  q: Queryable,
  repoKey: string,
  statuses: readonly RepoIndexStatus[] = ["ready", "unsupported"],
): Promise<RepoIndexRow | null> {
  return maybeOne<RepoIndexRow>(
    q,
    `SELECT * FROM repo_indexes
      WHERE repo_key = $1 AND status = ANY($2::text[])
      ORDER BY built_at DESC, commit_sha DESC
      LIMIT 1`,
    [repoKey, [...statuses]],
  );
}

/** 按路径/名字取符号。两个条件都给就是 AND（目前没有这种调用，留着急需时不用改签名）。 */
export async function listRepoSymbols(
  q: Queryable,
  repoKey: string,
  commitSha: string,
  filter: { paths?: readonly string[]; names?: readonly string[] } = {},
): Promise<RepoSymbolRow[]> {
  return many<RepoSymbolRow>(
    q,
    `SELECT * FROM repo_symbols
      WHERE repo_key = $1 AND commit_sha = $2
        AND ($3::text[] IS NULL OR path = ANY($3::text[]))
        AND ($4::text[] IS NULL OR name = ANY($4::text[]))
      ORDER BY path, start_line, name, kind`,
    [repoKey, commitSha, filter.paths === undefined ? null : [...filter.paths], filter.names === undefined ? null : [...filter.names]],
  );
}

/** 按路径/名字/种类取候选引用（增量重建的输入）。 */
export async function listRepoFileRefs(
  q: Queryable,
  repoKey: string,
  commitSha: string,
  filter: { paths?: readonly string[]; symbols?: readonly string[]; kind?: "identifier" | "import" } = {},
): Promise<RepoFileRefRow[]> {
  return many<RepoFileRefRow>(
    q,
    `SELECT * FROM repo_file_refs
      WHERE repo_key = $1 AND commit_sha = $2
        AND ($3::text[] IS NULL OR path = ANY($3::text[]))
        AND ($4::text[] IS NULL OR symbol = ANY($4::text[]))
        AND ($5::text IS NULL OR kind = $5)
      ORDER BY path, symbol, kind`,
    [
      repoKey,
      commitSha,
      filter.paths === undefined ? null : [...filter.paths],
      filter.symbols === undefined ? null : [...filter.symbols],
      filter.kind ?? null,
    ],
  );
}

/** 边。P9 的排名读全量（不带过滤），增量重建按名字读受影响的那几条。 */
export async function listRepoRefs(
  q: Queryable,
  repoKey: string,
  commitSha: string,
  filter: { fromPaths?: readonly string[]; symbols?: readonly string[] } = {},
): Promise<RepoRefRowRow[]> {
  return many<RepoRefRowRow>(
    q,
    `SELECT * FROM repo_refs
      WHERE repo_key = $1 AND commit_sha = $2
        AND ($3::text[] IS NULL OR from_path = ANY($3::text[]))
        AND ($4::text[] IS NULL OR symbol = ANY($4::text[]))
      ORDER BY from_path, to_path, symbol`,
    [repoKey, commitSha, filter.fromPaths === undefined ? null : [...filter.fromPaths], filter.symbols === undefined ? null : [...filter.symbols]],
  );
}

// ---------------------------------------------------------------- 保留策略

/**
 * 只保留最近 `keep` 版，把更老的 commit 的数据行整段删掉（spec 没规定，见附录 A-49）。
 *
 * 为什么要删：每索引一个 commit 就是一份完整的符号表副本，而索引是**每次 Run 都可能发生**的事
 * （P9 起）。不清理的话，一个活跃仓库一年能在库里堆出几十万行只被读过一次的数据。
 * 为什么保留 2：增量的基准是"上一版"，更老的版本唯一的价值是考古——而它是派生物，随时能重建。
 */
export async function pruneRepoIndexes(q: Queryable, repoKey: string, keep = 2): Promise<number> {
  const keepClause = `SELECT commit_sha FROM repo_indexes WHERE repo_key = $1 ORDER BY built_at DESC, commit_sha DESC LIMIT $2`;
  for (const table of ["repo_symbols", "repo_refs", "repo_file_refs"]) {
    await q.query(
      `DELETE FROM ${table}
        WHERE repo_key = $1 AND commit_sha NOT IN (${keepClause})`,
      [repoKey, keep],
    );
  }
  const deleted = await q.query(
    `DELETE FROM repo_indexes WHERE repo_key = $1 AND commit_sha NOT IN (${keepClause})`,
    [repoKey, keep],
  );
  return deleted.rowCount ?? 0;
}

// ---------------------------------------------------------------- 端口与 Postgres 实现

/** 一个文件的候选引用（`repo_file_refs` 的一行）。 */
export interface FileRefRowInput {
  path: string;
  symbol: string;
  kind: "identifier" | "import";
}

/** 一次索引写完所需的全部东西（`indexer.ts` 组装，`writeIndex` 在一个事务里落库）。 */
export interface WriteIndexInput {
  repoKey: string;
  commitSha: string;
  /** 增量：先从这个 commit 复制旧行再排除；全量传 null。 */
  copyFromCommitSha: string | null;
  excludeSymbolPaths: readonly string[];
  excludeFileRefPaths: readonly string[];
  /** 整段重算的边（变化文件）。 */
  excludeRefPaths: readonly string[];
  /** 只重算某几个名字的边（受影响文件）：这些 `(path, symbol)` 不复制。 */
  excludeRefPairs: readonly { path: string; symbol: string }[];
  symbols: readonly (SymbolRecord & { path: string; lang: LanguageId })[];
  fileRefs: readonly FileRefRowInput[];
  edges: readonly RefEdge[];
  status: "ready" | "unsupported";
  files: number;
  languages: Record<string, number>;
  durationMs: number;
  error: string | null;
  /** 写完只保留最近这么多版。 */
  keepCommits: number;
}

/**
 * `indexer.ts` 对这四张表的全部需要。
 *
 * 【为什么是端口，而不是把 `Queryable` 交给编排】单测要在没有 Postgres 的情况下验证增量——
 * 那是 P8 最难的一段逻辑（受影响集、排除集、以及"增量 == 全量"这条不变量）。
 * 端口只有 8 个方法，其中 `writeIndex` 把"复制 → 插入 → 计数 → 状态 → 清理"包成**一次**调用：
 * 那正是"它必须是一个事务"的意思。拆成几个方法让调用方拼，两个实现迟早会漂。
 *
 * 【为什么没有"删一半"的方法】`start` 与 `fail` 是两次独立的写入（独立事务）：
 * 前者让"跑到一半死了"留下一条 `building` 的事实，后者让失败有明确的终态。
 * 真正的数据行只在 `writeIndex` 那一个事务里动——失败就整个回滚，不会留下半份索引。
 */
export interface RepoIndexStore {
  start(input: { repoKey: string; commitSha: string; files: number; languages: Record<string, number> }): Promise<void>;
  get(repoKey: string, commitSha: string): Promise<RepoIndexRow | null>;
  /** 最近一次可以当增量基准的索引（只认 ready / unsupported）。 */
  latestReady(repoKey: string): Promise<RepoIndexRow | null>;
  /** 这些路径在上一版里的符号（算"哪些名字的定义集可能变了"）。 */
  symbolsInPaths(repoKey: string, commitSha: string, paths: readonly string[]): Promise<RepoSymbolRow[]>;
  /** 名字在这些集合里的符号（算受影响文件的候选所指向的定义集）。 */
  symbolsInNames(repoKey: string, commitSha: string, names: readonly string[]): Promise<RepoSymbolRow[]>;
  /** 候选里有这些名字的行（反查"谁引用了会变的名字"）。 */
  fileRefsInSymbols(repoKey: string, commitSha: string, symbols: readonly string[]): Promise<RepoFileRefRow[]>;
  /** 某一类候选的全部行（增量时要检查 import 解析是否变了）。 */
  fileRefsOfKind(repoKey: string, commitSha: string, kind: "identifier" | "import"): Promise<RepoFileRefRow[]>;
  writeIndex(input: WriteIndexInput): Promise<void>;
  fail(input: { repoKey: string; commitSha: string; files: number; languages: Record<string, number>; error: string; durationMs: number }): Promise<void>;
}

/** 生产实现。所有 SQL 都在这个文件里（§0.3 的边界：CP 侧，且只在这一层）。 */
export function postgresRepoIndexStore(db: Db): RepoIndexStore {
  return {
    start: (input) => startRepoIndex(db, input),
    get: (repoKey, commitSha) => getRepoIndex(db, repoKey, commitSha),
    latestReady: (repoKey) => latestRepoIndex(db, repoKey),
    symbolsInPaths: (repoKey, commitSha, paths) =>
      paths.length === 0 ? Promise.resolve([]) : listRepoSymbols(db, repoKey, commitSha, { paths }),
    symbolsInNames: (repoKey, commitSha, names) =>
      names.length === 0 ? Promise.resolve([]) : listRepoSymbols(db, repoKey, commitSha, { names }),
    fileRefsInSymbols: (repoKey, commitSha, symbols) =>
      symbols.length === 0 ? Promise.resolve([]) : listRepoFileRefs(db, repoKey, commitSha, { symbols }),
    fileRefsOfKind: (repoKey, commitSha, kind) => listRepoFileRefs(db, repoKey, commitSha, { kind }),

    async writeIndex(input) {
      await db.withTransaction(async (tx) => {
        // 幂等：先把这个 commit 的旧行整段删掉（主键能挡重复，挡不住"这次少了几个符号"的过期行）。
        await clearRepoIndexRows(tx, input.repoKey, input.commitSha);
        if (input.copyFromCommitSha !== null) {
          await copyRepoIndexRows(tx, {
            repoKey: input.repoKey,
            fromCommitSha: input.copyFromCommitSha,
            toCommitSha: input.commitSha,
            excludeSymbolPaths: input.excludeSymbolPaths,
            excludeFileRefPaths: input.excludeFileRefPaths,
            excludeRefFromPaths: input.excludeRefPaths,
            excludeRefPairs: input.excludeRefPairs,
          });
        }
        await insertRepoSymbols(tx, input.repoKey, input.commitSha, input.symbols);
        await insertRepoRefs(tx, input.repoKey, input.commitSha, input.edges);
        await insertRepoFileRefs(tx, input.repoKey, input.commitSha, input.fileRefs);
        await finishRepoIndex(tx, {
          repoKey: input.repoKey,
          commitSha: input.commitSha,
          status: input.status,
          files: input.files,
          languages: input.languages,
          durationMs: input.durationMs,
          error: input.error,
        });
        await pruneRepoIndexes(tx, input.repoKey, input.keepCommits);
      });
    },

    fail: (input) => failRepoIndex(db, input),
  };
}
