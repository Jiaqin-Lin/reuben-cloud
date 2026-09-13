FROM reuben-cloud/base-node-dev:dev
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libvips-dev
