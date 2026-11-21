FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base

WORKDIR /usr/src/app

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
  apt-get update && \
  apt-get upgrade -y && \
  apt-get install -y curl && \
  rm -rf /var/lib/apt/lists/*

COPY lib ./lib
COPY seeds ./seeds

ENTRYPOINT [ "node", "lib/index.js" ]
