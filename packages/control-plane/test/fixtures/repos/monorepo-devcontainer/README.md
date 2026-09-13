# P5 fixture · monorepo-devcontainer

给环境推断用的最小 monorepo（**不是**一个能真的装起来的项目，只够回答"这是什么仓库"）。

| 特征 | 值 | 期望命中 |
|---|---|---|
| devcontainer | `.devcontainer/devcontainer.json`（**JSONC：带注释与尾逗号**） | **L1 devcontainer 级** |
| features | `node:1`（→ 语言提示）+ `docker-in-docker:2`（→ 不支持 + degradedRisk） | `ignored[]` 有两条 feature 结论 |
| 忽略字段 | `mounts` / `forwardPorts` / `remoteUser` / `customizations` / `image` | 每条都进 `ignored[]` 且带原因 |
| 包管理器 | `pnpm-lock.yaml` + `pnpm-workspace.yaml` | pnpm；`monorepo = true` |
| 服务依赖 | `compose.yaml` 的 `db`(postgres) 与 `cache`(redis) | `degradedRisks` 含 postgres 与 redis |
| postCreateCommand | `pnpm install` | 进 `buildCommands` 的第一条 |

## 目录

```
package.json                    workspaces + 根 scripts
pnpm-workspace.yaml             monorepo 的显式标志
pnpm-lock.yaml                  pnpm 的锁文件（**空壳**：只用来认包管理器）
.devcontainer/devcontainer.json   L1 的信号来源（JSONC）
compose.yaml                    postgres + redis → degradedRisks
packages/api/ · packages/web/   两个子包（monorepo 兜底判定用）
```
