# reuben-cloud

> 一个云端自主编码 Agent 平台。你下班，它上班。
>
> 沙箱子系统的**实施规格**（Phase 拆分、测试要点、验收标准）见 [`docs/sandbox-spec.md`](docs/sandbox-spec.md)；**设计文档与取舍理由**见 [`docs/sandbox.md`](docs/sandbox.md)。
>
> **第一次读代码？** 先看 [`docs/exec-链路-大白话.md`](docs/exec-链路-大白话.md)（一次 exec 从 HTTP 到终态事件的完整链路）和 [`docs/typescript-速查.md`](docs/typescript-速查.md)（本仓库用到的 TS 语法速查）。

---

## 0. 这是什么

reuben-cloud 是一个**跑在云端的自主编码 agent**。用户选定一个远端 GitHub 仓库和分支，给它一个任务（"修掉 #123"、"把 lodash 升到 4.x"、"给 `src/billing` 补单测"），然后关掉电脑。agent 在隔离沙箱里 checkout 代码、读代码、改代码、跑测试，最后交出一个可 review 的 PR。

**一句话定位：把"异步、无人监督地完成一个软件工程任务"这件事做成可靠的、可观测的、可授权的服务。**

### 为什么是"异步"而不是"云端"

"关了电脑也能跑"的本质诉求不是"云端"，而是**异步长任务**。这个区别决定了整个产品的形态：

| | 本地 agent | 异步云端 agent |
|---|---|---|
| 失败代价 | 便宜，重跑就行 | 贵：烧钱 + 烧信任 |
| 用户预期 | 陪着我干活 | **我不在的时候把事办成** |
| 核心指标 | 交互体验 | **任务成功率 + 产出可信度** |
| 第一优先级 | 能力广度 | 验证闭环 + 可观测性 |

所以本项目的第一性目标是：**在一类任务上，成功率足够高，高到用户敢关电脑。** 不是"什么都能干"。

### 非目标（明确不做）

- ❌ 拖拉拽工作流编排 —— 会退化成一个 Coze，且 eino/LangGraph 那套 DAG 编排的价值在此不成立
- ❌ 通用聊天助手 / 通用 RAG 问答
- ❌ 模型训练、微调
- ❌ 多元化 Git 平台（MVP 只做 GitHub；GitLab 是 M6 之后的事）
- ❌ 多 agent 花式协作（先跑通单 agent + 强验证）

---

## 1. 概念模型

先把领域模型定清楚，后面所有子系统都挂在这上面。

```
Workspace (组织/个人空间)
 └── Project            一个绑定的远端仓库（GitHub App 安装 + 仓库选择）
      ├── Environment   这个仓库的运行环境定义与构建产物（版本化）
      ├── Skill         可复用的能力包（工具 + 提示词 + 约束）
      ├── Memory        这个仓库的长期经验（跨会话）
      └── Task          一个意图（"修 #123"）
           └── Run      一次执行尝试（可重试、可并行、可取消）
                ├── Session    沙箱实例 = Sandbox + workspace 卷
                ├── Transcript 完整的模型输入输出 + 工具调用流
                └── Artifact   产出物：patch / PR / 报告
```

**关键区分：**
- **Task ≠ Run**。Task 是"要做什么"，Run 是"这一次尝试"。同一个 Task 可以有多次 Run（重试、换策略、并行试两种方案）。没有这个区分，重试和对比就无从谈起。
- **Environment 是一等公民，不是配置项**。它有自己的生命周期、版本、构建日志和健康状态。这是本项目和"随便拉个镜像"的最大区别。
- **Session 是 Run 的运行时，不是 Run 本身**。一次 Run 一个沙箱，Run 结束即销毁。沙箱是易失的，不持有业务状态——挂起 / 快照 / 跨节点迁移推迟到 M3（见 §3.1）。

### 状态机

```
Task:    pending → running → (succeeded | failed | cancelled | needs_review)
Run:     queued → provisioning → building → executing ⇄ waiting_for_input
                 → verifying → (succeeded | failed | cancelled | timed_out)
Sandbox: CREATING → READY ⇄ BUSY → DESTROYED        (失败 → ERROR)
Env:     draft → building → ready → (degraded | failed)
```

沙箱的 5 个状态是刻意收窄的：每多一个状态，所有状态转换函数都要多考虑一种"从这里能不能到那里"。暂停 / 挂起 / 快照不是 MVP 需要的语义。

状态机要显式建模并持久化。**恢复能力全靠它** —— 进程崩了、节点挂了，靠状态机知道该从哪继续。

---

## 2. 系统架构

```
┌──────────────────────────────────────────────────────────────────┐
│  Web UI (Next.js)                                                │
│  任务面板 · 实时 Transcript · Diff 视图 · 环境构建 · 工具 / MCP  │
│  权限策略 · 成本看板 · Trace 回放                                │
└───────────────────────────┬──────────────────────────────────────┘
                            │ HTTP + SSE/WS
┌───────────────────────────▼──────────────────────────────────────┐
│  Control Plane (Node/TS)                                         │
│  ┌────────────┬────────────┬────────────┬─────────────────────┐  │
│  │ API Gateway│ Task/Run   │ Scheduler  │ Trigger Router      │  │
│  │  (Hono)    │ Orchestr.  │ + Quota    │ (webhook/cron/issue)│  │
│  └────────────┴────────────┴────────────┴─────────────────────┘  │
│  ┌────────────┬────────────┬────────────┬─────────────────────┐  │
│  │ Sandbox    │ Env Builder│ Context    │ Tool Registry       │  │
│  │ Manager    │            │ Compiler   │ (+ MCP / Skills)    │  │
│  └────────────┴────────────┴────────────┴─────────────────────┘  │
│  ┌────────────┬────────────┬─────────────────────────────────┐   │
│  │ Permission │ Secret     │ Observability / Cost            │   │
│  │ Engine     │ Broker     │ (OTel + trace store)            │   │
│  └────────────┴────────────┴─────────────────────────────────┘   │
└───────┬──────────────────────────────┬───────────────────────────┘
        │                              │
┌───────▼──────────┐        ┌──────────▼─────────────────────────┐
│ Postgres         │        │  Data Plane: Sandbox Provider      │
│ + pgvector       │        │  ┌──────────┬──────────┬────────┐  │
│ (状态/索引/记忆) │        │  │ Docker   │ K8s      │ Fire-  │  │
│ Redis (队列/锁)  │        │  │ (MVP)    │ +gVisor  │ cracker│  │
│ Object Store     │        │  └──────────┴──────────┴────────┘  │
│ (归档/日志/产物) │        │  沙箱只执行不决策（Agent 在 CP）   │
└──────────────────┘        └────────────────────────────────────┘
```

**控制面 / 数据面分离**是核心架构原则。控制面管状态和调度，数据面是易失的、可重建的沙箱。这样沙箱可以随便挂、随便换供应商，控制面的状态永远是真的。

---

## 3. 子系统详解

### 3.1 沙箱运行时（Sandbox）

**这是整个项目的地基，也是最容易低估的部分。**

> **完整方案见 [`docs/sandbox.md`](docs/sandbox.md)。** 这里只写定位和边界，细节不在 README 里重复。

#### 边界：沙箱是执行环境，不是 Agent

**Agent 循环跑在 Control Plane，不在沙箱里。** 沙箱只提供 9 个端点：`create / destroy / health / exec / read / write / list / diff / archive`。

| 沙箱负责 | 沙箱不负责 |
|---|---|
| 创建 / 销毁运行环境 | 决定执行什么命令 |
| 执行命令并流式返回输出 | 判断任务是否成功 |
| 文件读写 / 列目录 | Agent 推理、上下文管理 |
| 产出 diff / workspace 归档 | Task 调度、重试策略、成本计算 |
| 资源限制、网络与权限隔离 | 保存业务状态 |

**判据：任何"要看情况决定"的逻辑都不属于沙箱。**

**为什么 Agent 循环不能进沙箱**：① 模型 API Key 是高价值目标，而沙箱里执行的是任意代码（可能被提示注入操纵）；② 循环逻辑是可迭代资产，改 prompt 不该触发镜像重建；③ 决策与执行物理分离，任何一方被攻破不自动等于另一方失守。延迟代价为零 —— 一次工具调用以秒计，HTTP 往返是毫秒级。

**这条边界落在接口上的三个体现**：

1. spec 里**没有 `repo` 字段** → clone 是 CP 的事，沙箱不需要知道 GitHub 是什么
2. spec 里**没有 `secrets` 字段** → **沙箱内不存在任何凭据**（见下）
3. spec 里**没有 `network` 字段** → 出网白名单是全局静态配置，不是每个任务可调的参数

#### 网络与凭据：两个 MVP 级别的安全决定

**沙箱内零凭据。** GitHub App 私钥、installation token、模型 API Key、搜索/MCP 凭据——全部只在 CP。clone 和 push 都由 CP 执行：CP clone → tar → `PUT /files` 灌进沙箱；产出走 `GET /diff` → CP 侧 `git apply` → CP push。

沙箱是爆炸半径最大的地方（执行任意代码 + 内容全部不可信 + 可能被提示注入）。做成零凭据之后，一次成功的注入能拿到的上限是"改坏这个仓库的工作区"，而不是"拿到一个能写仓库的 token"。**没有东西可偷，就不需要防偷。**

**沙箱出网只为一个目的：装依赖。** 沙箱接在 internal 网络上（无出口路由），唯一出口是一个全局常驻的 CONNECT 代理，白名单是**全局静态**的：npm registry / pypi / go proxy / crates.io / maven / apt 源。**白名单里没有 `github.com`**。

代理是隧道式的——只看域名、不解密流量，因此它**不能**做内容检查、也**不能**注入凭据。这个"不能"是刻意的边界：正因为它足够简单，才能在 MVP 里做对。未来要注入第三方密钥时，把它替换成 credential service（§3.5），沙箱侧无感。

用域名而不是 IP 白名单，是因为包管理器源全部走 CDN、IP 段会漂移——IP 白名单要么很快失效，要么被迫开得很大（等于没有白名单）。

#### 接口分两层

变化频率不同：**换 provider 只动第一层，加执行能力只动第二层。**

```ts
// 第一层：Provider（CP 进程内；M0 只有 LocalDockerProvider 一个实现）
interface SandboxProvider {
  create(spec: SandboxSpec): Promise<SandboxHandle>
  destroy(sandboxId: string): Promise<void>
  health(sandboxId: string): Promise<SandboxHealth>
}
// 第二层：容器内 sandbox-agent 的 HTTP + SSE API（9 个端点，契约稳定）
```

三个方法就够，**不做 provider 插件框架** —— 一个实现也是接口，它的意义是把"要碰 docker socket"圈在一个文件里，不是为了可插拔。

**Git checkout / status / log 一律走 `exec`**，不设专属 API。只有 `diff` 和 `archive` 独立成端点，因为一个输出结构化数据、一个是二进制大对象。

#### 命令执行：异步提交 + SSE 事件流

```
POST /exec {cmd: ["npm","test"]}  →  202 {execution_id}     ← 立即返回
GET  /exec/{id}/events            →  SSE: started / stdout / stderr
                                        / completed / failed / timeout / killed
```

- **`cmd` 是 argv 数组，没有隐式 shell** —— 需要管道就自己写 `["bash","-lc",...]`。直接消灭命令拼接注入
- **日志文件不是通信通道**，只做大输出与事后取证的持久化存储
- 每条事件带单调递增 `id`，支持 `Last-Event-ID` 重连重放
- 一个沙箱同时只允许一个 exec（对应 BUSY），要并发就开多个沙箱

#### 隔离强度（按阶段演进）

| 阶段 | 方案 | 隔离强度 | 适用 |
|---|---|---|---|
| **MVP** | **本地 Docker + hardening** | **弱** | **单租户 / 内部 / 受信任用户** |
| 第一次升级 | Docker + gVisor (`runsc`) | 中强 | 接第一个外部用户前的**硬门槛** |
| 规模化 | K8s + gVisor | 中强 | 多节点与容量调度 |
| 需要快照时 | Firecracker microVM | 强 | 极致冷启动 / 跨节点恢复 |

**Docker 容器共享宿主机内核，是隔离边界，不是安全边界。** 内核 LPE 或运行时漏洞可以直接逃逸。加固（`--cap-drop=ALL`、`--read-only`、非 root、seccomp、pids/mem 限制、无 docker.sock、internal network）做的是**降低爆炸半径**，不是"防住有动机的攻击者"。

所以这是一条**排期约束**而不是免责声明：MVP 可以上，但不能带着 MVP 的隔离去接不信任的代码。升级到 gVisor 是性价比最高的一步，且只换 provider 实现，上层 API 一行不改。

#### 后期演进（**不在 MVP 内**）

预热池、暂停/恢复、快照/迁移、overlayfs 分层、嵌套容器、动态池容量 —— 全部推迟。每一项都写清了"什么时候才需要它"，见 `docs/sandbox.md` §H/§I。

**为什么推迟**：预热池一次性引入休眠态、配置注入、复用计数、消毒四套机制；快照状态让每个状态转换都要考虑"恢复后变量还在不在"。而 MVP 最需要的是**"创建即可用"的简单语义**。冷启动慢的问题，等它真的成为瓶颈再解。

#### 关键指标

创建（镜像已缓存）p95 < 5s、简单命令往返 p95 < 200ms、沙箱逃逸 = 0。预热池相关指标随预热池一起定义，现在写是空头承诺。

---

### 3.2 环境构建（Environment Builder）

**核心洞察：不要把"镜像"当静态产物，要当一条构建管线。**

"提前弄好基础镜像"这句话听着简单，实际是个独立产品。真实仓库要语言工具链、包管理器、Postgres、Redis、测试要 docker-in-docker、e2e 要浏览器、拉依赖要出网。手工做镜像 = 只能服务三个仓库。

#### 三层结构

```
Layer 1  Base        你维护的 5-10 个官方基础镜像
                      ubuntu-dev / node-dev / python-dev / go-dev / fullstack / rust-dev
                      ↓
Layer 2  Project     从仓库自动推断 + 构建（可缓存、可版本化）
                      优先复用 devcontainer > Dockerfile > LLM 推断
                      ↓
Layer 3  Session     会话期增量（装新依赖、seed 数据），可"固化"回 Layer 2
```

#### Layer 2 的三级推断策略

```
L1  存在 .devcontainer/devcontainer.json  →  直接复用（最优先，规范成熟）
L2  存在 Dockerfile / docker-compose.yml  →  复用 + 叠加 agent 必需组件
L3  以上都没有                            →  信号推断 + LLM 生成 Dockerfile
```

**L3 的信号来源**：`package.json` / `go.mod` / `requirements.txt` / `Cargo.toml` / `Makefile` / `.github/workflows/*` / `README` 里的安装说明 / 目录结构。

**LLM 生成 Dockerfile + 自愈循环**（这一步很实用）：

```
生成 Dockerfile
  → 构建
  → 失败? 把构建错误 + Dockerfile + repo 信号 喂回模型 → 重新生成
  → 最多 N 轮（比如 3 轮）
  → 仍失败 → Env 状态置 failed，保留全部日志给用户看
```

**构建即缓存**：以 `hash(base_image + repo_signals + builder_version)` 为 key。命中直接复用。团队里第一个人构建，后面所有人秒开 —— 这个收益是复利的。

#### 环境健康检查

构建完**必须**跑 smoke test（`npm ci && npm run build` / `go build ./...` / `pytest --collect-only`），把"环境是否可用"变成一个**显式的、可展示的状态**（`ready` / `degraded` / `failed`），而不是等到 agent 跑起来才发现装不上依赖。

degraded 的例子：构建成功但 `docker compose up` 起不来 → 明确告诉用户"这个环境不能跑集成测试"，agent 也会据此调整策略（跳过集成测试，而不是反复失败）。

#### 环境版本化

Environment 有版本号，可 diff、可回滚。用户手动在会话里装了个包并验证有效，可以**固化**（promote）回 Project 层，下次直接可用。

**这是"环境自进化"的入口** —— 见 §3.8。

---

### 3.3 上下文管理（Context Compiler）

**核心原则：上下文是有预算的。每次调用模型前，要"编译"一个上下文包，而不是无脑拼接历史。**

一个 `cat` 大文件就能爆窗口。上下文质量直接决定 agent 的上限。

#### 仓库索引层（离线，增量更新）

| 索引 | 技术 | 用途 |
|---|---|---|
| 符号索引 | tree-sitter AST | 提取函数/类/引用关系，精确跳转 |
| 全文索引 | ripgrep + trigram | 精确字符串/正则搜索 |
| 向量索引 | pgvector + code embedding | 语义检索（"错误处理在哪"） |
| 依赖图 | import/call graph | 影响面分析（改了 A 会影响谁） |
| **仓库地图** | 符号图 + PageRank | **最重要：压缩成几 K token 常驻上下文** |

**仓库地图（Repo Map）是被验证过最有效的一招**（Aider 的做法）：在符号引用图上跑 PageRank，取排名最高的 N 个符号，连同它们的签名，生成一份"这个仓库长什么样"的骨架，几 K token 就能让模型有全局感。这比向量检索 RAG 更稳定，因为它给的是**结构**而不是**相关片段**。

#### 上下文预算分配

每次模型调用前，`ContextCompiler` 按预算组装：

```
总预算 100%
├── 系统提示 + 工具定义        15%   (固定，可缓存)
├── 仓库地图                  15%   (半固定)
├── 任务描述 + Plan           20%   (结构化状态)
├── 近期对话历史              25%   (最近 N 轮，完整)
├── 相关文件片段              15%   (按需检索 + 按需回读)
└── 工具结果摘要              10%   (大结果外置)
```

超出预算时按优先级**驱逐**，而不是报错。

#### 三个关键技巧

**① 工具结果外置（Result Offloading）**

大结果永远不进上下文。工具执行结果超过阈值 → 写到沙箱文件 → 上下文里只放**摘要 + 路径 + 行数**，模型需要细节时自己 `read` 指定行范围。这一招能省掉大量 token。

**② 编辑用 diff，不用全文**

模型改文件输出 patch（unified diff）而不是整个文件重写。省 token、更准确、天然产生变更记录。

**③ 历史压缩**

旧对话用模型总结成结构化要点（做了什么、结论是什么、踩了什么坑），保留最近的完整轮次。压缩要在**任务边界**做，不要在任务中途打断。

#### 子 agent 上下文隔离

探索型子任务（"这个功能在哪些地方被调用"）用独立上下文跑，**只返回结论**，不返回过程。控制面只看到压缩后的结果。

#### 长期记忆层（Memory）

跨会话的仓库知识，这是自进化的基础：

```
"这个仓库的集成测试需要先 docker compose up -d postgres"
"src/legacy 目录禁止修改，是自动生成的"
"这个项目的 lint 规则很严，提交前必须跑 make lint"
"用 vitest 不用 jest，配置在 vitest.config.ts"
```

写入时机：Run 结束后，从 transcript 里提取"这次学到的新东西"。注入时机：ContextCompiler 组装时按相关性检索。

---

### 3.4 工具管理（Tool Registry）

**单一事实来源原则：内置工具、Skill、MCP 工具全部注册到同一个 Tool Registry，agent 只从这里取。** 权限、审计、UI 展示、成本归因全部统一在注册表上。

```ts
interface ToolDef {
  name: string
  description: string          // 直接影响模型调用准确率，值得反复打磨
  schema: ZodSchema            // → JSON Schema 给模型
  category: 'read' | 'write' | 'execute' | 'network' | 'vcs' | 'external'
  risk: 'safe' | 'caution' | 'destructive'
  requiresApproval: PolicyRule
  handler: (input, ctx: ToolCtx) => Promise<ToolResult>
  budget: { maxOutputBytes: number; timeoutMs: number }  // 与上下文外置联动
}
```

#### 工具的三个来源

1. **内置工具**：文件读写、bash 执行、代码搜索、git 操作、测试执行、浏览器（Playwright）
2. **Skill**：一组工具 + 提示词 + 约束的打包，粒度比工具粗（如"写单测"skill、"依赖升级"skill）
3. **MCP 工具**：通过 Model Context Protocol 接入外部能力，动态发现

#### MCP / Skill 管理界面（用户要的那块）

**本质就是配置管理，别过度设计：**

- 服务器/技能列表 + 启用开关
- 连接配置表单（从 MCP 的 schema 自动生成）
- **工具白名单**：一个 MCP server 暴露 20 个工具，只放行 5 个
- 健康检查 + 连接状态 + 最近错误
- 每个工具的调用统计（次数、成功率、平均耗时）

#### 工具质量的度量

工具描述写得好不好，直接决定模型会不会用。所以要记录：**调用成功率、错误类型分布、平均轮次**。某个工具频繁被误用 → 说明描述要改。这是"工具自进化"的入口。

---

### 3.5 权限与安全（Permission & Security）

**这是唯一一个做错了会出事的子系统。** agent 有仓库写权限、能执行任意代码、能出网 —— 这是供应链攻击的完美目标。

#### 四层权限模型

```
身份层   用户 → 组织 → 项目 → 会话
         GitHub App 安装授权（不是 PAT），token 短期化 + 按需下发 + 自动轮换

资源层   能访问哪些仓库 / 哪些分支 / 能否 push / 出网白名单

操作层   工具级权限（能否删文件 / 装包 / curl 外网 / 执行 git push）
         由 ToolDef.risk 驱动，策略可配

审批层   Human-in-the-loop：危险操作挂起等人工确认
         策略：always | never | when-risky | 自定义规则
```

#### 密钥代理（Secret Broker）—— M2，不在 MVP 内

> **MVP 的做法：沙箱内根本不存在凭据。** GitHub 访问用**短生命周期 GitHub App installation token**——私钥只在 CP，token 按 Run 签发（scope 限定到选定仓库、TTL 1 小时），**clone 和 push 全部由 CP 执行**，token 从不进入沙箱。
>
> 这是比"把短期 token 放进沙箱"更强的做法：不是"泄露了也不心疼"，而是"没有东西可泄露"。代价是仓库要过一次网络（CP → 沙箱，内网），换来的是任何产出都必须经过 CP 才能变成 PR。
>
> **为什么现在不做密钥代理**：MVP 里没有第三方密钥可注入。做一个需要 MITM 解密流量、往沙箱装 CA 的代理，去注入一个根本不在沙箱里的 token，是纯粹的复杂度。触发条件是"用户开始往任务里配第三方 API key"。

**以下是 M2 的设计。明文 secret 永不进入沙箱**：沙箱内只有占位符，真实值由沙箱外的一个代理在网络层按域名注入：

```
沙箱内:  curl https://api.stripe.com/... -H "Authorization: Bearer $STRIPE_KEY"
         ($STRIPE_KEY 实际值是 "ns-placeholder-xxx")
                ↓ 代理拦截，按域名匹配
出网:    Authorization: Bearer sk_live_real_key...
```

这样即使 agent 被注入攻击、或者用户在 transcript 里看到全部内容，**密钥也不会泄露**。同时代理记录所有出网请求（审计）。

#### 提示注入防御（Prompt Injection）

**这是当前没有完美解的问题，只能层层设防，且必须作为架构原则而不是事后补丁：**

- **内容分级**：仓库内容 / 网页内容 / issue 正文 一律标记为**不可信**。不可信内容**不能改变系统策略、不能绕过审批、不能读 secret**
- **凭据最小化**：沙箱内根本没有凭据（MVP），所以"诱导模型泄露 secret"这条攻击路径不存在。这是唯一一条不依赖"模型不被骗"的防线
- **出网白名单**：默认拒绝，只开依赖源，且**不含 `github.com`**——连"把代码推到攻击者仓库"这条路也堵掉
- **完整审计**：所有工具调用、文件变更、命令执行、出网请求全量落盘，可导出、可追溯
- **高危操作二次确认**：`rm -rf`、`git push --force`、修改 CI 配置、改动 `.env`。**注意这类限制的性质是产品策略（让用户知情、让产出可 review），不是安全边界**——命令黑名单覆盖不了无限种写法，把它当防线会产生安全幻觉。安全边界只有上面那四条

> 详见 `docs/sandbox.md` §F.5「命令黑名单不是安全机制」。

#### 产出交付方式

**默认产出 patch / PR，不直接改用户分支。** 这条既是安全边界也是信任边界。

---

### 3.6 任务编排与调度（Orchestration）

#### 触发器

| 触发方式 | 场景 |
|---|---|
| 手动 | UI 上点"开始" |
| GitHub Issue label | 打上 `reuben-cloud` 标签自动接活 |
| PR 评论 | `@reuben-cloud 帮我修一下这个测试` |
| Webhook | 对接内部系统 |
| **Cron 定时** | 每天跑依赖升级检查、每周补测试覆盖率、定期扫 TODO |

#### 调度器

- 优先级队列（用户手动 > webhook > 定时）
- 并发限制（按用户 / 组织 / 仓库三级）
- 配额（token + 沙箱时长 + 并发数）
- 公平调度，防止一个大组织饿死所有人

#### 定时任务的正确形态

定时任务在核心跑通后加，**成本极低、价值极高**。典型：

```
每天 02:00  扫描依赖安全公告 → 有高危 → 建 Task 自动升级 + 跑测试 + 开 PR
每周一 09:00  统计覆盖率下降的模块 → 建 Task 补测试
每月 1 号   扫描超过 90 天未处理的 TODO / FIXME → 汇总报告
```

这是"你睡觉时它干活"最直观的体现，也是**演示价值最高**的功能。

#### 长任务体验

一个任务跑 30 分钟，UI 必须：

- **实时流式** transcript（SSE/WebSocket）
- **中途插话**（steering）：用户看到 agent 走偏，直接发消息纠正，不打断当前执行
- 暂停 / 取消 / 重试
- 检查点恢复（从状态机恢复，不是从头再来；快照是更后面的事）

---

### 3.7 验证与可信度（Verification）

**这是"敢不敢关电脑"的答案。没有验证闭环的 agent 产出的是"看起来对"的垃圾 PR，比不产出更伤信任。**

#### 验证阶梯

```
语法检查 → lint → build → 单元测试 → 集成测试 → e2e
   (快，必跑)                              (慢，按环境能力)
```

按 `Environment` 的健康状态决定能跑到哪一级。degraded 环境就跑不了集成测试，要显式告知。

#### 自验证循环

**Agent 必须自己跑验证，失败自己修，N 次后放弃并诚实报告。**

这是 agent 循环里的一等公民，不是可选步骤。写代码 → 跑测试 → 失败 → 读错误 → 改 → 再跑。这个循环的质量决定了产出质量。

#### 可信度评分

给每个 Run 的产出打分，让用户一眼判断要不要细看：

```
✓ 测试通过 (新增 12 个，全部通过)
✓ build 通过
✓ lint 无新增告警
⚠ 改动 8 个文件，+340/-120 行
⚠ 新增依赖: date-fns@3.0.0
✗ 未覆盖 src/payment/refund.ts 的错误分支
```

评分维度：验证通过情况、diff 规模、影响面（依赖图）、是否引入新依赖、是否触碰敏感文件、测试覆盖率变化。

#### 产出形态

patch 文件 / GitHub PR（带完整描述）/ 结构化报告。**永远是 patch，不是"我直接改了你的分支"。**

---

### 3.8 自进化（Self-Evolution）

分四层，**从保守到激进，且必须有人在环上 + 可回滚**。自动改自己策略的系统极易退化，没有评估集的"进化"是随机游走。

#### L1 记忆进化（安全，先做，收益最大）

Run 结束后从 transcript 提取经验，写入 Project Memory。

- **输入**：这次踩了什么坑、环境有什么特殊性、什么做法有效
- **输出**：结构化记忆条目，下次同类任务自动注入
- **本质**：RAG over 自己的历史
- **可行性**：✅ 纯数据工程，无风险

#### L2 环境进化（安全，收益直接）

环境构建失败的自愈结果**固化**下来。

- 第一次遇到某仓库要装 `libvips` 才能 build → 修好后写入 Project 层 Dockerfile 片段
- 用户会话里验证有效的环境改动 → 可 promote 回 Project 层
- **效果**：同一个仓库的环境问题，只需要解决一次
- **可行性**：✅ 需要构建缓存 + 版本化，架构里已有

#### L3 提示词 / 工具进化（中等）

- **工具描述优化**：某工具失败率高 → 分析错误模式 → 改写描述 → 离线评估 → 上线
- **策略 A/B**：记录"哪种 plan 策略在哪类任务上成功率高"
- **可行性**：✅ 技术上简单，但**必须有评估集**（见下）

#### L4 技能自生成（激进，探索）

Agent 发现自己反复写同一段脚本 → **提议**固化成新 Skill → 人工审核 → 生效。

- "agent 给自己造工具"
- **等价的**：反复失败的 fix 模式 → 提议成新的验证规则
- **可行性**：⚠️ 机制容易做，难的是**判断它是不是真的变好了**

#### 自进化的前提：评估集（Eval Harness）

**没有评估集，自进化就是随机游走。** 这是 L3/L4 的硬前提：

- 构造一批**固定任务 + 已知正确答案**的回归测试集（可以从历史成功的 Run 里反向构造）
- 任何"进化"产物先在 eval 上跑，指标不降才允许上线
- 指标：任务成功率、平均轮次、平均成本、人工介入率

**架构约束**：所有进化产物先进**候选区（staging）**，跑离线评估，**人工批准**才进生产。可一键回滚。

---

### 3.9 可观测性（Observability）

Debug agent 比 debug 普通程序难十倍，因为不确定性来自模型。**回放能力是刚需。**

- **Trace**：一次 Run 的完整调用树（LLM 调用 / 工具调用 / 子 agent / 沙箱操作），OpenTelemetry 标准
- **回放**：能看到**任意时刻模型看到的确切输入**（编译后的上下文包全文）。这一条是整个可观测性里最重要的 —— 模型行为异常时，唯一能定位原因的方法
- **成本**：按 Run / Session / Repo / User 聚合 token + 沙箱时长，实时可见
- **指标**：任务成功率、PR 合入率、平均耗时、平均成本、人工介入率、工具失败率
- **告警**：成本异常、成功率下降、沙箱异常

---

## 4. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| **语言** | **TypeScript** | 前后端同构；MCP SDK 是 TS 优先；沙箱服务（E2B/Daytona）都有 TS SDK；瓶颈是集成复杂度不是吞吐 |
| 前端 | Next.js + SSE/WS | 流式 transcript、diff 视图、构建日志 |
| 后端 | Node + Hono/Fastify | 轻量、类型好 |
| 队列 | BullMQ (Redis) → 后期自建 | 起步够用 |
| 数据库 | Postgres + pgvector | 状态 + 向量索引一把梭，少一个组件 |
| 对象存储 | S3/MinIO | 归档、日志、产物 |
| 沙箱（MVP） | 本地 Docker + hardening | 单租户；`SandboxProvider` 接口圈住实现，换方案不动上层 |
| 沙箱（接外部用户前） | Docker + gVisor | 共享内核 → 用户态内核，性价比最高的一步 |
| 沙箱（规模化） | K8s + gVisor | 多节点调度；CP 不再需要持有 docker socket |
| 沙箱（需要快照时） | Firecracker | 毫秒级冷启动、跨节点恢复 |
| 代码索引 | tree-sitter + ripgrep + pgvector | 符号 + 全文 + 语义 |
| Agent 循环 | **自己写**（~500 行） | 循环本身很简单；框架的价值在 DAG 编排，而我们已经砍掉它 |
| MCP | 官方 TS SDK | 生态最全 |
| 模型 | 多provider 抽象 | 别绑死一家；按任务类型路由（便宜模型做检索，强模型做规划） |

### 关于 eino / LangGraph 这类编排框架

**不采用。** 理由：这类框架的核心价值是**图编排（DAG）**，而我们的 MVP 明确不做工作流编排。agent 主循环是一个 tool-use 循环，几百行就写完了，引入框架反而增加调试难度 —— 而 agent 项目最需要的就是**能看清每一步发生了什么**。

如果将来真要做工作流编排，那时再评估，而不是现在为它买单。

---

## 5. 路线图

### M0 · 骨架（跑通闭环）
> 目标：给一个 issue，产出一个 patch

**沙箱侧**（详细开发顺序见 `docs/sandbox.md` §K）：

- [ ] `sandbox-agent` 服务：`/health` + `/exec`(SSE) + `/files`（先在宿主机裸跑，不碰 Docker）
- [ ] 沙箱镜像：多语言运行时 + git + 非 root 用户
- [ ] `LocalDockerProvider`：加固参数 + internal 网络 + named volume
- [ ] egress-proxy：全局常驻，静态白名单只开依赖源，**不含 github.com**
- [ ] CP 侧仓库进出：clone → tar → 灌入沙箱；diff → apply → push（**凭据只在 CP**）
- [ ] `GET /diff` + `GET /archive` + 落对象存储
- [ ] 冒烟脚本 + 隔离红线测试（**必须在 Linux 上跑**）

**Agent 侧**（沙箱跑通之后再开始）：

- [ ] Agent 主循环（tool-use，4-8 个内置工具）
- [ ] 本地 Web UI：实时 transcript
- [ ] GitHub App：token 签发 + PR 创建
- [ ] 产出 unified diff

- [ ] **不做**：云端、多用户、权限、MCP、预热池、快照、密钥代理

### M1 · 云端化
> 目标：关掉电脑它还在跑，产出变成 PR

- [ ] **gVisor —— 硬门槛，接第一个外部用户之前必须完成**
- [ ] 远程沙箱（K8s + NetworkPolicy），CP 不再持有 docker socket
- [ ] 状态机 + 持久化 + 崩溃恢复 + 孤儿容器对账
- [ ] GitHub App 集成（安装授权 + PR 创建）
- [ ] 基础权限（仓库/分支范围）
- [ ] 产出 PR 而非 patch
- [ ] **不做**：预热池（推迟到 M3，冷启动真的成为瓶颈才做）

### M2 · 环境与上下文
> 目标：任意仓库能自动跑起来；agent 真正"懂"仓库

- [ ] Environment 构建管线（三层结构）
- [ ] devcontainer / Dockerfile 复用
- [ ] LLM 生成 Dockerfile + 自愈循环
- [ ] 环境缓存 + 版本化 + 健康检查
- [ ] 仓库索引（tree-sitter + ripgrep + pgvector）
- [ ] **仓库地图（Repo Map）**
- [ ] ContextCompiler（预算分配 + 结果外置 + diff 编辑）
- [ ] Tool Registry + Skill
- [ ] MCP 接入 + 管理界面

### M3 · 编排与规模化
> 目标：多任务、定时、可观测、可授权

- [ ] Task/Run 模型 + 队列 + 配额
- [ ] 触发器（label / 评论 / webhook / **cron**）
- [ ] 预热池（静态容量起步）+ 快照挂起恢复 —— 冷启动真的成为瓶颈时才做
- [ ] 审批流（Human-in-the-loop）
- [ ] 密钥代理
- [ ] 完整 Trace + 回放 + 成本看板
- [ ] 验证阶梯 + 可信度评分
- [ ] Project Memory

### M4 · 自进化（探索）
> 前提：Eval Harness 先建好

- [ ] Eval Harness（从历史成功 Run 反向构造回归集）
- [ ] L1 记忆进化 → [ ] L2 环境进化
- [ ] L3 工具描述优化 / 策略 A/B
- [ ] L4 技能自生成（候选区 + 人工批准）

---

## 6. 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| **环境构建做不好** | 只能服务少数仓库，产品不成立 | M2 全力投入；devcontainer 优先；自愈循环；构建缓存 |
| **沙箱逃逸** | 宿主机失守，全平台受影响 | MVP 限定单租户；**接外部用户前必须切 gVisor**；永不用 `--privileged` / docker.sock / bind mount；隔离红线进 CI |
| **成本失控** | 沙箱 + token 持续漏钱 | 沙箱 TTL 硬上限 + 用完即销毁（MVP）；预热池复用 / 快照挂起（M3）；配额；成本归因到 Run；模型分级路由 |
| **提示注入** | 供应链攻击，密钥泄露 | 内容分级；**默认无长期 secret**；出网白名单（白名单宽度 = 信任边界，需持续 review）；默认无 push；只交付 PR；审批流 |
| **产出不可信** | 用户不敢关电脑，产品价值归零 | 验证阶梯；自验证循环；可信度评分；只交付 PR |
| **赛道拥挤** | 模型厂商把此功能做成赠品 | 练手定位；差异化切口在私有化/垂直场景/内部平台 |
| **自进化退化** | 越进化越差 | Eval Harness 前置；候选区；人工批准；可回滚 |
| **eino/框架诱惑** | 引入不必要的复杂度 | 明确不采用；自己写循环，保持每一步可见 |

---

## 7. 设计原则（TL;DR）

1. **异步优先**：一切设计服务于"用户不在时把事办成"
2. **验证先于能力**：宁可在窄场景 90% 成功，不要宽场景 40% 成功
3. **环境是一等公民**：不是配置项，是有生命周期的实体
4. **上下文是编译出来的**：不是拼接出来的，有预算、有优先级、有驱逐
5. **默认最小权限**：默认不出网、不给 secret、不 push
6. **一切可回放**：模型看到了什么，必须能事后原样重现
7. **进化必须可回滚**：没有评估集的自进化是随机游走
8. **不做编排框架**：保持每一步可见，比抽象的图更有价值
