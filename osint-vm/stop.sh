#!/usr/bin/env bash
# ---------------------------------------------------------------------
# stop.sh -- stops the SearXNG search backend started by start.sh.
# ---------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "==> Stopping search backend..."
docker compose down

if [ -f .helper.pid ]; then
  echo "==> Stopping LinkTrace helper..."
  kill "$(cat .helper.pid)" 2>/dev/null || true
  rm -f .helper.pid
fi

echo ""
echo "Done. Everything from start.sh is stopped."
