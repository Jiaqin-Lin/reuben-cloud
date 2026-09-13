# 合法的生成结果（对照用：它必须通过 checkDockerfileConstraints）
FROM reuben-cloud/base-python-dev:dev

USER root
RUN apt-get update && apt-get install -y --no-install-recommends libvips-dev \
 && rm -rf /var/lib/apt/lists/*
USER 1000:1000

ENV PYTHONPATH="/workspace/repo/src"
