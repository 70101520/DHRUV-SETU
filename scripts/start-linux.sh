#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi
: "${PORT:=8080}"
export PORT
exec node server.mjs
