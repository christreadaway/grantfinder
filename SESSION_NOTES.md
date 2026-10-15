# GRANTFINDER - Session History

**Repository:** `grantfinder`  
**Total Sessions Logged:** 4  
**Date Range:** 2025-02-01 to 2025-02-02  
**Last Updated:** 2026-10-15

This file contains a complete history of Claude Code sessions for this repository, automatically generated from transcript files. Sessions are listed in reverse chronological order (most recent first).

---

## 2026-10-15 (evening) — Grant Finder Shored Up: 97 Verified Grants, Funder Track Records, Monthly Research

### What We Built
Chris asked to "really shore up the grant finder part of the app": expand the grants, get amounts and eligibility, ignore anything Catholic schools can't apply for, research due dates and what each funder funds now; then research monthly from here, add funders of AI in education, and gather intelligence on what each grantor actually funded, at what levels, and what it has announced about the future. Test comprehensively, fix every bug low to critical, update the docs line by line.

1. **Starter database: 24 → 97 verified grants, plus 7 foundations** (`frontend/src/server/data/seed_grants.json`, `"updated": "2026-10-15"`). Every record was checked on the funder's own site this session by research agents: deadline (date, "Annual: Month D", Rolling or Check website) and deadline notes, amount and typical award, current priorities, geography, who applies, religious eligibility, eligibility notes, last verified, confidence, sources. Programs closed to Catholic schools, private schools or Texas are listed in `tools/grant-research/excluded.json` with the reason and never added. 10 grants are tagged `ai` (AI in education).
2. **Funder intelligence on every grant** (`funder_intel`): 3-8 real past awards (year, amount, recipient by TYPE and CITY only, purpose), award levels, what it funded in practice, its Catholic-school track record, giving trend, and its announced outlook, from grants lists, annual reports and Form 990 / 990-PF. Entitlement programs (ESSA, IDEA, E-Rate, school meals) carry a one-line note instead. Shown as a collapsed **Funder track record** on every match; fed to matching ("real giving outweighs stated priorities") and to the writer's funder research and funder profile; exported (CSV: Past Award Levels, Catholic School Track Record, Funder Outlook; Markdown rows).
3. **Grant facts everywhere:** results chips ("Religious orgs eligible", "Non-religious uses only", "Religious eligibility not stated", "Doesn't fund religious orgs"; "Teachers apply" / "Applies: diocese" when the school can't apply itself), the funder's own words, typical award, deadline details, what they fund now. Spreadsheet upload reads Religious Eligibility (clause by clause), Applicants, Deadline Notes, Typical Award, Funding Priorities, Region, Last Verified; a date cell's time goes into the deadline notes.
4. **Matching rules in code (no AI cost):** funders that exclude religious organizations, Texas-only grants (including a Texas county, diocese or other city) for organizations outside Texas, closed grants and past deadlines are Not Eligible before any Claude call. Foundations the grant list already covers aren't scored twice; foundations that take no applications aren't scored.
5. **Results always current:** saved results are recomputed against today's grants on every read (never rewritten): a retired grant is marked "No longer in your grant database." and moved last; a grant now ruled out shows Not Eligible with its earlier score; tier counts, Top picks, exports and the calendar follow. A not-eligible card offers "Write anyway" (asks first).
6. **Update my grants:** loading the starter database again refreshes each user's copy in place (same ids, so applications and results keep working), retires programs that ended (kept as CLOSED when an application uses them), and keeps any cells the user corrected with their own spreadsheet (`user_edited_fields`). The dashboard and Results say when a newer edition is out.
7. **Add Deadlines to Calendar:** an .ics file (RFC 5545) with an all-day event per upcoming due date of excellent, good, possible and shortlisted matches, reminders 2 weeks and 3 days before, stable ids so re-importing updates instead of duplicating.
8. **Monthly grant research, run here:** `/grant-research` skill (`.claude/skills/grant-research/SKILL.md`), agent rules in `tools/grant-research/BRIEF.md`, validation and merge in `tools/grant-research/merge_seed.py` (warns on relative time words, first-person wording, Texas places marked open to all, missing applicants, likely duplicates; writes `docs/grant-research-log.md`). A scheduled task runs it on the 1st of each month at 5:54 AM Central (first run Nov 1, 2026) and pushes a `grant-research/YYYY-MM` review branch; it never merges.
9. **Comprehensive QA with multiple agents:** 17 findings fixed, including the critical one (saved results kept offering retired grants), foundation duplicates scored twice, Texas-place grants not ruled out, a refresh overwriting the user's own corrections, label accuracy, calendar and export gaps, plurals, accessibility names and parsing edge cases. Final pass fixed two stale "now"/"currently" outlooks, one "recently", one school-specific note and two "By my count" phrasings in the data, and a dashboard comment that described behavior the code didn't have.

### Technical Details
- Types: `GrantBase` optional facts, `ReligiousEligibility`, `ApplicantType`, `FunderIntel`, `PastAward`, `GrantDetails` (`frontend/src/server/types.ts`); lenient parsing in `frontend/src/server/grantDetails.ts`; `texasOnlyGeography` and `deterministicPrefilter` in `services/ai.ts`; `withGrantDetails` / `currentMatchResults` in `routes/processing.ts`; `refreshSeedGrants` in `services/discovery.ts`; `matchesIcs` / `calendarMatches` in `services/exportResults.ts`; UI in `frontend/src/app/dashboard/page.tsx` (`GrantFacts`, `FunderTrackRecord`, `StarterUpdateNotice`).
- `GRANTFINDER_TODAY=YYYY-MM-DD` (test mode only) runs every suite as if on another date; tests no longer hard-code dates that expire.
- New suites: `finder` (144), `finder-parsing` (82), `finder-results` (84).

### Current Status
- ✅ Engine: 1,802 checks (13 suites, 1,005 checks, then 7 again in direct job mode, 797)
- ✅ Browser (`E2E_JOB_MODE=direct`): 529 checks, 0 failures (11 new: funder track record, entitlement note, export columns)
- ✅ Docs updated line by line: CLAUDE.md, BUSINESS_SPEC, PRODUCT_SPEC, docs/grant-discovery.md, docs/grant-template-format.md, docs/grant-writer.md, docs/engine.md, READMEs, CONTRIBUTING, tests/e2e/README.md, the skill and BRIEF
- 🚧 Light-mode styles for the new chips exist, but the app has no light-mode toggle yet

### Branch Info
- Branch `claude/relaxed-curie-sj0zvu`, pushed and fast-forwarded to `main` (Chris allowed pushing to `main` for this work). Netlify deploys from `main`.

### Decisions Made
- Recipients in funder intelligence are described by type and city only, never by name (PII rule), and every number names its source year.
- "Religious orgs eligible" replaces "Catholic schools eligible": the funder allowing religious organizations does not mean every other rule fits a Catholic school.
- Saved results are never rewritten; today's view is computed on read, so nothing is lost if a grant comes back.
- The monthly research pushes a review branch only; Chris merges on GitHub.

### Next Steps
1. Redeploy, sign in, click **Update my grants** (or Load Starter Database), run matching, and read the Funder track record on the top picks.
2. Calendar the near-term deadlines from **Add Deadlines to Calendar**; the biggest-fit funders by track record are Kenedy (Austin-area Catholic schools got $7,000-$20,000 in 2024, most $15,000), Koch (Jan 1 - May 1 letters), Raskob (Jan 1-15 and Jun 1-15 windows) and the state's Nonprofit Security Grant program.
3. Review the first monthly research branch after Nov 1 and merge it on GitHub.

### Questions/Blockers
- None.

---

## 2026-10-15 (afternoon) — First Netlify Deploy: AI Gateway Key Fix, Sonnet 5.5, Paste Text as a Document

### What We Built
- Merged `claude/relaxed-curie-sj0zvu` to `main` (PR #2) after re-running every gate on the exact commit (1,251 engine checks, typecheck, lint).
- First deploy failed on purpose (`SECRET_KEY is not set`); Chris added `SECRET_KEY` and `ALLOW_GUEST_LOGIN`.
- Then the API Key step said **Anthropic rejected this API key** for an active key. Root cause: Netlify's AI Gateway injects `ANTHROPIC_BASE_URL` (and `ANTHROPIC_API_KEY`) into every function on credit-based plans. The engine passed `ANTHROPIC_BASE_URL` to the SDK (and the SDK reads it by default anyway), so the key went to Netlify's gateway, which refused it with a 401. Anthropic never saw the key.
- Fix: every Claude client now gets `baseURL: https://api.anthropic.com` explicitly and `authToken: null`; `ANTHROPIC_BASE_URL` is ignored; tests use `GRANTFINDER_CLAUDE_BASE_URL`. The rejected-key message now quotes what Anthropic said, `api_key_rejected` is logged with host, status and request id, and `/api/health` plus the debug report show `claude_api`.
- Default model is now Claude Sonnet 5.5 (`claude-sonnet-5-5`, same $2 / $10 per million tokens as Sonnet 5). The engine already avoided everything Sonnet 5.5 rejects (thinking disabled, forced `tool_choice`, sampling params, `budget_tokens`); the mock Claude now refuses those with Anthropic's 400 so no suite passes if they creep in.
- **Or paste text** on the Documents step and in the writer's Add Materials card: pick what it is (a past proposal that was funded, funder or reviewer comments, an analysis, report or data, other notes), paste, **Add this text**. The page turns it into a `.txt` whose first line tells Claude what it is and uploads it like any document (`frontend/src/app/PasteMaterial.tsx`; no server change).
- Tests: engine 1,260 (693 + 567 direct); browser 453 (10 new paste checks).

### Technical Details
- `frontend/src/server/config.ts` (`ANTHROPIC_API_URL`, `anthropicBaseUrl()`, `anthropicHost()`), `claude.ts` (both clients, `verifyApiKey`, `apiErrorMessage`), `routes/system.ts` (health, debug report).
- Tests: `tests/engine/helpers.mts` and `tests/e2e/run_e2e.sh` set Netlify-style decoy `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; the mock Claude refuses any `Authorization` header; 4 new foundation checks. Against the old code those checks fail (6 failures); with the fix all pass.

### Current Status
- ✅ Engine: 1,255 checks (688 + 567 in direct job mode)
- ✅ Browser test with the decoys in place: see PROJECT_STATUS.md
- ✅ Docs: CLAUDE.md (Claude address rule, counts), docs/engine.md, docs/deployment.md (health example, troubleshooting row), READMEs, CONTRIBUTING, BUSINESS_SPEC

### Branch Info
- Branch `claude/relaxed-curie-sj0zvu`; Chris allowed pushing straight to `main` for this deploy.

### Decisions Made
- Use the person's own Anthropic key, not Netlify's AI Gateway: billing stays on the school's Anthropic account and nothing depends on Netlify AI features being on.
- Workaround for an older deploy: set `ANTHROPIC_BASE_URL=https://api.anthropic.com` in Netlify (Netlify never overrides a variable you set). Harmless after the fix.

### Next Steps
1. Redeploy `main`, check `/api/health` shows `"claude_api":"api.anthropic.com"`, paste the key, load the starter database.
2. Write and export the Kenedy application.
3. Browser coverage for the checklist, Top picks and uploads; Google sign-in; a real-key pass over every prompt.

### Questions/Blockers
- None.

---

## 2026-10-14 to 2026-10-15 — Everything on Netlify: TypeScript Engine, Product-Test Fixes, Writer Ready for the Kenedy Application

### What We Built
Chris asked to run GrantFinder entirely on Netlify (no Railway; none of his other apps use it), test it comprehensively with multiple agents, fix bugs from low to critical, and update every doc, so he can finish the Kenedy Memorial Foundation application (due Oct 15) in the app.

1. **Engine ported to TypeScript inside the Next.js app** (about 5,500 lines of Python FastAPI): API routes at `/api/*` (`frontend/src/server/`), Netlify Blobs storage. The Python `backend/` stays as reference only; `backend/Procfile` (Railway) deleted; Railway removed from all docs.
1b. **Runs on any Netlify plan** (Chris: "make this compatible with my netlify"). Legacy Netlify plans (accounts before Sept 4, 2025, e.g. legacy Starter) have no background functions, and a deploy containing one fails there. Default "direct" job mode runs each AI step inside a normal request (`POST /api/jobs/{id}/run`, Claude calls stop at 50 s of Netlify's 60); long steps continue automatically in parts (`__continue`: drafting sections, matching unscored grants). The 15-minute background function is optional (`GRANTFINDER_BACKGROUND_JOBS=true`, copied in by `frontend/scripts/netlify-functions.mjs`). If Netlify ever cuts a step short, the message says how many seconds it got and how to fix it.
2. **Background jobs that don't lose or double-pay work:** `202 {job_id}` + polling; one run per lock key (an identical request waits for the running one; a different request gets a plain 409); 45-second heartbeat, stale after 3 silent minutes; hard stop before Netlify's cutoff; the dashboard and writer pick running steps back up after a reload.
3. **Security:** 30-day HS256 sessions, AES-256-GCM saved API keys, sign-in rate limits, SSRF guard checked again at connect time (DNS rebinding), zip-bomb guard for .docx/.xlsx, CSV formula neutralization, API keys redacted from logs, spending-cap errors that name the billing page.
4. **Writer:** edit any section by hand (history kept, restore earlier versions); live limit and banned-phrase checks (whole words) that match export; [NEEDS INPUT] placeholders and unsupported claims shown before export; edited strategy saved before drafting; "Draft missing sections" after a partial failure; stakeholder requests only for uncovered gaps; plain status words; funder question, ranked fixes, strength leads shown; typed text survives a reload.
5. **Dashboard and sign-in:** a session is cleared only on a real 401 (a 502 or Wi-Fi drop shows "Try again"); no silent replacement of a guest session; guest sign-out warns; saved work reopens before any step shows; returning users land on Results; saved questions and answers come back; already-read documents listed; "Add to my profile only (no new matching)"; phone layout and accessibility fixes.
6. **Profile:** questionnaire answers merge (never erased); `GET /api/processing/questionnaire`; documents yield key facts (enrollment, percentages, prior grants) saved as evidence the writer drafts from; 60,000 characters read per document; the USCCB group ruling counts as 501(c)(3).
7. **Client:** polling survives Wi-Fi drops and sleep; plain-English network errors; Safari-safe downloads and copies; heavy file libraries load on first use.
7b. **Product pillars (Chris, Oct 15):** surface grants with deadlines and links (Top picks, sort by deadline, days-left badges); fast response (guidelines as a file, Add Materials in the writer); optimize the outcome with AI (Funder History: notes, files or web research become a funder profile with verified comparable grants, positioning and a suggested ask, feeding fit, drafts and score); show what's needed and the gaps (Application Checklist with due date, next step, section status, attachments to tick, gaps by owner).
8. **Docs** updated line by line (engine, writer, discovery, deployment, template format, READMEs, specs, CLAUDE.md tests line); unused legacy `components/`, `hooks/`, `types/` deleted.

### Technical Details
- Key files: `frontend/src/server/{app,auth,claude,jobs,store,net,zipguard,log}.ts`, `routes/`, `handlers/`, `services/`; `frontend/netlify/functions/grantfinder-jobs-background.mts`; `frontend/src/lib/{api,download}.ts`; pages in `frontend/src/app/`.
- Tests: `bash tests/engine/run_all.sh` (7 suites, mock Claude) and `bash tests/e2e/run_e2e.sh` (real browser, production build, 7 phases). Local Netlify runtime checked with `netlify build` + `netlify serve` against a copy of `frontend/` (background function, Blobs, document parsing, hand edits, Word export).
- Agents used: three builders (writer, dashboard/sign-in, processing engine), two reviewers, one docs agent; every change re-verified by the lead before commit.

### Current Status
- ✅ Engine: 1,251 checks (10 suites, plus 5 again in direct job mode); browser: 443 checks (direct job mode, including Funder History); local Netlify runtime (no background function): 57 API checks, including drafting continued across 4 requests, Funder History, guideline PDF upload and the checklist
- 🚧 Checklist, Top picks and uploads are covered by engine tests only (browser coverage next session)
- ✅ No Railway anywhere; Netlify is the only host
- ✅ Merged to `main` on Oct 15 (PR #2) after a final re-run on the exact commit: 1,251 engine checks, typecheck and lint clean
- 🚧 Not yet deployed; the real-key run happens when Chris uses it on the deployed site

### Branch Info
- Branch: `claude/relaxed-curie-sj0zvu` (pushed). Merge into `main` on GitHub, then Netlify deploys from `main`.

### Decisions Made
- Netlify only (website, engine, AI jobs, storage). No Railway, Render, Vercel or Supabase.
- Works on Chris's existing Netlify account without a plan change: no background function by default; Sonnet (`claude-sonnet-5`) recommended for one-minute steps.
- Guest sign-in for today (turn on with `ALLOW_GUEST_LOGIN=true`); guest work lives in one browser.
- Only an identical request attaches to a running step; anything else is told to wait.
- Banned phrases match whole words only ("compassionate" never trips "passionate").
- Export never includes unsaved edit-box text; it asks the person to save first.

### Next Steps
1. Merge the branch on GitHub; on Netlify set `SECRET_KEY`, `ALLOW_GUEST_LOGIN=true`, optionally `CLAUDE_MODEL=claude-opus-5-5`; deploy.
2. Write the Kenedy application in the writer: paste the guidelines, upload the school documents, confirm strategy, draft, edit, export Word.
3. After the deadline: Google sign-in so work follows Chris across computers; a real-key test pass of every prompt.

### Questions/Blockers
- CLAUDE.md's "Branch Rules" (work on main) contradicts "Git Branch Strategy" (new branch per session); sessions have followed the per-session branch.

---

## 2026-10-14 (later) — Web Deploy via Netlify: Fix Sign-In, Deploy Guards, Real Tests

> **Superseded:** Railway was dropped. The engine was rewritten in TypeScript and everything (website, engine, AI jobs, storage) now runs on Netlify alone. See the newest entry.

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

> **Superseded:** Railway was dropped. The engine was rewritten in TypeScript and everything (website, engine, AI jobs, storage) now runs on Netlify alone. See the newest entry.

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
