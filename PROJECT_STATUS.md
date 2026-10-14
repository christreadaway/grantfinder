# GrantFinder - Project Status

> **Repository:** `github.com/christreadaway/grantfinder`
> **Category:** School
> **Local Path:** `~/grantfinder/`

## Overall Progress: ~86% — discovery + matching + GrantWriter, deploy-ready

## What's Working
- **Discovery:** starter database (24 grants + 8 foundations), live Grants.gov federal search, AI web discovery, Excel upload — all merging with dedup
- **Matching:** deterministic geo/deadline hard filters, parallel AI scoring, full-context scoring (questionnaire answers, free-form notes, foundations included), coverage guarantee
- **Recurring deadlines:** "Annual: October 15" style deadlines resolve to the next occurrence, so yearly funders are never filtered out as expired and the writer's urgency flag fires each cycle
- **Kenedy Memorial Foundation record:** verified Oct 15 annual deadline, $50,000 soft cap, exclusions, and Exhibits A-H (2026-10-14)
- **GrantWriter (complete pipeline):** "Write Application" handoff from match results → grant spec enrichment → fit/gap analysis with honesty ledger → strategy gate → stakeholder intake packets (answers enrich the shared profile) → voice-enforced evidence-backed drafting → rubric self-scoring → instruction-based refinement → export (Word/Markdown/portal-text/form-map) with hard format enforcement
- **Logging:** rotating file logs (~/logs/grantfinder/), per-AI-call cost/token/latency logging with correlation IDs, paste-ready debug bundles
- **Deploy-ready:** `next build` passes; `netlify.toml` + `backend/Procfile` + `docs/deployment.md` in place (Netlify frontend, Railway/Render backend)
- **Real wiring:** document upload/extraction runs during matching; no fabricated demo-data fallbacks remain; results export (CSV/Markdown) and voice-profile capture UI wired
- Verified 2026-10-14: backend boots with 42 API paths (15 writer endpoints); 23-check deadline/seed verification passes

## What's Broken
- In-memory storage: deployed data resets on backend restart (Supabase pending)
- Old PDF export endpoint is a stub (CSV/Markdown export works and is wired in the UI)
- No committed automated tests: the 16-check writer pipeline test from 2026-07-10 was never added to the repo

## What's In Progress
- Writer + web-discovery prompts implemented but not yet validated with a live Claude API key

## Tech Stack
- Backend: Python FastAPI, AsyncAnthropic (CLAUDE_MODEL env, default `claude-sonnet-5`), httpx, BeautifulSoup, openpyxl, python-docx
- Frontend: Next.js 15 + TypeScript + Tailwind
- Storage: in-memory (Supabase planned)

## Next Steps
1. Commit a pytest suite (writer pipeline with mocked AI, deadline parsing, seed loading)
2. Live-key validation of the writer pipeline, using the Kenedy application as the benchmark case
3. Funder templates: store required portal sections and exhibits per funder so Grant Spec uses them verbatim
4. Deploy (Railway backend, Netlify frontend), then Supabase persistence

## Blockers
- None

## Last Session
- **Date:** 2026-10-14
- **Branch:** `claude/relaxed-curie-sj0zvu`
- **Summary:** Built a complete Kenedy Memorial Foundation application kit (outside the repo) for an Oct 15 deadline, recommending Phase 2 of the school's Notre Dame-funded AI formation work. In the repo: corrected the Kenedy seed record and added annual-deadline parsing, verified with 23 checks.
