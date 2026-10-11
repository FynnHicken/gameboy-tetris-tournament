#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

# Find Node.js binary (system node or Antigravity bundled Node runtime)
if command -v node >/dev/null 2>&1; then
  NODE_CMD="node"
elif [ -x "/Applications/Antigravity.app/Contents/MacOS/Antigravity" ]; then
  export ELECTRON_RUN_AS_NODE=1
  NODE_CMD="/Applications/Antigravity.app/Contents/MacOS/Antigravity"
else
  echo "❌ Node.js wurde nicht gefunden."
  exit 1
fi

echo "🚀 Starte Game Boy Tetris-Turnier Server auf Port ${PORT}..."
exec "$NODE_CMD" server.js
