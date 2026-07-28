#!/usr/bin/env bash

DIRNAME="$(dirname "$0")"
HOME_DIR="$(realpath "$DIRNAME/../..")"
DATA_DIR="$HOME_DIR/data/argon"
BACKUP_DIR="$HOME_DIR/backups"
pkill -f "$HOME_DIR/server/scripts/installer.sh" || true

cd "$HOME_DIR/server"

docker compose --profile=all down --rmi all --volumes

DATABASES=()
for database in router.sqlite vault.sqlite; do
  if [[ -f "$DATA_DIR/$database" ]]; then
    DATABASES+=("data/argon/$database")
  fi
done

if (( ${#DATABASES[@]} )); then
  # Do not delete server data unless its database backup completed successfully.
  set -e
  mkdir -p "$BACKUP_DIR"
  chown --reference="$HOME_DIR" "$BACKUP_DIR"
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  TEMP_ARCHIVE="$(mktemp --tmpdir="$BACKUP_DIR" --suffix=.tar.gz.tmp "argon-server-databases-$STAMP-XXXXXXXX")"
  ARCHIVE="${TEMP_ARCHIVE%.tmp}"
  tar -C "$HOME_DIR" -czf "$TEMP_ARCHIVE" "${DATABASES[@]}"
  chown --reference="$HOME_DIR" "$TEMP_ARCHIVE"
  chmod 0600 "$TEMP_ARCHIVE"
  mv "$TEMP_ARCHIVE" "$ARCHIVE"
  set +e
  echo "Database backup ready: $ARCHIVE"
else
  echo "No server databases found"
fi

docker system prune -af --volumes

rm -rf "$HOME_DIR"/account
rm -rf "$HOME_DIR"/server*
rm -rf "$HOME_DIR"/config
rm -rf "$HOME_DIR"/logs
rm -rf "$HOME_DIR"/data

echo "Server wiped clean"
