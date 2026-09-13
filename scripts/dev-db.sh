#!/usr/bin/env bash
#
# 本地开发用的 Postgres（一次性容器）。
#
# spec §0.5 规定"需要 Postgres 的测试用一次性容器"，并给了固定端口 55432。
# 这个脚本是那条规矩的落点：起一个**不挂卷**的容器（数据丢了就丢了，
# 迁移重跑一次就好），用完 `down` 掉。
#
# 用法：
#   scripts/dev-db.sh up       # 起（幂等：已经在跑就复用）
#   scripts/dev-db.sh down     # 停（幂等）
#   scripts/dev-db.sh status   # 看一眼
#   scripts/dev-db.sh url      # 只打印连接串（喂给 DATABASE_URL）
#
# 环境变量（都有缺省）：
#   REUBEN_CLOUD_DB_NAME      容器名，默认 reuben-cloud-dev-db
#   REUBEN_CLOUD_DB_PORT      宿主端口，默认 55432
#   REUBEN_CLOUD_DB_PASSWORD  密码，默认 x（本地一次性容器，不是凭据）
#   REUBEN_CLOUD_DB_IMAGE     镜像，默认 postgres:16-alpine

set -euo pipefail

NAME="${REUBEN_CLOUD_DB_NAME:-reuben-cloud-dev-db}"
PORT="${REUBEN_CLOUD_DB_PORT:-55432}"
PASSWORD="${REUBEN_CLOUD_DB_PASSWORD:-x}"
IMAGE="${REUBEN_CLOUD_DB_IMAGE:-postgres:16-alpine}"
DATABASE="reuben_cloud"
URL="postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}"

running() {
  [ "$(docker inspect -f '{{.State.Running}}' "${NAME}" 2>/dev/null || echo false)" = "true" ]
}

exists() {
  docker inspect "${NAME}" >/dev/null 2>&1
}

wait_ready() {
  # 等 pg_isready：容器刚起来的那一两秒里，连接会被拒。
  for _ in $(seq 1 60); do
    if docker exec "${NAME}" pg_isready -U postgres -d "${DATABASE}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "✖ 等 ${NAME} 就绪超时" >&2
  return 1
}

case "${1:-up}" in
  up)
    if running; then
      echo "✔ ${NAME} 已经在跑（端口 ${PORT}）"
    else
      if exists; then docker rm -f "${NAME}" >/dev/null; fi
      docker run -d --name "${NAME}" \
        -e "POSTGRES_PASSWORD=${PASSWORD}" \
        -e "POSTGRES_DB=${DATABASE}" \
        -p "127.0.0.1:${PORT}:5432" \
        "${IMAGE}" >/dev/null
      wait_ready
      echo "✔ ${NAME} 已启动（端口 ${PORT}）"
    fi
    echo "  DATABASE_URL=${URL}"
    echo "  下一步：DATABASE_URL=${URL} npm run db:migrate"
    ;;
  down)
    if exists; then
      docker rm -f "${NAME}" >/dev/null
      echo "✔ ${NAME} 已删除"
    else
      echo "✔ ${NAME} 本来就不在"
    fi
    ;;
  status)
    if running; then
      echo "${NAME}：running（${URL}）"
    elif exists; then
      echo "${NAME}：存在但没在跑"
    else
      echo "${NAME}：不存在"
    fi
    ;;
  url)
    echo "${URL}"
    ;;
  *)
    echo "用法：scripts/dev-db.sh [up|down|status|url]" >&2
    exit 2
    ;;
esac
