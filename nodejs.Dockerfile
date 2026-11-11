FROM node:24.22.1-bookworm@sha256:d862bb5d082c5ae0210ac07e8c0344cb8cf7bef6d78e9b8c50c179da923108ea

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

COPY .yarnrc.yml package.json yarn.lock runtime-type-overrides.json ./
COPY .yarn/ ./.yarn/
COPY cli/package.json ./cli/
COPY bot/package.json ./bot/
COPY core/package.json ./core/
COPY discord-verifier/package.json ./discord-verifier/
COPY router/package.json ./router/
COPY indexer/package.json ./indexer/
COPY e2e/package.json ./e2e/
COPY runtime-client/ ./runtime-client/

RUN corepack enable \
 && corepack prepare yarn@stable --activate

RUN yarn install

RUN yarn generate:runtime-client

COPY cli/ ./cli/
COPY bot/ ./bot/
COPY core/ ./core/
COPY scripts/ ./scripts/
COPY tsconfig.json tsconfig.node.json ./

RUN yarn workspace @argonprotocol/cli build

ENTRYPOINT ["node", "cli/lib/cli.js"]
CMD []
