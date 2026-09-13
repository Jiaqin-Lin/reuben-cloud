/**
 * P9 · 文件级 PageRank 与符号重要性（spec Phase 9 §1/§3）。
 *
 * 【为什么是文件级，不是符号级】边来自 P8 的 `repo_refs`（`A → B` 一条），它本身就是文件到文件的；
 * 要把它拆到符号级就得给"这条引用到底指哪个同名定义"一个答案——而 P8 明确不做类型解析
 * （设计文档 §D.1：文件级边足够 Repo Map 用）。文件级还有一个好处：排名稳定，多一个私有符号
 * 不会让整张图抖一下。
 *
 * 【PageRank 的三个口径（都写在这里，免得地图的排名取决于某个默认值在哪被改过）】
 *  · damping = 0.85：Aider / 经典值。它决定"随机跳转"与"沿边游走"的比例；
 *  · 迭代到 L1 变化 < 1e-7 或 100 轮：5k 文件的图上收敛大致落在 60–100 轮之间（0.85^k 的收缩），
 *    两个出口都会到；
 *  · 悬挂节点（没有出边的文件，例如叶子模块）的权重按**个性化向量**再分配，这是标准做法：
 *    否则改成"按当前权重均摊"会让没有出边的目录吸走一大块排名。
 *
 * 【边权重进来之前先过一道 `dropVocabularyEdges`】这不是 PageRank 的一部分（那是个纯函数，
 * 边是它的输入），但没有它地图会被词汇名占位——实测依据与口径见那个函数的注释。
 *
 * 【确定性】浮点求和的顺序会影响最后几位，所以这里四处都按排序固定的顺序做：节点按路径排序、
 * 边按 (from, to) 排序、每轮的累加按下标升序。同样的输入必须给出逐字节相同的排名与文本
 * （设计文档 §D.3 第 3 条），否则提示词缓存前缀每轮都失效。
 *
 * 【为什么 `symbolRefCounts` 把 `repo_refs.symbol` 直接当符号名用】对标识符边它存的就是候选名，
 * 对 import 边存的是原始 import 字符串（`./ledger.ts`、`app.models`）——后者不可能等于一个符号名
 * （符号名是标识符，没有斜杠与点），所以不需要额外判 kind（`repo_refs` 里也没有这一列）。
 * 代价是一个名字叫 `./ledger` 的符号能蹭到 import 边的计数——这种名字不会存在。
 */

// ---------------------------------------------------------------- 常量

/** 沿边游走的概率（spec §1：damping = 0.85）。 */
export const DEFAULT_DAMPING = 0.85;

/** 收敛判据：整张图的 L1 变化（spec §1：|Δ| < 1e-7）。 */
export const DEFAULT_EPSILON = 1e-7;

/** 迭代上限（spec §1：100 次）。到了就停——结果照常可用，只是没到那么细的收敛。 */
export const DEFAULT_MAX_ITERATIONS = 100;

// ---------------------------------------------------------------- 图

/** PageRank 与符号重要性需要的边。`RefEdge`（P8）与 `repo_refs` 的行都能映射成它。 */
export interface RankEdge {
  fromPath: string;
  toPath: string;
  weight: number;
  /** 这条边由哪个名字引起（标识符边才有；符号重要性与词汇名衰减用它）。 */
  symbol?: string;
}

/** 判断一条边是不是 import 边要用的键（对应 `repo_file_refs` 的 `(path, symbol)`）。 */
export function edgeKey(path: string, symbol: string): string {
  return `${path}\u0000${symbol}`;
}

/**
 * 词汇名闸：一个候选名字被**超过这么多**不同文件引用时，它的标识符边一条都不产生（A-55 的杠杆）。
 *
 * 阈值取 20 是 A-55 里写下的数："20 个不同文件都提到同一个名字"已经从信号变成了词汇表
 * （`path` / `result` / `text` / `row` / `readFile` 在本仓库里分别是 74 / 80 / 47 / 36 / 36 个文件）。
 */
export const MAX_REFERENCING_FILES = 20;

/**
 * 把"被太多文件引用的名字"的**标识符边**丢掉（P8 附录 A-55 留的 P9 杠杆）。
 *
 * 【为什么必须有这一步（实测，不是理论）】名字匹配法没法知道 `path.join(...)` 里的 `path`
 * 指的是 Node 内置模块还是仓库里某个恰好叫 `path` 的常量。在本仓库自身上量过：`path` 出现在
 * 74 个文件里，而全仓库只有一个文件定义了叫 `path` 的常量（一个 P8 的 fixture），于是那 74 条边
 * 把 fixture 推到了地图第 3 名（一共 12 个名额）。加闸后本仓库丢掉 1104/4785 条边，
 * 前 12 名从"混着一个 fixture"变成全是真源码模块，而 issue 相关的文件（render.ts / indexer.ts /
 * parse.ts）一个没掉。
 *
 * 【为什么是闸而不是"按 1/df 连续衰减"】第一版写的就是 1/df（听起来更公平），它在实测里是错的：
 * PageRank 按**每个文件的出边权重之和**归一化，于是一个文件的所有出边被等比例缩小之后，
 * 归一化把衰减完全抵消（单测里造了一个"30 条通用名边 vs 3 条 import 边"的例子，衰减后排名不变）。
 * 要让连续衰减真的生效，得在 PageRank 里多加一个"被衰减的质量退回跳转池"的概念——比一道
 * 门槛贵得多，而两者的效果一样：真正要丢掉的是那类名字的边本身。
 *
 * 【谁不动：import 边】`import … from "./types"` 是作者写下的依赖，被 32 个文件 import 恰恰说明
 * 那个模块是中心。判断靠 `repo_file_refs` 的 kind（`importKeys`），不靠"字符串里有没有斜杠"猜：
 * Python / Go 的裸模块名（`import store`）没有斜杠但同样是 import 边。
 */
export function dropVocabularyEdges(edges: readonly RankEdge[], importKeys: ReadonlySet<string>): RankEdge[] {
  const filesPerName = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.symbol === undefined || edge.symbol === "" || importKeys.has(edgeKey(edge.fromPath, edge.symbol))) continue;
    const files = filesPerName.get(edge.symbol);
    if (files === undefined) filesPerName.set(edge.symbol, new Set([edge.fromPath]));
    else files.add(edge.fromPath);
  }
  const vocabulary = new Set<string>();
  for (const [name, files] of filesPerName) if (files.size > MAX_REFERENCING_FILES) vocabulary.add(name);
  if (vocabulary.size === 0) return [...edges];
  return edges.filter(
    (edge) =>
      edge.symbol === undefined ||
      edge.symbol === "" ||
      !vocabulary.has(edge.symbol) ||
      importKeys.has(edgeKey(edge.fromPath, edge.symbol)),
  );
}

export function fromRefEdge(edge: { fromPath: string; toPath: string; symbol: string; weight: number }): RankEdge {
  return { fromPath: edge.fromPath, toPath: edge.toPath, weight: edge.weight, symbol: edge.symbol };
}

export interface PageRankOptions {
  /** 图里的节点（文件路径）。去重后按字典序排——顺序是确定性的一部分。 */
  files: readonly string[];
  edges: readonly RankEdge[];
  /**
   * 个性化向量：`path → 权重`。不必先归一化（这里会按节点集归一），
   * `null` / 空 / 全零都退化成均匀分布（此时它回答的是"这个仓库的心脏在哪"）。
   */
  personalization?: ReadonlyMap<string, number> | null;
  damping?: number;
  epsilon?: number;
  maxIterations?: number;
}

export interface PageRankResult {
  /** 按路径字典序插入的 Map（遍历顺序稳定）。 */
  ranks: Map<string, number>;
  iterations: number;
  converged: boolean;
}

/**
 * 个性化 PageRank（幂法）。纯函数：同样的输入 → 同样的输出，没有 IO / 时间 / 随机。
 *
 * 【边指向节点集之外的路径怎么办】丢掉那条边。P8 的边理论上只会指向索引里的文件
 * （import 解析器只认文件集），但增量重建与"删掉的文件"之间有过边界情况；丢掉 + 把
 * `from` 当悬挂处理，能保证排名之和恒为 1（一个会漂的总量会让"取 top-N"的边界随迭代次数变）。
 */
export function pageRank(options: PageRankOptions): PageRankResult {
  const files = [...new Set(options.files)].sort();
  const n = files.length;
  if (n === 0) return { ranks: new Map(), iterations: 0, converged: true };

  const damping = options.damping ?? DEFAULT_DAMPING;
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const nodeIndex = new Map<string, number>();
  for (let i = 0; i < n; i += 1) nodeIndex.set(files[i]!, i);

  // 邻接表：先按 (from, to) 排序，保证同一组边无论调用方怎么排都得到同一份累加顺序。
  const sortedEdges = [...options.edges]
    .map((edge) => ({ from: nodeIndex.get(edge.fromPath), to: nodeIndex.get(edge.toPath), weight: edge.weight }))
    .filter((edge): edge is { from: number; to: number; weight: number } => edge.from !== undefined && edge.to !== undefined)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  const out: { to: number; weight: number }[][] = Array.from({ length: n }, () => []);
  const outWeightSum = new Float64Array(n);
  for (const edge of sortedEdges) {
    const weight = Number.isFinite(edge.weight) && edge.weight > 0 ? edge.weight : 0;
    if (weight === 0) continue;
    out[edge.from]!.push({ to: edge.to, weight });
    outWeightSum[edge.from] += weight;
  }

  // 个性化向量（归一化；全零 → 均匀）。
  const personal = new Float64Array(n);
  if (options.personalization !== null && options.personalization !== undefined) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const weight = Math.max(0, options.personalization.get(files[i]!) ?? 0);
      personal[i] = weight;
      sum += weight;
    }
    if (sum > 0) for (let i = 0; i < n; i += 1) personal[i] = personal[i]! / sum;
    else personal.fill(1 / n);
  } else {
    personal.fill(1 / n);
  }

  let ranks = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  let converged = false;
  let iterations = 0;
  const base = 1 - damping;

  for (let round = 1; round <= maxIterations; round += 1) {
    iterations = round;
    let dangling = 0;
    for (let i = 0; i < n; i += 1) if (outWeightSum[i] === 0) dangling += ranks[i]!;

    for (let i = 0; i < n; i += 1) next[i] = (base + damping * dangling) * personal[i]!;
    for (let from = 0; from < n; from += 1) {
      const total = outWeightSum[from]!;
      if (total === 0) continue;
      const share = (damping * ranks[from]!) / total;
      for (const edge of out[from]!) next[edge.to] += share * edge.weight;
    }

    let delta = 0;
    for (let i = 0; i < n; i += 1) delta += Math.abs(next[i]! - ranks[i]!);
    const swap = ranks;
    ranks = next;
    next = swap;
    if (delta < epsilon) {
      converged = true;
      break;
    }
  }

  const result = new Map<string, number>();
  for (let i = 0; i < n; i += 1) result.set(files[i]!, ranks[i]!);
  return { ranks: result, iterations, converged };
}

export interface RankedFile {
  path: string;
  rank: number;
}

/**
 * 排名 → 渲染顺序：rank 降序、同 rank 按 path 升序（spec §3）。
 *
 * 同 rank 几乎只出现在"这一版符号表里只有它一个文件"这类退化情形里，但顺序仍然写死：
 * 地图是进缓存前缀的文本，任何不稳定的排序都会让两轮之间字节不同。
 */
export function rankedFiles(ranks: ReadonlyMap<string, number>): RankedFile[] {
  return [...ranks.entries()]
    .map(([path, rank]) => ({ path, rank }))
    .sort((a, b) => b.rank - a.rank || comparePaths(a.path, b.path));
}

// ---------------------------------------------------------------- 符号重要性

/** 符号重要性排序只需要这两项（`RepoMapSymbol` 与它结构兼容）。 */
export interface RankedSymbol {
  name: string;
  startLine: number;
}

/**
 * `path → (符号名 → 被引用次数)`：数的是"有多少条边以这个名字指向这个文件"。
 *
 * 【为什么不乘 weight】排行榜要回答的是"这个符号在这个文件里有多重要"，不是"那条引用有多确定"；
 * 歧义衰减（1/n）已经在边上做过了，这里再乘一次会让"到处都是同名"的名字沉下去——
 * 那件事由 P8 的 `n > 5 丢弃` 负责。
 */
export function symbolRefCounts(edges: readonly RankEdge[]): Map<string, ReadonlyMap<string, number>> {
  const byPath = new Map<string, Map<string, number>>();
  for (const edge of edges) {
    if (edge.symbol === undefined || edge.symbol === "") continue;
    let counts = byPath.get(edge.toPath);
    if (counts === undefined) {
      counts = new Map();
      byPath.set(edge.toPath, counts);
    }
    counts.set(edge.symbol, (counts.get(edge.symbol) ?? 0) + 1);
  }
  return byPath;
}

/**
 * 一个文件里的符号按重要性排序：被引用次数降序 → start_line 升序 → name 升序（spec §3）。
 *
 * 第三个键是为了"同一行上声明了两个符号"（`type A = …; type B = …` 这种）。
 * 渲染时取前 K 个，所以这里是最后一道决定"地图里出现哪些签名"的关口。
 */
export function orderSymbols<T extends RankedSymbol>(
  path: string,
  symbols: readonly T[],
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
): T[] {
  const perName = counts.get(path);
  return [...symbols].sort(
    (a, b) =>
      (perName?.get(b.name) ?? 0) - (perName?.get(a.name) ?? 0) ||
      a.startLine - b.startLine ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** 字典序比较（不依赖 `localeCompare`：那个的结果取决于运行环境的 locale）。 */
export function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
