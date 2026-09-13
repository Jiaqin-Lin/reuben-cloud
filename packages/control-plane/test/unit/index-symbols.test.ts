/**
 * P8 · 每语言符号提取的金标准（spec 测试要点 1、2）。
 *
 * 【它拦住的是哪一类回归】符号提取的"对不对"没有编译器能帮我们检查（tree-sitter 认语法、
 * 不认语义）。这份表把九个语言的**每一个**定义、它的 kind、起止行、签名逐字钉住——
 * 将来升 tree-sitter、改一条规则、或者"顺手"把某个字段名写错，都会在这里变成一条具体的 diff，
 * 而不是"地图看起来怪怪的"。
 *
 * 【为什么金标准写在这里而不是一个 fixture 文件里】它要断的是"名字 + kind + 签名 + 行号"四件事；
 * 放进 JSON 只是把同一个表换一种语法，却多出一份要与测试同步维护的文件。
 *
 * 【它不替代什么】真仓库的规模（几万个文件）与奇怪写法（宏、字符串里的代码、生成代码）
 * 由真实使用与 P9 的地图效果覆盖；这里是"契约级"的最小样本。
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { extractSymbols, openParserPool, languageOfPath } from "../../src/index/symbols.ts";
import type { ParserPool, SymbolRecord } from "../../src/index/symbols.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/index/", import.meta.url));
const VENDOR = fileURLToPath(new URL("../../../../vendor/tree-sitter/", import.meta.url));

let pool: ParserPool;

before(async () => {
  pool = await openParserPool(VENDOR);
});

after(() => {
  pool.close();
});

/** 金标准的一行的形状：`行号 起-止 | kind | 名字 | 签名`。 */
type Golden = [name: string, kind: SymbolRecord["kind"], startLine: number, endLine: number, signature: string];

async function symbolsOf(file: string): Promise<SymbolRecord[]> {
  const lang = languageOfPath(file);
  assert.notEqual(lang, null, `${file} 应该有对应的语法文件`);
  const text = await readFile(FIXTURES + file, "utf8");
  const tree = await pool.parse(lang!, text);
  try {
    return extractSymbols(tree, lang!);
  } finally {
    tree.delete();
  }
}

async function assertGolden(file: string, golden: Golden[]): Promise<void> {
  const actual = (await symbolsOf(file)).map(
    (symbol) => [symbol.name, symbol.kind, symbol.startLine, symbol.endLine, symbol.signature] as Golden,
  );
  assert.deepEqual(actual, golden);
}

describe("每语言符号提取", () => {
  test("1. TypeScript：interface / type / class / 方法 / 函数 / const，签名带上 export", async () => {
    await assertGolden("sample.ts", [
      ["RouteContext", "interface", 12, 15, "export interface RouteContext"],
      ["Handler", "type", 17, 17, "export type Handler = (ctx: RouteContext) => Promise<string>"],
      ["Router", "class", 19, 33, "export class Router"],
      ["constructor", "method", 22, 24, "constructor(prefix: string)"],
      ["add", "method", 26, 28, "add(path: string, handler: Handler): void"],
      ["dispatch", "method", 30, 32, "async dispatch(ctx: RouteContext): Promise<string>"],
      ["createRouter", "function", 35, 37, "export function createRouter(prefix: string): Router"],
      ["defaultRouter", "const", 39, 39, 'export const defaultRouter = createRouter("/")'],
    ]);
  });

  test("1. TSX：class 里的 render 是方法，函数组件的参数解构不影响签名", async () => {
    await assertGolden("sample.tsx", [
      ["PanelProps", "interface", 3, 6, "export interface PanelProps"],
      ["Panel", "function", 8, 10, "export function Panel({ title, count = 1 }: PanelProps)"],
      ["PanelView", "class", 12, 16, "export class PanelView extends Component<PanelProps>"],
      ["render", "method", 13, 15, "render()"],
    ]);
  });

  test("1. JavaScript：export default / 箭头函数常量 / require", async () => {
    await assertGolden("sample.js", [
      ["path", "const", 3, 3, 'const path = require("node:path")'],
      ["greet", "function", 5, 7, "export function greet(name)"],
      ["Greeter", "class", 9, 17, "export class Greeter"],
      ["constructor", "method", 10, 12, "constructor(prefix)"],
      ["greet", "method", 14, 16, "greet(name)"],
      ["VERSION", "const", 19, 19, 'export const VERSION = "1.0.0"'],
      ["format", "const", 21, 21, "const format = (value) => `${value}`"],
      ["main", "function", 23, 25, "export default function main()"],
    ]);
  });

  test("1. Python：装饰器不影响定义识别；函数体里的 lambda 不是符号", async () => {
    await assertGolden("sample.py", [
      ["MAX_RETRIES", "const", 9, 9, "MAX_RETRIES = 3"],
      ["Session", "class", 13, 19, "class Session"],
      ["refresh", "method", 18, 19, "def refresh(self, ttl: int) -> str"],
      ["load_session", "function", 22, 24, "def load_session(token: str) -> Session"],
    ]);
  });

  test("1. Go：struct → class、interface → interface、别名 → type，接收者方法 → method", async () => {
    await assertGolden("sample.go", [
      ["MaxRetries", "const", 5, 5, "const MaxRetries = 3"],
      ["Store", "class", 7, 9, "type Store struct"],
      ["Reader", "interface", 11, 13, "type Reader interface"],
      ["Key", "type", 15, 15, "type Key string"],
      ["NewStore", "function", 17, 19, "func NewStore(name string) *Store"],
      ["Read", "method", 21, 23, "func (s *Store) Read(key string) (string, error)"],
      ["Close", "method", 25, 27, "func (s *Store) Close() error"],
    ]);
  });

  test("1. Rust：trait 里的无 body 方法、impl 里的方法、自由函数", async () => {
    await assertGolden("sample.rs", [
      ["MAX_RETRIES", "const", 3, 3, "pub const MAX_RETRIES: u32 = 3"],
      ["Store", "class", 5, 7, "pub struct Store"],
      ["Mode", "type", 9, 12, "pub enum Mode"],
      ["Reader", "interface", 14, 16, "pub trait Reader"],
      ["read", "method", 15, 15, "fn read(&self, key: &str) -> String"],
      ["new", "method", 19, 23, "pub fn new(name: &str) -> Self"],
      ["read", "method", 25, 27, "pub fn read(&self, key: &str) -> String"],
      ["open", "function", 30, 32, "pub fn open(name: &str) -> Store"],
    ]);
  });

  test("1. Java：字段不收；interface 里的方法没有 body 也认", async () => {
    await assertGolden("sample.java", [
      ["Store", "class", 7, 17, "public class Store"],
      ["Store", "method", 10, 12, "public Store(String name)"],
      ["read", "method", 14, 16, "public String read(String key, List<String> extra)"],
      ["Reader", "interface", 19, 21, "interface Reader"],
      ["read", "method", 20, 20, "String read(String key)"],
      ["Mode", "type", 23, 26, "enum Mode"],
    ]);
  });

  test("1. Ruby：module（→ class）/ 类方法 / 顶层方法", async () => {
    await assertGolden("sample.rb", [
      ["MAX_RETRIES", "const", 3, 3, "MAX_RETRIES = 3"],
      ["Auth", "class", 5, 19, "module Auth"],
      ["Session", "class", 6, 18, "class Session"],
      ["initialize", "method", 7, 9, "def initialize(token)"],
      ["refresh", "method", 11, 13, "def refresh(ttl)"],
      ["build", "method", 15, 17, "def self.build(token)"],
      ["load_session", "function", 21, 23, "def load_session(token)"],
    ]);
  });

  test("1. PHP：属性不收；`$` 不进符号名", async () => {
    await assertGolden("sample.php", [
      ["MAX_RETRIES", "const", 5, 5, "const MAX_RETRIES = 3"],
      ["Reader", "interface", 7, 10, "interface Reader"],
      ["read", "method", 9, 9, "public function read(string $key): string"],
      ["Store", "class", 12, 25, "class Store implements Reader"],
      ["__construct", "method", 16, 19, "public function __construct(string $name)"],
      ["read", "method", 21, 24, "public function read(string $key): string"],
      ["open", "function", 27, 30, "function open(string $name): Store"],
    ]);
  });
});

describe("签名重建（测试要点 2）", () => {
  test("2. 多行签名压成单行，并在 body 之前截断", async () => {
    const source = [
      "export function multiLine(",
      "  first: string,",
      "  second: number,",
      "): Promise<void> {",
      "  return;",
      "}",
      "",
    ].join("\n");
    const tree = await pool.parse("typescript", source);
    try {
      const [symbol] = extractSymbols(tree, "typescript");
      assert.equal(symbol?.signature, "export function multiLine( first: string, second: number, ): Promise<void>");
    } finally {
      tree.delete();
    }
  });

  test("2. 超过 200 字符截断（保留 199 字符 + 一个省略号，总数不超上限）", async () => {
    const params = Array.from({ length: 40 }, (_, index) => `argument${index}: string`).join(", ");
    const source = `export function veryLong(${params}): void {\n  return;\n}\n`;
    const tree = await pool.parse("typescript", source);
    try {
      const [symbol] = extractSymbols(tree, "typescript");
      assert.equal(symbol!.signature.length, 200);
      assert.ok(symbol!.signature.endsWith("…"), "截断要看得见");
      assert.ok(symbol!.signature.startsWith("export function veryLong("));
    } finally {
      tree.delete();
    }
  });

  test("2. 无 body 的声明（interface / type alias / trait 方法）取第一行并去掉尾部的 `{` / `;`", async () => {
    const cases: [lang: "typescript" | "rust", source: string, expected: string][] = [
      ["typescript", "export interface Big {\n  a: string;\n}\n", "export interface Big"],
      // 多行 type alias 只留首行——spec §3 的规则就是"第一行"（到 body 之前，而它没有 body）。
      // 代价是 `= | 'a'` 那一段看不到，收益是规则简单到不用猜。
      ["typescript", "export type Union =\n  | 'a'\n  | 'b';\n", "export type Union ="],
      ["rust", "pub trait Reader {\n    fn read(&self) -> String;\n}\n", "pub trait Reader"],
      ["rust", "pub trait Reader {\n    fn read(&self) -> String;\n}\n", "fn read(&self) -> String"],
    ];
    for (const [lang, source, expected] of cases) {
      const tree = await pool.parse(lang, source);
      try {
        const signatures = extractSymbols(tree, lang).map((symbol) => symbol.signature);
        assert.ok(signatures.includes(expected), `${lang}: 期望包含 ${expected}，实际 ${JSON.stringify(signatures)}`);
      } finally {
        tree.delete();
      }
    }
  });

  test("匿名函数（回调 / lambda / 闭包 / 块）是边界：里面的局部定义不是符号", async () => {
    // 这条规则拦住的是真出现过的一类噪声：`describe("x", () => { const input = 1 })` 里的
    // `input` 被当成模块级常量收下来，于是符号表里长出一堆同名定义、再产生几百条假边。
    const cases: [lang: "typescript" | "python" | "ruby" | "go" | "rust" | "java" | "php", source: string][] = [
      ["typescript", 'describe("x", () => {\n  const inside = 1;\n});\nexport const outside = 2;\n'],
      ["python", "handler = lambda value: value\nMAX = 1\n"],
      ["ruby", "items.each do |item|\n  inside = item\nend\nMAX = 1\n"],
      ["go", "package x\n\nfunc main() {\n\tf := func() {\n\t\tinside := 1\n\t\t_ = inside\n\t}\n\t_ = f\n}\n"],
      ["rust", "fn main() {\n    let f = || {\n        let inside = 1;\n        inside\n    };\n    let _ = f;\n}\n"],
      ["java", "class A {\n  void run() {\n    Runnable r = () -> { int inside = 1; };\n  }\n}\n"],
      ["php", "<?php\n$f = function () {\n  $inside = 1;\n};\n"],
    ];
    for (const [lang, source] of cases) {
      const tree = await pool.parse(lang, source);
      try {
        const names = extractSymbols(tree, lang).map((symbol) => symbol.name);
        assert.ok(!names.includes("inside"), `${lang}: 匿名函数里的 inside 不该是符号（实际 ${JSON.stringify(names)}）`);
      } finally {
        tree.delete();
      }
    }
    // 边界的另一侧：模块级的东西照收。
    const ts = await pool.parse("typescript", 'describe("x", () => {\n  const inside = 1;\n});\nexport const outside = 2;\n');
    try {
      assert.deepEqual(extractSymbols(ts, "typescript").map((symbol) => symbol.name), ["outside"]);
    } finally {
      ts.delete();
    }
  });

  test("空文件与纯注释文件没有符号，且不抛", async () => {
    for (const source of ["", "\n\n", "// 只有一行注释\n", "# python 注释\n"]) {
      const lang = source.startsWith("#") ? "python" : "typescript";
      const tree = await pool.parse(lang, source);
      try {
        assert.deepEqual(extractSymbols(tree, lang), []);
      } finally {
        tree.delete();
      }
    }
  });

  test("同一个文件解析两次结果逐字段相同（确定性）", async () => {
    const text = await readFile(`${FIXTURES}sample.ts`, "utf8");
    const first = await pool.parse("typescript", text);
    const second = await pool.parse("typescript", text);
    try {
      assert.deepEqual(extractSymbols(first, "typescript"), extractSymbols(second, "typescript"));
    } finally {
      first.delete();
      second.delete();
    }
  });
});
