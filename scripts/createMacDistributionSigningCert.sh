#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only runs on macOS."
  exit 1
fi

cert_name="${1:-Argon Apps Distribution Self Signed}"
slug="$(printf '%s' "$cert_name" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
output_dir="${OUTPUT_DIR:-$HOME/.argon-signing/$slug}"
keychain="${HOME}/Library/Keychains/login.keychain-db"

crt_path="$output_dir/apple_certificate.crt"
key_path="$output_dir/apple_certificate.key"
p12_path="$output_dir/apple_certificate.p12"
identity_path="$output_dir/apple_signing_identity.txt"
password_path="$output_dir/apple_certificate_password.txt"
base64_path="$output_dir/apple_certificate_base64.txt"

if [[ -e "$crt_path" || -e "$key_path" || -e "$p12_path" || -e "$password_path" || -e "$base64_path" ]]; then
  echo "Refusing to overwrite existing signing artifacts in:"
  echo "  $output_dir"
  echo "Delete that directory or set OUTPUT_DIR to a new location and rerun."
  exit 1
fi

mkdir -p "$output_dir"
chmod 700 "$output_dir"

p12_password="$(openssl rand -base64 24 | tr -d '\n')"

printf '%s' "$cert_name" > "$identity_path"
printf '%s' "$p12_password" > "$password_path"
chmod 600 "$identity_path" "$password_path"

openssl req \
  -new \
  -newkey rsa:2048 \
  -x509 \
  -sha256 \
  -days 3650 \
  -nodes \
  -subj "/CN=${cert_name}" \
  -addext "keyUsage=digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  -keyout "$key_path" \
  -out "$crt_path"

openssl pkcs12 \
  -export \
  -legacy \
  -inkey "$key_path" \
  -in "$crt_path" \
  -name "$cert_name" \
  -out "$p12_path" \
  -passout "pass:${p12_password}"

chmod 600 "$key_path" "$crt_path" "$p12_path"

security import "$p12_path" \
  -k "$keychain" \
  -P "$p12_password" \
  -T /usr/bin/codesign \
  -T /usr/bin/security

security add-trusted-cert \
  -d \
  -r trustRoot \
  -p codeSign \
  -k "$keychain" \
  "$crt_path" >/dev/null 2>&1 || true

if ! security find-identity -v -p codesigning "$keychain" | grep -Fq "\"${cert_name}\""; then
  echo "Failed to verify imported code-signing identity:"
  echo "  $cert_name"
  exit 1
fi

base64 < "$p12_path" | tr -d '\n' > "$base64_path"
chmod 600 "$base64_path"

echo
echo "Created macOS distribution signing artifacts:"
echo "  $output_dir"
echo
echo "GitHub secrets to set:"
echo "  APPLE_SIGNING_IDENTITY: $identity_path"
echo "  APPLE_CERTIFICATE_PASSWORD: $password_path"
echo "  APPLE_CERTIFICATE: $base64_path"
echo
echo "If you use gh, run:"
echo "  gh secret set APPLE_SIGNING_IDENTITY < \"$identity_path\""
echo "  gh secret set APPLE_CERTIFICATE_PASSWORD < \"$password_path\""
echo "  gh secret set APPLE_CERTIFICATE < \"$base64_path\""
