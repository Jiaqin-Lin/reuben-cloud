# 沙箱技术方案（MVP）

> 版本 v3 · 2026-09-12
> 目标：把 `Task → 创建 Sandbox → 拉代码 → 执行命令 → 改代码 → 跑测试 → 取 diff → archive → 销毁` 这条闭环**真正做出来**。
> 一句话：**沙箱是"安全、隔离的代码执行环境"，不是 Agent。**
> 不作目标：设计一个通用沙箱平台。
>
> **本文回答"为什么这样设计"。** 具体怎么落地——Phase 拆分、每个 Phase 的实现步骤 / 技术边界 / 测试要点 / 验收标准——见 [`sandbox-spec.md`](sandbox-spec.md)。
> 两份冲突时**以本文为准**；但 spec 附录 A 列出的偏差是**有意的**（另有 13 条实施决策），改回去之前先读每条的理由。

---

## A. MVP 架构图

```
Control Plane (Node/TS)
├─ Task/Run Orchestrator ─► Agent Loop ─► Tool Layer ─► SandboxManager
├─ GitHub 凭据只在这里：clone 与 push 全部由 CP 执行
└─ Provider 接口（M0: LocalDockerProvider）

   SQL │                                        │ docker API
       ▼                                        ▼
 ┌──────────────┐                  ┌─────────────────────────┐
 │ Postgres     │                  │  Sandbox 容器（每 Run） │
 │  sandboxes   │                  │  sandbox-agent :8080    │
 │  executions  │                  │  /workspace (volume)    │
 │  artifacts   │                  │  read-only rootfs       │
 │ Object Store │                  │  沙箱内无任何凭据       │
 └──────────────┘                  └────────────┬────────────┘
                                                │ internal net
                                   ┌─────────────────────────┐
                                   │ egress-proxy (global×1) │
                                   │ static domain allowlist │
                                   │ no github.com           │
                                   └────────────┬────────────┘
                                                ▼ internet
                                   ▼ internet
                                                ▼ internet
```

**三个角色的物理位置本身就是边界**：决策在 CP、执行在容器、出网在代理。任何一方被攻破都不自动等于另两方失守。

### 为什么 Agent Loop 必须在 Control Plane

1. **模型密钥不进沙箱**。沙箱里执行的是任意代码（可能被提示注入操纵），把 LLM API Key 放进去等于把最贵的凭据交给最不可信的环境。
2. **循环逻辑是可迭代资产**。改 prompt、改工具、改重试策略不该触发镜像重建。
3. **可观测性**。README 的设计原则是"一切可回放"——模型看到的完整输入只有 CP 有。
4. **延迟代价为零**。一次工具调用耗时以秒计，同机/同集群的 HTTP 往返是毫秒级。

反过来说：如果 Agent Runtime 跑在沙箱里，沙箱一断网或一被攻破，模型调用、凭据、决策逻辑会同时失守。

> **M2 的位置不变，只是包的边界变了**：循环 / 会话 / 上下文 / 工具收进独立 workspace 包
> `packages/agent-runtime/`（纯决策层，不依赖 pg / octokit / S3），CP 是它的宿主。
> 见 [`agent-runtime.md`](agent-runtime.md) §B.6。

---

## B. 职责边界

### Control Plane（决策方）

| 负责 | 说明 |
|---|---|
| Task / Run 状态机 | 唯一权威状态源 |
| Agent 主循环 | 调模型、解析 tool call、维护上下文 |
| 决定执行什么命令 | 沙箱永远不决定 |
| 判断任务是否成功 | 验证子系统 |
| 重试 / 超时 / 成本归因 | |
| **GitHub 全部操作** | 持有私钥、签发 token、clone、push、建 PR |
| 编排流程 | 灌入仓库 → 装依赖 → 跑准备脚本 → 执行 → diff → archive |
| 归档落对象存储 | 沙箱只产出流，CP 决定存哪 |

### Sandbox（执行方）

| 负责 | 不负责 |
|---|---|
| 创建 / 销毁运行环境 | 决定执行什么命令 |
| 执行命令并流式返回输出 | 判断任务是否成功 |
| 文件读写 / 列目录 | Agent 推理、上下文管理 |
| 产出 diff / workspace 归档 | Task 调度、重试策略、成本计算 |
| 资源限制、网络与权限隔离 | 保存业务状态、持有任何凭据 |

**判据：任何"要看情况决定"的逻辑都不属于沙箱。** 沙箱只回答"给我一条 argv 数组，我执行完把事件流给你"。

**这条边界落到接口上的三个体现**：

1. `create` 的 spec 里**没有 `repo` 字段** → clone 是 CP 的事。沙箱不需要知道 GitHub 是什么。
2. `create` 的 spec 里**没有 `secrets` 字段** → 沙箱里不存在任何凭据，一次成功的提示注入拿不到能被盗用的东西。
3. `create` 的 spec 里**没有 `network` 字段** → 出网白名单是全局静态配置（§F.2），不是每个任务可调的参数。

---

## C. Sandbox API

9 个端点，分成两层。分层的理由：**变化频率不同**。换 provider（Docker→K8s→Firecracker）只动第一层，加执行能力只动第二层。

### C.1 Provider 层（CP 进程内接口；M0 由 LocalDockerProvider 实现）

```ts
interface SandboxProvider {
  create(spec: SandboxSpec): Promise<SandboxHandle>
  destroy(sandboxId: string): Promise<void>
  health(sandboxId: string): Promise<SandboxHealth>
}

interface SandboxHandle {
  sandboxId: string
  providerRef: string      // 容器 ID；K8s 时是 pod 名
  endpoint: string         // "http://172.18.0.4:8080" 或 "http://127.0.0.1:49153"
  authToken: string        // 每次 create 随机生成，调用执行层必须带
}

interface SandboxSpec {
  image: string                              // 必须带 digest，不接受纯 tag
  limits: { cpu: number; memMb: number; pids: number; diskMb: number; ttlSec: number }
  env: Record<string, string>                // 非敏感配置；禁止放 secret
  labels: { sandboxId: string; runId: string; taskId: string }
  workspace: { sizeMb: number }
}
```

**这只是 3 个方法的接口，不是 provider 插件框架。** 一个实现也是接口——它存在的意义是把"这个进程要碰 docker socket"圈在一个文件里，而不是为了可插拔。等真的有第二个实现（K8s）再谈注册、发现、配置化。

`endpoint` 由 provider 决定怎么可达，这是有意的：
- Linux 上 CP 和容器同主机，容器在内网里，直接走容器 IP，**不需要发布任何端口**
- macOS / Docker Desktop 上要 `-p 127.0.0.1::8080` 才能访问（VM 边界），此时是随机本地端口

这个差异属于 provider 的实现细节，不该泄漏到上层。

### C.2 执行层（容器内 sandbox-agent，HTTP + SSE）

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| 1 | GET | `/health` | 就绪探针，返回 `{status, version, activeExecution}` |
| 2 | POST | `/exec` | 提交命令 → `{execution_id}`，**立即返回，不阻塞** |
| 3 | GET | `/exec/{id}/events` | **SSE 事件流**（exec 的主要通信机制） |
| 4 | POST | `/exec/{id}/kill` | 主动终止（超时/取消） |
| 5 | GET | `/files?path=` | 读文件（带编码与大小上限） |
| 6 | PUT | `/files` | 写文件，**支持流式二进制**（CP 用它灌入仓库 tar） |
| 7 | GET | `/files/list?path=` | 列目录 |
| 8 | GET | `/diff` | 相对 base commit 的变更 |
| 9 | GET | `/archive` | 打包整个 workspace（流式 tar.gz） |

所有请求必须带 `Authorization: Bearer <authToken>`。为什么沙箱内部还要鉴权：同一个内网上的其他容器、以及宿主机上任何进程都能访问这个端口，没有 token 就等于把命令执行接口公开。

#### 为什么 diff 和 archive 不通过 exec 实现

它们**内部实现就是 exec `git diff` / `tar`**，但对外是独立端点，因为输出形态不同：
- `diff` 返回结构化数据（文件列表 + 状态 + patch），CP 要存库、要在 UI 上渲染成行级视图、要算影响面
- `archive` 是二进制大对象，走 `tar.gz` 流直传对象存储，不能进事件流的文本通道（base64 膨胀 33%，还会触发截断）
- 两者都需要 CP 直接落盘/落 S3，不需要经过模型上下文

**`git checkout` / `git status` / `git log` / `git branch` 一律走 `exec`**，不设专属 API。agent 本来就会用 git 命令，给它一层封装只会限制它的表达力。

#### `POST /exec` 请求体

```jsonc
{
  "cmd": ["npm", "test"],        // 必填。argv 数组，直接 execve，不做任何 shell 解析
  "cwd": "/workspace/repo",      // 必须在 /workspace 之下
  "env": { "CI": "1" },          // 追加到容器 env；单次有效，不持久
  "timeoutMs": 120000,           // 默认 120s，硬上限 600s
  "maxOutputBytes": 1048576      // 内联事件上限，超出部分只进日志文件
}
```

**`cmd` 是 argv 数组，没有隐式 shell。** 需要管道/通配符就自己写 `["bash","-lc","npm test | tee out.txt"]` —— 让"要 shell"成为 agent 的显式选择，而不是接口的默认行为。这一条直接消灭了命令拼接注入这一整类问题。

> **M2 的 `bash` 工具与这里不冲突**：模型的入参是 shell 字符串（跟它见过的所有 coding agent 一样），
> 由**工具层**包成 `["bash","-lc",command]` 再发下来。沙箱这一侧的契约一个字不变；
> "要 shell" 仍然是显式的（现在是工具显式选的），而能否用管道/重定向本来就不是安全边界（§F.5）。
> 见 [`agent-runtime.md`](agent-runtime.md) §F.2。

`env` 只用于非敏感配置（`CI=1`、`HOME` 之类）。**沙箱里没有任何凭据可传**（§F.3）。

#### `GET /exec/{id}/events` 事件

```
id: 1
event: started
data: {"execution_id":"exe_01H...","pid":4711,"ts":"2026-09-12T03:00:00.123Z"}

id: 2
event: stdout
data: {"chunk":"npm WARN deprecated ...\n"}

id: 3
event: stderr
data: {"chunk":"Error: connect ECONNREFUSED\n"}

id: 4
event: completed
data: {"exit_code":0,"duration_ms":12345,"stdout_bytes":102400,
       "stderr_bytes":0,"truncated":false,
       "log_path":"/var/log/reuben-cloud/exec/exe_01H.log"}
```

终态事件共 4 种，互斥：
- `completed` — 进程正常退出，带 `exit_code`（非 0 也算 completed，退出码不是沙箱该判断的事）
- `failed` — 沙箱无法启动该命令（如 cwd 不存在、可执行文件不存在）
- `timeout` — 超过 `timeoutMs`，进程树已被杀
- `killed` — 被 `/kill`、沙箱销毁或 TTL 到期终止

**为什么不把"退出码非 0"当 failed**：判断命令成功与否是 CP 的事。沙箱只报告"进程退出了，退出码是 1"。

#### 事件流的三个必要设计

1. **`id` 单调递增 + 支持 `Last-Event-ID` 重连重放**。SSE 断线是常态（网络抖动、CP 重启）。重放靠沙箱内存里的环形缓冲（1000 条或 1MB，先到为准）。超出缓冲的部分不重放，客户端拿到 `{truncated:true, log_path}` 后可以去读日志文件。
2. **输出合并**。一个 `npm install` 能产生上万行输出，逐行发事件会把 SSE 打死。沙箱侧合并成 ≤64KB 的块，或每 100ms 强制 flush，先到先发。
3. **大输出分层**。内联事件总量超过 `maxOutputBytes` 后，事件流只发一条 `{truncated:true, log_path, total_bytes}`，完整内容始终在 `/var/log/reuben-cloud/exec/{id}.log`，需要时用 `GET /files?path=` 按范围读。

日志文件在这里的角色是**持久化存储和事后取证**，不是通信通道。

#### 并发模型

**一个沙箱同时只能有一个 exec**（对应状态机里的 BUSY）。第二个请求返回 `409`。

为什么不做并发：agent 本身是串行的；多路并发会带来输出交错、cwd 竞争、状态歧义，而这些复杂度换不来任何产品价值——需要并发的场景（多个任务）本来就该用多个沙箱。

**例外：exec 正常结束时不禁子进程。** `["bash","-lc","nohup ./dev-server &"]` 这种模式必须能用（集成测试要起数据库、要起 dev server）。后台进程随沙箱销毁一起消失。只有 `timeout` / `killed` / `destroy` 才会杀进程树。

#### 仓库怎么进沙箱，产出怎么回 CP

**两条路都不经过沙箱的 GitHub 凭据**——因为沙箱里根本没有凭据（§F.3）。

**进去（CP clone → 灌入）**：

```
1. CP 用 GitHub App token clone 到本地临时目录，checkout 到目标 commit
2. CP 打包：tar czf repo.tar.gz（含 .git，沙箱内要是个正常的 git 仓库）
3. CP: PUT /files?path=/tmp/repo.tar.gz     ← 流式二进制上传
4. CP: POST /exec ["tar","xzf","/tmp/repo.tar.gz","-C","/workspace/repo"]
5. CP: rm 临时文件
```

**出来（CP 取 patch → 应用 → push）**：

```
1. CP: GET /diff   → patch（内部是 git add -A -N && git diff --binary <base>，
                           -N 让新增文件也进 diff，--binary 让二进制文件也能应用）
2. CP 在自己那份 clone 上 git apply --binary
3. CP 生成 commit（message 取自沙箱内最后一次 commit，或由 CP 生成）→ push 到 reuben-cloud/<task> 分支
4. 兜底：patch 应用失败时，改用 GET /archive 取完整工作区
```

**为什么这样切**：沙箱零凭据的代价是仓库要过一次网络（本地/内网，可接受）。换来的是"任何产出都必须经过 CP 才能变成 PR"——这本来就是产品想要的语义（默认只交 PR，不直接改用户分支）。

---

## D. 沙箱生命周期

```
                create()          health ok         POST /exec
  (无记录) ──────────────► CREATING ─────────► READY ◄─────────► BUSY
                                                   exec 终态事件

  CREATING ──创建失败 / 超时──────────► ERROR
  BUSY     ──看门狗触发 / 容器退出────► ERROR
  任意状态  ──destroy()──────────────► DESTROYED
```

5 个状态。**没有** PAUSED / SUSPENDED / SNAPSHOTTING。

只有两个状态转换会改变"谁在等"：`CREATING → READY`（CP 在轮询 health）和 `BUSY → READY`（CP 在等终态事件）。除此之外没有任何异步转换，这是收窄状态集换来的好处。

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `CREATING` | 容器已提交创建，等待 `/health` 通过 | create() 调用后 |
| `READY` | 空闲，可接受 exec | health 返回 ok |
| `BUSY` | 有 exec 在执行 | CP 标记 |
| `ERROR` | 创建失败或运行异常，需人工处理 | 创建超时 / 容器退出 / 看门狗触发 |
| `DESTROYED` | 容器已删除，资源已释放 | destroy() 完成 |

**状态机的唯一权威在 Control Plane 的 Postgres 里。** 沙箱自己不维护状态——它是易失的，容器重建后状态就没了。沙箱只暴露 `/health` 和 `activeExecution` 这两个事实，状态是 CP 根据事实 + 自己的记录推导出来的。

**状态转换必须写成独立函数**（`transition(sandboxId, from, to, reason)`），不允许在业务代码里直接 UPDATE 状态字段。每次转换写审计日志。这是崩溃恢复的唯一依据。

**超时分层**（分开的理由：等待就绪和等待资源是两件事，容量不足应该立刻返回明确错误，而不是让用户干等）：

| 等待 | 超时 | 超时后 |
|---|---|---|
| 创建（镜像已缓存） | 15s | ERROR + 结构化原因 |
| 创建（需拉镜像） | 120s | ERROR + 结构化原因 |
| health 就绪轮询间隔 | 250ms | |
| 单条命令默认 | 120s | timeout 事件 |
| 单条命令硬上限 | 600s | timeout 事件 |
| 沙箱 TTL（安全兜底） | 6h | 强制 archive + destroy |

TTL 是**安全兜底**，不是资源调度策略：一个跑飞的 agent 不能无限占着容器。到点无论什么状态都销毁，in-flight 的 exec 收到 `killed`。

### CP 重启后的对账

CP 启动时：
1. 把 Postgres 里处于 `CREATING/READY/BUSY` 的记录与实际容器对标（按 label `reuben-cloud.sandboxId` 查 docker）
2. 容器不在 → `ERROR`（原因 `container_lost`）
3. 容器在但 DB 没记录 → 孤儿容器，直接删（防止资源泄漏）

标签是这一步的唯一依据，所以 create 时必须打全。

---

## E. exec 完整调用链

```
[1] Agent 产出 tool call: bash { cmd: ["npm","test"] }
      │
[2] CP · Tool Layer
      ├─ 参数校验：cmd 是 argv 数组、cwd 在 /workspace 内、timeout ≤ 600s
      ├─ 输出预算：这条命令的结果最多进多少 token
      └─ 不做命令黑名单（为什么，见 §F.5）
      │
[3] CP · SandboxManager
      ├─ 读 DB：state 必须 ∈ {READY, BUSY}，否则拒绝
      ├─ state → BUSY，更新 last_active_at
      └─ POST {endpoint}/exec   (Bearer authToken)
      │
[4] Sandbox · sandbox-agent
      ├─ 分配 execution_id，落一条 pending 记录
      ├─ 校验 cwd、规范化路径、确认在 /workspace 内
      ├─ fork → setsid（自成进程组，便于整组 kill）
      ├─ 打开 /var/log/reuben-cloud/exec/{id}.log
      ├─ 立即返回 202 {execution_id}          ← 不阻塞
      └─ 后台：边读 stdout/stderr，边三处写：
             ① 环形缓冲（供 SSE 与重连重放）
             ② 日志文件（完整、持久）
             ③ 字节计数（到上限后停止推送明文）
      │
[5] CP: GET {endpoint}/exec/{id}/events   (SSE, Last-Event-ID 断线重连)
      ├─ started   → 记录开始时间
      ├─ stdout    → 转发 UI + 按需进模型上下文（超阈值外置为文件引用）
      ├─ stderr    → 同上
      └─ completed/timeout/killed → 终态
      │
[6] CP · 收尾
      ├─ 落 executions 表：退出码、耗时、stdout/stderr 字节数、是否截断
      ├─ state → READY
      └─ 返回工具结果给 agent（含截断标记 + log_path）
```

### 两条计时，缺一不可

- **沙箱侧计时**是权威：超时由沙箱自己执行 `SIGTERM → 等 5s → SIGKILL 整个进程组`。CP 断线也必须保证命令被杀。
- **CP 侧看门狗**是兜底：某条 exec 超过 `timeoutMs + 30s` 仍无终态事件 → 判定沙箱异常，调 `/kill`，失败则把沙箱标记 `ERROR`。

只有一层是不够的：SSE 断线、CP 重启、沙箱 agent 假死都会让单点计时失真。

### SSE 的边界（别混淆）

系统里有**两条独立的 SSE**，不要混为一谈：

```
Sandbox ──SSE──► CP ──SSE──► Web UI
 (事件源)      (消费+聚合)   (展示)
```

沙箱那条是**命令输出流**；CP 那条是**面向 UI 的会话流**（含模型 token、工具调用、命令输出、状态变更）。CP 是唯一的聚合点。

---

## F. 安全模型

### F.0 先把话说清楚：Docker 不是"绝对安全的沙箱"

Docker 容器**共享宿主机内核**。它是一道**隔离边界**，不是**安全边界**：

- 内核提权漏洞（LPE）可以直接逃逸
- 容器运行时自身的漏洞可以逃逸
- 一个配错的 `--privileged` / bind mount / socket 挂载就等于没有隔离

所以本方案的定位必须写明白：

| 阶段 | 隔离方案 | 适用前提 |
|---|---|---|
| **MVP（本文档）** | Docker hardening | 单租户 / 内部使用 / 受信任用户。此时的加固目标是**降低爆炸半径**，不是"防住有动机的攻击者" |
| **生产（§I）** | gVisor / Kata / Firecracker | 面向不可信用户。**在接第一个外部用户之前必须完成升级** |

这句话不是免责声明，是排期约束：MVP 可以上，但不能带着 MVP 的隔离去接不信任的代码。

### F.1 容器加固参数（逐条）

| 项 | 参数 | 为什么 |
|---|---|---|
| 非 root | `--user 1000:1000` | 容器内 root 配合任意一个内核漏洞就是 root on host；而且镜像里默认以 root 跑写出的文件在卷上是 root 属主，CP 后续处置会很别扭 |
| 丢弃全部能力 | `--cap-drop=ALL` | Docker 默认仍保留约 14 个 capability（含 `CAP_NET_RAW`、`CAP_CHOWN`）。命令执行环境一个都不需要 |
| 禁止提权 | `--security-opt no-new-privileges=true` | 阻断 setuid 二进制提权路径，即使镜像里有 setuid 程序 |
| 系统调用过滤 | `--security-opt seccomp=<docker 默认 profile>` | 默认 profile 已阻断 `mount`/`ptrace`/`kexec_load`/`reboot` 等约 44 个高危调用。**必须确认没有被 `seccomp=unconfined` 关掉** |
| 强制访问控制 | `--security-opt apparmor=docker-default` | Linux 上默认启用，显式写出防止被意外关掉 |
| 非特权 | 永不出现 `--privileged` | 它等于关掉上面所有隔离 |
| 只读根文件系统 | `--read-only` | 镜像内容不可篡改，木马无法持久化到镜像层 |
| 可写位置显式化 | `--tmpfs /tmp:rw,nosuid,size=256m`<br>`--tmpfs /home/agent:rw,nosuid,size=512m`<br>`-v reuben-cloud-ws-{id}:/workspace` | 只读根之外必须显式列出每个可写点。漏了会在运行时报错——这是特性不是缺陷 |
| 内存 | `--memory=2g --memory-swap=2g` | 两者不等时 swap 可用，内存限制形同虚设（可以一直 swap 到宿主机崩） |
| CPU | `--cpus=1` | |
| 进程数 | `--pids-limit=2048` | 挡 fork bomb |
| init 进程 | `--init` | 不加的话 agent 起的后台进程会变僵尸，最终把 `--pids-limit` 耗尽，表现为"命令莫名不再能执行" |
| 无宿主 socket | 绝不挂 `/var/run/docker.sock` | 挂上它 = 宿主机 root。需要嵌套容器时用 §H 的方案，不用特权模式 |
| 无宿主目录 | 只用 named volume，不做 bind mount | bind mount 让容器能修改宿主机文件系统，直接破坏隔离前提 |
| 无宿主命名空间 | 绝不使用 `--pid=host` / `--network=host` / `--ipc=host` / `--userns=host` | |
| 磁盘 | `--storage-opt size=` （需要 xfs pquota） | **诚实说明**：ext4 + overlay2 下 Docker 不支持容器磁盘硬配额。MVP 用「卷 + 归档体积上限 + 输出字节上限」做软限制，Linux 生产环境切 xfs 启用硬配额。开发机（macOS）不保证 |

**关于 `/tmp` 不加 `noexec`**：攻击者本来就能在 `/workspace` 里执行任意代码，`noexec /tmp` 不增加任何实际安全性，却会让 `npm` 的 postinstall / `node-gyp` 失败。这是典型的"看起来更安全但降低可用性且无收益"的配置。

**关于自定义 seccomp profile**：MVP 用 Docker 默认 profile，不自维护。理由：自定义 profile 需要持续跟进各语言运行时新增的 syscall，写错的表现是"某个工具莫名失败"，维护成本和故障排查成本都高于它带来的边际收益。这一层的收益在升级到 gVisor 时由用户态内核接管。

### F.2 网络

```
sandbox 容器 ──┐
              ├── docker network: reuben-cloud-internal (--internal，无出口路由)
egress-proxy ─┘        │
                       └── 同时接在宿主机的外网 bridge 上
```

- **沙箱接在一个 internal bridge 上**：没有到公网的出口路由，Docker 的 DNS 也不转发外部域名。这是"默认拒绝"的实现方式——靠网络拓扑，不靠规则配置
- **唯一出口是 egress-proxy**：全局常驻一个容器，同时接入内网和外网
- **代理是 CONNECT 隧道式的**：只看域名（SNI/Host），不解密流量
- **白名单是全局静态的**：写在代理的配置文件里，只开"公共依赖源"——npm registry、pypi / files.pythonhosted、proxy.golang.org、crates.io、maven、apt 源等
- **白名单里没有 `github.com`**：clone / push 全部在 CP 侧完成（§C.2），沙箱不需要出网到 GitHub
- **代理记录所有出网请求**（域名、时间、字节数、来源 IP），先只写日志文件，不入库
- **端口不发布到宿主机**：CP 走内网 IP 访问 sandbox-agent。macOS 开发环境因 VM 边界需要 `-p 127.0.0.1::8080`（随机本地端口），**绝不 `-p 0.0.0.0:...`**

**为什么用域名代理，而不是 IP 白名单或防火墙规则**：包管理器源全部走 CDN，IP 段会漂移。IP 白名单要么很快失效（表现为"昨天还能装包今天不行了"），要么被迫开得很大（等于没有白名单）。域名级的控制在 HTTP 层做最简单也最准。

**为什么不做 per-sandbox / per-environment 白名单**：MVP 是单租户、单环境，白名单就是个全局常量。按环境区分的白名单等真的有第二个环境再说——现在做只是把一份配置拆成多份。

**代理不做的事**（这个"不做"是刻意的边界，不是偷懒）：
- 不解密流量 → 不能做内容检查
- 不认识密钥 → 不能注入凭据
- 只回答一个问题："这个域名在不在白名单里"

正因为简单，它能在 MVP 里做对。需要内容检查和密钥注入时，把它替换成 §I 的 credential service，沙箱侧无感。

**已知边界**（写出来避免误解）：
1. 内网里的容器可以访问**宿主机上监听 `0.0.0.0` 的服务** → 宿主机上不应暴露代理类服务，否则等于绕过白名单。这是单机开发环境的已知边界
2. 同一内网内的沙箱**互相可达**（agent 端口有随机 bearer token，驱动不了对方，但可以扫端口 / DoS）→ MVP 单租户前提下可接受；**接多租户前必须改成每沙箱独立网络**

### F.3 凭据：沙箱内不存在任何凭据

这是 MVP 在安全上最重要的一个决定。

| 凭据 | 位置 |
|---|---|
| GitHub App 私钥 | **只在 CP**（进程内存 / 密钥管理），永不离开 |
| installation token | CP 签发（TTL 1 小时，`contents:write` + `pull_requests:write`，**scope 限定到选定仓库**），只在 CP 内存中使用 |
| clone / push / 建 PR | **由 CP 执行**（§C.2） |
| 模型 API Key | 只在 CP（Agent Loop 在 CP） |
| 搜索 / MCP 等工具凭据 | 只在 CP（这些工具也在 CP 侧执行） |
| **沙箱内** | **无** |

沙箱里的进程能拿到的只有两条：`exec` 的 env 里 CP 主动放进去的非敏感配置，以及代理那个只有依赖源的白名单出口。

**为什么值得这么做**：沙箱是爆炸半径最大的地方（执行任意代码 + 内容全部不可信 + 可能被提示注入）。把它做成零凭据之后，一次成功的注入能拿到的上限是"改坏这个仓库的工作区"，而不是"拿到一个能写仓库的 token"。**没有东西可偷，就不需要防偷。**

**代价**：仓库要过一次网络（CP → 沙箱，本地/内网），push 由 CP 执行。这个代价换来的是"任何产出必须经过 CP 才能变成 PR"——本来就是产品想要的语义。

**残余风险**：没有凭据可盗，但要防的是"agent 拿到白名单域名后，把仓库内容外发到那些域名"（比如通过某个包的 registry）。见 §F.6 第 3 条。

### F.4 文件与命令边界

| 项 | 规则 |
|---|---|
| 路径 | 所有 `path` 参数：`path.resolve` → 必须落在 `/workspace` 之下 → `realpath` 再校验一次（防 symlink 逃逸） |
| 命令 | argv 数组直接 `execve`，不做字符串拼接、不做隐式 shell |
| 输出 | 单次 exec 内联上限默认 1MB，超出标记 `truncated` 并只保留在日志文件 |
| 超时 | 默认 120s，硬上限 600s |
| 进程树 | 超时/被 kill 时对**整个进程组**发 `SIGTERM`，5s 后 `SIGKILL` |
| TTL | 沙箱硬上限 6h，到点强制销毁 |

### F.5 命令黑名单不是安全机制

一个很容易滑进去的做法是：在 CP 侧拦 `rm -rf /`、`curl` 外网、改 CI 配置这类命令，把它当作"提示注入防御"。**不要这么做**：

1. **任意代码执行下命令空间是无限的。** `rm -rf` 有几十种写法，还有 `python -c`、`node -e`、base64 解码后执行、shell 变量拼接、Makefile 里的命令。黑名单只能覆盖想得到的形式。
2. **它产生的是安全幻觉。** 看起来有防护，实际给的是随机覆盖率。最危险的地方不是漏掉了某条命令，而是它会让人放松对真正边界的投入。
3. **真正决定爆炸半径的是四件事：沙箱隔离（F.1）、网络白名单（F.2）、路径校验（F.4）、凭据最小化（F.3）。** 这四件都是"默认拒绝"的结构性约束，不依赖"想全了"。

CP 侧当然可以有**产品策略**性质的限制——例如只允许 push 到 `reuben-cloud/*` 分支、危险操作走人工审批、改动 `.env` 与 CI 配置时提示用户。但要说清它们的性质：**这是产品语义**（让产出可 review、让用户知情），**不是安全边界**。把它们写成"提示注入防御"会误导后续所有判断。

### F.6 这个方案不防什么

写出来是为了避免"加固了 = 安全了"的错觉：

1. **容器逃逸** — 内核 0-day / 运行时漏洞。这是 §I 升级的动机。
2. **侧信道** — Spectre 类攻击需要物理隔离级别的方案（Firecracker 也不能完全防）。MVP 场景（单租户）不构成实际威胁。
3. **白名单域名上的数据外泄** — 白名单里的域名（npm registry 等）是被信任的，被注入的 agent 理论上可以借它外发数据。**白名单的宽度就是信任边界的宽度**，所以它必须窄；这是需要持续 review 的配置，不是一次性设置。
4. **提示注入导致的"合法但恶意"行为** — 在授权范围内提交恶意代码。沙箱隔离对此无能为力，靠的是 CP 侧的产出审查（默认只交 PR、不直接改用户分支）和 branch protection。
5. **沙箱之间的相互干扰** — 见 §F.2 已知边界第 2 条。

---

## G. 数据模型

**沙箱不持有业务状态。** 所有状态在 CP 的 Postgres 里。

### G.1 `sandboxes`

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | text PK | `sbx_<ulid>` |
| `task_id` / `run_id` | text | 归属 |
| `provider` | text | `docker`（M0 唯一值） |
| `provider_ref` | text | 容器 ID（K8s 时是 pod 名） |
| `endpoint` | text | 执行层访问地址 |
| `auth_token` | text | 每次 create 随机生成 |
| `image` / `image_digest` | text | **digest 是权威**，tag 只作展示 |
| `state` | text | `CREATING/READY/BUSY/ERROR/DESTROYED` |
| `state_reason` | text | 最近一次转换原因；ERROR 时是结构化错误码 |
| `limits` | jsonb | `{cpu, memMb, pids, diskMb, ttlSec}` |
| `workspace_volume` | text | named volume 名 |
| `last_active_at` | timestamptz | 每次 exec 开始时更新 |
| `created_at` / `ready_at` / `destroyed_at` | timestamptz | |

索引：`(state, last_active_at)` 用于超时扫描；`(run_id)`；`(provider_ref)` 用于对账。

### G.2 `executions`

| 字段 | 说明 |
|---|---|
| `id` | `exe_<ulid>`，沙箱侧生成 |
| `sandbox_id` / `run_id` | |
| `cmd` | jsonb（argv 数组，原样存） |
| `cwd` | text |
| `env_keys` | jsonb —— **只存 key 名，永不存 value** |
| `state` | `running/completed/failed/timeout/killed` |
| `exit_code` | int，仅 completed 有值 |
| `stdout_bytes` / `stderr_bytes` | bigint |
| `truncated` | bool |
| `log_path` | 沙箱内路径；沙箱销毁后失效，重要输出在销毁前转存对象存储 |
| `started_at` / `ended_at` | timestamptz |

### G.3 `artifacts`

| 字段 | 说明 |
|---|---|
| `id` | `art_<ulid>` |
| `run_id` / `sandbox_id` | |
| `kind` | `diff` / `workspace_archive` |
| `object_key` | S3/MinIO 路径 |
| `size_bytes` / `sha256` | 完整性 |
| `created_at` | |

**为什么 archive 必须存对象存储而不是留在沙箱**：沙箱是易失的，销毁后容器和卷都没了。归档是任务的产出凭证，生命周期必须长于沙箱。

---

## H. MVP 不实现的功能

每项都写清"什么时候需要它"，避免它被无声地提前拉进来。

| 功能 | 为什么现在不做 | 什么时候需要 |
|---|---|---|
| 预热池 | 引入休眠态、配置注入、复用计数、消毒四套机制，而冷启动慢还不是瓶颈 | 冷启动 p95 > 10s 且成为产品体验瓶颈时 |
| 暂停 / 恢复 | 没有"等 LLM 时释放资源"的需求（agent 循环在 CP，等待时沙箱本来就空闲但不烧 CPU） | 单任务跨越长时间等待（如等人审批）且沙箱成本成为主要成本时 |
| 快照 / 跨节点迁移 | 同上。且需要 CRIU 或 microVM 支持，Docker 原生做不到 | 需要毫秒级恢复，或需要把任务从故障节点搬走时 |
| overlayfs 分层 | 单卷能跑。分层的收益是"多任务共享同一 commit 的 checkout 层" | 出现大量同 commit 的并发任务时 |
| 嵌套容器（docker-in-docker） | 需要 sysbox 或特权模式，后者直接摧毁隔离 | 集成测试确实需要起容器时。优先选 sysbox 类无特权方案 |
| provider 插件框架 | 一个实现不需要注册表和配置化 | 出现第二个 provider 时（预计 K8s） |
| 代理的内容检查 / 密钥注入 | MVP 没有第三方密钥；MITM 需要往沙箱装 CA | 用户开始往任务里配第三方 API key 时（§I） |
| 按环境 / 按任务的出网白名单 | 单租户单环境，白名单是全局常量 | 出现第二个环境，或用户需要声明额外域名时 |
| 动态预热池容量 | 依赖预热池 | 随预热池一起 |
| 自定义 seccomp profile | 维护成本 > 边际收益；这层收益由 gVisor 接管 | 升级到 gVisor 时（该层被替换，不是被增强） |
| 多租户配额 / 计费 | 单租户 | 接第二个用户时 |
| 每沙箱独立网络 | 共享内网在单租户下可接受（§F.2 已知边界） | **接多租户前必须做** |
| 沙箱指标采集（CPU/内存曲线） | 先能跑通闭环 | 做成本归因时 |

---

## I. 演进路线

原则：**API 契约不变，只换 provider 实现**。这正是把接口收到 9 个端点的意义——每一层升级都不需要动 Control Plane 和 Agent 循环。

### Step 1 · Docker → Docker + gVisor（隔离强度）

| | |
|---|---|
| **触发条件** | 开始接外部用户的代码。**这是硬门槛，不是优化项** |
| **改动** | ① `LocalDockerProvider` 加 `--runtime=runsc`；② 镜像要求变严（无特殊 syscall、无 `/proc` 魔改）；③ 性能基线重测（gVisor 的文件 IO 和 syscall 密集场景有明显开销） |
| **不改动** | 执行层 API、CP、Agent 循环、数据模型 |
| **工作量** | 小。这是性价比最高的一步 |

### Step 2 · 单机 → K8s（容量与调度）

| | |
|---|---|
| **触发条件** | 需要多节点、需要容量调度、需要把"CP 持有 docker socket"这个信任假设去掉 |
| **改动** | ① 新增 `RemoteProvider`，实现同一套 `SandboxProvider` 接口（3 个方法），走 HTTP/gRPC 调 sandbox-manager；② sandbox-manager 成为独立服务，独占节点上的运行时权限；③ CP 的 `endpoint` 从容器 IP 变成 Service DNS；④ 网络策略从 docker internal network 换成 NetworkPolicy |
| **不改动** | 执行层 API、沙箱镜像、Agent 循环 |
| **顺带收益** | CP 不再需要接触容器运行时，CP 被攻破 ≠ 宿主机失守。**这一步同时解决 §H 里的"每沙箱独立网络"** |

### Step 3 · 冷启动与成本（预热池 + 快照）

| | |
|---|---|
| **触发条件** | 冷启动时间成为产品瓶颈（>10s），或空闲沙箱的内存成本成为主要成本项 |
| **改动** | ① 引入预热池：按 `image_digest` 分桶 + 原子取出 + 分配时注入配置；② 沙箱状态机加 `POOL_IDLE`（预热池专用，与业务状态隔离，避免污染 READY/BUSY 语义）；③ 快照依赖 Firecracker/Kata 的 microVM snapshot，Docker 下无法做到毫秒级 |
| **不改动** | 执行层 API、CP 的 Task/Run 状态机 |
| **注意** | 预热池的第一个版本必须是**静态容量**。动态容量（按使用频率预测）需要历史数据支撑，没有数据的自适应是随机游走 |

### 正交演进线 · 代理 → 凭据服务

与隔离强度无关，独立推进：

```
MVP:     静态白名单 CONNECT 代理（只看域名，不解密）
            ↓
M2:      按环境 / 按任务的白名单（多环境时才需要）
            ↓
M2+:     credential service
         - 沙箱内只有占位符（格式一眼可识别，含随机串）
         - 真实值由代理按「域名 ↔ 密钥」映射在网络层注入
         - 阻断占位符原样出网（防止 agent 把它当数据传出去）
         - 记录「哪个密钥在什么时间被哪个域名使用」
         - 需要 MITM：往沙箱装自定义 CA
```

**触发条件**：用户开始往任务里配置第三方密钥（云厂商、SaaS API）。在此之前，做它是零收益的复杂度。

**注意**：这条线的每一步都只动代理，沙箱侧和 CP 侧的接口不变。

### 关于跳过 Docker 直接上 Firecracker 的诱惑

不要。理由：Docker 阶段验证的是**协议和边界**（exec 事件流、状态机、路径校验、归档），这些和隔离方案完全正交。在协议还没稳定时先引入 microVM，会把"协议问题"和"运行时问题"混在一起排查——而后者在本地开发环境根本复现不了。

---

## J. 验收标准

### 功能闭环（MVP 的唯一硬指标）

对照 README 里的产品闭环，端到端必须能跑通：

1. 给定 GitHub 仓库地址 + commit，**CP clone 并灌入沙箱**，沙箱内 checkout 到指定 commit
2. 执行 `npm test`（或对应语言）返回正确的退出码、stdout、stderr
3. 长命令（>60s）立即返回 `execution_id`，执行中能拿到中间输出
4. agent 写入文件后读出的内容（含二进制）完全一致
5. 跑完测试后 `GET /diff` 返回 patch，CP 能 `git apply --binary` 成功
6. `GET /archive` 包含被 `.gitignore` 排除的构建产物
7. 归档落对象存储，沙箱销毁，DB 三张表状态正确

### 隔离（红线，全过才算）

- [ ] 沙箱内 `id -u` ≠ 0，且无法提权
- [ ] 根文件系统不可写（`touch /x` 失败），`/workspace`、`/tmp`、`$HOME` 可写
- [ ] **非白名单域名不可达**（含 `github.com`）——`curl https://github.com` 必须失败
- [ ] 白名单域名可访问（`npm install` / `pip install` 成功）
- [ ] 宿主机无 docker socket 暴露（`ls /var/run/docker.sock` 不存在）
- [ ] 申请超过上限的内存被 OOM kill，宿主机不受影响
- [ ] fork bomb 被 `--pids-limit` 挡住，沙箱 agent 仍存活并响应
- [ ] 越界路径（`../../etc/passwd`、symlink 逃逸）被拒绝
- [ ] **沙箱内不存在任何 GitHub 凭据**（全盘搜索 + `env` + `.git/config` 均无 token）

> **验收必须在 Linux 上跑。** macOS 的 Docker Desktop 使用不同的内核和 seccomp 行为，本机通过不代表生产通过。

### 性能（只列三个真正的目标，不编造数字）

| 指标 | 目标 |
|---|---|
| 创建（镜像已缓存）p95 | < 5s |
| 简单命令 exec 往返 p95 | < 200ms |
| 沙箱逃逸 | 0 |

预热池相关的指标（"命中时 < 3s"）随预热池一起定义，现在写是空头承诺。

### 冒烟测试脚本

每次改动沙箱相关代码都要跑，按顺序：

```
1.  create() → 等 READY
2.  校验 id -u ≠ 0、/ 不可写、github.com 不可达、npm registry 可达
3.  CP 灌入仓库 tar → 沙箱内 tar xzf → git status 干净
4.  exec git checkout <commit>
5.  write 一个文件 → read 校验内容一致（含二进制）
6.  exec 一条超时命令 → 校验收到 timeout 事件 且 进程确实死了（含子进程）
7.  exec 一条大输出命令 → 校验截断标记 + 日志文件完整
8.  越界路径读写 → 校验被拒
9.  GET /diff → CP 侧 git apply --binary 成功
10. GET /archive → 校验包含被忽略的文件
11. destroy() → 校验容器已删、卷已删、DB 状态为 DESTROYED
```

---

## K. 开发顺序

按依赖顺序排，每一步都能独立验证。**前 4 步不碰 Agent 循环**——先把执行环境做扎实。

| # | 任务 | 验证方式 |
|---|---|---|
| 1 | `sandbox-agent` 服务：`/health` + `/exec`(SSE) + `/files`（含流式二进制）。**先在宿主机裸跑，不碰 Docker** | 下方"第 1 步验证清单" |
| 2 | 沙箱镜像：多语言运行时 + git + 非 root 用户 + `sandbox-agent` 随容器启动 | 镜像能起，`/health` 通过 |
| 3 | `LocalDockerProvider`：加固参数 + internal 网络 + named volume + 标签 | §J 隔离红线全绿 |
| 4 | egress-proxy：全局常驻，静态白名单，出网日志 | 白名单域名能装包；`github.com` 不可达 |
| 5 | CP 侧仓库进出：clone → tar → `PUT /files`；diff → apply → push | 仓库进得去，patch 出得来并能应用 |
| 6 | CP：`SandboxManager` + Postgres 三张表 + 状态转换函数 + 启动对账 | 手动 create/destroy 若干次，DB 状态正确；kill 掉容器后重启 CP 能发现 |
| 7 | `GET /diff` + `GET /archive` + 落对象存储 | patch 可 apply；归档含忽略文件 |
| 8 | §J 冒烟脚本进 CI（**从第 3 步起覆盖隔离红线**） | 全绿 |
| 9 | **此时才开始** Agent 循环 + 4 个工具（bash / read / write / list） | 给一个真实 issue，产出一个 patch |
| 10 | GitHub App：token 签发 + PR 创建 | 端到端：issue → patch → PR |

### 第 1 步验证清单

裸跑（不碰 Docker）能验证的：

- exec 返回正确的退出码 / stdout / stderr
- 长命令立即返回 `execution_id`，执行中能拿到中间输出
- 超时后**进程组**被真正杀掉（含子孙进程），不是只杀直接子进程
- 大输出被截断且标记，日志文件完整
- 二进制文件写入后读出完全一致
- 越界路径（`../`、symlink）被拒绝
- SSE 断线后用 `Last-Event-ID` 重连不丢内容
- 一个沙箱同时只有一个 exec（第二个返回 409）

第 1 步**不验证**的（必须有容器才能测，属于第 3、4 步）：

- 非 root / 只读 rootfs / capability / seccomp / AppArmor
- 内存、CPU、pids、磁盘限制
- 无宿主 socket、无宿主目录、无宿主命名空间
- 公网不可达 / 白名单域名可达

**第 1 步和第 3 步之间不要合并**：sandbox-agent 的逻辑（事件流、路径校验、进程组管理、输出合并）是这个方案里唯一真正有技术风险的部分，把它放在 Docker 之外先跑通，能让后面所有的调试都不必先排除"是不是容器配置问题"。
