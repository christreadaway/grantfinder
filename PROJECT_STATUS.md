# GrantFinder - Project Status

> **Repository:** `github.com/christreadaway/grantfinder`
> **Category:** School
> **Local Path:** `~/grantfinder/`

## Overall Progress: ~80% — discovery+scoring MVP plus the full GrantWriter module

## What's Working
- **Discovery:** starter database (24 grants + 8 foundations), live Grants.gov federal search, AI web discovery, Excel upload — all merging with dedup
- **Matching:** deterministic geo/deadline hard filters, parallel AI scoring, full-context scoring (questionnaire answers, free-form notes, foundations included), coverage guarantee
- **GrantWriter (new, complete pipeline):** "Write Application" handoff from match results → grant spec enrichment → fit/gap analysis with honesty ledger → strategy gate → stakeholder intake packets (answers enrich the shared profile) → voice-enforced evidence-backed drafting → rubric self-scoring → instruction-based refinement → export (Word/Markdown/portal-text/form-map) with hard format enforcement
- **Logging:** rotating file logs (~/logs/grantfinder/), per-AI-call cost/token/latency logging with correlation IDs, paste-ready debug bundles
- Verified: 41 API routes registered; 16-check offline writer pipeline test passes; changed frontend files typecheck clean

## What's Broken
- Legacy frontend pages (`setup/`, `context/`, `results/`, `profile/`, `auth/callback`) still reference nonexistent API functions — `next build` fails on them (pre-existing; delete or rewrite)
- Old PDF export endpoint is a stub; dashboard matching terminal is simulated

## What's In Progress
- Writer + web-discovery prompts implemented but not yet validated with a live Claude API key

## Tech Stack
- Backend: Python FastAPI, AsyncAnthropic (CLAUDE_MODEL env, default `claude-sonnet-5`), httpx, BeautifulSoup, openpyxl, python-docx
- Frontend: Next.js 15 + TypeScript + Tailwind
- Storage: in-memory (Supabase planned)

## Next Steps
1. Live-key validation of the writer pipeline and AI web discovery; then merge branch to main
2. Delete/rewrite dead legacy frontend pages so the production build passes
3. Persist to Supabase (grants, profiles, applications, drafts all in-memory)
4. Voice profile UI + decide honesty-ledger policy default (PRD Q6)

## Blockers
- None

## Last Session
- **Date:** 2026-07-10
- **Branch:** `claude/grant-finder-review-0urze2`
- **Summary:** Built the complete GrantWriter module per the Application Writer PRD: 15 new API endpoints, 7 purpose-built AI stages, human approval gates, hard format/voice/fabrication rules enforced in code, 4 export formats, full logging with debug bundles, and the writer UI wired from match results. Earlier the same day: grant discovery engine + matching pipeline fixes.
