# 多阶段：最后那个 stage 的 FROM 也必须落在 Layer 1（运行命令与用户契约从它继承）
FROM reuben-cloud/base-node-dev:dev AS build
RUN npm install -g typescript

FROM node:24-bookworm-slim
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libvips-dev
USER 1000:1000
