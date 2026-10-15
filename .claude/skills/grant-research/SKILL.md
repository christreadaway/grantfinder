---
name: grant-research
description: Re-verify and expand GrantFinder's starter grant database (frontend/src/server/data/seed_grants.json) against funders' own websites - deadlines, amounts, eligibility, whether Catholic schools may apply, new programs - then test and push it on a review branch. A scheduled task runs it monthly; run it by hand any time with /grant-research.
---

# Grant research (monthly refresh of the starter database)

The starter database is what every GrantFinder user sees first, so this job is about accuracy:
every fact checked on the funder's own site this run, nothing from memory, nothing a Catholic
school can't apply for. Work in this order and don't skip steps.

## 0. Set up
```bash
cd ~/grantfinder 2>/dev/null || cd /home/user/grantfinder
git fetch origin main
RUN=$(TZ=America/Chicago date +%Y-%m-%d)          # today's date in Texas
BRANCH="grant-research/${RUN:0:7}"                # e.g. grant-research/2026-11
git checkout -B "$BRANCH" origin/main
RESEARCH="${TMPDIR:-/tmp}/grant-research-$RUN"    # or your scratchpad directory
mkdir -p "$RESEARCH"
```
Read `tools/grant-research/BRIEF.md` (the rules every research agent follows),
`frontend/src/server/data/seed_grants.json` (the current database) and
`tools/grant-research/excluded.json` (programs already found not open to Catholic schools; don't re-add them).

## 1. Research with parallel agents (background, all launched in one message)
Split the work so each agent has a manageable load (about 20 grants each):

- **Verify agents** (one per ~20 existing grants, grouped by category). Each gets: today's date,
  the path to BRIEF.md, its exact list of grant names, and its output file
  `$RESEARCH/verify-<n>.json`. Task: re-check every listed grant on the funder's site and return
  the full record with `action` keep/update/remove (+ `action_reason`), rolling past deadlines
  forward to the next cycle, and `renamed_from` when the funder renamed the program. Each record
  keeps a `funder_intel` track record (BRIEF.md "Funder intelligence"): refresh it when its `as_of`
  is more than six months old, when the funder has published a new annual report, grants list or
  Form 990 since, or when it announced a change (new focus, bigger or smaller awards, a program
  ending); otherwise copy it unchanged. The first verify agent also re-checks the `foundations`
  list and returns it as `"foundations"`.
- **Discovery agents** (four): Catholic funders (national and Texas Catholic foundations, religious
  orders, fraternal societies, diocesan foundations), Texas funders (statewide, Austin / Central
  Texas, state programs open to private schools), national (corporate, foundation and federal
  programs open to private religious schools, including ESSA equitable services and nutrition
  programs), and AI in education (funders of AI literacy, teacher AI training, classroom AI pilots
  and AI / computer science curricula that private religious schools or their teachers can apply
  to; every record gets the `ai` tag). Each gets: today's date, BRIEF.md, the full list of current grant names AND every name
  in excluded.json (skip all of them), a target of 10-20 NEW verified programs, each with a
  `funder_intel` track record, and its output file `$RESEARCH/new-<area>.json`.

Tell every agent: today's date, "follow BRIEF.md exactly", "verify on the funder's own site this
session", "write only your output file", "validate the JSON before you finish".

## 2. Merge and validate
```bash
python3 -I tools/grant-research/merge_seed.py "$RESEARCH" --today "$RUN" \
  --changelog docs/grant-research-log.md --excluded tools/grant-research/excluded.json --dry-run
```
Read the whole report. For every `UNUSABLE`, `MISSING` or `warn` line, fix the research (ask the
responsible agent with SendMessage, or check the funder's site yourself) and run the dry run again.
`NOT RE-VERIFIED` grants were kept unchanged: verify them yourself or leave them for next month and
say so. Then run it once more without `--dry-run`.

Sanity checks before going on:
- The Kenedy Memorial Foundation grant is still present (its deadline is the funder's stated date).
- The database did not shrink by more than 15% unless every removal has a clear reason.
- Fetch 5 random records' `url`s yourself and confirm the deadline and amount match the page.
- `git diff --stat` touches only seed_grants.json, docs/grant-research-log.md and tools/grant-research/excluded.json.

## 3. Test
```bash
bash tests/engine/run_all.sh
E2E_JOB_MODE=direct bash tests/e2e/run_e2e.sh
```
Both must pass. The tests read the starter count from the seed file; if a test names a grant that
was removed (tests/e2e/lib/fixtures.cjs SCORES, grants.test.mts), point it at another grant that
still exists. Never weaken or skip a check to get green.

## 4. Docs
Update any doc that states the number of starter grants (`grep -rn "starter" --include=*.md .`),
and add one line to SESSION_NOTES.md (top entry) and PROJECT_STATUS.md ("Starter database refreshed
<date>: N grants").

## 5. Commit and push (review branch; the owner merges on GitHub)
```bash
git add frontend/src/server/data/seed_grants.json docs/grant-research-log.md tools/grant-research/excluded.json SESSION_NOTES.md PROJECT_STATUS.md
git commit -m "Grant research $RUN: <N> grants (+<added>, -<removed>, <changed> changed)"
git push -u origin "$BRANCH"
```
Do not merge and do not open a pull request unless the owner asked for one. Finish with a short
summary: counts, notable changes (new programs, removed programs and why, deadline changes in the
next 60 days), anything not verified, and the review link
`https://github.com/christreadaway/grantfinder/compare/main...$BRANCH`.

After the owner merges and Netlify deploys, the app tells each user "The starter database was
updated" and **Load Starter Database** refreshes their copy in place (same grant ids, so
applications and results keep working).
