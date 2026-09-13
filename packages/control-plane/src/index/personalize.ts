/**
 * P9 · 个性化向量：把任务文本（issue 原文 + 任务书）变成"哪些文件更值得看"（spec Phase 9 §2）。
 *
 * 【它在整条链路里的位置】PageRank 回答的是"这个仓库的心脏在哪"，个性化回答的是"**这次任务**
 * 该从哪儿看起"。没有个性化时地图是同一张（把仓库里最中心的东西排前面），有了之后
 * "修 billing 的退款"会把 `src/billing/*` 顶上去。两者是同一个 PageRank 的两半：
 * 权重作为跳转向量传进去（`rank.ts`），而不是在结果上再乘一次——后者会让"中心但无关"的文件
 * 仍然排在前面。
 *
 * 【匹配口径：词，而不是子串】任务文本先切成词（驼峰 / 下划线 / 数字边界 / 标点都切），
 * 再与符号名的**词组成**比对：`refundInvoice` 这个名字的两段 `refund` + `invoice` 都在任务里
 * 出现才算命中。没有前缀匹配、没有编辑距离、没有大小写以外的模糊——设计文档 §D.3 的
 * "宁可少一条边，不要错一条边"在这里同样是"宁可漏一个文件，不要把不相干的文件顶上去"。
 * 顺带的好处是键很短：词只要有个集合，缓存键（`personalizationHash`）就只依赖这一小撮词。
 *
 * 【为什么停用词表里既有英文虚词、又有语言关键字、还有目录名】三者都会在 issue 文本里
 * 大量出现（"the function in src is broken"），而它们命中任何东西的概率远大于命中"正确的那个"
 * 的概率。目录名那一小撮同样：`src` / `lib` / `test` 提到它们等于什么都没说。
 *
 * 【为什么权重是 1.0 / 0.5 / 0.5 三档】spec §2 给的数：符号名命中 1、文件名与同目录命中 0.5。
 * 三档的顺序（符号 > 文件 ≈ 目录）才是这条规则的全部信息量，绝对值只影响与 PageRank 的
 * 初始分布，归一化之后都消掉了。
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------- 常量

/** 符号名精确命中（spec §2：`p[file] += 1`）。 */
export const SYMBOL_HIT_WEIGHT = 1;

/** 文件名命中（该文件本身，以及它的同目录文件）。 */
export const FILE_HIT_WEIGHT = 0.5;

/** 目录名命中（该目录下直接的文件）。 */
export const DIRECTORY_HIT_WEIGHT = 0.5;

/** 比这个短的词不进候选（`a` / `x` / `id` 里的单个字母是噪声）。 */
export const MIN_TERM_LENGTH = 2;

/**
 * 停用词：任务文本里高频、但命中什么都说明不了的那些词。
 *
 * 【为什么把 `get` / `set` / `update` 这类也放进来】它们是**代码里的通用动词**：一个 5k 文件的
 * 仓库里叫 `update` / `get` / `remove` 的符号能有几十个，命中它们只会把一堆不相干的文件
 * 顶上排行榜。而 issue 里说"update the parser"时，真正该命中的是 `parser`（那才是名词）。
 * 【为什么目录名也在这里】`src` / `lib` / `test` 出现在 issue 里通常是路径的一部分（"src 下"），
 * 而把所有 `src/*` 都加 0.5 等于给半个仓库加上同一个偏置。
 */
const STOP_WORDS = new Set([
  // 英文虚词 / issue 里的高频词
  "the", "a", "an", "and", "or", "but", "not", "no", "yes", "for", "with", "without", "from", "into", "onto",
  "this", "that", "these", "those", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
  "has", "have", "had", "will", "would", "can", "could", "should", "must", "may", "might", "shall",
  "when", "where", "which", "what", "why", "how", "who", "whom", "whose", "if", "then", "than", "there",
  "here", "it", "its", "as", "at", "by", "in", "on", "of", "to", "up", "out", "off", "over", "under",
  "again", "very", "just", "about", "after", "before", "because", "while", "during", "all", "any", "some",
  "more", "most", "only", "also", "one", "two", "new", "old", "same", "other", "such", "so", "too",
  "please", "want", "wants", "need", "needs", "problem", "issue", "bug", "error", "expected", "actual",
  "reproduce", "steps", "case", "cases", "example", "examples", "version", "versions",
  // 通用动词（见文件头）
  "add", "adds", "added", "remove", "removes", "removed", "update", "updates", "updated", "use", "uses",
  "used", "using", "make", "makes", "made", "get", "gets", "got", "set", "sets", "run", "runs", "ran",
  "fix", "fixes", "fixed", "support", "supports", "change", "changes", "changed", "check", "checks",
  // 语言关键字（spec §2 要求去掉）
  "function", "functions", "class", "classes", "method", "methods", "interface", "interfaces", "type", "types",
  "const", "let", "var", "return", "returns", "import", "imports", "export", "exports", "default", "public",
  "private", "protected", "static", "void", "new", "this", "self", "super", "true", "false", "null",
  "undefined", "none", "async", "await", "yield", "def", "end", "elif", "lambda", "pass", "raise", "try",
  "catch", "except", "finally", "throw", "throws", "switch", "case", "break", "continue", "package",
  "struct", "impl", "trait", "pub", "fn", "mut", "mod", "enum", "namespace", "using", "extends",
  "implements", "constructor", "prototype", "require", "module", "string", "number", "boolean", "object",
  "array", "list", "dict", "int", "float", "double", "char", "bool", "byte", "short", "long", "unsigned",
  // 目录名（见文件头）
  "src", "lib", "libs", "dist", "build", "out", "bin", "node_modules", "vendor", "third_party", "tmp",
  "temp", "coverage", "docs", "doc", "test", "tests", "spec", "specs", "scripts", "script", "assets",
  "static", "public", "images", "img", "fixtures",
]);

/** 个性化算法的版本；渲染逻辑一变就加一，让老缓存自然失效（键里带上它）。 */
export const PERSONALIZATION_VERSION = 1;

// ---------------------------------------------------------------- 词

/**
 * 任务文本 → 词集合。返回值**去重且已排序**（哈希与遍历顺序都靠它）。
 *
 * 切词规则：标点/空白/下划线先切一刀，再在最常见的驼峰边界上切第二刀（`refundInvoice` →
 * `refund` + `invoice`，`HTTPClient` → `http` + `client`），最后数字与字母之间也切。
 * 全部小写——大小写不是有意义的信号（`Ledger` 与 `ledger` 说的是同一个东西）。
 */
export function taskTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const word of wordsOf(text)) {
    if (word.length < MIN_TERM_LENGTH || STOP_WORDS.has(word)) continue;
    terms.add(word);
  }
  return [...terms].sort();
}

/** 缓存键里的那半：任务词的哈希（`repo_maps.personalization_hash`）。 */
export function personalizationHash(terms: readonly string[]): string {
  return createHash("sha256").update(`repo-map-v${PERSONALIZATION_VERSION}\n${terms.join(" ")}`, "utf8").digest("hex");
}

// ---------------------------------------------------------------- 向量

export interface PersonalizationInput {
  task: string;
  /** 索引里的符号（`repo_symbols` 的行）。只要 `path` 与 `name`，别的字段不参与。 */
  symbols: readonly { path: string; name: string }[];
  /**
   * 参与排名的文件（P9 里是"有符号或被引用的文件"）。
   *
   * 【为什么要它】"文件名 / 目录名命中"与"同目录文件"两条规则需要知道仓库里有哪些文件；
   * 只给符号的话，一个只有 `index.ts` 的文件夹根本不会被目录名命中——
   * 而那正是 issue 说"billing 那个目录"时想要的效果。
   */
  files?: readonly string[];
}

export interface Personalization {
  /** 已归一化（和为 1）；`null` = 一个词都没命中，调用方应当退化成均匀分布。 */
  weights: Map<string, number> | null;
  terms: string[];
  /** 命中的符号名（去重升序；给日志与 UI 用）。 */
  matchedSymbols: string[];
  /** 被直接命中的文件（符号 / 文件名 / 目录名；不含"仅仅同目录"的那些）。 */
  matchedPaths: string[];
}

const EMPTY: readonly string[] = [];

export function personalizationOf(input: PersonalizationInput): Personalization {
  const terms = taskTerms(input.task);
  const termSet = new Set(terms);
  const weights = new Map<string, number>();
  const matchedSymbols = new Set<string>();
  const matchedPaths = new Set<string>();

  const bump = (path: string, delta: number): void => {
    weights.set(path, (weights.get(path) ?? 0) + delta);
  };

  // ① 符号名命中（权重 1.0）。
  for (const symbol of input.symbols) {
    if (!nameMatches(symbol.name, termSet)) continue;
    matchedSymbols.add(symbol.name);
    matchedPaths.add(symbol.path);
    bump(symbol.path, SYMBOL_HIT_WEIGHT);
  }

  const files = input.files ?? EMPTY;
  const filesByDirectory = groupByDirectory(files);

  // ② 目录名命中（权重 0.5）：该目录下直接的文件。
  for (const directory of [...filesByDirectory.keys()].sort()) {
    const name = lastSegment(directory);
    if (name === "" || !nameMatches(name, termSet)) continue;
    for (const file of filesByDirectory.get(directory)!) {
      matchedPaths.add(file);
      bump(file, DIRECTORY_HIT_WEIGHT);
    }
  }

  // ③ 文件名命中（权重 0.5）：该文件本身，以及同目录的其它文件。
  const directoryOfFile = new Map<string, string>();
  for (const [directory, members] of filesByDirectory) for (const file of members) directoryOfFile.set(file, directory);
  for (const file of [...files].sort()) {
    if (!nameMatches(fileBaseName(file), termSet)) continue;
    matchedPaths.add(file);
    bump(file, FILE_HIT_WEIGHT);
    for (const sibling of filesByDirectory.get(directoryOfFile.get(file) ?? "") ?? EMPTY) {
      if (sibling !== file) bump(sibling, FILE_HIT_WEIGHT);
    }
  }

  let sum = 0;
  for (const weight of weights.values()) sum += weight;
  const summary = {
    terms,
    matchedSymbols: [...matchedSymbols].sort(),
    matchedPaths: [...matchedPaths].sort(),
  };
  if (!(sum > 0)) return { weights: null, ...summary };

  const normalized = new Map<string, number>();
  for (const path of [...weights.keys()].sort()) normalized.set(path, weights.get(path)! / sum);
  return { weights: normalized, ...summary };
}

// ---------------------------------------------------------------- 小工具

/**
 * 名字匹配：把这个名字切成词，**每一段都要在任务词里**（见文件头）。
 *
 * 单段名字就是"这个词出现过"（`billing` ← 任务里的 "billing"）；多段名字要求全中
 * （`refundInvoice` ← 任务里的 "refund invoice" 或 "refundInvoice"）。
 */
function nameMatches(name: string, terms: ReadonlySet<string>): boolean {
  const parts = wordsOf(name);
  if (parts.length === 0) return false;
  for (const part of parts) if (!terms.has(part)) return false;
  return true;
}

/** 一段文本 → 小写词（标点/空白/下划线切一刀，驼峰与数字边界再切一刀）。 */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (raw === "") continue;
    for (const part of splitIdentifier(raw)) out.push(part.toLowerCase());
  }
  return out;
}

/**
 * 驼峰边界切词（`refundInvoice` → `refund` + `invoice`，`HTTPClient` → `HTTP` + `Client`）。
 *
 * 【为什么不在数字边界上切】`utf8` / `sha256` / `v2` 是一个词：切开之后 `8` / `2` 会被
 * 最短长度过滤掉，于是 `billing_v2` 这个名字反而再也匹配不上（单测里有一条盯这个）。
 */
export function splitIdentifier(token: string): string[] {
  return token
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/\s+/)
    .filter((part) => part !== "");
}

/** `src/billing/refund.ts` 的目录是 `src/billing`（根目录是 `""`）。 */
function directoryOf(file: string): string {
  const cut = file.lastIndexOf("/");
  return cut === -1 ? "" : file.slice(0, cut);
}

/** `src/billing/refund.ts` → `refund`（去掉扩展名；`types.d.ts` 这种去掉 `.d.ts`）。 */
function fileBaseName(file: string): string {
  const name = lastSegment(file);
  const base = name.replace(/(\.d)?\.[^.]*$/, "");
  return base === "" ? name : base;
}

function lastSegment(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

function groupByDirectory(files: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of files) {
    const directory = directoryOf(file);
    const members = out.get(directory);
    if (members === undefined) out.set(directory, [file]);
    else members.push(file);
  }
  return out;
}
