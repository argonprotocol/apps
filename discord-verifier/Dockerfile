FROM node:24.12-slim AS build

WORKDIR /usr/src/argon-apps

COPY . .

RUN corepack enable \
  && yarn install --immutable \
  && yarn generate:runtime-client \
  && yarn workspace @argonprotocol/apps-discord-verifier build \
  && yarn workspaces focus @argonprotocol/apps-discord-verifier --production

FROM node:24.12-slim

WORKDIR /usr/src/argon-apps

COPY --from=build /usr/src/argon-apps/node_modules ./node_modules
COPY --from=build /usr/src/argon-apps/discord-verifier/dist ./discord-verifier/dist

RUN mkdir -p /var/lib/argon-discord-verifier \
  && chown node:node /var/lib/argon-discord-verifier

ENV DATABASE_PATH=/var/lib/argon-discord-verifier/verifier.sqlite

VOLUME ["/var/lib/argon-discord-verifier"]
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["node", "--enable-source-maps", "discord-verifier/dist/index.js"]
