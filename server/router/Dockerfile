FROM node:24.21.0-slim AS base

WORKDIR /usr/src/app

RUN apt-get update && \
  apt-get install -y curl jq

COPY . .

EXPOSE 8080
ENTRYPOINT [ "node", "--enable-source-maps", "src/index.js" ]
