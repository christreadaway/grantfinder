# Claude Code Instructions - GrantFinder

## About This Project
Grant discovery and tracking tool for Catholic schools. Helps identify, track, and apply for grants relevant to Catholic education institutions. Has product spec v2.6 (Feb 2, 2026).

## About Me (Chris Treadaway)
Product builder, not a coder. I bring requirements and vision — you handle implementation.

**Working with me:**
- Bias toward action — just do it, don't argue
- Make terminal commands dummy-proof (always start with `cd ~/grantfinder`)
- Minimize questions — make judgment calls and tell me what you chose
- I get interrupted frequently — always end sessions with clear handoff

## Tech Stack
- **Category:** School
- **Details:** One Next.js 16 + TypeScript app in `frontend/`, deployed entirely on **Netlify**: website (`frontend/src/app/`), engine API at `/api/*` (`frontend/src/server/`), AI jobs that run inside normal requests on any Netlify plan (optional 15-minute background function in `frontend/netlify/background/`), and Netlify Blobs for storage. Claude via `@anthropic-ai/sdk`. How it fits together: `docs/engine.md`.
- **Legacy:** `backend/` is the original Python FastAPI engine, kept only as the reference the TypeScript engine was ported from. It is not deployed; don't add features there.

## File Paths
- **Always use:** `~/grantfinder/`
- **Always start commands with:** `cd ~/grantfinder`

## PII Rules
❌ NEVER include: real school names → [School Name], staff names → [Staff Name], financial data, grant amounts tied to real institutions, file paths with /Users/christreadaway → use ~/
✅ ALWAYS use placeholders

## Git Branch Strategy
- Claude Code creates new branch per session
- Merge to main when stable
- Delete merged branches immediately

## Session End Routine

At the end of EVERY session — or when I say "end session" — do ALL of the following:

### A. Update SESSION_NOTES.md
Append a detailed entry at the TOP of SESSION_NOTES.md (most recent first) with: What We Built, Technical Details, Current Status (✅/❌/🚧), Branch Info, Decisions Made, Next Steps, Questions/Blockers.

### B. Update PROJECT_STATUS.md
Overwrite PROJECT_STATUS.md with the CURRENT state of the project — progress %, what's working, what's broken, what's in progress, next steps, last session date/summary. This is a snapshot, not a log.

### C. Commit Both Files
```
git add SESSION_NOTES.md PROJECT_STATUS.md
git commit -m "Session end: [brief description of what was done]"
git push
```

### D. Tell the User
- What branch you're on
- Whether it's ready to merge to main (and if not, why)
- Top 3 next steps for the next session

---
Last Updated: October 15, 2026


## GrantWriter Module (Application Writer)
- **Where it lives:** `frontend/src/server/services/writer.ts` (stages, prompts, compliance), `services/writerRepo.ts` (storage), `services/writerExport.ts` (docx/md/txt/form map), `routes/writer.ts`, `routes/checklist.ts` (Application Checklist), `handlers/writer.ts` (jobs: every writer Claude call), UI in `frontend/src/app/writer/`. Full docs: `docs/grant-writer.md`.
- **Single source of truth:** the writer READS and EXTENDS the existing org profile (`repo.ts` `getProfile`/`updateProfile`) and grant records (`repo.ts` grants; `getGrantOrFoundation` in `services/ai.ts` also opens foundations). Never duplicate them. An application is just `{user, grant_id}` + writer artifacts.
- **AI orchestration map (one purpose-built prompt per stage):** Extract (`grant_spec_v1`, `voice_profile_v1`) → Research the funder (`funder_research_v1` web search, optional; `funder_profile_v1`) → Map (`fit_gap_v1`) → Route (`intake_packets_v1`) → Draft (`section_draft_v1`) → Score (`self_score_v1`) → Refine (`section_refine_v1`) → Enforce (`voice_enforce_v1`). All in `services/writer.ts`. Other prompt ids: `website_scan_v1`, `questionnaire_v1`, `document_signals_v1`, `grant_match_batch_v1` (`services/ai.ts`), `web_discovery_v1` (`services/discovery.ts`).
- **Human approval gates (never bypass):** (1) strategy confirmation before drafting, (2) stakeholder emails are copy-paste only — never auto-sent, (3) export is an explicit user action — nothing is ever auto-submitted to a funder.
- **Hard rules in code:** never fabricate (unsupported claims get flagged); never export over-limit or banned-phrase content; high-severity gaps block drafting until answered/confirmed/waived; the funder history is about the funder, never evidence about the applicant, and a past grant whose recipient is not found word for word in the funder material is marked unverified and kept out of the fit, draft and score prompts.
- **Logging:** one JSON line per event (`frontend/src/server/log.ts`): Netlify > Logs > Functions when deployed, plus `~/logs/grantfinder/grantfinder.log` locally (daily rotation, 14 days). Every AI call is logged with correlation ID, tokens, latency, cost, and stored on its job. Look first at the dashboard's **Copy debug report** (`GET /api/debug/report`) or the writer's **Copy debug bundle** (`GET /api/writer/applications/{id}/debug-bundle`): both are paste-ready markdown. Set `LOG_LEVEL=debug` for verbose logs.
- **Model:** set via `CLAUDE_MODEL` env var (default `claude-sonnet-5-5`, Claude Sonnet 5.5, $2 / $10 per million tokens). Never hardcode. Sonnet 5.5 returns a 400 for `thinking: {type: "disabled"}`, forced `tool_choice` (`any`/`tool`), `budget_tokens` and sampling parameters: never send them (the mock Claude refuses them too). Thinking stays adaptive at the API's default effort; pass assistant turns back unchanged on `pause_turn`.

## Deployment & Testing
- **Where it runs:** everything on **Netlify** (no other host). `netlify.toml` builds `frontend/`. Click-by-click guide: `docs/deployment.md`.
- **Long AI work = jobs that fit any Netlify plan:** every Claude call runs as a job, never inside the route that asked for it. By default (direct mode) the website calls `POST /api/jobs/{id}/run`, which runs the job inside that request: Netlify stops a request at 60 seconds, so Claude calls stop at 50 (`ctx.timeLeftMs()`), and work that doesn't fit returns `__continue` so the website runs the next part. `GRANTFINDER_BACKGROUND_JOBS=true` deploys the optional 15-minute background function (`frontend/netlify/background/`, copied in by `frontend/scripts/netlify-functions.mjs`); legacy Netlify plans don't allow it (the deploy fails), so it stays off by default. Details: `docs/engine.md`.
- **Storage:** Netlify Blobs (store `grantfinder`) via `frontend/src/server/store.ts`; locally JSON files in `frontend/.data/`. Data and sign-ins survive deploys. Use `update()` (compare-and-swap) for read-modify-write. Keep the buffered `blobsFetch` in `store.ts`: without it, Blobs lookups of missing keys hang inside Netlify functions.
- **Claude address:** every Anthropic client gets `baseURL: anthropicBaseUrl()` (always `https://api.anthropic.com`) and `authToken: null` (`frontend/src/server/claude.ts`). Netlify's AI Gateway injects `ANTHROPIC_BASE_URL` into functions on credit-based plans, and the gateway rejects the person's own key ("Anthropic rejected this API key"), so never read `ANTHROPIC_BASE_URL`. Tests point at the mock with `GRANTFINDER_CLAUDE_BASE_URL`. `/api/health` shows the host as `claude_api`.
- **Netlify build guard:** `frontend/next.config.js` fails Netlify builds when `SECRET_KEY` is missing or shorter than 32 characters. Don't remove it.
- **Sign-in:** Google (`NEXT_PUBLIC_GOOGLE_CLIENT_ID` in Netlify; the engine reads the same value), or guest sign-in when `ALLOW_GUEST_LOGIN=true` (off by default). Every API route except health, sign-in (`/api/auth/options`, `/google`, `/guest`), and `/api/export/formats` needs a session token. Sessions last 30 days.
- **Tests (run before pushing):** `cd ~/grantfinder && bash tests/engine/run_all.sh` (10 suites, 693 checks: foundation 30, deadlines 31, grants 130, processing 140, writer 212, regressions 33, direct 21, direct-processing 20, checklist 52, security 24; then processing, grants, writer, regressions and checklist again in direct job mode, 567 more: 1,260 checks in all; mock Claude, no key needed) and `bash tests/e2e/run_e2e.sh` (real browser through the whole journey on a production build, 443 checks in 7 phases: journey, basics, errors, expired, persist, locked, down; `E2E_JOB_MODE=direct` runs AI steps the way Netlify does by default; setup at the top of the script).
- **Local npm installs:** `sfw npm install` (fallback `npm install` if sfw isn't installed). Netlify installs on its own.
- **Run it locally:** `cd ~/grantfinder/frontend && cp .env.example .env.local && npm run dev`, then open http://localhost:3000 (guest sign-in is on in `.env.example`).

## Branch Rules
Always work on the main branch. Do not create new branches unless explicitly asked. Commit and push all changes directly to main.

