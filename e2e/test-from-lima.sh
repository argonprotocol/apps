#!/bin/bash

set -euo pipefail

DIRNAME=$(dirname "$0")
cd "$DIRNAME" || exit 1


# Check if limactl is installed
if ! command -v limactl &> /dev/null; then
  echo "limactl could not be found. Please install Lima by running: brew install lima"
  exit 1
fi

# Check if XQuartz is installed
if ! pgrep -x "XQuartz" > /dev/null; then
  open -g -a XQuartz   # -g = do not bring to foreground
  # shellcheck disable=SC2034
  for i in {1..10}; do
    if test -S /tmp/.X11-unix/X0; then
      echo "XQuartz started"
      break
    fi
    sleep 1
  done
  if ! test -S /tmp/.X11-unix/X0; then
    echo "Failed to start XQuartz. Please ensure it is installed and try again."
    exit 1
  fi
  echo "XQuartz is running."
fi

# Check if the Lima VM 'tauri-webdriver' exists
if ! limactl list --json | jq -e 'select(.name=="tauri-webdriver" and .status=="Running")' > /dev/null; then
  echo "Creating Lima VM 'tauri-webdriver'..."
  limactl start --name=tauri-webdriver -y --debug ./lima.yaml
fi

# Remote dir inside Lima VM

echo "Syncing project to Lima VM..."
rsync -av --delete \
  --exclude node_modules \
  --exclude data/bitcoin \
  --exclude data/argon \
  --exclude .idea \
  --exclude .husky \
  --exclude .git \
  --exclude target \
  -e "ssh -F $HOME/.lima/tauri-webdriver/ssh.config" \
  ../ lima-tauri-webdriver:./apps/

SYNC_ONLY=${SYNC_ONLY:-0}
if [ "$SYNC_ONLY" -eq 1 ]; then
  echo "SYNC_ONLY is set to 1. Exiting after sync."
  exit 0
fi

limactl shell tauri-webdriver -- bash -lc "sudo rm -rf ~/.config/com.argon.operations.local"
echo "Running tests inside Lima VM..."
# Install deps + run tests
limactl shell tauri-webdriver -- bash -lc "
  cd ./apps &&
  yarn install &&
  cd ./e2e &&
  yarn install && yarn test
"
