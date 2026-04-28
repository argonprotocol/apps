#!/bin/bash

if [ ! -d /data ]; then
    echo "Make sure data directory exists already for this to work"
    exit 1
fi

if [ -n "${BITCOIN_ADDNODE:-}" ] && [[ "$1" == "bitcoind" || "$1" == */bitcoind ]]; then
    set -- "$@" "-addnode=${BITCOIN_ADDNODE}"
fi

echo "Running cmd: $@"
exec "$@"
