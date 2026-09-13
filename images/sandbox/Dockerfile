# reuben-cloud 默认沙箱镜像（`reuben-cloud/sandbox-base:dev`）。
#
# 【Phase 5 起它只剩一层薄封装】M0/M1 的那个大 Dockerfile 已经拆成 Layer 1 矩阵
# （`images/base/`）：非语言部分在 `Dockerfile.common`，语言工具链各自一个镜像。
# 这里之所以还留一个文件，是因为它承担一个**有名字的契约**：`SANDBOX_IMAGE`
# 与所有集成测试、冒烟、CI 都指向 `reuben-cloud/sandbox-base:dev` 这一个 tag，
# 而它到底是哪一档语言镜像（fullstack / node-dev / …）是这一行 ARG 说了算。
#
# 【为什么默认是 fullstack】现在这个 tag 的职责是"本地开发与全部既有测试的底座"：
# egress-proxy 的集成测试要 `python3 -m venv`，agent 的集成测试要 node，
# sandbox-image-check 要 git/tar。fullstack 是矩阵里唯一同时满足这三条的。
# 业务上真正给仓库用的镜像由 Phase 6/7 构建（`reuben-cloud/env-…`），不是这个 tag。
#
# 【加固参数仍然一个字都不写】只读根 / cap-drop / tmpfs / 内网 / --init 全在
# provider 侧（sandbox.md §F.1）。这个文件只负责选底座。
#
# 构建：`npm run build:image`（会先把 common 与 fullstack 建好再建它 —— 单独
# `docker build -f images/sandbox/Dockerfile .` 在没有 base-fullstack 时会拉取失败）。

ARG BASE_IMAGE=reuben-cloud/base-fullstack:dev
FROM ${BASE_IMAGE}

# FROM 之前的 ARG 只对 FROM 生效，要在指令里用到它（下面那个 LABEL）必须再声明一次。
ARG BASE_IMAGE

# 一个可查询的出处：`docker image inspect … --format '{{index .Config.Labels "reuben-cloud.base-image"}}'`
# 能直接回答"这个 sandbox-base 是从哪一档 Layer 1 来的"，而不用去翻构建日志。
LABEL reuben-cloud.base-image="${BASE_IMAGE}"
LABEL reuben-cloud.layer="1-sandbox-wrapper"
