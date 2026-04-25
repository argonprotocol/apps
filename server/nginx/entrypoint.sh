#!/bin/sh
set -eu

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
