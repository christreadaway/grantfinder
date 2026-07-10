# GrantFinder - Project Status

> **Repository:** `github.com/christreadaway/grantfinder`
> **Category:** School
> **Local Path:** `~/grantfinder/`

## Overall Progress: ~70% of v1.0 (discovery + scoring MVP)

## What's Working
- Backend API (FastAPI): auth (Google OAuth + JWT), grant Excel upload/parsing, website scanning (multi-page crawl), AI questionnaire, document extraction (PDF/DOCX/TXT), grant matching with probability scoring, CSV/Markdown export
- **Grant discovery (new)**: built-in starter database (24 grants + 8 foundations), live Grants.gov federal search, AI web discovery via Claude web search — all merge with dedup
- Matching pipeline: deterministic geo/deadline hard filters, parallel AI scoring, questionnaire answers + free-form notes + foundations now included, every grant guaranteed a scored entry
- Frontend dashboard wizard (7 steps) including new discovery step
- Verified: backend imports clean, 26 API routes live, Grants.gov integration returns real opportunities, prefilter unit-tested

## What's Broken
- Legacy frontend pages (`setup/`, `context/`, `results/`, `profile/`, `auth/callback`, `useAuth`, `FileUpload`) reference API functions that don't exist — `tsc`/`next build` fail on them (pre-existing; these belong to an abandoned earlier frontend generation and should be deleted or rewritten)
- PDF export is a stub (silently returns Markdown)
- Dashboard matching terminal is simulated (setTimeout logs), not real SSE

## What's In Progress
- AI web discovery implemented but not yet runtime-tested with a real Claude API key

## Tech Stack
- Backend: Python FastAPI, AsyncAnthropic (model configurable, default `claude-sonnet-5`), httpx, BeautifulSoup, openpyxl
- Frontend: Next.js 15 + TypeScript + Tailwind
- Storage: in-memory (Supabase planned)

## Next Steps
1. Validate AI web discovery with a real API key; then merge branch to main
2. Delete/rewrite dead legacy frontend pages so the production build passes
3. Persist grants/profiles/results to Supabase (everything is lost on restart)
4. Write grant writer PRD (v2.0) — schema groundwork done (eligibility_notes, funds_for, verbatim questionnaire answers)

## Blockers
- None

## Last Session
- **Date:** 2026-07-10
- **Branch:** `claude/grant-finder-review-0urze2`
- **Summary:** Added the grant discovery engine (starter database, Grants.gov, AI web discovery), fixed the matching pipeline (questionnaire answers/free-form/foundations were being discarded), added deterministic geo/deadline filtering, multi-page website crawl, parallel scoring, and discovery UI in the dashboard.
