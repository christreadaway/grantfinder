#!/usr/bin/env bash
# Cross-origin browser test of the production build, the way Netlify + Railway run it.
# Starts the backend (same command as the Procfile / Railway start command) and the
# frontend production build on different origins, then drives a real browser through
# four states: guest sign-in on, backend restarted, guest sign-in off, backend down.
#
# One-time setup (Mac):
#   cd ~/grantfinder/backend && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
#   cd ~/grantfinder/frontend && sfw npm install          (or: npm install)
#   cd ~/grantfinder/tests/e2e && sfw npm install && npx playwright install chromium
# Run:
#   cd ~/grantfinder && bash tests/e2e/run_e2e.sh
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
E2E="$REPO/tests/e2e"
VENV="${VENV:-$REPO/backend/.venv}"
WORK="${E2E_WORK_DIR:-$(mktemp -d)}"
STATE="$WORK/state.json"
TOTAL=0
mkdir -p "$WORK/home"

port_pids() { lsof -ti "tcp:$1" 2>/dev/null; }
free_port() { for i in $(seq 1 40); do [ -z "$(port_pids "$1")" ] && return 0; sleep 0.5; done; port_pids "$1" | xargs kill -9 2>/dev/null; sleep 1; }

start_backend() {  # $1 = ALLOW_GUEST_LOGIN value
  pushd "$REPO/backend" >/dev/null
  HOME="$WORK/home" PORT=8000 SECRET_KEY=e2e-secret-0123456789abcdef0123456789abcdef ALLOW_GUEST_LOGIN="$1" \
    FORWARDED_ALLOW_IPS="*" "$VENV/bin/python" -m uvicorn main:app --host 0.0.0.0 --port 8000 >> "$WORK/backend.log" 2>&1 &
  echo $! > "$WORK/backend.pid"
  popd >/dev/null
  for i in $(seq 1 40); do curl -sf http://localhost:8000/api/health >/dev/null && return 0; sleep 0.5; done
  echo "backend failed to start"; tail -20 "$WORK/backend.log"; return 1
}
stop_backend() { kill "$(cat "$WORK/backend.pid")" 2>/dev/null; free_port 8000; }
run_phase() { NODE_PATH="$E2E/node_modules:${NODE_PATH:-}" node "$E2E/e2e.cjs" "$1" "$STATE"; TOTAL=$((TOTAL + $?)); }

free_port 8000; free_port 3000
echo "== production build (NEXT_PUBLIC_API_URL=http://localhost:8000)"
(cd "$REPO/frontend" && NEXT_PUBLIC_API_URL=http://localhost:8000 npx next build > "$WORK/build.log" 2>&1) || { echo "build failed"; tail -20 "$WORK/build.log"; exit 1; }
pushd "$REPO/frontend" >/dev/null
./node_modules/.bin/next start -p 3000 -H 127.0.0.1 > "$WORK/frontend.log" 2>&1 &
echo $! > "$WORK/frontend.pid"
popd >/dev/null
for i in $(seq 1 40); do curl -sf http://127.0.0.1:3000/ >/dev/null && break; sleep 0.5; done

start_backend true || exit 1
echo "== CORS preflight from the frontend origin"
curl -s -o /dev/null -D - -X OPTIONS http://localhost:8000/api/auth/guest \
  -H "Origin: http://127.0.0.1:3000" -H "Access-Control-Request-Method: POST" | grep -i "access-control-allow-origin" || { echo "FAIL CORS preflight"; TOTAL=$((TOTAL + 1)); }

echo "== phase guest (guest sign-in on)";                         run_phase guest
echo "== phase expired (backend restarted)"; stop_backend; start_backend true  && run_phase expired
echo "== phase locked (guest sign-in off)";   stop_backend; start_backend false && run_phase locked
echo "== phase down (backend stopped)";       stop_backend; run_phase down

kill "$(cat "$WORK/frontend.pid")" 2>/dev/null; free_port 3000
echo "Logs: $WORK (backend.log, frontend.log, build.log, home/logs/grantfinder/grantfinder.log)"
echo "TOTAL FAILED PHASES: $TOTAL"
exit $TOTAL
