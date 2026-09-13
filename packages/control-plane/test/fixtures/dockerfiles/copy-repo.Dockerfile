FROM reuben-cloud/base-node-dev:dev
COPY package.json .
RUN npm ci
