# How the GrantFinder engine works (Netlify edition)

GrantFinder runs entirely on Netlify. There is no separate server to host.

| Piece | Where | What it does |
|---|---|---|
| Website | `frontend/src/app/` (Next.js) | The screens people use |
| Engine API | `frontend/src/server/`, mounted at `/api/*` by `frontend/src/app/api/[...path]/route.ts` | Sign-in, grants, profile, matching, writer |
| Background worker | `frontend/netlify/functions/grantfinder-jobs-background.mts` | Runs every Claude (AI) step, up to 15 minutes each |
| Storage | Netlify Blobs (on Netlify) or `frontend/.data/` JSON files (on your Mac) | Users, saved API keys, grants, profiles, applications, jobs |

The old Python engine in `backend/` is the reference the TypeScript engine was ported
from. It is no longer deployed.

## Why background jobs

Netlify stops a normal function after 60 seconds. Scoring 40 grants or drafting a
whole application takes minutes. So every Claude call runs as a **job**:

1. The website calls an API route (for example `POST /api/processing/match-grants`).
2. The route checks everything it can right away (signed in? API key saved? profile
   exists?) and answers `400`/`404`/`409` immediately when something is missing.
3. Otherwise it records a job and answers `202 {"job_id": "...", "status": "queued", "kind": "..."}`.
4. On Netlify the route starts the background function (signed with `SECRET_KEY`); locally
   the job runs inside the same server process.
5. The website polls `GET /api/jobs/{job_id}` until `status` is `done` (the `result` is
   exactly what the old Python endpoint returned) or `failed` (`error.detail` explains
   what to do). `frontend/src/lib/api.ts` does this polling for every call automatically,
   so screens see the same response shapes as before.

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
  dates and recurring "Annual: October 15" deadlines in Central time.
- **Fetching websites**: `net.ts` (`fetchPage`, `crawlSite`, `isSafeUrl`) with SSRF
  protection on every redirect.

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
| `jobs.ts` | Job records, dispatch to the background function, runner, stale-job detection; finished jobs keep only a summary of their input (document text and pasted guidelines are not stored) |
| `jobHandlers.ts` | Registry of every job kind → handler (`handlers/*.ts`) |
| `claude.ts` | Claude client: streaming, pause_turn, logging, error translation, prices |
| `json.ts` | Lenient JSON extraction from model output and coercion helpers |
| `net.ts`, `pdf.ts` | Safe web fetching and crawling; PDF text extraction |
| `deadlines.ts` | Deadline parsing and urgency |
| `routes/*.ts` | API routes by area (auth, system, grants, discovery, processing, profile, export, writer) |
| `services/*.ts` | Business logic and prompts by area |
| `handlers/*.ts` | Background job handlers by area |

## Storage layout

```
users/{userId}                    User
apikeys/{userId}                  encrypted Claude API key
grants/{userId}                   Grant[]
foundations/{userId}              Foundation[]
profiles/{userId}                 OrganizationProfile
matches/{userId}/{sessionId}      MatchResults
applications/{userId}/{appId}     Application
writer/{userId}/...               writer artifacts (grant specs, fit analyses, gaps, intake, drafts, scorecards)
jobs/{userId}/{jobId}             Job (input, status, result, error, AI call log, notes)
ratelimit/{bucket}/{ipHash}       sign-in rate-limit window
```

## Tests

```bash
cd ~/grantfinder
bash tests/engine/run_all.sh      # 406 checks: foundation, deadlines, grants, processing, writer
bash tests/e2e/run_e2e.sh         # real browser through the whole journey on a production build
```

The engine suites call `handleRequest()` in-process with a mock Claude
(`tests/mock-claude/server.mjs`, answers in `tests/mock-claude/fixtures/*.json`, keyed by
prompt id) and a throwaway data folder. Mock keys `sk-ant-invalid…`, `sk-ant-nocredit…`, and
`sk-ant-overload…` simulate Anthropic failures; `/__fail` forces errors per prompt.

To exercise the real Netlify runtime (background function + Blobs) on a Mac, install the
Netlify CLI and run `netlify build` then `netlify serve` against a copy of `frontend/` with
its own `netlify.toml` (the CLI's local server mishandles the repo's `base = "frontend"`).

## Debugging

- `GET /api/debug/report` (signed in): paste-ready markdown with settings, the last 15
  steps, every error with its internal detail, and the AI calls behind each step. The
  dashboard has a **Copy debug report** link.
- `GET /api/writer/applications/{id}/debug-bundle`: the same for one grant application.
- Netlify: **Logs**, then **Functions**: the `___netlify-server-handler` (API) and
  `grantfinder-jobs-background` (AI jobs) logs. Every line is JSON.
- Your Mac: `~/logs/grantfinder/grantfinder.log` (rotated daily, kept 14 days).
