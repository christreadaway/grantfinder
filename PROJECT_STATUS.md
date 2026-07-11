# GrantFinder - Project Status

> **Repository:** `github.com/christreadaway/grantfinder`
> **Category:** School
> **Local Path:** `~/grantfinder/`

## Overall Progress: ~85% — discovery + matching + GrantWriter, deploy-ready

## What's Working
- **Discovery:** starter database (24 grants + 8 foundations), live Grants.gov federal search, AI web discovery, Excel upload — all merging with dedup
- **Matching:** deterministic geo/deadline hard filters, parallel AI scoring, full-context scoring (questionnaire answers, free-form notes, foundations included), coverage guarantee
- **GrantWriter (new, complete pipeline):** "Write Application" handoff from match results → grant spec enrichment → fit/gap analysis with honesty ledger → strategy gate → stakeholder intake packets (answers enrich the shared profile) → voice-enforced evidence-backed drafting → rubric self-scoring → instruction-based refinement → export (Word/Markdown/portal-text/form-map) with hard format enforcement
- **Logging:** rotating file logs (~/logs/grantfinder/), per-AI-call cost/token/latency logging with correlation IDs, paste-ready debug bundles
- **Deploy-ready:** `next build` passes (dead legacy pages removed, Tailwind v4 config fixed); `netlify.toml` + `backend/Procfile` + `docs/deployment.md` in place (Netlify frontend, Railway/Render backend)
- Verified: 41 API routes registered; 16-check offline writer pipeline test passes; full typecheck clean

## What's Broken
- Old PDF export endpoint is a stub; dashboard matching terminal is simulated
- In-memory storage: deployed data resets on backend restart (Supabase pending)

## What's In Progress
- Writer + web-discovery prompts implemented but not yet validated with a live Claude API key

## Tech Stack
- Backend: Python FastAPI, AsyncAnthropic (CLAUDE_MODEL env, default `claude-sonnet-5`), httpx, BeautifulSoup, openpyxl, python-docx
- Frontend: Next.js 15 + TypeScript + Tailwind
- Storage: in-memory (Supabase planned)

## Next Steps
1. Deploy: Railway backend, then Netlify frontend (see docs/deployment.md)
2. Live-key validation of the writer pipeline and AI web discovery; then merge branch to main
3. Persist to Supabase (grants, profiles, applications, drafts all in-memory)
4. Voice profile UI

## Blockers
- None

## Last Session
- **Date:** 2026-07-10
- **Branch:** `claude/grant-finder-review-0urze2`
- **Summary:** Three pushes in one day: (1) grant discovery engine + matching fixes, (2) complete GrantWriter module, (3) Netlify deployment readiness — dead legacy pages removed, production build green, netlify.toml/Procfile/deployment docs added. Policy decisions locked: honesty ledger on, three gates only.
