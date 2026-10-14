#!/usr/bin/env bash
# Terminal version of the admin page's "Set up a board for someone".
# Prepares a board so that at somebody else's house it is plug-and-play:
# joins their Wi-Fi, installs itself, casts to their Chromecast, and shows
# the admin address on the TV.
#
# Do this at YOUR house with the board on YOUR Wi-Fi and key-based SSH working:
#   bash deploy/setup-for-someone.sh dietpi@192.168.1.50
set -euo pipefail
TARGET="${1:?usage: setup-for-someone.sh user@board-ip}"
cd "$(dirname "$0")/.."

ask() { local v; read -r -p "$1: " v; echo "$v"; }
asksecret() { local v; read -r -s -p "$1: " v; echo >&2; echo "$v"; }

echo "Their Wi-Fi (the board will join it when it boots at their place):"
WIFI_SSID="$(ask "  Wi-Fi name (SSID)")"
WIFI_PSK="$( [ -n "$WIFI_SSID" ] && asksecret "  Wi-Fi password" || echo "")"
echo
echo "Their Brewfather API credentials (Settings -> API -> Generate, 'Read Batches')."
echo "  Leave blank to let them enter it on the admin page themselves."
BF_USER="$(ask "  User ID")"
BF_KEY="$( [ -n "$BF_USER" ] && asksecret "  API key" || echo "")"
echo
TITLE="$(ask "Board title (e.g. 'Dad's Taps')")"
HOSTNAME_="$(ask "Board hostname (letters/digits, e.g. taps -> http://taps.local:3000) [taps]")"
HOSTNAME_="${HOSTNAME_:-taps}"
NEWPASS="$(asksecret "New password for the '${TARGET%@*}' login on the board (blank = keep current)")"

echo
echo ">> copying files to $TARGET:~/brewtoscreen"
tar --exclude=node_modules --exclude=.git --exclude='.claude' -cz \
  server.js package.json package-lock.json lib public deploy .env.example README.md LICENSE \
| ssh "$TARGET" 'mkdir -p ~/brewtoscreen && tar -xz -C ~/brewtoscreen'

echo ">> configuring the board"
ssh "$TARGET" "cd ~/brewtoscreen && bash deploy/provision-remote.sh $(printf '%q ' "$WIFI_SSID" "$WIFI_PSK" "$BF_USER" "$BF_KEY" "$TITLE" "$HOSTNAME_" "$NEWPASS")"

echo
echo "Done. Hand over the board with this note:"
echo "  1. Plug it into power near the TV (no cables to the TV needed). Wait about a minute."
echo "  2. The tap list appears on the Chromecast on its own."
echo "  3. To choose beers, open the address shown at the bottom of the TV screen"
echo "     (also http://${HOSTNAME_}.local:3000/admin.html) on a phone on the same Wi-Fi."
[ -z "$BF_USER" ] && echo "     The admin page will first ask for their Brewfather User ID and API key."
echo "  If the TV does not come on by itself: open the admin page, Scan, and press Cast."
