FROM node:24-slim AS base

WORKDIR /usr/src/app

RUN apt-get update && \
  apt-get install -y curl && \
  rm -rf /var/lib/apt/lists/*

COPY lib ./lib
COPY seeds ./seeds

ENTRYPOINT [ "node", "lib/index.js" ]
