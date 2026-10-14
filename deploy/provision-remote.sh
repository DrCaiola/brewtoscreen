#!/usr/bin/env bash
# Runs ON the board being prepared for someone else. Called by
# deploy/setup-for-someone.sh (terminal) and by the admin page's
# "Set up a board" feature (over SSH). Expects the project already copied
# to ~/brewtoscreen.
#
# Args: WIFI_SSID WIFI_PSK BF_USER_ID BF_API_KEY TITLE HOSTNAME NEW_PASSWORD
# Any argument may be empty.
set -euo pipefail
WIFI_SSID="${1-}"; WIFI_PSK="${2-}"; BF_USER="${3-}"; BF_KEY="${4-}"; TITLE="${5-}"; HOST="${6-}"; NEWPASS="${7-}"
S=$([ "$(id -u)" -eq 0 ] || echo sudo)
cd "$(dirname "$0")/.."

if [ -n "$S" ] && ! sudo -n true 2>/dev/null; then
  echo "!! This login needs a password for sudo. Use the root login instead, or give $(id -un) passwordless sudo." >&2
  exit 2
fi

echo ">> writing .env"
cp .env.example .env
sed -i "s|^BREWFATHER_USER_ID=.*|BREWFATHER_USER_ID=$BF_USER|; s|^BREWFATHER_API_KEY=.*|BREWFATHER_API_KEY=$BF_KEY|; s|^CAST_ON_START=.*|CAST_ON_START=true|" .env
chmod 600 .env

echo ">> starting tap state: '$TITLE', 7 taps"
mkdir -p data
rm -f data/taps.json data/settings.json
printf '{\n  "title": %s,\n  "taps": [],\n  "tapCount": 7,\n  "showAll": true,\n  "custom": []\n}\n' "\"$(printf '%s' "${TITLE:-On Tap}" | sed 's/["\\]/\\&/g')\"" > data/taps.json

if [ -n "$WIFI_SSID" ]; then
  echo ">> adding Wi-Fi network '$WIFI_SSID'"
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

if [ -n "$HOST" ]; then
  echo ">> hostname -> $HOST (http://$HOST.local:3000)"
  $S hostnamectl set-hostname "$HOST" 2>/dev/null || echo "$HOST" | $S tee /etc/hostname >/dev/null
  if grep -q "^127\.0\.1\.1" /etc/hosts; then $S sed -i "s/^127\.0\.1\.1.*/127.0.1.1 $HOST/" /etc/hosts
  else echo "127.0.1.1 $HOST" | $S tee -a /etc/hosts >/dev/null; fi
fi
echo ">> installing avahi (so .local names work)"
$S apt-get install -y -qq avahi-daemon >/dev/null 2>&1 || echo "   (avahi install skipped)"

echo ">> installing Node and the brewtoscreen service"
bash deploy/install-pi.sh

if [ -n "$NEWPASS" ]; then
  echo ">> setting new password for $(id -un)"
  echo "$(id -un):$NEWPASS" | $S chpasswd
fi

$S systemctl restart brewtoscreen
sleep 3
echo ">> health: $(curl -s localhost:3000/api/health)"
echo ">> address here: http://$(hostname -I | awk '{print $1}'):3000/admin.html   hostname: $(hostname)"
echo "DONE"
