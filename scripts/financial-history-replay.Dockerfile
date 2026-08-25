FROM scratch

COPY indexer/seeds/mainnet-financial-history-replay.db.gz /replay/mainnet-financial-history-replay.db.gz
COPY indexer/seeds/financial-history-replay-manifest.json /replay/financial-history-replay-manifest.json
