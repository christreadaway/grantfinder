#!/usr/bin/env bash
# GrantFinder end-to-end test.
#
# Builds the real site for production (the website and the engine are one
# Next.js app, exactly what Netlify runs), starts it with a mock Claude and a
# fake parish website, and drives a real browser through the whole journey:
# sign-in, API key, grant database, website scan, questions, documents,
# matching, exports, the full application writer for the Kenedy grant. Then it
# restarts the server and checks everything was saved, turns guest sign-in off,
# and simulates the engine being down.
#
# No real Claude API key and no internet needed. Nothing is sent anywhere.
#
# ONE-TIME SETUP (Mac or Linux) - paste these lines one at a time:
#   cd ~/grantfinder/frontend && (sfw npm install || npm install)
#   cd ~/grantfinder/tests/e2e && (sfw npm install || npm install)
#   cd ~/grantfinder/tests/e2e && npx playwright install chromium
#   (skip the last line if Playwright's Chromium is already installed)
#
# RUN (about 5-10 minutes, including the production build):
#   cd ~/grantfinder && bash tests/e2e/run_e2e.sh
#
# Exit code 0 means every check passed. Screenshots of failures, downloaded
# exports, and server logs are in tests/e2e/artifacts/.
#
# Options (put them in front of the command):
#   E2E_SKIP_BUILD=1          reuse the last build in frontend/.next (faster re-runs)
#   E2E_PHASES="journey"      run only some phases (journey basics errors expired persist locked down)
#   E2E_HEADED=1              show the browser while it runs
#   E2E_KEEP=1                keep the temporary data folder for inspection
#   E2E_NO_LATENCY=1          let the mock Claude answer instantly (no realistic delay)
#   E2E_JOB_MODE=direct       run AI steps the way Netlify does by default (inside each
#                             request, no background functions) instead of in-process
#   E2E_APP_PORT=3199 E2E_MOCK_PORT=4999 E2E_SITE_PORT=4998 E2E_PROXY_PORT=4996
#                             preferred ports (a busy port moves to the next free one)
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
E2E="$REPO/tests/e2e"
FRONTEND="$REPO/frontend"
ART="$E2E/artifacts"
LOGS="$ART/logs"
STATE="$ART/state.json"

PIDFILE="$ART/.pids"
APP_PORT="${E2E_APP_PORT:-3199}"
MOCK_PORT="${E2E_MOCK_PORT:-4999}"
SITE_PORT="${E2E_SITE_PORT:-4998}"
PROXY_PORT="${E2E_PROXY_PORT:-4996}"
E2E_SECRET="e2e-secret-key-0123456789-abcdefghijklmnopqrstuvwxyz"
PHASES="${E2E_PHASES:-journey basics errors expired persist locked down}"

APP_PID=""; MOCK_PID=""; SITE_PID=""; PROXY_PID=""
CLAUDE_URL="http://127.0.0.1:$MOCK_PORT"; PROXY_URL=""
DATA_DIR=""
HARNESS_PASS=0; HARNESS_FAIL=0
SUMMARY_LINES=""
TOTAL_PASS=0; TOTAL_FAIL=0; TOTAL_SKIP=0; CRASHED_PHASES=""

say() { printf '%s\n' "$*"; }
want() { case " $PHASES " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

harness_check() { # name ok(0/1) [detail]
  if [ "$2" = "0" ]; then
    HARNESS_PASS=$((HARNESS_PASS + 1)); say "PASS [harness] $1"
  else
    HARNESS_FAIL=$((HARNESS_FAIL + 1)); say "FAIL [harness] $1${3:+ :: $3}"
  fi
}

# ---------------------------------------------------------------------------
# Preflight: tools and installs
# ---------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || { say "Node.js is not installed. Install it from https://nodejs.org (LTS), then re-run."; exit 1; }
command -v curl >/dev/null 2>&1 || { say "curl is missing (it comes with every Mac). Install curl and re-run."; exit 1; }
NEXT_BIN="$FRONTEND/node_modules/next/dist/bin/next"
if [ ! -f "$NEXT_BIN" ]; then
  say "The website's packages are not installed. Run this once, then re-run the test:"
  say "  cd ~/grantfinder/frontend && (sfw npm install || npm install)"
  exit 1
fi
if [ ! -d "$E2E/node_modules/playwright" ]; then
  say "The browser test's packages are not installed. Run these once, then re-run the test:"
  say "  cd ~/grantfinder/tests/e2e && (sfw npm install || npm install)"
  say "  cd ~/grantfinder/tests/e2e && npx playwright install chromium"
  exit 1
fi

# A port is busy when something accepts a connection on it. curl exit code 7 means
# "could not connect" (port free); anything else means something is listening.
# Works the same on Mac and Linux, including for processes lsof can't describe.
port_busy() {
  curl --noproxy '*' -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/"
  [ $? -ne 7 ]
}

# The preferred port, or the next free one. Never stops someone else's program.
pick_port() { # preferred, ports-already-taken...
  local port="$1" taken
  shift
  taken=" $* "
  while port_busy "$port" || case "$taken" in *" $port "*) true ;; *) false ;; esac; do
    port=$((port + 1))
  done
  printf '%s' "$port"
}

wait_port_free() { # port seconds
  local i
  for i in $(seq 1 $(($2 * 4))); do port_busy "$1" || return 0; sleep 0.25; done
  return 1
}

# Processes a previous run left behind (only ones this script started, recorded
# with their PID; the PID must still be running what we started). Stopped by PID,
# never by name pattern.
stop_leftovers() {
  local pid port name args
  [ -f "$PIDFILE" ] || return 0
  while read -r pid port name; do
    [ -n "$pid" ] || continue
    kill -0 "$pid" 2>/dev/null || continue
    args="$(ps -o args= -p "$pid" 2>/dev/null)"
    case "$name:$args" in
      mock-claude:*mock-claude/server.mjs*|fake-site:*fake-site.cjs*|latency-proxy:*latency-proxy.cjs*|grantfinder-app:*next-server*|grantfinder-app:*next*start*)
        say "   stopping $name left over from an earlier run (pid $pid, port $port)"
        stop_pid "$pid" ;;
    esac
  done < "$PIDFILE"
}

remember_pid() { printf '%s %s %s\n' "$1" "$2" "$3" >> "$PIDFILE"; }

stop_pid() {
  local pid="$1" i
  [ -z "$pid" ] && return 0
  kill "$pid" 2>/dev/null || return 0
  for i in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null
  return 0
}

# wait_http URL NAME SECONDS PID LOGFILE
wait_http() {
  local url="$1" name="$2" seconds="$3" pid="$4" log="$5" i
  for i in $(seq 1 $((seconds * 4))); do
    if curl --noproxy '*' -sf -o /dev/null "$url"; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      say "$name exited while starting. Last lines of $log:"; tail -25 "$log"; return 1
    fi
    sleep 0.25
  done
  say "$name did not answer at $url within ${seconds}s. Last lines of $log:"; tail -25 "$log"; return 1
}

cleanup() {
  stop_pid "$APP_PID"; stop_pid "$PROXY_PID"; stop_pid "$MOCK_PID"; stop_pid "$SITE_PID"
  if [ -n "$DATA_DIR" ] && [ -d "$DATA_DIR" ]; then
    if [ "${E2E_KEEP:-0}" = "1" ]; then say "Data folder kept: $DATA_DIR"; else rm -rf "$DATA_DIR"; fi
  fi
}
trap cleanup EXIT
trap 'say "Interrupted."; exit 130' INT TERM HUP

# ---------------------------------------------------------------------------
# Fresh artifacts, free ports, temporary data folder
# ---------------------------------------------------------------------------
stop_leftovers
rm -rf "$ART"
mkdir -p "$LOGS"
APP_PORT="$(pick_port "$APP_PORT")"
MOCK_PORT="$(pick_port "$MOCK_PORT" "$APP_PORT")"
SITE_PORT="$(pick_port "$SITE_PORT" "$APP_PORT" "$MOCK_PORT")"
PROXY_PORT="$(pick_port "$PROXY_PORT" "$APP_PORT" "$MOCK_PORT" "$SITE_PORT")"
say "== Ports: app $APP_PORT, mock Claude $MOCK_PORT, fake website $SITE_PORT, latency proxy $PROXY_PORT"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/grantfinder-e2e-data.XXXXXX")"

# ---------------------------------------------------------------------------
# Build (production, the way Netlify builds it, minus Netlify itself)
# ---------------------------------------------------------------------------
if [ "${E2E_SKIP_BUILD:-0}" = "1" ] && [ -f "$FRONTEND/.next/BUILD_ID" ]; then
  say "== Reusing the existing production build (E2E_SKIP_BUILD=1)"
else
  say "== Building the site for production (1-3 minutes; log: tests/e2e/artifacts/logs/build.log)"
  if ! ( cd "$FRONTEND" && env -u NETLIFY NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_GOOGLE_CLIENT_ID= node "$NEXT_BIN" build ) > "$LOGS/build.log" 2>&1; then
    say "BUILD FAILED. Last lines of the build log:"
    tail -40 "$LOGS/build.log"
    say "If another change is still in progress (type errors), wait a few minutes and run the test again."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Helpers: mock Claude, latency proxy, fake parish website, the app
# ---------------------------------------------------------------------------
start_helpers() {
  node "$REPO/tests/mock-claude/server.mjs" --port "$MOCK_PORT" >> "$LOGS/mock-claude.log" 2>&1 &
  MOCK_PID=$!; remember_pid "$MOCK_PID" "$MOCK_PORT" mock-claude
  wait_http "http://127.0.0.1:$MOCK_PORT/__requests" "Mock Claude" 20 "$MOCK_PID" "$LOGS/mock-claude.log" || return 1
  node "$E2E/fake-site.cjs" --port "$SITE_PORT" >> "$LOGS/fake-site.log" 2>&1 &
  SITE_PID=$!; remember_pid "$SITE_PID" "$SITE_PORT" fake-site
  wait_http "http://127.0.0.1:$SITE_PORT/__hits" "Fake parish website" 20 "$SITE_PID" "$LOGS/fake-site.log" || return 1
  if [ "${E2E_NO_LATENCY:-0}" = "1" ]; then
    CLAUDE_URL="http://127.0.0.1:$MOCK_PORT"; PROXY_URL=""
  else
    node "$E2E/latency-proxy.cjs" --port "$PROXY_PORT" --target "http://127.0.0.1:$MOCK_PORT" >> "$LOGS/latency-proxy.log" 2>&1 &
    PROXY_PID=$!; remember_pid "$PROXY_PID" "$PROXY_PORT" latency-proxy
    wait_http "http://127.0.0.1:$PROXY_PORT/__latency" "Latency proxy" 20 "$PROXY_PID" "$LOGS/latency-proxy.log" || return 1
    CLAUDE_URL="http://127.0.0.1:$PROXY_PORT"; PROXY_URL="http://127.0.0.1:$PROXY_PORT"
  fi
}

# start_app GUEST_VALUE   ("true" = guest sign-in on, "" = off)
start_app() {
  if port_busy "$APP_PORT"; then say "Port $APP_PORT was taken by another program; stopping."; return 1; fi
  say "   starting the app on http://127.0.0.1:$APP_PORT (ALLOW_GUEST_LOGIN='$1')"
  echo "===== start $(date) ALLOW_GUEST_LOGIN='$1' =====" >> "$LOGS/app.log"
  # Every setting is passed explicitly (empty = off) so a frontend/.env.local can't change the test.
  ( cd "$FRONTEND" && exec env -u NETLIFY \
      NEXT_TELEMETRY_DISABLED=1 \
      ALLOW_GUEST_LOGIN="$1" GOOGLE_CLIENT_ID= NEXT_PUBLIC_GOOGLE_CLIENT_ID= \
      GRANTFINDER_TEST_MODE=1 GRANTFINDER_ALLOW_LOCAL_FETCH=1 \
      GRANTFINDER_CLAUDE_BASE_URL="$CLAUDE_URL" CLAUDE_MODEL=claude-sonnet-5 \
      ANTHROPIC_BASE_URL=http://127.0.0.1:9/netlify-ai-gateway-decoy ANTHROPIC_AUTH_TOKEN=netlify-ai-gateway-decoy \
      GRANTFINDER_DATA_DIR="$DATA_DIR" GRANTFINDER_STORE=fs GRANTFINDER_FILE_LOGS=0 \
      GRANTFINDER_JOB_MODE="${E2E_JOB_MODE:-}" \
      SECRET_KEY="$E2E_SECRET" LOG_LEVEL=info \
      node "$NEXT_BIN" start -p "$APP_PORT" -H 127.0.0.1 ) >> "$LOGS/app.log" 2>&1 &
  APP_PID=$!; remember_pid "$APP_PID" "$APP_PORT" grantfinder-app
  wait_http "http://127.0.0.1:$APP_PORT/api/health" "The GrantFinder app" 90 "$APP_PID" "$LOGS/app.log"
}

stop_app() {
  stop_pid "$APP_PID"; APP_PID=""
  wait_port_free "$APP_PORT" 15 || { say "Port $APP_PORT is still busy after stopping the app."; exit 1; }
}

run_phase() {
  local phase="$1" code line pass fail skip
  say ""
  say "================ phase: $phase ================"
  E2E_BASE_URL="http://127.0.0.1:$APP_PORT" E2E_MOCK_URL="http://127.0.0.1:$MOCK_PORT" E2E_PROXY_URL="$PROXY_URL" \
  E2E_SITE_URL="http://127.0.0.1:$SITE_PORT" E2E_ARTIFACTS="$ART" E2E_SECRET_KEY="$E2E_SECRET" \
  NODE_PATH="$E2E/node_modules${NODE_PATH:+:$NODE_PATH}" \
    node "$E2E/e2e.cjs" "$phase" "$STATE" 2>&1 | tee "$LOGS/phase-$phase.log"
  code=${PIPESTATUS[0]}
  line="$(grep -E '^SUMMARY phase=' "$LOGS/phase-$phase.log" | tail -1)"
  if [ -z "$line" ]; then
    CRASHED_PHASES="$CRASHED_PHASES $phase"
    SUMMARY_LINES="$SUMMARY_LINES
  $(printf '%-9s' "$phase") CRASHED (exit $code) - see tests/e2e/artifacts/logs/phase-$phase.log"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    return
  fi
  pass="$(printf '%s' "$line" | sed -E 's/.*pass=([0-9]+).*/\1/')"
  fail="$(printf '%s' "$line" | sed -E 's/.*fail=([0-9]+).*/\1/')"
  skip="$(printf '%s' "$line" | sed -E 's/.*skip=([0-9]+).*/\1/')"
  TOTAL_PASS=$((TOTAL_PASS + pass)); TOTAL_FAIL=$((TOTAL_FAIL + fail)); TOTAL_SKIP=$((TOTAL_SKIP + skip))
  SUMMARY_LINES="$SUMMARY_LINES
  $(printf '%-9s pass %4s   fail %3s   skip %3s' "$phase" "$pass" "$fail" "$skip")"
}

app_alive_check() {
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then harness_check "app still running after: $1" 0
  else harness_check "app still running after: $1" 1 "the server process exited; see tests/e2e/artifacts/logs/app.log"; fi
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
say "== Starting mock Claude (:$MOCK_PORT), fake parish website (:$SITE_PORT)$([ "${E2E_NO_LATENCY:-0}" = "1" ] || printf ', latency proxy (:%s)' "$PROXY_PORT")"
start_helpers || exit 1

say "== Starting the app with guest sign-in ON"
start_app true || exit 1
health="$(curl --noproxy '*' -s "http://127.0.0.1:$APP_PORT/api/health")"
say "   health: $health"
case "$health" in *'"store":"fs"'*'"runtime":"local"'*|*'"runtime":"local"'*'"store":"fs"'*) harness_check "health: local runtime, file storage" 0 ;; *) harness_check "health: local runtime, file storage" 1 "$health" ;; esac

for phase in journey basics errors expired; do
  if want "$phase"; then run_phase "$phase"; app_alive_check "$phase"; fi
done

if want journey; then
  say ""
  say "================ harness checks: storage and secrets ================"
  for dir in users apikeys grants profiles matches applications writer jobs; do
    if [ -d "$DATA_DIR/store/$dir" ]; then harness_check "data folder has $dir/" 0; else harness_check "data folder has $dir/" 1 "missing $DATA_DIR/store/$dir"; fi
  done
  leaked="$(grep -rl 'sk-ant-test-e2e' "$DATA_DIR" 2>/dev/null | head -3)"
  if [ -z "$leaked" ]; then harness_check "saved API keys are encrypted (no plain key in the data folder)" 0
  else harness_check "saved API keys are encrypted (no plain key in the data folder)" 1 "$leaked"; fi
  if grep -qE 'sk-ant-[A-Za-z0-9_]' "$LOGS/app.log"; then harness_check "server log never contains an API key" 1 "$(grep -m1 -oE '.{0,60}sk-ant-[A-Za-z0-9_].{0,10}' "$LOGS/app.log")"
  else harness_check "server log never contains an API key" 0; fi
fi

if want persist; then
  say ""
  say "== Restarting the app (same data folder, same SECRET_KEY): everything must still be there"
  stop_app
  start_app true || exit 1
  run_phase persist
  app_alive_check persist
fi

if want locked || want down; then
  say ""
  say "== Restarting the app with guest sign-in OFF"
  stop_app
  start_app "" || exit 1
  want locked && run_phase locked
  want down && run_phase down
  app_alive_check "locked/down"
fi

say ""
say "================ harness checks: logs ================"
crashes="$(grep -E '"event":"(request_failed|job_runner_crashed)"' "$LOGS/app.log" | head -5)"
if [ -z "$crashes" ]; then harness_check "no 5xx request failures or crashed jobs in the server log" 0
else harness_check "no 5xx request failures or crashed jobs in the server log" 1 "$(printf '%s' "$crashes" | cut -c1-400)"; fi
unhandled="$(grep -E 'unhandledRejection|uncaughtException|Unhandled Rejection|TypeError|ReferenceError' "$LOGS/app.log" | head -5)"
if [ -z "$unhandled" ]; then harness_check "no unhandled exceptions in the server log" 0
else harness_check "no unhandled exceptions in the server log" 1 "$(printf '%s' "$unhandled" | cut -c1-400)"; fi
nofixture="$(grep -o 'no fixture for prompt id "[^"]*"' "$LOGS/mock-claude.log" | sort -u | tr '\n' ' ')"
if [ -z "$nofixture" ]; then harness_check "every AI prompt id the app used has a mock answer" 0
else harness_check "every AI prompt id the app used has a mock answer" 1 "$nofixture"; fi
failed_jobs="$(grep -c '"event":"job_failed"' "$LOGS/app.log")"
say "   (info) failed background jobs in the server log: $failed_jobs (the blocked-website scan is one on purpose)"

TOTAL_PASS=$((TOTAL_PASS + HARNESS_PASS)); TOTAL_FAIL=$((TOTAL_FAIL + HARNESS_FAIL))
SUMMARY_LINES="$SUMMARY_LINES
  $(printf '%-9s pass %4s   fail %3s' harness "$HARNESS_PASS" "$HARNESS_FAIL")"

say ""
say "======================== GrantFinder e2e summary ========================$SUMMARY_LINES"
say "  ----------------------------------------------------------------------"
say "  $(printf '%-9s pass %4s   fail %3s   skip %3s' TOTAL "$TOTAL_PASS" "$TOTAL_FAIL" "$TOTAL_SKIP")"
say ""
say "Screenshots, downloads, debug reports, logs: tests/e2e/artifacts/"
grep -h '^FAIL ' "$LOGS"/phase-*.log 2>/dev/null | head -60 | sed 's/^/  /'
if [ "$TOTAL_FAIL" -gt 0 ] || [ "$TOTAL_SKIP" -gt 0 ] || [ -n "$CRASHED_PHASES" ]; then
  say "RESULT: FAILED"
  exit 1
fi
say "RESULT: ALL CHECKS PASSED"
exit 0
