#!/usr/bin/env bash
# ===========================================================================
#  VS Room Control - server launcher (Linux equivalent of Start-VSServer.bat)
#
#  Run it by hand:      ./start-vsserver.sh
#  Run it at boot:      sudo ./install-linux.sh server
#
#  When systemd runs this, stdout/stderr go to the journal:
#      journalctl -u vs-server -f
# ===========================================================================
set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")"

echo
echo "  VS Room Control"
echo "  ---------------"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed (or not on PATH)."
  echo "  Ubuntu:  sudo apt install -y nodejs npm"
  echo "  Better:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  Node $(node -v) is too old - this needs Node 18 or newer."
  exit 1
fi

if [ ! -f config.json ]; then
  echo "  No config.json found. Creating one from config.example.json..."
  cp config.example.json config.json
  echo "  Created config.json - open it and set your room IDs, light and"
  echo "  Wall Player addresses before running a real game."
  echo
fi

if [ ! -d node_modules ]; then
  echo "  Installing dependencies (one time)..."
  npm install --no-audit --no-fund
  echo
fi

# exec so signals (systemd's SIGTERM on stop/restart) reach node directly -
# the server restores both rooms on the way out, and it can only do that if
# it actually receives the signal.
exec node server/vs-server.js
