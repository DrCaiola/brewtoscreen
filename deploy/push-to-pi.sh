#!/usr/bin/env bash
# Ship this project's code to a board and (re)start the service there.
# Usage:  bash deploy/push-to-pi.sh user@host [--with-data]
#         e.g. bash deploy/push-to-pi.sh dietpi@192.168.86.53
#
# Taps and settings on the board are left alone, so updating never undoes what
# was changed on its admin page. Add --with-data only to copy this machine's
# .env, data/taps.json and data/settings.json over the board's, for example
# when moving from a laptop to a board for the first time.
# Needs key-based SSH (run `ssh-copy-id user@host` once first).
set -euo pipefail
TARGET="${1:?usage: push-to-pi.sh user@host [--with-data]}"
cd "$(dirname "$0")/.."

DATA=()
if [ "${2-}" = "--with-data" ]; then
  for f in .env data/taps.json data/settings.json; do [ -f "$f" ] && DATA+=("$f"); done
  echo ">> also copying: ${DATA[*]:-nothing found}"
fi

echo ">> copying files to $TARGET:~/brewtoscreen"
tar --exclude=node_modules --exclude=.git --exclude='.claude' -cz \
  server.js package.json package-lock.json lib public deploy .env.example README.md LICENSE \
  ${DATA[@]+"${DATA[@]}"} \
| ssh "$TARGET" 'mkdir -p ~/brewtoscreen && tar -xz -C ~/brewtoscreen'

echo ">> installing / starting on the board"
ssh "$TARGET" 'cd ~/brewtoscreen && bash deploy/install-pi.sh && S=$([ "$(id -u)" -eq 0 ] || echo sudo); $S systemctl restart brewtoscreen && sleep 3 && $S systemctl is-active brewtoscreen && curl -s localhost:3000/api/health; echo'
