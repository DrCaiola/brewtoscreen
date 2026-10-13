#!/usr/bin/env bash
# Prepare a board for somebody else (a friend, your dad) so that at their
# house it is plug-and-play: it joins their Wi-Fi, installs itself, casts to
# their Chromecast, and shows them the admin address on the TV.
#
# Do this at YOUR house with the board on YOUR Wi-Fi and key-based SSH working:
#   bash deploy/setup-for-someone.sh dietpi@192.168.1.50
# It asks a few questions, then does everything over SSH.
set -euo pipefail
TARGET="${1:?usage: setup-for-someone.sh user@board-ip}"
cd "$(dirname "$0")/.."

ask() { local v; read -r -p "$1: " v; echo "$v"; }
asksecret() { local v; read -r -s -p "$1: " v; echo >&2; echo "$v"; }

echo "Their Wi-Fi (the board will join it when it boots at their place):"
WIFI_SSID="$(ask "  Wi-Fi name (SSID)")"
WIFI_PSK="$(asksecret "  Wi-Fi password")"
echo
echo "Their Brewfather API credentials (Settings -> API -> Generate, 'Read Batches'):"
echo "  Leave blank to let them enter it themselves on the admin page later."
BF_USER="$(ask "  User ID")"
BF_KEY="$( [ -n "$BF_USER" ] && asksecret "  API key" || echo "")"
echo
TITLE="$(ask "Board title (e.g. 'Dad's Taps')")"
HOSTNAME_="$(ask "Board hostname (letters/digits only, e.g. taps; they can open http://taps.local:3000)")"
HOSTNAME_="${HOSTNAME_:-taps}"
NEWPASS="$(asksecret "New password for the '${TARGET%@*}' login on the board (blank = keep current)")"

echo
echo ">> copying files to $TARGET:~/brewtoscreen"
tar --exclude=node_modules --exclude=.git --exclude='.claude' -cz \
  server.js package.json package-lock.json lib public deploy .env.example README.md LICENSE \
| ssh "$TARGET" 'mkdir -p ~/brewtoscreen && rm -f ~/brewtoscreen/data/taps.json ~/brewtoscreen/data/settings.json && tar -xz -C ~/brewtoscreen'

echo ">> configuring the board"
ssh "$TARGET" bash -s -- "$WIFI_SSID" "$WIFI_PSK" "$BF_USER" "$BF_KEY" "$TITLE" "$HOSTNAME_" "$NEWPASS" <<'REMOTE'
set -euo pipefail
WIFI_SSID="$1"; WIFI_PSK="$2"; BF_USER="$3"; BF_KEY="$4"; TITLE="$5"; HOST="$6"; NEWPASS="$7"
S=$([ "$(id -u)" -eq 0 ] || echo sudo)
cd ~/brewtoscreen

# .env: credentials (if given) and cast-on-start.
cp .env.example .env
sed -i "s/^BREWFATHER_USER_ID=.*/BREWFATHER_USER_ID=$BF_USER/; s/^BREWFATHER_API_KEY=.*/BREWFATHER_API_KEY=$BF_KEY/; s/^CAST_ON_START=.*/CAST_ON_START=true/" .env
chmod 600 .env

# Starting tap state: their title, 7 taps, nothing assigned yet.
mkdir -p data
node -e '
const fs=require("fs");
fs.writeFileSync("data/taps.json", JSON.stringify({ title: process.argv[1] || "On Tap", taps: [], tapCount: 7, showAll: true, custom: [] }, null, 2));
' "$TITLE"

# Their Wi-Fi as an extra network; the board keeps yours too, so you can test here.
if [ -n "$WIFI_SSID" ]; then
  $S tee -a /etc/wpa_supplicant/wpa_supplicant.conf >/dev/null <<EOF

network={
	ssid="$WIFI_SSID"
	scan_ssid=1
	key_mgmt=WPA-PSK
	psk="$WIFI_PSK"
	priority=10
}
EOF
fi

# Hostname, so http://<host>.local:3000 works from iPhones, Macs and most laptops.
if [ -n "$HOST" ]; then
  $S hostnamectl set-hostname "$HOST" 2>/dev/null || echo "$HOST" | $S tee /etc/hostname >/dev/null
  $S sed -i "s/127\.0\.1\.1.*/127.0.1.1 $HOST/" /etc/hosts
  grep -q "127.0.1.1" /etc/hosts || echo "127.0.1.1 $HOST" | $S tee -a /etc/hosts >/dev/null
fi
$S apt-get install -y -qq avahi-daemon >/dev/null 2>&1 || true

# Install Node + the service.
bash deploy/install-pi.sh

if [ -n "$NEWPASS" ]; then
  echo "$(id -un):$NEWPASS" | $S chpasswd
fi

$S systemctl restart brewtoscreen
sleep 3
curl -s localhost:3000/api/health; echo
echo "IP here: $(hostname -I | awk '{print $1}')   hostname: $(hostname)"
REMOTE

echo
echo "Done. Hand over the board with this note:"
echo "  1. Plug it into power near the TV (no cables to the TV needed). Wait about a minute."
echo "  2. The tap list appears on the Chromecast on its own."
echo "  3. To choose beers, open the address shown at the bottom of the TV screen"
echo "     (also http://${HOSTNAME_}.local:3000/admin.html) on a phone on the same Wi-Fi."
[ -z "$BF_USER" ] && echo "     The admin page will first ask for their Brewfather User ID and API key."
echo "  If the TV does not come on by itself: open the admin page, Scan, and press Cast."
