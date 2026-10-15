# GrantFinder - Project Status

**Last updated:** 2026-10-15
**Branch:** `claude/relaxed-curie-sj0zvu` (pushed; not merged to `main` yet)
**Hosting:** Netlify only, on any plan. No Railway, Render, Vercel, or Supabase.

## Overall Progress: ~95% (deploy-ready; real-key use is the remaining proof)

## What's Working
- **One app on Netlify, any plan:** the Next.js site in `frontend/` serves the website and the engine API (`/api/*`, TypeScript in `frontend/src/server/`). Every AI step runs inside a normal request (about a minute each), and long steps continue on their own in parts. No background function is needed, so legacy plans deploy fine; the 15-minute background worker is optional (`GRANTFINDER_BACKGROUND_JOBS=true`). Netlify Blobs stores everything, so data survives deploys.
- **Sign-in:** guest (turn on with `ALLOW_GUEST_LOGIN=true`) or Google. A network hiccup never signs anyone out; guest sign-out and session replacement ask first.
- **Grant discovery:** starter database (24 grants, Kenedy included), Grants.gov search, AI web discovery, Excel upload.
- **Organization profile:** website scan (with a by-hand fallback), questionnaire (answers never erased, saved questions reopen), documents (PDF, Word, text) whose key facts become evidence the writer cites.
- **Matching:** hard filters plus AI scoring; unscored grants are labeled honestly and finished in follow-up parts.
- **Application writer:** requirements, fit and gaps, strategy confirmation, stakeholder email packets, voice capture, drafting (in parts when needed), refine, hand edit with version history and restore, self-score, export (Word, Markdown, portal text, form map). Export refuses over-limit or banned-phrase text and never includes unsaved edits; placeholders and unsupported claims are flagged.
- **Logging and debugging:** JSON-line logs (Netlify function logs; `~/logs/grantfinder/` locally), every AI call logged with tokens, cost, and correlation ID; "Copy debug report" and "Copy debug bundle" give paste-ready markdown.

## Tests (all passing)
- Engine: `cd ~/grantfinder && bash tests/engine/run_all.sh` runs 9 suites (561 checks), then processing, grants, writer and regressions again in direct job mode (451 checks): 1,012 checks.
- Browser: `bash tests/e2e/run_e2e.sh` runs 7 phases on a production build: 437 checks, passing both in-process and with `E2E_JOB_MODE=direct` (how Netlify runs it).
- Netlify runtime (local `netlify build` + `netlify serve`, no background function): 47 API checks including document parsing, Excel upload, hand edits, Word export, and drafting continued across 4 requests.

## Known Limits
- Guest work lives in one browser; use Google sign-in to reach the same work from another computer.
- Each AI step gets about a minute on Netlify. `claude-sonnet-5` (the default) fits comfortably; slower models may need the background option.
- AI prompts are verified against a mock Claude in tests; real-key quality depends on the model.

## Next Steps
1. Merge `claude/relaxed-curie-sj0zvu` into `main` on GitHub, then deploy on Netlify (`docs/deployment.md`): set `SECRET_KEY` and `ALLOW_GUEST_LOGIN=true`.
2. Write the Kenedy application in the writer and export it to Word.
3. After the deadline: Google sign-in, a real-key pass over every prompt, and consider moving to a Netlify plan with background functions for longer steps.

## Last Session (Oct 14-15, 2026)
Ported the engine to TypeScript on Netlify, removed every Railway leftover, ran a full product test with multiple agents and fixed every finding (critical to low), added hand editing and live export checks, made the app run on any Netlify plan, and updated all docs.
