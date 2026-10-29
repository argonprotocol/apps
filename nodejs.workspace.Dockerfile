FROM node:24.22.1-bookworm@sha256:d862bb5d082c5ae0210ac07e8c0344cb8cf7bef6d78e9b8c50c179da923108ea

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

COPY . .
COPY --from=mainchain . ../mainchain

RUN corepack enable \
 && corepack prepare yarn@stable --activate

RUN cd ../mainchain \
    && yarn install && yarn workspace @argonprotocol/mainchain tsc \
    && yarn workspace @argonprotocol/testing tsc \
    && yarn
RUN pwd && ls -lart ../mainchain/client/nodejs
RUN yarn install
RUN yarn workspace @argonprotocol/cli build

ENTRYPOINT ["node", "cli/lib/cli.js"]
CMD []
