FROM node:20-bookworm

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

COPY .yarnrc.yml package.json yarn.lock ./
COPY .yarn/ ./.yarn/
COPY cli/package.json ./cli/
COPY bot/package.json ./bot/
COPY core/package.json ./core/

RUN corepack enable \
 && corepack prepare yarn@stable --activate

RUN yarn install

COPY cli/ ./cli/
COPY bot/ ./bot/
COPY core/ ./core/
COPY scripts/ ./scripts/

RUN yarn workspace @argonprotocol/cli build

ENTRYPOINT ["node", "cli/lib/cli.js"]
CMD []
