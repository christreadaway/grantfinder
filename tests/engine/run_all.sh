#!/usr/bin/env bash
# Runs every engine test suite: no Claude API key, browser, or Netlify needed
# (a mock Claude server and a throwaway data folder are started per suite).
#
#   cd ~/grantfinder && bash tests/engine/run_all.sh
#
# Add VERBOSE=1 to see the engine's own log lines.
set -uo pipefail
cd "$(dirname "$0")/../../frontend" || exit 1
failed=()
for suite in foundation deadlines grants processing writer regressions direct direct-processing checklist security; do
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
for suite in processing grants writer regressions checklist; do
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
