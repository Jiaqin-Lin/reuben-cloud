# P5 fixture · node-ts-basic

给环境推断用的最小 TypeScript 仓库（**不是**一个能真的跑起来的项目，只够回答"这是什么仓库"）。

| 特征 | 值 | 期望命中 |
|---|---|---|
| 锁文件 | `package-lock.json` | 包管理器 npm |
| 构建入口 | `Makefile`（`build` / `test`）+ `package.json` 的 scripts | 构建与验证命令 |
| 运行时版本 | `engines.node` = `>=20` | `runtimeVersions.node = 20` |
| 容器 | 没有 Dockerfile、没有 compose、没有 devcontainer | **L3 信号级** → `base-node-dev` |

`Makefile` 里的配方只有 `echo`：推断**不执行**仓库里的任何东西（spec 测试要点 8 的
"采集不执行代码"由另一个临时 fixture 证明，那个 fixture 的配方会写一个哨兵文件）。

## 目录

```
package.json        锁文件与入口信号
package-lock.json   npm 的锁文件（真生成的，P7 的健康检查可以拿它跑 npm ci）
Makefile            build / test / clean 三个目标
src/index.ts        唯一的源码文件（语言统计靠它）
tsconfig.json       TypeScript 的配置
```
