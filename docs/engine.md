# How the GrantFinder engine works (Netlify edition)

GrantFinder runs entirely on Netlify, on any plan. There is no separate server to host.

| Piece | Where | What it does |
|---|---|---|
| Website | `frontend/src/app/` (Next.js) | The screens people use |
| Engine API | `frontend/src/server/`, mounted at `/api/*` by `frontend/src/app/api/[...path]/route.ts` | Sign-in, grants, profile, matching, writer; by default also runs every AI step (`POST /api/jobs/{id}/run`) |
| Background worker (optional) | `frontend/netlify/background/grantfinder-jobs-background.mts`, deployed only when `GRANTFINDER_BACKGROUND_JOBS=true` (`frontend/scripts/netlify-functions.mjs` copies it into `netlify/functions/` before the build) | Runs AI steps for up to 15 minutes each, on Netlify plans that include background functions |
| Storage | Netlify Blobs (on Netlify) or `frontend/.data/` JSON files (on your Mac) | Users, saved API keys, grants, profiles, applications, jobs |

The old Python engine in `backend/` is the reference the TypeScript engine was ported
from. It is no longer deployed.

## Jobs, and the three ways they run

Every Claude call runs as a **job**, never inside the route that asked for it:

1. The website calls an API route (for example `POST /api/processing/match-grants`).
2. The route checks everything it can right away (signed in? API key saved? profile
   exists?) and answers `400`/`404`/`409` immediately when something is missing.
3. Otherwise it records a job and answers `202 {"job_id": "...", "status": "queued", "kind": "..."}`
   (plus `"run": "direct"` in direct mode).
4. The job runs according to the **job mode** (`config.ts` `jobMode()`, shown by `/api/health`
   as `"jobs"`):
   - **direct** (Netlify default, works on every plan): the website calls
     `POST /api/jobs/{job_id}/run`, which runs the job inside that request. Netlify stops a
     request at 60 seconds, so the job's Claude calls stop at 50 (`directJobBudgetMs()`),
     leaving time to save. Handlers check `ctx.timeLeftMs()` before starting another Claude
     call. Work that doesn't fit (drafting many sections) returns a result with
     `__continue: {path, body}`; the website makes that request next and uses its result,
     so the screen sees one finished step.
   - **background** (`GRANTFINDER_BACKGROUND_JOBS=true`, Netlify plans with background
     functions): the route starts the background function (signed with `SECRET_KEY`), which
     runs the job for up to 15 minutes. Legacy Netlify plans (accounts from before
     September 4, 2025) don't have background functions, and a deploy that contains one
     fails there, so it is off by default and only copied into the deploy when asked for.
   - **local** (your Mac, tests): inside the same server process. `GRANTFINDER_JOB_MODE=direct`
     forces direct mode locally, to test it.
5. The website polls `GET /api/jobs/{job_id}` until `status` is `done` (the `result` is
   exactly what the old Python endpoint returned) or `failed` (`error.detail` explains
   what to do). `frontend/src/lib/api.ts` does this polling, the direct-mode run request,
   and following `__continue` for every call automatically.

What keeps a step from being lost or paid for twice:

- **One run at a time.** Each job has an exclusive key (by default its kind plus the
  application id; drafting and refining share `writer.sections:{appId}`, the website
  scan includes its URLs, document uploads have none). The very same request while one
  runs (a double click) gets `409 {"running": true, "job_id": ...}`, and the website waits
  for the first run instead of starting (and paying for) another. A different request on
  the same key (a refine while a redraft runs) gets a plain 409 that says to wait.
- **Heartbeat.** A running job touches its record every 45 seconds, even during one long
  Claude call. A background job silent for 3 minutes, or running past 16 minutes, reads as
  failed with a plain message; a direct job silent for 75 seconds does too (Netlify stopped
  its request), so a crashed worker never blocks a retry for long.
- **Hard stop.** Claude calls are cut at 50 seconds in direct mode and about 75 seconds before
  Netlify's 15-minute limit in background mode, so the job can still save what finished and
  say what didn't.
- **Polling survives the network.** The website keeps checking through a Wi-Fi drop or a
  sleeping laptop (it waits for the connection to come back) and through brief Netlify
  errors; it gives up only after 3 minutes online without one good answer, and then
  says the step may still finish and that reloading picks it back up.
- **Reloads pick steps back up.** The dashboard (matching) and the writer (every writer
  step) look for a running job of theirs on load and show its progress.

## Conventions for engine code (`frontend/src/server/`)

- **Relative imports only** inside `src/server` (no `@/`), because the Netlify background
  function is bundled separately from Next.js.
- **JSON stays snake_case** and matches the Python response shapes field for field.
  Types live in `types.ts`.
- **Errors**: throw `new HttpError(status, detail)` for expected problems. Keep the Python
  engine's exact `detail` wording where one existed. Responses always look like
  `{"detail": "..."}`.
- **Claude**: only inside job handlers, only through `ctx.claude()` → `Claude.call({stage,
  promptId, prompt, maxTokens, tools})`. It returns `{text, ...}` with text blocks joined
  (newer models put a thinking block first). Parse model output with `extractJson`,
  `extractJsonObject`, or `extractJsonArray` from `json.ts`, never bare `JSON.parse`.
- **Claude address**: every Anthropic client gets an explicit `baseURL: anthropicBaseUrl()`
  (`https://api.anthropic.com`) and `authToken: null`. Netlify's AI Gateway injects
  `ANTHROPIC_BASE_URL` (and `ANTHROPIC_API_KEY`) into functions on credit-based plans; the SDK
  would follow it and the gateway rejects the person's own key. The engine ignores those
  variables; only `GRANTFINDER_CLAUDE_BASE_URL` (the tests' mock Claude) changes the address.
  `/api/health` shows the host in use as `claude_api`.
- **Fatal vs. fallback**: a `ClaudeError` with `fatal: true` (bad key, no credits, unknown
  model, malformed request) must propagate so the job fails with a clear message. Use
  `isFatalClaudeError(e)` before falling back. Fallback results must say plainly that
  they are not AI-scored.
- **Storage**: `repo.ts` for grants, foundations, profile, match results, applications;
  `store.ts` `kv()` and `update()` for anything else. Use `update()` (compare-and-swap)
  for read-modify-write, never get-then-set, because jobs run concurrently.
  Two Netlify Blobs details live in `store.ts` and must stay: the client gets a
  fetch that reads every response fully (inside Netlify functions, cancelling an
  unread 404 body never settles, so lookups of missing keys hung), and when a read
  carries no ETag (Netlify's local sandbox) the version tag comes from a listing
  taken before the re-read, so compare-and-swap still works.
- **Logging**: `logger.info/warn/error(event, fields)` from `log.ts`: one JSON line per
  event. Every Claude call is logged automatically with tokens, latency, cost, and the
  correlation id, and stored on its job.
- **Deadlines**: `deadlines.ts` (`parseDeadline`, `deadlinePassed`, `isUrgent`) handles
  dates and recurring "Annual: October 15" deadlines in Central time. `todayIso()` honors
  `GRANTFINDER_TODAY=YYYY-MM-DD` only in test mode (`GRANTFINDER_TEST_MODE=1`), so suites can
  run as if on another date.
- **Grant facts**: the optional fields a grant can carry (`deadline_notes`, `geography`,
  `religious_eligibility`, `focus_areas`, `typical_award`, `last_verified`, `confidence`,
  `sources`) are typed in `types.ts` and read leniently by `grantDetails.ts`
  (`parseGrantDetails`, `parseReligiousEligibility`) from the starter database, spreadsheets
  and Claude's answers. Never fill one in without a source; leave it out instead.
- **Fetching websites**: `net.ts` (`fetchPage`, `crawlSite`, `checkUrl`) with SSRF
  protection on every redirect and again when the connection is made (a DNS answer that
  changes to a private address between the check and the connect is refused).
- **Heavy file libraries load on first use**: `exceljs` (`services/excel.ts`), `mammoth`
  (`services/documents.ts`), `unpdf` (`pdf.ts`) and `docx` (`services/writerExport.ts`)
  are imported inside the function that needs them (`await import(...)`), so ordinary
  API calls start faster on a cold Netlify function. Keep new heavy imports the same way.
- **Uploads**: `.docx` and `.xlsx` files are zip archives; `zipguard.ts` refuses ones
  that would expand past 120 MB before the parser unzips them. Netlify accepts uploads
  up to about 4 MB.

## Files

| File | Purpose |
|---|---|
| `app.ts` | Request entry: routing, auth, error → `{detail}` responses, request logs |
| `router.ts` | `/api/x/:param` pattern router |
| `http.ts` | `RequestContext`, JSON/file response helpers |
| `config.ts` | Environment settings (`SECRET_KEY`, `CLAUDE_MODEL`, `ALLOW_GUEST_LOGIN`...) |
| `auth.ts` | Session tokens (HS256, 30 days), users, AES-256-GCM API key storage, rate limits |
| `store.ts` | Netlify Blobs / local file key-value store with safe `update()` |
| `repo.ts` | Storage layout and accessors for shared records |
| `jobs.ts` | Job records, the three job modes (direct run, background dispatch, local), runner with deadline, stale-job detection; finished jobs keep only a summary of their input (document text and pasted guidelines are not stored) |
| `jobHandlers.ts` | Registry of every job kind → handler (`handlers/*.ts`) |
| `claude.ts` | Claude client: streaming, pause_turn, logging, error translation, prices |
| `json.ts` | Lenient JSON extraction from model output and coercion helpers |
| `net.ts`, `pdf.ts` | Safe web fetching and crawling; PDF text extraction |
| `deadlines.ts` | Deadline parsing and urgency |
| `grantDetails.ts` | Lenient parsing of the grant facts (religious eligibility, geography, deadline notes, priorities, typical award, last verified) |
| `data/seed_grants.json` | The starter database: 89 grants and 8 foundations a Catholic school or parish in Texas can apply to, each checked on the funder's site, refreshed monthly by `/grant-research` (`docs/grant-discovery.md`) |
| `routes/*.ts` | API routes by area (auth, system, grants, discovery, processing, profile, export, writer, checklist). The writer's include the guidelines file (`POST /api/writer/applications/{id}/grant-spec/upload`) and the funder history (`POST .../funder-profile`, `POST .../funder-profile/upload`, `DELETE .../funder-profile/files/{name}`); `routes/checklist.ts` serves `GET`/`PUT /api/writer/applications/{id}/checklist`; `POST /api/processing/match-grants/continue` scores grants a matching part didn't reach |
| `services/*.ts` | Business logic and prompts by area |
| `handlers/*.ts` | Job handlers by area (every Claude call; they run in all three job modes) |

## Storage layout

```
users/{userId}                    User
apikeys/{userId}                  encrypted Claude API key
grants/{userId}                   Grant[]
foundations/{userId}              Foundation[]
profiles/{userId}                 OrganizationProfile
matches/{userId}/{sessionId}      MatchResults (next_deadline, days_left, deadline_passed are added when read, never stored)
applications/{userId}/{appId}     Application
writer/{userId}/...               writer artifacts (grant specs, fit analyses, gaps, intake, drafts, scorecards)
writer/{userId}/funder/{grantId}  FunderRecord: funder history notes, files, web research and the funder profile (one per grant)
writer/{userId}/checklist/{appId} Application Checklist: items ticked by hand and their notes
seedloaded/{userId}               the starter database edition this user last loaded (for "Update my grants")
jobs/{userId}/{jobId}             Job (input, status, result, error, AI call log, notes)
ratelimit/{bucket}/{ipHash}       sign-in rate-limit window
```

## Tests

```bash
cd ~/grantfinder
bash tests/engine/run_all.sh      # 11 suites: foundation, deadlines, grants, processing, writer, regressions, direct, direct-processing, checklist, security, finder ({{ENGINE_FIRST_PASS}} checks); then processing, grants, writer, regressions, checklist, finder again in direct mode ({{ENGINE_TOTAL}} checks in all)
bash tests/e2e/run_e2e.sh         # real browser through the whole journey on a production build ({{E2E_TOTAL}} checks)
```

The suites compute deadlines from today, never from fixed dates. To check they pass on another
date: `cd ~/grantfinder && GRANTFINDER_TODAY=2028-11-20 bash tests/engine/run_all.sh` (the
engine honors it in test mode only).

`direct.test.mts` and `direct-processing.test.mts` run with `GRANTFINDER_JOB_MODE=direct`, a set
job budget (`GRANTFINDER_DIRECT_JOB_BUDGET_MS`: 45 and 5 seconds) and a slow mock Claude:
drafting and matching in parts, and every other AI step ending inside one request.
`E2E_JOB_MODE=direct bash tests/e2e/run_e2e.sh` runs the browser test in direct mode.

The engine suites call `handleRequest()` in-process with a mock Claude
(`tests/mock-claude/server.mjs` at `GRANTFINDER_CLAUDE_BASE_URL`, answers in
`tests/mock-claude/fixtures/*.json`, keyed by prompt id) and a throwaway data folder. Both
test harnesses also set decoy `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` values, the way
Netlify's AI Gateway does, and the mock refuses any request carrying an `Authorization`
header, so a regression there fails every suite. Mock keys `sk-ant-invalid…`, `sk-ant-nocredit…`,
`sk-ant-overload…`, `sk-ant-spendcap…` and `sk-ant-userlimit…` simulate Anthropic failures
(bad key, no credits, overloaded, monthly spend cap, a spend limit you set). `/__fail`
forces errors per prompt, `/__delay` slows one prompt down, and `/__fixtures` swaps answers
at runtime.

To exercise the real Netlify runtime (direct-mode jobs, or the background function with
`GRANTFINDER_BACKGROUND_JOBS=true`, plus Blobs) on a Mac, install the
Netlify CLI and run `netlify build` then `netlify serve` against a copy of `frontend/` with
its own `netlify.toml` (the CLI's local server mishandles the repo's `base = "frontend"`).

## Debugging

- `GET /api/debug/report` (signed in): paste-ready markdown with settings, the last 15
  steps, every error with its internal detail, and the AI calls behind each step. The
  dashboard has a **Copy debug report** link.
- `GET /api/writer/applications/{id}/debug-bundle`: the same for one grant application.
- Netlify: **Logs**, then **Functions**: the `___netlify-server-handler` log (the API and, in
  direct mode, every AI step) and, only with `GRANTFINDER_BACKGROUND_JOBS=true`, the
  `grantfinder-jobs-background` log (AI steps in background mode). Every line is JSON.
- Your Mac: `~/logs/grantfinder/grantfinder.log` (rotated daily, kept 14 days).
