# GrantFinder - Project Status

**Last updated:** 2026-10-15
**Branch:** `claude/relaxed-curie-sj0zvu`, merged to `main` on Oct 15 (PR #2)
**Hosting:** Netlify only, on any plan. No Railway, Render, Vercel, or Supabase.

## Overall Progress: ~95% (deploy-ready; real-key use is the remaining proof)

## What's Working
- **One app on Netlify, any plan:** the Next.js site in `frontend/` serves the website and the engine API (`/api/*`, TypeScript in `frontend/src/server/`). Every AI step runs inside a normal request (about a minute each), and long steps continue on their own in parts. No background function is needed, so legacy plans deploy fine; the 15-minute background worker is optional (`GRANTFINDER_BACKGROUND_JOBS=true`). Netlify Blobs stores everything, so data survives deploys.
- **Claude calls go straight to Anthropic:** every AI call and the key check use `https://api.anthropic.com` with the person's own key. Netlify's AI Gateway variables (`ANTHROPIC_BASE_URL`, which made an active key look "rejected" on the first deploy) are ignored; `/api/health` shows `"claude_api":"api.anthropic.com"`.
- **Sign-in:** guest (turn on with `ALLOW_GUEST_LOGIN=true`) or Google. A network hiccup never signs anyone out; guest sign-out and session replacement ask first.
- **Grant discovery:** starter database (24 grants, Kenedy included), Grants.gov search, AI web discovery, Excel upload. Results show Top picks (strong matches with open deadlines, soonest first), sort by deadline, and days-left badges.
- **Organization profile:** website scan (with a by-hand fallback), questionnaire (answers never erased, saved questions reopen), documents (PDF, Word, text) whose key facts become evidence the writer cites.
- **Matching:** hard filters plus AI scoring; unscored grants are labeled honestly and finished in follow-up parts.
- **Application writer:** an Application Checklist at the top (days left, next step, section status, attachments to tick, gaps by owner); requirements from pasted text or a file; Funder History (pasted notes, files or web research become a funder profile with comparable past grants and a suggested ask, which shapes the fit, drafts and score); Add Materials; fit and gaps, strategy confirmation, stakeholder email packets, voice capture, drafting (in parts when needed), refine, hand edit with version history and restore, self-score, export (Word, Markdown, portal text, form map). Export refuses over-limit or banned-phrase text and never includes unsaved edits; placeholders and unsupported claims are flagged.
- **Logging and debugging:** JSON-line logs (Netlify function logs; `~/logs/grantfinder/` locally), every AI call logged with tokens, cost, and correlation ID; "Copy debug report" and "Copy debug bundle" give paste-ready markdown.

## Tests (all passing)
- Engine: `cd ~/grantfinder && bash tests/engine/run_all.sh` runs 10 suites (688 checks), then processing, grants, writer, regressions and checklist again in direct job mode (567 checks): 1,255 checks.
- Browser: `bash tests/e2e/run_e2e.sh` runs 7 phases on a production build: 443 checks with `E2E_JOB_MODE=direct` (how Netlify runs it), including Funder History. The checklist, Top picks and the file uploads are covered by engine tests, not yet by the browser test.
- Netlify runtime (local `netlify build` + `netlify serve`, no background function): 57 API checks including document parsing, Excel upload, hand edits, Word export, drafting continued across 4 requests, Funder History, the guidelines PDF upload and the checklist.

## Known Limits
- Guest work lives in one browser; use Google sign-in to reach the same work from another computer.
- Each AI step gets about a minute on Netlify. `claude-sonnet-5` (the default) fits comfortably; slower models may need the background option.
- AI prompts are verified against a mock Claude in tests; real-key quality depends on the model.

## Next Steps
1. Redeploy `main` on Netlify (`SECRET_KEY` and `ALLOW_GUEST_LOGIN=true` are set), check `/api/health` shows `"claude_api":"api.anthropic.com"`, then paste the Claude key and load the starter database.
2. Write the Kenedy application in the writer and export it to Word.
3. After the deadline: browser-test coverage for the checklist, Top picks and uploads; Google sign-in; a real-key pass over every prompt (including the funder research).

## Last Session (Oct 14-15, 2026)
Ported the engine to TypeScript on Netlify, removed every Railway leftover, ran a full product test with multiple agents and fixed every finding (critical to low), added hand editing and live export checks, made the app run on any Netlify plan, then built the product pillars Chris named: Top picks with deadlines, Funder History (match the application to what the grantor has funded), the Application Checklist (what's left and where the gaps are), and guideline/material uploads. All docs updated.
