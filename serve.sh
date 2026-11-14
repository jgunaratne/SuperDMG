#!/usr/bin/env bash
# Serves the emulator at http://<host>:8740/
set -euo pipefail
cd "$(dirname "$0")"
export PORT="${PORT:-8740}"
echo "SuperDMG  ->  http://$(hostname -f):${PORT}/   (Ctrl-C to stop)"
exec node server.mjs
