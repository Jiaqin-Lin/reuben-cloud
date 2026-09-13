/**
 * P8 · 符号提取：一次 tree-sitter 遍历，把"定义"从语法树里捞出来（spec Phase 8 §3）。
 *
 * 【它与相邻文件的分工】`symbols.ts` 只认语法树，不认文件系统、不认数据库、不认 sqlite/PG——
 * 所以它能被单测直接喂一份 fixture 文本（`npm test` 里真的加载 vendor 的 .wasm）。
 * `parse.ts` 负责"读文件、开 worker、算预算"，`refs.ts` 负责"引用边"，`store.ts` 负责落库。
 * 一个文件一个职责，是因为这四件事的失败方式完全不同（语法不认、文件读不动、边算错、库写不进）。
 *
 * 【为什么是"节点类型表 + 通用遍历器"而不是 tree-sitter 的 query（.scm）】两者都能表达这件事，
 * 但表格能写的东西 query 不好写：① "函数 vs 方法"要看**外层容器**（`function_item` 在
 * `impl_item` 里是方法、在 `source_file` 里是函数）；② Go 的 `type_spec` 是什么 kind 要看它的
 * 子节点（struct → class、interface → interface、其余 → type）；③ "模块级常量"要区分作用域。
 * 用 query 表达这三件事要写成互相重叠的多条 pattern，再靠规则决定谁优先——那是把一张表
 * 拆成十几段字符串。表格用一个 Map 就够了，而且每个语言的那一屏就是它的全部规则。
 *
 * 【签名为什么要"截到 body 之前"】测试要点 2：`async dispatch(ctx: RouteContext): Promise<string>`
 * 这样的多行签名要压成一行、截断到 200 字符。取"body 子节点的起点"是唯一稳定的切法——
 * 正则找 `{` 会在 TS 的泛型、Java 的数组、Rust 的闭包里错。用 `body.endIndex === node.endIndex`
 * 兜住"body 不是最后一个子节点"的情况（那时退回第一行）。
 *
 * 【最容易写错的三处】
 *  ① **不要往函数体里走**。`function` 的函数体里可以有嵌套函数/局部常量，它们是"实现细节"，
 *     不是"能当跳转目标的定义"。本文件的做法是：定义节点默认不递归（只有 `container: true`
 *     的类 / trait / impl / module 才继续往下），**再加上一张 `FUNCTION_BOUNDARIES`**
 *     把匿名函数（箭头函数 / lambda / 闭包 / 块）也变成边界——否则测试回调里的局部常量会被
 *     当成模块级常量收下来，再长出几百条假边。
 *  ② **PHP 的 `variable_name` 带 `$`**、Python 的赋值左侧可能是元组解构、TS 的左侧可能是
 *     对象模式——名字节点必须先过类型白名单，否则会把 `$name` / `(a, b)` 当成符号名。
 *  ③ **行号是 1 起**（tree-sitter 的 row 是 0 起）。人是按 1 起读行号的，数据库里存 0 起
 *     等于给每个调用方埋一个 off-by-one。
 */

import path from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { Node as TsNode, Tree } from "web-tree-sitter";

// ---------------------------------------------------------------- 语言身份

export type LanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "ruby"
  | "php";

/** 顺序即"渲染顺序"的缺省（P9 的地图按语言分组时用）。 */
export const LANGUAGE_IDS: readonly LanguageId[] = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "ruby",
  "php",
];

/** 语言 id → vendor 目录里的语法文件名（`scripts/vendor-tree-sitter.ts` 也读这张表）。 */
export const GRAMMAR_FILES: Record<LanguageId, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
};

/**
 * 扩展名 → 语言。与 `environment/signals.ts` 的 `EXTENSION_LANGUAGES` 是**两件事**：
 * 那边回答"这个仓库是什么语言"（只看主语言，`.tsx` 归到 typescript），
 * 这边回答"这个文件用哪个语法文件解析"（`.tsx` 必须走 TSX 语法，否则 JSX 是语法错误）。
 */
const EXTENSIONS: Record<string, LanguageId> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
};

/** 一个文件路径 → 语言；不认识返回 null（调用方把这类文件计进 `files` 但不解析）。 */
export function languageOfPath(file: string): LanguageId | null {
  // 用 posix 的 extname：索引里的路径一律是 `/` 分隔的相对路径（`repo/*` 与 git 都这么给）。
  const ext = path.posix.extname(file).toLowerCase();
  return EXTENSIONS[ext] ?? null;
}

// ---------------------------------------------------------------- 符号记录

export type SymbolKind = "function" | "class" | "method" | "interface" | "type" | "const";

/** 与 009 迁移的 CHECK 约束是同一份清单。 */
export const SYMBOL_KINDS: readonly SymbolKind[] = ["function", "class", "method", "interface", "type", "const"];

export interface SymbolRecord {
  name: string;
  kind: SymbolKind;
  /** 单行、无换行、最多 `MAX_SIGNATURE_LENGTH` 字符。 */
  signature: string;
  /** 1 起（见文件头第 ③ 条）。 */
  startLine: number;
  endLine: number;
}

/** 签名的硬上限（spec Phase 8 §3：单行、截断到 200 字符）。 */
export const MAX_SIGNATURE_LENGTH = 200;

// ---------------------------------------------------------------- 规则表

/** "落在类容器里就是方法，否则是函数"——TS/Python/Java/Ruby/PHP 的同一个问题。 */
const FUNCTION_OR_METHOD = "function_or_method" as const;

interface DefinitionRule {
  /** 固定 kind；`FUNCTION_OR_METHOD` 表示看外层作用域；函数表示看这个节点自己。 */
  kind: SymbolKind | typeof FUNCTION_OR_METHOD | ((node: TsNode) => SymbolKind);
  /** 名字所在的字段。字段为空说明这个节点不是我们想要的形态（例如解构声明），跳过。 */
  nameField: string;
  /** 名字节点的类型白名单。不给就用 `NAME_NODE_TYPES`。 */
  nameTypes?: readonly string[];
  /** body 所在字段：签名截到它之前；找不到或不是最后一个子节点就退回第一行。 */
  bodyField?: string;
  /** 这个定义内部还可能有定义（类 / trait / impl / module）——只有它们会往子树走。 */
  container?: boolean;
  /** 只有模块级才算定义（常量：函数体里的临时变量不是符号）。 */
  moduleScope?: boolean;
  /** 签名要连带吸收的祖先（`const x = 1` 要带上 `const` 关键字）。 */
  absorb?: readonly string[];
}

/** 能当名字的节点类型。JS/TS、Python、Go、Rust、Java、Ruby、PHP 的合集。 */
const NAME_NODE_TYPES = new Set([
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "constant",
  "name",
  "simple_identifier",
  "variable_name",
]);

/** TS/JS 的导出包装：签名带上 `export` 比丢掉它有用（P9 的地图直接给人看）。 */
const EXPORT_WRAPPERS = new Set(["export_statement"]);

/**
 * TS / JS / TSX 共用一张表。JS 里永远不会出现 `interface_declaration` / `type_alias_declaration`，
 * 多两条死规则比维护三张会漂的表便宜。
 */
const TS_JS_RULES: Record<string, DefinitionRule> = {
  interface_declaration: { kind: "interface", nameField: "name", bodyField: "body" },
  type_alias_declaration: { kind: "type", nameField: "name" },
  class_declaration: { kind: "class", nameField: "name", bodyField: "body", container: true },
  abstract_class_declaration: { kind: "class", nameField: "name", bodyField: "body", container: true },
  function_declaration: { kind: FUNCTION_OR_METHOD, nameField: "name", bodyField: "body" },
  generator_function_declaration: { kind: FUNCTION_OR_METHOD, nameField: "name", bodyField: "body" },
  method_definition: { kind: "method", nameField: "name", bodyField: "body" },
  // `const x = …`：模块级才算；吸收 `const` / `export` 让签名像人写的那样。
  variable_declarator: {
    kind: "const",
    nameField: "name",
    moduleScope: true,
    absorb: ["lexical_declaration", "variable_declaration"],
  },
};

const PYTHON_RULES: Record<string, DefinitionRule> = {
  class_definition: { kind: "class", nameField: "name", bodyField: "body", container: true },
  function_definition: { kind: FUNCTION_OR_METHOD, nameField: "name", bodyField: "body" },
  // 模块级赋值当常量（`MAX_RETRIES = 3`）。函数体里的赋值不在遍历范围内，见文件头第 ① 条。
  assignment: { kind: "const", nameField: "left", nameTypes: ["identifier"], moduleScope: true },
};

const GO_RULES: Record<string, DefinitionRule> = {
  function_declaration: { kind: "function", nameField: "name", bodyField: "body" },
  method_declaration: { kind: "method", nameField: "name", bodyField: "body" },
  const_spec: { kind: "const", nameField: "name", absorb: ["const_declaration"] },
  type_spec: {
    kind: (node) => {
      const type = node.childForFieldName("type");
      if (type?.type === "struct_type") return "class"; // Go 的 struct 就是"挂方法的那个东西"
      if (type?.type === "interface_type") return "interface";
      return "type";
    },
    nameField: "name",
    // `type Store struct {` 没有单独的 body 字段可选（body 与 type 是同一个字段），
    // 所以签名走"第一行 + 去掉尾部的 `{`"，再靠 absorb 把 `type` 关键字带回来。
    absorb: ["type_declaration"],
  },
};

const RUST_RULES: Record<string, DefinitionRule> = {
  const_item: { kind: "const", nameField: "name" },
  static_item: { kind: "const", nameField: "name" },
  struct_item: { kind: "class", nameField: "name", bodyField: "body" },
  enum_item: { kind: "type", nameField: "name", bodyField: "body" },
  union_item: { kind: "type", nameField: "name", bodyField: "body" },
  trait_item: { kind: "interface", nameField: "name", bodyField: "body", container: true },
  function_item: { kind: FUNCTION_OR_METHOD, nameField: "name", bodyField: "body" },
  // trait 里的方法可以没有 body（`fn read(&self) -> String;`）。
  function_signature_item: { kind: "method", nameField: "name" },
};

const JAVA_RULES: Record<string, DefinitionRule> = {
  class_declaration: { kind: "class", nameField: "name", bodyField: "body", container: true },
  record_declaration: { kind: "class", nameField: "name", bodyField: "body", container: true },
  interface_declaration: { kind: "interface", nameField: "name", bodyField: "body", container: true },
  annotation_type_declaration: { kind: "interface", nameField: "name", bodyField: "body", container: true },
  enum_declaration: { kind: "type", nameField: "name", bodyField: "body" },
  method_declaration: { kind: FUNCTION_OR_METHOD, nameField: "name", bodyField: "body" },
  constructor_declaration: { kind: "method", nameField: "name", bodyField: "body" },
  // `field_declaration` 刻意不收：类字段不是"去哪儿看代码"的线索，收进来只会让地图变吵。
};

const RUBY_RULES: Record<string, DefinitionRule> = {
  method: { kind: FUNCTION_OR_METHOD, nameField: "name", bodyField: "body" },
  singleton_method: { kind: "method", nameField: "name", bodyField: "body" },
  class: { kind: "class", nameField: "name", bodyField: "body", container: true },
  // Ruby 的 module 与 class 在这个用途下是同一个东西：命名空间 + 方法的容器。
  module: { kind: "class", nameField: "name", bodyField: "body", container: true },
  assignment: { kind: "const", nameField: "left", nameTypes: ["constant"], moduleScope: true },
};

const PHP_RULES: Record<string, DefinitionRule> = {
  class_declaration: { kind: "class", nameField: "name", bodyField: "body", container: true },
  trait_declaration: { kind: "class", nameField: "name", bodyField: "body", container: true },
  interface_declaration: { kind: "interface", nameField: "name", bodyField: "body", container: true },
  enum_declaration: { kind: "type", nameField: "name", bodyField: "body" },
  function_definition: { kind: FUNCTION_OR_METHOD, nameField: "name", bodyField: "body" },
  method_declaration: { kind: "method", nameField: "name", bodyField: "body" },
  const_element: { kind: "const", nameField: "name", absorb: ["const_declaration"] },
  // `property_declaration` 与 Java 的字段同一条理由：不收。
};

const RULES: Record<LanguageId, Record<string, DefinitionRule>> = {
  typescript: TS_JS_RULES,
  tsx: TS_JS_RULES,
  javascript: TS_JS_RULES,
  python: PYTHON_RULES,
  go: GO_RULES,
  rust: RUST_RULES,
  java: JAVA_RULES,
  ruby: RUBY_RULES,
  php: PHP_RULES,
};

/**
 * 让子树里的函数变成方法的容器（`impl Store { fn new() }` → `new` 是方法）。
 * 表里 `container: true` 的定义本身就是容器，不需要在这里重复。
 */
const TYPE_CONTAINERS: Record<LanguageId, ReadonlySet<string>> = {
  typescript: new Set(),
  tsx: new Set(),
  javascript: new Set(),
  python: new Set(),
  go: new Set(),
  rust: new Set(["impl_item"]),
  java: new Set(),
  ruby: new Set(),
  php: new Set(),
};

/**
 * 匿名函数的边界：进到这些节点里面就不再往下找定义。
 *
 * 【为什么必须有这张表】"不往函数体里走"这条规则只在**具名定义**上白拿：
 * `function foo(){}` 与 `method_definition` 都是规则表里的定义节点，不递归就跳过去了。
 * 但 `describe("x", () => { const inside = 1 })` 里的箭头函数**不是定义**——它只是一个表达式，
 * 于是遍历会走进去，把测试回调里的局部常量当成模块级常量收下来。
 * 真实效果不是"多几个符号"：`input` / `now` / `line` / `after` 这些局部名会在符号表里
 * 长出一堆同名定义，接着产生几百条指向测试文件的假边（实现时在本仓库自身上量到 7.5% 的边
 * 来自这一类噪声）。
 */
const FUNCTION_BOUNDARIES: Record<LanguageId, ReadonlySet<string>> = {
  typescript: new Set(["arrow_function", "function_expression", "generator_function"]),
  tsx: new Set(["arrow_function", "function_expression", "generator_function"]),
  javascript: new Set(["arrow_function", "function_expression", "generator_function"]),
  python: new Set(["lambda"]),
  go: new Set(["func_literal"]),
  rust: new Set(["closure_expression"]),
  java: new Set(["lambda_expression"]),
  ruby: new Set(["do_block", "block", "lambda"]),
  php: new Set(["anonymous_function", "arrow_function"]),
};

// ---------------------------------------------------------------- 遍历

/** 遍历时的作用域：只有"方法还是函数"和"模块级常量"两件事需要看它。 */
type Scope = "module" | "type";

type SymbolSink = SymbolRecord[];

export function extractSymbols(tree: Tree, lang: LanguageId): SymbolRecord[] {
  const rules = RULES[lang];
  const containers = TYPE_CONTAINERS[lang];
  const boundaries = FUNCTION_BOUNDARIES[lang];
  const out: SymbolSink = [];
  walk(tree.rootNode, rules, containers, boundaries, "module", out);
  // 确定性：同一个文件解析两次必须逐字段相同（P9 的地图与 P10 的缓存前缀都建在这上面）。
  out.sort((a, b) =>
    a.startLine !== b.startLine
      ? a.startLine - b.startLine
      : a.name !== b.name
        ? a.name < b.name
          ? -1
          : 1
        : a.kind < b.kind
          ? -1
          : a.kind > b.kind
            ? 1
            : 0,
  );
  return out;
}

function walk(
  node: TsNode,
  rules: Record<string, DefinitionRule>,
  containers: ReadonlySet<string>,
  boundaries: ReadonlySet<string>,
  scope: Scope,
  out: SymbolSink,
): void {
  for (const child of node.namedChildren) {
    const rule = rules[child.type];
    if (rule !== undefined) {
      const symbol = symbolOf(child, rule, scope);
      if (symbol !== null) out.push(symbol);
      if (rule.container === true) walk(child, rules, containers, boundaries, "type", out);
      // 不是 container 的定义一律不往下走：函数体 / 常量值里的东西不是符号（文件头 ①）。
      continue;
    }
    // 匿名函数不是定义、但它是个边界：里面的东西是局部变量（见 `FUNCTION_BOUNDARIES`）。
    if (boundaries.has(child.type)) continue;
    if (containers.has(child.type)) {
      walk(child, rules, containers, boundaries, "type", out);
      continue;
    }
    walk(child, rules, containers, boundaries, scope, out);
  }
}

function symbolOf(node: TsNode, rule: DefinitionRule, scope: Scope): SymbolRecord | null {
  if (rule.moduleScope === true && scope !== "module") return null;
  const allowed = new Set(rule.nameTypes ?? NAME_NODE_TYPES);
  // 字段优先，字段没有就退到"第一个像名字的子节点"：PHP 的 `const_element` 就是这一种
  // （`name` 是个裸子节点，没有字段名），而按类型找比按位置找更不容易在改语法时静默错位。
  const nameNode =
    node.childForFieldName(rule.nameField) ??
    node.namedChildren.find((child) => allowed.has(child.type)) ??
    null;
  if (nameNode === null) return null;
  if (!allowed.has(nameNode.type)) return null;
  const name = normaliseName(nameNode.text);
  if (name === "" || /\s/.test(name)) return null;
  const kind = typeof rule.kind === "function" ? rule.kind(node) : rule.kind;
  return {
    name,
    kind: kind === FUNCTION_OR_METHOD ? (scope === "type" ? "method" : "function") : kind,
    signature: signatureOf(node, rule),
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

/** PHP 的 `$name` 去掉 `$`：refs 匹配用的是不带 `$` 的名字（`->name` 里的那一份）。 */
function normaliseName(text: string): string {
  return text.startsWith("$") ? text.slice(1) : text;
}

/**
 * 签名 = 定义节点（或它的声明包装）的文本，截到 body 之前，压成单行。
 */
function signatureOf(node: TsNode, rule: DefinitionRule): string {
  let base = node;
  // 吸收祖先：`export const x = 1` / `const MaxRetries = 3` 这些关键字在祖先节点上。
  let cursor: TsNode | null = node.parent;
  while (cursor !== null && (EXPORT_WRAPPERS.has(cursor.type) || rule.absorb?.includes(cursor.type) === true)) {
    base = cursor;
    cursor = cursor.parent;
  }

  const text = base.text;
  const body = rule.bodyField === undefined ? null : node.childForFieldName(rule.bodyField);
  // body 必须是这个节点的最后一个子节点，减掉它的文本才是"签名"；否则退回第一行。
  const head =
    body !== null && body.endIndex === node.endIndex && text.length >= body.text.length
      ? text.slice(0, text.length - body.text.length)
      : (text.split("\n", 1)[0] ?? text);

  const oneLine = head.replace(/\s+/g, " ").trim().replace(/[{;:,]+$/, "").trim();
  return oneLine.length > MAX_SIGNATURE_LENGTH
    ? `${oneLine.slice(0, MAX_SIGNATURE_LENGTH - 1)}…`
    : oneLine;
}

// ---------------------------------------------------------------- 解析器池

/**
 * 一个语言一个 Parser（`setLanguage` 之后就固定了）。Parser 是有状态的 WASM 对象，
 * 每次 parse 都新建一个会很慢；跨文件复用是安全的——tree-sitter 的 parse 没有跨调用的状态。
 */
export interface ParserPool {
  /** 只在**第一次**用某个语言时才会真的等待（加载 .wasm），之后是同步的 parse 包了一层 Promise。 */
  parse(lang: LanguageId, text: string): Promise<Tree>;
  loadedLanguages(): LanguageId[];
  close(): void;
}

/**
 * 打开一个解析器池。语法文件按需加载（一个纯 Go 仓库不该付 TS 的初始化时间），
 * 加载过的 Language 常驻——它们是不可变的 WASM 模块，重复加载才是浪费。
 */
export async function openParserPool(vendorDir: string): Promise<ParserPool> {
  const languages = new Map<LanguageId, Language>();
  const parsers = new Map<LanguageId, Parser>();
  await Parser.init();

  async function parserFor(lang: LanguageId): Promise<Parser> {
    const existing = parsers.get(lang);
    if (existing !== undefined) return existing;
    const loaded = await Language.load(path.join(vendorDir, GRAMMAR_FILES[lang]));
    const parser = new Parser();
    parser.setLanguage(loaded);
    languages.set(lang, loaded);
    parsers.set(lang, parser);
    return parser;
  }

  return {
    async parse(lang: LanguageId, text: string): Promise<Tree> {
      // 这里返回的是 Promise 只是为了让签名统一（调用方在 worker 的异步循环里）：
      // `parserFor` 命中缓存时是同步的，真正的等待只发生在首次加载。
      return (await parserFor(lang)).parse(text) as Tree;
    },
    loadedLanguages: () => [...languages.keys()],
    close: () => {
      // 只删 Parser：`Language` 在这个版本里没有 dispose（WASM 模块由 Emscripten 自己管），
      // 而它本来就不该被反复加载——一个进程里每种语言只 load 一次。
      for (const parser of parsers.values()) parser.delete();
      parsers.clear();
      languages.clear();
    },
  };
}
