# AGENTS.md

> 给在这个仓库里干活的编码 agent（以及新来的同事）的路标。**它与 `README.md` / `docs/` 不重复**：
> 那几份讲"这个系统是什么、为什么这样设计"，这份讲"动手之前要知道什么、改完怎么算完"。
> 人类优先读 README；agent 优先读这份。

## 0. 这是什么、现在做到哪了

reuben-cloud 是一个**异步云端编码 agent**：给它一个仓库和一个任务，它在隔离沙箱里读代码、
改代码、跑测试，最后交出可 review 的 PR。当前进度：

- **M0（沙箱子系统）已完成**：设计 [`docs/sandbox.md`](docs/sandbox.md)、实施规格
  [`docs/sandbox-spec.md`](docs/sandbox-spec.md)（13 个 Phase 全部完成，含完成标记与实现备注）。
- **M2（环境与上下文）在做**：设计 [`docs/agent-runtime.md`](docs/agent-runtime.md)、实施规格
  [`docs/agent-runtime-spec.md`](docs/agent-runtime-spec.md)（13 个 Phase；**每完成一个 Phase 就把
  README 的勾选与规格里的"实现备注 / 附录 A"补齐**）。进度看 README 的 M2 列表。

**每次动手前先读实施规格里那个 Phase 的全文**（交付物 / 具体如何实现 / 技术边界 / 测试要点 /
验收标准），以及**附录 A**——它记录了"文档这么写、实际那样做"的全部有意偏差，改回去之前先读理由。

## 1. 仓库布局

```
packages/agent-runtime/   纯决策层：循环 / 工具 / 提示词 / 会话存储接口 / 压缩（无 pg / octokit / s3）
packages/control-plane/   CP：沙箱编排 / 会话存储的 Postgres 实现 / 仓库进出 / 观察窗 / 环境与索引
packages/sandbox-agent/   沙箱内的执行服务（文件 API / exec / diff / archive），镜像里直接 node xxx.ts
packages/web/             观察窗前端（零构建的原生 ESM：public/app.js + index.html + style.css）
packages/e2e/             冒烟与隔离红线（npm run smoke，CI 里跑）
deploy/                   egress-proxy（白名单出网）与部署相关
images/sandbox/Dockerfile    沙箱镜像（P5 会把 Layer 1 基础镜像矩阵加在 `images/base/`）
scripts/                  CLI 入口：agent-run / migrate / sandbox-image-check / egress-proxy / github-app
docs/                     设计文档 + 实施规格（见上）
vendor/                   tree-sitter 的 .wasm（P8 才建：固定版本 + sha256）
```

**依赖方向只有一条：`control-plane → agent-runtime`，不许反向。** `agent-runtime` 是纯决策层，
它的单测不需要 docker / PG / 网络；这条边界**有测试兜着**（`agent-runtime/test/dependency.test.ts`
读 import 图），别用 `import type` 之类的技巧绕过。

## 2. 常用命令

```bash
npm run typecheck            # 根目录聚合所有 workspace：**改完必跑**
npm test                     # 全部单测（node --test；不需要 docker / PG / 网络）
npm run test:integration     # 集成测试（需要 docker + PG + MinIO；每个文件起自己的一次性容器）
npm run smoke                # M0 的隔离红线（Linux docker）
npm run dev:up / dev:down    # compose 起本地 PG + MinIO（含 minio-init）
npm run db:migrate           # 跑迁移（scripts/migrate.ts）
npm run agent:run -- ...     # 手工跑一次真实 Run（--local/--repo、--serve、--keep、--compact）
npm run test:live            # 真模型 / 真 GitHub 的验收（手工跑，不进 CI；需要 key）
```

单跑一个包或一个文件：

```bash
npm test -w @reuben-cloud/agent-runtime
node --test packages/control-plane/test/unit/web-server.test.ts
```

环境变量都在 `.env`（模板见 README；`.env` 与 `*.pem` 已在 `.gitignore` 里，**绝不提交**）。
所有变量都有合理缺省，只有真跑集成 / live 时才需要配。

## 3. 硬性约束（破了就是 bug，不是风格问题）

1. **`agent-runtime` 不许 import `pg` / `octokit` / `@aws-sdk/*`**。存储用接口注入（`SessionStore`），
   容器与宿主实现放在 CP。SQL 只允许出现在 `packages/control-plane/src/session/postgres.ts`。
2. **Node >= 24 + `erasableSyntaxOnly`**：能在容器/宿主直接 `node xxx.ts` 跑的代码不得用 enum /
   namespace / 参数属性 / 装饰器（沙箱镜像里没有构建步骤）。`import type` 与 `.ts` 扩展名是这个仓库
   的写法（`allowImportingTsExtensions` + `verbatimModuleSyntax`）。
3. **不引新依赖**，除非先按 spec §0.2 的表格写清"用在哪 / 为什么 / 替代方案（不选的理由）"。
4. **迁移只增不改**：`packages/control-plane/src/db/migrations/NNN_名字.sql`，已执行的迁移永不编辑。
5. **凭据零泄漏**：模型 key、GitHub App 私钥、安装 token 都不许进沙箱、日志、事件流与 transcript。
   `npm run smoke` 里有一条红线用例专门抓这个。
6. **前端零构建、零外链、零字体**（`packages/web/public/`）：不引 CDN / 字体 / 分析脚本；所有动态
   内容一律走 `textContent`（不拼 HTML）——`packages/web/test/ui.test.ts` 会拦下来。
7. **失败是结果，不是异常**：工具失败 → `isError` 结果；模型请求失败 → `error` 事件 +
   `stopReason: "error"` 的消息；循环契约是"不抛异常、终态走事件"。观察者（事件 sink、存储）
   抛异常只记一条 warn，绝不冒泡进循环。

## 4. 代码与注释风格

- **注释写"为什么"，不写"做了什么"**。函数名与类型已经把"做了什么"说清楚了；注释的价值在
  "为什么是这个形状、换一种做法会坏在哪、踩过什么坑"。文件头必须有一段：这个文件解决什么问题、
  与相邻文件的分工、容易写错的地方。
- **中文**，`【】` 起小标题（例如 `【为什么不是 X】`）。数字、标识符、命令保持原样。
- **引用具体的东西**：写偏差就写 `附录 A-18`，写测试要点就写 `spec P4 测试要点 3`，写设计取舍就写
  `设计文档 §B.5`。不要写"按文档要求"这种找不到出处的句子。
- **类型收窄用判别式**：事件 / 记录一律带一个字面量 `type`（或 `role`），`switch` 全枚举 +
  `never` 兜底；新增一个成员时让编译器把漏网之处指出来，而不是等运行时。
- **测试文件头同样写"为什么值得写 / 它不替代什么"**。一个测试的价值不在断言数量，而在
  "它拦住的是哪一类回归"。
- 命名：表小写下划线；ID `<前缀>_<ulid>`；TS 文件全小写连字符；事件类型小写下划线；包名
  `@reuben-cloud/<name>`。

## 5. 测试分层（沿用 M0，不新建概念）

| 层 | 命令 | 允许依赖 | 写什么 |
|---|---|---|---|
| 单测 | `npm test` | 无（docker / PG / 网络都不许有） | 循环、工具、切点、渲染、契约（内存实现） |
| 集成 | `npm run test:integration` | docker + PG + MinIO | 环境构建、索引、真容器、真 PG 契约、真 HTTP |
| 真模型 | `npm run test:live` | 真 key | 一个真实任务端到端（手工跑） |
| 冒烟/红线 | `npm run smoke` | Linux docker | 隔离红线（任何 Phase 都不许让它变红） |

两条习惯：

- 用**脚本化的假模型 / 假 provider**测行为，不要为了测编排去花钱或依赖模型当天的脾气
  （`scriptedModel` 的写法在 `control-plane/test/unit/agent-events.test.ts` 与 `session-run.test.ts`）。
- 新加一个"双实现"（内存 / Postgres）的接口方法时，**把断言写进契约测试**（`agent-runtime/test/`
  里的 `*-contract.ts`），两个实现跑同一份；只测内存实现等于没测生产路径。

## 6. 一个 Phase 干完要交什么（这个仓库的"定义完成"）

1. **代码 + 测试**：`npm test` 与 `npm run typecheck` 全绿；涉及 docker / PG 的改动另跑
   `npm run test:integration`；`agent:run` 这条端到端路径不能被弄坏。
2. **规格里的"实现备注"**：`docs/agent-runtime-spec.md`（或 sandbox-spec）对应 Phase 下加一段
   `> **实现备注**：……有 N 条有意偏差，逐条记在附录 A-XY … A-ZW——……`。
3. **附录 A**：每一条"文档这么写、但这样做更好"都记一行（位置 / 原文 / 实际 / 理由 / 影响面）。
   这是给未来的自己与 reviewer 的账本，不是可选的美化。
4. **README**：M2 列表里的 Phase 勾选，并把关键交付物写进括号（越具体越好：表名、文件名、数字）。
5. **必要的用户文档**：新增的开关 / 脚本 / 端点写进 README 的对应小节（例如 P3 的四个压缩环境变量）。

## 7. 参考实现 pi

Agent 运行时（循环、上下文管理、工具处理）**以 `/Users/reuben/Documents/pi` 为参考实现**
（用户明确要求）。参考的是**契约与取舍**，不是照抄规模：

- 对照关系与"不搬什么"写在设计文档 §B（`§B.1–B.6` 对齐清单、`§B.7` 明确不搬）；
- 文件级对应表见 `docs/agent-runtime-spec.md` 的**附录 B**；
- 两边字段名**故意保持一致**（`toolCall` / `arguments` / `details` / `AgentTool` 的形状），
  这样"对照实现排查"不需要多一层翻译；线上协议的差异（Anthropic 的 `tool_use` / `input`）
  收在 `model/client.ts` 一处。

## 8. 几个已经踩过的坑（别重复踩）

- **别用 `onmessage` + `addEventListener("message", ...)` 同时监听**：它们是同一个通道的两个监听，
  事件会被处理两遍（P4 实现时真的让文字翻倍了一次）。
- **`turn` 的子进程 / 事件流都有"重放空洞"问题**：任何"发出去就没了"的流都要有有界缓冲 +
  游标补发（沙箱事件总线与观察窗 hub 是同一个问题的两处）。
- **沙箱里跑命令要显式给 cwd**：沙箱的默认 cwd 是 workspace 根，而仓库在 `/workspace/repo`，
  不传会得到 `MODULE_NOT_FOUND` 之类的错，原因与现象隔一层。
- **`git` 远端操作要短超时 + 有限重试**：这台机器到 github.com 的连接有一半概率在建立阶段挂住
  （详见 sandbox-spec Phase 12 实现备注 12）。
- **prompt cache 的断点在 system 那一个块上**：一次性请求（例如摘要）要显式关掉缓存写入
  （`ModelRequest.cache: "none"`），否则"省钱"的请求反而更贵。

## 9. 提交信息

`feat(scope): 主题` / `fix(scope): 主题` / `docs(m2): 主题` / `chore(scope): 主题`，一个 Phase 一个
commit（或几个小 commit）；正文写"为什么"与验证过的命令，别只写"update"。示例（git log 里都是）：

```
feat(agent-runtime): Phase 1+2 — 运行时契约与包拆分 + 会话持久化与沙箱租约
docs(m2): 沙箱改成会话的工作区租约（v1.2）；向量检索移出 M2
fix(provider): 裸本地镜像 ID 也是合法 digest（CI 第四轮抓到"四组全灭"）
```
