# reuben-cloud · Agent 运行时实施 Spec（M2：环境与上下文）

> 版本 v1 · 2026-09-13
> 本文是 [`agent-runtime.md`](agent-runtime.md)（设计文档）的落地规格：**每个 Phase 的交付物 /
> 具体如何实现 / 技术边界 / 测试要点 / 验收标准**。
>
> **两份冲突时以设计文档为准。** 但附录 A 列出的偏差是**有意的**（实施过程中发现"文档这么写、
> 但这样做更好"时，改代码的同时必须在这里记一条），改回去之前先读每条的理由。
>
> **与 pi 的关系**：Agent Runtime 的契约以 `/Users/reuben/Documents/pi` 为参考实现。文件级对应表见附录 B。
> 参考的是**契约与取舍**，不是照抄规模——不搬的部分在设计文档 §B.7 列了理由。

---

## 0. 全局约定

### 0.1 命名

| 类别 | 规则 | 例子 |
|---|---|---|
| 数据库表 | 小写 + 下划线，见名知义；不加前缀（已有 `sandboxes` 风格） | `session_entries` / `repo_symbols` |
| 主键 | `<前缀>_<ulid>`（与既有 `sbx_`/`exe_`/`art_` 一致，时间有序） | `ses_`（会话）/ `run_`（一次执行）/ `ent_` / `inv_` / `usg_` / `req_` / `env_` / `bld_` / `mcp_` |
| 迁移文件 | `三位序号_名字.sql`，只增不改（已执行的迁移永不编辑） | `005_agent_runtime.sql` |
| TS 文件 | 全小写 + 连字符；一个文件一个主要导出 | `agent-loop.ts` / `cut-point.ts` |
| 事件类型 | 小写 + 下划线（对齐 pi） | `tool_execution_start` / `message_update` |
| 环境变量 | `REUBEN_CLOUD_*`；工具内部约定用 `REUBEN_CLOUD_AGENT_*` | `REUBEN_CLOUD_COMPACTION_KEEP_TOKENS` |
| 包 | `@reuben-cloud/<name>`，与既有 workspace 一致 | `@reuben-cloud/agent-runtime` |

**ID 为什么继续用 ULID 而不是 pi 的 UUIDv7**：既有三张表全是 ULID，M2 换 ID 方案只会让对账脚本要同时认两种；
ULID 同样是"时间有序 + 全局唯一"，满足 pi 对 id 的两条实际需求（可排序、可作恢复身份）。

### 0.2 依赖策略（每引入一个都要写理由与替代方案）

| 依赖 | 版本 | 用在哪 | 为什么 | 替代方案（不选的理由） |
|---|---|---|---|---|
| `typebox` | `1.3.27`（与 pi 同版本） | 工具参数 schema | 一份声明同时给 TS 类型 / JSON Schema / 运行时校验 | 手写 JSON Schema（M0 现状：两处会漂）；zod（转 JSON Schema 要额外适配层，且 pi 不用） |
| `web-tree-sitter` | 最新稳定（pin 到 minor） | 符号索引（**control-plane 侧**，不在 agent-runtime） | 纯 WASM，安装零编译，跨平台/CI 稳 | 原生 `tree-sitter` 绑定（node-gyp + 平台预编译，装不上就是全盘阻塞；速度优势用预算兜住） |
| `tree-sitter-{ts,tsx,js,python,go,rust,java,ruby,php}` 的 `.wasm` | vendored | 同上 | 语言语法文件是**数据**，不该在运行时下载 | npm 包（版本漂移 + 安装期网络依赖）；运行时下载（让"能不能建索引"依赖网络） |
| `@modelcontextprotocol/sdk` | 最新稳定（pin） | MCP 客户端 | 官方 SDK，stdio + streamable HTTP 都覆盖 | 手写 JSON-RPC（协议面大、易错，且没有收益） |
| `@anthropic-ai/sdk` | 已有 | 模型调用 | 已有 | — |

**明确不引入**：`zod`、`pgvector` 客户端（M2 不做向量；见设计文档 §H）、`dockerode`（M0 已决定用 HTTP API）、
`langchain` / `llamaindex` 类框架（README §4 已说明：循环自己写，保持每一步可见）、
`tree-sitter` 原生绑定（见上）。

### 0.3 语言与运行时硬约束

- Node **>= 24**（与 M0 一致；`node --test` + 直接跑 `.ts`）。
- **`erasableSyntaxOnly`**：所有能在容器/宿主直接 `node xxx.ts` 跑的代码不得使用需要编译的语法
  （enum、namespace、参数属性、装饰器）。沙箱镜像里没有构建步骤，M0 的 `sandbox-agent` 就是这么跑的。
- **`packages/agent-runtime` 不允许 import `pg` / `octokit` / `@aws-sdk/*`**：它是纯决策层。
  存储用接口注入（`SessionStore`），容器与宿主的实现分别在 CP 侧。这条**要有测试兜住**
  （一个读 import 图的单测），否则三个月后它会悄悄变成第二个 CP。
- 类型检查：`npm run typecheck`（根目录聚合）。测试：`node --test`。没有 lint 工具的强制要求
  （M0 的约定是"类型 + 单测"），但新增文件要过 `tsc --noEmit`。

### 0.4 目标目录结构

```
packages/agent-runtime/                  ← M2 新增（纯决策层，无 pg/octokit/s3）
├── package.json                         # dependencies: typebox（web-tree-sitter 在 control-plane 侧，见下）
├── src/
│   ├── types.ts                         # AgentMessage / AgentTool / AgentEvent / AgentContext / Config
│   ├── event-stream.ts                  # EventStream<AgentEvent, AgentMessage[]>（约 60 行）
│   ├── loop.ts                          # agentLoop / agentLoopContinue（对齐 pi 的 agent-loop.ts）
│   ├── limits.ts                        # 默认预算策略（40 轮 / 30min / 300k 输出 token）
│   ├── model/
│   │   ├── client.ts                    # ModelClient（Anthropic + DeepSeek，从 CP agent/model.ts 迁移）
│   │   ├── catalog.ts                   # 模型目录：contextWindow / maxTokens / cost（编译与压缩要用）
│   │   └── retry.ts                     # 限流/超时退避（M0 已有逻辑搬过来）
│   ├── session/
│   │   ├── store.ts                     # SessionStore 接口（append/list/usage/invocations）
│   │   ├── memory.ts                    # 单测用实现
│   │   ├── entries.ts                   # entry 构造与投影（buildContextEntries 等价物）
│   │   └── export.ts                    # JSONL 导出（兼容 M0 观察窗与人工排查）
│   ├── compaction/
│   │   ├── tokens.ts                    # estimateTokens / estimateContextTokens / shouldCompact
│   │   ├── cut.ts                       # findValidCutPoints / findCutPoint（含 split turn）
│   │   ├── summarize.ts                 # 结构化摘要 + 累积文件清单
│   │   └── index.ts                     # prepareCompaction / compact / 触发策略
│   ├── context/
│   │   ├── sections.ts                  # 分区定义与预算
│   │   ├── compiler.ts                  # compile() → CompiledContext
│   │   └── hash.ts                      # 确定性哈希
│   ├── tools/
│   │   ├── truncate.ts                  # 行/字节双上限（对齐 pi 的 truncate.ts）
│   │   ├── edit.ts / read.ts / write.ts / ls.ts / bash.ts   # Operations 注入
│   │   ├── grep.ts / find.ts
│   │   └── index.ts                     # 内置工具装配
│   ├── registry/
│   │   ├── registry.ts                  # ToolRegistry（register/select/resolve/snapshot）
│   │   └── meta.ts                      # ToolMeta（category/risk/approval/budget）
│   ├── skills/
│   │   ├── discover.ts / format.ts / types.ts
│   ├── mcp/
│   │   ├── client.ts / config.ts / source.ts / health.ts
│   └── prompt/
│       ├── system.ts                    # 分区组装（角色 / 工具 / 技能 / 地图 / 沙箱事实）
│       └── task.ts                      # 任务书
└── test/                                # 纯单测（不需要 docker / PG / 网络）

packages/control-plane/src/
├── session/                             # SessionStore 的 Postgres 实现（pg 只在这里）
│   ├── postgres.ts
│   └── requests.ts                      # model_requests 落库（内联 or 对象存储）
├── environment/                         # 环境构建（Phase 5-7）
│   ├── base-images.ts / types.ts / signals.ts / devcontainer.ts / infer.ts
│   ├── store.ts                         # environments 表的读写（P7 的 revision.ts 接着长）
│   ├── generate.ts                      # LLM 生成 Dockerfile
│   ├── build.ts                         # docker build 调用 + 日志 + 错误分类
│   ├── queue.ts                         # 构建队列：并发 1、按 project_key 去重、带 trigger
│   ├── cache.ts / revision.ts / health.ts
├── session/                             # 会话与沙箱租约（Phase 2）
│   ├── postgres.ts                      # SessionStore 的 PG 实现（pg 只在这里）
│   ├── requests.ts                      # model_requests 落库（内联 or 对象存储）
│   └── sandbox-lease.ts                 # 会话级沙箱：按需建 / 热着复用 / 空闲回收 / 回收前落地
├── index/                               # 仓库索引（Phase 8-9）
│   ├── worker.ts                        # 子进程隔离（WASM 崩了不影响 CP）
│   ├── parse.ts / symbols.ts / refs.ts
│   ├── rank.ts / render.ts / personalize.ts
│   └── store.ts
└── db/migrations/005_*.sql … 013_*.sql

images/base/                             # Layer 1 基础镜像矩阵（Phase 5）
├── Dockerfile.common
└── Dockerfile.{node-dev,python-dev,go-dev,rust-dev,fullstack,ubuntu-dev}

vendor/tree-sitter/*.wasm                # 固定版本 + 记录 sha256（Phase 8）
```

**为什么索引与环境构建放 CP 侧而不是 agent-runtime**：两者都要碰外部资源（文件系统、docker、
对象存储），而 agent-runtime 的硬约束是"纯决策层"。这个切分同时也是**依赖方向**：
`CP → agent-runtime`，不允许反向。

### 0.5 测试策略

沿用 M0 的四层，**不新建概念**：

| 层 | 命令 | 允许依赖 | 覆盖什么 |
|---|---|---|---|
| 单测 | `npm test` | 无（docker / PG / 网络都不能有） | 循环、工具、压缩切点、编译确定性、Registry |
| 集成 | `npm run test:integration` | docker + PG + MinIO（一次性容器） | 环境构建、索引、会话存储、迁移 |
| 真模型 | `npm run test:live` | 真模型 key | 一个真实任务端到端（手工跑，不进 CI） |
| 冒烟/红线 | `npm run smoke` + CI | Linux docker | M0 的隔离红线（M2 不许让它变红） |

**新增的两类 fixture**（M0 只有"临时仓库"）：

1. `packages/control-plane/test/fixtures/repos/` —— 三个小仓库（node-ts 单包 / python / monorepo-with-devcontainer），
   每个 < 50 个文件，进 git，用于环境推断、索引、地图的金标准断言；
2. `packages/control-plane/test/fixtures/dockerfiles/` —— 人为错误的 Dockerfile（缺依赖 / 错基础镜像 / 语法错），
   用于自愈循环的假 builder 测试。

### 0.6 Phase 总览

| # | Phase | 部分 | 依赖 | 人日 | 交付后可验证的事 |
|---|---|---|---|---|---|
| P1 | 运行时契约与包拆分 | Runtime | — | 3–4 | `agent:run` 行为不变，但循环/工具/提示词独立成包 |
| P2 | 会话持久化 + **沙箱租约**（会话长期 / 按需建 / 热着复用 / 空闲回收） | Runtime | P1 | 6–7 | 20 句讨论 0 个容器；干活后同一会话只建 1 个；同一会话能连续两句 |
| P3 | compaction | Runtime | P2 | 3–4 | 超长会话自动压缩并继续 |
| P4 | 事件统一 | Runtime | P3 | 1–2 | 一条事件流；观察窗加上下文面板 |
| P5 | 环境定义与推断 | Env | — | 4–5 | 三个 fixture 仓库各命中一级推断 |
| P6 | LLM 生成 + 自愈 | Env | P5 | 3–4 | 人为缺依赖的仓库能自愈成功 |
| P7 | 缓存/版本/健康 | Env | P6 | 4–5 | 二次构建 < 10s；健康三态可见 |
| P8 | 符号索引 | Index | P5 | 4–6 | 中位仓库 < 60s 建出符号表 |
| P9 | Repo Map | Index | P8 | 3–4 | 首轮上下文里有仓库骨架 |
| P10 | ContextCompiler | Index | P3,P9 | 4–5 | 分区预算 + 缓存前缀 + 可回放 |
| P11 | Registry + 7 工具 | Tools | P1 | 3–4 | `edit`/`grep`/`find` 可用，bash 改 shell 字符串 |
| P12 | Skills | Tools | P11 | 2–3 | 仓库自带技能被模型加载 |
| P13 | MCP | Tools | P11 | 3–5 | 外部 server 的 2/5 个工具可用 |

> **向量索引（原 P11）已移出 M2**：它没有需求驱动、也没有评估集（设计文档 §H）。
> 真出现"符号与全文搜不到、只能靠语义"的实测案例，再单独立项。

```
P1 ─► P2 ─► P3 ─► P4          P5 ─► P6 ─► P7
              │                    │
              └──────► P10 ◄───────┘
                        ▲
              P8 ─► P9 ──┘
P11（P1 之后任意时刻）──► P12 ──► P13
```

**关键路径 = P1 → P2 → P3 → P5 → P8 → P9 → P10**。P11–P13（工具面）与 P5–P7（环境）可以交错，
不需要等关键路径。

---

# 第一部分 · Agent Runtime（对齐 pi）

> 这一部分**会动 M0 已经跑通的代码**，风险集中在这里。三条自我约束：
> ① 每个 Phase 结束时 `npm test` + `npm run typecheck` 必须全绿，`agent:run` 端到端必须仍能产出 patch；
> ② 新旧行为不一致的地方，**要么是设计文档里写明的偏差，要么是新行为的测试更有说服力**——
> 不做"顺手改改"；
> ③ 迁移过程中保留一个兼容层（`runAgentLoop` 的旧签名），全部 Phase 结束后再删。

## Phase 1 · 运行时契约与包拆分

### 交付物

- `packages/agent-runtime/`（新 workspace，`package.json` / `tsconfig.json` / `src/{types,event-stream,loop,limits}.ts`）
- `src/model/{client,catalog,retry}.ts`（从 `packages/control-plane/src/agent/model.ts` 迁出）
- `src/tools/{truncate,index}.ts` + `read/write/ls/bash` 的 Operations 化改造
- `src/prompt/{system,task}.ts`（从 `agent/prompt.ts` 迁出并改成分区组装）
- CP 侧：`packages/control-plane/src/agent/` 只保留编排（`run.ts`/`events.ts`/`transcript.ts`），
  其余改为从 `@reuben-cloud/agent-runtime` 引入；`scripts/agent-run.ts` 改 import
- CP 侧两个入口：`handleUserMessage(sessionId, text)`（用户发来一句话）与
  `steer(runId, message)`（一句还在处理中，用户插话）——见设计文档 §A.1

### 具体如何实现

**1. `types.ts` —— 契约（照 pi 的形状写，字段名不改）**

```ts
export type AgentMessage =
  | { role: "user"; content: string | Content[] }
  | { role: "assistant"; content: Content[]; stopReason?: StopReason; usage?: Usage }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: Content[];
      details?: unknown; isError: boolean; timestamp: number }
  | { role: "compactionSummary"; summary: string; firstKeptEntryId: string; tokensBefore: number }
  | { role: "custom"; customType: string; content: string; display: boolean }

export interface AgentTool<TParams extends TSchema = TSchema, TDetails = unknown> {
  name: string; label: string; description: string;
  parameters: TParams;                                   // TypeBox → JSON Schema
  prepareArguments?(args: unknown): unknown;             // provider 参数怪癖兜底
  execute(id: string, params: Static<TParams>, signal?: AbortSignal,
          onUpdate?: (partial: AgentToolResult<TDetails>) => void): Promise<AgentToolResult<TDetails>>;
  replay?: "never" | "safe";
  executionMode?: "sequential" | "parallel";
}

export interface AgentContext { systemPrompt: string; messages: AgentMessage[]; tools?: AgentTool[] }

export type AgentEvent =
  | { type: "agent_start" } | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" } | { type: "turn_end"; message: AgentMessage; toolResults: AgentMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantStreamEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "context_compiled"; turn: number; sections: SectionStat[]; hash: string }
  | { type: "compaction"; reason: "threshold" | "overflow" | "manual"; tokensBefore: number; firstKeptEntryId: string }
  | { type: "note"; kind: string; message: string }      // 重复调用提示 / 上下文告警等旁路信息
```

**2. `loop.ts` —— 双层循环（逐条对齐 pi 的 `agent-loop.ts`）**

```
runLoop:
  内层 while (hasMoreToolCalls || pendingMessages.length > 0):
    ① 若上一轮完成且存在 prepareNextTurn → 跑它（压缩、换模型、重编译）
       跑完后**再取一次** steering（因为压缩可能耗时，用户可能刚插话）
    ② 注入 pendingMessages（每条发 message_start + message_end，push 进 context）
    ③ 流式取 assistant 响应：transformContext → convertToLlm → streamFn
       - start / text_delta / toolcall_delta … 转成 message_update 事件
       - 结束（done/error）→ 定稿 message，push 进 context
    ④ 若 stopReason ∈ {error, aborted} → turn_end + agent_end，返回
    ⑤ 收集 tool calls；stopReason === "length" → 全部回失败（不执行）
       否则按 executionMode 并行或串行执行（结果按**源码顺序**拼装）
    ⑥ 结果 push 进 context 与 newMessages → turn_end
    ⑦ shouldStopAfterTurn? → 停
    ⑧ pendingMessages = getSteeringMessages?.()
  外层：没有更多工具调用时取 getFollowUpMessages?.()，有就继续内层
```

**3. 预算从循环搬进钩子（`limits.ts`）**

`maxTurns=40` / `wallClockMs=30min` / `outputTokenBudget=300k` 三个默认值保留，实现改为一个
**默认 `shouldStopAfterTurn` 策略函数**：

```ts
export function defaultStopPolicy(limits: Limits): (ctx: ShouldStopAfterTurnContext) => boolean
```

理由：数值是可迭代资产（不同任务类型该有不同上限），而循环结构不该为此改动。M3 的配额系统
就是替换这个策略函数，不是改 loop。

**4. 事件流（`event-stream.ts`）**

自己写一个小 `EventStream<TEvent, TResult>`（约 60 行）：`push()` / `end()` / `[Symbol.asyncIterator]()` /
`result(): Promise<TResult>`。不引 pi-ai（我们在 CP 侧，不需要它的 provider 层）。

**5. 工具的 Operations 化**

```ts
// 每个工具一个窄 port，由 CP 注入（对齐 pi 的 BashOperations / ReadOperations）
export interface BashOperations {
  exec(command: string, cwd: string,
       options: { onData(data: Buffer): void; signal?: AbortSignal; timeoutMs?: number; env?: Record<string,string> }):
    Promise<{ exitCode: number | null }>
}
export interface FileOperations {
  read(p, opts): Promise<{ content: string; totalLines: number; bytes: number }>
  write(p, content, opts): Promise<void>
  list(p, opts): Promise<...>
  stat(p): Promise<...>                  // edit 要用（mtime/大小做乐观并发）
  runExclusive<T>(path: string, fn: () => Promise<T>): Promise<T>   // 文件写入队列（P11 用）
}
```

**6. ModelClient 抽取 + 模型目录**

`catalog.ts` 是 M2 新增的关键小文件：压缩与上下文编译需要 `contextWindow` 与 `maxTokens`。

```ts
export const MODEL_CATALOG: Record<string, { contextWindow: number; maxTokens: number; cost?: ModelCost }> = {
  "claude-opus-4-8": { contextWindow: 200_000, maxTokens: 64_000 },
  "deepseek-flash":  { contextWindow: 128_000, maxTokens: 8_192 },
  // 未知模型 → 保守默认 { contextWindow: 128_000, maxTokens: 16_000 }，并打一条 warn
}
```

**7. 兼容层**

`packages/control-plane/src/agent/run.ts` 的 `runAgentLoop(options)` 签名保持不变（这是 M0 的
集成测试与 `agent-run` 脚本的入口），内部改为构造 `AgentLoopConfig` 调新循环。兼容层只做参数翻译，
不复制逻辑；P4 结束后删除。

**8. Run 与 Session 的两个入口（多轮对话的接线点）**

```
handleUserMessage(sessionId, text)        // 用户发来一句话
  → 抢会话锁（P2 落地：sessions.active_run_id）
  → appendEntry(user message, parent = 当前 leaf)
  → 返回一个 runId；跑循环。**沙箱不在这里建**——第一次要用工具时才建（P2 §6）
  → 锁在 P1 先用内存实现（单进程），P2 换成 PG 条件更新

steer(runId, message)                     // 一句还在处理中，用户插话
  → 队列入 AgentLoopConfig.getSteeringMessages
  → 不新开执行、不中断当前工具
```

**这两个入口的分工必须在 P1 就定下**：它们是"多轮对话"与"中途插话"两个不同场景的接口，
合起一个就会退化成"每句话都开新一轮"（历史与成本都会失控）。

### 技术边界

- **不搬** pi 的 harness（operation 状态机 / lanes / forks / navigation / inbox / RPC / 三后端）；
- 不引入 provider 插件框架（两家 provider 用 `selectProvider()` 就够，出现第三家再说）；
- 不搬 pi 的 `Extension` 插件系统（我们的扩展点是 Skill 与 MCP，两者都是标准协议）；
- 循环不得 import 任何 CP 模块（依赖方向单向）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 事件序列快照（脚本化模型：两轮工具 + 收工） | 事件类型与顺序完全匹配（含 `message_update` 增量） |
| 2 | 一条响应里 3 个 tool call | 并行执行、结果按源码顺序、同一条消息 |
| 3 | `stopReason === "length"` 且带 tool call | 一个工具都不执行，全部回 `isError` 且文案含"重发" |
| 4 | 工具抛异常 | 变 `isError` 结果，不中断循环 |
| 5 | `executionMode: sequential` 与 `parallel` 混用 | 有 sequential 时整批串行（对齐 pi 的判定） |
| 6 | steering：工具执行中 `steer("换个思路")` | 在**这一轮工具跑完后、下一轮模型调用前**注入 |
| 7 | follow-up：agent 要收工时队列里有消息 | 不结束，继续下一轮 |
| 8 | `abort` | 当轮工具收到 signal；循环以 `aborted` 结束；事件齐全 |
| 9 | `shouldStopAfterTurn` 在第 3 轮返回 true | `run_end` 的停止原因注明是策略停的（不是模型收工） |
| 10 | 重复调用检测（M0 的能力，挂在 `beforeToolCall`） | 第 3 次注入提示，第 4 次停止 |
| 11 | prefix 稳定性 | 同一输入两次构造的 system 字节相同 |
| 12 | 依赖方向 | 读 import 图断言 agent-runtime 不含 pg/octokit/@aws-sdk |
| 13 | `handleUserMessage` 与 `steer` 的分工 | 空闲时来的消息开一次新执行；一句进行中来的消息注入当前执行（不新开）；两者都不主动建沙箱 |

### 验收标准

- `npm test` / `npm run typecheck` 全绿；`agent:run --local <repo> --issue ...` 仍产出 patch；
- `packages/agent-runtime/test/` 新增 ≥ 16 个用例（上表全部）；
- `git grep` 确认 `control-plane/src/agent/` 里不再有循环与工具实现（只剩编排与兼容层）。

---

## Phase 2 · 会话持久化

### 交付物

- `packages/control-plane/src/db/migrations/005_agent_runtime.sql`
- `packages/agent-runtime/src/session/{store,memory,entries,export}.ts`
- `packages/control-plane/src/session/postgres.ts`（`SessionStore` 的 PG 实现）
- `packages/control-plane/src/session/sandbox-lease.ts`（会话级沙箱：按需建 / 热着复用 / 空闲回收 / 回收前落地）
- `packages/control-plane/src/session/requests.ts`（`model_requests`：内联 or 对象存储）
- 接线：`run.ts` 在会话开始时创建/读取 session，每句写 entry/usage，工具调用写 intent/settlement；
  一份 `handleUserMessage` 编排（抢锁 → 读历史 → 按需建沙箱 → 跑 → 释放锁）

### 具体如何实现

**1. 迁移（005）**

> **这一节是 v1.1 改过的重点**：会话（长期）与 Run（一次执行）是**两张表**。
> v1 草案把它们合成一张 `run_sessions`，后果是"用户回第二句话就开了一个新会话"。

```sql
-- 会话：长期实体，跨 Run 存活。用户的对话历史（entries）挂在它下面。
CREATE TABLE sessions (
  id            text PRIMARY KEY,               -- ses_<ulid>
  task_id       text,                           -- 可空：tasks 表是 M3（与 sandboxes 同一约定）
  repo_key      text NOT NULL,                  -- owner/name，不含凭据
  base_commit   text NOT NULL,                  -- 会话开始时的 commit
  head_ref      text,                           -- 会话当前的工作分支（reuben-cloud/<task>）
  head_commit   text,                           -- 当前分支的 head（下一轮的仓库起点）
  cwd           text NOT NULL,                  -- 沙箱内的仓库根
  title         text,                           -- 给 UI 用的一句话（第一轮后生成，可空）
  leaf_entry_id text,                           -- 当前 leaf；下一句从这里往后接
  sandbox_id    text,                           -- 当前热着的沙箱（可空：还没干活）
  sandbox_last_used_at timestamptz,             -- 最后一次用到沙箱的时间（空闲回收用）
  active_run_id text,                           -- 正在跑的执行；不为空 = 本会话忙（并发保护）
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- M0 的 sandboxes 表加一列：沙箱归属**会话**（不是归属某一次执行）。
-- 只需 ALTER（既有行 session_id 为 NULL，对账逻辑一字不改）。
ALTER TABLE sandboxes ADD COLUMN session_id text;
CREATE INDEX sandboxes_session_idx ON sandboxes (session_id, last_active_at DESC);

-- Run：一次执行（一个沙箱）。干完就结束；用户回话是新的 Run。
CREATE TABLE runs (
  id             text PRIMARY KEY,              -- run_<ulid>
  session_id     text NOT NULL REFERENCES sessions (id),
  sandbox_id     text,                          -- 可空：创建前；M0 的 sandboxes 表已能按它反查
  start_entry_id text,                          -- 这一轮从哪条 entry 之后开始
  end_entry_id   text,                          -- 结束时 leaf 在哪（下一轮的起点）
  provider       text NOT NULL, model text NOT NULL,
  env_revision   text,                          -- 用了哪个环境版本（Phase 7）
  status         text NOT NULL,                 -- running | stopped | failed
  stop_reason    text,                          -- 与 AgentStopReason 同一套取值
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,
  CONSTRAINT runs_status_check CHECK (status IN ('running','stopped','failed'))
);
CREATE INDEX runs_session_idx ON runs (session_id, started_at DESC);

-- 对话树：挂在会话上（**不是挂在 Run 上**）。只追加。
CREATE TABLE session_entries (
  id         text PRIMARY KEY,                 -- ent_<ulid>
  session_id text NOT NULL REFERENCES sessions (id),
  run_id     text,                             -- 哪一次执行写的（压缩/自定义条目可空）
  parent_id  text,                             -- 直线；结构上支持分叉（M3）
  seq        bigserial NOT NULL,               -- 全局单调（排序与分页用）
  type       text NOT NULL,
  payload    jsonb NOT NULL,                   -- AgentMessage 或压缩条目
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_entries_type_check CHECK (type IN ('message','compaction','custom'))
);
CREATE INDEX session_entries_session_idx ON session_entries (session_id, seq);

-- 工具调用：意图 → 结算。
CREATE TABLE tool_invocations (
  id              text PRIMARY KEY,            -- inv_<ulid>
  session_id      text NOT NULL REFERENCES sessions (id),
  run_id          text NOT NULL,
  turn            integer NOT NULL,            -- 本次执行内的模型往返序号
  source_index    integer NOT NULL,            -- 在 assistant 消息里的位置（顺序恢复要用）
  tool            text NOT NULL,
  args            jsonb NOT NULL,
  replay          text NOT NULL DEFAULT 'never',
  status          text NOT NULL,                -- intent | settled | interrupted
  result_entry_id text,                         -- 预留的结果 entry id（结算时用同一个）
  is_error        boolean,
  result_bytes    integer,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  CONSTRAINT tool_invocations_status_check CHECK (status IN ('intent','settled','interrupted'))
);
CREATE INDEX tool_invocations_run_idx ON tool_invocations (run_id, turn, source_index);

-- 用量账本：只追加。主调用 / 压缩摘要 / 环境自愈 / 技能分析全在这里。
CREATE TABLE usage_ledger (
  id                text PRIMARY KEY,          -- usg_<ulid>
  session_id        text,                      -- 环境自愈可能没有 session
  run_id            text,
  kind              text NOT NULL,             -- main | compaction | env_build | embedding
  provider          text NOT NULL, model text NOT NULL,
  input_tokens      bigint NOT NULL DEFAULT 0,
  output_tokens     bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  cost_usd          numeric(12,6),             -- 账本允许为空（未知模型）
  entry_id          text,                      -- 对应的 entry（可空）
  at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_session_idx ON usage_ledger (session_id, at);
CREATE INDEX usage_ledger_run_idx ON usage_ledger (run_id, at);

-- 每轮模型调用看到的编译产物（可回放）。
CREATE TABLE model_requests (
  id            text PRIMARY KEY,              -- req_<ulid>
  session_id    text NOT NULL REFERENCES sessions (id),
  run_id        text NOT NULL,
  turn          integer NOT NULL,
  compiled_hash text NOT NULL,
  sections      jsonb NOT NULL,                -- [{name, tokens, hash}]
  system        text NOT NULL,
  tools_hash    text NOT NULL,
  usage_id      text,
  inline_messages jsonb,                       -- ≤ 256 KiB 内联
  object_key    text,                          -- 超出部分落对象存储
  bytes         integer NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_requests_run_idx ON model_requests (run_id, turn);
```

**`seq` 为什么用 `bigserial` 而不是"会话内自增"**：全局单调即可满足排序与分页（pi 的 seq 也是
storage-assigned 全局序号）。会话内顺序用 `(session_id, seq)` 表达，不需要额外的计数列——
少一个需要事务保护的计数器，就少一类并发 bug。

**2. `SessionStore` 接口（agent-runtime 只认这个）**

```ts
export interface SessionStore {
  // 会话（长期）
  createSession(input: NewSession): Promise<SessionRef>       // 建会话（第一轮之前）
  getSession(sessionId: string): Promise<StoredSession | null>  // 含 leaf_entry_id / head_ref / head_commit
  updateSessionHead(sessionId: string, patch: { leafEntryId?: string; headRef?: string; headCommit?: string; title?: string }): Promise<void>
  listSessions(opts?: { limit?: number; cursor?: string }): Promise<StoredSession[]>   // UI 的会话列表

  // 对话树（挂在会话上，只追加）
  appendEntry(sessionId: string, runId: string | null, entry: NewEntry, opts?: { usage?: UsageRow }): Promise<string>  // 一个事务
  listEntries(sessionId: string, opts?: { limit?: number; afterSeq?: number; beforeSeq?: number }): Promise<StoredEntry[]>

  // Run（一次执行）
  startRun(input: NewRun): Promise<string>                    // 记录 start_entry_id
  endRun(runId: string, patch: { status: RunStatus; stopReason: string; endEntryId: string; sandboxId?: string }): Promise<void>
  listRuns(sessionId: string): Promise<StoredRun[]>

  // 工具调用 / 用量 / 编译产物
  beginToolInvocation(inv: NewInvocation): Promise<string>    // intent，一个事务
  settleToolInvocation(id: string, result: { entry: NewEntry; isError: boolean; bytes: number }): Promise<void>
  recordUsage(row: UsageRow): Promise<void>
  recordRequest(row: NewRequest): Promise<void>
  listInvocations(runId: string, status?: InvocationStatus): Promise<StoredInvocation[]>
}
```

`memory.ts` 是同一接口的内存实现，**两个实现跑同一套契约测试**（对齐 M0 对状态机双实现的做法）。

**3. 事务边界**

- **`appendEntry` + `usage` 必须一个事务**（pi 的规则：entry 与用量同生共死）；
- `beginToolInvocation` 与 `settleToolInvocation` 各自一个事务；
- 任何"读改写"（比如 endSession）用单条 SQL 表达，不用"先查后写"。

**4. `model_requests` 的落盘规则**

```
serialized_messages ≤ 256 KiB  →  inline_messages（jsonb）
否则                            →  对象存储 key = requests/{session_id}/{turn}.json.gz
```

`compiled_hash` = sha256(sections 的 hash 列表 + system + tools_hash + messages 序列化)。**相同输入必须
得到相同 hash**——它是"上下文是否真的稳定"的唯一客观证据（也是缓存命中分析的基础）。

**5. 续轮（多轮对话的数据面）**

```
handleUserMessage(sessionId, text):
  ① 抢会话锁：UPDATE sessions SET active_run_id = $runId
       WHERE id = $sessionId AND active_run_id IS NULL
       （抢不到 → 明确拒绝 "session_busy"，**不排队**：排队是 M3）
  ② session = getSession()；appendEntry(user message, parent = leaf_entry_id)
  ③ 重建上下文：listEntries(sessionId) → buildContextEntries（含压缩摘要）
  ④ 跑循环。沙箱**不在这里建**——第一次真的要用工具时才 acquireSandbox()（见 §6）
  ⑤ 结束时 endRun({ end_entry_id, stop_reason })；updateSessionHead(leaf_entry_id)
  ⑥ 释放会话锁：active_run_id = NULL
```

**三条容易写错的点**：

1. **沙箱不在这一步建**：模型可能整句都在说话（讨论、解释），一个容器都不该建。
   建沙箱的时机是"第一次要读/写/跑命令"，实现上就是 `acquireSandbox()`（§6）。
2. **没有改动的一句也要更新 leaf**：用户可能只是问"这段代码干嘛的"，那一句没有任何文件改动，
   但历史必须接得上（下一句要能看到这句的回答）。
3. **`head_commit` 只在"冷启动重建沙箱"时用**：沙箱热着时改动就在工作区里，不需要推也不需要拉。

**6. 沙箱租约（会话级：按需建、热着复用、空闲回收）**

> 这是 v1.2 改过的地方：沙箱**不是**"一次执行一个"。用户可能先讨论二十句需求
> （一个容器都不该建），然后才开工。沙箱是**会话的工作区**。

```
acquireSandbox(sessionId):                     // 工具层第一次要用沙箱时调它
  ① session.sandbox_id 有值，且沙箱状态 ∈ {READY,BUSY} 且未过空闲 TTL
        → touchSession()；直接返回（热着复用，不重建）
  ② 否则（没有，或已冷）：
        a. 旧沙箱存在 → flush(session)（取 diff → apply → push）→ destroy
        b. provider.create()：image = 当前 env revision 的 digest；
           仓库起点 = session.head_commit ?? session.base_commit
        c. UPDATE sessions SET sandbox_id, sandbox_last_used_at = now()
  ③ 返回 SandboxTarget（工具层拿到的东西与 M0 完全一样）

reapIdleSessions(now):                         // 扩展现有 manager/sweeper.ts
  for session where sandbox_id is not null:
      if sessions.active_run_id is not null → continue       // 正在处理一句话：绝不回收
      if sandbox 有 in-flight execution     → continue       // 正在跑命令：绝不回收
      if now() - sandbox_last_used_at > IDLE_TTL
            → reap(session, reason='idle')                   // 真闲着：flush + destroy
      else if now() - sandbox.created_at > MAX_LIFETIME
            → rotate(session, reason='max_lifetime')         // 换容器，不是砍任务

// reap 与 rotate 的动作一样（flush → destroy），区别只在原因与后续：
//   reap：下次要用时重建；rotate：立即重建（或懒到下一次工具调用再建，两者都可，后者更省）
// flush 在两种情况下都不推：没有改动（diff 为空）
```

**三条硬规则**：

1. **一个会话同时只有一次执行在跑**：靠 `sessions.active_run_id` 的条件更新抢锁（不用 advisory lock，
   因为它是事务级的，而一次执行跨很多事务）。抢不到就拒，明确错误码 `session_busy`。
2. **空闲 TTL 从“最后一次活动”算起，而且续时是自动的**：用户发言、每次模型调用、每次工具调用
   （含沙箱文件 API）都会 `touchSession()` 把 `sandbox_last_used_at` 推到当前时间。默认 30 分钟
   （env 可配），但**只在真的闲着时才计时**：正在处理一句话、或沙箱里有在跑的命令，到点也只续时，
   绝不回收。一句话跑了 50 分钟不会被砍——期间每次工具调用都在续时。
3. **回收前必须落地**：`flush()` 失败（推送失败/网络）→ **不销毁沙箱**，标 `flush_failed`，
   下个周期重试；连续 3 次仍失败 → 按 M0 Phase 10 的兜底落 archive 到对象存储再销毁。
4. **容器总寿命（6h）到点是“换容器”，不是“砍任务”**：先等当前活动结束（在跑的 exec 最多
   再等它自己的 600s 超时）→ flush → destroy → 下一次工具调用自动建新沙箱。用户只会看到
   “下一句慢一点”。唯一的例外是真卡死：超过总寿命再加 30 分钟宽限仍无任何活动结束 → 强制回收
   （这条是给跑飞的进程准备的，不是常规路径）。

**为什么不用"一句一沙箱 + 每句推送"**（v1 草案）：讨论型的一句也要建沙箱、装依赖、推 Git；
十句就是十次 clone + 十次 push。它把"每句都付固定成本"当成了常态。

**7. JSONL 降级为导出格式**

`session/export.ts` 提供 `exportSession(store, sessionId)`（**整个会话，跨 Run**）→ 与 M0 的
`transcript.jsonl` **逐字段兼容**（`run_start`/`request`/`response`/`tool_call`/`note`/`run_end`），
每条前面加一行 `{"type":"run","runId":…}` 作为轮次分隔。`agent:run` 增加 `--export <path>`，
`--keep` 时自动导出。观察窗（P4 之前）继续读内存缓冲，不受影响。

### 技术边界

- **不做恢复**：`status='intent'` 的孤儿只在 M3 处理；M2 只保证它们**可见**；
- **不做调度**：会话与执行可以连续起，但没有队列、优先级、并发限制与触发器；
  同一会话并发第二次请求是**直接拒绝**，不是排队（M3）；
- **不做沙箱预热池 / 跨会话复用 / 快照挂起**：M2 的复用范围只在"同一个会话热着的时候"；
- 不做 `values/lists` 表（没有消费者：session 名、队列都不是持久状态）；
- entries 不可修改、不可删除（M4 的合规删除不在范围内）；
- 不在 `session_entries.payload` 里存二进制（图片等大对象走对象存储，payload 存引用）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 内存 vs Postgres 契约测试 | 同一串操作在两边产生相同的可观察结果（对齐 M0 的双实现做法） |
| 2 | append + usage 同事务 | 注入一个 usage 写入失败 → entry 也不存在 |
| 3 | 并发 append | 两个并发 append 的 seq 都唯一且单调（无重复、无空洞也可接受） |
| 4 | kill -9 集成测试 | 在工具执行中途杀 CP 进程 → 重启后该 invocation 是 `intent`，且能查到 args |
| 5 | 大 payload 分界 | 257 KiB 的 messages → 落对象存储；`bytes` 与实际一致 |
| 6 | 导出兼容 | 10 个真实 Run 的导出通过 M0 JSONL 的 schema 断言（字段名一致） |
| 7 | 压缩条目 | `type='compaction'` 的 payload 有 `firstKeptEntryId` / `tokensBefore` / `details` |
| 8 | 迁移可重跑 | `db:migrate` 两次幂等（沿用 M0 的迁移测试） |
| 9 | 续轮上下文 | 第 1 句结束后发第 2 句 → 第 2 句的 messages 里含第 1 句的 entries（结构化断言） |
| 10 | 纯讨论不建沙箱 | 20 句只用文字的会话 → `sandboxes` 表**零行** |
| 11 | 沙箱复用 | 同一会话连续 5 次工具调用 → `provider.create` 只被调用 **1** 次 |
| 12 | 空闲回收 | 拨快时钟 → 回收：有改动则推分支 + 销毁 + `sessions.sandbox_id = null` |
| 13 | 回收后重建 | 回收后下一次工具调用 → 新建 1 个，仓库起点 = 任务分支 head（不是 `base_commit`） |
| 14 | 并发保护 | 同一会话两个 `handleUserMessage` 并发 → 第二个明确被拒（`session_busy`） |
| 15 | 落地失败不丢数据 | 注入 push 失败 → 沙箱**不**被销毁、状态 `flush_failed`；重试成功后销毁 |
| 16 | 硬崩 | 直接删容器 → `ERROR(container_lost)`；会话保留，下一句能重建沙箱 |
| 17 | 轮次标记 | `listRuns(sessionId)` 返回两句；每句的 `start_entry_id`/`end_entry_id` 能把 entries 切成两段而不重叠 |
| 18 | 续时（空闲 TTL 从最后一次活动算） | 会话每 25 分钟发一句话、连续 3 次 → 沙箱**不**被回收（`provider.create` 仍为 1 次） |
| 19 | 干活中不回收 | 拨快时钟穿过 IDLE_TTL，同时有一次长 exec 在跑 → 沙箱**不**被销毁；exec 结束后才进入回收 |
| 20 | 总寿命到点换容器 | 拨快时钟到 6h；当前 exec 结束后 flush + destroy；下一次工具调用新建 1 个，会话继续（历史不断） |

### 验收标准

- 一次真实 Run（`agent:run --local … --pr`）之后，`sessions` / `runs` / `session_entries` / `usage_ledger` /
  `tool_invocations` / `model_requests` 六张表都有正确数据；
- **20 句纯讨论 → 0 个容器；干活后同一会话连续多句 → 只有 1 个容器**（`sandboxes` 一行）；
- 空闲回收后回来 → 1 个新容器，工作区接得上（从任务分支，不是从原始 base commit）；
- 同一会话并发第二个请求被明确拒绝（不是静默串行、也不是两句话混进一个工作区）；
- 导出 JSONL（跨句）能被现有观察窗与人工排查流程直接使用；
- kill -9 集成测试进 `test:integration` 且通过。

---

## Phase 3 · compaction

### 交付物

- `packages/agent-runtime/src/compaction/{tokens,cut,summarize,index}.ts`
- 摘要 prompt 模板 `src/compaction/summary-prompt.ts`
- 配置项（env）：`REUBEN_CLOUD_COMPACTION_ENABLED`（默认 on）/ `_RESERVE_TOKENS`（16384）/
  `_KEEP_TOKENS`（20000）/ `_SUMMARY_MODEL`（默认同主模型）
- 接线：`prepareNextTurn` 钩子 + 溢出恢复 + `--compact` 手动触发

> **实现备注**：P3 落地时有 7 条有意偏差，逐条记在附录 A-11 … A-17——循环契约的三个
> 新增（`compaction` / `stop` / `recoverFromModelError`）、溢出恢复按**新的一轮**记账、摘要序列化
> 再加一道总长闸、投影里只留最新一份摘要、M0 的 600k 裁剪随本 Phase 删除、摘要请求的缓存开关
> （`cache: "none"`）、`compaction_failed` 用"与停止原因同名的 note"传到 Run 终态。

### 具体如何实现

**1. 估算（`tokens.ts`，逐条对齐 pi）**

```
estimateContextTokens(messages):
  lastUsage = 从后往前第一条 assistant 的 usage
  若没有 → 全部用 estimateTokens 求和
  若有   → calculateContextTokens(lastUsage)（input + output + cacheRead + cacheWrite）
           + lastUsage 之后每条消息的 estimateTokens
estimateTokens(message) = ceil(chars / 4)
  user/toolResult: content 的字符数
  assistant: text + thinking + (toolCall.name + JSON.stringify(args))
  compactionSummary/自定义: summary 字符数
shouldCompact(tokens, window, settings) = enabled && tokens > window - reserveTokens
```

**为什么用 `chars/4` 而不是 tokenizer**：跨 provider（Anthropic / DeepSeek）的 tokenizer 不同，
装两套 tokenizer 的复杂度换来的精度提升，远不如"以真实 usage 为基线 + 只有尾部用估算"来得实在。
pi 的选择也是这个。

**2. 切点（`cut.ts`）**

```
findValidCutPoints(entries, start, end):
  可用切点 = user / assistant / custom（**绝不含 toolResult**）
  另外：compaction 条目之后到它 firstKeptEntryId 之间的条目不可作为切点起点

findCutPoint(entries, start, end, keepRecentTokens):
  从 end-1 往回累加 estimateTokens，首次 ≥ keepRecentTokens 时停下
  取"≥ 当前下标的最小可用切点"
  再往回吃掉相邻的**不影响上下文的元数据条目**（对齐 pi）
  判定 splitTurn：切点不是 turn 起点，且能找到它所属的 user 消息
```

**split turn 的语义**（必须写进测试）：一个 turn 本身就超过 `keepRecentTokens` 时，切在 turn 中间：

```
usr | ass(tool) | tool | ass | tool  ← 一个超长 turn
      └──── turnPrefixMessages ────┘ └── kept ──┘
      生成"turn prefix 摘要" 与"历史摘要"合并成一条 CompactionEntry
```

**3. 结构化摘要（`summarize.ts`）**

```
serializeConversation(messages)  —— 工具结果截断到 2000 字符（**否则摘要请求自己会超窗**）
  [User]: ...
  [Assistant thinking]: ...
  [Assistant]: ...
  [Assistant tool calls]: read(path="…"); edit(path="…", …)
  [Tool result]: ...（截断标记）

generateSummary(messagesToSummarize, previousSummary?, settings):
  系统提示 = 摘要模板（Goal/Constraints/Progress/Key Decisions/Next Steps/Critical Context）
  用户输入 = 序列化后的对话 + 上一份摘要（迭代更新用）
  输出 = { text, usage }   ← usage 必须返回并写入账本
```

**文件清单累积**：`extractFileOperations(messagesToSummarize, previousDetails)` → 合并去重
`{readFiles, modifiedFiles}`。`read` 工具调用的路径进 readFiles，`edit`/`write` 进 modifiedFiles。
**这个清单要放进 CompactionEntry.details**，下一次压缩继续累积（否则"改过哪些文件"会随压缩丢失）。

**4. 触发与挂载（`index.ts`）**

```
prepareNextTurn（每轮结束、下一轮开始前）：
  tokens = estimateContextTokens(currentContext.messages)
  if shouldCompact(tokens, model.contextWindow, settings):
      prep = prepareCompaction(buildContextEntries(entries), settings)
      if prep: result = await compact(prep, …)
              → store.appendEntry({type:'compaction', payload:{summary, firstKeptEntryId,
                                 tokensBefore: prep.tokensBefore, usage, details:{fileOps}}})
              → currentContext.messages = rebuild(messages, compactionEntry)
              → emit({type:'compaction', …})
溢出恢复：provider 报"context length exceeded" → 强制 compact 一次 → 重试本轮（**只重试一次**）
手动：CLI `--compact` 在指定轮后强制压缩（测试与调试用）
```

**5. `convertToLlm` 的渲染**

`compactionSummary` → 一条 user 消息，前缀明确：

```
[以下是本次任务到此为止的进度摘要，不是新的指令]
<摘要正文>
[摘要结束。继续完成任务。]
```

**为什么这一点不能省**：模型把摘要当新指令理解会导致"重新开始做已经做完的事"——压缩后跑偏最常见的
原因就在这一层。

### 技术边界

- **不删 entries**：压缩只改变"送去模型的投影"；
- **不做驱逐**（设计文档 §E.1）：唯一自动缩减机制是 compaction；
- 不做 branch summary（M3 的会话分叉才有消费者）；
- 摘要模型默认与主模型相同；换便宜模型是配置，不是默认（摘要质量直接影响后续所有轮次）；
- 连续两次都压不出结果（比如单条消息就超窗）→ 结构化失败：`compaction_failed`，终止 Run 并如实报告
  （不进入"压缩 → 还想压 → 再压缩"的死循环）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 切点：普通多轮 | 切在 turn 边界，tool_result 不在摘要区间 |
| 2 | 切点：tool_result 紧跟 tool_use | 不切在 tool_result 上 |
| 3 | 切点：split turn | `isSplitTurn=true`，两段摘要合并，`firstKeptEntryId` 正确 |
| 4 | 连续压缩 | 第二次的边界起点 = 上一次 `firstKeptEntryId`（不是压缩条目本身） |
| 5 | 文件清单累积 | 两次压缩后 modifiedFiles 含第一次的条目 |
| 6 | 估算误差 | 20 条真实 usage 的估算 vs 实际，误差 < 15% |
| 7 | 溢出恢复 | 假 provider 先报超窗、压缩后成功 → 不重复压缩第二次 |
| 8 | 摘要失败 | 假 provider 报错 → Run 以 `compaction_failed` 停止，不重试 |
| 9 | 压缩后继续 | 压缩后的下一轮请求里含摘要消息 + `firstKeptEntryId` 之后的消息 |
| 10 | usage 记账 | 摘要调用的 usage 进 `usage_ledger`（kind='compaction'），且**不写 prompt cache** |
| 11 | 摘要请求不超窗 | 100 条含 200 KB 工具结果的对话 → 序列化后 < 预留预算 |

### 验收标准

- 构造一个 > 模型窗口的会话（脚本化模型 + 大工具结果），Run 能自动压缩并**继续到结束**；
- `usage_ledger` 里能看到 `compaction` 行；
- 压缩前后的上下文都能从 `model_requests` + entries 复原。

---

## Phase 4 · 事件统一

### 交付物

- `packages/agent-runtime/src/types.ts` 的 `AgentEvent` 成为**唯一**事件协议
- CP `src/agent/events.ts` 改为"AgentEvent → SSE 帧"的映射器；删除 `RunEvent` 的工具/消息类成员
  （只保留 `run_start` / `run_end` / `run_error` 三个 Run 生命周期事件）
- `packages/web/public/app.js` 增加事件分支与**上下文面板**（sections 占比 + 压缩标记）
- 迁移 M0 Phase 13 的"每个事件类型都有前端分支"单测到新协议

> **实现备注**：P4 落地时有 6 条有意偏差，逐条记在附录 A-18 … A-23——SSE 帧多了
> `event:` 通道名（唯一映射表是 `events.ts` 的 `sseFrameOf`，`switch` + `never` 兜底）；
> `SessionStore` 多一个 `getRun`（`/runs/{id}/transcript` 要从 run 反查会话）；`run_start`
> 多一个 `sessionId`（页面靠它读会话视图）；沙箱命令输出成独立的一小族 `ExecEvent`；
> 每个 Run 的 JSONL transcript **保留**（观察窗不再读它）；上下文面板的"是否命中压缩"
> 由 `compaction` 事件点亮（P10 的 `context_compiled` 里没有这个字段）。
>
> 两件本轮没有做的事，写在这里免得被当成漏了：① `context_compiled` 现在**没有任何生产者**
> ——面板是壳、DOM 单测喂合成事件，数据由 P10 的 ContextCompiler 接上（spec P10 的原文就是
> "P4 已建壳，本 Phase 填数据"）；② 不做"选轮次看当时上下文"的重放 UI（M3 的可观测性）。
>
> **验证**：`npm test` 495 项（agent-runtime 124 / control-plane 244 / sandbox-agent 101 /
> web 26）与 `npm run typecheck` 全绿；`npm run test:integration` 107 项里 106 绿、0 红
> （1 条是早就有的、需要真 key 的 live 开关用例）。与 P4 直接相关的两条端到端：
> `web-stream` 在真容器上跑完一次 Run 并读真 HTTP 的 SSE（命名通道、完整事件序列、
> `Last-Event-ID` 重连），同一文件里新增的一条用真 PG 验会话视图与 `/runs/{id}/transcript`；
> `session-run.test.ts` 里还有一条把**产品路径**（会话编排 → hub）与两个读接口连起来跑的用例。
> `web/` 的 26 条盖住了 M0 Phase 13 的 19 条原用例（表格见 `docs/sandbox-spec.md` Phase 13）。

### 具体如何实现

1. **映射表**（唯一允许出现"事件名映射"的地方）：
| 事件 | SSE `event:` | 前端行为 |
|---|---|---|
| `run_start` / `run_end` / `run_error` | `run` | Run 卡片与终态 |
| `agent_start` / `agent_end` | `agent` | 状态行 |
| `turn_start` / `turn_end` | `turn` | 轮次计数 |
| `message_start/update/end` | `message` | 打字机、工具调用卡片 |
| `tool_execution_*` | `tool` | 卡片状态更新 |
| `context_compiled` | `context` | 上下文面板数据 |
| `compaction` | `compaction` | 插入一条"已压缩"分隔线（含 tokensBefore） |
| `note` | `note` | 旁路提示 |
| （沙箱 exec 事件） | `exec` | 命令输出着色 |

2. **`exhaustive check`**：映射器写 `switch` + `never` 兜底，TS 编译期就能发现"新增事件没映射"。
   前端仍保留运行时断言（M0 的做法），因为 app.js 是纯 JS。

3. **transcript 从 entries 派生**：`GET /sessions/{id}/entries`（整个会话，跨 Run）与
   `GET /runs/{id}/transcript`（本次执行）都读 `session_entries`（P2 的表）而不是内存 JSONL；
   观察窗默认显示**会话视图**，用 `runs.start_entry_id` 标出每一轮的边界。
   SSE 的**实时**部分仍走内存缓冲（观察窗的环形缓冲不变）。

4. **上下文面板**：显示每个分区的 token 数与占比、`compiled_hash` 前 8 位、是否命中压缩。
   这是 M2 唯一新增的 UI 区块（其余 UI 在 P7/P13 各自加）。

### 技术边界

- 前端仍然**零构建、零外链、零字体**（M0 的契约不变）；
- 不做完整重放 UI（选轮次、看当时上下文）——那是 M3 的可观测性；
- SSE 协议向后兼容：老客户端不认识的事件忽略即可（`event:` 名变了，但 EventSource 只分发已监听的）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 事件 → SSE 映射 | 每个 AgentEvent 有分支（编译期 switch + 运行时表） |
| 2 | 前端分支覆盖 | 每个 SSE 事件名在 app.js 里有处理（迁移 M0 的单测） |
| 3 | 重连不重不漏 | `Last-Event-ID` 重放（沿用 M0 的集成测试，改协议后仍通过） |
| 4 | 上下文面板 | 渲染出一个带 sections 的 JSON → 断言页面结构（DOM 单测） |
| 5 | 未知事件 | 注入一个假事件类型 → 页面不白屏、不抛异常 |

### 验收标准

- 一个 Run 的全部可观测信息只从 `AgentEvent` 派生（`git grep` 确认没有第二套事件类型）；
- M0 Phase 13 的全部单测（19 个）迁移后仍绿；
- 观察窗打开后能看到上下文面板与压缩标记。

---

# 第二部分 · Environment（环境构建）

> 这一部分的验收口径（设计文档 §C.1）：**不是"支持 N 种语言"，而是"给任意仓库，10 分钟内得到
> `ready` 或明确 `degraded/failed`，并给出原因"**。failed 是合法结果。

## Phase 5 · Environment 定义与推断

### 交付物

- `packages/control-plane/src/db/migrations/006_environments.sql`
- `packages/control-plane/src/environment/{types,signals,devcontainer,infer}.ts`
- `images/base/Dockerfile.common` + 六个语言镜像（`Dockerfile.{node-dev,python-dev,go-dev,rust-dev,fullstack,ubuntu-dev}`）
- `images/sandbox/Dockerfile` 改为 `FROM reuben-cloud/base-<x>`（保留一层薄封装）
- fixture 仓库三个（`test/fixtures/repos/`）

> **实现备注**：P5 落地时有 7 条有意偏差，逐条记在附录 A-24 … A-30——devcontainer 的 `image` 与
> 仓库 Dockerfile 的 FROM **只当语言信号**，生成的 Dockerfile 的 FROM 永远是 Layer 1（A-24）；
> environment 目录多 `base-images.ts` 与 `store.ts` 两个文件，`RepoSignals` 多一个 `scripts`、
> `EnvironmentCandidate` 多一个 `baseImageKind`（A-25）；`go-dev` 不装 gopls（A-26）；"无 root"
> 实现成"默认非 root + 每个 `USER root` 后面都切回"（A-27）；devcontainer.json 走自带的容错
> JSONC 解析（A-28）；CI 与 compose 只做**行级扫描**、不引 YAML 库（A-29）；默认沙箱镜像的底座是
> `fullstack`、构建入口从一条 `docker build` 换成 `scripts/build-images.ts`（A-30）。
>
> **验证**：`npm test` 558 项全绿（agent-runtime 124 / control-plane 307 / sandbox-agent 101 /
> web 26）；`npm run typecheck` 全绿；`node scripts/build-images.ts` 真建出七个镜像（common →
> python-dev → fullstack → sandbox-base + node-dev + ubuntu-dev，首次约 5 分钟，之后走层缓存）；
> `npm run test:integration` 的 `environment.integration.test.ts` 把三个 fixture 生成的 Dockerfile
> **真的 build 成功**，并断言环境镜像继承了 Layer 1 的 `CMD` 与 `1000:1000`；`environments` 表的
> 真 PG 往返（jsonb / revision 单调 / 三个 CHECK）也在同一个文件里。
>
> 本轮**没有做**的两件事，写在这里免得被当成漏了：① 没有 `env:infer` 之类的 CLI——推断这条路径
> 现在只有测试在跑，运维入口留给 P6/P7（它们才有"构建一个环境"这件事可做）；② `environments`
> 表没有 `image_digest` / `cache_key` / `parent_revision` / `health*`（spec P7 明确把"剩余字段"
> 留给了 P7，现在建就只会多一批永远是 NULL 的列）。

### 具体如何实现

**1. 类型（`types.ts`）**

```ts
export type EnvKind = "base" | "project"
export type EnvStatus = "draft" | "building" | "ready" | "degraded" | "failed"
export type InferenceLevel = "devcontainer" | "dockerfile" | "signals"

export interface RepoSignals {                    // 采集结果（可序列化、可缓存、可测试）
  languages: string[]                             // 按文件数与"是不是入口"排序
  packageManagers: string[]                       // npm / pnpm / yarn / uv / poetry / pip / cargo / go
  runtimeVersions: Record<string, string>         // node: 20 / python: 3.11 / go: 1.22
  hasDockerfile: boolean; hasCompose: boolean; hasDevcontainer: boolean
  lockfiles: string[]; ciCommands: string[]; makeTargets: string[]
  services: string[]                              // 从 compose 里读出来的 postgres/redis/…
  monorepo: boolean
  ignored: Array<{ source: string; field: string; reason: string }>   // 显式记录忽略了什么
}

export interface EnvironmentCandidate {
  level: InferenceLevel
  baseImage: string                               // Layer 1 的镜像引用
  dockerfile: string                              // 完整 Dockerfile 文本（可复现）
  buildCommands: string[]                         // 建议的构建命令（健康检查用）
  verifyCommands: string[]                        // 建议的验证命令（给 agent 的提示）
  degradedRisks: string[]                         // 例如 "compose 依赖 postgres：集成测试需 degraded"
  notes: string[]                                 // 忽略的字段、降级说明
}
```

**2. 信号采集（`signals.ts`）**

- 输入是 CP 侧的 **clone 目录**（不碰沙箱）；只读文件，不执行任何东西；
- 采集清单按设计文档 §C.3 的表，每项一个纯函数（`readPackageManager(clone)` 等），**每个函数一份单测**；
- 结果可序列化 → 进 `environments.signals`（jsonb），是缓存键的输入（§C.5 的规范化在这里做：
  排序键、去注释、去时间戳）。

**3. devcontainer 解析（`devcontainer.ts`）**

支持字段：`image`、`build.{dockerfile,context,args}`、`features`（仅 common 类）、`containerEnv`、
`postCreateCommand`、`mounts`（**忽略**，为了隔离）、`forwardPorts`（忽略）。其余字段进 `ignored[]` 并带原因。
`features` 的实现方式：在生成的 Dockerfile 里加一段固定模板的 `RUN`（只支持官方 registry 里的
common 类，映射表写死在代码里——不引入 devcontainer CLI，那是另一个产品）。

**4. 三级判定（`infer.ts`）**

```
hasDevcontainer && 可解析  →  level="devcontainer"
hasDockerfile||hasCompose  →  level="dockerfile"（叠加 agent 必需组件）
否则                        →  level="signals"（本地规则；P6 接 LLM 生成）
```

**5. Layer 1 镜像矩阵**

`Dockerfile.common` 抽自现有 `images/sandbox/Dockerfile` 的"非语言"部分：
`git ca-certificates curl tar gzip procps` + `sandbox-agent` 源码 + uid 1000 相关（`/workspace`、`/tmp`、
`HOME`，chown）+ 环境变量（`LANG`、`PYTHONUNBUFFERED`、`SANDBOX_AGENT_*`）。语言镜像只加语言工具链。

**为什么必须拆**：现在这个镜像装了 node + python + build-essential（约 1.2 GB）。M2 之后每个语言镜像
只装自己的东西，冷启动与磁盘都受益；而 `ubuntu-dev` 保留"什么都没装"的兜底。

**6. fixture 仓库**

| fixture | 特征 | 期望命中 |
|---|---|---|
| `node-ts-basic` | `package-lock.json`、`Makefile`、无 Dockerfile | `signals`（node-dev） |
| `python-poetry` | `pyproject.toml` + `poetry.lock`、`Dockerfile` | `dockerfile` |
| `monorepo-devcontainer` | `packages/*`、`pnpm-lock.yaml`、`.devcontainer/devcontainer.json`、`compose.yaml` | `devcontainer` + `degradedRisks` 含 postgres |

### 技术边界

- 不支持 `devcontainer` 全量规范（健康检查/生命周期脚本/自定义 feature 都不做），忽略的字段必须显式记录；
- 不做 monorepo 的多项目拆分（M2 一个仓库一个环境），`monorepo: true` 只影响基础镜像与构建命令的推断；
- 不在构建或推断阶段注入任何凭据；
- 不做"环境矩阵"（多个可选环境给用户挑）——M2 一个仓库一个当前 revision。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 三个 fixture 各命中一级 | `level` 与 `baseImage` 正确 |
| 2 | 锁文件优先级 | 同时有 `package-lock.json` 与 `yarn.lock` → 取 npm 并记一条 note |
| 3 | devcontainer 子集 | 支持的字段生效、不支持的进 `ignored[]` 且带原因 |
| 4 | devcontainer 语法错 | 不抛异常，降级到 L2 并记 note |
| 5 | 空仓库 | 退化成 `ubuntu-dev`，不崩 |
| 6 | 信号规范化 | 同一仓库两次采集 → `signals` 序列化字节相同（缓存键稳定的前提） |
| 7 | 生成的 Dockerfile | 对三个 fixture 各生成一份，断言：以 Layer 1 镜像为 FROM、无 CMD/ENTRYPOINT、无 root |
| 8 | 采集不执行代码 | 用一个"含恶意 Makefile"的 fixture → 采集过程不产生任何子进程副作用 |

### 验收标准

- 三个 fixture 的期望命中全部通过；
- 生成的 Dockerfile 在集成测试里**真的能 build 成功**（docker 可用时）；
- `environments` 表能存下一份完整候选（level / dockerfile / signals / notes）。

---

## Phase 6 · LLM 生成 Dockerfile + 自愈循环

### 交付物

- `packages/control-plane/src/environment/generate.ts`（prompt + 生成 + 硬约束校验）
- `packages/control-plane/src/environment/build.ts`（docker build 调用 + 日志采集 + 错误分类）
- `packages/control-plane/src/environment/queue.ts`（构建队列：并发 1、按 `project_key` 去重，
  带 `trigger`；触发点与"Run 绝不建环境"的口径见设计文档 §C.8）
- `packages/control-plane/src/db/migrations/007_env_builds.sql`
- 假 builder（集成测试与单测用）+ 真 builder（生产路径）两个实现（假的那个在
  `test/environment-fakes.ts`——两份测试层都要用同一套替身，见该文件的头注释）
- `scripts/build-env.ts`（`npm run env:build`：手工验收用的驱动，真连 PG / 真读 .env）

> **实现备注**：P6 落地时有 8 条有意偏差，逐条记在附录 A-31 … A-38——`env_builds` 多了
> `status` / `inference` 的 CHECK 与一个索引（A-31）；生成阶段的两类失败（`generation_failed` /
> `constraint_violation`）也进 `error_class`（A-32）；`signals` 级的第一轮就走 LLM、而不是等构建
> 失败（A-33，**这一条与下一条是计划本身的修正，正文已同步**）；记账口径是"每次 LLM 生成一行"，
> 规则生成不记假账（A-34）；日志落点是一个端口（配了 S3 走 S3，没配落本地文件，A-35）；多一个
> `scripts/build-env.ts`（A-36）；构建成功后 `environments.status` 留在 `building` 等 P7 的健康检查
> （A-37）；镜像 tag 把 `project_key` slug 化，并把实际构建的那份文本写回 `environments.dockerfile`
> （A-38）。另外两条不构成偏差、只是把 spec 没说死的地方写死：网络类故障最多重试 1 次是队列里
> 的 attempt 级 break（不是"重试整个仓库"）；`build_timeout` 不设额外上限，仍然吃满三轮（§C.4 的
> 两个防烧钱约束就是"3 轮 + 单轮 10 分钟"）。另外一处测试范围的收窄：P5 那条"环境目录不 import
> child_process”的目录级扫描改成只扫**推断层**那六个文件（`signals` / `infer` / `devcontainer` /
> `types` / `base-images` / `store`）——P6 的 `build.ts` 的工作就是起 `docker build`，目录级扫描
> 会把这条完全正当的能力当成违规。

### 具体如何实现

**1. 生成 prompt 的输入与硬约束**

```
输入：RepoSignals 摘要 + 规则生成的基线（P5 的渲染结果，可原样保留）+ 之前的错误分类（第二、三轮）
      + 上一版 Dockerfile + 日志尾部（40 行）
输出：一个 ```dockerfile 代码块
硬约束（校验不通过直接判失败，不进 build）：
  ① FROM 必须是 Layer 1 镜像之一
  ② 不得出现 CMD / ENTRYPOINT
  ③ 不得出现 USER root 之后不切回
  ④ 不得出现 COPY/ADD 相对仓库内容的路径（构建上下文无仓库内容）
  ⑤ 不得出现凭据字样（TOKEN/SECRET/PASSWORD/PRIVATE_KEY）的 RUN 或 ENV
  ⑥ 不得出现 curl|sh / wget|sh 这类远程执行（有依赖源白名单也不能让构建阶段任意执行）
```

**2. 构建（`build.ts`）**

```
docker build -f <tmp>/Dockerfile -t reuben-cloud/env-<project_key>-<revision>:build <tmp-context>
  · 构建上下文 = 一个只含 Dockerfile 的临时目录（**不把仓库内容给构建**）
  · 日志：docker 的 stdout/stderr 合并，边流边写对象存储（env_builds.log_key）
  · 超时：单轮 10 分钟（超时 → 杀进程组 → 分类为 build_timeout）
  · 并发：1（宿主机 docker daemon 是共享资源）
```

**3. 错误分类（正则表 + 优先级）**

| 分类 | 触发模式（示例） | 喂回模型的形式 |
|---|---|---|
| `unknown_base_image` | `pull access denied` / `manifest unknown` | "基础镜像不存在，只能从 Layer 1 矩阵里选" |
| `apt_package_missing` | `E: Unable to locate package` | 提取包名 → "这个包在 bookworm 里不存在" |
| `npm_404` / `pypi_404` | `404 Not Found - GET https://registry.npmjs.org` | 提取包名与版本 |
| `network_timeout` | `Temporary failure resolving` / `i/o timeout` | "网络问题，重试可能有效"（不重试超过 1 次） |
| `build_context_error` | `COPY failed: file not found` | "不要 COPY 仓库内容" |
| `permission_denied` | `Permission denied` 且涉及非 root 路径 | 检查 chown/chmod |
| `syntax_error` | `Dockerfile parse error` | 报行号 |
| `unknown` | 兜底 | 日志尾部 40 行 |

**分类的价值**：把"2000 行日志"压成"一句可行动的诊断"，是自愈循环能收敛的关键。

**4. 自愈循环**

```
attempt = 1..3:
  dockerfile = 第一轮 且 level != signals ? 规则生成
                                             : LLM 生成(信号, 规则基线, 上一版, 错误分类, 日志尾部)
  校验硬约束 → build → 成功则退出
  失败 → 分类 → 记 env_builds 一行（attempt, status, error_class, log_key, duration_ms）
        → 每次 LLM 生成各进 usage_ledger 一行（kind='env_build'；规则生成的那轮没有模型调用，不记）
最终失败 → environments.status='failed'，保留全部 attempt 与日志
成功    → environments.status 留在 building：能不能用是 P7 健康检查的结论（设计文档 §C.6）
```

> 第一轮的分工按 level 分（附录 A-33）：`devcontainer` / `dockerfile` 级先用规则渲染（那是仓库
> 作者写下的环境事实），失败才上模型；`signals` 级的第一轮就是 LLM（规则渲染对那一级只给得出
> 一行 `FROM`），否则模型永远没有出手的机会——一行 FROM 的镜像几乎构不出错。

**5. `env_builds` 表**

```sql
CREATE TABLE env_builds (
  id           text PRIMARY KEY,            -- bld_<ulid>
  project_key  text NOT NULL,
  revision     integer NOT NULL,
  attempt      integer NOT NULL,            -- 1..3
  inference    text NOT NULL,               -- devcontainer | dockerfile | signals | llm
  trigger      text NOT NULL,               -- first_seen | manual | promote（设计文档 §C.8）
  status       text NOT NULL,               -- building | built | failed
  error_class  text,                        -- 日志分类 + generation_failed / constraint_violation（A-32）
  dockerfile   text NOT NULL,               -- 每次尝试的实际文本（生成失败时是模型原文）
  log_key      text,                        -- 对象存储（没配对象存储时是本地文件 key，A-35）
  duration_ms  integer,
  image_digest text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT env_builds_trigger_check CHECK (trigger IN ('first_seen','manual','promote')),
  CONSTRAINT env_builds_status_check CHECK (status IN ('building','built','failed')),
  CONSTRAINT env_builds_inference_check CHECK (inference IN ('devcontainer','dockerfile','signals','llm'))
);
CREATE INDEX env_builds_project_idx ON env_builds (project_key, revision, attempt);
```

**6. 队列（`queue.ts`）：入队不等于构建**

触发点只做一件事：把"这个 `project_key` 需要环境"放进队列（设计文档 §C.8）。三件事必须在
**入队这一层**做完，不能下放到构建里：

- **并发 1**（宿主机 docker daemon 是共享资源）：队列串行执行，不是几个协程抢一个信号量；
- **去重**：同一个 `project_key` 已有构建在跑 → 复用那一次；已有 `ready` 且 `cache_key` 没变 →
  直接返回旧 digest（P7 的缓存命中），不产生新的 `env_builds` 行；
- **失败不阻塞队列**：一个仓库 build 失败只影响它自己，后面排队的照跑（否则一个坏仓库能卡死所有人）。

三个触发来源（`first_seen` / `manual` / `promote`）走的是同一个入队函数，差别只有 `trigger` 字段
——这也是"触发点只变时机、不变机制"那句落在代码里的样子。

### 技术边界

- 轮数硬上限 3、单轮超时 10 分钟、构建并发 1（三个约束都是**代码**，不是文档）；
- **触发点只影响入队**（`first_seen` / `manual` / `promote`），不影响构建流程；队列的并发 1 与
  去重也是**代码**，不是运维约定（设计文档 §C.8）；
- `first_seen` 的入队是**异步**的：发起方（会话 / M3 的调度器）不等它，Run 照常跑（P7 §5）；
- 生成的 Dockerfile 只允许从 Layer 1 出（避免"从零开始"导致 uid/HOME/sandbox-agent 全丢）；
- **不在构建阶段注入凭据**（构建进程 env 里没有 GitHub token / 模型 key；`--build-arg` 白名单为空）；
- 日志的落点是一个端口：配了对象存储就写它，没配就落本地文件（`REUBEN_CLOUD_ENV_LOG_DIR`，A-35）；
- 不做"构建缓存优化"（M2 用 docker 默认层缓存 + C.5 的镜像级缓存，不做 BuildKit 的高级特性）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 假 builder：第 1 轮失败、第 2 轮成功 | 收满 2 行 env_builds；最终 status=built |
| 2 | 假 builder：3 轮全失败 | status=failed；3 行 attempt；日志 key 都在 |
| 3 | 错误分类表 | 每条真实日志样本（fixture）分类正确 |
| 4 | 硬约束校验 | 含 CMD/ENTRYPOINT/root/curl\|sh 的生成结果被拒（不 build，`error_class=constraint_violation`） |
| 5 | 超时 | 假 builder 卡住 → 10 分钟（测试里拨快时钟）后被杀并分类 |
| 6 | 成本记账 | `signals` 级仓库三轮全失败（每轮一次 LLM 生成）→ usage_ledger 有 3 行 env_build；L1/L2 的第一轮是规则生成，不记账 |
| 7 | 真 build（集成） | 人为缺依赖的 fixture 仓库 → ≤3 轮成功（真 docker） |
| 8 | 构建上下文隔离 | 断言临时目录里只有 Dockerfile（没有仓库文件） |
| 9 | 队列去重 | 同一个 `project_key` 已有构建在跑时再入队 → 复用那一次，不产生第二行 attempt |
| 10 | 失败不阻塞 | 队列里第一个仓库 build 失败 → 第二个照常被构建（且两者串行，不重叠） |
| 11 | 生成阶段失败 | 模型没给代码块 / 违反硬约束 → 记一行 attempt（`generation_failed` / `constraint_violation`）、不产生 build、下一轮的 prompt 里带上那句诊断 |
| 12 | 网络类故障重试上限 | 连续两次 `network_timeout` → 第 2 轮之后停下（不烧第 3 轮） |

### 验收标准

- 人为缺一个依赖的仓库能在 ≤3 轮内构建成功；
- 构建日志可从对象存储取回并**人类可读**（有分轮次的分隔）；
- 三轮全失败时有结构化原因（不是一句"build failed"）。

---

## Phase 7 · 缓存 / 版本化 / 健康检查 / promote

### 交付物

- `environment/cache.ts`（cache_key 计算与命中）
- `environment/revision.ts`（revision 单调、父指针、promote、清理策略）
- `environment/health.ts`（一次性沙箱里的 smoke test → ready/degraded/failed）
- CLI：`agent:run --env-revision <n>` / `--rebuild-env` / `--promote-env`
- UI：环境状态与构建日志页（`packages/web/public/env.html` + 一条只读路由）
- `environments` 表的剩余字段（health / cache_key / parent_revision / image_digest）
- **触发接线**（设计文档 §C.8）：`--rebuild-env` 与页面上的按钮 → 入队 `trigger: "manual"`；
  会话创建时首次见到某个 `project_key` → 异步入队 `trigger: "first_seen"`；
  Run 侧的回退（拿不到 `ready` / `degraded` 就用 Layer 1 镜像 + 一句沙箱事实）

> **实现备注**：P7 落地时有 10 条有意偏差，逐条记在附录 A-39 … A-48——迁移号 008 给了 P7、
> P8 的索引迁移顺延为 `009_repo_index.sql`（A-39）；**`manual` 触发跳过缓存**，且缓存命中在
> 插入新 revision **之前**判断（命中不产生新行，A-40）；"当前 revision"落在一张一行的小表
> `project_env_state` 上，且只在构建 + 体检成功之后才动（A-41）；交付物多四个文件
> `health-sandbox.ts` / `resolve.ts` / `runtime.ts` / `web/env.ts`（A-42）；体检沙箱**先灌仓库
> 再跑命令**（A-43）；体检的第三步只跑按语言选的轻量校验、不跑 `verifyCommands` 里的真测试
> （A-44）；体检日志记在 `environments.health_log_key`（A-45）；清理只删镜像、不删行（A-46）；
> 环境页有一条 POST 写口、日志代理的 key 由服务端拼（A-47）；`resolveImageRef` 从测试脚手架
> 搬进产品代码（A-48）。
>
> 另外三处把 spec 没说死的地方写死：① `degraded` 的 `affected` 由关键词推断（浏览器 / playwright /
> e2e → `e2e`，其余 → `integration_tests`）——P5 的 `degradedRisks` 是人话文本，没有结构化的
> "受影响的动作"；② `first_seen` 的接线落在 **Run 侧解析**那一层（`resolveEnvironment`；会话创建与
> 第一次 Run 在脚本里相邻，M3 的调度器走同一个入口）：落一版 `draft` → **异步入队** → 回退到
> Layer 1；③ 异步那次构建成功之后会把 `current_revision` 往前推（`pointForwardIfNewer`，只往前走）
> ——否则指针要等到下一次 Run 的缓存命中才动，UI 上的"当前"会一直空着。
>
> **验证**：`npm test` 全绿（agent-runtime 124 / control-plane 405 / sandbox-agent 101 / web 33）；
> `npm run typecheck` 全绿；`npm run test:integration` **整套**全绿（122 项：121 通过 + 1 项平台条件
> 跳过；含 `environment.integration.test.ts` 新加的一节——新列的真 PG 往返 / 缓存命中只认
> ready|degraded / 指针 upsert 与回滚 / promote 的父指针 / 清理读得到 `sandboxes.image_digest`
> 的引用——与 `environment-build.integration.test.ts` 的真沙箱体检：起容器 → 灌 fixture 仓库 →
> exec → 日志落盘 → `ready` 落库 → 沙箱 `DESTROYED`）；`npm run smoke` 16 项全绿（Linux 专有的
> 隔离红线在 macOS 上按设计跳过）；
> 手工验收：`env:build` 第一次 2.3s 建出环境（`degraded`，事实是人话）、第二次 **0.64s 缓存命中**
> （`不构建也不体检`）、`--rebuild` 落 revision 2（父 1）、`--promote ./env.Dockerfile` 落 revision 3
> （父 2，真装了 jq，21s）且同一份文本再 promote 一次直接命中缓存；`agent:run` 在没命中时用 Layer 1 镜像 +
> 一句事实（system 里真的带上了），那次 Run 还在跑时后台构建就完成了（revision 1 → `ready`），
> 下一次 Run 直接用它的 digest 且 `runs.env_revision='1'`；环境页的页面 / `/info` / 两类日志
> 都用 `curl` 真取过一遍。

### 具体如何实现

**1. cache_key**

```ts
cacheKey = sha256([
  baseImage,
  normalizeSignals(signals),      // 排序键、去注释、去时间戳、去掉采集顺序
  BUILDER_VERSION,                // 手工维护的整数：改 prompt / 改 Layer 1 / 改叠加组件都要 +1
  dockerfileText,                 // 显式生成的那份（L1/L2 的合成结果或 L3 的 LLM 结果）
].join("\n"))
```

命中 → 直接复用 `image_digest` 与 `health`（不再构建、不再体检）。

**2. 版本（`revision.ts`）**

```
同一个 project_key 下 revision 单调递增；parent_revision 指向上一个
"重新构建" = 新 revision（即使 dockerfile 一样，只要不是缓存命中）
"promote（会话级改动固化回项目级）" = 基于当前 revision 生成新 Dockerfile → 新 revision
回滚 = 把 project 的 current_revision 指回旧值（不删任何行）
清理：保留最近 10 个 revision；被 sandboxes 表引用过的 image_digest 永不清理
```

**3. 健康检查（`health.ts`）**

在**用该镜像起的一次性沙箱**里跑（不是宿主！），按语言选命令：

| 语言 | 健康命令 | degraded 的判据 |
|---|---|---|
| node | `npm ci`（有 lockfile）/ `npm install` → `npm run build --if-present` | 构建成功但 compose 里的服务不可用 |
| python | `pip install -e .`（或 `poetry install`）→ `python -m compileall -q .` | 有 Dockerfile 里的服务依赖 |
| go | `go build ./...` | 有 cgo/系统库缺失但主包可编译 |
| 其他 | `true`（只验镜像能起） | — |

```
ready    ：安装 + 构建命令退出码 0
degraded ：构建成功，但命中 degradedRisks（compose 服务不可达 / 浏览器缺失 / 非关键步骤失败）
failed   ：安装或构建失败
```

**degraded 的产物**：结构化事实（`{reason, affected:["integration_tests"], detail}`），
ContextCompiler 把它作为"沙箱事实"写进 system（agent 据此跳过集成测试）。

**4. UI（最小）**

`/env/{projectKey}` 页面：当前 revision、状态徽章、健康细节、历次构建列表（点开看日志）。
仍然零构建前端；日志走对象存储的只读代理（只允许 `env-logs/` 前缀）。
页面的"构建/重建"按钮是 `manual` 触发的第二个入口（另一个是 CLI 的 `--rebuild-env`）。

**5. 触发与 Run 侧的回退（设计文档 §C.8）**

三种入队来源（`first_seen` / `manual` / `promote`）走 P6 的同一个队列函数，差别只有 `trigger`：

- `first_seen`：CP 第一次看到某个 `project_key`（会话创建时；M3 的调度器收到 issue 时同理）
  —— **异步入队，不阻塞**当前这次 Run；
- `manual`：`--rebuild-env` 与 `/env/{projectKey}` 的按钮；
- `promote`：会话里验证有效的改动固化回项目级。

Run 侧**只做一次解析**，从不构建：

```
resolveEnv(projectKey, signals):
  命中 cache_key 且有 ready|degraded  → 用它的 image_digest（revision 进 runs.env_revision）
  未命中                              → 用 Layer 1 的语言镜像；把 "项目依赖还没装" 当成
                                        沙箱事实写进 system（与 degraded 同一条通道）
                                        + 异步入队 first_seen
```

这一条让"构建 10 分钟"与"用户第一句话"彻底解耦：用户不等构建，构建也不需要用户。

### 技术边界

- 健康检查**必须**在沙箱里跑（宿主没有目标环境），且用一次性沙箱（跑完即销毁）；
- 缓存键里**不许**出现时间戳或随机值（否则永不命中）；
- 旧镜像清理只删"没被任何 sandbox 引用过"的；
- 不做环境的"手动编辑 Dockerfile"界面（改环境走重新构建；编辑 Dockerfile 是 M3+）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | cache_key 稳定性 | 同一信号两次计算相同；改注释不变；`BUILDER_VERSION` +1 会变 |
| 2 | 命中复用 | 第二次构建命中：不调用 builder、直接返回旧 digest |
| 3 | revision 单调 | 连续三次构建 → 1,2,3；父指针正确 |
| 4 | 回滚 | `--env-revision 1` → Run 用的是 revision 1 的 digest |
| 5 | promote | 会话级改动固化成新 revision，Dockerfile 内含该改动 |
| 6 | 健康三态 | 三个假沙箱（成功/部分失败/失败）→ 三个状态与 detail |
| 7 | degraded 传递 | degraded 环境跑 Run → system 里出现"集成测试不可用"的事实 |
| 8 | 清理 | 造 12 个 revision + 一个被引用 → 清理后保留 10 个 + 被引用的那个 |
| 9 | 迁移/幂等 | 重复构建同一 revision 不产生新行 |
| 10 | 入队去重 | 同一 `project_key` 连发两次 `first_seen` → 只建一次（复用进行中的那次，或缓存命中） |
| 11 | 环境未就绪也能跑 | 没有 `ready`/`degraded` 的 revision 时起 Run → 用 Layer 1 镜像，system 里有"依赖未装"的事实，Run 正常结束（不报错、不阻塞） |

### 验收标准

- 同一仓库第二次构建 < 10s（缓存命中）；
- 健康状态与原因可见（UI + DB）；
- degraded 环境下的 Run 提示词里含该事实（结构化断言）；
- **没有现成环境时 Run 照常结束**（用 Layer 1 镜像 + 一句结构化事实），不等构建、不报错，
  同时该仓库的构建已在队列里（UI 上看得见进度）。

---

# 第三部分 · 索引与上下文

## Phase 8 · 仓库索引（符号 + 引用 + 增量）

### 交付物

- `vendor/tree-sitter/*.wasm`（7 种语言语法文件 + LICENSE + `SHA256SUMS`）
- `packages/control-plane/src/index/{parse,symbols,refs,worker,store}.ts`
- `packages/control-plane/src/db/migrations/009_repo_index.sql`（A-39：008 给了 P7 的环境版本 / 体检）
- `packages/control-plane/src/index/indexer.ts`（编排：增量判定 → 解析 → 落库）
- dev 脚本：`npm run index:repo -- --local <path>`（不接 GitHub 也能建索引）

### 具体如何实现

**1. 迁移（008）**

```sql
CREATE TABLE repo_indexes (
  repo_key    text NOT NULL,
  commit_sha  text NOT NULL,
  status      text NOT NULL,               -- building | ready | failed | unsupported
  files       integer NOT NULL DEFAULT 0,
  symbols     integer NOT NULL DEFAULT 0,
  edges       integer NOT NULL DEFAULT 0,
  languages   jsonb NOT NULL DEFAULT '{}', -- {ts: 120, python: 30}
  duration_ms integer,
  error       text,
  built_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_key, commit_sha)
);

CREATE TABLE repo_symbols (
  repo_key   text NOT NULL, commit_sha text NOT NULL,
  path       text NOT NULL, lang text NOT NULL,
  name       text NOT NULL, kind text NOT NULL,   -- function|class|method|interface|type|const
  signature  text NOT NULL,                       -- 单行（截断到 200 字符）
  start_line integer NOT NULL, end_line integer NOT NULL,
  PRIMARY KEY (repo_key, commit_sha, path, name, start_line)
);
CREATE INDEX repo_symbols_name_idx ON repo_symbols (repo_key, commit_sha, name);

CREATE TABLE repo_refs (
  repo_key text NOT NULL, commit_sha text NOT NULL,
  from_path text NOT NULL, to_path text NOT NULL,
  symbol text NOT NULL, weight real NOT NULL DEFAULT 1.0,
  PRIMARY KEY (repo_key, commit_sha, from_path, to_path, symbol)
);
```

**2. 解析（worker 子进程隔离）**

```
CP 主进程 → spawn(node, index/worker.ts) → stdin/stdout 上跑 JSON 协议
  为什么必须隔离：WASM 模块崩溃/OOM 会带走整个进程；索引是"随时可以重来"的派生物，
  不该有任何机会影响正在跑的 Run
  worker 生命周期：一批文件一个 worker，跑完退出（不做常驻池——M2 的索引频次低）
```

**3. 符号提取**

- 每种语言一个 query/遍历器（TS/TSX/JS/Python/Go/Rust/Java/Ruby/PHP），提取：
  顶层与嵌套的定义节点（function/class/method/interface/type/const）；
- **签名重建**：取定义节点源码的第一行 ~ 到 body 开始前，压成单行、截断 200 字符；
- 跳过超大文件（> 1 MiB）与 `node_modules`/`vendor`/`dist`/`.git`/lockfile；
- 不支持的语言 → 该文件记为"无符号"（计进 `files`，不进 `symbols`），不报错。

**4. 引用边（文件级）**

```
对每个文件：收集标识符（去掉语言关键字与局部变量名的最佳努力：只取"出现在成员访问左侧 或
作为调用目标"的名字）+ import/require/use 语句里的路径
把标识符映射到"定义它的文件"：查 repo_symbols(name) →
  唯一 → 一条边 weight=1
  多个 → 每个候选 weight=1/n（n 为候选数），n > 5 时丢弃（宁可少边，不要错边）
import 路径直接给出高权重边（weight=2）
```

**5. 增量**

```
上一次索引 commit 与目标 commit 在同一个 clone 里：
  git diff --name-status <old> <new>  → 变化文件集 C
  若 C 为空 → 直接复用旧行（只改 repo_indexes 的 commit 复制）
  若 |C| / 总文件数 < 30% → 只重解析 C（边的两端涉及 C 时重算；被删文件连带删行）
  否则 → 全量重建
非祖先关系（force push / 换分支）→ 全量
```

**6. 预算与降级**

- 全量索引预算：**90s 硬超时**（超过就落 `status='ready'` 但 `error='partial_timeout'`，已解析的部分可用）；
- 单文件预算：200ms（超时跳过该文件）；
- 内存：worker `--max-old-space-size=1024`；
- 索引失败**不阻塞 Run**（只是没有 Repo Map）：`indexer` 返回 `null`，Run 继续。

### 技术边界

- **不做类型解析 / 精确 call graph**（那是每语言一套编译器前端的量级）；文件级边足够 Repo Map 用；
- **不做向量**（M2 不做；见设计文档 §H）；
- 不支持的语言静默降级（不报错、不阻塞）；
- 索引是派生物：任何时刻可 `DELETE` 后重建，没有"唯一真相"；
- 不在沙箱里跑索引（理由见设计文档 §D.2）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 每语言符号提取（fixture 文件） | 符号名 / kind / 签名 / 行号完全匹配金标准 |
| 2 | 签名重建 | 多行签名压成单行；超长截断到 200；无 body 的声明（interface/type）正确 |
| 3 | 引用边 | fixture 里 A→B 的调用/import → 边存在且权重正确 |
| 4 | 歧义 | 同名定义在 3 个文件 → 三条边各 weight=1/3；8 个文件 → 无边 |
| 5 | 增量 == 全量 | 造 3 次提交逐步改动 → 增量结果的哈希 == 全量重建的哈希 |
| 6 | 超时降级 | 单文件超时 → 跳过且不失败；总超时 → partial 状态 |
| 7 | worker 崩溃 | 注入一个让 WASM 崩的输入 → CP 主进程存活，索引落 failed |
| 8 | 大仓库预算 | 生成 5k 文件的合成仓库 → 全量 < 90s（性能测试，标记为 slow） |
| 9 | 幂等 | 同一 commit 索引两次 → 不产生重复行（主键约束 + 先删后插的事务） |

### 验收标准

- 中位真实仓库（≥ 3k 文件）全量索引 < 60s（预算 90s）；
- 索引结果落 `repo_symbols` / `repo_refs`，且能回答"某个符号定义在哪几个文件里"；
- 增量与全量结果一致（哈希断言）。

---

## Phase 9 · Repo Map

### 交付物

- `packages/control-plane/src/index/{rank,render,personalize}.ts`
- `packages/control-plane/src/db/migrations/009_repo_map.sql`（`repo_maps` 缓存表）
- `npm run map:repo -- --local <path> --issue-file <f>`（可单独看地图长什么样）
- 接线：ContextCompiler 的 `repo_map` 分区（P10 正式接，本 Phase 先提供函数）

### 具体如何实现

**1. 图与排名（`rank.ts`）**

```
节点 = 文件（不是符号：文件级更稳定、边更可靠）
边   = repo_refs 的 (from,to,weight)
PageRank（幂法）：
  r = 1/N 起步；damping = 0.85；迭代到 |Δ| < 1e-7 或 100 次
  个性化向量 p：命中任务词的文件权重高（见 personalize.ts），否则均匀
  悬挂节点（无出边）的权重按 p 重新分配（标准做法）
```

**2. 个性化（`personalize.ts`）**

```
任务文本（issue + 任务书）→ 标识符候选（驼峰/下划线切词、去停用词、去语言关键字）
→ 在 repo_symbols.name 上精确匹配 → 命中的文件 p[file] += 1
→ 目录名/文件名出现在任务文本里 → 该文件与同目录文件 p += 0.5
→ 归一化；全为 0 时退化成均匀分布
```

**3. 渲染（`render.ts`）**

```
按 rank 降序、同 rank 按 path 升序（**确定性**）
每个文件：取它的 top-K 符号（K=8，按符号重要性：被引用次数多者优先，其次 start_line 升序）
输出格式（缩进树 + 签名），达到 token 预算（默认 1500，硬上限 3000）就停
每个文件块之间留空行；被截断的文件在末尾标 "…"（不截断半行）
末尾追加一行："# 本次 Run 已改动（地图可能过期）：a.ts, b.ts"（P10 提供该列表）
```

**4. 缓存（`repo_maps`）**

```sql
CREATE TABLE repo_maps (
  repo_key text NOT NULL, commit_sha text NOT NULL,
  personalization_hash text NOT NULL,   -- 任务词的哈希（同一任务命中）
  budget_tokens integer NOT NULL,
  text text NOT NULL, hash text NOT NULL, tokens integer NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_key, commit_sha, personalization_hash, budget_tokens)
);
```

**5. 过期处理（设计文档 §D.3）**

已改动文件列表（来自 `tool_invocations` 里 `edit`/`write` 的 `details.changedFiles`）拼在末尾；
**增量重建**只在"改动文件 > 20 或距上次重建 > 5 分钟"时触发。

### 技术边界

- 只渲染**签名**，不渲染实现体（它是地图）；
- token 预算硬上限 3000（超了必须截断，不允许挤掉历史）；
- 确定性优先于"更聪明"：同样的输入必须字节相同；
- 不做跨语言/跨仓库的地图合并；
- 索引不可用时（`status != ready`）地图降级为**文件树**（目录 + 文件名，按目录大小排序），仍进上下文。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 确定性 | 同一输入渲染两次字节相同；符号顺序稳定 |
| 2 | 预算 | 大仓库截断到预算内且不截半行；末尾无残缺 |
| 3 | 个性化 | 任务提到 `billing` → `src/billing/*` 的文件排名上升（对照无个性化） |
| 4 | 空/单文件仓库 | 不崩，输出合理 |
| 5 | Unicode 路径 | 中文/emoji 文件名不破坏缩进与截断 |
| 6 | 已改动标注 | 传入 changedFiles → 末尾出现该行 |
| 7 | 缓存命中 | 同一 (commit, personalization, budget) 第二次不重算 |
| 8 | 降级 | `repo_indexes.status != ready` → 输出文件树而非报错 |

### 验收标准

- 地图文本里包含 issue 涉及的模块（§J.1 第 4 条的断言方式）；
- 渲染 < 200ms（5k 文件仓库）；
- 关掉地图（配置）能跑同一批任务——这是 §J.2 那条"轮数下降 ≥20%"对照实验的前提。

---

## Phase 10 · ContextCompiler

### 交付物

- `packages/agent-runtime/src/context/{sections,compiler,hash}.ts`
- 接线：`transformContext` → compiler；`model_requests` 落库；`context_compiled` 事件
- `packages/control-plane/src/session/requests.ts` 的完整实现（P2 已建表）
- UI：上下文面板显示分区占比（P4 已建壳，本 Phase 填数据）
- 配置：`REUBEN_CLOUD_REPO_MAP_TOKENS`（1500）/ `_SEED_ENABLED`（默认 on）/ 各分区上限

### 具体如何实现

**1. 分区与预算（`sections.ts`）**

```ts
export const SECTIONS = [
  { name: "tools",     budget: null,  hard: true  },   // 由工具数量决定，不可截断
  { name: "system",    budget: 0.15,  hard: true  },   // 超预算 → 报错（工程问题）
  { name: "repo_map",  budget: 1500,  hard: false },   // token 数，截断
  { name: "task",      budget: 0.10,  hard: true  },
  { name: "seed",      budget: 0.03,  hard: false },
  { name: "history",   budget: null,  hard: false },   // 剩余空间，不截断（由 compaction 管）
  // 【预留，M2 不实现】用户文档知识库召回。没有配置知识库 / 开关为关时，这个分区不存在，
  // 编译产物与 M2 完全一致——留接缝不等于提前实现，这一点要有测试兜住（下面第 11 条）。
  // { name: "knowledge", budget: 0.10, hard: false },
] as const
```

**2. 编译流程（`compiler.ts`）**

```
compile({ system, tools, messages, repoMap, task, seed }):
  1. 先 compaction 之后的消息序列（compaction 在 prepareNextTurn 里已经跑过）
  2. 组装 tools（Registry 快照，按名字排序 → **字节稳定**）
  3. 组装 system 分区：
      角色与规则（常量）
      + 沙箱事实（REPO_DIR / 出网白名单 / 环境健康 degraded 事实）
      + 技能清单（XML，P12）
      + "已改动文件"提醒
  4. repo_map（P9 的渲染结果，超预算截断）
  5. task（issue 原文 + 任务书）
  6. seed（符号命中 → 路径 + 符号名，≤ 3% 预算）
  7. 统计每个分区的 tokens（chars/4）与 hash
  8. compiled_hash = sha256(有序的 [name, hash] + system + tools_hash + 消息序列化)
  9. 返回 { sections, system, tools, messages, compiledHash }
```

**3. `convertToLlm`（富消息 → 协议消息）**

```
user / assistant / toolResult → 直通（toolResult 映射成 provider 的 tool_result 块）
compactionSummary → 带前缀的 user 消息（P3 的渲染规则）
custom（技能提示、审批记录）→ user 消息，带 [系统提示] 前缀
```

**4. 缓存断点**

Anthropic：在 `system` 末尾与 `repo_map` 末尾各打一个 `cache_control: {type:"ephemeral"}`（最多两个断点，
这是 Anthropic 的限制）。断点位置的**判据**：它之前的内容在本 Run 内必须字节稳定。

**5. `model_requests` 落库与回放**

每轮调用前调用 `recordRequest()`；`sections` 存统计（名字/大小/hash），不存正文。
回放 API（M3 的 UI 会用，M2 只留函数）：`replayContext(sessionId, turn)` → 从 entries 重建 messages +
从 model_requests 取 system/编译产物 → 与当时的输入**逐字节比对**（不等就是 bug）。

**6. seed 检索（只给"去哪看"，不给代码）**

```
任务词 → repo_symbols.name 精确匹配 → top 5 个符号所在文件
输出（≤ 3% 预算）：
  # 可能与任务相关的位置（只是线索，请自己 read 确认）
  src/billing/refund.ts: refundInvoice
  src/api/handlers/billing.ts: createInvoice
```

**不做每轮自动检索注入**：检索结果每轮变化会破坏缓存前缀，且会把模型从"自己的探索"上带偏。
这是设计文档 §E.1 的取舍，写在这里防止实施时"顺手加一个 RAG"。

### 技术边界

- **不做驱逐**（唯一自动缩减是 compaction）；
- 编译产物**不得包含任何凭据**（单测里扫 key 前缀）；
- 编译函数必须是**纯函数**（输入 → 输出，无 IO、无时间、无随机）；IO（读地图/技能）在编译前完成；
- system 超预算**报错**而不是截断（提示词写太长是工程问题，靠截断会掩盖）；
- 预算表里的比例是**监控口径**，不是强制裁剪规则（硬预算只有 repo_map / seed）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 确定性 | 同一输入两次编译 → `compiledHash` 相同、system 字节相同 |
| 2 | 纯函数 | 编译过程不产生任何 IO（用一个只读的 spy store 断言零调用） |
| 3 | 分区统计 | sections 里每块 tokens/hash 正确；总和 ≈ 消息总量 |
| 4 | repo_map 截断 | 超预算 → 截断到预算内且不截半行 |
| 5 | system 超预算 | 故意塞长技能清单 → 抛结构化错误（不是静默截断） |
| 6 | seed 预算 | 命中 20 个符号 → 只取 5 个且总量 ≤ 3% |
| 7 | 凭据扫描 | 编译产物里不含 `sk-` / `ghs_` / `-----BEGIN` |
| 8 | 压缩后编译 | 含 compactionSummary 的会话 → 编译出的 messages 含摘要前缀 |
| 9 | 缓存断点 | 两次编译（仅 history 不同）→ 前缀部分（tools/system/repo_map）hash 相同 |
| 10 | 回放 | 随机取 5 个历史 (session, turn) → 重建的输入逐字节等于当时记录 |
| 11 | 预留分区缺席 | 不配置知识库 → 编译产物里没有 `knowledge` 分区，且与不加预留代码时逐字节相同 |

### 验收标准

- §J.2 全部指标可测（尤其"有地图 vs 无地图，平均轮数下降 ≥ 20%"的对照实验）；
- `replayContext` 对历史 Run 逐字节一致；
- 上下文面板能看到每个分区的占比。

---

# 第四部分 · 工具面

## Phase 11 · Tool Registry + 7 个内置工具

### 交付物

- `packages/agent-runtime/src/registry/{registry,meta}.ts`
- `packages/agent-runtime/src/tools/{truncate,edit,read,write,bash,grep,find,ls,index}.ts`
- 镜像更新：`rg`（ripgrep）+ `fd` 进 Layer 1（apt 源已在白名单，**不需要**改 egress 白名单）
- `packages/control-plane/src/db/migrations/011_tool_stats.sql`（物化视图或按需查询，见下）
- CP 侧注入：`sandbox-{bash,file}operions.ts`（把沙箱 API 适配成 Operations）

### 具体如何实现

**1. Registry（`registry.ts`）**

```ts
export type ToolSource = "builtin" | "skill" | "mcp"
export interface RegisteredTool { tool: AgentTool; meta: ToolMeta; source: ToolSource; server?: string }

export class ToolRegistry {
  register(entry: RegisteredTool): void                                  // 重名 → 抛错（注册期就能发现）
  resolve(name: string): RegisteredTool | undefined
  snapshot(): AgentTool[]                                                // Run 开始时的冻结快照（按名字排序）
  expand(names: string[]): void                                          // addedToolNames 的懒加载
}
```

**2. M0 现状 → pi 语义的逐项对齐（这张表同时是测试清单）**

| 工具 | 入参 | 行为（对齐 pi） |
|---|---|---|
| `read` | `path, offset?, limit?` | 行号前缀；目录报错提示用 `ls`；超 2000 行/50KB 给续读指令 |
| `write` | `path, content` | 目标目录不存在 → 明确错误（不自动建目录） |
| `edit` | `path, oldString, newString, replaceAll?` | 精确匹配失败 → 报错 + 提示（"最接近的一处"行号）；多处匹配且未 `replaceAll` → 报错 |
| `grep` | `pattern, path?, glob?, contextLines?, ignoreCase?` | `rg` 输出；行截断 500 字符；总输出走 truncate.ts |
| `find` | `pattern, path?` | `rg --files -g`；按 mtime 还是字典序？**字典序**（确定性） |
| `ls` | `path?, depth?` | 目录在前、文件在后，附大小；`depth` 默认 1 |
| `bash` | `command, timeout?` | 收 shell 字符串 → `["bash","-lc",command]`；流式 `onUpdate`；超时/取消杀进程组 |

**3. `truncate.ts`（从 pi 移植语义，自己实现）**

```
truncateHead / truncateTail：行数（2000）与字节数（50KB）双上限，先到先算
不返回半行（唯一例外：尾部截断时最后一行本身是半行，要标记 lastLinePartial）
返回 TruncationResult（total/输出行数与字节数、被哪个限制截断）
大输出落沙箱临时文件 → 结果文本末尾附 "Full output: <path>"（与 M0 的 log_path 机制统一）
```

**4. `edit` 的实现（最容易写错的一个）**

```
1. 通过 FileOperations.runExclusive(path, …) 串行化（防两个并行 edit 互相覆盖）
2. read → 精确字符串查找：
     0 处 → 错误："oldString 没有找到。最接近的一处在第 N 行：<片段>"
     多处且 !replaceAll → 错误："找到 K 处，需要更大上下文或 replaceAll"
3. 替换 → 校验结果不是空文件（除非原文件就是空）
4. write → 重新 read 校验（写回的字节必须等于预期）
5. details 里给出 unified diff（+行数变化）与 changedFiles
```

**5. `bash` 的字符串化与 prompt 同步**

- 工具的 schema 变成 `{ command: string; timeout?: number }`；
- 实现里包成 `["bash","-lc", command]` 交给 `BashOperations.exec`；
- **同步改** `prompt/system.ts`：删掉"cmd 是 argv 数组"那一条，改成"用标准 shell 语法"；
- 沙箱侧契约**一个字不改**（`POST /exec` 仍然只收 argv）。

**6. 工具统计**

`tool_invocations` 已有数据；M2 只加一个视图（不建新表）：

```sql
CREATE VIEW tool_stats AS
SELECT tool, count(*) AS calls,
       avg((ended_at - started_at)) AS avg_duration,
       sum(CASE WHEN is_error THEN 1 ELSE 0 END)::float / count(*) AS error_rate
FROM tool_invocations WHERE status = 'settled' GROUP BY tool;
```

### 技术边界

- 内置工具固定 7 个，不加"顺手再来一个"（浏览器、LSP、HTTP fetch 都不在 M2）；
- `edit` 必须串行化（per-sandbox + per-path），这是**正确性**问题不是性能问题；
- 工具输出截断只在一处发生（工具层），编译器不二次截断；
- 工具描述（`description`）是要反复打磨的资产：改动必须带一个"为什么这样改"的 commit message。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 每个工具的成功路径 | 输入输出快照 |
| 2 | 每个工具的错误路径 | `isError=true` + 文案含下一步提示 |
| 3 | `edit` 三态 | 未找到 / 多处 / 精确替换（含 `replaceAll`） |
| 4 | `edit` 并发 | 两个并行 edit 同一文件 → 串行执行，结果不互相覆盖 |
| 5 | `bash` 引用 | 命令里的引号/管道/重定向正确（shell 语义） |
| 6 | `bash` 超时与取消 | 进程组被杀（含子进程）；`onUpdate` 收到中间输出 |
| 7 | `truncate` 边界 | 恰好 2000 行 / 恰好 50KB / 首行超字节限制 |
| 8 | Registry | 重名抛错；快照顺序稳定；`expand` 后工具可见 |
| 9 | 统计视图 | 10 次调用后 error_rate 正确 |
| 10 | 与 pi 对拍 | 同一输入下与 pi 同名工具的行为一致（表格逐项） |

### 验收标准

- 7 个工具全绿；`agent:run` 在真实仓库上跑通并产出 patch；
- 平均工具调用轮数相比 M0 下降（这是 edit/grep/find 的主要价值）；
- prompt 与沙箱文档的措辞同步更新（设计文档 §L 的第 7 条）。

---

## Phase 12 · Skills

### 交付物

- `packages/agent-runtime/src/skills/{discover,format,types}.ts`
- 内置技能目录 `packages/agent-runtime/skills/`（至少 2 个示范：`make-release`、`fix-flaky-test`）
- `packages/control-plane/src/db/migrations/012_skills.sql`（`skills` / `skill_runs`）
- 信任机制：`--trust-project` 与 workspace 配置里的 `trustedProjects`
- 技能文件注入沙箱（Run 开始时写到 `/workspace/.reuben/skills/`）

### 具体如何实现

**1. 发现（`discover.ts`）**

```
位置（优先级从低到高）：
  packages/agent-runtime/skills/          ← 内置
  ~/.reuben/skills/                       ← 用户级
  <clone>/.reuben/skills/                 ← 项目级（**需要信任**）
规则（对齐 pi 的发现语义）：
  目录下的 SKILL.md 递归发现；`.reuben/skills/` 根层的直接 .md 文件也认（带合法 frontmatter）
  校验 name（小写+连字符）、description 非空、SKILL.md 存在
  不合法 → 跳过 + 一条诊断（进日志与 UI，不静默）
去重：同名以优先级高者为准，并记一条 note
```

**2. 注入（`format.ts`，对齐 pi 的 XML 形态）**

```xml
<available_skills>
  <skill><name>make-release</name><description>…</description><location>/workspace/.reuben/skills/make-release/SKILL.md</location></skill>
</available_skills>
```

- 清单进 system 的 `skills` 子块（≤ 100 个 + ≤ system 预算的 1/3；超了按名字截断并记 note）；
- **只有描述常驻**；正文由模型用 `read` 读（progressive disclosure）。

**3. 信任门**

```
未信任仓库：不加载 `.reuben/skills/`（但加载用户级与内置）
信任来源：CLI `--trust-project`，或 workspace 配置 `trustedProjects: ["owner/name"]`
被拒绝时：日志与 system 里各留一句"项目技能已跳过（仓库未信任）"——**不能静默**
```

**4. `skill_runs`（可度量）**

```sql
CREATE TABLE skill_runs (
  id text PRIMARY KEY, session_id text NOT NULL, skill text NOT NULL,
  source text NOT NULL,          -- builtin | user | project
  loaded_at timestamptz NOT NULL DEFAULT now()
);
```

判定"加载了"：会话里出现对该 `SKILL.md` 路径的 `read` 调用（结构化，不靠文本匹配）。

**5. 内置技能示范（内容要真能跑）**

- `make-release`：检查版本号一致性、跑构建、生成 changelog 草稿（演示"约束 + 步骤 + 检查清单"）；
- `fix-flaky-test`：如何复现、如何区分 flaky 与真失败、允许的修复范围（演示"边界与禁止项"）。

### 技术边界

- **项目技能默认不加载**（未信任仓库）——这是安全边界不是配置偏好；
- 技能**不能注册工具**（注册源只有 builtin / 静态声明 / MCP）；
- 技能内容按不可信内容对待（不能改系统策略、不能越过审批）；
- 不做技能包管理 / 版本解析 / 依赖安装（技能就是文本 + 脚本，脚本用 bash 跑）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 发现顺序与去重 | 三层同名 → 取优先级高者 + 一条 note |
| 2 | frontmatter 校验 | 缺 description / 非法 name → 跳过 + 诊断 |
| 3 | XML 格式 | 转义正确（描述里有 `<`/`&`）；`location` 是绝对路径 |
| 4 | 预算 | 200 个技能 → 截断到上限 + note |
| 5 | 信任门 | 未信任仓库的项目技能不出现；`--trust-project` 后出现 |
| 6 | 加载记录 | 模型 read 了 SKILL.md → `skill_runs` 有一行 |
| 7 | 注入沙箱 | Run 开始时技能文件在沙箱内可读（集成测试） |

### 验收标准

- 一个自带项目技能的仓库（信任后）能被模型加载并按技能执行（§J.1 第 7 条）；
- 未信任时不加载（安全断言）；
- 技能清单在系统提示词里的占比可查（上下文面板）。

---

## Phase 13 · MCP

### 交付物

- `packages/agent-runtime/src/mcp/{client,config,source,health}.ts`
- `packages/control-plane/src/db/migrations/013_mcp.sql`（`mcp_servers` / `mcp_calls`）
- UI：MCP 管理页（列表 / 开关 / 配置表单 / 工具白名单 / 健康状态 / 调用统计）——仍零构建前端
- 文档：`docs/mcp.md`（怎么加一个 server、信任模型、故障排查）

### 具体如何实现

**1. 配置与信任模型（必须先写明白）**

> **安装一个 MCP server = 在 CP 宿主机上运行第三方代码。** M2 的边界：
> ① 只能通过**配置文件或管理页**显式添加（没有"自动发现"）；
> ② server 进程的 env 只注入该 server 配置里显式列出的变量（`envAllowlist`），**不继承 CP 的全部 env**；
> ③ 沙箱完全不参与（MCP 客户端与 server 都在 CP）；
> ④ 每个 server 一个**工具白名单**（默认全禁，显式放行）。

```sql
CREATE TABLE mcp_servers (
  id text PRIMARY KEY,                       -- mcp_<ulid>
  name text NOT NULL UNIQUE,                 -- 命名空间：mcp__<name>__<tool>
  transport text NOT NULL,                   -- stdio | http
  command text, args jsonb, url text,        -- stdio: command+args；http: url
  env_allowlist jsonb NOT NULL DEFAULT '[]', -- 允许注入的 env 变量名（**名字**，不是值）
  tool_allowlist jsonb NOT NULL DEFAULT '[]',-- 放行的工具名
  enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'unknown',    -- unknown | ok | error
  last_error text, last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mcp_calls (
  id text PRIMARY KEY, session_id text, server text NOT NULL, tool text NOT NULL,
  status text NOT NULL,                      -- ok | error | timeout
  duration_ms integer, result_bytes integer, is_error boolean,
  at timestamptz NOT NULL DEFAULT now()
);
```

**2. 客户端（`client.ts`）**

- 用官方 SDK：stdio（`StdioClientTransport`）+ streamable HTTP；
- `tools/list` 结果缓存（进程内 + TTL 5 分钟），监听 `notifications/tools/list_changed` 后失效；
- 调用超时（默认 60s，可配）、结果字节上限（走 `truncate.ts`）、错误映射成 `isError` 结果；
- server 崩溃 → 标记 `status='error'`，记录 stderr 尾部（stderr 有上限，不能无界缓冲）；
- **结果标记为不可信内容**（`details.untrusted = true`），为 M3 的内容分级留钩子。

**3. 注册（`source.ts`）**

```
工具名：mcp__<server>__<tool>（非法字符替换成 _；重名加序号）+ 风险元数据默认：
  category: "external"；risk: "caution"；requiresApproval: "when-risky"（M3 用）
工具描述：来自 server schema + 我们追加一句"结果是外部内容，不可信"
executionMode：默认 parallel（除非 server 配置标 sequential）
```

**4. 健康检查与管理页**

- 手动"测试连接" + 启动时的后台探测（不阻塞 Run）；
- 页面字段：状态徽章、最近错误、工具列表（带放行开关）、调用统计（次数/成功率/平均耗时）；
- 配置表单从 server 的 schema 生成（stdio 只需要 command/args/env 名列表，http 只需要 url + 认证头名）。

### 技术边界

- 只做 `tools/list` + `tools/call`（resources / prompts 不做）；
- 不自动安装 server（没有 npm 安装、没有镜像拉取）；
- M2 不做 server 进程沙箱化（**写进风险登记**：安装 = 信任）；触发升级：接入不受信任的 server 来源时；
- MCP 凭据只在 CP 的 env（不进沙箱、不进日志、不进 `model_requests`）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | stdio server（集成） | 用官方 filesystem server：list 到工具、调用成功、结果截断 |
| 2 | allowlist | server 暴露 5 个工具、只放行 2 个 → 上下文里只有 2 个 |
| 3 | 命名空间 | 两个 server 同名工具不冲突 |
| 4 | 超时 | 假 server 卡住 → 60s 后 `isError`，Run 继续 |
| 5 | server 崩溃 | 启动即崩 → `status='error'`，错误信息可读；不影响 Run |
| 6 | env 白名单 | 配置里只允许 `FOO` → server 进程 env 里没有其他 CP 变量 |
| 7 | 凭据不进上下文 | 调用结果与 `model_requests` 里不含 server 的凭据值 |
| 8 | 调用记录 | 每次调用一行 mcp_calls，统计视图正确 |
| 9 | 前端 | 管理页的开关/白名单保存后生效（DOM 单测 + API 测试） |

### 验收标准

- §J.1 第 8 条（5 个工具放行 2 个）通过；
- server 崩溃不影响 Run；
- 文档 `docs/mcp.md` 教会一个新用户接一个 server。

---

## 附录 A · 与设计文档的有意偏差

> 规则：实施过程中发现"文档这么写、但这样做更好"时，**改代码的同时在这里记一条**，写清
> ① 原文怎么写的 ② 实际怎么做的 ③ 为什么 ④ 影响面。改回去之前先读理由。

| # | 位置 | 原文 | 实际 | 理由 |
|---|---|---|---|---|
| A-1 | Phase 1 · `bash` 工具入参 | 工具收 argv 数组（`cmd`），**P11** 才改成 shell 字符串 | **P1 就改了**：工具入参是 `{command: string, cwd?, timeoutMs?}`，由 CP 适配器包成 `["bash","-lc",command]` 再发下去 | ① P1 的 spec §5 已经把 `BashOperations.exec` 定义成字符串形状（端口在 P1 落地）；② 提示词在 P1 就要重写成分区组装，顺手删掉那条"跟模型先验对抗"的规矩（设计文档 §F.2 第 1 条）比留到 P11 少一次全量迁移；③ 沙箱红线一个字没变（`POST /exec` 仍然只收 argv，注入类问题仍然不存在） | `sandbox-operations.ts` 的 `cmd: ["bash","-lc",command]`；`prompt/system.ts` 规则 1；`agent-tools` / `web-stream` 集成测试与 live 测试的调用形式；工具描述里的 argv 措辞 |
| A-2 | Phase 1 · `list` → `ls` | **P11** 把 `list` 改名 `ls`，旧名保留一个版本作别名 | **P1 就改了**：文件 `src/tools/ls.ts`、工具名 `ls`；旧名通过 `AgentTool.aliases` 解析（模型看不到别名，只有拿旧名字调用时才命中） | ① P1 的交付物清单里写的就是 `read/write/ls/bash`；② 改名与 Operations 化是同一次搬迁，拆成两次要再动一遍所有调用点与测试 | `aliases` 是过渡期字段（下个版本删）；工具清单里只有 `ls`；`agent-runtime/test/loop.test.ts` 有一条别名用例 |
| A-3 | Phase 1 · 重复调用守卫的提示方式 | "第 3 次注入提示"（M0 是先执行、再往同一条消息里塞一条提示块） | 第 3 次**不执行**该工具，把提示作为 `isError` 结果返回（pi 的 `beforeToolCall` → `{block:true}` 语义）；第 4 次 block + `terminate` | 已经知道它是重复，就没有理由再跑一遍（对 `bash` 这种有副作用的工具尤其明显）；提示仍然进同一条消息，模型看到的东西不变 | 阈值与"连续"语义没变；`REPEAT_NOTICE` 文案没变；守卫仍然挂在 `beforeToolCall`（测试要点 10 的原话） |
| A-4 | Phase 2 · `sessions` 表 | 只有 `sandbox_id` / `sandbox_last_used_at` | 多加两列：`sandbox_flush_failures` / `sandbox_flush_failed_at` | 规则 3（"落地失败 → 不销毁，标 flush_failed，下个周期重试"）需要一个"不销毁沙箱、又能被下一轮看见"的标记。放 `sandboxes.state = ERROR` 不行：§D 里 ERROR 没有出边，标了它这个沙箱就再也回不到 READY——一次网络抖动会被升级成"必须人工处理"。放在会话上是诚实的：失败的是"这次会话的落地" | 005 迁移；租约的两个计数读写；不影响既有四张表 |
| A-5 | Phase 2 · `SessionStore` 接口 | 14 个方法，`settleToolInvocation` 返回 `void` | 多 5 个方法（`setSessionSandbox` / `touchSession` / `acquireSessionLock` / `releaseSessionLock` / `interruptInvocation` / `listRequests`——具体见 `store.ts`），`settleToolInvocation` 返回结果 entry id | ① 租约要写 `sessions` 的沙箱字段，续轮要抢锁——这些是 P2 §5/§6 明文要求的动作，没有对应端口就只能让编排直接拼 SQL（那就破了"纯决策层"的边界）；② 结果 entry 的 id 是 leaf 的下一跳，`void` 会让编排只能先猜一个 id 再传进去（等于把预留机制废掉） | `store.ts`、`memory.ts`、`postgres.ts`、契约测试；PG 实现仍然是唯一的 SQL 出处 |
| A-6 | Phase 2 · `model_requests` 的对象 key | `requests/{session_id}/{turn}.json.gz` | `requests/{session_id}/{run_id}/{turn}.json.gz` | `turn` 只在**一次执行内**唯一；同一个会话的第二轮 Run 会覆写第一轮的输入，P10 的回放会直接拿到错的上下文。多一段 `run_id` 之后 key 与"entries 挂会话、run 标段落"是同一套结构 | `requests.ts` 的 `requestObjectKey`；导出读取器；测试 5 |
| A-7 | Phase 2 · JSONL 导出的字段 | 与 M0 `transcript.jsonl` 逐字段兼容 | 记录类型与字段名逐条对齐，但 M0 独有的字段（`run_start.limits`、`request.tools` / `maxTokens`、`run_end.detail`）**如实为 `null`** | 这些值在 P2 的表里没有列（`tools` 只有 hash，`detail` 只在实时 transcript 里有）。拿一个相近的值蒙混会让排查脚本读到一个"看起来有但是错的"字段——那比 `null` 贵得多。P10 的 ContextCompiler 会把 `tools` / 分区补齐，届时这些字段自然有值 | `export.ts`；测试要点 6 的断言方式（断言字段名在、**不**断言值非空） |
| A-8 | Phase 2 · `sandboxes` 表 | 设计文档 §G.1："既有三张表一行不改" | 加一列 `session_id`（spec P2 §1 就是这么写的），并加了 `(session_id, last_active_at)` 索引 | 沙箱从"某次执行的附属品"变成"某个会话的工作区"（设计文档 §A.1 的第 2 条规则）。既有行 `session_id` 为 NULL，对账/状态机/sweeper 的语义一个字没变——这是**加列**，不是改结构 | 005 迁移；`SandboxRow`；`manager.createSandbox` 多一个可选 `sessionId`；持久层"列清单"测试同步加了这一列 |
| A-9 | Phase 2 · 目标目录 | `session/{store,memory,entries,export}` + CP 的 `session/{postgres,requests,sandbox-lease}` | 多三个文件：`session/entry-recorder.ts`、`session/session-run.ts`、`session/provision.ts` | ① "事件 → entries / intent / usage"必须只有一份实现：会话编排（多轮）与 `agent:run`（单轮手工验收）都要它；② `sandbox-lease.ts` 要能在没有 Docker / git / 网络时被完整测到（测试要点 11–20 全是这一类），所以"建沙箱 / 落地"这两个真动作拆到 `provision.ts`（端口注入），租约只留策略 | 纯新增，不影响既有文件；集成测试只跑 `provision.ts` 的真路径 |
| A-10 | Phase 2 · `AgentLoopOptions` | P1 的兼容入口只有 `onText` / `events` | 多四个口：`onAgentEvent` / `onRequest` / `history` / `prompts` | ① 会话层要**原生事件**（`events` 是 M0 的观察窗词汇，P4 才统一）才能写 entries 与结算 intent；② `model_requests` 要"真的发给模型的东西"，它只存在于 `transformContext` 里；③ 多轮必须有"这一轮之前的历史"与"本次注入的消息"两个独立的口——否则续轮要么丢历史、要么把任务书重复注入每轮 | `run.ts`（兼容层，P4 删）；`session-run.ts`；`agent:run` 脚本；P1 的测试没受影响（都是可选项） |
| A-11 | Phase 3 · 循环契约 | 只写"接线：`prepareNextTurn` 钩子 + 溢出恢复 + `--compact`" | `AgentLoopTurnUpdate` 多两个字段（`compaction` / `stop`），`AgentLoopConfig` 多一个钩子（`recoverFromModelError`），`PrepareNextTurnContext` 多一个 `signal` | ① 压缩条目与"压了多少 token、保留自哪条 entry"只有准备方知道（entry id 与账本都在它手里），循环只该负责播事件——否则循环要知道会话存储的形状；② "压不出来就终止 Run"需要一个明确的停下信号（`stop`），返回 `undefined` 的语义是"这次不压"；③ 摘要是耗时请求，没有 signal 就没法在用户 abort 时取消它 | `types.ts` 的三个契约；`loop.ts` 的两处接线；`compaction-controller.test.ts` 的溢出恢复用例 |
| A-12 | Phase 3 · 溢出恢复的"重试本轮" | "强制 compact 一次 → 重试本轮（只重试一次）" | 重试**算作新的一轮**：失败的尝试照常落 entries / `model_requests` / transcript（轮次号前进），重试之前**跳过 `prepareNextTurn` 一次** | ① `model_requests` 的对象 key 是 `(session, run, turn)`，同一轮两次请求会覆写第一轮的输入（A-6 同一条毛病）；轮次号前进让"失败的尝试"与"重试"各有完整记录；② 恢复钩子已经给过一份压缩后的上下文，再跑一遍 `prepareNextTurn` 会让"压缩完还超阈值"的上下文被立刻压第二次（白烧一次摘要）；③ `shouldStopAfterTurn` 看到的仍是"模型真的跑完的那一轮" | `loop.ts` 的 `recoveries` / `preparedByRecovery`；测试要点 7 的断言（"第一次失败 + 重试一次"） |
| A-13 | Phase 3 · 摘要序列化的总预算 | 工具结果截断到 2000 字符（单条）；测试要点 11 又要求"100 条含 200 KB 工具结果的对话 → 序列化后 < 预留预算" | 单条仍截 2000 字符，**再加一道总长闸**：整段序列化超过 `reserveTokens × 4` 时保留头 1/4 + 尾、中间标省略 | 100 × 2000 字符 = 200 KB > 预留预算（16384 token ≈ 65 KB）——只做单条截断满足不了测试要点 11，而"摘要请求自己超窗"正是设计文档 §E.4 点名的死循环。头尾各留一段是因为开头有原始诉求、结尾有"刚做到哪"，只留一边会结构性丢信息 | `summarize.ts` 的 `serializeConversation` / `summaryBudgetChars`；`compaction.test.ts` 要点 11 |
| A-14 | Phase 3 · `buildContextEntries` 的摘要去重 | P2 的投影规则只说"从最后一条 compaction 的 `firstKeptEntryId` 开始取" | `projectAll` 跳过**所有**压缩条目（投影里只可能有一份摘要） | 第二次压缩时旧压缩条目正好落在保留区间里（它的 seq 在新压缩条目之前、`firstKeptEntryId` 之后），不跳过就会把一份**过时摘要**当成一条 user 消息发出去——与最新那份互相矛盾，也正是测试要点 4 的隐含前提 | `session/entries.ts`；`compaction.test.ts` 的"连续压缩之后投影里只有一份摘要" |
| A-15 | Phase 3 · M0 的上下文裁剪 | "M0 的做法：超 600k 字符丢旧 `tool_result`；M2 的 compaction 取代它" | 随 P3 一起删除（`elideOldToolResults`、三个常量、`AgentLoopOptions.context`，以及它的单测 `agent-context.test.ts`） | 两套缩减机制并存会让"上下文为什么变小"有两个可能；而裁剪按体积丢正文、能丢在 turn 中间、每次丢完都让缓存前缀失效。删 `AgentLoopOptions.context` 不影响任何调用方（会话路径与脚本都不传它） | `agent/run.ts`；`test/unit/agent-compaction.test.ts` 取代 `agent-context.test.ts` |
| A-16 | Phase 3 · 摘要请求的缓存开关 | "摘要请求本身关闭 prompt cache 写入"（没有说关在哪一层） | `ModelRequest` 多一个 `cache?: "default" \| "none"`；SDK 参数构造从 `#params` 抽成纯函数 `toSdkParams` | ① 缓存断点在 `system` 那一个块上，客户端不给开关就只能发一次带缓存的请求——写缓存比读贵；② 抽成纯函数之后"没有 `cache_control`"这条断言可以在没有网络、没有 key 的情况下测（私有方法测不到） | `types.ts` 的 `ModelRequest.cache`；`model/client.ts` 的 `toSdkParams`；两个测试文件各一条 |
| A-17 | Phase 3 · `compaction_failed` 怎么传到 Run 的终态 | "结构化失败：`compaction_failed`，终止 Run 并如实报告"（没有说通道） | 准备方返回 `{stop: {reason, detail}}` → 循环发一条**与停止原因同名**的 `note` 再收工；CP 兼容层按名字表把它翻成 `AgentStopReason`，`runStatusFor` 把它归到 `failed` | 循环不该为了一个业务终态长出一套新的返回类型；`note` 本来就要发（观察窗要能解释"为什么停了"），把 kind 与停止原因共用一个词之后，新增一种停止原因只需要在 `isStopReason` 里加名字。归 `failed` 是因为重跑同样的输入还会失败——那不是"我们主动停下" | `loop.ts` 的 `stop` 分支；`agent/run.ts` 的 `isStopReason` / `resolveStopReason`；`session-run.ts` 的 `runStatusFor` |
| A-18 | Phase 4 · SSE 帧的通道名 | M0 的 `frameOf` 只写 `id:` + `data:`，前端在 `onmessage` 里再 switch `data.type` | 每条帧多一个 `event:` 字段（`run` / `agent` / `turn` / `message` / `tool` / `context` / `compaction` / `note` / `exec`），通道由 `events.ts` 的 `sseFrameOf` **一张 switch 表**（+ `never` 兜底）决定；前端把同一份清单注册成 `addEventListener` | ① `EventSource` 的 `addEventListener("tool", ...)` 是这个协议最自然的用法，把通道藏进 `data.type` 等于要求每个消费者都写一层 switch；② 后端加通道、老客户端不认识时，浏览器**根本不派发**（规范行为）——spec 要求的"向后兼容"是白拿的；③ 实现时真踩到一个坑：`source.onmessage = fn` 与 `addEventListener("message", fn)` 是**同一个通道的两个监听**，两个都注册会让 message 类事件处理两遍（文字翻倍、第一条 user 消息被当成插话重画），所以前端只注册通道、不设 `onmessage` | `events.ts` 的 `SSE_EVENT_NAMES` / `sseFrameOf`；`server.ts` 的 `frameOf`；`app.js` 的 `SSE_CHANNELS`；`ui.test.ts` 逐条比对两份清单；`web-server.test.ts` 断言四族事件的通道名 |
| A-19 | Phase 4 · `SessionStore` 的读口 | P2 的接口只有 `listRuns(sessionId)`（从会话出发） | 多一个 `getRun(runId)` | `/runs/{id}/transcript` 拿到的是 **run id**，要回答"这个 run 属于哪个会话、从哪条 entry 开始"就必须能反查。没有这个端口，观察窗只能自己拼 SQL（破了"PG 只在 CP 存储层"的边界）或者再建一张 run→session 的内存表（重启就丢）；P10 的回放（按 run 取编译产物）走同一条路 | `session/store.ts`、`memory.ts`、CP 的 `session/postgres.ts`、契约测试 8 号用例（集成测试在真 PG 上跑同一份） |
| A-20 | Phase 4 · `run_start.sessionId` | 交付物只说"事件统一"，没说 run 与会话怎么连 | `RunEvent.run_start` 多一个 `sessionId: string \| null` | 观察窗的入口是 `/runs/{id}`，而会话视图要 `/sessions/{id}/entries`：不给这个字段，页面就得先问一次存储（多一个往返与一个"存储没接"的空状态）；"这次执行挂在哪个会话上"本来就是 CP 才知道的编排事实，和 `model` / `issue` / `limits` 是同一类 | `events.ts`；`run.ts` 的 `AgentLoopOptions.sessionId`；`session-run.ts` 与 `scripts/agent-run.ts` 的传参；`hub.ts` 的 `RunInfo.sessionId`；`session-run.test.ts` 的一条断言 |
| A-21 | Phase 4 · 沙箱命令输出的位置 | 映射表里只有一行"（沙箱 exec 事件）→ `exec`"，没说它是哪一族 | 独立的一小族 `ExecEvent`（3 个成员，在 CP 的 `events.ts`），与 Run 生命周期（3 个）并列；三者合成观察窗的 `HubEvent` | 沙箱是另一个进程、另一套词汇（`started` / `stdout` / `completed`，snake_case），而且在循环之外也在用（P7 的健康检查、P6 的构建日志）。塞进 `AgentEvent` 会让"循环事件"这个概念被污染（循环根本不知道这些事件），塞进 `RunEvent` 又违反了"RunEvent 只留生命周期"这条；单独一小族之后，`createSandboxToolkit` 只认 `ExecEventSink`，工具层不认识 Run 生命周期 | `events.ts` 的 `ExecEvent` / `ExecEventSink` / `HubEvent`；`sandbox-operations.ts` 的口；`web-server.test.ts` 的 `exec` 通道用例 |
| A-22 | Phase 4 · 每个 Run 的 JSONL transcript | "transcript 从 entries 派生"（容易读成"删掉 JSONL 写入"） | 两条都留着：观察窗与 `/runs/{id}/transcript` 读 `session_entries`；`agent/transcript.ts` 继续写每个 Run 的 JSONL | 两者受众不同：JSONL 是**单次执行**的取证文件（`agent:run --export/--keep`、排障脚本、集成测试都在用它），entries 是**会话**的持久形态，每轮真发出去的全文在 `model_requests` 里。删 JSONL 要动 `run.ts` / 脚本 / 三条单测 / 两个 live 脚本，而 P4 要的"观察窗不再依赖内存 JSONL"已经拿到了 | `agent/transcript.ts` 不动；新增的 `web/history.ts` 是另一条读路径；`agent-events.test.ts` 仍断 transcript 的内容（轮次号与三条记录） |
| A-23 | Phase 4 · 上下文面板的"是否命中压缩" | "显示每个分区的 token 数与占比、`compiled_hash` 前 8 位、是否命中压缩"（没说这个布尔从哪来） | 由流里的 `compaction` 事件点亮（面板上显示"已压缩 / 未压缩"），不新增字段 | P10 的 `context_compiled` 只有分区统计与 `compiled_hash`——"命中压缩"在编译产物里表现为"投影里有一条 `compactionSummary`"，那是投影的属性、不是某个分区的属性；而"这个上下文被压过"在事件流里已经有一条权威记录（P3 的 `compaction`）。等 P10 真需要"这一轮的分区里含多少摘要 token"时再加字段，比现在先编一个字段便宜（加字段不破坏旧客户端，编错了反而误导） | `app.js` 的 `renderCompaction` / `renderContextCompiled`；`web-server.test.ts` 的 `context` / `compaction` 通道用例；`render.test.ts` 的面板用例 |
| A-24 | Phase 5 · §3/§4（L1 "直接复用"、L2 "复用 + 叠加"） | devcontainer 的 `image` / `build.dockerfile` 直接复用；L2 复用仓库 Dockerfile 再叠加 agent 必需组件 | 生成的 Dockerfile 的 FROM **永远是** Layer 1 的一档（`baseImageRef`）；devcontainer 的 `image` 与仓库 Dockerfile 的 FROM **只当语言信号**（进 `notes`；`image` 另记一条 `ignored`），仓库 Dockerfile 的构建步骤一条都不搬 | ① 硬约束与沙箱契约（sandbox-agent、非 root uid 1000、HOME/环境变量）只有 Layer 1 保证；② 仓库 Dockerfile 常以 `COPY . .` 依赖构建上下文里的仓库内容，而环境构建期仓库还没灌进沙箱（那是创建沙箱时的事）；③ spec 测试要点 7 断言的形态就是"以 Layer 1 镜像为 FROM" | `infer.ts` 的 `pickBaseKind` / `renderEnvDockerfile`；`devcontainer.ts` 给 `image` 记的 ignored；fixture 的期望命中表（`python-poetry` 的 `Dockerfile` 只贡献 `python:3.11-slim` 这个语言信号） |
| A-25 | Phase 5 · 交付物清单 | `environment/{types,signals,devcontainer,infer}.ts` 四个文件；`RepoSignals` 的字段清单；`EnvironmentCandidate` 的字段清单 | 多 `base-images.ts`（矩阵身份：kind / 引用，被推断、构建脚本、集成测试、P7 共用）与 `store.ts`（插入 / 按 id 取 / 取最新，三个函数）；`RepoSignals` 多一个 `scripts`；`EnvironmentCandidate` 多一个 `baseImageKind` | ① 镜像 tag 必须只有一处定义：构建脚本打的 tag 与生成的 Dockerfile 里 `FROM` 那一行是**同一个事实**，两处各写一份字符串迟早漂；② 验收标准写着"表能存下一份完整候选"，只建表不留写入口的话这条只能靠测试手写 SQL 证明，而 P6/P7 还要再造一次（终态留给 P7 的 `revision.ts`）；③ npm scripts 并进 `makeTargets` 之后，写进 `buildCommands` 的 `build` 到底是 `make build` 还是 `npm run build` 就分不清了；④ P7 的健康检查按语言选命令，从镜像引用反查等于每次解析字符串 | `environment/{base-images,store}.ts`；`types.ts`；`scripts/build-images.ts`；三个 environment 测试文件 |
| A-26 | Phase 5 · §5 镜像矩阵 | `Dockerfile.go-dev  # FROM common + go + gopls` | 只装 go（官方 tarball，版本钉在 ARG 里），**不装 gopls** | M2 没有任何一处消费 LSP：符号索引走 tree-sitter WASM（P8），工具面是 read/write/edit/grep/find/ls/bash（P11），没有工具会说 LSP。装一个几百 MB、无人调用的语言服务器，只让构建时间与常规镜像体积双双变难看。真接 LSP 时补一行 `go install golang.org/x/tools/gopls@vX.Y.Z` 即可——那时它才有实测需求驱动 | `images/base/Dockerfile.go-dev`（矩阵其余六档一字未改） |
| A-27 | Phase 5 · 测试要点 7 vs P6 §1 ③ | 测试要点 7"无 CMD/ENTRYPOINT、无 root"；P6 §1 ③"不得出现 `USER root` 之后不切回" | `checkDockerfileConstraints` 按更具体的那句实现："默认用户必须非 root，且每个 `USER root` 后面都要切回非 root"；三个 fixture 的生成结果里**一个 `USER` 都没有**，测试对它们额外断言了这条更强的形态 | devcontainer 的 features（github-cli / git-lfs）只能以 root 装包；把"无 root"读成"永远不许出现 USER root"会让 §3 明确要求支持的 feature 这条路没法实现 | `infer.ts` 的 `checkDockerfileConstraints` / `renderEnvDockerfile`；`environment-infer.test.ts` 的两条用例（三个 fixture 无 USER / github-cli 有 root 但切回） |
| A-28 | Phase 5 · §3 devcontainer 子集 | 支持字段清单（没提文件格式） | 自带 40 行 JSONC 解析（去行/块注释 + 去尾逗号，扫描时跳过字符串字面量）；解析失败返回 `error`，调用方降级到下一级并记 note | 真实仓库里的 devcontainer.json 是 VS Code 写出来的 JSONC（带注释与尾逗号）——用 `JSON.parse` 会在最常见的一类文件上失败。spec §0.2 的依赖表里没有 JSON5 / jsonc-parser，而这里要做的只有两件事；"读不懂就降级"本来就是测试要点 4 的要求，所以解析器只负责"能读的读懂、读不懂的如实上报" | `devcontainer.ts` 的 `parseJsonc`；fixture 的 `.devcontainer/devcontainer.json` **故意**写成 JSONC |
| A-29 | Phase 5 · §2 采集清单（CI 配置、compose 的 services） | 从 `.github/workflows/*.yml` 的 `run:` 与 `compose.yaml` 的 services 读环境事实 | 两个 reader 都是**行级扫描**（缩进 + 正则）：CI 只取内联 `run:`（块状 `run: \|` 进 `ignored`），compose 只取 `services:` 块里两空格缩进的服务名与 `image:` | 要读的只有两件小事，而且都是启发式——错了顶多少一条信号（`ignored` 里写明"只做了行级扫描"）。spec §0.2 没有 YAML 依赖，为它引一个库要按表格写理由。行级扫描读不到的东西（`depends_on` 关系、YAML 锚点、多文档）对 P5 的产出没有影响：服务名 + "沙箱里起不了它们"这句 degraded 说明已经够 agent 用 | `signals.ts` 的 `readCiHints` / `readServices` / `parseComposeServices`；真需要结构化 YAML 时（例如要判服务版本）再引库 |
| A-30 | Phase 5 · 交付物（`images/sandbox/Dockerfile` 改为 `FROM reuben-cloud/base-<x>`） | "保留一层薄封装" | 薄封装只剩 FROM + 两个 LABEL，底座选 `base-fullstack`；`npm run build:image` 从一条 `docker build` 改成 `scripts/build-images.ts`（按拓扑序建 common → python-dev → fullstack → sandbox-base 并打印 digest），新增 `npm run build:base-images` 建七档；`scripts/sandbox-image-check.ts` 的缓存断言从"看 sandbox 镜像里的 `#6 CACHED`"改成"看 common 那次构建真的没跑 apt + sandbox 镜像的 config digest 不变" | ① `sandbox-base:dev` 这个 tag 是"本地开发与既有测试的底座"（egress-proxy 的集成测试要 python venv、agent 集成测试要 node、image-check 要 git/tar），矩阵里只有 fullstack 同时满足；② 镜像名是**一个**事实——脚本从 `base-images.ts` 取引用，Dockerfile 的缺省 ARG 只是手工构建时的方便值；③ apt 层随 common 搬走后，旧断言里的步骤号必然失效，而"步骤号"本来就是最脆的断言方式 | `images/sandbox/Dockerfile`、`scripts/build-images.ts`、`scripts/sandbox-image-check.ts`、`package.json`、`docs/sandbox-spec.md` Phase 4 的构建命令、README §8 |

| A-31 | Phase 6 · `007_env_builds.sql` | 建表语句只给 `trigger` 一个 CHECK | 另加 `status` / `inference` 的 CHECK 与 `(project_key, revision, attempt)` 索引 | 与 006 同一条理由：这两个列是被 `switch` / `if` 按值读的（UI 徽章、队列的分支、P7 的缓存），写错一个字母只会让某个分支永远走不到；索引是因为"这个仓库这一版试过几次"是 UI 与排障最常读的形态 | 007 迁移；`store.ts` 的 `listEnvBuilds`；集成测试按 attempt 升序断言三行 |
| A-32 | Phase 6 · 生成阶段的两类失败 | 分类表只有日志类（`unknown_base_image` … `unknown`） | `env_builds.error_class` 另收 `generation_failed`（模型没给代码块 / 调用失败）与 `constraint_violation`（生成结果违反硬约束、按 spec 不进 build）；`env_builds.dockerfile` 是 NOT NULL，生成失败时放模型原文或一句说明 | "这一轮为什么没成"对下一轮生成是同一个问题；把它们记成 `unknown` 会让 UI 与 prompt 都少一句可行动的诊断。形状统一（同一个 `BuildFailure`）之后，循环里只有一处填 `error_class` | `build.ts` 的 `ENV_BUILD_ERROR_CLASSES`；`queue.ts` 的两个失败分支；单测两条用例 |
| A-33 | Phase 6 · §4 自愈循环（**计划本身的修正，正文已同步**） | `dockerfile = (attempt == 1) ? 规则生成 : LLM 生成(...)` | `signals` 级的第一轮就是 LLM 生成（规则渲染结果作为 prompt 里的基线）；`devcontainer` / `dockerfile` 级保持"第一轮规则、失败才自愈"；没有生成端口时（没配模型 key）一律退化成规则生成 | ① P5 §4 对这一级的原话是"本地规则；P6 接 LLM 生成"；② 规则渲染对 signals 级只给得出一行 `FROM`（没有作者写的 devcontainer / Dockerfile 可复用），而一行 FROM 的镜像几乎永远构不出错——等构建失败再上模型等于模型永远没有机会，环境里也就永远没有系统依赖；③ L1/L2 相反：第一轮规则输出里有作者的事实，先用它省一次模型调用 | `queue.ts` 的 `#plan`；单测两条（signals 级第一轮就调模型 / devcontainer 级第一轮不调） |
| A-34 | Phase 6 · §4 记账口径（**计划本身的修正，正文已同步**） | 循环末尾"失败 → … 进 usage_ledger（kind='env_build'）" + 测试要点 6"三轮自愈 → 3 行" | **每次 LLM 生成各记一行**；第一轮走规则生成的那条路（L1/L2 且第一轮失败前）不记假账；模型调用失败但拿到了 usage 也照记 | 账本是成本，规则生成没有模型调用；"三轮 → 3 行"只在三轮都有 LLM 调用时成立（signals 级正是这样）。反过来给零 token 的规则轮记一行，会让按 kind 汇总的账多出一批"花了钱"的假行 | `queue.ts` 的 recordUsage 分支；单测断言 3 行（signals）与 1 行（devcontainer）两种形态 |
| A-35 | Phase 6 · §2 日志落点 | "日志：docker 的 stdout/stderr 合并，边流边写对象存储（`env_builds.log_key`）" | 落点是一个端口（`BuildLogStore`）：配了 S3 就用它，没配就落本地目录（`REUBEN_CLOUD_ENV_LOG_DIR`，缺省 `$TMPDIR/reuben-cloud-env-logs`）；上传失败只记一条 warn 并把 `log_key` 置空 | 对象存储是**部署形态**、本地文件是**开发形态**；让"没配 S3 就不能构建环境"成为事实，只会逼人在本地把四个 S3 变量编出来。日志是证据不是产物：一次成功的构建不该因为 MinIO 抖动而失败（反过来，构建失败也不会因为日志丢了而变成成功） | `build.ts` 的 `FileBuildLogStore` / `envBuildLogStoreFromEnv`；单测两条；README §8 的环境变量表 |
| A-36 | Phase 6 · 交付物 | 只有三个模块 + 迁移 + 两个 builder 实现 | 多一个 `scripts/build-env.ts`（`npm run env:build`：推断 → 建 revision → 入队 → 打印分轮结果与 digest） | 验收标准是"人为缺一个依赖的仓库能在 ≤3 轮内构建成功"——手工验收需要一条能真连 PG、真读 `.env` 里的模型凭据的驱动；P7 的 `agent:run --rebuild-env` 要等 P7 的会话接线，先给一个独立脚本少一次等待（与 P8 的 `index:repo` 同一个定位） | `scripts/build-env.ts`、`package.json`、README §8 |
| A-37 | Phase 6 · 构建成功之后的环境状态 | 只写了"最终失败 → `environments.status='failed'`" | 成功时**不动**状态：留在队列开始时推进过去的 `building`，等 P7 的健康检查收尾 | `ready` 的定义是"依赖装上了、构建命令跑通了"（设计文档 §C.6），而 P6 只证明了 `docker build` 成功。在这里写 ready 等于把"可能用不了"当成事实，degraded 就再也没机会出现——而 degraded 是 M2 最有价值的一个状态 | `queue.ts` 的收尾分支；集成测试断言 `status='building'`；P7 的健康检查接着推到 ready / degraded / failed |
| A-38 | Phase 6 · 镜像 tag 与成功后的文本回写 | `-t reuben-cloud/env-<project_key>-<revision>:build`；没说自愈成功之后 `environments.dockerfile` 怎么办 | tag 变成 `reuben-cloud/env-<slug>-r<revision>:build`（`/` 与怪字符 slug 化，同一版的所有尝试共用一个 tag）；成功自愈后把**实际构建的那份文本**写回 `environments.dockerfile` | ① tag 里不能有 `/`，而 `project_key` 就是 `owner/name`；② P7 的缓存键里有一项是 `dockerfileText`：如果环境行留着规则生成的那份、而镜像是模型改过的，缓存命中就会把"用另一份文本构建的镜像"当成这一版的产物复用出去——那是最难查的一类错（本地是好的、别人那儿不对） | `build.ts` 的 `envImageTag` / `slugifyProjectKey`；`store.ts` 的 `setEnvironmentDockerfile`；`queue.ts` 的收尾；集成测试断言回写 |

| A-39 | Phase 7 · 迁移号 | P8 的交付物写的是 `008_repo_index.sql` | P7 的迁移占了 `008_env_health.sql`，P8 的索引迁移顺延成 `009_repo_index.sql`（P8 落地时按这个号建） | 迁移**只增不改、按落地顺序编号**：P7 在 P8 之前落地，中间插一个更大的序号只会让"哪条先跑"这件事在文件名里失真。改名零成本（P8 还没落地），序号错乱则是永久的 |
| A-40 | Phase 7 · §1 与 P6 §6 的"缓存命中" | "命中 → 直接复用 image_digest 与 health"；P6 §6："已有 ready 且 cache_key 没变 → 直接返回旧 digest" | **两处收窄**：① `trigger: "manual"` **跳过**缓存（另外两个触发源照吃）；② 缓存命中在**插入新 revision 之前**判断（`runtime.buildIfNeeded()` 与 `resolveEnvironment`），命中**不产生新行**——队列里那道闸只是"调用方没查 / 两个进程同时入队"时的兜底，命中时把旧 digest 与体检结论复制到本次要求的那一版上 | ① 人显式点"重建"时"缓存键没变"不是理由：缓存键看不见 Layer 1 的 tag 被重建、上游 registry 变动、docker 层缓存脏了——而那正是他要重试的对象；`first_seen`（没人要求）那条路仍然吃缓存，收益一分不少。② spec §1 说"重新构建 = 新 revision（只要不是缓存命中）"，这句话的另一半就是"命中不产生新行"；先插行再命中会让每次命中都留一版 `draft` 孤儿 | `queue.ts` 的缓存闸（含 `cached` 字段）；`runtime.ts` 的 `buildIfNeeded` / `rebuild`；`resolve.ts` 的第 ③ 步；测试要点 2 / 10 的断言改成"命中不产生新 revision" |
| A-41 | Phase 7 · §2 "当前 revision" | "回滚 = 把 project 的 current_revision 指回旧值（不删任何行）"——没说这个指针住在哪 | 新建一张一行的小表 `project_env_state(project_key, current_revision, updated_at)`（008 迁移），`setProjectEnvState` 走 upsert；**只在构建 + 体检成功之后才动指针**（`pointForwardIfNewer` / `promoteEnvironment` 的收尾） | ① "当前是哪一版"与"这一版环境是什么"是两个事实：前者每个仓库一行、会被回滚改；后者每个 revision 一行、只追加。把指针放进 `environments` 会让"回滚"变成改一条历史证据。② 推一个新版本失败不该弄坏正在生效的那一版——指针晚一点动，Run 侧解析自然继续用旧的 | 008 迁移；`store.ts` 的 `getProjectEnvState` / `setProjectEnvState`；`revision.ts` 的 promote 与 rollback；`resolve.ts` 的命中路径会把指针指过去（"只往前走"） |
| A-42 | Phase 7 · 交付物 | `environment/{cache,revision,health}.ts` 三个模块 | 多四个：`health-sandbox.ts`（一次性沙箱的端口实现：clone / 建沙箱 / 灌仓库 / exec / 销毁）、`resolve.ts`（Run 侧解析）、`runtime.ts`（组合根：进程级队列 + 仓库级运行时 + 体检装配）、`web/env.ts`（环境页读模型与日志只读代理） | 与 P6 的 `queue.ts`/`build.ts` 同一条切分：`health.ts` 要能在没有 docker / manager / git 的单测里逐条验证三态，所以"三段真动作"必须分开；`resolve.ts` 是 spec §5 那段伪代码的落点（Run 侧只解析不构建）；`runtime.ts` 让 `agent:run` / `env:build` / 环境页共用一个装配（否则三个地方会各自漂一个默认值）；`web/env.ts` 把"读模型 + 服务端拼日志 key"从路由里分出来（路由只管 HTTP 形状） | 纯新增；`health.ts` 只认 `open/exec/destroy` 三个动作 |
| A-43 | Phase 7 · §3 体检沙箱 | "在用该镜像起的一次性沙箱里跑（不是宿主！）" | 那个沙箱**先灌入仓库再跑命令**——与创建会话沙箱走同一条 clone + inject 路径（`health-sandbox.ts`） | 体检要跑的正是 `npm ci` / `go build ./...` 这类**要仓库内容**的命令；而镜像是 P6 从信号生成的，它只装系统依赖、不装项目依赖。不灌仓库的话每条命令都会以"找不到 package.json"失败，于是每个环境都被判成 `failed`——那不是体检，那是误判 | `health-sandbox.ts`；`environment-build.integration.test.ts` 的真沙箱用例断言 `package.json` 与 `.git` 在沙箱里、cwd 是 `/workspace/repo` |
| A-44 | Phase 7 · §3 体检命令 | 表里给了每类语言的健康命令（`npm ci` → `npm run build --if-present` / `pip install -e .` → `compileall` / `go build ./...`） | required 那批直接取 `candidate.buildCommands`（P5 从仓库事实推出来的那一份）；再加**一条**按语言选的轻量校验（`compileall` / `go build ./...` / `cargo check`，失败只降级）；`verifyCommands` 里的真测试（`npm test` / `pytest`）**不跑** | ① `buildCommands` 与 §C.6 表里那一列是同一件事的两个来源，再写一张表就是两份"怎么装依赖"；② 跑真测试可能几分钟、要数据库，甚至本来就是这个环境要服务的目标——health 是 smoke test（`pytest --collect-only` 那种量级） | `health.ts` 的 `healthPlanFor` / `lightCheckFor`；`environment-health.test.ts` 的计划用例 |
| A-45 | Phase 7 · §3 "健康检查日志也落对象存储" | "构建日志与健康检查日志都落对象存储（`env_builds.log_key`）" | 体检日志落 **`environments.health_log_key`**（008 迁移新列），key 与构建日志同一个前缀与 slug 规则（`env-logs/<slug>/<rev>/<runId>.health.log`） | 体检不是一次构建尝试：`env_builds` 一行 = 一次 `docker build` 的尝试（attempt / error_class / duration 都是它的语义），把体检塞进去会多出一批"不是构建"的行，而那正是按 kind 汇总成本时最容易被当成假账的形态。落点与前缀一致，所以 UI 的只读代理是一段代码 | 008 迁移的 `health_log_key`；`health.ts` 的 `logKey`；`build.ts` 的 `envHealthLogKey`；环境页的 `?health=` 日志路由 |
| A-46 | Phase 7 · §2 清理 | "清理：保留最近 10 个 revision；被 sandboxes 表引用过的 image_digest 永不清理" | 清理的对象**只有镜像**：`planRevisionCleanup()` 算计划（窗口 10 + 引用 + 被窗口内版本共用的 digest），`pruneRevisionImages()` 用注入的 `removeImage` 端口执行（生产 = `docker image rm`）；`environments` 的行一个都不删 | `runs.env_revision` 指向某一版——删行会让"这次执行当时用的是什么环境"变成悬空引用，而那是排障要看的第一条线索。行很小、镜像很大，所以清理只对后者动手。"被窗口内版本共用"是必须的一条：回滚 / promote 之后可能有两版指向同一个 digest，删了就把正在用的那一版一起弄坏 | `revision.ts`；`store.ts` 的 `listReferencedDigests`；`runtime.ts` 在每次新镜像建出来之后后台跑一次 |
| A-47 | Phase 7 · §4 UI 与日志代理 | "只读路由"；观察窗的文件头写着"这个服务只有 GET" | 环境页有**一条 POST**（`POST /env/{projectKey}/build`，manual 入队，回 202 不等构建）；日志路由形如 `GET /env/{projectKey}/logs/{revision}?build=<bld_id>`（或 `?health=<run_id>`），**对象 key 由服务端用校验过的四段拼**，客户端不传 key | ① 一个 GET 不该有副作用（浏览器预取、链接重放、爬虫都会踩到"重建环境"）；这条写口的合法性来自它的位置——只绑定回环、无鉴权、单租户（M1 的真 API 面不在这里长）。② 让客户端传 key 等于开一个任意读的口（`../`、别人的仓库、别的前缀）；服务端拼 key 之后"只允许 `env-logs/` 前缀"是结构上的性质，不需要一条 if 挡着 | `web/server.ts` 的 `parseEnvRoute` / `handleEnvRoute`；`web/env.ts` 的 `readEnvironmentLog` / `logRequestOf`；`web-env.test.ts` 的路由与 400/404/503 用例 |
| A-48 | Phase 7 · §5 Run 侧回退 | "用 Layer 1 的语言镜像" | 新增 `provider/image-ref.ts`（把 `resolveImageRef` 从 `test/support.ts` 搬过来，脚手架改成 re-export）；`runtime.ts` 缺省用它把 Layer 1 的 tag 解析成 digest，解析不到返回 null、由解析层抛出可行动的错误 | `SandboxSpec.image` 只收 digest，所以生产路径也需要"tag → digest"这一步；而产品代码 import 测试脚手架是反向依赖（AGENTS.md §1）。搬迁零成本（调用方按 `test/support.ts` 的路径 import，一行不动），留在脚手架里则意味着 P7 的 Run 侧回退要么复制一份实现、要么永远只能跑在测试里 |

**已经预知的两条偏差**（实施时必须确认并回填）：

- **`bash` 工具的入参从 argv 改成 shell 字符串**：设计文档 §F.2 已论证（模型先验 + 沙箱层契约不变），
  实施时把 prompt / `sandbox.md` / README 的措辞一起改掉，并在 A 表里记一条；
- **`list` 改名 `ls`**：模型对 `ls` 的先验更强，旧名保留一个版本作为别名（`dispatch` 层兼容），
  下个版本删掉。

> **两条都在 P1 落地并回填（见 A-1 / A-2）**，而不是留到 P11：Operations 化与提示词重写
> 都在 P1，改名与缩写形态是同一批改动的一部分；拆成两批只会让每个调用点被改两遍。
> 沙箱侧契约（`POST /exec` 只收 argv）**一个字没改**，两条偏差都只发生在工具层。

---

## 附录 B · 与 pi 的对应表（文件级）

| pi | 我们（M2） | 关系 |
|---|---|---|
| `packages/agent/src/agent-loop.ts` | `agent-runtime/src/loop.ts` | 同构：双层循环、事件流、source 顺序、length 截断保护；预算改走钩子 |
| `packages/agent/src/types.ts`（AgentTool/AgentMessage/AgentEvent） | `agent-runtime/src/types.ts` | 同形状；事件多了 `context_compiled` / `compaction` / `note` |
| `packages/agent/src/agent.ts`（Agent 类 / steering 队列） | `agent-runtime/src/loop.ts` 的 `AgentLoopConfig.getSteeringMessages` + CP 的 `steer()` | 我们不做有状态 Agent 类（Run 是一个函数调用，状态在 store 里） |
| `packages/coding-agent/src/core/session-manager.ts`（entries 树） | `agent-runtime/src/session/entries.ts` + `control-plane/src/session/postgres.ts` | 只取 entries + 用量 + 意图/结算；不取 values/lists/分支 |
| `packages/coding-agent/src/core/compaction/compaction.ts` | `agent-runtime/src/compaction/*` | 算法逐条对齐（估算基线、切点、split turn、累积文件清单） |
| `packages/coding-agent/src/core/tools/*`（read/write/edit/bash/grep/find/ls） | `agent-runtime/src/tools/*` | 语义对齐；执行落点从本地 FS 换成沙箱 Operations |
| `packages/coding-agent/src/core/tools/truncate.ts` | `agent-runtime/src/tools/truncate.ts` | 同语义（2000 行 / 50KB / 不返回半行） |
| `packages/coding-agent/src/core/system-prompt.ts` | `agent-runtime/src/prompt/system.ts` | 同结构（分区）；技能 XML 格式一致 |
| `packages/coding-agent/src/core/skills.ts` | `agent-runtime/src/skills/*` | 同一标准（agentskills.io）、同一 progressive disclosure |
| `packages/coding-agent/src/core/project-trust.ts` | 信任门（P12） | 同一原则：项目资源要信任后才加载 |
| `packages/ai`（Model / Models / streamFn） | `agent-runtime/src/model/*` | 我们只有 2 家 provider，不做注册表与插件 |
| `packages/agent/src/harness/**`（operation 状态机 / lanes / forks） | **不搬** | M3 的参考实现（设计文档 §B.7） |
| `packages/coding-agent/src/core/extensions/**` | **不搬** | 我们的扩展点是 Skill 与 MCP |
| （pi 明确不做 MCP） | `agent-runtime/src/mcp/*` | **我们的新增**（设计文档 §F.5） |

---

## 附录 C · 与 M3 的接口（留给下一阶段）

| M2 产物 | M3 怎么用 | 不能怎么用 |
|---|---|---|
| `sessions` + `runs` | 调度器与触发器（label / 评论 / cron）：什么时候起下一个 Run、谁先跑、配额与并发 | 不能让调度器重建会话表（轮次边界已经落在 `start_entry_id` / `end_entry_id` 上） |
| `runs.sandbox_id` | 空闲沙箱复用（同一个会话的下一轮不重建沙箱） | 不能把"沙箱保活"写进循环（属于调度层） |
| `session_entries`（只追加） | 同一个 Run 的跨进程恢复（读 entries 重建） | 不能改成可变（要保持 append-only 才能做审计与回放）；会话分叉要用 `parent_id` 扩展，不是改表 |
| `tool_invocations`（intent/settlement） | 恢复：`replay: safe` 重放、`never` 合成中断结果 | 不能把"自动重放"塞进 M2 的循环（恢复属于调度层） |
| `usage_ledger` | 成本看板 / 配额 / 告警 | 不能把配额判断塞进循环（属于 `shouldStopAfterTurn` 策略） |
| `model_requests` | Trace / 回放 UI | 不能把 trace 当唯一真相（entries 才是） |
| `ToolMeta.requiresApproval` | 审批流挂起与放行 | 不能在 M2 就拦截（单租户，拦截只会妨碍自己） |
| `environments.revision` | 环境自进化（构建失败自愈结果固化回项目级） | 不能静默改 revision（每次都要有构建记录） |
| `repo_symbols` / `repo_refs` | 影响面分析（"改了 A 会碰谁"）等分析类功能 | 不能把索引当唯一真相（它是派生物） |
| `skills` / `skill_runs` | 技能效果统计（哪个技能真的有用） | — |
| ContextCompiler 的分区 | Project Memory 作为新分区注入 | 不能破坏确定性（记忆注入必须可复现） |

---

## 附录 D · 测试 fixture 清单

| fixture | 位置 | 用于 |
|---|---|---|
| `node-ts-basic` | `test/fixtures/repos/` | P5（signals 级）、P8（TS 符号）、P9（地图金标准） |
| `python-poetry` | 同上 | P5（dockerfile 级）、P8（Python 符号） |
| `monorepo-devcontainer` | 同上 | P5（devcontainer 级 + degraded）、P8（增量） |
| `dockerfiles/*.Dockerfile` | `test/fixtures/dockerfiles/` | P6（错误分类与硬约束校验） |
| `build-logs/*.log` | 同上 | P6（错误分类样本） |
| `index/*.{ts,py,go,rs,java,rb,php}` | `test/fixtures/index/` | P8（每语言符号金标准） |
