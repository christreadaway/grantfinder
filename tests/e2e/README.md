# End-to-end browser test

`run_e2e.sh` builds the real site for production (the website and the engine are one
Next.js app, the same thing Netlify runs), starts it on your computer with a **mock Claude**
and a **fake parish website**, and drives a real Chrome browser through everything a person
would do. No real Claude API key, no internet, nothing sent anywhere.

## Run it

```bash
cd ~/grantfinder && bash tests/e2e/run_e2e.sh
```

About 5-10 minutes (the production build is 1-3 of them). The summary at the end shows the
pass and fail counts per phase (453 checks in all), then either says
`RESULT: ALL CHECKS PASSED` (exit code 0) or lists the `FAIL` lines (the first 60) and says
`RESULT: FAILED`; a skipped check also counts as a failure. Screenshots (of every failed step
and a few key screens), the downloaded exports, the copied debug report/bundle, a
`results-<phase>.json` per phase and all server logs land in `tests/e2e/artifacts/`.

### One-time setup (Mac or Linux)

```bash
cd ~/grantfinder/frontend && (sfw npm install || npm install)
cd ~/grantfinder/tests/e2e && (sfw npm install || npm install)
cd ~/grantfinder/tests/e2e && npx playwright install chromium
```

Skip the last line if Playwright's Chromium is already installed (for example when
`PLAYWRIGHT_BROWSERS_PATH` points at one). `tests/e2e/package.json` pins `playwright` to the
version that matches the installed browser build.

### Options

| Option | What it does |
|---|---|
| `E2E_SKIP_BUILD=1` | Reuse the last build in `frontend/.next` (faster re-runs) |
| `E2E_PHASES="journey basics"` | Run only some phases (`journey basics errors expired persist locked down`; `persist` needs `journey` in the same run) |
| `E2E_HEADED=1` | Show the browser while it runs |
| `E2E_KEEP=1` | Keep the temporary data folder for inspection |
| `E2E_NO_LATENCY=1` | Mock Claude answers instantly instead of after a realistic delay (0.15-5 s per call, set per phase) |
| `E2E_JOB_MODE=direct` | Run every AI step the way Netlify does by default: inside its own request (`POST /api/jobs/{id}/run`, about a minute each, long steps continuing in parts) instead of in the server process. The same 443 checks |
| `E2E_APP_PORT` / `E2E_MOCK_PORT` / `E2E_SITE_PORT` / `E2E_PROXY_PORT` | Preferred ports (3199 / 4999 / 4998 / 4996); a busy port moves to the next free one |

Example: `cd ~/grantfinder && E2E_SKIP_BUILD=1 E2E_PHASES="journey" bash tests/e2e/run_e2e.sh`

Direct job mode (the Netlify default): `cd ~/grantfinder && E2E_JOB_MODE=direct bash tests/e2e/run_e2e.sh`

## What it covers

| Phase | Server state | What it proves |
|---|---|---|
| journey | guest sign-in on | Landing, "Continue as guest", API key (typo, key Anthropic rejects, good key), starter database (24 grants, no duplicates on a second load), website scan of a site that blocks robots (403: inline error + basics form) and of a parish site plus a separate school site (crawler reads about/school/news/PDF bulletin, skips irrelevant pages, text reaches Claude), every questionnaire type (yes/no, dropdown, multiple choice, text) + notes saved to the profile, document upload (.txt, real .docx, real PDF; wrong type rejected) and pasted text (a funded proposal: listed like a file under a safe name, read with its kind) with text reaching Claude, matching with live progress and MATCHING COMPLETE, results counts, Kenedy at the top, CSV + Markdown exports, "Write Application" on Kenedy (deadline + urgency banner; a second click reopens the same application), and the whole writer: guidelines, pasted reviewer comments in Add Materials (read with their kind), Funder History (pasted notes become a funder profile showing a summary, comparable grants and a suggested ask; the notes reach Claude, and the profile reaches the fit analysis and every draft prompt), fit analysis, strategy gate (engine refuses to draft before it; the edited strategy reaches every draft), gaps (waive, stakeholder emails, record an answer, "They don't have it"), Draft blocked while a high gap is open (screen and engine), voice, drafting with live progress and banned-phrase rewrite, refine, a hand edit (live word count, saved on the server, the earlier text kept in the history) and "Restore this version" (asks first), score, Word/Markdown/portal/form-map exports (the .docx is opened and read), "Copy debug bundle"; then back to the dashboard, "Your applications", a page reload that opens on Results and restores the key, grants, website addresses and results, and shows the saved questions with earlier answers filled in (no new AI call), "Copy debug report" |
| basics | guest sign-in on | A second guest: AI web discovery, uploading your own Excel grant list ("Upload and Continue"), "Enter the basics by hand" (required fields, saved profile), the step bar back to Website, then "Go to my questions" (the questions written after the basics are reused, no new AI call), matching with no documents (unscored grants labeled "Not AI-scored"), "Keep my saved key", the writer reading guidelines from the grant's own web page when none are pasted (and saying so when that page blocks robots), one guest can't open another guest's application, sign out (a guest is warned first that the work can't be opened again; the session is forgotten in the browser) |
| errors | guest sign-in on | A third guest: a key with no API credits (clear "out of credits" message), replacing the saved key, Claude overloaded during matching (results still arrive, labeled "Not AI-scored"), drafting while Claude keeps failing (finished sections kept; the error is on screen, says how many were saved and what to do; "Draft missing sections" drafts only the unfinished ones), the export hard rules (an over-limit or banned-phrase section is flagged, export is refused naming the section, a clean revision exports again), "Redraft All Sections" asks first, reloading the page mid-draft (the running step is picked back up and finishes; the replaced text stays in the history), a one-section "Redraft", "Re-run fit analysis" asks first, re-analyzing after drafting (the new section is listed as not drafted; export follows the new requirements), and the debug report explaining all of it |
| expired | guest sign-in on | A garbage token, a token signed by another server, and a valid token for a user that no longer exists all return to `/?expired=1` with "Your session ended" (dashboard and writer); the bad token is cleared and guest sign-in is offered again |
| persist | **restarted** | The old session still works, the saved key still decrypts (an AI step runs), grants, profile, results, the application, its drafts, scorecard, exports (the Markdown file is identical) and debug bundle are all still there; a returning user with results lands on Results; a wrong application link shows a clear message; the dashboard and writer on a phone-sized screen |
| locked | restarted with guest sign-in **off** | Landing says "Sign-in isn't set up yet", no guest button, the engine refuses guest sign-in (403) |
| down | engine unreachable (simulated in the browser) | Landing says "Can't reach the GrantFinder engine" for a crashed function (502), no connection, and a missing function (404 page) |
| harness | | The health check reports local runtime and file storage, data folder layout, API keys stored encrypted (never in plain text), no API key in the server log, no 5xx or crashed jobs and no unhandled exceptions in the server log, every AI prompt the app used has a mock answer, the server never crashed |

Every phase also fails on unexpected browser console errors, page errors, or any 5xx from
`/api/*` (the deliberate ones, like the 400 for the rejected key, are allowed).

## How it works

| Piece | File |
|---|---|
| Runner: build, start, phases, restarts, summary | `run_e2e.sh` |
| Browser test (Playwright) | `e2e.cjs` |
| Mock Claude answers for the journey (sent to the mock at runtime) | `lib/fixtures.cjs` |
| Test documents (real PDF and .docx) and the .docx export reader | `lib/files.cjs` |
| Fake parish website (pages, a PDF bulletin, a 403 "Cloudflare" page) | `fake-site.cjs` |
| Realistic Claude delay so progress messages can be seen | `latency-proxy.cjs` |
| Mock Claude server (shared with the engine tests) | `../mock-claude/server.mjs` |

The app runs with `GRANTFINDER_TEST_MODE=1` (prompt ids sent to the mock),
`GRANTFINDER_ALLOW_LOCAL_FETCH=1` (lets the engine read the fake site on 127.0.0.1),
a throwaway `GRANTFINDER_DATA_DIR`, a fixed test `SECRET_KEY`, and `GRANTFINDER_JOB_MODE`
taken from `E2E_JOB_MODE` (empty: AI steps run in the server process). Every setting is passed
explicitly, so a `frontend/.env.local` on your Mac can't change the result.

The journey's mock answers are sent to the mock with `POST /__fixtures` instead of living in
`tests/mock-claude/fixtures/`, so the engine tests keep seeing their own answers. Answers that
must echo ids the app generates (grant ids for scoring, gap ids for stakeholder routing) are
built from the live data, the way real Claude echoes the ids it was given.

The runner only ever stops processes it started itself (by PID, recorded in
`tests/e2e/artifacts/.pids`, including ones left behind by a run that was killed). If a port is
busy with something else, it picks the next free port and leaves that program alone.

The build writes to `frontend/.next`, the same folder `npm run build` uses: don't run another
build in `frontend/` while the test runs (or use `E2E_SKIP_BUILD=1` to reuse the last build).

## When something fails

1. Read the `FAIL` lines at the end of the output.
2. Look at the matching screenshot in `tests/e2e/artifacts/` (named after the phase and step).
3. Server side: `tests/e2e/artifacts/logs/app.log` (one JSON line per event); the browser side
   of each phase is in `tests/e2e/artifacts/logs/phase-<name>.log`.
4. Paste the FAIL lines and the relevant log lines into Claude Code.

Engine-level tests (no browser): `cd ~/grantfinder && bash tests/engine/run_all.sh` runs all 10
suites (693 checks), then the processing, grants, writer, regressions and checklist suites again in
direct job mode (1,260 checks in all); one area alone: `cd ~/grantfinder/frontend && npx tsx ../tests/engine/<area>.test.mts`.
