#!/bin/bash

DIRNAME="$(dirname "$0")"
HOME_DIR="$DIRNAME/../.."
pkill -f "$HOME_DIR/server/scripts/installer.sh"

cd "$HOME_DIR/server"

docker compose --profile=all down --rmi all --volumes
docker system prune -af --volumes

rm -rf "$HOME_DIR"/account
rm -rf "$HOME_DIR"/server*
rm -rf "$HOME_DIR"/config
rm -rf "$HOME_DIR"/logs
rm -rf "$HOME_DIR"/data

echo "Server wiped clean"
