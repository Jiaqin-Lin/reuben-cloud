/**
 * P8/P9 单测的替身：内存版 `RepoIndexStore` 与 `RepoMapStore`、脚本化的假 parser、假 git 端口。
 *
 * 【为什么值得写这几个】P8 最难的一段逻辑是**增量**：受影响集怎么算、哪些旧行不复制、
 * 以及"增量结果 == 全量结果"这条不变量。P9 最难的一段是**缓存与降级**：命中时到底读了几次库、
 * 索引不可用时输出什么、指纹变了之后旧地图算不算命中。把这两样都留到集成测试里验，
 * 等于每次改一行逻辑都要起一次 Postgres 容器；而它们本身没有一处需要真库。
 * 真库要验的是另一件事：SQL 的复制/排除/upsert 与内存实现的行为一致（见集成测试）。
 *
 * 【它不替代什么】这两个内存实现是**照 SQL 语义写的**，不是 SQL 的证明：
 * `INSERT … SELECT`、`unnest(pairs)`、`ON CONFLICT DO UPDATE` 这些只有真库能证。
 * 所以集成测试会用同一组场景再跑一遍。
 */

import { readFile } from "node:fs/promises";
import type { BatchParser, DiffEntry, IndexGitPort } from "../src/index/indexer.ts";
import type { ParseOutcome, ParsedFile, ParseFileStatus } from "../src/index/parse.ts";
import type { LanguageId } from "../src/index/symbols.ts";
import type {
  FileRefRowInput,
  RepoFileRefRow,
  RepoIndexRow,
  RepoIndexStore,
  RepoMapRow,
  RepoMapStore,
  RepoRefRowRow,
  RepoSymbolRow,
  WriteIndexInput,
} from "../src/index/store.ts";

// ---------------------------------------------------------------- 内存 store

function key(repoKey: string, commitSha: string): string {
  return `${repoKey}\u0000${commitSha}`;
}

/** 内存 store 多出来的两个口：直接看行（断言用），以及调用计数（断言"没重写/没重算"用）。 */
export interface MemoryRepoIndexStore extends RepoIndexStore {
  symbols(repoKey: string, commitSha: string): RepoSymbolRow[];
  refs(repoKey: string, commitSha: string): RepoRefRowRow[];
  fileRefs(repoKey: string, commitSha: string): RepoFileRefRow[];
  /** 每个方法被调了几次（行为断言：reuse 不该写行、跳过时不该写行）。 */
  readonly calls: Record<string, number>;
}

/**
 * 一个内存实现，语义与 `postgresRepoIndexStore` 逐条对应（复制、排除、先删后插、保留 N 版）。
 * `built_at` 用一个自增计数代替时钟：断言里要按顺序比较，用 `Date.now()` 会不稳定。
 */
export function memoryRepoIndexStore(): MemoryRepoIndexStore {
  const indexes = new Map<string, RepoIndexRow>();
  const symbols = new Map<string, RepoSymbolRow[]>();
  const refs = new Map<string, RepoRefRowRow[]>();
  const fileRefs = new Map<string, RepoFileRefRow[]>();
  const calls: Record<string, number> = {};
  let clock = 0;

  const count = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };

  function prune(repoKey: string, keep: number): void {
    const mine = [...indexes.entries()].filter(([, row]) => row.repo_key === repoKey);
    mine.sort((a, b) => b[1].built_at.getTime() - a[1].built_at.getTime() || (a[1].commit_sha < b[1].commit_sha ? 1 : -1));
    for (const [entryKey, row] of mine.slice(keep)) {
      indexes.delete(entryKey);
      symbols.delete(entryKey);
      refs.delete(entryKey);
      fileRefs.delete(entryKey);
    }
  }

  return {
    calls,

    async start(input) {
      count("start");
      const entryKey = key(input.repoKey, input.commitSha);
      const previous = indexes.get(entryKey);
      indexes.set(entryKey, {
        repo_key: input.repoKey,
        commit_sha: input.commitSha,
        status: "building",
        files: input.files,
        symbols: 0,
        edges: 0,
        languages: input.languages,
        duration_ms: null,
        error: null,
        built_at: previous?.built_at ?? new Date(clock++),
      });
    },

    async get(repoKey, commitSha) {
      count("get");
      return indexes.get(key(repoKey, commitSha)) ?? null;
    },

    async latestReady(repoKey) {
      count("latestReady");
      const mine = [...indexes.values()].filter(
        (row) => row.repo_key === repoKey && (row.status === "ready" || row.status === "unsupported"),
      );
      mine.sort((a, b) => b.built_at.getTime() - a.built_at.getTime() || (a.commit_sha < b.commit_sha ? 1 : -1));
      return mine[0] ?? null;
    },

    async symbolsInPaths(repoKey, commitSha, paths) {
      count("symbolsInPaths");
      const wanted = new Set(paths);
      return (symbols.get(key(repoKey, commitSha)) ?? []).filter((row) => wanted.has(row.path));
    },

    async symbolsInNames(repoKey, commitSha, names) {
      count("symbolsInNames");
      const wanted = new Set(names);
      return (symbols.get(key(repoKey, commitSha)) ?? []).filter((row) => wanted.has(row.name));
    },

    async fileRefsInSymbols(repoKey, commitSha, wanted) {
      count("fileRefsInSymbols");
      const set = new Set(wanted);
      return (fileRefs.get(key(repoKey, commitSha)) ?? []).filter((row) => set.has(row.symbol));
    },

    async fileRefsOfKind(repoKey, commitSha, kind) {
      count("fileRefsOfKind");
      return (fileRefs.get(key(repoKey, commitSha)) ?? []).filter((row) => row.kind === kind);
    },

    async allSymbols(repoKey, commitSha) {
      count("allSymbols");
      return [...(symbols.get(key(repoKey, commitSha)) ?? [])];
    },

    async allRefs(repoKey, commitSha) {
      count("allRefs");
      return [...(refs.get(key(repoKey, commitSha)) ?? [])];
    },

    async writeIndex(input: WriteIndexInput) {
      count("writeIndex");
      const entryKey = key(input.repoKey, input.commitSha);
      symbols.delete(entryKey);
      refs.delete(entryKey);
      fileRefs.delete(entryKey);

      if (input.copyFromCommitSha !== null) {
        const from = key(input.repoKey, input.copyFromCommitSha);
        const excludeSymbols = new Set(input.excludeSymbolPaths);
        const excludeFileRefs = new Set(input.excludeFileRefPaths);
        const excludeRefs = new Set(input.excludeRefPaths);
        const excludePairs = new Set(input.excludeRefPairs.map((pair) => `${pair.path}\u0000${pair.symbol}`));
        symbols.set(
          entryKey,
          (symbols.get(from) ?? []).filter((row) => !excludeSymbols.has(row.path)).map((row) => ({ ...row, commit_sha: input.commitSha })),
        );
        refs.set(
          entryKey,
          (refs.get(from) ?? [])
            .filter((row) => !excludeRefs.has(row.from_path) && !excludePairs.has(`${row.from_path}\u0000${row.symbol}`))
            .map((row) => ({ ...row, commit_sha: input.commitSha })),
        );
        fileRefs.set(
          entryKey,
          (fileRefs.get(from) ?? []).filter((row) => !excludeFileRefs.has(row.path)).map((row) => ({ ...row, commit_sha: input.commitSha })),
        );
      } else {
        symbols.set(entryKey, []);
        refs.set(entryKey, []);
        fileRefs.set(entryKey, []);
      }

      for (const symbol of input.symbols) {
        symbols.get(entryKey)!.push({
          repo_key: input.repoKey,
          commit_sha: input.commitSha,
          path: symbol.path,
          lang: symbol.lang,
          name: symbol.name,
          kind: symbol.kind,
          signature: symbol.signature,
          start_line: symbol.startLine,
          end_line: symbol.endLine,
        });
      }
      for (const ref of input.fileRefs as readonly FileRefRowInput[]) {
        fileRefs.get(entryKey)!.push({ repo_key: input.repoKey, commit_sha: input.commitSha, ...ref });
      }
      for (const edge of input.edges) {
        refs.get(entryKey)!.push({
          repo_key: input.repoKey,
          commit_sha: input.commitSha,
          from_path: edge.fromPath,
          to_path: edge.toPath,
          symbol: edge.symbol,
          weight: edge.weight,
        });
      }

      indexes.set(entryKey, {
        repo_key: input.repoKey,
        commit_sha: input.commitSha,
        status: input.status,
        files: input.files,
        symbols: symbols.get(entryKey)!.length,
        edges: refs.get(entryKey)!.length,
        languages: input.languages,
        duration_ms: input.durationMs,
        error: input.error,
        built_at: new Date(clock++),
      });
      prune(input.repoKey, input.keepCommits);
    },

    async fail(input) {
      count("fail");
      const entryKey = key(input.repoKey, input.commitSha);
      symbols.delete(entryKey);
      refs.delete(entryKey);
      fileRefs.delete(entryKey);
      indexes.set(entryKey, {
        repo_key: input.repoKey,
        commit_sha: input.commitSha,
        status: "failed",
        files: input.files,
        symbols: 0,
        edges: 0,
        languages: input.languages,
        duration_ms: input.durationMs,
        error: input.error,
        built_at: new Date(clock++),
      });
    },

    symbols: (repoKey, commitSha) => [...(symbols.get(key(repoKey, commitSha)) ?? [])],
    refs: (repoKey, commitSha) => [...(refs.get(key(repoKey, commitSha)) ?? [])],
    fileRefs: (repoKey, commitSha) => [...(fileRefs.get(key(repoKey, commitSha)) ?? [])],
  };
}

// ---------------------------------------------------------------- 手摆一份快照

/** 往内存索引库里塞一份"已经索引好"的快照（`writeIndex` 的参数太多，单测里只关心内容）。 */
export interface SeedRepoIndexSymbol {
  path: string;
  name: string;
  kind?: "function" | "class" | "method" | "interface" | "type" | "const";
  signature?: string;
  startLine?: number;
  endLine?: number;
  lang?: LanguageId;
}

export async function seedRepoIndex(
  store: MemoryRepoIndexStore,
  input: {
    repoKey: string;
    commitSha: string;
    symbols?: readonly SeedRepoIndexSymbol[];
    edges?: readonly { fromPath: string; toPath: string; symbol: string; weight: number }[];
    fileRefs?: readonly { path: string; symbol: string; kind: "identifier" | "import" }[];
    languages?: Record<string, number>;
    files?: number;
    status?: "ready" | "unsupported";
  },
): Promise<void> {
  const symbols = input.symbols ?? [];
  const languages = input.languages ?? (symbols.length === 0 ? {} : { typescript: new Set(symbols.map((symbol) => symbol.path)).size });
  await store.start({ repoKey: input.repoKey, commitSha: input.commitSha, files: input.files ?? 0, languages });
  await store.writeIndex({
    repoKey: input.repoKey,
    commitSha: input.commitSha,
    copyFromCommitSha: null,
    excludeSymbolPaths: [],
    excludeFileRefPaths: [],
    excludeRefPaths: [],
    excludeRefPairs: [],
    symbols: symbols.map((symbol) => ({
      path: symbol.path,
      lang: symbol.lang ?? "typescript",
      name: symbol.name,
      kind: symbol.kind ?? "function",
      signature: symbol.signature ?? `export function ${symbol.name}()`,
      startLine: symbol.startLine ?? 1,
      endLine: symbol.endLine ?? (symbol.startLine ?? 1) + 1,
    })),
    fileRefs: input.fileRefs ?? [],
    edges: (input.edges ?? []).map((edge) => ({ ...edge })),
    status: input.status ?? "ready",
    files: input.files ?? 0,
    languages,
    durationMs: 1,
    error: null,
    keepCommits: 2,
  });
}

// ---------------------------------------------------------------- 内存地图缓存

/** 内存版 `RepoMapStore` 多出来的口：看行、调用计数、以及“故意坏一下”（降级的 warn 路径要能测）。 */
export interface MemoryRepoMapStore extends RepoMapStore {
  rows(): RepoMapRow[];
  readonly calls: Record<string, number>;
  /** 置 true 之后对应方法抛错（验证“缓存坏了不影响地图”这条）。 */
  readonly failing: { get: boolean; put: boolean };
}

/**
 * 与 `postgresRepoMapStore` 逐条对应：get / upsert / latestBuiltAt / prune。
 *
 * `built_at` 用一个自增计数代替时钟（P8 的内存 store 同一条理由：断言里要比先后，
 * `Date.now()` 在同一个毫秒里会给出相同的值）。
 */
export function memoryRepoMapStore(): MemoryRepoMapStore {
  const rows = new Map<string, RepoMapRow>();
  const calls: Record<string, number> = {};
  const failing = { get: false, put: false };
  let clock = 0;

  const count = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const rowKey = (input: { repoKey: string; commitSha: string; personalizationHash: string; budgetTokens: number }): string =>
    [input.repoKey, input.commitSha, input.personalizationHash, String(input.budgetTokens)].join("\u0000");

  return {
    calls,
    failing,

    async get(input) {
      count("get");
      if (failing.get) throw new Error("scripted cache read failure");
      return rows.get(rowKey(input)) ?? null;
    },

    async put(row) {
      count("put");
      if (failing.put) throw new Error("scripted cache write failure");
      const stored: RepoMapRow = { ...row, built_at: new Date(clock++) };
      rows.set(rowKey({ repoKey: row.repo_key, commitSha: row.commit_sha, personalizationHash: row.personalization_hash, budgetTokens: row.budget_tokens }), stored);
    },

    async latestBuiltAt(repoKey, commitSha) {
      count("latestBuiltAt");
      const mine = [...rows.values()].filter((row) => row.repo_key === repoKey && row.commit_sha === commitSha);
      mine.sort((a, b) => b.built_at.getTime() - a.built_at.getTime());
      return mine[0]?.built_at ?? null;
    },

    async prune(repoKey, keepCommits) {
      count("prune");
      const mine = [...rows.values()].filter((row) => row.repo_key === repoKey);
      const byCommit = new Map<string, number>();
      for (const row of mine) byCommit.set(row.commit_sha, Math.max(byCommit.get(row.commit_sha) ?? -1, row.built_at.getTime()));
      const keep = new Set(
        [...byCommit.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))
          .slice(0, keepCommits)
          .map(([commitSha]) => commitSha),
      );
      let deleted = 0;
      for (const row of mine) {
        if (keep.has(row.commit_sha)) continue;
        rows.delete(rowKey({ repoKey: row.repo_key, commitSha: row.commit_sha, personalizationHash: row.personalization_hash, budgetTokens: row.budget_tokens }));
        deleted += 1;
      }
      return deleted;
    },

    rows: () => [...rows.values()],
  };
}

// ---------------------------------------------------------------- 假 parser

export interface FakeFile {
  symbols?: { name: string; kind?: "function" | "class" | "method" | "interface" | "type" | "const"; signature?: string; startLine?: number; endLine?: number }[];
  identifiers?: string[];
  imports?: string[];
  status?: ParseFileStatus;
}

/** 一批文件的返回值，外加"每次解析了哪些文件"的记录。 */
export interface FakeParser {
  parser: BatchParser;
  /** 每次调用解析的路径列表（增量断言的核心：第二次只该出现变化文件）。 */
  calls: string[][];
}

/**
 * 按"路径 → 内容"的脚本产出解析结果。
 *
 * 【为什么状态也叫脚本化】超时 / 崩溃这些降级路径必须能被造出来——真让 tree-sitter 解析
 * 超过 200ms 需要一个足够病态的输入，而这里只要写 `status: "timeout"`。
 */
export function fakeParser(files: Record<string, FakeFile>, outcome: { crashed?: boolean; timedOut?: boolean; stderr?: string } = {}): FakeParser {
  const calls: string[][] = [];
  const parser: BatchParser = async (input) => {
    calls.push(input.files.map((file) => file.path));
    if (outcome.crashed === true) {
      return {
        files: [],
        timedOut: false,
        crashed: true,
        exitCode: 1,
        stderr: outcome.stderr ?? "boom",
        parseMs: 0,
        wallMs: 0,
        timedOutFiles: [],
      } satisfies ParseOutcome;
    }
    const parsed: ParsedFile[] = input.files.map((file) => {
      const script = files[file.path] ?? {};
      const status = script.status ?? "ok";
      return {
        path: file.path,
        lang: file.lang,
        status,
        symbols: (script.symbols ?? []).map((symbol) => ({
          name: symbol.name,
          kind: symbol.kind ?? "function",
          signature: symbol.signature ?? `function ${symbol.name}`,
          startLine: symbol.startLine ?? 1,
          endLine: symbol.endLine ?? 1,
        })),
        identifiers: script.identifiers ?? [],
        imports: script.imports ?? [],
        durationMs: 1,
        bytes: 10,
        error: status === "ok" ? null : `scripted ${status}`,
      };
    });
    return {
      files: status(parsed),
      timedOut: outcome.timedOut ?? false,
      crashed: false,
      exitCode: 0,
      stderr: outcome.stderr ?? "",
      parseMs: parsed.length,
      wallMs: parsed.length,
      timedOutFiles: parsed.filter((file) => file.status === "timeout").map((file) => file.path),
    } satisfies ParseOutcome;
  };
  return { parser, calls };

  // 非 ok 的文件在真实实现里是没有符号 / 没有引用的；替身保持同样的形状。
  function status(parsed: ParsedFile[]): ParsedFile[] {
    return parsed.map((file) =>
      file.status === "ok" ? file : { ...file, symbols: [], identifiers: [], imports: [] },
    );
  }
}


// ---------------------------------------------------------------- 按内容解析的假 parser

/**
 * 一个"按文件内容解析"的假 parser：内容里的标记行就是解析结果。
 *
 * ```
 *   sym:foo            一个函数符号（`sym:class Bar` / `sym:method Baz` 可指定 kind）
 *   ref:foo,bar        候选标识符
 *   imp:./x.ts,app     候选 import 路径
 *   status:timeout     让这个文件以某种降级状态返回（timeout / error / too_large）
 * ```
 *
 * 【为什么它必须读文件，而不是"按路径给一份脚本"】第一版是按路径写脚本的，于是踩了一个坑：
 * 增量只解析变化文件，不变文件在新提交里"应该解析出什么"根本没人校验——测试里悄悄出现了
 * "这个文件在这一版其实已经没有那个符号了，但增量把旧的复制了过来"，而哈希断言比对的两边
 * 用了不同的剧本，于是它比的是两份剧本而不是两份实现。读内容之后，全量与增量看到的是**同一个事实**：
 * 同一份文件内容 → 同一份解析结果，与"这次解析了它没有"无关。
 */
export function contentParser(options: { timedOut?: boolean } = {}): BatchParser {
  return async (input) => {
    const parsed: ParsedFile[] = [];
    for (const file of input.files) {
      const absolute = `${input.root}/${file.path}`;
      let text: string;
      try {
        text = await readFile(absolute, "utf8");
      } catch (error) {
        parsed.push({
          path: file.path,
          lang: file.lang,
          status: "unreadable",
          symbols: [],
          identifiers: [],
          imports: [],
          durationMs: 0,
          bytes: 0,
          error: String(error),
        });
        continue;
      }
      const script = scriptFromContent(text);
      const status = script.status ?? "ok";
      parsed.push({
        path: file.path,
        lang: file.lang,
        status,
        symbols:
          status === "ok"
            ? (script.symbols ?? []).map((symbol) => ({
                name: symbol.name,
                kind: symbol.kind ?? "function",
                signature: symbol.signature ?? `function ${symbol.name}`,
                startLine: symbol.startLine ?? 1,
                endLine: symbol.endLine ?? 1,
              }))
            : [],
        identifiers: status === "ok" ? (script.identifiers ?? []) : [],
        imports: status === "ok" ? (script.imports ?? []) : [],
        durationMs: 1,
        bytes: text.length,
        error: null,
      });
    }
    return {
      files: parsed,
      timedOut: options.timedOut ?? false,
      crashed: false,
      exitCode: 0,
      stderr: "",
      parseMs: parsed.length,
      wallMs: parsed.length,
      timedOutFiles: parsed.filter((file) => file.status === "timeout").map((file) => file.path),
    } satisfies ParseOutcome;
  };
}

/** 包一层，记下"每次调用解析了哪些文件"（增量断言的核心）。 */
export function trackingParser(inner: BatchParser): FakeParser {
  const calls: string[][] = [];
  return {
    calls,
    parser: async (input) => {
      calls.push(input.files.map((file) => file.path));
      return inner(input);
    },
  };
}

/** 把标记文本翻成一份解析结果（只有 `contentParser` 用它）。 */
function scriptFromContent(text: string): FakeFile {
  const out: FakeFile = { symbols: [], identifiers: [], imports: [] };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const [marker, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (marker === "sym") {
      const [kind, name] = value.includes(" ") ? (value.split(/\s+/) as [string, string]) : ["function", value];
      out.symbols!.push({ name: name!, kind: kind as "function" });
    } else if (marker === "ref") {
      out.identifiers!.push(...value.split(",").map((item) => item.trim()).filter((item) => item !== ""));
    } else if (marker === "imp") {
      out.imports!.push(...value.split(",").map((item) => item.trim()).filter((item) => item !== ""));
    } else if (marker === "status") {
      out.status = value as ParseFileStatus;
    }
  }
  return out;
}

// ---------------------------------------------------------------- 假 git

export interface FakeGit extends IndexGitPort {
  /** 每个 commit 的父提交（用来回答"是不是祖先"）。 */
  diffs: Map<string, DiffEntry[]>;
}

export function fakeGit(input: { head: string; ancestry?: Record<string, string[]>; diffs: Record<string, DiffEntry[]> }): FakeGit {
  const ancestry = input.ancestry ?? {};
  return {
    diffs: new Map(Object.entries(input.diffs)),
    async head() {
      return input.head;
    },
    async isAncestor(fromSha, toSha) {
      if (fromSha === toSha) return true;
      const seen = new Set<string>();
      const stack = [toSha];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === fromSha) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        stack.push(...(ancestry[current] ?? []));
      }
      return false;
    },
    async diff(fromSha, toSha) {
      const entries = this.diffs.get(`${fromSha}..${toSha}`);
      if (entries === undefined) throw new Error(`没有为 ${fromSha}..${toSha} 准备 diff`);
      return entries;
    },
  };
}
