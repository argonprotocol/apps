FROM node:24.21.0-slim AS base

WORKDIR /usr/src/app

RUN apt-get update && \
  apt-get install -y curl

COPY . .

EXPOSE 3000
ENTRYPOINT [ "node", "src/index.js" ]
