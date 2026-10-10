#!/usr/bin/env bash
# One-shot setup for a Raspberry Pi / Orange Pi (Debian, Ubuntu or Armbian, arm64).
# Run from inside the cloned repo:  bash deploy/install-pi.sh
set -euo pipefail

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Installing Node.js 22 (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

cd "$(dirname "$0")/.."
npm install --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo ">>> Edit .env and add your Brewfather credentials:  nano .env"
fi

# systemd unit, templated on the current user so paths line up.
sudo cp deploy/brewtoscreen.service /etc/systemd/system/brewtoscreen@.service
sudo systemctl daemon-reload
sudo systemctl enable --now "brewtoscreen@$USER"

echo
echo "brewtoscreen is running. Useful commands:"
echo "  sudo systemctl status brewtoscreen@$USER"
echo "  sudo journalctl -u brewtoscreen@$USER -f"
echo "  Admin page: http://$(hostname -I | awk '{print $1}'):3000/admin.html"
