FROM node:24-bookworm

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
