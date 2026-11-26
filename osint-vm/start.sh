#!/usr/bin/env bash
# ---------------------------------------------------------------------
# start.sh -- brings up the LinkTrace search backend (SearXNG) and checks
# that it answers. Safe to re-run: docker compose up -d is a no-op if
# the container is already running.
#
#   cd osint-vm && ./start.sh
# ---------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "==> Starting SearXNG search backend..."
docker compose up -d

echo "==> Checking search backend..."
for i in 1 2 3 4 5; do
  if curl -fsS "http://127.0.0.1:8888/search?q=ping&format=json" >/dev/null 2>&1; then
    echo "    search backend is up (http://127.0.0.1:8888)"
    break
  fi
  if [ "$i" -eq 5 ]; then
    echo "    search backend didn't answer yet -- it may still be starting. Check: docker compose logs -f searxng"
  else
    sleep 2
  fi
done

echo "==> Starting LinkTrace helper (page previews + image extraction)..."
if [ -x ".venv/bin/python" ]; then
  PY="$(pwd)/.venv/bin/python"          # virtualenv created for Holehe (see README)
else
  PY="$(command -v python3 || command -v python || true)"
fi
if [ -z "$PY" ]; then
  echo "    Python 3 not found -- skipping the helper. Previews fall back to plain iframes."
else
  if [ -f .helper.pid ] && kill -0 "$(cat .helper.pid)" 2>/dev/null; then
    echo "    helper already running (pid $(cat .helper.pid))"
  else
    nohup "$PY" linktrace_helper.py > .helper.log 2>&1 &
    echo $! > .helper.pid
    sleep 1
    if curl -fsS "http://127.0.0.1:8899/api/health" >/dev/null 2>&1; then
      echo "    helper is up (http://127.0.0.1:8899)"
    else
      echo "    helper didn't answer -- see osint-vm/.helper.log"
    fi
  fi
fi

if [ -n "${PY:-}" ]; then
  MISSING=""
  for m in holehe ignorant maigret; do "$PY" -c "import $m" >/dev/null 2>&1 || MISSING="$MISSING $m"; done
  if [ -n "$MISSING" ]; then
    echo "==> Optional account checks not installed:$MISSING"
    echo "      python3 -m venv .venv && .venv/bin/pip install -r requirements-accounts.txt   (then ./stop.sh && ./start.sh)"
  fi
fi

echo ""
echo "Done. Open LinkTrace (index.html) -- Live results should work now."
echo "Stop it later with: ./stop.sh"
