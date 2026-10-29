FROM node:24.22.1-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS base

WORKDIR /usr/src/app

RUN apt-get update && \
  apt-get install -y curl

COPY . .

EXPOSE 3000
ENTRYPOINT [ "node", "src/index.js" ]
