#!/bin/sh
set -eu

cert_name="argon-gateway"
renew_interval_seconds=21600
lineage_dir="/etc/letsencrypt/live/$cert_name"
nginx_cert_dir="/etc/nginx-certs"

copy_lineage_cert() {
  if [ ! -s "$lineage_dir/fullchain.pem" ] || [ ! -s "$lineage_dir/privkey.pem" ]; then
    return 1
  fi

  mkdir -p "$nginx_cert_dir"
  cp -L "$lineage_dir/fullchain.pem" "$nginx_cert_dir/fullchain.pem"
  cp -L "$lineage_dir/privkey.pem" "$nginx_cert_dir/privkey.pem"
  chmod 0644 "$nginx_cert_dir/fullchain.pem"
  chmod 0600 "$nginx_cert_dir/privkey.pem"
}

require_nginx_cert() {
  if [ -s "$nginx_cert_dir/fullchain.pem" ] && [ -s "$nginx_cert_dir/privkey.pem" ]; then
    return
  fi

  echo "Gateway certificate material is missing at $nginx_cert_dir" >&2
  exit 1
}

if [ -z "${GATEWAY_CERT_IP:-}" ]; then
  echo "GATEWAY_CERT_IP is required" >&2
  exit 1
fi

while true; do
  if [ -s "$lineage_dir/fullchain.pem" ] && [ -s "$lineage_dir/privkey.pem" ]; then
    certbot renew --cert-name "$cert_name"
  else
    certbot certonly \
      --standalone \
      --non-interactive \
      --agree-tos \
      --register-unsafely-without-email \
      --preferred-profile shortlived \
      --cert-name "$cert_name" \
      --ip-address "$GATEWAY_CERT_IP"
  fi

  copy_lineage_cert
  require_nginx_cert
  sleep "$renew_interval_seconds"
done
