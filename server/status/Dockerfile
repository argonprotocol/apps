FROM oven/bun:1.3.5 as base

RUN apt-get update && apt-get install -y \
    curl jq \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app

COPY . .

EXPOSE 8080
ENTRYPOINT [ "bun", "run", "server.ts" ]
