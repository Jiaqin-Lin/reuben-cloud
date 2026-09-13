/**
 * P9 · 渲染：把"排好序的文件 + 符号"压成一段固定预算的文本（spec Phase 9 §3）。
 *
 * 【为什么它是纯函数、为什么必须是】地图每轮都进提示词缓存前缀（tools → system → repo_map），
 * 所以同一份输入必须给出**逐字节相同**的文本（设计文档 §D.3 第 3 条）。纯函数是这条性质的
 * 最便宜的实现方式：没有 IO、没有时钟、没有随机、没有 locale（排序用 `a < b`，不用
 * `localeCompare`——后者的结果取决于运行环境）。
 *
 * 【预算怎么算，为什么不会超】token 估算沿用 compaction / 分区统计的口径：`ceil(chars / 4)`。
 * 于是"不超过预算"等价于 `chars ≤ 预算 × 4`，渲染器直接在这个字符上限上做加法，
 * 每一行都是整行进或整行不进（**绝不截半行**）。被截断的文件补一行 `  …`；
 * 补标记本身也要过预算判断，塞不下就先退掉最后一行再加标记。
 *
 * 【被截掉的文件去哪了】`omittedFiles` / `truncated` 在返回值里（P10 的上下文面板与
 * 排障要看"地图是不是不全"）。**没有往文本里写"还有 N 个文件没显示"**：
 * 模型对"地图不全"这件事能不能正确利用是未知的，而这段话每轮都要花 token。
 * 需要告诉模型的只有"这次 Run 改过哪些文件"那一行（`withChangedFiles`），
 * 因为那是它自己刚做过的动作、地图与工作区就此分叉。
 *
 * 【改动标注为什么不占预算】它依赖本次 Run 的动作（`changedFiles`），而缓存键是
 * `(repo, commit, 任务词, 预算)`——把标注算进正文会让"同一份缓存"对应多份文本。
 * 代价是最终文本可能比预算多一点（一行 ≤ 20 个路径），由 P10 的分区预算兜底。
 *
 * 【降级渲染（`renderFileTree`）为什么单独一个函数】索引不可用时给不出排名，能给的是
 * "这个仓库有哪些目录、哪个目录文件多"。它与地图是两种东西（一个是"该看哪"，一个是
 * "有什么"），硬塞进同一个函数只会让两边都长出一堆 `if`。首行的那句说明是必需的：
 * 没有它，模型会把文件树当成"地图说这些文件里没有符号"。
 */

import { buildChangedFilesSection } from "@reuben-cloud/agent-runtime";

// ---------------------------------------------------------------- 类型

/** 地图里的一行签名（`repo_symbols` 的必要字段）。 */
export interface RepoMapSymbol {
  name: string;
  kind: string;
  signature: string;
  startLine: number;
}

/** 一个文件在地图里的那一块。`symbols` 由调用方按重要性排好（`rank.orderSymbols`）。 */
export interface RepoMapFileBlock {
  path: string;
  symbols: readonly RepoMapSymbol[];
}

export interface RenderRepoMapInput {
  blocks: readonly RepoMapFileBlock[];
  /** token 预算；缺省 1500，硬上限 3000（spec §3）。 */
  budgetTokens?: number;
  /** 每个文件最多几条签名（缺省 8）。 */
  symbolsPerFile?: number;
}

export interface RenderFileTreeInput {
  /** 扫描到的全部文件（`parse.ts` 的 `discoverFiles` 给的就是它）。 */
  files: readonly string[];
  budgetTokens?: number;
}

export interface RenderedRepoMap {
  text: string;
  /** `ceil(text.length / 4)`。 */
  tokens: number;
  /** 文本里出现的文件数。 */
  files: number;
  /** 因为预算没进文本的文件数。 */
  omittedFiles: number;
  /** 有东西被截断（文件被丢、或某个文件的签名被切）。 */
  truncated: boolean;
}

// ---------------------------------------------------------------- 常量

/** 每个文件最多渲染 8 条签名（spec §3）。 */
export const DEFAULT_SYMBOLS_PER_FILE = 8;

/** 缺省预算（spec §3：默认 1500）。P10 的环境变量 `REUBEN_CLOUD_REPO_MAP_TOKENS` 也用它。 */
export const DEFAULT_BUDGET_TOKENS = 1500;

/** 硬上限（spec §3）：地图挤掉对话历史是本末倒置，所以配置写大了也不会超过它。 */
export const MAX_BUDGET_TOKENS = 3000;

/** 改动标注最多列多少个文件（再多就只给个数——20 正好是"该重建地图"的那个阈值）。 */
export const CHANGED_FILES_LIMIT = 20;

/** 文件树的首行说明（降级时告诉模型这不是符号地图）。 */
export const FILE_TREE_HEADING = "# 仓库文件树（没有可用的符号索引：只有目录与文件名）";

/** 同一个文件里签名被截断时补的那一行。 */
const ELLIPSIS = "  …";

// ---------------------------------------------------------------- 地图

export function renderRepoMap(input: RenderRepoMapInput): RenderedRepoMap {
  const sink = new LineSink(clampBudgetTokens(input.budgetTokens));
  const perFile = input.symbolsPerFile ?? DEFAULT_SYMBOLS_PER_FILE;
  let files = 0;
  let omittedFiles = 0;
  let truncated = false;

  for (let index = 0; index < input.blocks.length; index += 1) {
    const block = input.blocks[index]!;
    const header = `${block.path}:`;
    // 块的**头一行**（路径）加它前面的空行都放不下，就没有必要再试后面的：后面的块只会更长。
    if (!sink.canFitNextBlock(header)) {
      omittedFiles = input.blocks.length - index;
      truncated = true;
      break;
    }
    sink.pushNextBlock(header);
    files += 1;

    const shown = block.symbols.slice(0, perFile);
    let cut = block.symbols.length > shown.length;
    for (const symbol of shown) {
      const line = `  ${symbol.signature === "" ? symbol.name : symbol.signature}`;
      if (!sink.canFit(line)) {
        cut = true;
        break;
      }
      sink.push(line);
    }
    if (cut) {
      sink.pushEllipsisIfPossible(ELLIPSIS);
      truncated = true;
    }
  }

  const text = sink.text();
  return { text, tokens: estimateTokens(text), files, omittedFiles, truncated };
}

/**
 * 末尾追加"本次 Run 已改动"那一行（spec §3）。
 *
 * 去重 + 排序是确定性的一部分：`changedFiles` 来自工具层的事件流，顺序不稳定，
 * 而这段文本会被写进 `model_requests` 并参与逐字节回放。
 *
 * 【这句话的措辞只有一处】用 agent-runtime 的 `buildChangedFilesSection`（P1 的 system 分区）
 * 而不是在这里再写一遍：同一件事（"你刚改过这些文件，地图可能过期"）在同一段上下文里出现两次，
 * 两个措辞就会让模型以为是两件事；P10 决定"只留一处"时也只需要删一个调用点。
 * 本函数比它多的只有两件：去重排序，以及超过 20 个文件时只列前 20 个（那是地图的预算约束，
 * system 分区没有）。方向是 CP → agent-runtime，与依赖规则一致。
 */
export function withChangedFiles(text: string, changedFiles: readonly string[] | undefined): string {
  if (changedFiles === undefined || changedFiles.length === 0) return text;
  const unique = [...new Set(changedFiles)].sort();
  const shown = unique.slice(0, CHANGED_FILES_LIMIT);
  const more = unique.length > shown.length ? ` 等 ${unique.length} 个文件` : "";
  const note = `${buildChangedFilesSection(shown) ?? ""}${more}`;
  return text === "" ? note : `${text}\n\n${note}`;
}

// ---------------------------------------------------------------- 文件树（降级）

/**
 * 索引不可用时的地图：目录 + 文件名，按目录大小（文件数）排序。
 *
 * 【为什么按目录大小】它要回答的问题与地图一样（"这个仓库由哪几块组成"），
 * 而文件多的目录通常就是主要的模块。反过来按路径字典序排，`src` 里最后一个目录之后的
 * 那些文件就永远进不了预算。
 */
export function renderFileTree(input: RenderFileTreeInput): RenderedRepoMap {
  const sink = new LineSink(clampBudgetTokens(input.budgetTokens));
  // 连说明行都放不下（预算是屈指可数的几个 token）就什么都不给：预算的语义是硬上限。
  if (!sink.canFit(FILE_TREE_HEADING)) {
    return { text: "", tokens: 0, files: 0, omittedFiles: input.files.length, truncated: input.files.length > 0 };
  }
  sink.push(FILE_TREE_HEADING);

  const byDirectory = new Map<string, string[]>();
  for (const file of input.files) {
    const cut = file.lastIndexOf("/");
    const directory = cut === -1 ? "" : file.slice(0, cut);
    const members = byDirectory.get(directory);
    if (members === undefined) byDirectory.set(directory, [file]);
    else members.push(file);
  }
  const directories = [...byDirectory.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );

  let files = 0;
  let omittedFiles = 0;
  let truncated = false;
  for (let index = 0; index < directories.length; index += 1) {
    const [directory, members] = directories[index]!;
    const sorted = [...members].sort();
    const header = `${directory === "" ? "." : directory}/ (${sorted.length})`;
    if (!sink.canFitNextBlock(header)) {
      omittedFiles = input.files.length - files;
      truncated = true;
      break;
    }
    sink.pushNextBlock(header);

    let cut = false;
    for (const file of sorted) {
      const name = file.slice(directory === "" ? 0 : directory.length + 1);
      if (!sink.canFit(`  ${name}`)) {
        cut = true;
        break;
      }
      sink.push(`  ${name}`);
      files += 1;
    }
    if (cut) {
      sink.pushEllipsisIfPossible(ELLIPSIS);
      truncated = true;
      omittedFiles = input.files.length - files;
      break;
    }
  }

  const text = sink.text();
  return { text, tokens: estimateTokens(text), files, omittedFiles, truncated };
}

// ---------------------------------------------------------------- 预算

/** token 估算的口径（与 `compaction/tokens.ts` 和 P2 的分区统计一致）。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 预算归一化：不给 / 非正 / 不是数 → 缺省 1500；超过 3000 → 截到 3000。
 *
 * 【为什么是截断而不是报错】预算来自配置（P10 的 `REUBEN_CLOUD_REPO_MAP_TOKENS`）。
 * 写大了是配置问题，不是这次 Run 该失败的理由；调用方觉得值得说就记一条 warn（`repo-map.ts` 做了）。
 */
export function clampBudgetTokens(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_BUDGET_TOKENS;
  return Math.min(Math.floor(value), MAX_BUDGET_TOKENS);
}

// ---------------------------------------------------------------- 行累加器

/**
 * 按行累加，每一行要么整行进要么整行不进（"不截半行"就是这么保证的）。
 *
 * 预算换算成字符上限（`tokens × 4`）之后加法是精确的：`ceil(chars / 4) ≤ tokens`
 * 等价于 `chars ≤ tokens × 4`（`chars` 全是整数）。行之间那个 `\n` 也算进 `chars`。
 */
class LineSink {
  readonly #charCap: number;
  #lines: string[] = [];
  #chars = 0;

  constructor(budgetTokens: number) {
    this.#charCap = budgetTokens * 4;
  }

  canFit(line: string): boolean {
    return this.#chars + this.#separatorCost() + line.length <= this.#charCap;
  }

  /**
   * 块之间要留一行空行（spec §3），而空行 + 头一行必须**一起**进：
   * 只进空行不进头一行会在末尾留一个空行（"末尾无残缺"那条同样管它）。
   */
  canFitNextBlock(line: string): boolean {
    return this.#chars + this.#gapCost() + this.#separatorCost() + line.length <= this.#charCap;
  }

  pushNextBlock(line: string): void {
    if (this.#gapCost() === 1) this.push("");
    this.push(line);
  }

  push(line: string): void {
    this.#chars += this.#separatorCost() + line.length;
    this.#lines.push(line);
  }

  /**
   * 想加省略标记就加；加不下就退掉刚加的最后一行再试（那一行是符号行，不是文件头——
   * 文件头进来之前已经 `canFit` 过，而标记比任何一行都短，所以退一行一定腾得出位置）。
   */
  pushEllipsisIfPossible(marker: string): void {
    if (!this.canFit(marker) && this.#lines.length > 0) {
      const removed = this.#lines.pop()!;
      this.#chars -= this.#separatorCost() + removed.length;
    }
    if (this.canFit(marker)) this.push(marker);
  }

  text(): string {
    return this.#lines.join("\n");
  }

  #separatorCost(): number {
    return this.#lines.length === 0 ? 0 : 1;
  }

  /** 块之间那个空行的代价（第一块之前没有）。 */
  #gapCost(): number {
    return this.#lines.length === 0 ? 0 : 1;
  }
}
