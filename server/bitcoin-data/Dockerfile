FROM --platform=linux/amd64 debian

WORKDIR /init-data

ARG SNAPSHOT_HEIGHT=unknown
ARG SNAPSHOT_NETWORK=unknown
ARG COMMIT_SHA=none
ARG UTXO_HASH=unknown
LABEL snapshot.height=$SNAPSHOT_HEIGHT
LABEL snapshot.network=$SNAPSHOT_NETWORK
LABEL snapshot.utxohash=$UTXO_HASH
LABEL org.opencontainers.image.revision=$COMMIT_SHA
LABEL org.opencontainers.image.source=https://github.com/argonprotocol/apps

COPY splits/data.tar.aa* /init-data/.
COPY splits/data.tar.ab* /init-data/.
COPY splits/data.tar.ac* /init-data/.
COPY splits/data.tar.ad* /init-data/.
COPY splits/data.tar.ae* /init-data/.
COPY splits/data.tar.af* /init-data/.

COPY <<-EOF copy.sh
	#!/bin/bash

	cd /data
	cat /init-data/data.tar.* | tar xvf -
	cd -
EOF
RUN chmod +x copy.sh

CMD [ "./copy.sh" ]
