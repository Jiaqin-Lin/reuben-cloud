/**
 * P8 · 引用边（文件级）：从语法树里捞"候选引用"，再把候选解成 `A → B` 的边（spec Phase 8 §4）。
 *
 * 【为什么分两半，而且后一半是纯函数】前半 `extractRefs` 要语法树（只能在 worker 里跑），
 * 后半 `createImportResolver` + `computeEdges` 只要"每个文件的候选 + 全量符号表 + 全量文件集"
 * （纯数据，能在单测里造任意形态）。歧义衰减、`n > 5` 丢弃、import 权重 2 这些规则全是后一半的事
 * ——把它们混进语法遍历，就只能靠"造一个刚好有 8 个同名定义的仓库"来测一条纯规则。
 *
 * 【候选只收三种：裸调用目标、成员访问的根、import 路径】spec Phase 8 §4 明说了这是
 * "去掉语言关键字与局部变量名的最佳努力"。语法树能给出一个便宜的近似：`a.b.c()` 里 `a`
 * 很可能是一个模块/类名（能映射到定义它的文件），而裸调用 `foo()` 里的 `foo` 同。
 * 而 `const x = 1` 里的 `x`、参数名、局部变量不是——它们要么没有定义文件，要么满地都是；
 * `a.b.c()` 里的 `c`（属性名）与测试框架的全局名也不是，两边都有实测数字，
 * 见 `calleeName` 与 `FRAMEWORK_GLOBALS` 的注释（附录 A-55）。
 * 这个近似的代价是漏边（少几条），收益是不产生"看起来有但错"的边（设计文档 §D.3 的原则）。
 *
 * 【import 为什么要单独一档、权重 2】`import { foo } from "./bar"` 是一条**作者写下的**
 * 依赖声明，它比"调用目标恰好同名"强得多。权重 2 让它在 PageRank 里压过同名推测出来的边，
 * 而 1.0 仍然是"唯一同名"的基准权重（spec §4 的表格）。
 *
 * 【路径解析的态度：宁可没有边，不要错的边】非相对路径（Python 的 `app`、Java 的 `a.b.C`、
 * Go 的包路径）没有 resolver 就不可能精确。这里的做法是：按优先级列候选，**只在唯一命中时**
 * 产生边；命中多个（同名模块在别的地方也有一份）就丢掉。丢一条边只是地图少一条线，
 * 错一条边会让 PageRank 把不相干的文件排到前面——后者才是真正会误导模型的那种错。
 */

import path from "node:path";
import type { Node as TsNode, Tree } from "web-tree-sitter";
import { languageOfPath } from "./symbols.ts";
import type { LanguageId, SymbolRecord } from "./symbols.ts";

// ---------------------------------------------------------------- 常量

/** 同名定义超过这么多处就丢掉这条边（spec §4：n > 5 时丢弃）。 */
export const MAX_DEFINITION_CANDIDATES = 5;

/** import / require / use 路径直接给出的边（spec §4：weight=2）。 */
export const IMPORT_EDGE_WEIGHT = 2;

/** 唯一同名定义时的权重。多个候选时每条 `1 / n`（加起来是 1）。 */
export const SINGLE_DEFINITION_WEIGHT = 1;

// ---------------------------------------------------------------- 候选引用

export interface FileRefs {
  /** 候选标识符：去重、排序。落 `repo_file_refs`，也是增量重建时的输入。 */
  identifiers: string[];
  /** import / require / use 的原始路径（已去掉引号），去重、排序。 */
  imports: string[];
}

export function extractRefs(tree: Tree, lang: LanguageId): FileRefs {
  const identifiers = new Set<string>();
  const imports = new Set<string>();
  const rules = REF_RULES[lang];
  visit(tree.rootNode, rules, identifiers, imports);
  return { identifiers: [...identifiers].sort(), imports: [...imports].sort() };
}

interface CallRule {
  /** 调用形态的节点类型（`call_expression` / `method_invocation` / `call`…）。 */
  types: readonly string[];
  /** 被调名字所在的字段。 */
  nameField: string;
  /**
   * "有接收者"的字段。给了它、而这个字段非空时就**不收被调名字**（只留成员链的根）。
   * 有它是因为 Java 的 `method_invocation`、PHP 的 `scoped_call_expression`、Ruby 的 `call`
   * 都把"方法名"和"接收者"拆成两个字段，而其余语言用一个成员表达式包着。
   */
  receiverField?: string;
}

interface MemberRule {
  /** 成员访问的节点类型（`member_expression` / `attribute` / `selector_expression`…）。 */
  types: readonly string[];
  /** 链的"根"所在的字段（`object` / `operand` / `value`…）。 */
  rootField: string;
  /** 链的最后一个名字所在字段（Ruby 的 `Auth::Session` 要两边都收）。 */
  nameField?: string;
}

interface RefRules {
  calls: readonly CallRule[];
  members: readonly MemberRule[];
  /** import 类语句的节点类型（交给 `collectImports` 处理）。 */
  imports: ReadonlySet<string>;
}

const IDENTIFIER_TYPES = new Set([
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "constant",
  "name",
  "simple_identifier",
]);

/**
 * 测试框架注入的全局函数（Mocha / Jest / Vitest / node:test）与 node:assert 的入口名。
 *
 * 【为什么值得单独列一份】它们在一个 JS/TS 仓库里出现几百次，而"恰好定义了同名符号"的文件
 * 纯属巧合（本仓库里 `describe` 命中两个 interface 上的同名方法、`assert` 命中一个脚本里的
 * 局部 helper，共 265 条边）。这与"同名定义有多个"那条歧义规则不同：歧义是**多个**定义撞上，
 * 这里是**一个**定义撞上了框架的全局名——1/N 衰减救不了它。
 * 代价是"如果一个仓库真的定义了并调用同名函数，这条边会少"——对这几个名字而言，
 * 前者在任何 JS 仓库里都成立，后者罕见。
 */
const FRAMEWORK_GLOBALS = new Set([
  "describe",
  "test",
  "it",
  "expect",
  "assert",
  "before",
  "after",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "suite",
  "setup",
  "teardown",
]);

/** 不是标识符的关键字/内置名：它们不可能是本仓库里的定义。 */
const KEYWORDS = new Set([
  "this",
  "self",
  "super",
  "cls",
  "Self",
  "static",
  "parent",
  "$this",
  "crate",
  "std",
  "core",
  "alloc",
]);

const TS_JS_REFS: RefRules = {
  calls: [
    { types: ["call_expression"], nameField: "function" },
    { types: ["new_expression"], nameField: "constructor" },
    // JSX 的元素其实是一次调用（`<Panel />`），而它是 React 仓库里最主要的引用形态。
    { types: ["jsx_self_closing_element", "jsx_opening_element"], nameField: "name" },
  ],
  members: [{ types: ["member_expression"], rootField: "object" }],
  imports: new Set(["import_statement", "export_statement", "call_expression"]),
};

const PYTHON_REFS: RefRules = {
  calls: [{ types: ["call"], nameField: "function" }],
  members: [{ types: ["attribute"], rootField: "object" }],
  imports: new Set(["import_statement", "import_from_statement", "future_import_statement"]),
};

const GO_REFS: RefRules = {
  calls: [
    { types: ["call_expression"], nameField: "function" },
    // `Store{…}` / `&Store{…}`：Go 里"用到某个类型"最常见的写法。
    { types: ["composite_literal"], nameField: "type" },
  ],
  members: [{ types: ["selector_expression"], rootField: "operand" }],
  imports: new Set(["import_spec"]),
};

const RUST_REFS: RefRules = {
  calls: [
    { types: ["call_expression"], nameField: "function" },
    { types: ["macro_invocation"], nameField: "macro" },
  ],
  members: [
    { types: ["field_expression"], rootField: "value" },
    // `Store::new(…)` 里的 `Store` 在 path 字段上；`new` 由 call 规则收。
    { types: ["scoped_identifier"], rootField: "path" },
  ],
  imports: new Set(["use_declaration"]),
};

const JAVA_REFS: RefRules = {
  calls: [
    // `run()` 收（裸调用）；`extra.size()` 不收（有接收者，只由下面那条收 `extra`）。
    { types: ["method_invocation"], nameField: "name", receiverField: "object" },
    { types: ["object_creation_expression"], nameField: "type" },
  ],
  members: [
    { types: ["field_access"], rootField: "object" },
    { types: ["method_invocation"], rootField: "object" },
  ],
  imports: new Set(["import_declaration"]),
};

const RUBY_REFS: RefRules = {
  calls: [{ types: ["call"], nameField: "method", receiverField: "receiver" }],
  members: [
    { types: ["scope_resolution"], rootField: "scope", nameField: "name" },
    // `obj.build(1)`：接收者是标识符时它就是那条依赖的根（`Auth::Session.build` 走上面那条）。
    { types: ["call"], rootField: "receiver" },
  ],
  imports: new Set(["call"]),
};

const PHP_REFS: RefRules = {
  calls: [
    { types: ["function_call_expression"], nameField: "function" },
    { types: ["scoped_call_expression"], nameField: "name", receiverField: "scope" },
    { types: ["object_creation_expression"], nameField: "type" },
  ],
  members: [
    { types: ["member_access_expression"], rootField: "object" },
    { types: ["scoped_call_expression"], rootField: "scope" },
  ],
  imports: new Set([
    "namespace_use_declaration",
    "include_expression",
    "include_once_expression",
    "require_expression",
    "require_once_expression",
  ]),
};

const REF_RULES: Record<LanguageId, RefRules> = {
  typescript: TS_JS_REFS,
  tsx: TS_JS_REFS,
  javascript: TS_JS_REFS,
  python: PYTHON_REFS,
  go: GO_REFS,
  rust: RUST_REFS,
  java: JAVA_REFS,
  ruby: RUBY_REFS,
  php: PHP_REFS,
};

function visit(node: TsNode, rules: RefRules, identifiers: Set<string>, imports: Set<string>): void {
  for (const child of node.namedChildren) {
    for (const rule of rules.calls) {
      if (rule.types.includes(child.type)) {
        const name = calleeName(child, rule);
        if (name !== null) identifiers.add(name);
      }
    }
    for (const rule of rules.members) {
      if (!rule.types.includes(child.type)) continue;
      const root = chainRoot(child, rule.rootField);
      if (root !== null) identifiers.add(root);
      if (rule.nameField !== undefined) {
        const name = simpleName(child.childForFieldName(rule.nameField));
        if (name !== null) identifiers.add(name);
      }
    }
    if (rules.imports.has(child.type)) collectImports(child, imports);
    visit(child, rules, identifiers, imports);
  }
}

/**
 * 被调用的名字——**只收裸调用目标**：`foo()` → `foo`；`new Store()` → `Store`；`<Panel />` → `Panel`。
 *
 * 【为什么 `a.b.c()` 里的 `c` 不收】它是"某个对象的属性"，而这里的图是**文件级**的：
 * `obj.method()` 能说明的依赖（"这个文件用了 obj 这个模块/类型"）已经由成员链的根给出了，
 * 而 `method` 这个名字会与**任何**同名函数挂上钩。实测过代价：在本仓库自身上，
 * `console.log` / `res.text` / `stream.end` / `container.destroy` 这些属性名曾经贡献了
 * 7.6% 的边（`log` 一个名字 212 条），而它们指向的是某个恰好定义了同名函数（往往是测试里的
 * 局部常量）的文件——对 PageRank 来说这是投毒，不是信号。设计文档 §D.3 的原则是
 * "宁可少一条边，不要错一条边"。
 */
function calleeName(call: TsNode, rule: CallRule): string | null {
  // "有接收者"的语言（Java / PHP / Ruby）：接收者在时方法名不算调用目标，只收接收者的根。
  if (rule.receiverField !== undefined && call.childForFieldName(rule.receiverField) !== null) return null;
  // 字段缺失时退到"第一个像名字的子节点"：PHP 的 `new Store(…)` 没有字段名，
  // JSX 开标签的名字也可能是裸的 `identifier`。
  const target = call.childForFieldName(rule.nameField) ?? call.namedChildren.find((child) => IDENTIFIER_TYPES.has(child.type)) ?? null;
  if (target === null) return null;
  const name = simpleName(target);
  if (name === null) return null; // 成员表达式 / 作用域路径 / 框架全局名：根由 `members` 规则收
  // 内置元素的过滤只对 JSX 生效：`print(...)` 是首字母小写，但它绝不是 HTML 标签。
  return call.type.startsWith("jsx_") && isIntrinsicJsxElement(name) ? null : name;
}

/**
 * JSX 里的内置元素（`div` / `h1` / `svg:path`）不是我们的符号，收集它们只会给地图加噪声。
 * 组件名的约定是首字母大写（或含点/冒号命名空间）——这是 JSX 自己的一条语法约定，值得依赖。
 */
function isIntrinsicJsxElement(name: string): boolean {
  return /^[a-z]/.test(name) && !name.includes(".") && !name.includes(":");
}

/** 成员链的根：`a.b.c` → `a`；`this.x` → null（`this` 不是定义）。 */
function chainRoot(member: TsNode, rootField: string): string | null {
  let cursor = member.childForFieldName(rootField);
  let guard = 0;
  while (cursor !== null && guard < 16) {
    guard += 1;
    const parent = cursor.childForFieldName(rootField);
    if (parent === null) break;
    cursor = parent;
  }
  return cursor === null ? null : simpleName(cursor);
}

function simpleName(node: TsNode | null): string | null {
  if (node === null) return null;
  if (!IDENTIFIER_TYPES.has(node.type)) return null;
  const text = node.text;
  if (text === "" || KEYWORDS.has(text) || FRAMEWORK_GLOBALS.has(text) || /\s/.test(text)) return null;
  return text;
}

// ---------------------------------------------------------------- import 提取

/** 去掉引号（`"x"` / `'x'` / 反引号）：只留路径本身。 */
function unquote(text: string): string {
  const trimmed = text.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (trimmed.length >= 2 && (first === '"' || first === "'" || first === "`") && first === last) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 一个节点里所有字符串字面量的内容（PHP 的 include 表达式会把路径拼成几段）。 */
function stringLiterals(node: TsNode): string[] {
  const out: string[] = [];
  const stack: TsNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === "string" || current.type === "string_literal" || current.type === "encapsed_string") {
      out.push(unquote(current.text));
      continue;
    }
    stack.push(...current.namedChildren);
  }
  return out;
}

function collectImports(node: TsNode, imports: Set<string>): void {
  switch (node.type) {
    // ---- JS/TS：`import … from "x"` / `export … from "x"` / `require("x")`
    case "import_statement":
    case "export_statement": {
      const source = node.childForFieldName("source");
      if (source !== null) imports.add(unquote(source.text));
      return;
    }
    case "call_expression": {
      const fn = node.childForFieldName("function");
      if (fn?.text !== "require") return;
      const args = node.childForFieldName("arguments");
      const first = args?.namedChildren[0];
      if (first !== undefined && first.type === "string") imports.add(unquote(first.text));
      return;
    }
    // ---- Python：`import a.b` / `from .x import y`（相对层数在 relative_import 的文本里）
    case "import_statement":
    case "import_from_statement":
    case "future_import_statement": {
      const relative = node.namedChildren.find((child) => child.type === "relative_import");
      if (relative !== undefined) {
        imports.add(relative.text);
        return;
      }
      const module = node.childForFieldName("module_name") ?? node.namedChildren[0] ?? null;
      if (module !== null && (module.type === "dotted_name" || module.type === "identifier")) {
        imports.add(module.text);
      }
      return;
    }
    // ---- Go：`import "path"`（可能带别名）
    case "import_spec": {
      const spec = node.childForFieldName("path");
      if (spec !== null) imports.add(unquote(spec.text));
      return;
    }
    // ---- Rust：`use a::b::{c, d}`
    case "use_declaration": {
      const argument = node.namedChildren.find((child) => child.type !== "visibility_modifier");
      if (argument === undefined) return;
      for (const item of expandUseTree(argument.text.replace(/\s+/g, ""))) imports.add(item);
      return;
    }
    // ---- Java：`import a.b.C;`
    case "import_declaration": {
      const target = node.namedChildren.find(
        (child) => child.type === "scoped_identifier" || child.type === "identifier",
      );
      if (target !== undefined) imports.add(target.text);
      return;
    }
    // ---- Ruby：`require "x"` / `require_relative "x"` / `load "x"`
    case "call": {
      const method = node.childForFieldName("method");
      if (method === null || !["require", "require_relative", "load"].includes(method.text)) return;
      const args = node.childForFieldName("arguments");
      for (const literal of args === null ? [] : stringLiterals(args)) {
        if (literal !== "") imports.add(literal);
      }
      return;
    }
    // ---- PHP：include/require 的字符串片段
    case "include_expression":
    case "include_once_expression":
    case "require_expression":
    case "require_once_expression": {
      for (const literal of stringLiterals(node)) {
        if (literal !== "") imports.add(literal);
      }
      return;
    }
    // ---- PHP：`use A\B\C;`（也展开 `use A\{B, C};`）
    case "namespace_use_declaration": {
      const body = node.text
        .replace(/\s+/g, "")
        .replace(/^use(?:function|const)?/, "")
        .replace(/;$/, "")
        .replace(/^\\/, "");
      for (const item of expandPhpUse(body)) imports.add(item);
      return;
    }
    default:
      return;
  }
}

/** `a::b::{c, d}` → `a::b::c`、`a::b::d`；`a::b as c` → `a::b`。 */
function expandUseTree(text: string): string[] {
  const braces = /^(.*?)\{(.*)\}$/.exec(text);
  if (braces === null) return [text.replace(/as\w+$/, "")];
  const prefix = braces[1]!.replace(/::$/, "");
  return braces[2]!
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "" && item !== "self")
    .map((item) => `${prefix}::${item}`);
}

/** `A\B\{C, D}` → `A\B\C`、`A\B\D`。 */
function expandPhpUse(text: string): string[] {
  const braces = /^(.*?)\{(.*)\}$/.exec(text);
  if (braces === null) return [text];
  const prefix = braces[1]!;
  return braces[2]!
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => `${prefix}${item}`);
}

// ---------------------------------------------------------------- 边计算

export interface FileSymbols {
  path: string;
  symbols: readonly SymbolRecord[];
}

export interface FileCandidates {
  path: string;
  refs: FileRefs;
}

export interface RefEdge {
  fromPath: string;
  toPath: string;
  symbol: string;
  weight: number;
}

/** import 路径 → 目标文件。`createEdgeContext` 只需要这一个能力，所以它是一个窄口。 */
export interface ImportResolver {
  resolve(fromPath: string, spec: string): string | null;
}

/**
 * 算边需要的全部背景：文件集（import 解析） + 名字 → 定义它的文件。
 *
 * 【为什么要这个中间对象】全量重建与增量重建需要的是**同一套规则**，但输入不同：
 * 全量拿的是本次解析出来的全部符号，增量拿的是"上一版的符号 + 本次解析的符号"，
 * 而且只关心受影响的那几个名字。把"输入"与"规则"分成 `createEdgeContext` / `edgesFor`
 * 之后，增量就不会偷偷用一套简化过的规则（那正是"增量与全量不一致"这类 bug 的来源）。
 */
export interface EdgeContext extends ImportResolver {
  /** 名字 → 定义它的文件（去重、按加入顺序稳定）。 */
  definitions: Map<string, string[]>;
}

export function createEdgeContext(input: {
  /** 全量文件集（import 路径解析用；不在其中的路径一律认为解析失败）。 */
  files: readonly string[];
  /** 全量符号（不是增量时的"受影响符号"，是这一次索引里**全部**可用的定义）。 */
  symbols: readonly FileSymbols[];
}): EdgeContext {
  const definitions = new Map<string, string[]>();
  for (const file of input.symbols) {
    for (const symbol of file.symbols) {
      const list = definitions.get(symbol.name);
      if (list === undefined) definitions.set(symbol.name, [file.path]);
      else if (!list.includes(file.path)) list.push(file.path);
    }
  }
  return { resolve: createImportResolver(input.files).resolve, definitions };
}

/**
 * 这些候选在上下文里能算出哪些边。纯函数，确定性输出（先按 from/to/symbol 排序）。
 *
 * 【为什么按 `(from, to, symbol)` 去重取最大权重】`repo_refs` 的主键就是这个三元组：
 * 同一个名字在同一个文件里出现两次只会有一条候选（Set），但"import 一条路径"与
 * "调用一个同名函数"可能同时命中同一个目标文件——那时 import 的那一条更可信，取 2。
 */
export function edgesFor(candidates: readonly FileCandidates[], context: EdgeContext): RefEdge[] {
  const edges = new Map<string, RefEdge>();
  const add = (edge: RefEdge): void => {
    const key = `${edge.fromPath}\u0000${edge.toPath}\u0000${edge.symbol}`;
    const existing = edges.get(key);
    if (existing === undefined || edge.weight > existing.weight) edges.set(key, edge);
  };

  for (const file of candidates) {
    for (const name of file.refs.identifiers) {
      const targets = (context.definitions.get(name) ?? []).filter((target) => target !== file.path);
      if (targets.length === 0 || targets.length > MAX_DEFINITION_CANDIDATES) continue;
      const weight = targets.length === 1 ? SINGLE_DEFINITION_WEIGHT : 1 / targets.length;
      for (const target of targets) {
        add({ fromPath: file.path, toPath: target, symbol: name, weight });
      }
    }
    for (const spec of file.refs.imports) {
      const target = context.resolve(file.path, spec);
      if (target === null || target === file.path) continue;
      add({ fromPath: file.path, toPath: target, symbol: spec, weight: IMPORT_EDGE_WEIGHT });
    }
  }

  return [...edges.values()].sort((a, b) =>
    a.fromPath !== b.fromPath
      ? a.fromPath < b.fromPath
        ? -1
        : 1
      : a.toPath !== b.toPath
        ? a.toPath < b.toPath
          ? -1
          : 1
        : a.symbol < b.symbol
          ? -1
          : a.symbol > b.symbol
            ? 1
            : 0,
  );
}

/** 全量：候选 + 符号表 + 文件集 → 边。 */
export function computeEdges(input: {
  files: readonly string[];
  symbols: readonly FileSymbols[];
  candidates: readonly FileCandidates[];
}): RefEdge[] {
  return edgesFor(input.candidates, createEdgeContext({ files: input.files, symbols: input.symbols }));
}

// ---------------------------------------------------------------- import 路径解析

const TS_EXTENSIONS: Record<string, readonly string[]> = {
  typescript: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".jsx"],
  tsx: [".tsx", ".ts", ".d.ts", ".js", ".jsx"],
  javascript: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"],
};

/**
 * 建一个解析器：把"要查的东西"（按文件名、按目录）预先索引好，避免每条 import 都线性扫全仓库。
 *
 * 【为什么要有这个索引】一个 3k 文件的仓库有几千条 import；每条都 `[...fileSet].filter(...)`
 * 是 O(n²) 的量级，而索引只有 O(n × 目录深度)。
 */
export function createImportResolver(files: readonly string[]): ImportResolver {
  const fileSet = new Set(files);
  const byBasename = new Map<string, string[]>();
  const byDir = new Map<string, string[]>();
  /** 目录的每个后缀 → 拥有这个后缀的目录集合（Go 的包路径只有这一个是可查的）。 */
  const dirsBySuffix = new Map<string, string[]>();

  for (const file of [...files].sort()) {
    const base = path.posix.basename(file);
    const baseList = byBasename.get(base);
    if (baseList === undefined) byBasename.set(base, [file]);
    else baseList.push(file);

    const dir = path.posix.dirname(file);
    const dirList = byDir.get(dir);
    if (dirList === undefined) byDir.set(dir, [file]);
    else dirList.push(file);
  }
  for (const dir of [...byDir.keys()].sort()) {
    const segments = dir === "." ? [] : dir.split("/");
    for (let start = 0; start < Math.max(segments.length, 1); start += 1) {
      const suffix = segments.slice(start).join("/");
      if (suffix === "") continue;
      const list = dirsBySuffix.get(suffix);
      if (list === undefined) dirsBySuffix.set(suffix, [dir]);
      else list.push(dir);
    }
  }

  /** 唯一命中的文件：`null` 表示没有或多个（多个一律丢）。 */
  function unique(pattern: string): string | null {
    const base = pattern.slice(pattern.lastIndexOf("/") + 1);
    const matches = (byBasename.get(base) ?? []).filter(
      (file) => file === pattern || file.endsWith(`/${pattern}`),
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  /** Go：import 指向包（目录）。唯一命中那个目录时，取目录里排序最前的文件当代表。 */
  function packageFile(spec: string): string | null {
    const segments = spec.split("/").filter((segment) => segment !== "");
    for (let length = segments.length; length >= 1; length -= 1) {
      const suffix = segments.slice(-length).join("/");
      const dirs = dirsBySuffix.get(suffix) ?? [];
      if (dirs.length === 1) {
        const first = byDir.get(dirs[0]!)?.[0];
        return first ?? null;
      }
      if (dirs.length > 1) return null; // 同名包有多个 → 不猜
    }
    return null;
  }

  return {
    resolve(fromPath: string, spec: string): string | null {
      const lang = languageOfPath(fromPath);
      if (lang === null || spec === "") return null;
      const fromDir = path.posix.dirname(fromPath);

      // ① 显式候选：相对路径 + 扩展名补全。这些是**确定**的，命中就用。
      for (const candidate of explicitCandidates(lang, fromDir, spec)) {
        if (fileSet.has(candidate)) return candidate;
      }
      // ② 后缀唯一命中：语言自己的"模块根"（Python 的 src/、Java 的包、Go 的包目录）。
      if (lang === "go") return packageFile(spec);
      for (const pattern of suffixPatterns(lang, spec)) {
        const hit = unique(pattern);
        if (hit !== null) return hit;
      }
      return null;
    },
  };
}

function explicitCandidates(lang: LanguageId, fromDir: string, spec: string): string[] {
  const join = (base: string, relative: string): string => path.posix.normalize(path.posix.join(base, relative));

  if (lang === "python") {
    const dots = /^\.+/.exec(spec)?.[0] ?? "";
    if (dots !== "") {
      let base = fromDir;
      for (let i = 1; i < dots.length; i += 1) base = path.posix.dirname(base);
      const rest = spec.slice(dots.length).replace(/\./g, "/");
      if (rest === "" || rest === "/") return [`${base}/__init__.py`];
      return [`${base}/${rest}.py`, `${base}/${rest}/__init__.py`];
    }
    const asPath = spec.replace(/\./g, "/");
    return [`${asPath}.py`, `${asPath}/__init__.py`];
  }

  if (lang === "ruby") {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = join(fromDir, spec);
      return spec.endsWith(".rb") ? [target] : [`${target}.rb`];
    }
    return [];
  }

  if (lang === "php") {
    // `require __DIR__ . "/util.php"`：字面量是 `/util.php`，相对的是当前文件所在目录。
    const target = join(fromDir, spec);
    return spec.startsWith("/") || spec.startsWith("./") ? [target] : [];
  }

  if (lang === "typescript" || lang === "tsx" || lang === "javascript") {
    if (!(spec.startsWith("./") || spec.startsWith("../"))) return []; // 裸模块 = node_modules / 路径别名
    const base = join(fromDir, spec);
    const extensions = TS_EXTENSIONS[lang] ?? [];
    const out: string[] = [base];
    for (const extension of extensions) out.push(`${base}${extension}`);
    // TS 的 ESM 写法会写 `./x.js` 而真实文件是 `x.ts`：把 .js 换回 .ts/.tsx 再试一轮。
    const withoutJs = base.replace(/\.(js|mjs|cjs)$/, "");
    if (withoutJs !== base) {
      for (const extension of extensions) out.push(`${withoutJs}${extension}`);
      for (const extension of extensions) out.push(`${withoutJs}/index${extension}`);
    }
    for (const extension of extensions) out.push(`${base}/index${extension}`);
    return out;
  }

  if (lang === "rust") {
    const segments = spec.split("::").filter((segment) => segment !== "");
    let base: string;
    if (segments[0] === "crate") {
      segments.shift();
      base = "src";
    } else if (segments[0] === "self") {
      segments.shift();
      base = fromDir;
    } else if (segments[0] === "super") {
      base = fromDir;
      while (segments[0] === "super") {
        segments.shift();
        base = path.posix.dirname(base);
      }
    } else {
      // 2018 edition：`use foo::bar` 里的 foo 是 crate 内的顶层模块。
      base = "";
    }
    const out: string[] = [];
    // 从最长到最短：`crate::foo::bar` 先试 `src/foo/bar.rs`（bar 是模块），
    // 再退到 `src/foo.rs`（bar 是 foo 里的符号）——这正是 `use` 的两种常见形态。
    for (let length = segments.length; length >= 1; length -= 1) {
      const joined = [base, ...segments.slice(0, length)].filter((part) => part !== "").join("/");
      out.push(`${joined}.rs`, `${joined}/mod.rs`);
    }
    return out;
  }

  return [];
}

/** 后缀候选，按"越具体越先试"排序。 */
function suffixPatterns(lang: LanguageId, spec: string): string[] {
  switch (lang) {
    case "python": {
      const clean = spec.replace(/^\.+/, "");
      if (clean === "") return [];
      const asPath = clean.replace(/\./g, "/");
      return [`${asPath}.py`, `${asPath}/__init__.py`];
    }
    case "ruby": {
      const clean = spec.replace(/^\.\//, "");
      return [`${clean}.rb`, `lib/${clean}.rb`];
    }
    case "php": {
      const clean = spec.replace(/\\/g, "/").replace(/^\/+/, "");
      return [`${clean}.php`, `src/${clean}.php`];
    }
    case "java": {
      const clean = spec.replace(/\./g, "/");
      return [`${clean}.java`];
    }
    case "rust": {
      const segments = spec.split("::").filter((segment) => segment !== "");
      return [`${segments.join("/")}.rs`, `${segments.join("/")}/mod.rs`];
    }
    default:
      return [];
  }
}
