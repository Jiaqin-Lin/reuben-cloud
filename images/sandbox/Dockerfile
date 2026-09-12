# reuben-cloud 沙箱镜像（Phase 4）。
#
# 【这个镜像只负责什么】把 packages/sandbox-agent/src 放进一个「非 root、能在只读根 +
# 512MiB /tmp + 内网 + cap-drop ALL 下正常工作」的运行时里。它**不负责加固**：
# 只读根、cap-drop、tmpfs、内网、--init 全部由 Phase 5 的 LocalDockerProvider 在
# create 时传。理由很简单——镜像可以被换掉，provider 传的参数才是可信那一侧；
# 把加固写进镜像只会给人「镜像自己很安全」的错觉。
#
# 构建（上下文是仓库根，不是本目录）：
#   docker build -f images/sandbox/Dockerfile -t reuben-cloud/sandbox-base:dev .
# 验证：
#   node scripts/sandbox-image-check.ts   # 或 npm run check:image
#
# 【为什么基础镜像用 tag 而不是 digest】tag 让「改一行代码 → 重建 → 跑」这条本地循环
# 保持便宜。digest 强制发生在 Phase 5 的 provider 侧（SandboxSpec.image 必须含
# `@sha256:`），CI 在构建后记录产物 digest（spec Phase 4 末「构建命令」）。
# MVP 也不做镜像发布流水线，本地 tag 就是全部。

FROM node:24-bookworm-slim

# 语言运行时 + 工具，逐个列出，不用 metapackage（少一个包就少一片攻击面/体积）：
#   git ca-certificates curl —— 仓库进出（Phase 9 的 clone/push）与 HTTPS
#   tar gzip                 —— Phase 3 的 /archive 直接用系统 tar，不在 Node 里 gzip
#   procps                   —— ps / pgrep，排查孤儿进程时要靠它
#   python3 python3-pip python3-venv build-essential —— MVP 的目标仓库是 TS/Python
# 不装 go/rust/java：基础镜像矩阵是 M2 的事（spec「镜像范围（MVP）」），
# 现在装一整套只会让镜像变大、构建变慢。
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl tar gzip procps \
      python3 python3-pip python3-venv build-essential \
    && rm -rf /var/lib/apt/lists/*

# 这里的每一项都不是"顺手设的"：
#   PYTHONUNBUFFERED=1 —— 没有它，python 的输出会整段卡在管道缓冲里，表现为
#                          "命令跑完了才一次性出结果"，把 Phase 1 的实时性白送掉
#   LANG/LC_ALL=C.UTF-8 —— 没有它，python3 往管道写非 ASCII 会 UnicodeEncodeError；
#                          不选 zh_CN.UTF-8 是因为 slim 里没有 locale 数据
#   HOME=/tmp/agent     —— 见附录 A-2：不挂 tmpfs 到 /home，而是放在 /tmp 下自建，
#                          属主天然归 uid 1000
#   SANDBOX_AGENT_HOST  —— 裸跑默认 127.0.0.1，容器里必须显式 0.0.0.0 才能被 CP 访问
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp/agent \
    SANDBOX_AGENT_HOST=0.0.0.0 \
    SANDBOX_AGENT_PORT=8080 \
    SANDBOX_WORKSPACE_ROOT=/workspace \
    SANDBOX_LOG_ROOT=/tmp/reuben-cloud/exec

# 可写点的属主必须在镜像里就正确，这是 Appendix B 里排第一的那类坑：
#   1) /workspace 由命名卷覆盖。Docker 建新卷时会把镜像里这个目录的**内容与属主**
#      复制进去；少了 chown，卷就是 root:root，容器里 uid 1000 连 workspace 都写不进去。
#   2) /tmp/reuben-cloud 是日志根与外置 patch 的落点。运行时 /tmp 会被 tmpfs 盖住
#      （provider 传 mode=1777，见 Phase 5），但手动 `docker run` 和裸跑用的还是镜像里这份。
# 【为什么没有 useradd】base 镜像自带 uid/gid 1000（用户 `node`，`--gid 1000`），
# 再 `useradd -u 1000` 会直接以 "UID 1000 is not unique" 构建失败。而 uid/gid 才是
# 契约（provider 传的是 `--user 1000:1000`），用户名叫什么无所谓；复用现成的 1000
# 还顺带保住了 /etc/passwd 里有对应条目（`os.userInfo()` 之类不会炸）。
# 这里也**不写 VOLUME /workspace**：写了之后镜像里对该路径的写入会被丢弃，
# 卷由 provider 显式挂。
RUN mkdir -p /workspace /app /tmp/reuben-cloud \
    && chown -R 1000:1000 /workspace /app /tmp/reuben-cloud

WORKDIR /app
# 零依赖的兑现（spec §0.2/§0.3）：没有 npm install、没有构建层，COPY 源码直接跑。
# 顺带说明为什么镜像里没有 node_modules 也能跑——sandbox-agent 的 dependencies 是空对象。
COPY packages/sandbox-agent/src ./src

# 镜像里再写一遍 uid，provider 还会再传一次 `--user 1000:1000`（防"镜像被人换掉"）。
USER 1000:1000
EXPOSE 8080

# HEALTHCHECK 是可选增强：它只让 `docker ps` 能看出状态，provider 自己会轮询 /health，
# 不依赖这一项。token 是运行时注入的，而 env 在容器里可见，所以这里可以不落凭据地用它。
# 注意：没有 token 的容器本来就起不来（下一行 CMD），healthcheck 不会掩盖这个事实。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health',{headers:{authorization:'Bearer '+process.env.SANDBOX_AGENT_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec 形式（不是 shell 形式）：node 直接吃 .ts，靠的是 tsconfig 的 erasableSyntaxOnly
# 约束——没有构建步骤，`node src/index.ts` 就是全部。
# **故意不设 SANDBOX_AGENT_TOKEN**：缺了就启动失败。镜像里给个默认 token 等于所有沙箱
# 共用一个公开凭据，那是整个方案最严重的一类错误。
CMD ["node", "src/index.ts"]
