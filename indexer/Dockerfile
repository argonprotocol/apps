FROM node:24-slim AS base

WORKDIR /usr/src/app

RUN apt-get update && \
  apt-get install -y curl

COPY . .
COPY seeds ./seeds

ENTRYPOINT [ "node", "lib/index.js" ]
