# GrantFinder - Project Status

**Last updated:** 2026-10-15 (evening)
**Branch:** `claude/relaxed-curie-sj0zvu`, fast-forwarded to `main` on Oct 15
**Hosting:** Netlify only, on any plan. No Railway, Render, Vercel, or Supabase.

## Overall Progress: ~96% (deployed; real-key use is the remaining proof)

## What's Working
- **One app on Netlify, any plan:** the Next.js site in `frontend/` serves the website and the engine API (`/api/*`, TypeScript in `frontend/src/server/`). Every AI step runs inside a normal request (about a minute each), and long steps continue on their own in parts. The 15-minute background worker is optional (`GRANTFINDER_BACKGROUND_JOBS=true`). Netlify Blobs stores everything, so data survives deploys.
- **Claude calls go straight to Anthropic** with the person's own key (`https://api.anthropic.com`; Netlify's AI Gateway variables are ignored). Default model Claude Sonnet 5.5 (`claude-sonnet-5-5`).
- **Sign-in:** guest (`ALLOW_GUEST_LOGIN=true`) or Google. A network hiccup never signs anyone out.
- **Grant finder:**
  - Starter database of **97 verified grants** a Catholic school or parish in Texas can apply to (10 for AI in education) plus 7 foundations, each checked on the funder's own site on 2026-10-15: deadline and deadline notes, amount and typical award, current priorities, geography, who applies, religious eligibility, sources. Programs closed to Catholic schools are excluded and logged.
  - **Funder track record on every grant:** real past awards (recipient type and city, never names) and levels, record with Catholic schools, what it funds in practice, giving trend, announced outlook. Shown on every match, used by matching and the writer, exported to CSV and Markdown.
  - Grants.gov search, AI web discovery (skips funders that exclude religious organizations), Excel upload with the new columns (Religious Eligibility, Applicants, Region, Deadline Notes, Typical Award, Funding Priorities, Last Verified).
  - **Update my grants** refreshes each user's copy in place (same ids), retires ended programs, and keeps the user's own spreadsheet corrections.
  - **Monthly research** (`/grant-research`): scheduled for the 1st of each month at 5:54 AM Central (first run Nov 1, 2026); pushes a `grant-research/YYYY-MM` branch for review, never merges.
- **Matching:** hard filters in code before any AI call (funders excluding religious orgs, Texas-only or Texas-place grants for orgs outside Texas, closed, past deadline); AI scoring weighs who applies, the funder's own words and its track record; foundations already covered by a grant aren't scored twice.
- **Results:** Top picks, deadline sort, days-left badges, grant-fact chips, Funder track record, results recomputed against today's grants on every read (retired grants marked, newly ruled-out ones shown Not Eligible with their earlier score), exports (CSV, Markdown) and **Add Deadlines to Calendar** (.ics with reminders 2 weeks and 3 days before).
- **Organization profile:** website scan (with a by-hand fallback), questionnaire (answers never erased), documents (PDF, Word, text) and pasted text (funded proposals, comments, analyses), whose key facts become evidence the writer cites.
- **Application writer:** Application Checklist, requirements from text or a file, Funder History (now also fed by GrantFinder's own funder research), Add Materials, fit and gaps, strategy confirmation, stakeholder email packets, voice, drafting in parts, refine, hand edits with history, self-score, export (Word, Markdown, portal text, form map) with hard export rules.
- **Logging and debugging:** JSON-line logs (Netlify function logs; `~/logs/grantfinder/` locally), every AI call logged with tokens, cost and correlation ID; "Copy debug report" and "Copy debug bundle" give paste-ready markdown.

## Tests (all passing)
- Engine: `cd ~/grantfinder && bash tests/engine/run_all.sh` runs 13 suites (1,005 checks), then 7 of them again in direct job mode (797): 1,802 checks. `GRANTFINDER_TODAY=YYYY-MM-DD` in front runs them as if on another date (test mode only).
- Browser: `cd ~/grantfinder && E2E_JOB_MODE=direct bash tests/e2e/run_e2e.sh` runs 7 phases on a production build: 529 checks (509 in the phases, 20 harness checks), including the funder track record, the calendar, results that change after matching, and the starter update notice.

## What's Broken
- Nothing known.

## Known Limits
- Guest work lives in one browser; use Google sign-in to reach the same work from another computer.
- Each AI step gets about a minute on Netlify; Sonnet 5.5 fits comfortably.
- AI prompts are verified against a mock Claude in tests; real-key quality depends on the model.
- Light-mode styles for the new chips exist, but the app has no light-mode toggle yet.
- The starter database changes only when a research branch is merged and Netlify deploys.

## Next Steps
1. Redeploy `main`, then **Update my grants** (or Load Starter Database), run matching, and read the Funder track record on the top picks.
2. Add the deadlines to a calendar; start letters for Koch (window opens Jan 1, 2027) and Raskob (Jan 1-15, 2027).
3. Review and merge the first monthly research branch after Nov 1.

## Last Session (Oct 15, 2026, evening)
Expanded the starter database from 24 to 97 grants verified on funders' sites, added funder intelligence (past awards, levels, Catholic-school record, outlook) to every grant, built the monthly research skill and scheduled task, added AI-in-education funders, made results recompute against today's grants, added the calendar export, ran a multi-agent QA pass and fixed all 17 findings plus the final data cleanups, and updated every doc line by line.
