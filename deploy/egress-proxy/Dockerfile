# reuben-cloud egress-proxy 镜像（Phase 6）。
#
# 【这个镜像只负责什么】把 deploy/egress-proxy/src 放进一个「非 root、只读根、cap-drop ALL、
# 同时挂在共用内网与默认 bridge 上」的运行时里。加固由 Provider 侧（control-plane 的
# EgressProxy）在创建容器时传——镜像可以被换掉，创建参数才是可信那一侧。这条取舍与沙箱镜像
# 完全一致（见 images/sandbox/Dockerfile 顶部）。
#
# 【为什么不需要 ca-certificates / curl / npm】代理是**隧道 + 明文转发**：它不解密流量、
# 不发起 TLS、不注入凭据。HTTPS 的证书校验发生在沙箱与目标之间，端到端，跟这里无关。
# 于是镜像里只有 node 本体——这也是"未授权代码在这个容器里没有落脚点"的一部分。
#
# 构建（上下文是仓库根，不是本目录）：
#   docker build -f deploy/egress-proxy/Dockerfile -t reuben-cloud/egress-proxy:dev .
# 起容器（会自己建内网、挂白名单、加固）：
#   npm run proxy:up      # 背后是 scripts/egress-proxy.ts + LocalDockerProvider 的那套加固参数
#
# 【allowlist.txt 为什么要烤进镜像】没有 bind mount 时（手动 docker run、CI 里裸跑）
# 它必须有一份能用的清单；有 bind mount 时运行时的挂载会覆盖它——留着这份是为了让
# "没配也起得来"，而不是让"配错了也起得来"（配错路径会启动失败，见 proxy.ts）。
# SIGHUP 重载需要文件可被替换，而只读根下只能靠只读 bind mount，这正是 EgressProxy 干的事。

FROM node:24-bookworm-slim

# 三个缺省值都进镜像 env：手动 `docker run` 时不用记端口和路径。
# 注意 SANDBOX_AGENT_TOKEN 那类"必须每实例不同"的凭据这里没有——代理不持有任何凭据（§F.2）。
ENV EGRESS_PROXY_PORT=3128 \
    EGRESS_PROXY_HOST=0.0.0.0 \
    EGRESS_PROXY_ALLOWLIST=/app/allowlist.txt

# /app 的属主必须是 1000：容器以 1000:1000 跑，只读根下它只需要"读"，
# 但 bind mount 点与工作目录的属主对不上会在排查时凭空多一个变量。
RUN mkdir -p /app && chown -R 1000:1000 /app

WORKDIR /app
# 零依赖的兑现：代理只用 node 内置模块（http / net / fs），没有 npm install、没有构建层。
COPY deploy/egress-proxy/src ./src
COPY deploy/egress-proxy/allowlist.txt ./allowlist.txt

USER 1000:1000
EXPOSE 3128

# 只给 `docker ps` 看状态用（EgressProxy.ensureRunning 自己会探 /healthz）。
# 它读的是容器内网/回环地址，不需要 token——代理本来就没有 token 可读。
HEALTHCHECK --interval=30s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3128/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 绝对路径：provider 会把 WorkingDir 覆盖成 /app（见 EgressProxy），但启动命令不应该依赖它。
# node 直接吃 .ts，靠的是 tsconfig 的 erasableSyntaxOnly 约束——没有构建步骤。
CMD ["node", "/app/src/proxy.ts"]
