#!/usr/bin/env bash
# Sync this project to the board and (re)start the service there.
# Usage:  bash deploy/push-to-pi.sh user@host        e.g. dietpi@192.168.86.53
# Needs key-based SSH (run `ssh-copy-id user@host` once first).
set -euo pipefail
TARGET="${1:?usage: push-to-pi.sh user@host}"
cd "$(dirname "$0")/.."

echo ">> copying files to $TARGET:~/brewtoscreen"
tar --exclude=node_modules --exclude=.git --exclude='.claude' -cz \
  server.js package.json package-lock.json lib public deploy .env.example README.md \
  $( [ -f .env ] && echo .env ) \
  $( [ -f data/taps.json ] && echo data/taps.json ) \
| ssh "$TARGET" 'mkdir -p ~/brewtoscreen && tar -xz -C ~/brewtoscreen'

echo ">> installing / starting on the board"
ssh "$TARGET" 'cd ~/brewtoscreen && bash deploy/install-pi.sh && SUDO=$([ "$(id -u)" -eq 0 ] || echo sudo) && $SUDO systemctl restart brewtoscreen && sleep 3 && systemctl is-active brewtoscreen && curl -s localhost:3000/api/health'
