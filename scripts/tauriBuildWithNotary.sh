#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TAURI_CONFIG_PATH="$ROOT_DIR/src-tauri/tauri.conf.json"
TARGET="universal-apple-darwin"
CONFIG_PATH=""
COMMAND="${1:-}"

NOTARY_KEY_ID="${APPLE_API_KEY:-}"
NOTARY_ISSUER="${APPLE_API_ISSUER:-}"
NOTARY_KEY_PATH="${APPLE_API_KEY_PATH:-}"

if [[ -z "$COMMAND" ]]; then
  echo "Expected a Tauri subcommand" >&2
  exit 1
fi

shift
ARGS=("$@")

for ((i = 0; i < ${#ARGS[@]}; i++)); do
  case "${ARGS[i]}" in
    --config)
      CONFIG_PATH="${ARGS[i + 1]:-}"
      ((i++))
      ;;
    --target)
      TARGET="${ARGS[i + 1]:-}"
      ((i++))
      ;;
  esac
done

if [[ "$COMMAND" != "build" ]]; then
  exec yarn tauri "$COMMAND" "${ARGS[@]}"
fi

if [[ -z "$CONFIG_PATH" ]]; then
  echo "Expected --config in tauri-action args" >&2
  exit 1
fi

if [[ -z "$NOTARY_KEY_ID" || -z "$NOTARY_ISSUER" || -z "$NOTARY_KEY_PATH" ]]; then
  echo "Missing Apple notary credentials" >&2
  exit 1
fi

PRODUCT_NAME=$(
  node -e 'const fs = require("fs");
const [basePath, overlayPath] = process.argv.slice(1);
const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
const overlay = JSON.parse(fs.readFileSync(overlayPath, "utf8"));
process.stdout.write(overlay.productName ?? base.productName ?? "");' \
    "$TAURI_CONFIG_PATH" "$CONFIG_PATH"
)

if [[ -z "$PRODUCT_NAME" ]]; then
  echo "Unable to determine product name for notarization" >&2
  exit 1
fi

unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID

yarn tauri build "${ARGS[@]}"

BUNDLE_DIR="$ROOT_DIR/src-tauri/target/$TARGET/release/bundle"
shopt -s nullglob
DMG_MATCHES=("$BUNDLE_DIR/dmg/$PRODUCT_NAME"*.dmg)

if [[ ${#DMG_MATCHES[@]} -ne 1 ]]; then
  echo "Expected exactly one DMG for $PRODUCT_NAME in $BUNDLE_DIR/dmg" >&2
  printf 'Found:\n' >&2
  printf '  %s\n' "${DMG_MATCHES[@]}" >&2
  exit 1
fi

DMG_PATH="${DMG_MATCHES[0]}"
SUBMIT_OUTPUT=$(mktemp)
MAX_ATTEMPTS=240
POLL_SECONDS=60
RETRY_SECONDS=30
RETRY_LIMIT=5

json_field() {
  node -e 'const fs = require("fs");
const [path, field] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(path, "utf8"));
const value =
  field === "id"
    ? data.id ?? data.data?.id ?? ""
    : data.status ?? data.data?.status ?? data.data?.attributes?.status ?? "";
process.stdout.write(String(value));' "$1" "$2"
}

echo "::group::Submit DMG for notarization"
xcrun notarytool submit "$DMG_PATH" \
  --issuer "$NOTARY_ISSUER" \
  --key-id "$NOTARY_KEY_ID" \
  --key "$NOTARY_KEY_PATH" \
  --output-format json | tee "$SUBMIT_OUTPUT"
echo "::endgroup::"

SUBMISSION_ID=$(json_field "$SUBMIT_OUTPUT" id)

if [[ -z "$SUBMISSION_ID" ]]; then
  echo "Unable to read notarization submission ID" >&2
  exit 1
fi

echo "Submitted $DMG_PATH"
echo "Submission ID: $SUBMISSION_ID"

CONSECUTIVE_FAILURES=0

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)); do
  INFO_OUTPUT=$(mktemp)

  echo "::group::Check notarization status (attempt $attempt/$MAX_ATTEMPTS)"
  if xcrun notarytool info "$SUBMISSION_ID" \
    --issuer "$NOTARY_ISSUER" \
    --key-id "$NOTARY_KEY_ID" \
    --key "$NOTARY_KEY_PATH" \
    --output-format json | tee "$INFO_OUTPUT"; then
    echo "::endgroup::"

    STATUS=$(json_field "$INFO_OUTPUT" status)
    echo "Current notarization status: $STATUS"
    CONSECUTIVE_FAILURES=0

    case "$STATUS" in
      Accepted)
        LOG_OUTPUT=$(mktemp)

        echo "::group::Download notarization log"
        xcrun notarytool log "$SUBMISSION_ID" \
          --issuer "$NOTARY_ISSUER" \
          --key-id "$NOTARY_KEY_ID" \
          --key "$NOTARY_KEY_PATH" \
          "$LOG_OUTPUT"
        cat "$LOG_OUTPUT"
        echo "::endgroup::"

        echo "::group::Staple and validate DMG"
        xcrun stapler staple -v "$DMG_PATH"
        xcrun stapler validate -v "$DMG_PATH"
        echo "::endgroup::"
        exit 0
        ;;
      In\ Progress)
        sleep "$POLL_SECONDS"
        ;;
      Invalid | Rejected)
        LOG_OUTPUT=$(mktemp)

        echo "::group::Download notarization log"
        xcrun notarytool log "$SUBMISSION_ID" \
          --issuer "$NOTARY_ISSUER" \
          --key-id "$NOTARY_KEY_ID" \
          --key "$NOTARY_KEY_PATH" \
          "$LOG_OUTPUT" || true
        if [[ -s "$LOG_OUTPUT" ]]; then
          cat "$LOG_OUTPUT"
        fi
        echo "::endgroup::"

        echo "Notarization failed with status $STATUS" >&2
        exit 1
        ;;
      *)
        echo "Unexpected notarization status: $STATUS" >&2
        sleep "$POLL_SECONDS"
        ;;
    esac
  else
    echo "::endgroup::"

    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))

    if ((CONSECUTIVE_FAILURES >= RETRY_LIMIT)); then
      echo "Failed to query notarization status after $CONSECUTIVE_FAILURES consecutive attempts" >&2
      exit 1
    fi

    echo "Transient notarization status error. Retrying in ${RETRY_SECONDS}s..." >&2
    sleep "$RETRY_SECONDS"
  fi
done

echo "Timed out waiting for notarization after $MAX_ATTEMPTS attempts" >&2
exit 1
