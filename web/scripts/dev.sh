#!/usr/bin/env bash
# Infinite Canvas local HMR preview (no production build).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -x node_modules/.bin/vite ]]; then
  echo "missing node_modules/.bin/vite — install deps first (once)" >&2
  exit 1
fi
echo "Infinite Canvas dev → http://127.0.0.1:${VITE_DEV_PORT:-3000}"
exec npm run dev
