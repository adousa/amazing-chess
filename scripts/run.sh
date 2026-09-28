#!/usr/bin/env bash
# Start the backend (API on :8000) and the frontend (app on :5173) together.
# Ctrl-C stops both.
#
#   scripts/run.sh
#   AC_ENGINE_OPTIONS='{"Threads":1}' scripts/run.sh     # override engine options
#   BACKEND_PORT=8001 scripts/run.sh                      # other backend port (frontend proxy stays on 8000)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT=5173
# Competition setup: 3 search threads (allowed by the organisers), Contempt 60 (draws score nothing).
DEFAULT_ENGINE_OPTIONS='{"Threads":3,"Hash":128,"Contempt":60}'
export AC_ENGINE_OPTIONS="${AC_ENGINE_OPTIONS:-$DEFAULT_ENGINE_OPTIONS}"

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

for p in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if port_busy "$p"; then
    echo "Port $p is already in use:" >&2
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >&2
    echo "Stop that process first (kill <PID>), then run this script again." >&2
    exit 1
  fi
done

if [ ! -x .venv/bin/python ]; then
  echo "Missing .venv — set up the backend first (see backend/README.md)." >&2
  exit 1
fi
if [ ! -x engine/target/release/amazing-chess ] && [ -z "${AC_ENGINE_PATH:-}" ]; then
  echo "Building the engine (first run)…"
  (cd engine && cargo build --release)
fi
if [ ! -d frontend/node_modules ] || [ frontend/package.json -nt frontend/node_modules ]; then
  echo "Installing frontend dependencies…"
  (cd frontend && npm install)
fi

pids=()
cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Stopping backend and frontend…"
  # Stop everything this script started (servers and their log pipes), not just the pipe ends.
  pkill -TERM -P $$ 2>/dev/null || true
  pkill -TERM -f "amazing serve --port $BACKEND_PORT" 2>/dev/null || true
  pkill -TERM -f "vite.*--port $FRONTEND_PORT" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "Backend  → http://localhost:$BACKEND_PORT/api   (engine options: $AC_ENGINE_OPTIONS)"
.venv/bin/python -m amazing serve --port "$BACKEND_PORT" 2>&1 | sed -u 's/^/[backend]  /' &
pids+=($!)

echo "Frontend → http://localhost:$FRONTEND_PORT"
(cd frontend && npm run dev -- --port "$FRONTEND_PORT" --strictPort) 2>&1 | sed -u 's/^/[frontend] /' &
pids+=($!)

# Exit (and stop the other one) as soon as either process dies.
while true; do
  for pid in "${pids[@]}"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "A process exited — shutting down." >&2
      exit 1
    fi
  done
  sleep 2
done
