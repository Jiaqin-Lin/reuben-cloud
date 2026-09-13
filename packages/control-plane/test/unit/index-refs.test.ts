/**
 * P8 · 引用边与 import 路径解析（spec 测试要点 3、4）。
 *
 * 【它拦住的是哪一类回归】
 *  ① **权重规则**：唯一同名 1.0、三处同名各 1/3、超过五处直接丢边——它们是 PageRank 的输入，
 *     错一条就会让不相关的文件排到地图前面；
 *  ② **import 解析**：相对路径（补扩展名 / index / TS 的 `.js` 写法）与非相对路径（Python 的
 *     模块名、Go 的包目录、Rust 的 `crate::`）各有一套规则，而它们的共同底线是
 *     "**只在唯一命中时产生边**"——歧义时丢边是设计，不是 bug；
 *  ③ 真 fixture 仓库上的一次端到端：`python-poetry` 里 `from app import greet` 必须
 *     既产生 import 边（w=2）又产生标识符边（w=1），指向 `src/app/__init__.py`。
 *
 * 【它不替代什么】真仓库的 import 形态（路径别名、monorepo 的 workspace 包、生成代码）
 * 不在这里——那些"解析不出来"是预期行为（丢边），由设计文档 §D.3 的"宁可少边"兜住。
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { discoverFiles } from "../../src/index/parse.ts";
import { computeEdges, createImportResolver, edgesFor, createEdgeContext, extractRefs } from "../../src/index/refs.ts";
import { extractSymbols, openParserPool } from "../../src/index/symbols.ts";
import type { ParserPool } from "../../src/index/symbols.ts";

const VENDOR = fileURLToPath(new URL("../../../../vendor/tree-sitter/", import.meta.url));
const INDEX_FIXTURES = fileURLToPath(new URL("../fixtures/index/", import.meta.url));
const REPO_FIXTURES = fileURLToPath(new URL("../fixtures/repos/", import.meta.url));

let pool: ParserPool;

before(async () => {
  pool = await openParserPool(VENDOR);
});

after(() => {
  pool.close();
});

/** 一个文件 + 它的符号，喂给 `computeEdges`。 */
function file(path: string, symbols: string[]) {
  return { path, symbols: symbols.map((name) => ({ name, kind: "function" as const, signature: name, startLine: 1, endLine: 1 })) };
}

describe("边计算（测试要点 3、4）", () => {
  test("3. 唯一同名定义 → weight=1；import 边 → weight=2", () => {
    const edges = computeEdges({
      files: ["src/a.ts", "src/b.ts"],
      symbols: [file("src/a.ts", ["foo"])],
      candidates: [
        { path: "src/b.ts", refs: { identifiers: ["foo"], imports: ["../src/a.ts"] } },
      ],
    });
    assert.deepEqual(
      edges.map((edge) => [edge.fromPath, edge.toPath, edge.symbol, edge.weight]),
      [
        ["src/b.ts", "src/a.ts", "../src/a.ts", 2],
        ["src/b.ts", "src/a.ts", "foo", 1],
      ],
    );
  });

  test("4. 同名定义在三处 → 三条边各 1/3；八处 → 一条边都没有", () => {
    const three = computeEdges({
      files: ["a.ts", "b.ts", "c.ts", "user.ts"],
      symbols: [file("a.ts", ["dup"]), file("b.ts", ["dup"]), file("c.ts", ["dup"])],
      candidates: [{ path: "user.ts", refs: { identifiers: ["dup"], imports: [] } }],
    });
    assert.equal(three.length, 3);
    for (const edge of three) assert.ok(Math.abs(edge.weight - 1 / 3) < 1e-9);

    const many = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts"];
    const eight = computeEdges({
      files: [...many, "user.ts"],
      symbols: many.map((path) => file(path, ["dup"])),
      candidates: [{ path: "user.ts", refs: { identifiers: ["dup"], imports: [] } }],
    });
    assert.deepEqual(eight, []);
  });

  test("4. 边不指向自己（文件里调用自己定义的东西不是依赖）", () => {
    const edges = computeEdges({
      files: ["a.ts"],
      symbols: [file("a.ts", ["foo"])],
      candidates: [{ path: "a.ts", refs: { identifiers: ["foo"], imports: ["a.ts"] } }],
    });
    assert.deepEqual(edges, []);
  });

  test("3. 同一个 (from,to,symbol) 只留一条，import 的权重压过同名推测", () => {
    const edges = computeEdges({
      files: ["src/a.ts", "src/b.ts"],
      symbols: [file("src/a.ts", ["./a"])],
      candidates: [{ path: "src/b.ts", refs: { identifiers: ["./a"], imports: ["./a"] } }],
    });
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.weight, 2);
  });

  test("确定性：候选顺序不影响输出顺序", () => {
    const input = {
      files: ["a.ts", "b.ts", "c.ts"],
      symbols: [file("b.ts", ["beta"]), file("c.ts", ["gamma"])],
    };
    const first = edgesFor(
      [
        { path: "a.ts", refs: { identifiers: ["gamma", "beta"], imports: [] } },
      ],
      createEdgeContext(input),
    );
    const second = edgesFor(
      [
        { path: "a.ts", refs: { identifiers: ["beta", "gamma"], imports: [] } },
      ],
      createEdgeContext(input),
    );
    assert.deepEqual(first, second);
    assert.deepEqual(first.map((edge) => edge.symbol), ["beta", "gamma"]);
  });
});

describe("候选提取的收窄", () => {
  /** 解析一段源码，返回候选（真实 wasm，不 mock）。 */
  async function candidatesOf(lang: "typescript" | "tsx" | "python" | "java" | "ruby" | "php", source: string) {
    const tree = await pool.parse(lang, source);
    try {
      return extractRefs(tree, lang);
    } finally {
      tree.delete();
    }
  }

  test("只收裸调用目标与成员链的根：`res.text()` 不收 `text`，`console.log()` 不收 `log`", async () => {
    const refs = await candidatesOf(
      "typescript",
      'import { readFile } from "./io";\n\nfunction run(res: Response, store: Store): void {\n  res.text();\n  console.log("x");\n  store.get("k");\n  readFile("a");\n}\n',
    );
    assert.deepEqual(refs.identifiers, ["console", "readFile", "res", "store"]);
    assert.deepEqual(refs.imports, ["./io"]);
  });

  test("框架注入的全局名不算调用目标（describe / test / assert / before / after）", async () => {
    const refs = await candidatesOf(
      "typescript",
      'describe("x", () => {\n  assert.equal(1, 1);\n});\nbefore(() => undefined);\nafter(test);\n',
    );
    assert.deepEqual(refs.identifiers, []);
  });

  test("Java / Ruby / PHP 的`有接收者就不算调用目标`：只留接收者的根", async () => {
    assert.deepEqual((await candidatesOf("java", "class A {\n  void run(Extra extra) {\n    extra.size();\n    helper();\n  }\n}\n")).identifiers, ["extra", "helper"]);
    assert.deepEqual((await candidatesOf("ruby", "obj.build(1)\nload_session(2)\n")).identifiers, ["load_session", "obj"]);
    assert.deepEqual((await candidatesOf("php", "<?php\n$store->read('k');\nopen('x');\n")).identifiers, ["open"]);
  });

  test("JSX 只收组件（首字母大写），不收 `div` / `h1` 这类内置元素", async () => {
    // 必须用 tsx 语法解析：在 TypeScript 里 `<div>…` 是类型断言，根本不是 JSX。
    const refs = await candidatesOf("tsx", "export const App = () => <div><Panel /></div>;\n");
    assert.deepEqual(refs.identifiers, ["Panel"]);
  });
});

describe("import 路径解析", () => {
  const files = [
    "src/index.ts",
    "src/util.ts",
    "src/esm-style.ts",
    "src/lib/index.ts",
    "src/app/__init__.py",
    "lib/app/__init__.py",
    "internal/foo/foo.go",
    "src/ports.rs",
    "src/ports/mod.rs",
    "com/example/Store.java",
    "lib/reader.rb",
    "App/Models/User.php",
  ];
  const resolver = createImportResolver(files);

  test("TS/JS：相对路径补扩展名、index 文件、以及 ESM 的 `.js` 写法", () => {
    assert.equal(resolver.resolve("src/index.ts", "./util"), "src/util.ts");
    assert.equal(resolver.resolve("src/index.ts", "./lib"), "src/lib/index.ts");
    assert.equal(resolver.resolve("src/index.ts", "./esm-style.js"), "src/esm-style.ts");
    assert.equal(resolver.resolve("src/index.ts", "../src/util.ts"), "src/util.ts");
    // 裸模块（node_modules / 路径别名）不猜。
    assert.equal(resolver.resolve("src/index.ts", "react"), null);
  });

  test("Python：相对导入按层数、绝对导入按唯一后缀", () => {
    assert.equal(resolver.resolve("src/app/main.py", "."), "src/app/__init__.py");
    assert.equal(resolver.resolve("src/app/main.py", "app"), null, "两处同名 app → 不猜");
    const onlyLib = createImportResolver(["lib/app/__init__.py", "lib/app/main.py"]);
    assert.equal(onlyLib.resolve("lib/app/main.py", "app"), "lib/app/__init__.py", "唯一后缀 → 命中");
  });

  test("Go：import 指向包目录，取目录里排序最前的文件；同名包有两个就不猜", () => {
    assert.equal(resolver.resolve("main.go", "example.com/x/internal/foo"), "internal/foo/foo.go");
    assert.equal(resolver.resolve("main.go", "example.com/y/app"), null);
  });

  test("Rust：crate::/self:: 与 `mod.rs` 两种形态", () => {
    // `tcp` 是 `ports.rs` 里的东西时指向文件本身（先试长的，试不通就退到短的）。
    assert.equal(resolver.resolve("src/main.rs", "crate::ports::tcp"), "src/ports.rs");
    // 同名文件不在时，`mod.rs` 形态才是答案。
    const modOnly = createImportResolver(["src/main.rs", "src/ports/mod.rs"]);
    assert.equal(modOnly.resolve("src/main.rs", "crate::ports"), "src/ports/mod.rs");
  });

  test("Java / Ruby / PHP：包路径与 require 的后缀匹配", () => {
    assert.equal(resolver.resolve("Main.java", "com.example.Store"), "com/example/Store.java");
    assert.equal(resolver.resolve("bin/run.rb", "reader"), "lib/reader.rb");
    assert.equal(resolver.resolve("index.php", "App\\Models\\User"), "App/Models/User.php");
  });
});

describe("fixture 仓库上的端到端引用边", () => {
  test("3. python-poetry：`from app import greet` 产生 import 边（w=2）与标识符边（w=1）", async () => {
    const root = `${REPO_FIXTURES}python-poetry`;
    const discovery = await discoverFiles(root);
    const symbols = [];
    const candidates = [];
    for (const file of discovery.indexable) {
      const text = await (await import("node:fs/promises")).readFile(`${root}/${file.path}`, "utf8");
      const tree = await pool.parse(file.lang, text);
      try {
        symbols.push({ path: file.path, symbols: extractSymbols(tree, file.lang) });
        candidates.push({ path: file.path, refs: extractRefs(tree, file.lang) });
      } finally {
        tree.delete();
      }
    }
    const edges = computeEdges({ files: discovery.indexable.map((file) => file.path), symbols, candidates });
    const intoModule = edges.filter((edge) => edge.fromPath === "src/app/main.py" && edge.toPath === "src/app/__init__.py");
    assert.deepEqual(
      intoModule.map((edge) => [edge.symbol, edge.weight]).sort(),
      [
        ["app", 2],
        ["greet", 1],
      ],
    );
    // `print(...)` 是内置函数，不可能命中任何定义 → 不该有边。
    assert.ok(!edges.some((edge) => edge.symbol === "print"), "内置函数不该产生边");
  });

  test("3. index fixture 目录里的跨语言同名不会互相串（每条边都指向真的定义了它的文件）", async () => {
    const discovery = await discoverFiles(INDEX_FIXTURES);
    const symbols = [];
    const candidates = [];
    for (const file of discovery.indexable) {
      const text = await (await import("node:fs/promises")).readFile(`${INDEX_FIXTURES}${file.path}`, "utf8");
      const tree = await pool.parse(file.lang, text);
      try {
        symbols.push({ path: file.path, symbols: extractSymbols(tree, file.lang) });
        candidates.push({ path: file.path, refs: extractRefs(tree, file.lang) });
      } finally {
        tree.delete();
      }
    }
    const edges = computeEdges({ files: discovery.indexable.map((file) => file.path), symbols, candidates });
    // `Store` 在 Go / Java / PHP / Rust 四个 fixture 里都有定义 → 四条边各 1/4，且每条都指向真的定义了它的文件。
    const storeEdges = edges.filter((edge) => edge.symbol === "Store");
    assert.ok(storeEdges.length > 0, "应该至少有一条 Store 的边");
    for (const edge of storeEdges) {
      const target = symbols.find((file) => file.path === edge.toPath)!;
      assert.ok(
        target.symbols.some((symbol) => symbol.name === edge.symbol),
        `${edge.toPath} 里并没有定义 ${edge.symbol}`,
      );
    }
  });
});
