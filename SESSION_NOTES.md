# GRANTFINDER - Session History

**Repository:** `grantfinder`  
**Total Sessions Logged:** 3  
**Date Range:** 2025-02-01 to 2025-02-02  
**Last Updated:** 2026-10-14

This file contains a complete history of Claude Code sessions for this repository, automatically generated from transcript files. Sessions are listed in reverse chronological order (most recent first).

---

## 2026-10-14 (later) — Web Deploy via Netlify: Fix Sign-In, Deploy Guards, Real Tests

### What We Built
Chris asked for GrantFinder to web deploy via Netlify. Netlify Functions run JavaScript, TypeScript, and Go only, so the Python engine can't live there: the website deploys to Netlify and the engine to Railway, and visitors only see the Netlify address.
1. **Found and fixed a dead end:** "Get Started (Demo Mode)" skipped sign-in, but every API route requires a session token, so every action after it failed. Replaced with guest sign-in behind `ALLOW_GUEST_LOGIN` (backend, off by default): `POST /api/auth/guest`, plus public `GET /api/auth/options` so the landing page shows exactly the sign-in methods the backend offers.
2. **Landing page diagnostics:** shows "Can't reach the GrantFinder engine" with the URL it tried and what to check (API URL, backend up, CORS_ORIGINS with the site's own origin); "Sign-in isn't set up yet" when neither method is on; "half set up" when only Netlify has the Google client ID; sign-in errors shown on screen instead of only the console.
3. **Expired sessions:** a backend restart (every Railway deploy) wipes in-memory sessions. An axios interceptor now sends any later 401 back to sign-in with "Your session ended..." instead of leaving every button failing. Dashboard sends tokenless visitors to sign-in and restores the user on refresh.
4. **Deploy guards:** Netlify builds fail with plain-English fixes when `NEXT_PUBLIC_API_URL` is missing or not https; API base URL trailing slashes stripped.
5. **Railway hardening:** start command `python -m uvicorn ...` (Procfile + guide), `backend/.python-version` 3.13, `main.py` honors `$PORT` and disables reload on platforms, `FORWARDED_ALLOW_IPS=*` so rate limiting sees real client IPs.
6. **Docs:** `docs/deployment.md` rewritten as a click-by-click guide (secret key, Railway, Netlify, CORS, Google sign-in, troubleshooting table, where logs live, known limits, run-on-Mac); README setup/deploy sections point to it; env examples no longer ship fake Google IDs.
7. **Committed tests:** `tests/e2e/run_e2e.sh` + `e2e.cjs` (production build, real backend, real browser, different origins; 4 phases, 25 checks) and `backend/tests/check_deadlines.py` (23 checks).

### Technical Details
- Modified: `backend/config.py`, `backend/routers/auth.py`, `backend/main.py`, `backend/Procfile`, `backend/.env.example`, `frontend/next.config.js`, `frontend/src/lib/api.ts`, `frontend/src/app/page.tsx`, `frontend/src/app/dashboard/page.tsx`, `frontend/.env.example`, `docs/deployment.md`, `GrantFinder_README.md`, `CLAUDE.md`
- Added: `backend/.python-version`, `backend/tests/check_deadlines.py`, `tests/e2e/{run_e2e.sh,e2e.cjs,package.json,README.md}`
- Verified: `next build` (Next 16.1.6) passes; Netlify guard tested with missing, http, and https URLs; tsc clean; no new lint findings (17 pre-existing `no-explicit-any`); E2E 25/25 across guest, expired, locked, down; deadline checks 23/23; CORS preflight returns the frontend origin; file log captures guest sign-ins and writer handoffs.

### Current Status
- ✅ Deploy-ready for Netlify (website) + Railway (engine), with tests proving the cross-origin flow
- 🚧 The deploy itself needs Chris's Netlify, Railway, and Google Cloud accounts (about 40 minutes, docs/deployment.md)
- ❌ Data still lives in memory and resets on every engine restart; AI steps not yet validated with a live key

### Branch Info
- Branch: `claude/relaxed-curie-sj0zvu`

### Decisions Made
- Netlify for the website, Railway for the engine (no TypeScript rewrite of the engine; revisit only if one platform matters more than the rebuild cost)
- Guest sign-in exists but is off by default; turn it on only to try a fresh deployment or for local dev
- No client-side demo mode, ever: it can't work against an authenticated API

### Next Steps
1. Chris: follow docs/deployment.md (Railway, then Netlify, then CORS, then Google sign-in)
2. Persistence (Supabase or similar) so sessions and work survive engine restarts
3. Live-key run of discovery, matching, and the writer pipeline on the deployed site, then add those steps to the E2E test

### Questions/Blockers
- None in code. Deployment needs Chris's accounts.

---

## 2026-10-14 — Kenedy Foundation Application Kit + Annual Deadlines

### What We Built
Chris asked whether GrantFinder can write grants, and for help with a Kenedy Memorial Foundation application due Oct 15, 2026.
1. **Capability answer:** yes. The GrantWriter module (built 2026-07-10) is real and wired: the backend boots with 42 API paths, 15 of them writer endpoints. It has never run against a live Claude key, storage is in-memory, and it isn't deployed, so for a next-day deadline the writing was done directly in-session with the same method (grant spec, fit/gap, honesty ledger, intake, draft, self-score, adversarial review).
2. **Kenedy application kit** (a Claude Doc, kept outside the repo): 24-hour checklist, eligibility traps, strategy and honesty ledger, paste-ready portal answers (Organization Information and Grant Project Data), Plan B and Plan C swap-ins, Exhibits A-H tracker with status dropdowns, exhibit templates (C resolution, D funding summary, E three-year budget, G no-990 statement, H litigation disclosure), fact sheet, sources.
3. **Strategy:** recommended Phase 2 of the school's Notre Dame DELTA-funded AI formation pilot ($45,000, with a $25,000 fallback): partner Texas Catholic schools including South Texas, a free summer institute, Spanish family materials, free K-8 materials. Tuition assistance held as Plan B because a high-performing school has a weak "demonstrated need" case; capital as Plan C.
4. **Kenedy seed record corrected** in `backend/data/seed_grants.json`: annual Oct 15 deadline, $50,000 soft cap and ~$25,000 median, exclusions, Exhibits A-H, application-process URL, OPEN status.
5. **Annual deadline support:** `AIService._parse_deadline` now resolves "Annual: October 15" to its next occurrence, so yearly funders are never filtered out as expired and the writer's urgency flag fires every cycle.

### Technical Details
- Modified: `backend/services/ai_service.py` (`ANNUAL_DEADLINE_RE`, `_parse_deadline`), `backend/data/seed_grants.json` (Kenedy record).
- Verified with a 23-check ad-hoc script (not committed): annual parsing incl. year rollover, Feb 29, abbreviations, bogus months; seed JSON validity and load; TX prefilter pass and non-TX disqualify; Kenedy not expired after Oct 15; writer urgency flag true on Oct 14.
- Found: the "16-check offline writer pipeline test" cited in earlier notes is not committed to the repo.

### Current Status
- ✅ Backend boots; writer routes registered; annual deadlines verified
- ✅ Kenedy kit complete, names kept as placeholders per PII rules
- 🚧 The application itself: Chris fills the fact sheet, calls the diocese and Foundation, gets board authorization, submits by 3 p.m. Oct 15
- ❌ GrantWriter still not validated with a live Claude key; storage still in-memory

### Branch Info
- Branch: `claude/relaxed-curie-sj0zvu` (the session's designated branch; CLAUDE.md's "work on main" rule conflicts, so the designated branch was kept and Chris merges online)

### Decisions Made
- Recommend AI formation Phase 2 over tuition assistance for Kenedy (reasons above)
- Keep all school, parish, and staff names as placeholders in the kit; one find-and-replace before pasting
- Recurring deadlines are written as "Annual: Month Day" in seed data

### Next Steps
1. Commit a pytest suite for the writer pipeline and deadline parsing (the earlier 16-check test isn't in the repo)
2. Live-key validation of the GrantWriter pipeline, using the Kenedy kit as the benchmark case
3. Funder templates: store a funder's required portal sections and exhibits (like Kenedy's A-H) so the Grant Spec stage uses them verbatim
4. Supabase persistence

### Questions/Blockers
- None for the code. For the application: diocesan protocol and the Foundation's answers on Exhibits C, G, and H depend on Chris's calls.

---

## 2026-07-10 (night) — Close the Real-Wiring Gaps

### What We Built
Audit of "anything else that needs building" found the dashboard was partly theater. Fixed:
1. **Document upload actually works now** — files selected in step 5 were never sent to the backend; document extraction (a core spec pillar: "AI catches the playground mention in your bulletin") never ran. The matching step now uploads each document, runs extraction, and shows the real extracted needs in the terminal.
2. **Fabricated demo results removed** — on any matching error the UI used to silently display hardcoded fake grants (whose "Write Application" would 404). Now errors surface honestly in the terminal with a back-and-retry button. Same cleanup for the silent fallbacks in the API-key, grant-upload, website-scan, and questionnaire steps.
3. **Results export buttons wired** — CSV and Markdown report download via the existing backend export endpoints (buttons previously did nothing).
4. **Voice profile UI added** — writer page now has a "Your Voice" card: paste a real writing sample, capture the voice profile, see it reflected. Endpoint existed; UI didn't.

### Current Status
- ✅ tsc clean, `next build` green, 16-check writer pipeline test passing
- The dashboard now does only real work — no fabricated data paths remain

### Branch Info
- Branch: `claude/grant-finder-review-0urze2`

### Next Steps
1. Deploy (docs/deployment.md), then live-key end-to-end run
2. Supabase persistence — now clearly the biggest remaining gap
3. Nice-to-haves: real SSE progress terminal, shortlist persistence, profile review/edit screen (spec 3.3)

---

## 2026-07-10 (evening) — Netlify Deployment Readiness

### What We Built
Made the repo deployable: frontend to Netlify, backend to Railway/Render (Netlify can't run Python servers — split matches spec section 7's hosting table).

1. **Deleted the dead legacy frontend generation** (`setup/`, `context/`, `results/`, `profile/`, `auth/callback`, `providers.tsx`, `useAuth.ts`, `FileUpload.tsx`) — they referenced APIs that never existed in this codebase and blocked every production build.
2. **Fixed the build config conflicts**: removed stale v3-style `postcss.config.js` that shadowed the Tailwind v4 config; consolidated duplicate `next.config.js`/`next.config.ts` into one (with `images.remotePatterns`).
3. **`next build` passes for the first time** — clean routes: `/`, `/dashboard`, `/writer`. `tsc --noEmit` fully clean.
4. **Added deploy scaffolding**: repo-root `netlify.toml` (base `frontend`, Next plugin), `backend/Procfile` (uvicorn for Railway/Render), `docs/deployment.md` (step-by-step, env vars, CORS), CORS_ORIGINS documented in `.env.example`.
5. **Locked in Chris's policy decisions** (recorded in docs/grant-writer.md): honesty ledger = name-and-frame by default; exactly three gates, no per-section approval; plain npm (no sfw).

### Current Status
- ✅ Production frontend build green; backend 16-check pipeline test still green
- 🚧 Deploy itself happens in Netlify/Railway dashboards (needs Chris's accounts)
- ⚠️ In-memory storage means deployed data resets on backend restart — documented in deployment.md

### Branch Info
- Branch: `claude/grant-finder-review-0urze2`

### Next Steps
1. Deploy: Railway backend first, then Netlify frontend with NEXT_PUBLIC_API_URL
2. Live-key end-to-end run of writer + web discovery
3. Supabase persistence (now the biggest gap for a real deployment)

---

## 2026-07-10 (later) — GrantWriter Module (Application Writer PRD v2.0)

### What We Built
Full implementation of the Application Writer PRD as a module inside grantfinder. The complete arc now exists: discover a matching grant → click "Write Application" → tailored, voice-matched, criteria-mapped application ready to export.

Pipeline (linear, with human approval gates):
1. **Handoff (4.0):** "Write Application" button on every match card; creates an `application` linking the existing grant record + org profile (never duplicates them). Deadline within 10 days → urgent flag.
2. **Grant Spec (4.2):** enriches the grant record into required sections, format constraints, deliverables, rubric (explicit used verbatim; inferred rubrics visibly flagged). Guidelines pasted or fetched from the grant's URL.
3. **Fit/Gap analysis (4.3):** criterion-by-criterion fit map (strong/partial/weak/missing) with real profile evidence, strength leads, honesty ledger, gap report, recommended strategy. GATE 1: strategy must be confirmed before drafting.
4. **Stakeholder intake (4.4):** copy-paste email packets per stakeholder (one owner per gap), "we don't have that" recorded as confirmed gap → honest framing path. Answers flow back into the SHARED org profile as evidence (compounding asset).
5. **Drafting (4.5):** voice-conditioned, evidence-backed sections; unsupported claims flagged; `[NEEDS INPUT]` instead of invented facts; banned phrases (org list + built-in AI-tell list) detected deterministically and auto-rewritten. Blocked by open high-severity gaps (waivable).
6. **Self-scoring (4.6):** skeptical-reviewer scorecard, single highest-leverage fix first, deterministic compliance pass/fail.
7. **Refinement (4.7):** one instruction per revision; over-limit revisions auto-tighten once, else stay flagged.
8. **Export (4.8), GATE 2:** Word (.docx), Markdown, portal paste-in .txt with per-field counts, JSON form-field map. Export refuses over-limit/banned-phrase content. Nothing auto-submitted.
9. **Voice (4.1):** `POST /api/writer/voice/analyze` extracts style guidelines + banned phrases from writing samples onto the shared profile.
10. **Logging (S8):** rotating file logs at ~/logs/grantfinder/, every AI call logged (correlation ID, tokens, latency, cost), debug-bundle endpoint returns paste-ready markdown, /logs/recent in-app surface.

### Technical Details
- New: `backend/models/writer_schemas.py`, `backend/services/writer_service.py` (7 AI stages), `backend/services/writer_export.py`, `backend/routers/writer.py` (15 endpoints), `frontend/src/app/writer/page.tsx`, `docs/grant-writer.md`
- Modified: `backend/models/schemas.py` (profile writer extension: voice_profile, evidence, team_members, collaborations, validators, in_kind_resources, prior_grants_detail, financial_capacity), `backend/state.py`, `backend/main.py` (file logging), `frontend/src/lib/api.ts`, `frontend/src/app/dashboard/page.tsx` (Write Application button), `CLAUDE.md` (writer module notes per PRD), `backend/.env.example`
- PRD stack adaptation: PRD assumed Node/Firebase; built on the real FastAPI/Next.js stack per the PRD's own "extend reality" instruction. Firestore collections → Pydantic + in-memory stores.

### Current Status
- ✅ 16-check offline end-to-end pipeline test passes (mocked AI): gates, gap blocking, intake round-trip → profile enrichment, voice enforcement, unsupported-claim flagging, over-limit auto-tighten, all 4 export formats, debug bundle
- ✅ All 41 API routes registered; backend compiles; new frontend files typecheck clean
- ✅ Found + fixed a real JSON-parser bug via the test (array responses were mis-parsed as their first object)
- 🚧 AI prompt quality not yet validated with a live Claude API key
- ❌ Same pre-existing legacy-page build failures as before (untouched)

### Branch Info
- Branch: `claude/grant-finder-review-0urze2` (same branch as the discovery work)

### Decisions Made (PRD open questions answered by reality — see session summary)
- Stack: real FastAPI/Python + in-memory, not assumed Node/Firebase (PRD Q1/Q2)
- Module location: backend routers/services + `frontend/src/app/writer` (Q3)
- Grounding: direct context slices, no vector store (Q4 recommendation accepted)
- Rubric inference: infer + flag + human review (Q5 recommendation accepted)
- Honesty ledger: defaults to naming-and-framing weaknesses (Q6 — flagged for Chris)
- Gates: strategy, intake (copy-paste only), export (Q7 confirmed set)
- Intake mode: copy-paste email packets, v1 (Q8 recommendation accepted)
- `sfw npm install` not available in this environment — plain npm used; flagged

### Next Steps
1. Live-key validation run of the full writer pipeline (prompts untested against real Claude)
2. Persistence (Supabase) — writer state is in-memory like everything else
3. Voice profile UI (endpoint exists; no UI to paste samples yet)
4. Decide honesty-ledger policy default (PRD Q6 — values call)

---

## 2026-07-10 — Comprehensive Grant Discovery Engine

### What We Built
The product previously had NO grant discovery — grants only entered via a user-uploaded Excel, and several context inputs were silently discarded before matching. This session added a discovery engine and repaired the matching pipeline:

1. **Starter grant database** (`backend/data/seed_grants.json`): 24 curated grants (national Catholic funders, secular grants faith-based orgs qualify for, TX foundations) + 8 foundations to monitor. Loaded via `POST /api/discovery/seed`.
2. **Grants.gov integration** (`POST /api/discovery/grants-gov`): live search of the free federal Search2 API; keywords derived from the org profile. Verified live — found the real FY2026 Nonprofit Security Grant Program.
3. **AI web discovery** (`POST /api/discovery/web-search`): Claude + server-side web search tool finds current grants tailored to the profile, using the user's own API key. Instructed to never invent grants/deadlines.
4. **Matching pipeline fixes**:
   - `submit-questionnaire` previously threw away ALL answers (`pass` stub) and free-form text — now stored verbatim on the profile and mapped to structured fields, and fed into scoring
   - Category 5 foundations were never matched — now converted to opportunities and scored
   - Deterministic hard filters (TX-only geo, CLOSED, expired deadlines) applied in code before AI scoring, per spec 5.2
   - Every grant guaranteed a match entry (AI-skipped grants get "review manually" fallback)
   - Batches scored in parallel (semaphore of 4) instead of sequentially
5. **Website scan** now crawls homepage + up to 5 grant-relevant internal pages (/about, /school, /ministries, /news...) instead of one page.
6. **Dashboard step 2** redesigned: three discovery buttons + optional Excel upload; can continue with discovered grants only.
7. **Model updated**: `claude-sonnet-4-20250514` (deprecated, retires June 2026) → configurable `CLAUDE_MODEL` setting, default `claude-sonnet-5`.

### Technical Details
- New: `backend/services/discovery_service.py`, `backend/routers/discovery.py`, `backend/data/seed_grants.json`, `docs/grant-discovery.md`
- Modified: `backend/models/schemas.py` (Grant.source/eligibility_notes/funds_for; Profile.questionnaire_answers/free_form_notes; Discovery models), `backend/services/ai_service.py`, `backend/routers/processing.py`, `backend/config.py`, `backend/main.py`, `frontend/src/lib/api.ts`, `frontend/src/app/dashboard/page.tsx`
- Dedup on normalized grant_name+funder; all discovery is additive/idempotent

### Current Status
- ✅ Backend compiles, app imports, all 26 routes registered (verified via OpenAPI)
- ✅ Seed load + dedup + live Grants.gov search tested end-to-end
- ✅ Deterministic prefilter unit-tested (6 cases, all correct)
- ✅ Changed frontend files typecheck clean
- ❌ Pre-existing: legacy pages (setup/context/results/profile/auth-callback) reference an API layer that doesn't exist — `tsc` fails on them (was broken before this session). `next build` will fail until they're deleted or rewritten.
- 🚧 AI web discovery not runtime-tested (needs a real Claude API key)
- 🚧 Storage still in-memory (grants/profiles lost on restart) — Supabase migration still pending

### Branch Info
- Branch: `claude/grant-finder-review-0urze2`

### Decisions Made
- Model default `claude-sonnet-5` (spec names Sonnet-tier; <$2/session cost target), configurable via `CLAUDE_MODEL` env var
- Seed data uses "Check website"/"Varies" for deadlines/amounts that change frequently — never fabricate dates
- Foundations matched as pseudo-grants rather than a separate results section (simpler, no frontend changes needed)
- Left the dead legacy frontend pages in place (flagged, not deleted) — deleting user code is a scope decision for Chris

### Next Steps
1. Test AI web discovery end-to-end with a real API key
2. Delete or rewrite the dead legacy frontend pages so `next build` passes
3. Persist to Supabase (grants, profiles, match results are in-memory)
4. Grant writer PRD (v2.0): data model is ready — Grant.eligibility_notes/funds_for + verbatim questionnaire answers give the writer its raw material

### Questions/Blockers
- None blocking; web discovery needs a real key to validate

---


## 2025-02-02 — Spec V2_6
**Source:** `grantfinder-spec-v2_6-2025-02-02.txt`

### What Was Accomplished
- Updated project progress tracking with completed tasks
- Updated project progress tracker with completed setup tasks
- Updated project todo list with completed tasks and progress
- Marked security fixes completed and created state management module
- Completed security fixes and reorganized router imports

### Technical Details
**Files Modified/Created:**
- `Next.js`
- `__init__.py`
- `ai_service.py`
- `api.ts`
- `auth.py`
- `config.py`
- `document_processor.py`
- `excel_parser.py`
- `export.py`
- `globals.css`
- `grants.py`
- `init.py`
- `main.py`
- `package.js`
- `page.ts`

**Key Commands:**
- `npm install`
- `npm run`
- `pip install`

### Issues/Notes
- Build failed due to Google Fonts connection error
- The build failed due to network issues with Google Fonts. Let me update to use system fonts instead.
- Built Next.js frontend successfully without errors
- User: any bugs or security issues as far as you can tell?
- Claude: Let me review the codebase for bugs and security issues.

---

## 2025-02-02 — General
**Source:** `grantfinder-2025-02-02.txt`

### Work Done
- [Checked git status and found recently created markdown file]

### Technical Details
**Files Modified/Created:**
- `CLAUDE.md`
- `SKILL.md`
- `claude.md`

**Key Commands:**
- `git status`

### Issues/Notes
- Blocking issue: I cannot find any CLAUDE.md file or content to implement.

---

## 2025-02-01 — General
**Source:** `grantfinder-2025-02-01.txt`

### What Was Accomplished
- Updated project progress tracking with completed database models task
- Updated project todo list with completed tasks and progress

### Technical Details
**Files Modified/Created:**
- `Next.js`
- `ai_service.py`
- `config.py`
- `document_service.py`
- `grant_service.py`
- `main.py`
- `matching_service.py`
- `organizations.py`
- `page.ts`
- `website_service.py`

**Key Commands:**
- `npm install`
- `npm packages`
- `npm run`
- `pip install`

### Issues/Notes
- Backend dependencies installed. Now let me try running the backend to check for import errors.
- Backend imports work. Let me start the backend server and check for runtime issues.
- Started backend server, identified startup error in routing
- Backend starts successfully. Now let me check the frontend for issues.
- 1. Backend - Python f-string syntax error (organizations.py:183,195)

---
