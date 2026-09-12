# TypeScript 速查（对着 sandbox-agent 读）

这份文档不是为了教你 TS，是为了**让你能读懂这个仓库的代码**。

如果你有 JS 基础，读完这份就能顺畅读 `packages/sandbox-agent/src/` 了。如果连 JS 也不太熟，先看 §0 和 §3.7、§3.12，其余遇到再查。

---

## 0. 最关键的一件事：类型在运行时**不存在**

TS 是 JS 加了一层"类型注解"。这层注解**只活在两个地方**：

1. 你写代码时的编辑器提示
2. `tsc` 类型检查时（这个仓库就是 `npm run typecheck`）

一旦运行起来，`node src/index.ts`，所有类型注解都被**擦掉**了——就像注释一样。所以：

```ts
const n: number = 1;
// 擦掉类型后 → const n = 1;
```

这带来两个直接后果，读完能省很多困惑：

- **代码跑得起来 ≠ 类型是对的。** `node src/index.ts` 能跑，但 `tsc` 可能报错。这个仓库的规矩是两者都要过。
- **类型不会帮你挡运行时的坏数据。** CP 发来的 JSON 里 `cmd` 是不是字符串数组，TS 完全不知道（它只看到 `unknown`）。所以要**手写校验**——这就是 `spawn.ts` 里那个又长又烦的 `validateExecRequest` 存在的全部原因。**它不是过度防御，它是唯一真实存在的防线。**

> 一句话：**类型是写给编译器和同事看的，校验才是写给运行时的。**

---

## 1. 三种最基本的形状

### 1.1 标注一个变量/参数/返回值

```ts
const port: number = 8080;
function delay(ms: number): Promise<void> { ... }
                 // ↑ 参数类型      ↑ 返回值类型
```

冒号后面就是类型。返回值写在参数括号后面。

### 1.2 `interface`：描述"一个对象长什么样"

```ts
export interface LogFileOptions {
  path: string;
  maxBytes: number;
  onError: (message: string) => void;
}
```

读法："LogFileOptions 类型的对象，必须有 path（字符串）、maxBytes（数字）、onError（一个接收字符串、不返回东西的函数）"。

本仓库里所有 `interface` 都是这个用途：**描述一个对象/配置/响应体有哪些字段**。

### 1.3 `type`：给"任何东西"起个别名，尤其是联合类型

```ts
export type TerminalStatus = "completed" | "failed" | "timeout" | "killed";
```

这行读作："TerminalStatus 这个类型，只能是这四个字符串之一"。

```ts
export type ValidationResult =
  | { ok: true; request: ValidatedExecRequest }
  | { ok: false; body: ErrorResponse };
```

这是"要么是左边那个形状，要么是右边那个形状"——TS 里最常见的**带错误的返回值**写法，见 §4。

> 记不清 `interface` 和 `type` 该用哪个？本仓库的惯例：
> **描述对象的字段用 `interface`，联合类型/别名用 `type`。** 就这么简单，不要纠结。

---

## 2. 卡住人的符号，速查表

读代码时看到这些符号，回这张表：

| 符号 | 名字 | 大白话 | 本仓库例子 |
|---|---|---|---|
| `x: string` | 类型标注 | x 是字符串 | `const port: number = 8080` |
| `x?: string` | 可选属性/参数 | 这个字段**可以没有** | `cwd?: string` |
| `readonly x` | 只读 | 建好之后不能再赋值 | `readonly id: string` |
| `A \| B` | 联合类型 | 要么 A 要么 B | `number \| null` |
| `"a" \| "b"` | 字面量联合 | 只能是这几个具体字符串 | `TerminalStatus` |
| `x!` | 非空断言 | "我保证它不是空" | `child.stdout!` |
| `x as T` | 类型断言 | "把它当成 T 来用" | `err as Error` |
| `unknown` | 未知 | 还不知道是什么，用之前必须判 | `validateExecRequest(raw: unknown)` |
| `any` | 随便 | 关掉类型检查，本仓库几乎不用 | 只在测试里 `data: any` |
| `x?.y` | 可选链 | x 是空就整个表达式是 undefined | `record.mergers?.out.flush()` |
| `x ?? y` | 空值合并 | x 是 null/undefined 就用 y | `child.pid ?? null` |
| `#foo` | 私有字段 | 只有类内部能访问（JS 语法） | `#subscribers` |
| `<T>` | 泛型 | 类型当参数传 | `Promise<void>`、`Set<Subscriber>` |
| `(a: string) => void` | 函数类型 | 参数是 string，不返回东西 | `onError: (message: string) => void` |
| `void f()` | 丢弃 Promise | "故意不等这个异步结果" | `void finalize(record, config)` |

下面逐个细讲，每个都用本仓库真实代码。

---

## 3. 逐个细讲

### 3.1 `?` —— "这个字段可以没有"

```ts
export interface ExecRequest {
  cmd: string[];        // 必须有
  cwd?: string;         // 可以没有 → 类型实际是 string | undefined
  timeoutMs?: number;   // 可以没有
}
```

`?` 只表示"允许不传"。**不表示不校验**——`validateExecRequest` 会给没传的字段补默认值。这是读这个仓库最容易误解的一点。

### 3.2 `readonly` —— 只在类型层面禁止赋值

```ts
export interface ExecutionRecord {
  readonly id: string;
  status: "running" | TerminalStatus;   // 这个可以被改（收尾时要改成终态）
}
```

`readonly` 是给写代码的人看的合同：`record.id = "x"` 会被 `tsc` 拦下来。运行时没有保护。

### 3.3 联合类型 `A | B` 与字面量联合

```ts
let status: "running" | "completed" | "failed" | "timeout" | "killed";
```

这比"用字符串"强在哪：写错一个字母、或者写了个不存在的状态，`tsc` 立刻报错。

```ts
export type KillResponse = {
  status: "killing" | TerminalStatus;
};
```

**字面量联合 + 对象形状 = "可辨识联合"**，见 §4。

### 3.4 `!` 非空断言 与 `as` 类型断言

这两兄弟都是**你对编译器说"相信我"**。

```ts
const stdout = child.stdout!;
```

`child.stdout` 的类型是 `Readable | null`（因为如果 spawn 时没指定 `pipe`，它就是 null）。但这里是写死了 `stdio: ["ignore","pipe","pipe"]` 的，所以运行时一定有值。`!` 就是"我知道它不是 null，别烦我"。

```ts
record.spawnError = { code: (error as NodeJS.ErrnoException).code, message: error.message };
```

`error` 是 `Error` 类型，而 `Error` 上没有 `code` 字段。但它其实是 Node 的 errno 错误（比如 ENOENT），确实带 `code`。`as NodeJS.ErrnoException` 就是"当成 errno 错误来读"。

```ts
const body = raw as Record<string, unknown>;
```

"把这个未知东西当成一个字典来读"。

> **什么时候可以放心用 `!` 和 `as`**：你手上有一条编译器不知道的运行期事实（"我明明写了 pipe"、"这是 Node 的 errno 错误"）。用错地方就是埋雷——`as` 不会做任何检查，它只是闭嘴。
>
> 注意本仓库的 `!`/`as` 都集中在校验完之后的代码里，且旁边都有注释说明"为什么我知道"。这是好习惯。

### 3.5 `unknown` vs `any`

```ts
export function validateExecRequest(raw: unknown, ...)
```

`unknown` = "我还不知道它是什么，所以用之前必须自己判断"。

```ts
if (typeof value !== "number" || !Number.isInteger(value)) {
  return invalid(...);   // 上面这个 if 一挡，下面 value 就被 TS 当成 number 了
}
```

这就是 §4 要讲的"控制流收窄"。

`any` = "关掉检查，随便用"。本仓库几乎不用 `any`（一搜只有测试里的 SSE `data: any`）。**看到 `unknown` 不要怕——它是在保护你；看到 `any` 要警惕。**

### 3.6 `?.` 可选链 与 `??` 空值合并

```ts
record.mergers?.out.flush();
// 等价于：if (record.mergers !== null) record.mergers.out.flush();
```

```ts
record.timers.timeout?.cancel();
// 等价于：if (record.timers.timeout !== undefined) record.timers.timeout.cancel();
```

```ts
record.pid = child.pid ?? null;
// 只有 child.pid 是 null / undefined 时才用 null
```

**`??` 和 `||` 的区别**（这个坑很常见）：`||` 把 `0`、`""`、`false` 也当作"空"。所以要写"默认值"时用 `??`：

```ts
const port = input ?? 8080;   // input 是 0 时保留 0
const port2 = input || 8080;  // input 是 0 时会变成 8080 ← 通常不是你想要的
```

### 3.7 `#` 私有字段（这是 JS 语法，不是 TS）

```ts
export class EventBus {
  #subscribers = new Set<Subscriber>();

  get subscriberCount(): number {
    return this.#subscribers.size;
  }
}
```

`#` 开头是**真私有**：类外面 `bus.#subscribers` 是语法错误，不是"约定不要访问"。

为什么这个仓库大量用它：类里那些状态（缓冲、定时器、序列号）只能由类自己改，外面必须走方法——这样"状态从哪被改的"永远只有一个答案。读代码时可以把 `#xxx` 当成"这个类的内部零件"。

> 注意本仓库**没有**用 TS 的 `private` 关键字（`private foo`），因为 `erasableSyntaxOnly` 模式下 `#` 是唯一能用的（见 §5）。

### 3.8 泛型 `<T>` 与内置工具类型

泛型就是"把类型当参数传"：

```ts
export class EventBus {
  #subscribers = new Set<Subscriber>();   // Set 里装的是 Subscriber
}
```

```ts
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
```

读法："你传进来的 Promise 里装的是什么类型，我返回的 Promise 里就装同样类型。"——`<T>` 只是个占位名，叫 `T` 是惯例。

本仓库用到的内置工具类型（TS 自带的，不用 import）：

| 写法 | 含义 | 本仓库例子 |
|---|---|---|
| `Record<string, string>` | "字符串键 → 字符串值"的字典 | `env: Record<string, string>` |
| `Partial<Config>` | Config 的所有字段都变成可选 | 测试的 `options.config` |
| `Omit<T, "onChunk">` | 和 T 一样，但去掉 `onChunk` | 测试的 `collector()` |
| `Promise<void>` | 一个将来会完成、但没有返回值的异步操作 | `async end(): Promise<void>` |
| `Set<Subscriber>` / `Map<string, ExecutionRecord>` | 集合 / 字典 | events.ts / registry.ts |

### 3.9 函数类型与回调

```ts
export interface OutputMergerOptions {
  onChunk: (text: string, bytes: number) => void;
}
```

读法："onChunk 是一个函数：收两个参数（string 和 number），不返回东西。"

调用时就把它当普通函数用：`this.#options.onChunk(text, bytes)`。这叫**回调**——合并器不认识"事件总线"，它只知道"攒够一块就交给这个函数"。

这就是这个仓库解耦的主要手法：`spawn.ts` 给 `OutputMerger` 传 `(text, bytes) => emitChunk(...)`，于是"切块"和"怎么发"互不知道对方。

### 3.10 类：getter / `static` / `private constructor`

```ts
get bytes(): number {
  return this.#bytes;
}
```

`get` = 读属性时自动执行函数：外面写 `log.bytes`，不用写 `log.bytes()`。

```ts
static async connect(url: string, token: string): Promise<SseClient> {
```

`static` = 挂在类上、不需要实例：`SseClient.connect(...)`，而不是 `new SseClient().connect(...)`。用来做"构造函数是异步的"这种活（构造函数不能 async，所以用 static 工厂方法绕开）。

```ts
private constructor(response: Response, controller: AbortController) { ... }
```

`private`（这里是 TS 的访问修饰符，可以用，因为它在**类型**层）表示"只能从类内部 `new`"——强制调用方走 `SseClient.connect()`。测试里的 `SseClient` 就是这个用法。

### 3.11 `catch (err)` 里的 err 为什么是 `unknown`

```ts
} catch (err) {
  record.spawnError = { message: (err as Error).message };
}
```

因为 JS 里 `throw` 可以扔**任何东西**（字符串、数字、对象）。TS 诚实地告诉你"我不知道你扔出来的是什么"，所以你必须先断言或者判断。

本仓库里更严谨的写法在 `index.ts`：

```ts
const message = err instanceof Error ? err.message : String(err);
```

`instanceof` 判断就是 §4 的收窄：判完之后 TS 才允许你读 `.message`。

### 3.12 import 的三种写法（这个仓库有硬约束）

```ts
import { spawn } from "node:child_process";            // ① 导入会执行的代码
import type { ChildProcess } from "node:child_process"; // ② 只导入类型
import { VERSION, type Config } from "./config.ts";     // ③ 两种混着写
```

- `import type` 表示"这个 import 只用于类型标注，运行时擦掉"。
- 这个仓库**必须**这么写（`verbatimModuleSyntax: true`），否则编译出来的 import 在运行时找不到东西会炸。
- **相对导入必须带 `.ts` 后缀**（`"./config.ts"` 而不是 `"./config"`）。这在普通 TS 项目里很少见，但 Node 24 直接跑 `.ts` 的规矩就是如此。

还有第三种写法里的 `type Config` —— 在一行 import 里给单个名字加 `type` 前缀。

---

## 4. TS 最像魔法的一块：它会读你的 `if`

TS 会跟着你的控制流走，自动"收窄"类型。这是读代码时最值的一个概念。

```ts
const validated = validateExecRequest(raw, this.#config, this.#roots);
if (!validated.ok) return { ok: false, status: 400, body: validated.body };

// 走到这里，TS 已经知道 validated.ok 是 true
// 所以下面的 validated.request 才合法：
const record = this.#createRecord(id, validated.request);
```

`ValidationResult` 是两个形状的联合（§1.3）。那个 `if` 之后，TS 把"左边的形状"从可能性里删掉了，所以能安全访问 `.request`。这叫**可辨识联合**——靠一个共同的字段（这里是 `ok`）来区分。

同一个魔法在别处的样子：

```ts
if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
  return invalid("invalid_timeout", "timeoutMs must be a positive integer");
}
if (value > MAX_TIMEOUT_MS) { ... }
timeoutMs = value;   // 到这里 value 已经被收窄成 number
```

```ts
if (execRoute !== null) {
  const id = execRoute[1]!;   // 判过不是 null，TS 才允许取下标
}
```

**读代码时的实用价值**：看到一个 `if (... ) return`，就知道它下面的代码是"已经排除了某种情况"的。很多 TS 代码看起来没有类型标注，就是因为前面几行已经收窄过了。

如果收窄不生效，就会出现奇怪的报错。这时一般是两种情况：漏了一个 `if`，或者判断条件不是 TS 能认出来的形式（比如把检查写在了另一个函数里）。

---

## 5. 为什么这个仓库不能用 `enum`、import 要写 `.ts`

来自 `tsconfig.base.json`：

```jsonc
{
  "strict": true,                // 严格模式：空值、隐式 any 全部报错
  "noEmit": true,                // tsc 只检查，不产出 JS
  "allowImportingTsExtensions": true,  // 允许（并要求）import 带 .ts
  "verbatimModuleSyntax": true,  // 类型导入必须写 import type
  "erasableSyntaxOnly": true     // ★ 只能用"能被擦掉"的语法
}
```

`erasableSyntaxOnly` 是关键：**只允许"擦掉类型就能跑"的语法**。因为 Node 24 是直接跑 `.ts` 的（类型擦除），根本没经过编译。所以：

| 不能用 | 因为 |
|---|---|
| `enum Color { Red }` | 擦不掉——它需要生成真的对象 |
| `namespace X {}` | 同上 |
| `constructor(private x: number)` | 参数属性会生成赋值代码 |
| 装饰器 `@foo` | 需要运行时支持 |

替代方案这个仓库都用了：

- 需要"枚举"？→ 字符串联合类型：`type TerminalStatus = "completed" | "failed" | ...`
- 需要常量？→ `export const VERSION = "0.0.1"`

**好处**（不只坏处）：镜像里没有构建步骤、没有 `node_modules`、没有打包器。`COPY src` 直接跑。代价就是上面这四条限制。

---

## 6. 自己验证：怎么用 `tsc` 抓错

```bash
cd /Users/reuben/Documents/cloud-digital-platform
npx tsc --noEmit          # 全仓库类型检查，无输出 = 通过
npm test -w @reuben-cloud/sandbox-agent   # 49 个测试
```

读报错的方法：

- **报错行号有时候不在你改的那一行**，而是"用错类型的地方"。TS 说"类型不匹配"时，往上找"这个值是哪来的"。
- `Object is possibly 'null' or 'undefined'` → 少了 `?.` 或者少了空值判断。
- `Argument of type 'X' is not assignable to parameter of type 'Y'` → 形状对不上，看 Y 需要什么字段。
- `Cannot find module './foo'` → 大概率是忘了写 `.ts` 后缀。
- 改完注释如果 `tsc` 报错了，说明你不小心动到了代码（注释本身不可能影响类型）。

---

## 7. 从 JS 到 TS：一张对照表

| 你熟悉的 JS | 这里的 TS 写法 | 意思 |
|---|---|---|
| `function f(a, b) {}` | `function f(a: string, b: number): void {}` | 参数和返回值都标上类型 |
| `const opts = {a: 1}` | `const opts: Options = {a: 1}` | 声明它符合某个形状 |
| `if (x)` | `if (x !== undefined)` | TS 更要求显式判空 |
| `x \|\| 0` | `x ?? 0` | 只想在 null/undefined 时兜底 |
| `obj && obj.f()` | `obj?.f()` | 更短的空值保护 |
| `/** 注释 */`（JSDoc） | 一样的写法 | 本仓库注释就是这个风格，只是 TS 会连带检查类型 |
| `throw new Error(...)` | 同上 | 但 catch 到的是 `unknown` |
| `class A { constructor() { this._x = 1 } }` | `class A { #x = 1 }` | 真私有字段 |

---

## 8. 建议的阅读顺序

1. 本文档 §0 + §2（十分钟，建立符号直觉）
2. `src/types.ts`（全是类型，没有任何逻辑，对照本文看一遍）
3. `src/ulid.ts`（40 行，纯函数，热身）
4. `src/paths.ts`（有类、有 if 收窄、有 `unknown` 参数）
5. `docs/exec-链路-大白话.md`（把链路搞清）
6. `src/exec/` 六个文件按 `output → logfile → timeout → events → registry → spawn` 的顺序读
7. `src/server.ts` → `src/config.ts` → `src/index.ts`
8. 想深入就去看 `test/`：`harness.ts` 是基础设施，`exec.test.ts` 是最直观的"链路说明书"
