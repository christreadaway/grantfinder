#!/usr/bin/env bash
# Runs every engine test suite: no Claude API key, browser, or Netlify needed
# (a mock Claude server and a throwaway data folder are started per suite).
#
#   cd ~/grantfinder && bash tests/engine/run_all.sh
#
# Add VERBOSE=1 to see the engine's own log lines.
#
# The suites must pass on any day. To check, pretend it is another day (test mode only;
# every suite reads it through the engine's deadlines.todayIso()):
#
#   cd ~/grantfinder && GRANTFINDER_TODAY=2028-11-20 bash tests/engine/run_all.sh
set -uo pipefail
cd "$(dirname "$0")/../../frontend" || exit 1
if [ -n "${GRANTFINDER_TODAY:-}" ]; then
  if ! [[ "$GRANTFINDER_TODAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "GRANTFINDER_TODAY must be YYYY-MM-DD (got \"$GRANTFINDER_TODAY\")"
    exit 1
  fi
  export GRANTFINDER_TODAY
  echo "Pretending today is $GRANTFINDER_TODAY (GRANTFINDER_TODAY)"
fi
failed=()
for suite in foundation deadlines grants processing writer regressions direct direct-processing checklist security finder; do
  echo "== $suite"
  if npx tsx "../tests/engine/$suite.test.mts" > "/tmp/grantfinder-engine-$suite.log" 2>&1; then
    tail -1 "/tmp/grantfinder-engine-$suite.log"
  else
    grep -E "^FAIL" "/tmp/grantfinder-engine-$suite.log" | head -20
    tail -1 "/tmp/grantfinder-engine-$suite.log"
    failed+=("$suite")
  fi
done
# Netlify's default runs every AI step inside one request (direct job mode):
# the processing, grants, writer and regressions suites must pass that way too.
for suite in processing grants writer regressions checklist finder; do
  echo "== $suite (direct job mode)"
  if GRANTFINDER_JOB_MODE=direct npx tsx "../tests/engine/$suite.test.mts" > "/tmp/grantfinder-engine-$suite-direct.log" 2>&1; then
    tail -1 "/tmp/grantfinder-engine-$suite-direct.log"
  else
    grep -E "^FAIL" "/tmp/grantfinder-engine-$suite-direct.log" | head -20
    tail -1 "/tmp/grantfinder-engine-$suite-direct.log"
    failed+=("$suite-direct")
  fi
done
if [ ${#failed[@]} -gt 0 ]; then
  echo "FAILED suites: ${failed[*]} (full output in /tmp/grantfinder-engine-<suite>.log)"
  exit 1
fi
echo "All engine suites passed."
