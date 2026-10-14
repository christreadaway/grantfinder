# GrantFinder - Project Status

> **Repository:** `github.com/christreadaway/grantfinder`
> **Category:** School
> **Local Path:** `~/grantfinder/`

## Overall Progress: ~88% — discovery + matching + GrantWriter, ready to deploy (Netlify + Railway)

## What's Working
- **Discovery:** starter database (24 grants + 8 foundations), live Grants.gov federal search, AI web discovery, Excel upload — all merging with dedup
- **Matching:** deterministic geo/deadline hard filters, parallel AI scoring, full-context scoring (questionnaire answers, free-form notes, foundations included), coverage guarantee
- **Recurring deadlines:** "Annual: October 15" style deadlines resolve to the next occurrence, so yearly funders are never filtered out as expired
- **GrantWriter (complete pipeline):** "Write Application" handoff → grant spec → fit/gap with honesty ledger → strategy gate → intake packets → evidence-backed drafting → self-scoring → refinement → export (Word/Markdown/portal-text/form-map)
- **Sign-in:** Google, or guest sign-in when `ALLOW_GUEST_LOGIN=true` (off by default); the old client-side Demo Mode (which could never reach the API) is gone
- **Deploy readiness:** website on Netlify, engine on Railway; Netlify builds fail with plain-English fixes if the engine URL is missing or not https; landing page diagnoses an unreachable engine, missing sign-in setup, and expired sessions
- **Logging:** rotating file logs (~/logs/grantfinder/), Railway stdout logs, per-AI-call cost/token/latency with correlation IDs, paste-ready debug bundles, `[GrantFinder]` browser console messages
- **Tests (committed):** `tests/e2e/run_e2e.sh` (cross-origin browser test, 25 checks, passing) and `backend/tests/check_deadlines.py` (23 checks, passing)

## What's Broken
- In-memory storage: data and sign-in sessions reset whenever the engine restarts, including every Railway deploy (Supabase pending)
- Old PDF export endpoint is a stub (CSV/Markdown export works and is wired in the UI)

## What's In Progress
- Deployment: guide ready (`docs/deployment.md`); needs Chris's Netlify, Railway, and Google Cloud accounts
- Writer + web-discovery prompts not yet validated with a live Claude API key

## Tech Stack
- Backend: Python 3.13, FastAPI, AsyncAnthropic (CLAUDE_MODEL env, default `claude-sonnet-5`), httpx, BeautifulSoup, openpyxl, python-docx — hosted on Railway
- Frontend: Next.js 16 + React 19 + TypeScript + Tailwind — hosted on Netlify
- Storage: in-memory (Supabase planned)

## Next Steps
1. Deploy: follow `docs/deployment.md` (Railway engine, Netlify website, CORS, Google sign-in)
2. Persistence so sessions and work survive engine restarts
3. Live-key run of discovery, matching, and the writer on the deployed site; extend the E2E test to cover them

## Blockers
- None in code; deployment needs account access

## Last Session
- **Date:** 2026-10-14
- **Branch:** `claude/relaxed-curie-sj0zvu`
- **Summary:** Built the Kenedy application kit (outside the repo), corrected the Kenedy record, added annual deadlines. Then made the app deployable via Netlify: replaced the broken Demo Mode with gated guest sign-in, added landing-page diagnostics and expired-session handling, Netlify build guards, Railway start-command hardening, a click-by-click deployment guide, and committed tests (25-check browser test, 23-check deadline test), all passing.
