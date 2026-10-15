# GrantFinder - Project Status

**Last updated:** 2026-10-15
**Branch:** `claude/relaxed-curie-sj0zvu` (not merged to `main` yet)
**Hosting:** Netlify only. No Railway, Render, Vercel, or Supabase.

## Overall Progress: ~92% (all-Netlify app with discovery, matching, and the application writer)

## What's Working
- **One app on Netlify:** the Next.js site in `frontend/` serves the website and the engine API (`/api/*`, TypeScript in `frontend/src/server/`). A Netlify background function runs every Claude step (up to 15 minutes). Netlify Blobs stores users, encrypted API keys, grants, profiles, match results, and applications, so data survives deploys.
- **Sign-in:** guest sign-in (turn on with `ALLOW_GUEST_LOGIN=true`) or Google. Sessions last 30 days.
- **Grant discovery:** starter database (24 grants), Grants.gov search, AI web discovery, Excel upload.
- **Organization profile:** website scan (with a by-hand fallback when a site blocks robots), questionnaire, document uploads (PDF, Word, text).
- **Matching:** hard filters (location, deadline, status) plus AI scoring; grants Claude could not score are labeled plainly.
- **Application writer:** requirements, fit and gaps, strategy confirmation, stakeholder email packets, voice capture, drafting, refining, self-scoring, and export (Word, Markdown, portal text, form map). Export refuses over-limit or banned-phrase text.
- **Logging and debugging:** JSON-line logs (Netlify function logs; `~/logs/grantfinder/` locally), every AI call logged with tokens, cost, and correlation ID; "Copy debug report" and "Copy debug bundle" give paste-ready markdown.
- **Tests:** engine suites (`bash tests/engine/run_all.sh`, mock Claude, no key needed) and a real-browser test of the whole journey (`bash tests/e2e/run_e2e.sh`).

## In Progress (this session)
- Final round of fixes from a full product test: hand-editing sections, live limit and banned-phrase checks, saved questionnaire answers, document facts reaching the writer, never losing a guest session on a network blip, phone layout, accessibility.

## Known Limits
- Guest work lives in one browser; use Google sign-in to reach the same work from another device.
- AI prompts are verified against a mock Claude in tests; real-key quality depends on the model set in `CLAUDE_MODEL`.

## Next Steps
1. Merge `claude/relaxed-curie-sj0zvu` into `main` on GitHub, then deploy on Netlify (`docs/deployment.md`).
2. Set `SECRET_KEY` and `ALLOW_GUEST_LOGIN=true` in Netlify; optionally `CLAUDE_MODEL=claude-opus-5-5` for the best drafts.
3. Write the Kenedy application in the writer and export it.
