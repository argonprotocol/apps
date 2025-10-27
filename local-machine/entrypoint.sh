#!/bin/sh
set -eu

# Use provided UID/GID from env, or default to 1000
USER_ID=${UID:-1000}
GROUP_ID=${GID:-1000}

# Update argon's UID/GID if needed
if [ "$(id -u argon)" != "$USER_ID" ]; then
    usermod -u "$USER_ID" argon
fi

if [ "$(id -g argon)" != "$GROUP_ID" ]; then
    if getent group "$GROUP_ID" >/dev/null; then
        # Group already exists -> just move argon into it
        usermod -g "$GROUP_ID" argon
    else
        groupmod -g "$GROUP_ID" argon
    fi
fi

# Fix ownership of any bind mounts
chown -R argon:argon /app 2>/dev/null || true

exec "$@"
