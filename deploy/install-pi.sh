#!/usr/bin/env bash
# One-shot setup for a small Linux board (Raspberry Pi OS, DietPi, Armbian, Ubuntu; arm64 or armhf).
# Run from inside the copied/cloned project folder:  bash deploy/install-pi.sh
# Works as root or as a user with sudo.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUN_USER="$(id -un)"
NODE_BIN="$(command -v node || true)"

if [ -z "$NODE_BIN" ] || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo ">> Installing Node.js 22 (NodeSource)..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
  $SUDO apt-get install -y -qq nodejs
  NODE_BIN="$(command -v node)"
fi
echo ">> Node $(node -v) at $NODE_BIN"

cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund --loglevel=error

if [ ! -f .env ]; then
  cp .env.example .env
  echo ">> Created .env from .env.example. Edit it and add your Brewfather credentials:  nano $APP_DIR/.env"
fi

# systemd unit with the real user and path baked in.
$SUDO tee /etc/systemd/system/brewtoscreen.service >/dev/null <<EOF
[Unit]
Description=brewtoscreen tap list (Brewfather -> Chromecast)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now brewtoscreen >/dev/null
echo
echo ">> brewtoscreen service installed and started."
echo "   status:  systemctl status brewtoscreen"
echo "   logs:    journalctl -u brewtoscreen -f"
echo "   admin:   http://$(hostname -I | awk '{print $1}'):3000/admin.html"
