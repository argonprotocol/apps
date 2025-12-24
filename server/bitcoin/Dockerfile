# Base image pinned for deterministic third-party installs.
# Update only during explicit Bitcoin or security releases.
FROM debian:bullseye-20251208-slim@sha256:e899040a73d36e2b36fa33216943539d9957cba8172b858097c2cabcdb20a3e2

ARG VERSION=28.0
ENV VERSION=$VERSION

RUN <<END
    set -ex
    apt-get update
    apt-get install -y wget curl jq gnupg
    # Dynamically fetch and import all builder keys from Bitcoin Core guix.sigs
    mkdir -p /tmp/builder-keys
    cd /tmp/builder-keys

    curl -s https://api.github.com/repos/bitcoin-core/guix.sigs/contents/builder-keys | \
      jq -r '.[] | select(.name | endswith(".gpg")) | .name' | \
      while read keyfile; do
        echo "Fetching and importing key: $keyfile"
        wget -q https://raw.githubusercontent.com/bitcoin-core/guix.sigs/main/builder-keys/"$keyfile" && \
        gpg --batch --import "$keyfile" || echo "Warning: failed to fetch or import $keyfile"
      done
END
RUN <<END
    ARCH=$(dpkg --print-architecture)
    if [ "$ARCH" = "amd64" ]; then
        PLATFORM="x86_64-linux-gnu"
    elif [ "$ARCH" = "arm64" ]; then
        PLATFORM="aarch64-linux-gnu"
    else
        echo "Unsupported architecture: $ARCH"
        exit 1
    fi
    if [ -z "$VERSION" ]; then
        echo "VERSION is not set"
        exit 1
    fi
    VERSION=${VERSION#v}
    wget https://bitcoincore.org/bin/bitcoin-core-$VERSION/bitcoin-$VERSION-$PLATFORM.tar.gz
    wget https://bitcoincore.org/bin/bitcoin-core-$VERSION/SHA256SUMS.asc
    wget https://bitcoincore.org/bin/bitcoin-core-$VERSION/SHA256SUMS
    gpg --verify SHA256SUMS.asc SHA256SUMS
    grep "bitcoin-$VERSION-$PLATFORM.tar.gz" SHA256SUMS | sha256sum -c -
    if [ $? -ne 0 ]; then
        echo "SHA256 checksum verification failed"
        exit 1
    fi
    tar xzf bitcoin-$VERSION-$PLATFORM.tar.gz
    install -m 0755 -o root -g root -t /usr/local/bin bitcoin-$VERSION/bin/*
    rm -rf /opt/bitcoin-${VERSION}/bin/bitcoin-qt
END

COPY ./entrypoint.sh /

ENTRYPOINT [ "./entrypoint.sh" ]
CMD [ "/usr/local/bin/bitcoind", "-conf=/etc/bitcoin/bitcoin.conf" ]
