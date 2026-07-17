#!/bin/sh
set -eu

: "${SUBSTRATE_UPSTREAM_URL:=http://argon-miner:9945}"
: "${SUBSTRATE_UPSTREAM_HOST_HEADER:=localhost:9945}"
: "${ROUTER_UPSTREAM_URL:=http://router:8080}"
: "${BOT_UPSTREAM_URL:=http://bot:8080}"
export SUBSTRATE_UPSTREAM_URL SUBSTRATE_UPSTREAM_HOST_HEADER ROUTER_UPSTREAM_URL BOT_UPSTREAM_URL

cert_fingerprint() {
  sha256sum /etc/nginx/certs/fullchain.pem /etc/nginx/certs/privkey.pem 2>/dev/null || true
}

if [ "$#" -gt 0 ] && { [ "$1" != "nginx" ] || ! printf '%s\n' "$*" | grep -q 'daemon off'; }; then
  exec /docker-entrypoint.sh "$@"
fi

watch_gateway_certs() {
  last_fingerprint="$(cert_fingerprint)"

  while true; do
    sleep 60

    fingerprint="$(cert_fingerprint)"
    if [ -n "$fingerprint" ] && [ "$fingerprint" != "$last_fingerprint" ]; then
      last_fingerprint="$fingerprint"
      nginx -t && nginx -s reload
    fi
  done
}

watch_gateway_certs &
exec /docker-entrypoint.sh "$@"
