# reuben-cloud · 沙箱 MVP 实施 Spec

> 输入：`docs/sandbox.md`（v3 设计文档）。那份回答**为什么这样设计**，这份回答**先写哪个文件、函数长什么样、怎么测、什么算完成**。
>
> **权威顺序**：设计文档 > 本文档。本文与设计冲突时以设计为准；但本文附录 A 列出的偏差是**有意的**，每条都写了理由，改回来之前先读那条理由。

**怎么用这份文档**

- 一次只做一个 Phase，按顺序做。每个 Phase 末尾有一个 `- [ ]`，做完勾上。
- 每个 Phase 都按同一套模板写：**目标 → 交付物 → 具体如何实现 → 技术边界 → 测试要点 → 验收标准**。
- 「技术边界」是**这个阶段不做的事**的清单。它比「要做什么」更重要——写代码时容易顺手多做一个东西，那份清单就是拦你的。
- 第 1 步和第 3 步（本文 Phase 1/2/3 与 Phase 5）**不要合并**。§K 给的理由：sandbox-agent 的事件流、路径校验、进程组管理、输出合并是整个方案唯一有真正技术风险的部分。在裸机上把它调通，以后调试就永远不用先排除"是不是容器配置问题"。

---

## 0. 全局约定

### 0.1 命名

项目名是 **`reuben-cloud`**，全部小写、连字符。所有标识符统一改过（旧的 `nightshift` 一律作废）：

| 位置 | 值 |
|---|---|
| npm 包名 / monorepo | `reuben-cloud` |
| 沙箱容器名 | `reuben-cloud-sbx-{sandboxId}` |
| Docker 标签 | `reuben-cloud.sandboxId` / `reuben-cloud.runId` / `reuben-cloud.managed` |
| 命名卷 | `reuben-cloud-ws-{sandboxId}` |
| 内部网络 | `reuben-cloud-internal` |
| 出网代理容器 / 别名 | `reuben-cloud-proxy`（内网别名同名） |
| 执行日志 | `/tmp/reuben-cloud/exec/{executionId}.log`（路径变更理由见附录 A-1） |
| 工具结果外置 | `/tmp/reuben-cloud/out/{executionId}.txt` |
| 大 patch 外置 | `/tmp/reuben-cloud/diff/{executionId}.patch` |
| 分支前缀 | `reuben-cloud/<taskId>` |
| CP 临时目录 | `/tmp/reuben-cloud-cp/<runId>/` |

### 0.2 依赖策略

默认**不引依赖**。只有下面这些例外，每个都写明了理由；想加新依赖，先在这里加一行。

| 包 | 依赖 | 理由 |
|---|---|---|
| `sandbox-agent` | **零依赖** | 它要做的三件事（SSE、流式二进制、进程组）正是框架会藏起来的细节，而这正是唯一有真风险的地方 |
| `control-plane` | `pg` | Postgres 驱动，没有理由自己写 |
| `control-plane` | `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` | S3/MinIO 流式分段上传；签名逻辑不值得自己写 |
| `control-plane` | `@octokit/auth-app` + `@octokit/rest` | GitHub App JWT 签发 + REST；RS256 手写容易错 |
| `control-plane` | `@anthropic-ai/sdk` | 模型调用 |

**明确不引**：Hono/Fastify/Express（CP 的路由也不复杂，先用 `node:http`；真到了几十条路由再说）、dockerode（见 Phase 5）、tsx/ts-node/任何打包器（见 0.3）、zod（见 Phase 11）、ORM / 迁移框架（见 Phase 8）。

### 0.3 语言与运行时硬约束

从 `tsconfig.base.json` 来，所有转 TS 的代码都受它约束：

- Node ≥ 24，**原生类型擦除**：`node src/index.ts` 直接跑，没有构建步骤。
- `tsc` 只做 `--noEmit` 类型检查，**不产出任何产物**。
- 因此：**不能用 `enum` / `namespace` / 参数属性 / 装饰器**（都不是可擦除语法）；只导类型必须 `import type`；相对导入必须带 `.ts` 后缀；`verbatimModuleSyntax` 打开。
- 副作用：镜像里没有 `node_modules`、没有构建层——`COPY src` 直接跑。这个约束在这里变成了一份白送的礼物。

### 0.4 目标目录结构

```
reuben-cloud/
├─ packages/
│  ├─ sandbox-agent/            # 容器内执行层（Phase 1–3）
│  │  └─ src/
│  │     ├─ index.ts            # 启动、env、优雅退出
│  │     ├─ server.ts           # 路由表 + 鉴权 + 响应工具
│  │     ├─ ulid.ts             # 无依赖 ULID（~40 行）
│  │     ├─ exec/
│  │     │  ├─ registry.ts      # 单执行并发闸 + id 生成 + 状态表
│  │     │  ├─ spawn.ts         # argv 校验 → 进程组 → 管道接线
│  │     │  ├─ events.ts        # 事件总线：环形缓冲 + SSE 编码 + 重放
│  │     │  ├─ output.ts        # ≤64KiB / 100ms 合并器 + 字节计数
│  │     │  ├─ logfile.ts       # 日志文件（含上限与降级）
│  │     │  └─ timeout.ts       # SIGTERM → 5s → SIGKILL 进程组
│  │     ├─ files/{paths,read,write,list}.ts
│  │     ├─ diff.ts
│  │     ├─ archive.ts
│  │     └─ types.ts
│  └─ control-plane/            # Phase 5, 8–12
│     └─ src/
│        ├─ provider/{types,local-docker}.ts
│        ├─ db/{client,sandboxes,executions,artifacts,migrations/*.sql}
│        ├─ manager/{sandbox-manager,reconcile,sweeper}.ts
│        ├─ client/{sandbox-api,sse}.ts   # 手写 SSE 客户端
│        ├─ repo/{github-app,clone,pack,push}.ts
│        ├─ artifacts/{store,offload}.ts
│        └─ agent/{loop,tools/*,prompt}.ts
├─ packages/e2e/                # Phase 7 冒烟脚本
├─ images/sandbox/Dockerfile
├─ deploy/egress-proxy/{Dockerfile,allowlist.txt,src/proxy.ts}
├─ scripts/{migrate.ts,dev-db.sh}
└─ docs/
```

**不做 `packages/shared`**。两层之间只有 HTTP 契约，没有类型共享——CP 用自己的类型描述它看到的响应，故意重复。理由是让两层能独立演进：共享类型会让「沙箱加一个字段」变成「CP 被迫重新编译」。

### 0.5 测试策略

- 测试框架：**`node:test` + `node:assert/strict`**（Node 内置，零依赖，与整体取舍一致）。文件命名 `*.test.ts`，跑法 `node --test`。
- 三层：
  1. **单元测试**：不依赖 Docker，`npm test` 默认跑（Phase 1–3 的大部分、状态机、SSE 解析器）。
  2. **集成测试**：需要 Docker，`npm run test:integration`（Phase 5 起的容器测试、Phase 8 起的 Postgres 测试）。
  3. **冒烟/e2e**：需要完整栈，`npm run smoke`（Phase 7 起），**只在 Linux 上跑**。
- `npm test` 永远不需要 Docker、不需要网络。这是硬要求——它保证提交前那条命令是快的。
- 需要 Postgres 的测试用一次性容器：`docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=x postgres:16-alpine`，测试开始时跑迁移。不引 testcontainers。

### 0.6 Phase 总览

| Phase | 主题 | 依赖 | 关键产物 | §K 对应 |
|---|---|---|---|---|
| 1 | exec 内核（宿主机裸跑） | — | `exec/*` | 第 1 步（一半） |
| 2 | 文件与路径 API | 1 | `files/*` | 第 1 步（另一半） |
| 3 | diff 与 archive | 1,2 | `diff.ts` `archive.ts` | 第 7 步（沙箱侧） |
| 4 | 沙箱镜像 | 1–3 | `images/sandbox/Dockerfile` | 第 2 步 |
| 5 | LocalDockerProvider | 4 | `provider/local-docker.ts` | 第 3 步 |
| 6 | egress-proxy | 5 | `deploy/egress-proxy/*` | 第 4 步 |
| 7 | 冒烟脚本 + 隔离红线 CI | 5,6 | `packages/e2e/*` `.github/workflows/smoke.yml` | 第 8 步 |
| 8 | 持久层：表 / 状态机 / 对账 | 5 | `db/*` `manager/*` | 第 6 步 |
| 9 | 仓库进出：clone → 灌入 → diff → apply → push | 8 | `repo/*` | 第 5 步 |
| 10 | 归档与对象存储 | 9 | `artifacts/*` | 第 7 步（CP 侧） |
| 11 | Agent 循环 + 4 个工具 | 10 | `agent/*` | 第 9 步 |
| 12 | GitHub App + PR | 11 | `repo/pr.ts` | 第 10 步 |
| 13 | （可选）最小 transcript UI | 11 | `packages/web/*` | — |

**关键路径**：1 → 4 → 5 → 6 → 7 是硬串行，中间任何一环没过红线，后面全部无意义。Phase 8–10 在 Phase 5 完成后即可并行开工。

---
---

# 第一部分 · 执行层（宿主机裸跑，不碰 Docker）

这一部分做完，你手上有一个能在笔记本上直接跑起来的执行服务。它不知道容器、不知道网络、不知道 GitHub。

---

## Phase 1 · exec 内核

**目标**：`POST /exec` 立刻返回 202 和一个 `execution_id`，同时能从 SSE 上实时看到命令的输出；命令能被超时杀掉、能被主动杀掉，且绝不留下孤儿进程。

### 交付物

`packages/sandbox-agent/src/{index,server,ulid}.ts` + `src/exec/{registry,spawn,events,output,logfile,timeout}.ts`。

### 具体如何实现

#### 1. 启动与 env（`index.ts`）

```
SANDBOX_AGENT_TOKEN     必填。缺失就打印一行说明并以非 0 退出（不设默认 token！）
SANDBOX_AGENT_PORT      默认 8080
SANDBOX_AGENT_HOST      默认 127.0.0.1（裸跑安全；容器里由 Dockerfile 显式设 0.0.0.0）
SANDBOX_WORKSPACE_ROOT  默认 /workspace（裸跑时指向临时目录，测试全靠它）
SANDBOX_LOG_ROOT        默认 /tmp/reuben-cloud/exec
```

`WORKSPACE_ROOT` 可配是 Phase 1 的关键设计：**同一份代码，裸跑和容器里跑的是同一条路径逻辑**。裸跑不存在的 `/workspace` 就不会让路径校验逻辑变成另一套。

启动时做三件事：`realpath(WORKSPACE_ROOT)` 并缓存（macOS 上 `/tmp` 是 `/private/tmp` 的符号链接，不 realpath 后面路径校验必炸）、`mkdir -p LOG_ROOT`、监听。

退出时做一件事：**SIGTERM/SIGINT → 杀掉所有在跑的进程组 → 关闭 server → exit**。Docker 的 stop 是先 SIGTERM、10 秒后 SIGKILL；agent 必须在这 10 秒内把自己的子进程组带走，否则容器里会留下孤儿。这个逻辑在 Phase 5 才会被真正用到，但在 Phase 1 就要写对。

#### 2. 鉴权（`server.ts`）

每个请求都要 `Authorization: Bearer <token>`，缺或错一律 401。比较用 `crypto.timingSafeEqual`（先比长度，长度不等直接返回 false——`timingSafeEqual` 长度不等会抛异常）。

裸跑阶段这个 token 看起来没用（本机、127.0.0.1）。**仍然要写**：容器化之后它是内网唯一的防线，事后补的鉴权就是这个项目里最容易被漏掉的一行。

#### 3. 路由表

| 方法 | 路径 | Phase |
|---|---|---|
| GET | `/health` | 1 |
| POST | `/exec` | 1 |
| GET | `/exec/{id}/events` | 1 |
| POST | `/exec/{id}/kill` | 1 |
| GET/PUT | `/files` | 2 |
| GET | `/files/list` | 2 |
| GET | `/diff` | 3 |
| GET | `/archive` | 3 |

路由用手写匹配（`new URL(req.url, "http://x")` 拿 pathname，按 method+path 分支）。不要引路由库。

#### 4. `POST /exec`（`registry.ts`）

请求体：

```ts
interface ExecRequest {
  cmd: string[];                 // argv，不是 shell 字符串
  cwd?: string;                  // 默认 WORKSPACE_ROOT；必须落在 root 之内
  env?: Record<string, string>;  // 非敏感配置（代理地址、CI 标记）
  timeoutMs?: number;            // 默认 120_000，上限 600_000
  maxOutputBytes?: number;       // 默认 1 MiB
}
```

校验与响应：

- `cmd` 必须是非空字符串数组，任何一项含 `\0` → 400 `invalid_cmd`。
- `timeoutMs > 600000` → 400 `timeout_exceeds_max`。**不静默截断**：静默截断会让调用方以为自己拿到了 30 分钟。`600000` 是 §C.2 的硬上限。
- `cwd` 路径包含性违规 → 400 `path_out_of_bounds`（这是策略违规，拒绝请求）；
  `cwd` 在 root 之内但磁盘上不存在 → **不是 400**，而是 `failed` 事件（这是运行期事实）。
  这两者的区分要写死在代码里，它决定了 CP 的错误处理分支。
- 并发闸：已有执行在跑 → **409** `{error:"busy", activeExecution}`。§D 的单执行模型。
- 通过 → 生成 `exe_<ulid>`，登记，**立刻返回 202** `{execution_id, log_path}`，spawn 是异步的。

**ULID 自己写**（`ulid.ts`，约 40 行：Crockford base32，48 位毫秒时间戳 + 80 位随机，`crypto.getRandomValues`）。理由：日志和 DB 里 id 能直接按时间排序。不想维护就用 `crypto.randomUUID()`，但会丢掉前缀可排序性。

#### 5. 进程与其进程组（`spawn.ts`）

```ts
const child = spawn(cmd[0], cmd.slice(1), {
  cwd,
  env: baseEnv(env),
  detached: true,                 // ← 关键：让子进程成为进程组组长（setsid）
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,                   // ← 默认值，但写出来
});
```

- `shell: false` + argv 数组 = 注入类 bug 整类消失。要管道就显式写 `["bash","-lc","..."]`。
- `detached: true` 是 Node 里拿到进程组 id 的正规做法，不用调 `setsid` 二进制。之后 `process.kill(-child.pid, sig)` 一次带走整棵树。
  注意：**不要 unref**，我们还需要 `exit` 事件。
- `stdio[0] = "ignore"`：**没有交互式输入通道**。需要交互的程序会立刻读到 EOF 而失败——这是设计边界，不是 bug。工具层要在提示词里告诉模型这一点（Phase 11）。
- `baseEnv()` 返回一个**固定的最小集合**（`PATH`、`HOME`、`LANG`、`TERM`）叠加请求里的 `env`，而不是继承 agent 自己的整个 `process.env`。理由不是防泄密（容器里本来没秘密），是**确定性**——测试里环境变量不随宿主漂移。
- `child.on("error")` → `failed` 事件（ENOENT 走这条路，`spawn` 本身不抛）。
- `child.on("exit", (code, signal))` → 终态事件。

#### 6. 输出合并（`output.ts`）

stdout / stderr 各一个合并器，独立。规则来自 §C.2：

- 累积到 **≥ 64 KiB** 或距上次 flush **≥ 100 ms**，先到先发。
- 用 `node:string_decoder` 的 `StringDecoder` 做**增量解码**。裸 `Buffer.toString()` 会把跨 chunk 的多字节字符切成乱码——这是真会发生的（中文输出、`emoji`、任何非 ASCII）。
- 逐流累计 `stdout_bytes` / `stderr_bytes`（原始字节数，不是字符数）。
- 超过 `maxOutputBytes`：**停止往事件流发内容**，发一条 `truncated` 事件 `{reason:"output_limit", limit, log_path}`，但**日志文件继续写**（§C.2：完整内容始终在日志文件）。
- 顺流顺序保证：同一流内严格有序（单线程事件循环 + 单合并器）；**stdout 与 stderr 之间不保证时序**（OS 层面本来就不保证），这一条写进注释，免得日后有人试图"修"它。

#### 7. 事件总线与 SSE（`events.ts`）

每个执行持有一个单调递增的 `seq`（从 1 开始）+ 一个环形缓冲（**1000 条或 1 MiB，先到为准**，淘汰最旧的）。

SSE 帧：

```
id: 42
event: stdout
data: {"chunk":"..."}

```

要点：

- `Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`。
- `res.socket.setNoDelay(true)`：关掉 Nagle。100ms 的合并窗口已经够慢，不要再叠一层缓冲。
- **心跳**：空闲超过 15 秒发一行 `: ping\n\n`。中间任何一层代理都可能掐掉长时间没数据的连接；这是实现必需，不是可选。
- **重放**：请求头带 `Last-Event-ID: n` → 先按序补发 id > n 的事件，再接实时。若 `n` 早于缓冲里最旧的事件 → **先发一条 `truncated`**（`{reason:"replay_gap", from_id, log_path}`），然后再从缓冲最早处开始发。亏掉的部分去读日志文件。
- **允许 N 个订阅者**，各带各的游标。理由是 CP 重连时旧连接可能还没断干净，禁止重连会让重试逻辑变复杂。
- **终态事件之后 `res.end()`**：`completed` / `failed` / `timeout` / `killed` 四选一，互斥。收到终态事件的客户端可以安全收尾。
- **退出码非 0 是 `completed`，不是 `failed`**。判断成败是 CP 的事。`failed` 只表示"沙箱根本没能启动这个命令"。

#### 8. 日志文件（`logfile.ts`）

- 路径 `{SANDBOX_LOG_ROOT}/{executionId}.log`，`fs.createWriteStream(path, {flags:"a"})`。
- stdout 和 stderr 写进**同一个文件**，交错、无标记——和终端里看到的一致。想分离看事件流或 DB 里的字节计数。
- **单次执行上限 256 MiB**（`SANDBOX_AGENT_MAX_LOG_BYTES`）。超限后停止写、置 `log_truncated` 标记，但命令继续跑。理由很重要：日志落在 tmpfs 上，**tmpfs 的页面计入 cgroup 内存**，不设上限的输出狂魔会把整个容器 OOM 掉（Phase 4 的 `/tmp` 只有 512 MiB、内存上限 2 GiB）。
- **写失败不能弄死执行**（磁盘满、inode 用完）：记 error、发一条 stderr 事件说明、继续跑。

#### 9. 超时阶梯（`timeout.ts`）

```
setTimeout(timeoutMs) →
  标记 timeout
  process.kill(-pid, "SIGTERM")     // 整个进程组
  若有 ESRCH 忽略（可能刚好自己退了）
  5s 后 process.kill(-pid, "SIGKILL")
  等 exit 事件真正到达
  然后才发 timeout 终态事件（带上 exit_code / signal）
```

顺序是重点：**终态事件必须在进程真的死了之后才发**，否则 CP 一收到 `timeout` 就认为"进程树已被杀"，而实际可能还在写文件。定时器全部 `unref()`，免得 agent 进程被它们吊住。

#### 10. `POST /exec/{id}/kill`

幂等：未知 id → 404；已在终态 → 200 返回当前状态（**不是错误**，重试语义需要它幂等）；正在跑 → 走同一套 SIGTERM→5s→SIGKILL，发 `killed` 终态。

#### 11. `GET /health`

```json
{ "status": "ready", "version": "0.0.1", "activeExecution": "exe_01..." }
```

Phase 1 里 `status` 只取值 `ready`（`starting` 用不到、`error` 保留）。`activeExecution` 兜住的不只是 exec：Phase 3 起 diff/archive 也会占这个槽，届时用 `diff_<ulid>` / `archive_<ulid>` 前缀区分（见 Phase 3）。

### 技术边界

- **不碰 Docker**。这个包里出现 `docker` 这个词就是错误的。
- **不做多执行并发**。单执行闸 + 409 是设计，不是临时限制。
- **不提供 stdin**，不做 pty，不做交互式。
- **无隐式 shell**：`cmd` 一律 argv。
- **不做文件 API**（Phase 2）、**不做 diff/archive**（Phase 3）、**不做鉴权之外的安全策略**。
- **不做命令黑名单**。§F.6 说得直白：任意代码执行让命令空间是无限的，黑名单只制造安全幻觉。真正的边界在 Phase 4–6 的四条结构约束上。
- 事件流是**唯一的输出通道**；日志文件是给取证和 `GET /files` 用的，不是通信通道。

### 测试要点

`node --test`，全部用临时目录当 `WORKSPACE_ROOT`，不需要 Docker。

| # | 用例 | 断言 |
|---|---|---|
| 1 | `["true"]` / `["false"]` | 都是 `completed`，`exit_code` 0 / 1 |
| 2 | stdout/stderr 分流 | 两路内容各自正确，单流内顺序正确 |
| 3 | 立即返回 | 对 `sleep 5` 的 POST 往返 < 100ms 且拿到 `execution_id` |
| 4 | 中间输出 | `["bash","-lc","echo a; sleep 0.3; echo b"]`，进程结束**之前**收到 `a` |
| 5 | 超时杀进程组 | `["bash","-lc","sleep 300 & sleep 300 & wait"]` → `timeout` 事件；后台进程写出的 pid 文件里的进程 `kill -0` 全部失败 |
| 6 | 正常结束不杀后台 | `["bash","-lc","nohup sleep 300 >/dev/null 2>&1 & echo $!"]` → `completed`，且该 pid **仍然活着**（清理交给 destroy） |
| 7 | 主动 kill | 长命令 → kill → `killed` 事件 + 进程组真死 |
| 8 | 大输出截断 | 产出 5 MiB → 收到 `truncated`（`reason:"output_limit"`）；事件流总量 ≤ `maxOutputBytes`；日志文件字节数 = 5 MiB |
| 9 | 二进制安全 | `printf '\x00\x01\xff'` → 收到的 chunk 是合法 UTF-8，无替换字符 |
| 10 | 多字节边界 | 输出 100 KB 中文 → 全文重组后与源字节一致（验证 StringDecoder） |
| 11 | 重连重放 | 跑一条长命令，读 3 条事件后断开，带 `Last-Event-ID` 重连 → 不丢不重 |
| 12 | 重放空洞 | 制造 > 1000 条事件，从 id=1 重连 → 收到 `truncated{reason:"replay_gap"}` |
| 13 | 409 | 第一个执行未结束时第二个请求 → 409 且带 `activeExecution` |
| 14 | 鉴权 | 无 token / 错 token / 长度不等的 token → 401 |
| 15 | 参数校验 | 空 cmd、非数组、含 `\0`、`timeoutMs:600001` → 400；`cwd` 越界 → 400；`cwd` 不存在 → `failed` 事件 |
| 16 | ENOENT | `["definitely-not-a-binary"]` → `failed` 事件（不是 400） |
| 17 | 无隐式 shell | `["echo","a","|","b"]` 原样打印 `a | b`，不产生管道行为 |
| 18 | SIGTERM 优雅退出 | 给 agent 发 SIGTERM → 在跑的进程组被杀、端口释放、退出码 0 |

### 验收标准

- [x] 上表 18 个用例全绿：`npm test -w @reuben-cloud/sandbox-agent`
- [x] `packages/sandbox-agent/package.json` 的 `dependencies` 仍然为空对象
- [x] `npx tsc --noEmit` 通过
- [x] 手工：curl 起一条长命令，`curl -N` 观察输出逐段到达（不是最后一次性到达）

#### 实现备注（与本文的有意偏差，都写了理由）

1. **多两个文件**：`src/config.ts`（env 加载 + Config）与 `src/paths.ts`（root 包含性校验）。cwd 校验必须有个落点，而 Phase 2 会在**同一个类**上扩展成「读多根、写单根」——路径校验不能有第二份实现。
2. **事件缓冲容量可配**（`SANDBOX_AGENT_EVENT_BUFFER_MAX_EVENTS` / `_BYTES`，默认仍是 1000 条 / 1 MiB）。用例 12 在默认容量下要么跑 100 秒（100ms 一个事件），要么产出 64 MiB 输出；把容量调小是这个场景唯一诚实的测法。同理加了 `SANDBOX_AGENT_CHUNK_BYTES` / `_FLUSH_INTERVAL_MS` / `_EXIT_DRAIN_MS` / `_KILL_GRACE_MS` / `_HEARTBEAT_MS` / `_MAX_LOG_BYTES` 几个测试用的旋钮。
3. **用例 9 的断言改了形式**：`printf '\x00\x01\xff'` 里的 `\xff` 单独出现就是非法 UTF-8，StringDecoder 必然给出一个 U+FFFD，所以「无替换字符」对这个输入不可满足。改测「有效字节原样送达 + 恰好一个替换字符」，而多字节边界由用例 10 负责。
4. **终态事件的触发条件写清楚了**：直接子进程退出 **且** 两路管道 EOF，**或** 退出后 250ms 宽限期到（后台进程继承管道写端时管道永远不会 EOF，死等会让 `completed` 永不发出——而 §C.2 要求 `nohup ./dev-server &` 这种模式必须能用）。宽限期后的输出丢弃，清理交给 destroy。
5. **路径包含性只判「符号链接解析之后」的路径**，没有单独的字面前缀检查：root 本身是符号链接时（macOS `/var` → `/private/var`）字面前缀检查会把 root 之内、尚未落盘的路径误判成越界；而真正要拦的是解析后的落点。

**完成标记：**
- [x] **Phase 1 完成** — exec 内核在裸机上跑通全部 18 个用例

---

## Phase 2 · 文件与路径安全 API

**目标**：CP 能把一个 tar 包流式灌进沙箱，能把文件读回去，且**任何越界路径都被拒**。

### 交付物

`packages/sandbox-agent/src/files/{paths,read,write,list}.ts` + 路由接线 + `files/paths.test.ts`。

### 具体如何实现

#### 1. `resolveSafePath` —— 整个阶段的核心（`paths.ts`）

```ts
type ResolveResult =
  | { ok: true; abs: string }
  | { ok: false; reason: "empty" | "nul" | "out_of_bounds" };

export function resolveSafePath(input: string, forWrite = false): ResolveResult
```

按顺序做，**每一步都不能省**：

1. 空串 / 非字符串 / 含 `\0` → 拒。
2. `path.resolve(ROOT_REAL, input)`（相对路径按 root 解析，绝对路径原样）。
3. 前缀检查：`abs === root || abs.startsWith(root + path.sep)`。
   **必须带分隔符**——裸 `startsWith(root)` 会让 `/workspace-evil` 通过。
4. `fs.realpath(abs)` 再查一次包含性。这一步是为了抓符号链接逃逸：workspace 里放一个 `ln -s /etc link`，第 3 步过得了，第 4 步过不了。
5. 写操作的目标文件可能还不存在，`realpath` 会 ENOENT → 退而 `realpath(dirname(abs))` 再查包含性。
   这是最容易被漏掉的一个分支，也是 `ln -s /etc x && echo pwn > x/passwd` 那条路。

`ROOT_REAL` 在启动时 `realpath` 一次并缓存（见 Phase 1 §1）。

**已知残余风险（写进注释，不要假装解决了）**：校验与 `open()` 之间存在 TOCTOU 窗口，中间可以把符号链接换掉。彻底的解法是内核的 `openat2(RESOLVE_BENEATH)`，Node 没有暴露。这里选择接受它，威胁模型是"agent 误用或被提示注入后想读容器里的别的路径"，而容器里除了 `/workspace` 就只有只读根和 `/tmp/reuben-cloud`。**不为此发明黑名单**。

#### 2. `GET /files?path=&offset=&limit=&encoding=&raw=1`

- 全部走 `resolveSafePath`。目录 → 400 `is_directory`（提示用 `/files/list`）；不存在 → 404。
- 默认 `encoding=utf8`：JSON 返回 `{path, size, sha256, encoding, content}`。
- **非法 UTF-8 → 报 400 `invalid_utf8`，并提示改用 `encoding=base64`**。不静默替换成 U+FFFD——静默替换会让"读到的内容和真实内容不同"这件事无人察觉。
- `encoding=base64`：原字节往返，不猜、不嗅探。**不做自动二进制探测**：猜会猜错。
- `offset` / `limit` 按字节做范围读；`limit` 默认 `MAX_READ_BYTES`（1 MiB），超出 → 413 `too_large`。
- `raw=1`：直接以 `application/octet-stream` 流式吐出（CP 读大日志走这条路，避免 base64 膨胀 33%）。

#### 3. `PUT /files?path=` —— 流式二进制

- **Body 就是裸字节**，不解析 `multipart/form-data`。CP 传的是 `repo.tar.gz`，它自己知道怎么打包；解析 multipart 是纯粹的额外代码。
- 先写 `{path}.part-{rand}`，成功后 `fs.rename` 覆盖 → 原子。半途失败的目标目录里不会留下半个 tar。
- 边写边 `crypto.createHash("sha256")`，返回 `{path, size, sha256}`。CP 拿它校验灌入完整性。
- 上限 `SANDBOX_AGENT_MAX_WRITE_BYTES`（默认 512 MiB）：超了要 **`req.destroy()`** 并删临时文件。只返回 413 不 destroy 会让连接吊住。
- 自动 `mkdir -p` 父目录。
- **客户端中途断开**：`req.on("aborted")` → 删临时文件、不产生目标文件。测试要覆盖。

#### 4. `GET /files/list?path=&depth=`

- 走同一个路径校验。
- 返回 `[{name, type:"file"|"dir"|"symlink", size, mtime}]`，按 name 排序。
- **不跟随符号链接**：`type` 直接标 `symlink`。跟随会让 list 变成一条绕过路径校验的越权通道。
- 条目上限 1000，超出 `{truncated:true}`。

#### 5. 读根扩展（为 Phase 11 的外置结果准备）

允许一个**额外的只读根**：`SANDBOX_AGENT_READ_ROOTS=/workspace,/tmp/reuben-cloud`。

- **读**可以在任一允许根之下；**写**永远只在 `/workspace`。
- 理由：模型工具结果外置到 `/tmp/reuben-cloud/out/`，之后模型要用工具把它读回来（Phase 11）；而写进去的东西必须能被 diff/archive 看见，所以写只能落在 workspace。
- 现在就把这个参数做进去，别等到 Phase 11 再改路径逻辑。

### 技术边界

- 只允许配置的根之下（读多根、写单根）。
- **不提供 delete / move / mkdir / chmod 端点**——agent 用 `exec` 做这些。少四个端点，少四份路径校验。
- 不解析 multipart；不做 HTTP range 语义（`offset`/`limit` 是我们自己的参数，不支持 `Range` 头）。
- 不跟随符号链接（读和 list 都是）。
- TOCTOU 残余风险如上，明写在文档和代码注释里。
- 单文件内联读 ≤ 1 MiB，写 ≤ 512 MiB。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | `../../etc/passwd`、`/etc/passwd`、`/workspace/../x` | 全部 400 |
| 2 | 前缀绕过 `/workspace-evil/f` | 400 |
| 3 | **symlink 逃逸**：`ln -s /etc link` 后读 `link/passwd` | 400 |
| 4 | **写路径 symlink 逃逸**：`ln -s /etc x` 后写 `x/pwn` | 400 |
| 5 | URL 编码 `?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd` | 400（用 `searchParams.get("path")`，它已解码） |
| 6 | 空 path / 缺 path 参数 | 400 |
| 7 | 文本往返 | 内容一致 |
| 8 | **二进制往返**：1 MiB 随机字节 → base64 → 原字节 sha256 相等 | 一致 |
| 9 | 边界 | 1 MiB 整通过；1 MiB + 1 字节 → 413 |
| 10 | 流式内存：上传 256 MiB tar | agent 进程 RSS 增量 < 50 MiB（证明真的在流，没有 `Buffer.concat`） |
| 11 | 半途中断上传 | 目标目录里既无目标文件也无 `.part` |
| 12 | sha256 | 与本地 `shasum -a 256` 一致 |
| 13 | list：file/dir/symlink/空目录 | 类型、排序正确；symlink 不展开 |
| 14 | 目录读 → 400；不存在 → 404 | 同左 |
| 15 | 非法 UTF-8 字节 | 400 `invalid_utf8`；改 `base64` 后成功 |

### 验收标准

- [ ] 上表 15 个用例全绿
- [ ] 越界路径**全部** 400（含 symlink 与 URL 编码两类）
- [ ] 256 MiB 上传期间 RSS 增量 < 50 MiB
- [ ] 二进制往返 sha256 一致
- [ ] `tsc --noEmit` 通过

**完成标记：**
- [ ] **Phase 2 完成** — 文件 API 可用且越界全部被拒

---

## Phase 3 · diff 与 archive

**目标**：沙箱能吐出「相对 base commit 的 patch」和「整个 workspace 的 tar.gz」，两者都是流，都不进模型上下文。

### 交付物

`packages/sandbox-agent/src/{diff,archive}.ts`。

### 具体如何实现

#### 1. base commit 由调用方传入（**与设计文档的有意偏差**）

`GET /diff?base=<sha>`，`base` 可选，缺省 `HEAD`。

设计原文隐含"沙箱记住 base commit"。这里改成显式传参，理由：§A 的核心原则是**沙箱不持有业务状态**（它随时可能死掉重建）。让 CP 把 base 传进来，沙箱就真的是无状态的；也省掉了第 10 个端点和一份需要持久化的状态。

`base` 不存在（sha 不认识）→ 400 `unknown_base`，把 git 的 stderr 带上。

#### 2. `GET /diff`

```
git -C /workspace/repo add -A -N          # intent-to-add：让未跟踪的新文件出现在 diff 里
git -C /workspace/repo diff --binary <base>
```

响应：

```json
{
  "base": "<sha>", "head": "<sha>",
  "files": [{"path":"src/a.ts","status":"modified","additions":12,"deletions":3,"binary":false}],
  "patch": "…unified diff…",
  "patch_bytes": 12345,
  "truncated": false,
  "patch_log_path": null
}
```

- `--binary` 不能省：没有它，二进制文件的改动会变成一句 "Binary files differ"，patch 应用不回去。
- `add -A -N` 会修改 index。接受并写进注释——这是让新文件出现在 diff 里的标准做法。副作用是之后 `git status` 会把新文件显示为已暂存（intent-to-add），对 agent 无害。
- patch 超过 `MAX_PATCH_BYTES`（默认 2 MiB）→ 不内联，写到 `/tmp/reuben-cloud/diff/{executionId}.patch`，返回 `truncated:true` + `patch_log_path`，CP 用 `GET /files?raw=1` 取回。和输出外置同一套思路，只有一份实现。
- patch 的 sha256 由 CP 侧算（它本来就要拿这串字节去 `git apply`，顺手算，不额外传）。

#### 3. `GET /archive`

```
tar czf - -C /workspace .
```

- 用系统 `tar` + `spawn`，零依赖；管 stdout 到 HTTP 响应。
- **默认不排除任何东西**——§J.6 明确要求包含被 `.gitignore` 排除的构建产物（这正是它作为 patch 兜底方案的价值）。顺便记一笔：GNU tar 的 `--exclude-vcs-ignores` 是**可选**开关，默认不读 `.gitignore`，所以默认行为就是对的。
- 支持 `?exclude=.git,node_modules` 让 CP 自己选。
- 归档顶层是 **workspace 根**（`./...`），不是 `repo/`。CP 解包时按这个结构走。
- **`?dryRun=1`**（新增，见附录 A-6）：先 `du -sb /workspace` 返回 `{size_bytes, file_count}`，不发流。CP 在拉 2 GiB 之前先知道体积，用它做「卷 + 归档体积上限」的软限制判断。
- 超上限：既然 dryRun 已经提前拒过，这里只做兜底——流到一半超了就直接断连接并记日志。

**长流式请求必须能被打断。** `res.on("close")` → `process.kill(-tar.pid, "SIGKILL")`。不写这几行，客户端一断开就留下一个继续打包的 tar 进程，反复几次就把容器塞满。diff 里的 git 同理。

**diff/archive 不走 exec 的超时机制**，它们有自己的 HTTP 层时限（默认 300s，`SANDBOX_AGENT_STREAM_TIMEOUT_MS`）。

#### 4. 并发闸的扩展（**与设计文档的有意偏差**）

`GET /diff` 和 `GET /archive` **占用同一个 BUSY 槽位**，与 `/exec` 互斥。正在跑 exec 时请求 archive → 409。

理由：它们共享 workspace 的读写语义。一边跑测试一边打包会产生一个撕裂的归档（半个测试产物、不一致的 lockfile）。CP 的流程本来就是顺序的（跑测试 → 取 diff → 取归档 → 销毁），互斥不损失任何东西。

`/health.activeExecution` 在跑 diff/archive 时返回 `diff_<ulid>` / `archive_<ulid>`，让 409 的调用方能看出是谁占着。读事件流的连接不算占用（那是主要路径，必须随时可用）。

### 技术边界

- diff 一定同时给**结构化文件列表**和**patch 文本**；超限的 patch 走文件引用，不截断内容。
- archive 不尊重 `.gitignore`（这是需求，不是疏忽）。
- 两者都不进事件流、不进模型上下文。
- **不设 git status/log/branch 端点**——需要的话走 `exec`。
- 依赖宿主 `tar`（macOS bsdtar / Linux GNU tar 公共子集，只用 `czf - -C`）。
- 归档里可能含指向 `/workspace` 外的符号链接；**CP 解包时必须 `--no-same-owner`、不加 `-P/--absolute-names`、且在空目录里解**（Phase 10 会用到这条）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | **apply 往返**：改一个文件 → `/diff` → 在另一份 clone 上 `git apply --binary` | 成功，且两边 `git diff <base>` 的 sha256 相等 |
| 2 | 新增未跟踪文件 | 出现在 patch 里 |
| 3 | 删除 / 重命名 / 二进制改动 | 都能 apply 回去，内容一致 |
| 4 | 大 patch（> 2 MiB） | `truncated:true` + `patch_log_path` 可读，内容完整 |
| 5 | `base` 不存在 | 400 `unknown_base` |
| 6 | archive 含被忽略的 `dist/`、`node_modules/` | 解包后存在 |
| 7 | archive 往返 | 解包后文件清单 + 每个文件 sha256 与源一致 |
| 8 | archive 空目录 / 含 symlink | 能打包；symlink 以链接本体存入 |
| 9 | **中断传输** | 断开后 `pgrep tar` 为空（进程被带走） |
| 10 | 并发闸 | exec 进行中 `GET /archive` → 409，且 `activeExecution` 是那个 exec id |
| 11 | 流式内存 | 打包 1 GiB workspace，agent RSS 增量 < 50 MiB |

### 验收标准

- [ ] 上表 11 个用例全绿
- [ ] patch apply 往返后两边树内容一致（sha256 相等）
- [ ] archive 包含构建产物
- [ ] 中断传输后无残留 tar/git 进程
- [ ] `tsc --noEmit` 通过

**完成标记：**
- [ ] **Phase 3 完成** — diff/archive 可用、可中断、可被 CP 消费

---
---

# 第二部分 · 容器与隔离

这一部分把上一部分的代码放进一个受限容器里，并且证明它真的受限。

---

## Phase 4 · 沙箱镜像

**目标**：一个可复现的镜像，非 root、只读根、起得来、`/health` 通得过，且**没有默认 token**。

### 交付物

`images/sandbox/Dockerfile`、仓库根 `.dockerignore`。

### 具体如何实现

```dockerfile
FROM node:24-bookworm-slim

# 语言运行时 + 工具。逐个列出，不要 metapackage。
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl tar gzip procps \
      python3 python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp/agent \
    SANDBOX_AGENT_HOST=0.0.0.0 \
    SANDBOX_AGENT_PORT=8080 \
    SANDBOX_WORKSPACE_ROOT=/workspace \
    SANDBOX_LOG_ROOT=/tmp/reuben-cloud/exec

# 可写点必须显式存在且在镜像里就有正确属主：
#   /workspace 由命名卷覆盖，Docker 用镜像里该目录的属主初始化新卷 → 必须 chown 成 1000
RUN useradd -u 1000 -m -s /bin/bash agent \
 && mkdir -p /workspace /app /tmp/reuben-cloud \
 && chown -R 1000:1000 /workspace /app /tmp/reuben-cloud

WORKDIR /app
COPY packages/sandbox-agent/src ./src

USER 1000:1000
EXPOSE 8080
CMD ["node", "src/index.ts"]
```

要点，逐条都有理由：

1. **不写 `VOLUME /workspace`**。写了之后镜像里对该路径的写入会被丢弃，而且属主故事会变得难讲。卷由 Phase 5 的 provider 显式挂。
2. **`mkdir -p /workspace && chown 1000:1000`**：Docker 创建命名卷时，会把镜像里挂载点目录的**内容与属主**复制进新卷。少了这一句，卷是 `root:root`，容器里 uid 1000 连 `/workspace` 都写不进去——这是最容易浪费半天的一类 bug。
3. **`HOME=/tmp/agent`** 而不是 `--tmpfs /home/agent`：tmpfs 的挂载点属主是 root，容器里的 uid 1000 写不进去；而 runc 对 `mode=` 的支持不值得赌。放在 `/tmp` 下，由 agent 启动时 `mkdir -p $HOME`（它自己就是 uid 1000，在 1777 的 `/tmp` 下建目录，天然归自己所有）。见附录 A-2。
4. **日志根在 `/tmp/reuben-cloud`**：同上的属主问题。`/var/log` 在只读根上根本不可写。放 `/tmp` 下还顺便受 tmpfs 上限约束。见附录 A-1。
5. **`PYTHONUNBUFFERED=1`**：没有它，python 输出会整段卡在管道缓冲里，表现为"命令跑完了才一次性出结果"——直接把 Phase 1 的实时性白送掉。
6. **`LANG=C.UTF-8`**：没有它，python3 往管道写非 ASCII 会 `UnicodeEncodeError`。
7. **没有 `npm install` 这一步**：sandbox-agent 零依赖，`COPY src` 完事。这是 0.2 那个取舍的兑现。
8. **镜像里 `USER 1000:1000` 和 provider 的 `--user 1000:1000` 都写**：后者防的是"镜像被人换掉"。
9. **`CMD ["node", "src/index.ts"]`**（exec 形式）：`node` 直接吃 `.ts`，靠的就是 `erasableSyntaxOnly` 这个约束。
10. **没有 `SANDBOX_AGENT_TOKEN` 默认值**。缺失就退出——如果镜像里写了个默认 token，所有沙箱就都用同一个公开的 token。
11. `--init` 由 provider 传（tini 负责回收僵尸），所以镜像里不装 tini。
12. HEALTHCHECK 可选。要用的话得带上 token，但 token 是运行时注入的——env 在容器里可见，所以能写：
    `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/health',{headers:{authorization:'Bearer '+process.env.SANDBOX_AGENT_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`
    价值是 `docker ps` 能看出状态；不写也不影响（provider 自己轮询 `/health`）。

**镜像范围（MVP）**：node + python + 常见构建工具 + git。不装 go/rust/java——README §3.2 说的基础镜像矩阵是 M2 的事，现在装一整套只会让镜像变大、构建变慢，而 MVP 的测试仓库是 TS/Python。

**`.dockerignore`**（构建上下文是仓库根）：`**/node_modules`、`.git`、`docs`、`*.md`、`packages/control-plane`。

**构建命令**：`docker build -f images/sandbox/Dockerfile -t <registry>/sandbox-base:dev .`。CI 里构建后记录 `docker images --digests` 的 digest；provider 强制用 digest 引用（Phase 5）。

### 技术边界

- 镜像里没有：任何凭据、docker CLI、sudo、ssh、nested container 能力。
- 不做多语言全家桶（见上）。
- `/tmp` **故意不加 `noexec`**： attacker 已经能在 `/workspace` 里执行任意代码，`noexec` 换不来实际安全增益，却会打断 `npm` postinstall / `node-gyp`。§F.1 已定，这里照抄。
- 镜像内代码 = 仓库里的 `sandbox-agent/src`（COPY，不发布到 registry）。MVP 不做镜像发布流水线。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | `docker run --rm <img> id -u` | 输出 `1000` |
| 2 | 无 token 启动 | 进程非 0 退出，日志里有说明 |
| 3 | 带 token 起 → `curl /health` | 200 |
| 4 | `python3 -c "print('中文')"` | 通过 SSE 立即可见（验证 `PYTHONUNBUFFERED` + locale） |
| 5 | `node -v` / `git --version` / `python3 -V` | 都在 |
| 6 | `/workspace` 可写、`/` 不可写 | 前者成功、后者失败 |
| 7 | 两次构建 | 层缓存命中（可复现） |
| 8 | 镜像大小记录在案 | 只记录，不设硬指标 |

### 验收标准

- [ ] 镜像能起，`/health` 带 token 通过
- [ ] `id -u` = 1000
- [ ] 无 token 拒绝启动
- [ ] `python3` 中文输出即时可见
- [ ] 命名卷初始化后 `/workspace` 属主是 1000（在 Phase 5 一起验）

**完成标记：**
- [ ] **Phase 4 完成** — 沙箱镜像可用且非 root

---

## Phase 5 · LocalDockerProvider

**目标**：CP 代码里的一个模块，能 `create / destroy / health` 一个**加固过的**沙箱，且**不泄漏**（失败也不留容器和卷）。

### 交付物

`packages/control-plane/src/provider/{types.ts,local-docker.ts}` + 集成测试。

### 具体如何实现

#### 1. 怎么跟 Docker 说话：**不引 dockerode**

用 `node:http` 的 `socketPath` 直连 `/var/run/docker.sock`，API 版本显式钉在路径上：

```ts
http.request({ socketPath: "/var/run/docker.sock", path: `/v1.44${apiPath}`, method, headers })
```

我们只需要 6 个调用：`POST /images/create`、`POST /volumes/create`、`DELETE /volumes/{name}`、`POST /networks/create`、`POST /containers/create`、`POST /containers/{id}/start`、`GET /containers/{id}/json`、`GET /containers/json`、`DELETE /containers/{id}`。全是非流式 JSON。dockerode 的价值主要在 attach/events 的流式封装，而我们**不用 docker attach**（exec 走 agent 的 HTTP API）。零依赖 + 创建参数反正要手写 JSON body，所以自己写更直白。

**如果**以后需要 `docker events` 或 attach，再评估引 dockerode。这条留在这里免得日后重复讨论。

#### 2. `create(spec)`

顺序（**顺序本身是设计的一部分**）：

1. **校验 spec**：镜像引用必须含 `@sha256:`；limits 在允许范围内；labels 必须带 `reuben-cloud.sandboxId`。校验失败直接抛，不碰 Docker。
2. **拉镜像**（`POST /images/create?fromImage=...&tag=...`，同步等它返回）。这一步用 **120s 预算**。
   把 pull 拆出来，是为了让 create 的 **15s 预算**变成可预期的——§D 那张超时表里的两行，落到实现就是"两次可分别计时的操作"，不然 15s/120s 根本没法区分。
3. **建卷**：`POST /volumes/create`，名字 `reuben-cloud-ws-{sandboxId}`，带 labels。
4. **建网络**（幂等，进程启动时做一次即可）：`POST /networks/create` `{Name:"reuben-cloud-internal", Driver:"bridge", Internal:true}`。已存在 → 409，当作成功。
5. **建容器**：

```jsonc
POST /containers/create?name=reuben-cloud-sbx-{id}
{
  "Image": "<ref>@sha256:<digest>",
  "User": "1000:1000",
  "WorkingDir": "/workspace",
  "Env": ["SANDBOX_AGENT_TOKEN=<32字节base64url随机>", "HTTP_PROXY=http://reuben-cloud-proxy:3128", ...],
  "Labels": { "reuben-cloud.managed": "true", "reuben-cloud.sandboxId": "...", "reuben-cloud.runId": "..." },
  "ExposedPorts": { "8080/tcp": {} },          // 仅 darwin 需要
  "HostConfig": {
    "ReadonlyRootfs": true,
    "CapDrop": ["ALL"],
    "SecurityOpt": ["no-new-privileges:true", "apparmor=docker-default"],
    "Privileged": false,
    "Memory": 2147483648, "MemorySwap": 2147483648, "NanoCpus": 1000000000,
    "PidsLimit": 2048,
    "Init": true,
    "Tmpfs": { "/tmp": "rw,nosuid,size=512m,mode=1777" },
    "Binds": ["reuben-cloud-ws-{id}:/workspace"],
    "NetworkMode": "reuben-cloud-internal",
    "PortBindings": { "8080/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "" }] },  // 仅 darwin
    "RestartPolicy": { "Name": "no" },
    "AutoRemove": false,
    "LogConfig": { "Type": "json-file", "Config": { "max-size": "10m", "max-file": "3" } }
  }
}
```

逐条说明：

- **加固参数硬编码在 provider 里，spec 里没有任何开关能关掉它们**。这是关键：`SandboxSpec` 里不存在 `privileged`、不存在 `binds`、不存在 `securityOpt` 字段。代码里根本没有那些分支，就不可能被上层打开。
- **seccomp：什么都不传**。不传即使用 Docker 的默认 profile；§F.1 那条"必须是默认 profile，不能是 unconfined"翻译成实现就是"这一项不写"。测试断言 `SecurityOpt` 里**不含**任何 `seccomp=` 项。
- `no-new-privileges:true` 是 API 形式（CLI 的 `--security-opt no-new-privileges=true` 等价）。断言时用「以 `no-new-privileges` 开头」而不是全等，免得被两种拼法绊住。
- `Tmpfs` 只有 `/tmp` 一项，512 MiB、`mode=1777`。**没有 `/home/agent`**（见 Phase 4 与附录 A-2），**没有 `/var/log/...`**（见 A-1）。tmpfs 的页面**计入 cgroup 内存**，所以 512 MiB 的 tmpfs 是 2 GiB 内存上限里实打实的一部分。
- `PortBindings` 只在 `process.platform === "darwin"` 时加，且 `HostIp` 必须是 `127.0.0.1`、端口随机。**绝不发布到 `0.0.0.0`**。
- `NetworkMode` 是内网名——容器只能到代理，出不了公网。
- `authToken`：`crypto.randomBytes(32).toString("base64url")`，**每次 create 现生成**，通过 env 注入。它只保护一个仅在内网可达的端口，但仍然是每沙箱一个。

6. **start** → `POST /containers/{id}/start`。
7. **解析 endpoint**：
   - Linux：`GET /containers/{id}/json` → `NetworkSettings.Networks["reuben-cloud-internal"].IPAddress`，endpoint = `http://<ip>:8080`。宿主到 bridge 网络上的容器 IP 默认可达，所以不需要发布任何端口。
   - darwin：读 `NetworkSettings.Ports["8080/tcp"][0].HostPort`，endpoint = `http://127.0.0.1:<port>`。
   - 把这段差异收敛到一个纯函数 `resolveEndpoint(inspectJson, platform)`，好单测。
8. **轮询 `/health`**：间隔 250ms，预算 15s（镜像已经预拉过）。带 `Authorization: Bearer <token>`。
   成功 → 返回 handle `{sandboxId, providerRef, endpoint, authToken}`。
   超时或 agent 报 `error` → 抛 `{reason: "health_timeout" | "agent_error"}`，**并且先把容器和卷删掉**（失败路径的清理不能靠调用方记得做）。

#### 3. 失败清理（不泄漏）

`create()` 用一个 `try/catch` 包住，catch 里按**创建的反向顺序**清理：容器 → 卷。网络是共享的，不删。清理本身也要 catch（删一个已经没了的容器会 404，忽略）。

`destroy(sandboxId)` 必须**幂等**：容器不存在的 404 当作成功；卷的 404 当作成功。因为对账（Phase 8）会重复调用它。

`destroy` 的顺序：`POST /containers/{id}/stop?t=10`（给 agent 10 秒自己带走子进程组）→ `DELETE /containers/{id}?force=true` 兜底 → `DELETE /volumes/{name}` → 卷删不掉（还在用时）就记警告，留给下次对账。

#### 4. 给对账用的查询接口

- `listManaged()`：`GET /containers/json?all=1&filters={"label":["reuben-cloud.managed=true"]}`。
- `inspect(sandboxId)`：按名字或标签找容器，返回 `{state, endpoint, agentStatus}`；没有则 `null`。

Phase 8 的对账逻辑完全建立在这两个方法上，所以它们从第一天就要有，不能等到 Phase 8 现加。

### 技术边界

- **只支持本机 daemon**（未设 `DOCKER_HOST` 或它是 unix socket）。远程/TLS 的 docker context 明确不支持（`DOCKER_HOST` 是 `tcp://` 时启动就报错退出，不要静默连到别的机器上）。
- **不做预热池、不做 pause/resume、不通过 docker exec 执行命令**（exec 一律走 agent HTTP）。
- provider 是 CP 进程内的一个模块，**不是独立服务**（§C.1 的意图：Provider 层在进程内，Execution 层才在容器里）。
- 不允许 bind mount、不允许 host network/pid/ipc、不允许 `--privileged`——**代码里不存在这些字段**。

### 测试要点

集成测试（`npm run test:integration`，需要 Docker）：

| # | 用例 | 断言 |
|---|---|---|
| 1 | create → health → exec → destroy | 全链路成功 |
| 2 | **inspect 断言加固参数** | `CapDrop==["ALL"]`、`ReadonlyRootfs==true`、`User=="1000:1000"`、`Memory==2GiB`、`NanoCpus==1e9`、`PidsLimit==2048`、`Init==true`、`Privileged==false`、`NetworkMode=="reuben-cloud-internal"`、`SecurityOpt` 含 `no-new-privileges*` 且**不含** `seccomp=` |
| 3 | 卷属主 | `docker exec <c> stat -c %u /workspace` → `1000`（测试里允许用 docker exec 做断言，产品路径不许） |
| 4 | **create 失败不泄漏** | 给一个不存在的 digest → 抛错；断言无残留容器、无残留卷 |
| 5 | destroy 幂等 | 连调三次都成功 |
| 6 | health 超时 | 用一个 CMD 是 `sleep 1h` 的坏镜像 → 15s 内报错、reason 正确、并已清理 |
| 7 | 冷启动计时 | 镜像已拉取的前提下，create 的 p95 < 5s（§J 的性能目标） |
| 8 | endpoint 解析 | 纯函数单测：Linux 的 inspect JSON / darwin 的 inspect JSON 各一例，mocked 响应 |

### 验收标准

- [ ] 上表 8 项全绿
- [ ] `docker inspect` 逐条复核加固参数（**手工看一遍**，不要只看测试绿）
- [ ] 连做 10 次 create/destroy，`docker ps -a` 和 `docker volume ls` 无残留
- [ ] `DOCKER_HOST=tcp://...` 时启动报错退出

**完成标记：**
- [ ] **Phase 5 完成** — 沙箱能被创建、加固、回收，且不泄漏

---

## Phase 6 · egress-proxy

**目标**：沙箱出不去公网，除了白名单上的包管理器域名。

### 交付物

`deploy/egress-proxy/{Dockerfile,allowlist.txt,src/proxy.ts}`。

### 具体如何实现

#### 1. 代理本体（`node:http`，两种请求都接）

**a) CONNECT（HTTPS 走这条）**

```ts
server.on("connect", (req, clientSocket, head) => {
  const [host, port] = splitHostPort(req.url);      // "registry.npmjs.org:443"
  if (!allowlisted(host)) { clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); log(...); return; }
  const upstream = net.connect(Number(port), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(clientSocket); clientSocket.pipe(upstream);
  });
  ...
});
```

**b) 绝对 URI 的普通请求（apt 走这条）**

`GET http://deb.debian.org/debian/... HTTP/1.1` —— Debian/Ubuntu 的源是**明文 http**，所以只支持 CONNECT 的代理会让 `apt-get` 完全不能用。必须同时处理绝对 URI 形式并转发。

**c) 域名归一化**：小写、去尾部点（`registry.npmjs.org.` 要跟 `registry.npmjs.org` 命中同一条规则）。这是防绕过，不是洁癖。

#### 2. 白名单（`allowlist.txt`）

一行一个模式，`#` 注释。规则：

- 精确域名：`registry.npmjs.org`
- 子域通配：`*.npmjs.org`（**只允许这一种通配形式**）
- **禁止裸 `*`**。加载时就检查，出现裸 `*` 直接拒绝启动——一条无心的通配会把整个边界变成装饰品。
- **IP 直连一律拒绝**：CONNECT 到 IP 时它不匹配任何域名模式，自然被拒。这是刻意的。

初始清单（每条都要有人 review 过，§F.6.3：白名单的宽度就是信任边界）：

```
registry.npmjs.org          # npm
pypi.org                    # pip
files.pythonhosted.org
proxy.golang.org            # go modules
sum.golang.org
crates.io                   # cargo
static.crates.io
index.crates.io
repo1.maven.org             # maven
deb.debian.org              # apt（http）
security.debian.org
```

**`github.com` / `codeload.github.com` / `raw.githubusercontent.com` / `objects.githubusercontent.com` 全部不在列表里**——仓库由 CP 用 GitHub App 的凭据取，沙箱不需要也不允许碰 GitHub。这是 §F.2 的红线之一。

`allowlist.txt` 支持 SIGHUP 重载（生产上不重启换清单）。

#### 3. 容器与网络

- 代理容器跑在同一台宿主上，**双挂**：`reuben-cloud-internal`（内网，别名 `reuben-cloud-proxy`）+ 默认 `bridge`（有出口）。
- 代理容器同样加固：非 root、`CapDrop: ["ALL"]`（监听 3128 是非特权端口，不需要任何 capability）、`ReadonlyRootfs: true`、`no-new-privileges`。它经手的是不可信流量，没理由给它更多。
- 沙箱通过 `HTTP_PROXY` / `HTTPS_PROXY` / `http_proxy` / `https_proxy`（大小写都给，npm 和 apt 各认各的）+ `NO_PROXY=localhost,127.0.0.1` 找到它。

**关键区分**：这些 env 是**便利**，不是**强制**。强制来自拓扑——沙箱只挂在 `--internal` 网络上，没有默认路由，唯一可达的外部目标就是代理。就算 agent 把自己的代理 env 全删了，它也出不去。§F.2 说的"靠网络拓扑，不靠规则配置"落在这几行。

#### 4. 日志

每请求一行 JSON 到 **stdout**，交给 Docker 的 `json-file` 驱动（启动时带 `--log-opt max-size=100m --log-opt max-file=5`）做轮转：

```json
{"ts":"...","src":"<容器IP>","host":"registry.npmjs.org","port":443,"decision":"allow","in":1024,"out":524288,"ms":312}
```

字段：域名、决策、字节数、耗时。**不记录路径和请求体**（那是内容，我们不解密、也拿不到）。

**与设计的小偏差**：§F.2 说"先只写日志文件"。这里改成 stdout + Docker 的 json-file，理由是省掉自己写轮转——自写轮转是一个新的 bug 来源，而 Docker 已经给了一份带时间戳的持久日志。见附录 A-11。

#### 5. TLS 不需要任何 CA 注入

我们做的是 CONNECT 隧道，**不解密、不 MITM**。所以 npm/pip 的证书校验是端到端的，不需要往沙箱里塞自签 CA。这是 §F.2 明确的设计选择，也顺带把"代理能不能改内容"这个攻击面整个删掉了。

### 技术边界

- **不解密流量**：不做 MITM、不注入 CA、不能做内容检查、不能注入凭据。
- 白名单是**全局静态常量**，不是 per-sandbox / per-task（`SandboxSpec` 里没有 `network` 字段）。改动要重启/重载代理。
- 不允许裸 `*`；不允许 IP；不允许 `github.com`。
- 代理**不持有任何凭据**。
- 已知边界（写进文档，不假装没有）：内网里的容器可以访问宿主上监听 `0.0.0.0` 的服务；同一内网里的沙箱之间互通。MVP 的单任务场景下可接受，M2 再谈 per-sandbox 网络。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | `curl https://registry.npmjs.org/` | 通 |
| 2 | `curl https://github.com` | 失败（超时或 403 而**不是**成功） |
| 3 | CONNECT 到 IP `1.1.1.1:443` | 403 |
| 4 | 非白名单域名 `example.com` | 403 |
| 5 | 大小写 / 尾点绕过 `REGISTRY.NPMJS.ORG.` | 按规则归一化（命中或一律拒，但不能因为归一小把 `evil.com` 放进去） |
| 6 | 明文 HTTP 转发 | `curl http://deb.debian.org/debian/dists/stable/Release` 通 |
| 7 | 日志行 | 含域名、决策、字节数 |
| 8 | **真实装包**：容器内 `npm install <小包>` | 成功 |
| 9 | **真实装包**：`pip install requests` | 成功 |
| 10 | DNS：`getent hosts npmjs.org` | 失败（内网没有出口 DNS）；但服务名 `reuben-cloud-proxy` 能解析（Docker 内网 DNS） |
| 11 | 裸 `*` 配置 | 代理**拒绝启动** |
| 12 | SIGHUP 重载 | 加一行后新域名生效，旧连接不受影响 |

### 验收标准

- [ ] 上表 12 项全绿
- [ ] §J 网络两条红线达成：非白名单（含 github.com）不可达、白名单可装包
- [ ] 代理日志里能看到全部出网域名
- [ ] `curl https://github.com` 从沙箱里**确实失败**

**完成标记：**
- [ ] **Phase 6 完成** — 出网被白名单限制，github.com 不可达

---

## Phase 7 · 冒烟脚本与隔离红线 CI

**目标**：§J 的验收变成一条命令，跑在 Linux 上，并且**有牙齿**（故意破坏一个加固参数，它必须变红）。

### 交付物

`packages/e2e/src/smoke.ts`（外加若干 `*.smoke.ts`）、`.github/workflows/smoke.yml`。

### 具体如何实现

#### 1. 脚本形态

`node --test packages/e2e`，用 `--test-reporter=spec` 输出。按标签分组，便于本地只跑一部分：

```
npm run smoke                    # 全部
npm run smoke -- --tag=isolation # 只跑红线
npm run smoke -- --tag=network
```

**这个阶段的冒烟脚本直接调 provider + agent HTTP，不经过 CP 业务层**（Phase 8 还没落地）。这样它从 Phase 5 就能开始跑，不用等控制面。

#### 2. §J 的隔离红线（`isolation` 组）

全部通过 `/exec` 在容器里跑（顺带把 exec 也测了）：

| # | 命令 | 期望 |
|---|---|---|
| I1 | `id -u` | `1000` |
| I2 | `touch /nope` | 失败（只读根） |
| I3 | `touch /workspace/a; touch /tmp/b; touch $HOME/c` | 全部成功 |
| I4 | `ls -l /var/run/docker.sock` | 不存在 |
| I5 | `curl https://github.com` | 失败 |
| I6 | `curl https://registry.npmjs.org/` | 成功 |
| I7 | 申请 4 GiB 内存的进程 | 被 OOM kill；容器仍存活、`/health` 仍有响应 |
| I8 | fork 炸弹 | 被 `pids-limit` 挡下；**agent 仍然响应 `/health`** |
| I9 | 容器内 `git config -l` + `env` + 对 `/` 做关键词搜索 | 无任何 GitHub token / 私钥痕迹 |
| I10 | `docker inspect` 复核 Phase 5 那张参数表 | 全中 |

#### 3. §J 的业务链路（`flow` 组）

1. create → health
2. CP clone 一个测试仓库 → tar → `PUT /files` → `exec tar xzf`（Phase 9 之后才能全自动；Phase 7 里用预置的 tar 文件）
3. `exec npm ci && npm test` → 收到 SSE 流、拿到退出码
4. 改一个文件 → `GET /diff` → patch 非空
5. `GET /archive` → 落对象存储（Phase 10 之后）
6. destroy → 容器和卷都没了
7. **全程断言**：三张表状态正确（Phase 8 之后）

#### 4. CI（`.github/workflows/smoke.yml`）

```yaml
on: [pull_request]
jobs:
  smoke:
    runs-on: ubuntu-latest        # ← 必须 Linux
    steps:
      - checkout
      - setup-node 24
      - npm ci
      - docker network create ... （不需要，provider 自己建）
      - run: npm run smoke
```

- **必须跑在 Linux 上**。§J 明写了理由：macOS Docker Desktop 的内核/seccomp 行为不同，红线在那里得不到验证。
- 本地 macOS 开发跑 `--tag=exec,files,flow`，跳过 `isolation`。
- **CI 里不允许存在跳过失败项的开关**。任何 `--skip` 都只在本地跑得住，CI 无条件全绿。

#### 5. 反向验证（**这一步不能省**）

CI 里加一个**故意破坏**的 job：用环境变量把 `CapDrop` 设成 `[]`（只在这一条特殊路径下允许覆盖，且代码里要显式写 `if (process.env.SMOKE_NEGATIVE_CONTROL)`，一眼能看出这是个测试钩子），跑 `--tag=isolation`，**断言它必须失败**。

没有这一步，红线测试就只是一段永远绿的装饰性代码——你永远不知道它是不是其实什么都没在测。

### 技术边界

- 冒烟脚本是 e2e，**不进单元测试套件**（`npm test` 不带 Docker、不带它）。
- 只能跑在 Linux（CI）；macOS 只跑子集。
- 不允许"跳过失败项"的开关进入 CI。

### 验收标准

- [ ] CI 上 `npm run smoke` 全绿
- [ ] **反向验证 job 红了**（证明脚本有牙齿）
- [ ] 手工把 `CapDrop` 去掉再跑一次，本地也变红
- [ ] §J 的 11 项红线逐条能在 CI 日志里找到对应输出

**完成标记：**
- [ ] **Phase 7 完成** — 隔离红线在 Linux CI 上被自动验证，且有反向验证

---
---

# 第三部分 · 控制面

---

## Phase 8 · 持久层：三张表、状态机、对账

**目标**：状态只在 Postgres 里，**只能通过 `transition()` 改**；CP 崩了重启能自己把状态理清。

### 交付物

`packages/control-plane/src/db/{client.ts,migrations/*.sql,sandboxes.ts,executions.ts,artifacts.ts}`、`src/manager/{sandbox-manager.ts,reconcile.ts,sweeper.ts}`、`src/client/{sandbox-api.ts,sse.ts}`、`scripts/migrate.ts`。

### 具体如何实现

#### 1. 迁移

`migrations/001_init.sql`、`002_...sql`，`schema_migrations` 表记已应用的文件名。迁移脚本按文件名排序、逐个在事务里跑。不引 ORM、不引 knex——三张表而已，SQL 直接看得见最好。

#### 2. 表（照 §G，加一处）

`sandboxes` / `executions` / `artifacts` 按 §G 的字段建，索引按 §G 建。三点补充：

- `sandboxes` 的 `task_id` / `run_id` 是**可空 text、没有外键**——`tasks`/`runs` 表是 M3 的事，现在建了就是空壳。
- `executions.env_keys` 存 **jsonb 数组，只有 key 名，绝不存值**。这条要么在 insert 处硬编码，要么在测试里断言。
- **新增第四张表 `sandbox_state_transitions`**（id, sandbox_id, from_state, to_state, reason, at）。§D 说"每次转换写审计日志，这是崩溃恢复的唯一依据"——审计日志得有个地方落。见附录 A-7。

`artifacts.kind` 取值 `diff` / `workspace_archive` / **`exec_log`**（第三个是新增，见 A-8）。

#### 3. `transition()` —— 唯一的写状态入口

```ts
async function transition(
  id: string,
  from: SandboxState[],      // 期望的当前状态集合
  to: SandboxState,
  reason: string,
  patch?: Partial<SandboxRow>,
): Promise<{ ok: true; from: SandboxState } | { ok: false; current: SandboxState }>
```

实现在**一个事务**里：`SELECT ... FOR UPDATE`（拿到真正的旧状态）→ 校验旧状态在 `from` 里 → `UPDATE` → `INSERT` 审计行。状态不在允许集合里 → 返回 `{ok:false, current}`，调用方转 409。

**怎么强制"业务代码不许直接 UPDATE state"**：两条一起上。

1. **推荐**：建一个 `SECURITY DEFINER` 的 Postgres 函数 `sandbox_transition(...)`，把 `state` 列的直接 UPDATE 权限从应用角色上收掉。这样是数据库在拦，不是靠自觉。
2. **兜底**：一条 grep 测试——`SET state` 这个字符串只允许出现在 `db/sandboxes.ts` 里。便宜、有效。

两条都做。第二条能拦住新来的同学，第一条能拦住所有人。

#### 4. `SandboxManager`

**`createSandbox({runId, taskId, image, limits})`**：

1. **先生成 `sbx_<ulid>` 并 INSERT 一行 `CREATING`**，然后才调 provider。顺序不能反——崩在 create 中途时，DB 里有一行可对账的记录，而不是一个没人知道的孤儿容器。
2. `provider.create(spec)`，`spec.labels` 带上 sandboxId / runId（provider 用它命名容器和卷）。
3. 成功 → 落 `endpoint` / `provider_ref` → `transition(READY)`。
4. 失败 → `transition(ERROR, reason)`，reason 取自 provider 的结构化原因（`health_timeout` / `image_pull_failed` / ...）。

**`execInSandbox(sandboxId, req)`**：

1. 查状态，非 READY → 409。
2. `transition(BUSY)`。
3. `POST /exec` → 拿 `execution_id`。
4. 打开 SSE（带 `Last-Event-ID` 重连）→ 边收边转发给上层消费者。
5. **看门狗**：`timeoutMs + 30_000` 的定时器。到点还没收到终态事件 → 调 `/kill`；`/kill` 也失败 → `transition(ERROR, "watchdog_timeout")`。这是**第二道**防线，第一道是沙箱侧自己的超时（Phase 1 §9）。两道都要有。
6. 收到终态 → 写 `executions` 行（含 `stdout_bytes` / `stderr_bytes` / `truncated` / `log_path`）→ `transition(READY)`。

**SSE 客户端自己写**（`client/sse.ts`，约 80 行）：用 `fetch` 拿 `response.body`，手写逐行解析。必须处理：跨 chunk 的事件帧、`:` 开头的注释行（心跳）、多行 `data:`。重连时显式带上 `Last-Event-ID` 头（手写客户端不会像浏览器 `EventSource` 那样自动带），最多重连 3 次，之后判 ERROR。

**TTL 清扫（`sweeper.ts`）**：每 60 秒扫一次 `(state, last_active_at)` 索引，超过 `ttlSec`（默认 6h）的 → 先归档（Phase 10）→ destroy → `transition(DESTROYED, "ttl_expired")`。§D 说得对：TTL 是安全网，不是调度器。

**`last_active_at`** 在每次 exec 开始时刷新。

#### 5. 启动对账（`reconcile.ts`）

CP 起来时跑一次，全部动作走 `transition()`：

1. 列出 DB 里 `CREATING` / `READY` / `BUSY` 的行。
2. 对每一行：`provider.inspect(sandboxId)`。
   - 容器不在 → `transition(ERROR, "container_lost")`。
   - 容器在，agent `/health` 返回 `status:"error"` → `transition(ERROR, "agent_error")`。
   - 容器在，行是 `BUSY` 且 agent 报 `activeExecution` 非空 → **这是 CP 重启时最麻烦的一种**：一个执行在跑，但它的 SSE 消费者已经不在了。做法：调 `/kill` 杀掉它，写一条 `executions` 行标 `killed`，reason 记 `cp_restart`，然后 `transition(READY)`。保守但诚实——总比留下一个没人看、结果也拿不到的执行好。
   - 其余 → `transition(READY)`（或保持）。
3. `provider.listManaged()` 里 DB 中不存在的容器 → 删掉（孤儿，多半是上一次 CP 崩在 create 中间留下的）。
4. DB 里 `DESTROYED` 但容器还在的 → 也走第 3 步被扫掉。

对账必须**幂等且可重入**：跑两次结果一样。

### 技术边界

- 状态的唯一权威在 DB；沙箱不维护业务状态。
- **只能通过 `transition()` 改状态**。
- 超时分层照 §D 的表，不要自己发明新的层。
- **不做**：`tasks`/`runs` 表、任务队列、配额、多实例 CP。MVP 单实例；多实例需要 advisory lock + `SKIP LOCKED`，M1 再说。
- 对账默认只在启动时跑一次（定时对账是可选加强，不是必需）。
- `auth_token` 明文存（TTL 6h、只保护内网端口、DB 本身在可信域内）。这条要有意识地记一笔，别让它在 code review 时变成一个惊喜。

### 测试要点

测试用一次性 Postgres 容器。

| # | 用例 | 断言 |
|---|---|---|
| 1 | 合法转换全路径 | CREATING→READY→BUSY→READY→DESTROYED 全通过，每条都留下审计行 |
| 2 | 非法转换 | `DESTROYED→BUSY`、`READY→CREATING` 被拒，返回当前状态 |
| 3 | grep 测试 | 除 `db/sandboxes.ts` 外无 `SET state` |
| 4 | **对账：容器丢失** | 手工删容器 → 重启 CP → 该行变 `ERROR(container_lost)` |
| 5 | **对账：孤儿容器** | 手工建一个带 `reuben-cloud.managed` 标签的容器 → 重启 → 被删 |
| 6 | **对账：BUSY 且有执行在跑** | 构造该状态 → 重启 → 执行被 kill、executions 里多一行 killed、行转 READY |
| 7 | 对账幂等 | 连跑两次，第二次不产生任何状态变化 |
| 8 | 看门狗 | 用一个不返回终态事件的假 agent → 到点后 `/kill` 被调用（假 agent 记录调用） |
| 9 | TTL | `ttlSec=5` → 自动 destroy、状态 `DESTROYED`、reason `ttl_expired` |
| 10 | CP 被 kill -9 | 重启后状态与真实容器一致 |
| 11 | SSE 解析器单测 | 跨 chunk 帧、心跳注释行、多行 data、`Last-Event-ID` 重连 |

### 验收标准

- [ ] 上表 11 项全绿
- [ ] 手工 `docker kill` 掉一个沙箱容器，重启 CP，状态自愈为 ERROR
- [ ] 手工 `docker run` 一个带标签的孤儿容器，重启 CP，它被删掉
- [ ] 审计表里能看到一次完整的 CREATING→READY→BUSY→READY→DESTROYED 轨迹

**完成标记：**
- [ ] **Phase 8 完成** — 状态机、审计、对账、看门狗全部可用

---

## Phase 9 · 仓库进出：clone → 灌入 → diff → apply → push

**目标**：给定 GitHub 仓库 + commit，CP 能把仓库灌进沙箱；沙箱改完之后，CP 能把改动变成一个**可应用的 patch**、推成一条分支，并且**沙箱里从来没有过任何 GitHub 凭据**。

### 交付物

`packages/control-plane/src/repo/{github-app.ts,clone.ts,pack.ts,inject.ts,apply.ts,push.ts}`。

### 具体如何实现

#### 1. GitHub App token（`github-app.ts`）

- App 权限只要两个：`contents: write`、`pull_requests: write`（外加 GitHub 强制的 `metadata: read`）。
- 私钥从 env / secret manager 读，**只在 CP 进程内**。
- `@octokit/auth-app` 的 `auth({type:"installation", installationId, repositoryNames:[repo]})` —— 用 `repositoryNames` 把 token 限定到选定仓库。
- 缓存 token，**提前 5 分钟过期**（TTL 1h）。
- 启动时检查私钥存在且可解析；缺失就退出，不要等到第一次 clone 才炸。

#### 2. clone（`clone.ts`）—— 凭据绝不落盘

**关键实现细节**：用 `-c http.extraHeader=...` 传 token，**绝不把 token 放进 remote URL**。

```
git -c http.extraHeader="Authorization: Basic <base64(x-access-token:<token>)>" \
    clone --no-single-branch <repo> <dir>
```

为什么不能写 `https://x-access-token:TOKEN@github.com/...`：那个 URL 会被写进 `.git/config`；而我们马上要把**带 `.git` 的整个仓库**打成 tar 灌进沙箱 —— token 就跟着进去了，正好踩中 §J 的"沙箱内零 GitHub 凭据"红线。

`-c` 形式的配置**只作用于这一次命令**，不写入任何文件。这是这条红线的实现方式，值得写进注释。

其他：

- `GIT_TERMINAL_PROMPT=0`（禁止任何交互提示）。
- clone 到 `/tmp/reuben-cloud-cp/<runId>/repo`，`finally` 里 `rm -rf`（崩溃残留由启动时清理 `/tmp/reuben-cloud-cp/*` 兜底）。
- 不做 shallow clone：目标 commit 可能不是 tip，shallow 里可能不存在。`--filter=blob:none` 之类是性能优化，先不做。
- `git checkout <commit>` 到指定 commit。
- **submodule 不初始化**（`--recurse-submodules` 不加）。含 submodule 的仓库 MVP 支持有限，写进边界。

#### 3. 灌入（`pack.ts` + `inject.ts`）

```
tar czf - -C <cloneDir> .        # 含 .git
→ PUT /files?path=/workspace/repo.tar.gz   （流式，边算 sha256）
→ POST /exec { cmd: ["tar","xzf","/workspace/repo.tar.gz","-C","/workspace"] }
→ POST /exec { cmd: ["rm","/workspace/repo.tar.gz"] }
```

- 用系统 `tar`，零依赖。
- **灌入前检查**：`git -C <cloneDir> config -l | grep -i token` 必须为空（这是 clone 那步的实现验证，也顺便是一条测试断言）。
- 灌入后记下当前的 commit sha，作为后面 `/diff?base=` 的参数。

#### 4. 取回（`apply.ts`）

1. `GET /diff?base=<sha>` → `{patch, files, patch_bytes}`。
2. patch 超限（`truncated:true`）→ `GET /files?path=<patch_log_path>&raw=1` 拿回完整 patch。
3. 在 CP 的 clone 里 `git -C <cloneDir> apply --binary`。
   `--binary` 是必须的（Phase 3 已经解释过）。
4. **忠实度校验**：apply 之后，CP 在自己这里再算一次 `git diff <base>` 的 sha256，**必须等于沙箱返回的 patch 的 sha256**。不等就说明应用不完整（CRLF、filemode、空白丢失），直接判失败而不是推出一个错的 commit。这是本文档在 §K 之外加的一道校验，成本几毫秒，能拦住一整类"推上去的代码和沙箱里验证过的不是同一份"的事故。
5. apply 失败 → **回退 archive**：`GET /archive` → 解到 CP 临时目录 → 用整棵树替换 clone 的工作区 → 从这棵树上生成 patch。
   解包时：`tar xzf - --no-same-owner -C <空目录>`，**不加** `-P/--absolute-names`（Phase 3 已经提醒过）。

#### 5. 推送（`push.ts`）

```
git -c http.extraHeader="..." push origin HEAD:refs/heads/reuben-cloud/<taskId>
```

- 同样用 `-c`，同样不落盘。
- 分支已存在时用 `--force-with-lease`：**它保护的是"远端分支不是我们上次推的那个 sha"的情况**——如果人手动改过这条分支，推会被拒，而不是被静默覆盖。被拒时如实报告，不要 `--force`。
- commit message：`reuben-cloud: <task title>` + 附 run id / 第几次尝试。
- MVP 分支命名：一个 Task 固定一条 `reuben-cloud/<taskId>`，重跑覆盖，PR 描述里写明是第几次 Run。这是产品取舍，值得记一笔（见附录 A-12）。

### 技术边界

- **所有 GitHub 凭据只在 CP**：沙箱里 `.git/config`、env、磁盘全文搜索都不得出现。这条是 §J 红线，也要进 Phase 7 的冒烟脚本。
- clone/push 一律 `-c http.extraHeader`，**永不写入 remote URL**。
- 临时目录用完即删，且都在 `/tmp/reuben-cloud-cp/` 下，便于崩溃后统一清理。
- **不做**：GitLab、多仓库、submodule 完整支持、LFS。
- patch 应用失败必须走 archive 回退，且回退路径也要被测试覆盖。
- 不直接改用户的分支；不推 main。

### 测试要点

用一个 fixture 仓库（本地 bare repo 或 GitHub 上的私有测试仓库）。

| # | 用例 | 断言 |
|---|---|---|
| 1 | 端到端 | clone → tar → PUT → exec 解包 → 改文件 → `/diff` → apply → **两边树 sha256 相等** |
| 2 | 二进制文件改动 | `--binary` patch 正确应用 |
| 3 | 新增未跟踪文件 / 删除 / 重命名 | 都出现在 patch 里且能应用 |
| 4 | **token 不落盘** | clone 后 `grep -r <token> /tmp/reuben-cloud-cp` 无命中 |
| 5 | **沙箱内零凭据** | 解包后容器内 `git config -l`、`env`、对 `/workspace` 全盘搜索 —— 无 token、无私钥 |
| 6 | patch 应用失败回退 | 人为构造一个应用不了的 patch → 走 archive 回退并成功 |
| 7 | 权限 | 用另一个仓库的 installation 权限 → 403，报错清晰 |
| 8 | 推送 | 远端出现 `reuben-cloud/<taskId>`，commit 内容与 patch 一致 |
| 9 | **force-with-lease 保护** | 模拟远端分支被第三方改动 → 推被拒、报告而不是覆盖 |
| 10 | 临时目录清理 | 成功和失败路径都不留下 `/tmp/reuben-cloud-cp/<runId>` |

### 验收标准

- [ ] 上表 10 项全绿
- [ ] §K 第 5 步的验证：仓库进得去、patch 出得来并能应用
- [ ] **token 泄漏测试通过**（第 4、5 条）
- [ ] archive 回退路径被真实触发过一次（不是只有代码）

**完成标记：**
- [ ] **Phase 9 完成** — 仓库能进能出，patch 忠实且可应用，凭据零泄漏

---

## Phase 10 · 归档与对象存储

**目标**：沙箱销毁之前，它的产出（patch、归档、重要的执行日志）已经在对象存储里了。

### 交付物

`packages/control-plane/src/artifacts/{store.ts,offload.ts}` + 接进 `SandboxManager` 的销毁流程。

### 具体如何实现

#### 1. 存储客户端（`store.ts`）

- `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` 的 `Upload`（分段上传，**不需要预先知道 content-length**——沙箱是流式给我们的，我们不可能先知道大小）。
- 配置全走 env：`S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`。开发环境用 MinIO（`docker run -p 9000:9000 minio/minio server /data`）。
- Key 布局：
  ```
  runs/<runId>/diff.patch
  runs/<runId>/workspace-<sandboxId>.tar.gz
  runs/<runId>/exec/<executionId>.log
  runs/<runId>/transcript.jsonl        # Phase 11
  ```
- **边传边算 sha256**：用一个 `PassThrough` 分流到 hash 和上传。不要为了算 hash 把流读两遍。
- `Upload` 参数 `{ queueSize: 1, partSize: 8MB }` —— 单并发分段，避免 CP 同时把多个 8MB 分片读进内存。

#### 2. 销毁流程（顺序是重点）

```
1. GET /diff                       → 上传 diff.patch       → artifacts(kind=diff)
2. GET /archive?dryRun=1           → 体积软配额检查（超过就记警告，不阻断）
3. GET /archive                    → 流式分段上传          → artifacts(kind=workspace_archive)
4. 转存 truncated=true 的执行日志  → artifacts(kind=exec_log)
5. transition(DESTROYED)
6. provider.destroy()              → 容器、卷
```

- **归档必须在销毁之前**：§A 的原则——沙箱只产出流，CP 决定存哪；销毁后 sandbox 的 `log_path` 就没意义了。
- **第 4 步只转存 `truncated=true` 的执行**。理由：没截断的输出在事件流里已经完整送到 CP 了；重复存一份是纯粹的浪费。§G.2 说的"重要输出在销毁前转存"里的"重要"，定义就是"事件流里没有完整版"。
- **归档失败怎么办**（这是一条真实的策略，不是边界情况）：
  1. 指数退避重试 3 次。
  2. 仍失败 → 标记 `archived=false`，**不立刻销毁**，`transition(ERROR, "archive_failed")`。
  3. 10 分钟宽限期后再试一次；仍失败 → 强制销毁，并把 `archive_failed` 写进 Run 结果。
  也就是：尽力保，但有界。一个永远存不上去的归档不能把容器无限期留着。

#### 3. `artifacts` 行

每次上传成功写一行：`{id, run_id, sandbox_id, kind, object_key, size_bytes, sha256, created_at}`。

- `size_bytes` / `sha256` 用上传过程中算的值（跟内容一致，不是事后 `HEAD` 拿的）。
- **不做自动过期**。对象 key 带 runId，批量删是 M3 的事。这条写进边界。

### 技术边界

- 沙箱销毁后 `log_path` 失效；对象存储是产出的唯一长期载体。
- 上传**必须流式**：不允许把 2 GiB 归档读进内存。
- 归档失败不无限阻塞销毁（策略如上）。
- 归档内容**不进模型上下文**——它只是文件。
- **不做**：生命周期策略、跨区复制、应用层加密（SSE 由 bucket 配置管）。

### 测试要点

用 MinIO 容器。

| # | 用例 | 断言 |
|---|---|---|
| 1 | archive → 对象存在 | size 与 `dryRun` 报的一致；sha256 与本地算的一致 |
| 2 | 下载回来解包 | 文件清单与内容与源一致 |
| 3 | **流式**：上传 1 GiB 归档 | CP RSS 增量 < 100 MiB |
| 4 | 重试 | MinIO 不可用 → 重试 3 次 → 状态 `ERROR(archive_failed)`、无 artifacts 行 |
| 5 | 宽限期后强制销毁 | 超时后容器确实被销毁，Run 结果里有 `archive_failed` |
| 6 | log 转存 | `truncated=true` 的日志对象字节数 = `stdout_bytes + stderr_bytes` |
| 7 | 顺序 | destroy 之后对象仍可下载 |
| 8 | §J.7 | 归档落对象存储 + 沙箱销毁 + DB 三张表状态正确（一条端到端断言） |

### 验收标准

- [ ] 上表 8 项全绿
- [ ] §J.6：archive 包含被 `.gitignore` 排除的构建产物
- [ ] §J.7：归档落对象存储、沙箱销毁、DB 状态正确
- [ ] MinIO 挂掉时销毁流程不会永远挂着

**完成标记：**
- [ ] **Phase 10 完成** — 产出在销毁前落到对象存储

---
---

# 第四部分 · Agent 与交付

---

## Phase 11 · Agent 循环 + 4 个工具

**目标**：给一个真实 issue，模型能自己探索仓库、跑测试、改代码，最后产出一个 patch。

### 交付物

`packages/control-plane/src/agent/{loop.ts,prompt.ts,transcript.ts,model.ts}` + `src/agent/tools/{bash,read,write,list}.ts`。

### 具体如何实现

#### 1. 循环在 CP，不在沙箱

§A 给的四条理由（凭据不进沙箱、循环逻辑是可迭代资产、可观测性、零延迟代价）决定了这一段的物理位置。落到代码：`loop.ts` 只在 control-plane 包里，`sandbox-agent` 完全不知道模型的存在。

#### 2. 模型客户端（`model.ts`）

```ts
export interface ModelClient {
  create(req: {
    system: string;
    messages: Message[];
    tools: ToolDef[];
    maxTokens: number;
    onText?: (delta: string) => void;
  }): Promise<{ content: ContentBlock[]; stopReason: string; usage: Usage }>;
}
```

MVP 只实现 Anthropic 一家（README 说的"多 provider 抽象"留着接口，不实现第二家）。

Anthropic 实现要点：

- 模型 `claude-opus-4-8`（默认；env `REUBEN_CLOUD_MODEL` 可覆盖）。
- `thinking: { type: "adaptive" }` —— agent 循环属于"相当复杂"那一档，思考打开。
- `output_config: { effort: "high" }`（编码/agentic 任务；这个参数比模型选型更影响成本与质量的平衡，值得在 Phase 11 结束时扫一遍 medium/high/xhigh 再定）。
- **用 `client.messages.stream(...)` + `await stream.finalMessage()`**：agent 循环的 `max_tokens` 要给足（64000），非流式请求在这个量级会撞 SDK 的 HTTP 超时。`onText` 回调把文字增量推给 Phase 13 的 transcript（没有 UI 时它就是 no-op）。
- 不传 `temperature` / `top_p` / `top_k`——这些在当前模型上已被移除，传了会 400。
- `stop_reason === "refusal"` 要当成一种正常终态处理（`content` 可能为空），不要当成异常。Phase 12 的 PR 描述里要如实写明"模型拒绝了这次请求"。

#### 3. 工具定义（4 个）

用**手写的 JSON Schema 字面量**，不引 zod。理由：只有 4 个工具、每个 2–3 个参数，手写 schema 是 30 行，而 zod 要走 `zod → JSON Schema` 转换得再引一个包。**触发条件**：工具数超过 10 个、或者出现嵌套结构，就换成 zod + 转换器。这条留在这里，免得日后反复讨论。

每个工具都要写清**什么时候调用**，不只是做什么——工具描述里的触发条件对 should-call 率有明显影响：

| 工具 | 对应沙箱 API | 参数 |
|---|---|---|
| `bash` | `POST /exec` | `{cmd: string[], cwd?, timeoutMs?}` —— schema 里明确写"cmd 是 argv 数组，不是 shell 字符串；需要管道时显式用 `["bash","-lc","..."]`" |
| `read` | `GET /files` | `{path, offset?, limit?}` |
| `write` | `PUT /files` | `{path, content}` |
| `list` | `GET /files/list` | `{path, depth?}` |

参数校验**自己写**一小段（30 行）：必填项、类型、`cmd` 必须是非空字符串数组。校验失败不要抛异常，返回 `is_error: true` 的 `tool_result` 并把原因说清楚——让模型自己改。

工具的返回值就是 `tool_result` 的字符串内容。

#### 4. 循环（`loop.ts`）

```
messages = [user: <issue + 任务说明>]
for turn in 1..MAX_TURNS(40):
  resp = model.create({system, messages, tools})
  transcript.write(resp)
  messages.push({role:"assistant", content: resp.content})   // 必须整块 push，保留 tool_use
  if resp.stopReason === "end_turn": break
  if resp.stopReason === "refusal": 记录并 break
  if resp.stopReason === "max_tokens": 记警告 + 提高 max_tokens 重试一次（或 break）
  toolUses = resp.content.filter(b => b.type === "tool_use")
  results = 并行执行所有 toolUses（沙箱单执行闸会串行化，但读类工具可以并发发起）
  messages.push({role:"user", content: results})   // 所有 tool_result 放在同一条 user 消息里
```

必须遵守的几条：

- **一次响应里的多个 `tool_use` 的结果，要放在同一条 `user` 消息里返回**。拆成多条会训练模型不再并行调用工具。
- 失败的工具有返回：`{type:"tool_result", tool_use_id, content:"<错误>", is_error:true}`。**不要丢掉它**。
- **循环硬上限**：40 轮（`MAX_TURNS`）、总墙钟 30 分钟、累计输出 token 上限。三个都要有，到任何一个就停，并在 Run 结果里如实写"因达到上限而停止"。
- **重复调用检测**：同一工具 + 同样参数连续出现 3 次 → 往对话里插一条提示（"你已经用相同参数调用过这个工具三次，换一个方法或者说明你卡在哪"），再犯就停。
- 上下文的 MVP 策略：**工具结果外置 + 简单的旧结果裁剪**。完整版 ContextCompiler 是 M2 的事，现在不做。裁剪只丢最旧的 `tool_result` 内容，**不丢 user/assistant 的文字**。

#### 5. 工具结果外置

- 阈值：单次工具结果的文本超过 **8 KiB**（或 200 行）→ 全文写到沙箱的 `/tmp/reuben-cloud/out/<executionId>.txt`，`tool_result` 里只放：前 50 行 + 总数 + 文件路径 + 一句"用 read 工具读完整内容"。
- 为什么要写进沙箱而不是留在 CP 内存：模型下一轮要用 `read` 工具**按范围**读回来。留在 CP 里就没有"按范围读"这个动作了，模型只能让你把整段塞回去。
- 这就用上了 Phase 2 的**只读第二根** `/tmp/reuben-cloud`。写仍然只在 `/workspace`。
- 上限：单个外置文件 ≤ 32 MiB，总数 ≤ 64 个；超了就直接给更狠的摘要（这是防 `/tmp` 被塞满的兜底，不是主要机制）。

#### 6. System prompt（`prompt.ts`）

MVP 版本要讲清楚的事：

- 你在一个隔离沙箱里，工作目录 `/workspace/repo`。
- **`bash` 的 `cmd` 是 argv 数组**；要管道/重定向就 `["bash","-lc","..."]`。
- **没有交互式 stdin**：`npm init` 这类需要交互的命令必须带 `-y`；任何等输入的程序会立刻读到 EOF 失败。
- 没有 `github.com`：不要试图 `git clone` / `curl` GitHub。
- 改完之后**跑测试**再收工。
- 输出要节制：不要 `cat` 整个大文件（用 `read` 的 offset/limit）；不要 `ls -R` 整个仓库。

刻意保持短。提示词是要迭代的东西，第一版写长了反而不好改。

**提示词缓存**：`tools` → `system` → `messages` 是渲染顺序，缓存是前缀匹配。做法：

- 把 `cache_control: {type:"ephemeral"}` 打在 **system 的最后一块**上，它会把 tools + system 一起缓存。
- 这个前缀**必须字节稳定**：不要把 runId、时间戳、当前 commit 插进 system——一插进去每轮都重新写缓存。
- 模型是多轮追加式的，所以前缀天然稳定，命中率会随轮数累积。
- 验证方式：看 `usage.cache_read_input_tokens`。如果反复请求都是 0，说明前缀里有东西在变（最常见的是工具列表顺序不稳——工具数组要**按名字排序后**再传）。
- 注意最小可缓存前缀：当前模型是 4096 token。system + tools 加起来不够长的话，标记了也不会缓存（静默不生效）。

#### 7. Transcript（`transcript.ts`）

- 每个 Run 一个 JSONL：每轮模型请求与响应**原样**追加（含 system、tools、usage）。
- 追加写本地文件，Run 结束时上传对象存储（`runs/<runId>/transcript.jsonl`）。
- **完整 prompt 必须落盘**——这是 README "一切可回放"那条原则的前提。少了它，agent 行为出问题时你只能猜。
- 为什么不进 DB：一次 Run 的 transcript 可能几十 MB，塞 jsonb 是自找麻烦。

### 技术边界

- **不做**：ContextCompiler、RepoMap、子 agent、Memory、MCP（全是 M2+）。
- 不做多 provider 路由（接口留着，实现一家）。
- 不做流式 token 到 UI（Phase 13 才做；`onText` 回调预留接口）。
- 循环必须有硬上限（轮数 / 墙钟 / token）。
- 模型 API key **只在 CP**，从不进沙箱（这是 §F.3 的红线之一）。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 假模型驱动循环 | 给定固定 `tool_use` 序列 → 工具被正确调用、结果被回填、循环正常终止 |
| 2 | 并行工具 | 一条响应里两个 `tool_use` → 两个 `tool_result` 在**同一条** user 消息里 |
| 3 | 工具参数校验 | `cmd` 是字符串不是数组 → `is_error:true`，不抛异常 |
| 4 | 工具失败 | `read` 越界 → `is_error:true`，循环继续 |
| 5 | 结果外置 | 200 KB 的 bash 输出 → 上下文里只有摘要 + 路径；`read` 能按 offset 读回原文 |
| 6 | 轮数上限 | 永远调用工具的 stub → 40 轮后停止，Run 结果如实说明 |
| 7 | 重复检测 | 连续 3 次相同调用 → 注入提示；再犯 → 停止 |
| 8 | 真实模型 smoke（`@live`，默认跳过） | 预置一个失败的测试，真跑一遍产出 patch |
| 9 | transcript 完整性 | JSONL 里含 system、tools、每轮的 usage |
| 10 | 缓存命中 | 多轮之后 `cache_read_input_tokens > 0` |
| 11 | key 不进沙箱 | 容器内全盘搜索无模型 API key |

### 验收标准

- [ ] 上表 11 项全绿（`@live` 那项在本地手工跑过一次）
- [ ] §K 第 9 步：给一个真实 issue，跑完产出一个 patch
- [ ] transcript 能在不重跑的情况下还原出每一轮的输入输出
- [ ] `cache_read_input_tokens` 在多轮时确实非 0

**完成标记：**
- [ ] **Phase 11 完成** — Agent 循环能针对真实 issue 产出 patch

---

## Phase 12 · GitHub App 与 PR

**目标**：issue 进来 → 一条 PR 出去，端到端。

### 交付物

`packages/control-plane/src/repo/pr.ts` + 接进 Run 的收尾流程。

### 具体如何实现

#### 1. Token 与推送

复用 Phase 9 的 `github-app.ts`。推送已在 Phase 9 完成，这里只多一件事：**推送前确认工作区干净**（`git status --porcelain` 为空），避免把 CP 临时目录里的垃圾带上去。

#### 2. 创建 PR

```
POST /repos/{owner}/{repo}/pulls
{ title: "reuben-cloud: <task title>",
  head: "reuben-cloud/<taskId>",
  base: "<默认分支>",
  draft: true,
  body: <见下> }
```

**默认 draft**。理由：draft 明确表示"等人工确认"，也避免自动触发评审请求。这是产品决策，值得记一笔（附录 A-13）。

PR 正文要有的东西（这是 README 说的"可信度报告"的雏形）：

- 改动的文件数与 +/− 行数
- **测试有没有跑过、跑的结果是什么**（没跑就跑，跑不过就如实写）
- 用的哪个模型、哪次 Run、attempt 序号
- transcript 的对象存储链接
- 一句话说明"这是自动生成的，请人工 review"

#### 3. 幂等与冲突

- 同 Task 重复 Run：分支被 `--force-with-lease` 覆盖，PR 已存在 → `PATCH` 更新标题/正文，**不新建**。
- 分支名冲突：`reuben-cloud/*` 是我们自己的命名空间。`--force-with-lease` 会在"远端那个分支不是我们上次推的 sha"时拒绝——这时候报告并停止，**绝不 `--force`**。用户手动改过的分支不能被静默覆盖。
- 触发条件判定：`GET /repos/{owner}/{repo}/pulls?head=owner:reuben-cloud/<taskId>&state=open` → 有就更新，没有就创建。

#### 4. 失败模式

每种都要给结构化错误，不要抛出字符串：

| 情况 | 处理 |
|---|---|
| 权限不足（403） | 报告缺哪个权限，停止 |
| 分支保护拒绝推 | 报告保护规则，停止 |
| Rate limit（403 + `retry-after`） | 按 `retry-after` 等待重试，最多 3 次 |
| 仓库被删 / 不可见（404） | 报告并停止 |
| PR 已存在且 base 分支变了 | 更新 base 而不是重建 |

### 技术边界

- **不做** webhook / 触发器（M3）、不做 GitLab、不做审批流。
- 不直接改用户的分支、不推 main、不合并 PR。
- PR 默认 draft。
- 不做 PR 正文的模型生成（MVP 用模板 + 实数）；"可信度报告"的完整版是 M1。

### 测试要点

| # | 用例 | 断言 |
|---|---|---|
| 1 | 端到端 | issue → patch → PR（对着 fixture 仓库） |
| 2 | PR 是 draft | API 返回 `draft: true` |
| 3 | 正文含实数 | 文件数、+/−、测试结果、transcript 链接都在 |
| 4 | 重复 Run | 不产生第二个 PR，正文的 attempt 序号递增 |
| 5 | 权限不足 | 用缺 `pull_requests:write` 的 installation → 结构化错误 |
| 6 | **force-with-lease 保护** | 模拟远端分支被第三方改动 → 拒绝覆盖并报告 |
| 7 | token 过期 | 把缓存 TTL 调成 0 秒 → 自动重新签发，流程不中断 |
| 8 | rate limit | mock 一个 403 + `retry-after` → 等待后重试 |

### 验收标准

- [ ] 上表 8 项全绿
- [ ] §K 第 10 步：端到端 issue → patch → PR
- [ ] 手工看一次 PR：正文如实、draft、分支名正确

**完成标记：**
- [ ] **Phase 12 完成** — 端到端跑通并产出 PR（M0 完成）

---

## Phase 13 · （可选，非阻塞）最小 transcript UI

**目标**：打开一个页面，能看到一次 Run 的实时流。

**明确标记为可选**：sandbox.md 不覆盖它，README 的 M0 把它列为"本地 Web UI"。它不阻塞 M0 的沙箱目标，可以在 Phase 12 之后做。

### 交付物

`packages/web/*` + CP 上的 `GET /runs/{id}/stream`（SSE）。

### 具体如何实现

- CP 增加一个 SSE 端点，把三类事件统一到一个流里：模型文字增量、工具调用与工具结果、沙箱命令输出（复用 Phase 1 的事件流）。
- 前端：一个静态页面 + 原生 `EventSource`。**不用 Next.js、不用构建**——`node --test` 之外再引一套打包工具不划算。用浏览器原生的 ESM + 一个 `index.html`。
- 复用 Phase 11 已经写好的 `onText` 回调。

### 技术边界

- **不做**：鉴权、多用户、多 Run 列表、diff 高亮、成本看板、回放控制（这些是 M3 的 Web 控制台）。
- 只读，不做交互（不能在 UI 上打断 Run）。

### 测试要点

- 打开页面能看到一次 Run 的实时流（手工）
- SSE 端点断开后浏览器自动重连能接上（`EventSource` 自带 `Last-Event-ID`）

### 验收标准

- [ ] 一次 Run 的全过程能在浏览器里实时看到

**完成标记：**
- [ ] **Phase 13 完成**（可选）

---
---

# 附录

## A. 与 `docs/sandbox.md` 的有意偏差

改回来之前先读理由。

| # | 设计原文 | 本文做法 | 理由 |
|---|---|---|---|
| A-1 | 日志 `/var/log/nightshift/exec/{id}.log` | `/tmp/reuben-cloud/exec/{id}.log` | 只读根上 `/var/log` 根本不可写；用 tmpfs 挂上去则挂载点属主是 root，容器里 uid 1000 也写不进去。放 `/tmp`（1777）下自建目录，天然归 uid 1000，还顺带受 tmpfs 上限约束 |
| A-2 | `--tmpfs /home/agent:size=512m` | `HOME=/tmp/agent` | 同上：tmpfs 挂载点归 root。用 `mode=` 绕过要赌 runc 对参数的接受程度，不如直接放 `/tmp` |
| A-3 | base commit 由沙箱持有 | `/diff?base=<sha>` 由 CP 传入 | §A 的核心原则是沙箱不持有业务状态（随时可能死掉重建）。显式传参让沙箱真的无状态，还省掉第 10 个端点和一份持久化状态 |
| A-4 | §K 第 7 步把 `/diff`+`/archive` 和对象存储放在一起 | 沙箱侧提前到 Phase 3，CP 侧留在 Phase 10 | 沙箱侧只是"跑个 git、打个 tar"，裸机阶段调通最便宜；对象存储要等 CP 起来才有意义 |
| A-5 | — | `/diff` 与 `/archive` 占用 exec 的 BUSY 槽位 | 它们共享 workspace 的读写语义。边跑测试边打包会产生撕裂归档；CP 的流程本来就是顺序的，互斥不损失什么 |
| A-6 | — | 新增 `GET /archive?dryRun=1` | CP 要执行"卷 + 归档体积上限"的软限制，得在拉 2 GiB 之前知道体积 |
| A-7 | §G 三张表 | 增加 `sandbox_state_transitions` | §D 要求"每次转换写审计日志，这是崩溃恢复的唯一依据"——审计日志需要一个落点 |
| A-8 | `artifacts.kind` ∈ {diff, workspace_archive} | 增加 `exec_log` | §G.2 要求"重要输出在销毁前转存"，被截断的执行日志需要一个 kind |
| A-9 | — | 单次执行日志上限 256 MiB | tmpfs 页面计入 cgroup 内存。不设上限时，一个 `yes` 就能把容器自己 OOM 掉 |
| A-10 | — | 文件 API 支持只读第二根 `/tmp/reuben-cloud` | 工具结果外置到那里，模型要用 `read` 读回来；而外置文件不能写进 `/workspace`（会污染 diff 和归档） |
| A-11 | 出网日志"先只写日志文件" | stdout + Docker json-file 轮转 | 自己写轮转是新的 bug 来源；Docker 已经给了一份带时间戳的持久日志 |
| A-12 | 分支 `nightshift/<task>` | `reuben-cloud/<taskId>`，重跑用 `--force-with-lease` 覆盖 | 用户看到的分支应稳定对应一个 Task；保护机制见 Phase 12 |
| A-13 | — | PR 默认 draft | 明确表示"待人工确认"，也不会自动触发评审请求 |

## B. 风险登记

按"出问题时的排查成本"排序。每条都写了最早的暴露点——**在没有暴露点之前不要写防御代码**。

| 风险 | 为什么危险 | 最早暴露点 |
|---|---|---|
| **进程组回收** | `detached` + `process.kill(-pid)` 在 macOS 与 Linux 上行为有细微差异；漏杀会留下孤儿占满容器 | Phase 1 用例 5、6（裸机就能测） |
| **命名卷属主** | 忘了在 Dockerfile 里 `chown /workspace`，卷初始化成 root，容器里什么都写不进去 | Phase 4 验收 + Phase 5 用例 3 |
| **SSE 重连语义** | `Last-Event-ID`、心跳、跨 chunk 帧，三个都能独立出错；错了表现为"偶尔丢输出"，最难查的一类 | Phase 1 用例 11、12 |
| **Docker Desktop ≠ Linux** | seccomp/apparmor/只读根/内网在 macOS 上**压根没被验证**，本地全绿不代表什么 | Phase 7 的 Linux CI（这是它存在的唯一理由） |
| **patch 忠实度** | CRLF、filemode、二进制、空白，任何一样出问题都表现为"PR 里的代码和沙箱里验证过的不是同一份" | Phase 9 用例 1 的 sha256 校验 |
| **tmpfs 计入 cgroup 内存** | `/tmp` 的 512 MiB 和 2 GiB 内存上限是同一笔账；大日志会 OOM 掉正在跑编译的容器 | Phase 1 用例 8 + Phase 4 的日志上限 |
| **GC 并发闸的边界** | `/diff` 与 `/archive` 共用 BUSY 槽，如果 CP 忘了处理 409，会表现为"偶尔拿不到归档" | Phase 3 用例 10 |
| **对账误伤** | 对账逻辑写错会把正在跑的沙箱标成 ERROR | Phase 8 用例 6（BUSY + 有执行在跑这一条专门测它） |

## C. 命名对照（旧 → 新）

| 旧 | 新 |
|---|---|
| `Nightshift`（产品名） | `reuben-cloud` |
| `nightshift.sandboxId`（docker label） | `reuben-cloud.sandboxId` |
| `nightshift-ws-{id}`（卷） | `reuben-cloud-ws-{id}` |
| `nightshift-internal`（网络） | `reuben-cloud-internal` |
| `/var/log/nightshift/...` | `/tmp/reuben-cloud/...` |
| `nightshift/<task>`（分支） | `reuben-cloud/<task>` |
| `@nightshift`（webhook 触发词） | `@reuben-cloud` |
