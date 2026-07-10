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
- **Details:** Check repo for current implementation

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
Last Updated: February 16, 2026


## GrantWriter Module (Application Writer)
- **Where it lives:** `backend/routers/writer.py`, `backend/services/writer_service.py`, `backend/services/writer_export.py`, `backend/models/writer_schemas.py`, `frontend/src/app/writer/`. Full docs: `docs/grant-writer.md`.
- **Single source of truth:** the writer READS and EXTENDS the existing org profile (`state.profiles_db`) and grant records (`routers/grants.grants_db`). Never duplicate them. An application is just `{user, grant_id}` + writer artifacts.
- **AI orchestration map (one purpose-built prompt per stage):** Extract (`grant_spec_v1`, `voice_profile_v1`) → Map (`fit_gap_v1`) → Route (`intake_packets_v1`) → Draft (`section_draft_v1`) → Score (`self_score_v1`) → Refine (`section_refine_v1`) → Enforce (`voice_enforce_v1`). All in `writer_service.py`.
- **Human approval gates (never bypass):** (1) strategy confirmation before drafting, (2) stakeholder emails are copy-paste only — never auto-sent, (3) export is an explicit user action — nothing is ever auto-submitted to a funder.
- **Hard rules in code:** never fabricate (unsupported claims get flagged); never export over-limit or banned-phrase content; high-severity gaps block drafting until answered/confirmed/waived.
- **Logging:** file logs at `~/logs/grantfinder/grantfinder.log` (daily rotation, 14 days). Every AI call logged with correlation ID, tokens, latency, cost. Debug bundle: `GET /api/writer/applications/{id}/debug-bundle` returns paste-ready markdown — look there first when something breaks. Set `LOG_LEVEL=debug` for verbose logs.
- **Model:** set via `CLAUDE_MODEL` env var (default `claude-sonnet-5`). Never hardcode.

## Branch Rules
Always work on the main branch. Do not create new branches unless explicitly asked. Commit and push all changes directly to main.

