/**
 * P9 · 排名与个性化的单测（spec Phase 9 测试要点 1 / 3 / 4 的前半）。
 *
 * 【为什么把这些写成纯函数用例】PageRank 与个性化是"地图为什么长这样"的全部依据，而它们的
 * 正确性只依赖图与词——不需要 PG、不需要 tree-sitter、不需要文件系统。把它们埋在
 * `buildRepoMap` 的集成路径里测，等于每次调一下跳转概率都要起一次库。
 *
 * 【它不替代什么】`buildRepoMap` 的缓存 / 降级 / 标注在 `repo-map-build.test.ts`，
 * 排版与预算在 `repo-map-render.test.ts`。真 PG 上的 `repo_maps` 在集成测试里。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { dropVocabularyEdges, edgeKey, MAX_REFERENCING_FILES, orderSymbols, pageRank, rankedFiles, symbolRefCounts } from "../../src/index/rank.ts";
import { personalizationHash, personalizationOf, taskTerms } from "../../src/index/personalize.ts";

// ---------------------------------------------------------------- PageRank

test("PageRank：被依赖的文件排在引用它的文件前面（链 a→b→c）", () => {
  const { ranks } = pageRank({
    files: ["a.ts", "b.ts", "c.ts"],
    edges: [
      { fromPath: "a.ts", toPath: "b.ts", weight: 1 },
      { fromPath: "b.ts", toPath: "c.ts", weight: 1 },
    ],
  });
  assert.ok(ranks.get("c.ts")! > ranks.get("b.ts")!, "c 被 b 引用，应当比 b 高");
  assert.ok(ranks.get("b.ts")! > ranks.get("a.ts")!, "b 被 a 引用，应当比 a 高");
  assert.equal(rankedFiles(ranks)[0]!.path, "c.ts");
});

test("PageRank：排名之和恒为 1（悬挂节点的权重按个性化向量再分配）", () => {
  const { ranks } = pageRank({
    files: ["a.ts", "b.ts", "c.ts"],
    edges: [{ fromPath: "a.ts", toPath: "b.ts", weight: 1 }],
  });
  const sum = [...ranks.values()].reduce((total, rank) => total + rank, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `排名之和是 ${sum}，应当为 1`);
});

test("PageRank：个性化向量把命中的文件顶上去，其他文件相应下沉", () => {
  const files = ["src/core/store.ts", "src/billing/refund.ts", "src/api/routes.ts"];
  const edges = [
    { fromPath: "src/api/routes.ts", toPath: "src/core/store.ts", weight: 2 },
    { fromPath: "src/billing/refund.ts", toPath: "src/core/store.ts", weight: 1 },
  ];
  const uniform = pageRank({ files, edges });
  const personalized = pageRank({ files, edges, personalization: new Map([["src/billing/refund.ts", 1]]) });

  assert.equal(rankedFiles(uniform.ranks)[0]!.path, "src/core/store.ts", "没有个性化时，仓库的心脏排第一");
  assert.equal(rankedFiles(personalized.ranks)[0]!.path, "src/billing/refund.ts", "个性化之后命中项排第一");
});

test("PageRank：全零 / 空 / 未归一化的向量都退化成均匀分布", () => {
  const files = ["a.ts", "b.ts"];
  const edges = [{ fromPath: "a.ts", toPath: "b.ts", weight: 1 }];
  const uniform = pageRank({ files, edges });
  for (const personalization of [null, new Map<string, number>(), new Map([["a.ts", 0]]), new Map([["a.ts", 2], ["b.ts", 2]])]) {
    const result = pageRank({ files, edges, personalization });
    assert.deepEqual([...result.ranks.entries()], [...uniform.ranks.entries()]);
  }
});

test("PageRank：输入顺序不影响结果（文件和边都打乱之后逐位相同）", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts"];
  const edges = [
    { fromPath: "a.ts", toPath: "b.ts", weight: 1 },
    { fromPath: "a.ts", toPath: "c.ts", weight: 0.5 },
    { fromPath: "b.ts", toPath: "d.ts", weight: 2 },
    { fromPath: "c.ts", toPath: "b.ts", weight: 1 },
  ];
  const forward = pageRank({ files, edges });
  const backward = pageRank({ files: [...files].reverse(), edges: [...edges].reverse() });
  assert.deepEqual([...backward.ranks.entries()], [...forward.ranks.entries()]);
});

test("PageRank：指向节点集之外的边被丢掉，排名之和仍然是 1", () => {
  const { ranks } = pageRank({
    files: ["a.ts", "b.ts"],
    edges: [
      { fromPath: "a.ts", toPath: "b.ts", weight: 1 },
      { fromPath: "b.ts", toPath: "ghost.ts", weight: 3 },
    ],
  });
  assert.equal(ranks.has("ghost.ts"), false);
  const sum = [...ranks.values()].reduce((total, rank) => total + rank, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `排名之和是 ${sum}，应当为 1`);
});

test("PageRank：空图不崩；退化输入（自环 / 0 权重）也被算进去", () => {
  assert.deepEqual([...pageRank({ files: [], edges: [] }).ranks.keys()], []);
  const { ranks } = pageRank({
    files: ["a.ts", "b.ts"],
    edges: [
      { fromPath: "a.ts", toPath: "a.ts", weight: 1 },
      { fromPath: "b.ts", toPath: "a.ts", weight: 0 },
    ],
  });
  assert.equal(ranks.size, 2);
  assert.equal(Number.isFinite(ranks.get("a.ts")!), true);
});

// ---------------------------------------------------------------- 符号重要性

test("符号重要性：被引用多的排前面，其次按 start_line 升序", () => {
  const symbols = [
    { name: "laterButHot", startLine: 50 },
    { name: "earlyAndCold", startLine: 1 },
  ];
  const counts = symbolRefCounts([
    { fromPath: "x.ts", toPath: "target.ts", weight: 1, symbol: "laterButHot" },
    { fromPath: "y.ts", toPath: "target.ts", weight: 1, symbol: "laterButHot" },
    { fromPath: "z.ts", toPath: "target.ts", weight: 1, symbol: "earlyAndCold" },
    { fromPath: "z.ts", toPath: "other.ts", weight: 1, symbol: "laterButHot" },
    { fromPath: "z.ts", toPath: "target.ts", weight: 2, symbol: "./import" },
  ]);
  assert.deepEqual(
    orderSymbols("target.ts", symbols, counts).map((symbol) => symbol.name),
    ["laterButHot", "earlyAndCold"],
  );

  // 都没被引用（或次数相同）时按行号；同一行再按名字。三级键都要能决定顺序，否则"确定性"靠运气。
  const sameCounts = symbolRefCounts([]);
  const tied = [
    { name: "b", startLine: 7 },
    { name: "a", startLine: 7 },
    { name: "c", startLine: 3 },
  ];
  assert.deepEqual(
    orderSymbols("f.ts", tied, sameCounts).map((symbol) => `${symbol.startLine}:${symbol.name}`),
    ["3:c", "7:a", "7:b"],
  );
});

test("符号重要性：import 边的 symbol 是路径，撞不上任何符号名（所以不参与排序）", () => {
  const counts = symbolRefCounts([
    { fromPath: "a.ts", toPath: "b.ts", weight: 2, symbol: "./b" },
    { fromPath: "a.ts", toPath: "b.ts", weight: 1, symbol: "Ledger" },
  ]);
  const symbols = [
    { name: "Ledger", startLine: 1 },
    { name: "Store", startLine: 2 },
  ];
  assert.deepEqual(orderSymbols("b.ts", symbols, counts).map((symbol) => symbol.name), ["Ledger", "Store"]);
  // import 路径仍然在计数表里（它就是一个字符串），只是它不可能与某个符号名相等。
  assert.deepEqual([...counts.get("b.ts")!.entries()].sort(), [["./b", 1], ["Ledger", 1]]);
});

// ---------------------------------------------------------------- 词汇名闸

test("词汇名闸：超过 20 个文件引用的名字，它的标识符边一条不产生；import 边与 unique 名字不动", () => {
  const many = MAX_REFERENCING_FILES + 1;
  const edges = [
    // 21 个文件都提到 `path` → 这个名字是词汇表，它的标识符边全丢。
    ...Array.from({ length: many }, (_, index) => ({ fromPath: `f${index}.ts`, toPath: "hub.ts", weight: 1, symbol: "path" })),
    // 20 个文件提到 `Ledger` → 刚好在阈内，一条不少。
    ...Array.from({ length: MAX_REFERENCING_FILES }, (_, index) => ({ fromPath: `g${index}.ts`, toPath: "ledger.ts", weight: 1, symbol: "Ledger" })),
    // 同一个名字如果是 import 字符串（裸模块名也要认），照旧保留。
    ...Array.from({ length: many }, (_, index) => ({ fromPath: `h${index}.ts`, toPath: "store.ts", weight: 2, symbol: "store" })),
    { fromPath: "a.ts", toPath: "core.ts", weight: 1, symbol: "unique" },
    { fromPath: "a.ts", toPath: "core.ts", weight: 1, symbol: undefined },
  ];
  const importKeys = new Set(Array.from({ length: many }, (_, index) => edgeKey(`h${index}.ts`, "store")));
  const kept = dropVocabularyEdges(edges, importKeys);

  assert.equal(kept.some((edge) => edge.symbol === "path"), false, "21 个文件的名字被丢掉");
  assert.equal(kept.filter((edge) => edge.symbol === "Ledger").length, MAX_REFERENCING_FILES, "正好 20 个文件不算词汇名");
  assert.equal(kept.filter((edge) => edge.symbol === "store").length, many, "import 边不参与闸");
  assert.equal(kept.some((edge) => edge.symbol === "unique"), true);
  assert.equal(kept.some((edge) => edge.symbol === undefined), true, "没有 symbol 的边原样穿过");
  assert.equal(edges.filter((edge) => edge.symbol === "path").length, many, "纯函数：原数组不动");
  assert.deepEqual(dropVocabularyEdges(edges, importKeys), kept, "同一个输入两次结果相同");
});

test("词汇名闸：把 A-55 的场景算一遍——30 条通用名的边压不过 3 条 import 边", () => {
  const nodes = ["hub.ts", "core.ts", ...Array.from({ length: 30 }, (_, index) => `f${index}.ts`)];
  const edges = [
    ...Array.from({ length: 30 }, (_, index) => ({ fromPath: `f${index}.ts`, toPath: "hub.ts", weight: 1, symbol: "path" })),
    ...Array.from({ length: 3 }, (_, index) => ({ fromPath: `f${index}.ts`, toPath: "core.ts", weight: 2, symbol: "./core" })),
  ];
  const importKeys = new Set(Array.from({ length: 3 }, (_, index) => edgeKey(`f${index}.ts`, "./core")));
  const before = pageRank({ files: nodes, edges });
  const after = pageRank({ files: nodes, edges: dropVocabularyEdges(edges, importKeys) });
  assert.equal(rankedFiles(before.ranks)[0]!.path, "hub.ts", "不设闸时 30 条边把 hub 顶上去");
  assert.equal(rankedFiles(after.ranks)[0]!.path, "core.ts", "设闸后 import 边（作者写下的依赖）胜出");
});

test("词汇名闸：丢边之后剩下的边照常分走质量（退化输入不崩）", () => {
  const edges = [
    ...Array.from({ length: MAX_REFERENCING_FILES + 1 }, (_, index) => ({
      fromPath: `f${index}.ts`,
      toPath: "a.ts",
      weight: 1,
      symbol: "path",
    })),
    // `f0.ts` 除了那条被丢的边，还有一条自己的 import 边。
    { fromPath: "f0.ts", toPath: "b.ts", weight: 2, symbol: "./b" },
  ];
  const kept = dropVocabularyEdges(edges, new Set([edgeKey("f0.ts", "./b")]));
  assert.deepEqual(kept.map((edge) => edge.toPath), ["b.ts"]);

  const { ranks } = pageRank({ files: ["a.ts", "b.ts", "f0.ts"], edges: kept });
  assert.ok(ranks.get("b.ts")! > ranks.get("a.ts")!, "b.ts 还拿得到 f0 的质量，a.ts 只剩下跳转项");
  const sum = [...ranks.values()].reduce((total, rank) => total + rank, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `排名之和是 ${sum}`);
});

// ---------------------------------------------------------------- 任务词与个性化

test("任务词：驼峰 / 下划线 / 数字边界都切，停用词与语言关键字去掉", () => {
  const terms = taskTerms("请修复 refundInvoice 与 billing_v2 的 HTTPClient，function 不要动");
  for (const expected of ["refund", "invoice", "billing", "v2", "http", "client"]) {
    assert.ok(terms.includes(expected), `词表里应当有 ${expected}：${terms.join(",")}`);
  }
  // 语言关键字与虚词不进词表；中文词照旧进（它不是停用词，只是匹配不上英文符号而已）。
  assert.equal(terms.includes("function"), false);
  assert.equal(terms.includes("the"), false);
  assert.ok(terms.includes("不要动"), `中文词应当保留：${terms.join(",")}`);
  assert.deepEqual(taskTerms("the a an and of"), [], "全是停用词时词表为空");
});

test("任务词：同样的词无论文本顺序，哈希相同；不同的词哈希不同", () => {
  const first = personalizationHash(taskTerms("refund invoice"));
  assert.equal(first, personalizationHash(taskTerms("invoice refund, refund!")));
  assert.notEqual(first, personalizationHash(taskTerms("refund credit")));
});

test("个性化：符号名命中（驼峰拆开写也命中），命中文件是它自己", () => {
  const personalization = personalizationOf({
    task: "修一下 refundInvoice 抛的错",
    symbols: [
      { path: "src/billing/refund.ts", name: "refundInvoice" },
      { path: "src/api/routes.ts", name: "createRouter" },
    ],
    files: ["src/billing/refund.ts", "src/api/routes.ts"],
  });
  assert.deepEqual(personalization.matchedSymbols, ["refundInvoice"]);
  assert.deepEqual([...personalization.weights!.keys()], ["src/billing/refund.ts"]);
  assert.equal(personalization.weights!.get("src/billing/refund.ts"), 1);
});

test("个性化：目录名命中把同目录文件一起抬高；无关文件保持 0", () => {
  const files = ["src/billing/refund.ts", "src/billing/ledger.ts", "src/api/routes.ts"];
  const personalization = personalizationOf({ task: "billing 这块要重写", symbols: [], files });
  assert.equal(personalization.weights!.get("src/billing/refund.ts"), 0.5);
  assert.equal(personalization.weights!.get("src/billing/ledger.ts"), 0.5);
  assert.equal(personalization.weights!.has("src/api/routes.ts"), false);
});

test("个性化：文件名命中抬自己与同目录；符号命中权重更高（1.0 > 0.5）", () => {
  const files = ["src/billing/refund.ts", "src/billing/ledger.ts"];
  const byName = personalizationOf({ task: "refund.ts 有问题", symbols: [], files });
  assert.equal(byName.weights!.get("src/billing/refund.ts"), 0.5, "自己一份");
  assert.equal(byName.weights!.get("src/billing/ledger.ts"), 0.5, "同目录一份");

  const bySymbol = personalizationOf({
    task: "refund 有问题",
    symbols: [{ path: "src/billing/refund.ts", name: "refund" }],
    files,
  });
  const weights = bySymbol.weights!;
  // 归一化之前：refund.ts = 1（符号）+ 0.5（文件名）= 1.5，ledger.ts = 0.5（同目录）。
  assert.equal(weights.get("src/billing/refund.ts"), 0.75);
  assert.equal(weights.get("src/billing/ledger.ts"), 0.25);
});

test("个性化：一个词都没命中 → 返回 null（调用方退化成均匀分布）", () => {
  const personalization = personalizationOf({
    task: "there is a bug somewhere",
    symbols: [{ path: "src/a.ts", name: "createRouter" }],
    files: ["src/a.ts"],
  });
  assert.equal(personalization.weights, null);
  assert.deepEqual(personalization.matchedSymbols, []);
});

test("个性化：非 ASCII 标识符与文件名也能命中（中文 / 全角路径）", () => {
  const personalization = personalizationOf({
    task: "退款 逻辑 有问题",
    symbols: [{ path: "src/退款/流程.ts", name: "退款" }],
    files: ["src/退款/流程.ts", "src/other.ts"],
  });
  assert.deepEqual(personalization.matchedSymbols, ["退款"]);
  assert.ok(personalization.weights!.has("src/退款/流程.ts"));
});

test("个性化：归一化之后权重之和为 1，且键按路径排序（确定性）", () => {
  const personalization = personalizationOf({
    task: "billing 和 api 都要动",
    symbols: [],
    files: ["src/api/routes.ts", "src/billing/refund.ts", "src/billing/ledger.ts"],
  });
  const entries = [...personalization.weights!.entries()];
  assert.deepEqual(entries.map(([path]) => path), [...entries.map(([path]) => path)].sort());
  const sum = entries.reduce((total, [, weight]) => total + weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
});
