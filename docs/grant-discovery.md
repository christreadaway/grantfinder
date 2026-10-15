# Grant Discovery

GrantFinder no longer depends solely on a user-uploaded Excel file. Grants can
enter the database from four sources, all merged with automatic deduplication
(matching on normalized grant name + funder):

| Source | Endpoint | Requires Claude API key | What it does |
|---|---|---|---|
| Excel upload | `POST /api/grants/upload` | No | User's own spreadsheet (5-category format, `.xlsx`, up to 4 MB). Merges into the database: a row matching a saved grant updates the cells it filled in; nothing is deleted |
| Starter database | `POST /api/discovery/seed` | No | Built-in list of 97 grants a Catholic school or parish in Texas can apply to (Catholic funders, Texas funders, and national programs open to private religious schools), each checked on the funder's own site on 2026-10-15, with the funder's track record (past awards and levels, record with Catholic schools, outlook), plus 7 foundations to monitor. Loading it again refreshes your copy (see "The starter database" below) |
| Grants.gov | `POST /api/discovery/grants-gov` | No | Runs as a job. Live search of the free Grants.gov Search2 API for open + forecasted federal opportunities. Keywords derive from the org profile (security concerns, facility needs, food pantry, school programs) or can be passed explicitly. If Grants.gov doesn't answer, the step fails with a clear message instead of reporting 0 grants. In direct mode (the Netlify default, about a minute per step) up to 4 keyword searches run at once, 10 seconds each at most, and a keyword that no longer fits is skipped and noted; with the background worker they run one after another, 30 seconds each at most. Each result has geography "National (federal)" and religious eligibility "unclear" (check the listing) |
| AI web discovery | `POST /api/discovery/web-search` | Yes | Runs as a job. Claude uses its server-side web search tool to find current grant opportunities tailored to the organization profile (plus an optional focus typed on the dashboard). Instructed to only report grants with real web evidence and to use "Check website" when a deadline can't be verified. It asks for the same facts the starter database has (deadline notes, typical award, funder priorities, geography, religious eligibility with the funder's own words, who submits the application) and to skip programs that exclude religious organizations, religious schools or private schools. A result marked excluded anyway is never saved, and the notes say how many were skipped. In direct mode Claude runs at most 3 web searches (8 with the background worker) and one continuation of a paused search, and is asked for 5-8 grants, so the step ends within its minute. Grants already listed when time runs out are kept; if none were, the step says so plainly and suggests a narrower focus |

`GET /api/discovery/sources` reports how many grants came from each source, plus
`starter`: `updated` (the date of the starter database this site carries), `loaded` (the
edition you last loaded) and `update_available` (true when you have starter grants from an
older edition).

## The starter database

`frontend/src/server/data/seed_grants.json` holds 97 grants and 7 foundations (10 of the grants
are tagged `ai`, for AI in education). It lists only grants a Catholic school or parish in Texas
can apply to. Programs that ended, are limited to another region, or are closed to parishes or
parish schools are left out. Its `"updated"` field is the date of the last research run
(2026-10-15).

Every starter grant has:

- `deadline`: "YYYY-MM-DD", "Annual: Month D", "Rolling" or "Check website", plus
  `deadline_notes` (cycles, letter-of-inquiry steps)
- `amount`, and `typical_award` when the funder publishes one
- `focus_areas`: the funder's current priorities
- `geography`: where applicants must be
- `applicants`: who submits the application (`school`, `parish`, `diocese`, `teacher`,
  `family`, `nonprofit`)
- `religious_eligibility`: `eligible`, `secular_purpose_only` (may apply, but the money can't
  pay for religious activity) or `unclear` (the funder doesn't say)
- `eligibility_notes`, `last_verified` (YYYY-MM-DD), `confidence` (`verified`, or `partial`
  when some facts couldn't be confirmed) and `sources` (the pages it was checked against)
- `funder_intel`, the funder's track record: 3-8 `past_awards` (year, amount, recipient by type
  and city only, never by name, purpose), `award_levels`, `funded_focus` (what it actually funded,
  which can differ from its stated priorities), `catholic_school_track_record`, `giving_trend`,
  `outlook` (anything announced about the future: bigger or smaller awards, a new focus, a final
  round, with the date announced), `as_of` and `sources`. Read from the funder's grants list,
  annual report and IRS Form 990 / 990-PF. Entitlement and formula programs (ESSA equitable
  services, school meals, E-Rate) have `applicable: false` and a one-line `note` instead.

In code the new fields are optional (`GrantBase` in `types.ts`), because uploaded and
discovered grants may not have them. `grantDetails.ts` reads them leniently from the seed file,
spreadsheets and Claude's answers. A grant can also keep `religious_eligibility_text` (the funder's
own words, from web discovery or a spreadsheet's Religious Eligibility column) and
`user_edited_fields` (the cells you changed with your own spreadsheet).

**Load Starter Database** refreshes your copy, so it is safe to click again:

- A starter grant you already have gets the new details in place. It keeps its id, so
  applications, shortlists and results keep working. A renamed program is found by its old
  name (`renamed_from` in the file).
- New starter grants are added, unless you already added the same grant and funder yourself
  (yours is kept).
- A starter grant that is no longer listed is removed. When an application uses it, or you
  changed it with your own spreadsheet, it is kept as CLOSED with a note saying why.
- Cells you changed with your own spreadsheet keep your values (a starter grant remembers them in
  `user_edited_fields`): a refresh never overwrites your corrections.
- Grants you added yourself (upload, Grants.gov, web discovery) are never changed.

The response adds `updated`, `retired` and `kept_user_changes` counts, and the notes say what
changed in full sentences ("Updated N starter grants with the latest deadlines and details.",
"Kept your own changes to N starter grants.", "Retired N grants no longer offered or not open to
Catholic schools: ...", "Also added N foundations to monitor."). Loading it again with nothing new
returns no notes. When this site carries a newer edition than the one you
loaded, the dashboard says "The starter grant database was updated [date]." with an **Update my
grants** button, on the Grant Database step and on the Results page.

**Monthly research.** The grant-research skill (`.claude/skills/grant-research/SKILL.md`; run it
by hand with `/grant-research`) re-checks every grant on the funder's site and looks for new ones
in four areas: Catholic funders, Texas funders, national programs open to private religious
schools, and AI in education (tag `ai`). Research agents follow `tools/grant-research/BRIEF.md`, which also has them refresh each funder's
track record when it is more than six months old or the funder has published a new grants list,
annual report or Form 990, or announced a change.
`tools/grant-research/merge_seed.py` validates and merges their work (it warns about relative
time words such as "currently" or "open now", in the grant and in the track record, a Texas-only
place marked open to all, a missing applicants list and likely duplicates) and writes
`docs/grant-research-log.md` and `tools/grant-research/excluded.json` (programs found closed to
Catholic schools, so they aren't added again). A scheduled task runs it on the 1st of every month
at 5:54 AM Central in a fresh Claude Code session (first run 2026-11-01). It pushes the branch
`grant-research/YYYY-MM` for review and never merges. The owner merges on GitHub, Netlify
deploys, and each user clicks **Update my grants**.

## Recommended flow

1. Load the starter database (instant, free).
2. Complete the profile (website scan, questionnaire, documents, free-form notes).
   If your website blocks automated reading, use "Enter the basics by hand" or
   "Skip to questions" on the Website step (it reads "Go to my questions" once
   Claude has written them); uploaded documents add the detail.
   To add documents later without matching again, use "Add to my profile only
   (no new matching)" on the Documents step. Text you can't upload as a file
   (a past proposal that was funded, comments, an analysis) goes in "Or paste
   text" there; it is read like a document.
3. Run Grants.gov search + AI web discovery — both use the profile to target
   the search, so they find more relevant grants after the profile exists.
4. Optionally upload your own Excel on top.
5. Run matching. Grants.gov and web discovery only add grants you don't
   already have, an upload also updates the grants it matches, and loading the
   starter database again brings its grants up to date (see above).

## Matching improvements that ship with discovery

- **Deterministic hard filters** (no AI cost, guaranteed): a grant whose
  `religious_eligibility` is `excluded` is Not Eligible ("this funder does not
  fund religious organizations or religious schools... No need to apply"),
  Texas-only grants are auto-disqualified for non-Texas orgs (`geo_qualified`
  "Yes - TX Only", or a `geography` that names only Texas or a Texas place
  such as a county, a diocese or another Texas city; `texasOnlyGeography` in
  `services/ai.ts`), and `CLOSED` grants and parseable past deadlines are
  marked not-eligible, all before any AI scoring.
- **Grant facts in the scoring prompt**: when a grant has them, Claude also
  gets its `geography`, `religious_eligibility` and `religious_eligibility_text`
  (the funder's own words), `applicants`, `deadline_notes`,
  `funder_priorities` (its `focus_areas`), `typical_award` and
  `funder_track_record` (the funder's track record), with how to read
  them: outside the geography means eligibility near 0; `secular_purpose_only`
  is judged on the organization's non-religious needs; `unclear` lowers
  completeness and the explanation says "confirm religious eligibility"; funder
  words that rule out religious schools mean eligibility near 0; a grant only a
  diocese, teachers or families apply for says so and lowers eligibility unless
  the profile shows that channel; an invitation-only program, or a window that
  closed with no next date, scores low on timing; real giving outweighs stated
  priorities (no grants to schools like this one, or a program that is ending,
  lowers the score; a record of funding similar Catholic schools raises it).
- **Full context scoring**: questionnaire answers (verbatim Q&A pairs),
  free-form notes, previous grants, and student count now feed the scoring
  prompt. Previously questionnaire answers and free-form text were discarded.
- **Answers are never erased**: answers are saved by question text and merged,
  so answering a new set of questions updates repeated questions in place and
  keeps every earlier answer (a blank answer changes nothing). The 501(c)(3)
  and food pantry fields change only on a clear yes or no; an answer that
  mentions the USCCB group ruling (or the Official Catholic Directory) counts
  as yes for 501(c)(3).
- **Foundations are matched**: Category 5 foundations are converted to
  monitorable opportunities and scored alongside grants. A foundation the grant
  database already covers (its name appears in a grant's funder or name) is
  skipped, so the same funder isn't scored twice, and so is one that takes no
  applications (it stays on the foundations list to monitor).
- **Coverage guarantee**: every grant in the database gets a match entry.
  Anything the AI couldn't score gets a neutral score with an explanation that
  starts "Not AI-scored:" and says why, instead of silently disappearing. A
  bad API key or an empty Anthropic balance stops matching with that message
  rather than producing placeholder scores.
- **Parallel scoring**: 10 grants per Claude call. In direct mode (the
  Netlify default: each part runs inside one request of about a minute),
  every batch is scored at once (up to 8 at a time), and a batch starts only
  while at least 25 seconds are left in the step. Grants the time didn't reach
  get an honest label ("Not AI-scored: matching ran out of time before Claude
  could score this grant (each step on this site can run for about a
  minute)..."), and the website then starts a follow-up part on its own
  (`POST /api/processing/match-grants/continue`) that scores just those
  grants and merges them into the same saved results, up to 12 parts. A part
  in which Claude scores nothing ends the run, and those grants keep their
  label. With the background worker, 4 calls run at a time in one step of up
  to 15 minutes; no new batch starts after 12 minutes and anything left is
  marked "Not AI-scored". Either way, a batch Claude couldn't score because of
  a passing problem (overloaded, rate limit, timeout, network) is tried once
  more, one batch at a time, when the wait and one more call still fit before
  it is labeled "Not AI-scored" (in direct mode a follow-up part tries it
  again too).
- **Documents feed the writer**: Claude reads up to the first 60,000
  characters of each uploaded document and returns its needs and signals plus
  up to 15 key facts a grant writer can cite (enrollment, percentages,
  outcomes, prior grants), in the document's own numbers and words. Every item
  and key fact is saved to the profile's evidence list, which the grant writer
  drafts from. Evidence is deduplicated by text (uploading the same document
  again adds nothing) and capped at 200 items: when a document pushes it over,
  the oldest document items go first, and items you or the writer added are
  never removed. In direct mode, if Claude is still reading a document when
  the step's minute ends, nothing is saved and the message names the file
  and suggests trying again or uploading a shorter version.
- **Deeper website scan**: the org's site is crawled (homepage + up to 5
  grant-relevant internal pages like /about, /school, /ministries, /news)
  instead of fetching just the single URL. Scanning the same addresses again
  while a scan runs joins that scan; scanning different (corrected) addresses
  starts a new scan, and once it has started the older scan is not saved to
  the profile. In direct mode the crawl stops in time to leave Claude most of
  the step's minute (about 35 of its 50 seconds), each page gets up to 10
  seconds, and pages it had no time for are noted; if Claude still can't
  finish reading in time, the scan says so and suggests trying again or
  "Enter the basics by hand".

## The Results page

- **Top picks** (at the top): up to 5 of your strongest matches (excellent or
  good) whose deadline is still open, soonest deadline first; when there are
  fewer than 5, possible matches fill in. Each says when it is due ("Due
  [date] · N days left", "Rolling", or "Check the funder's site"), its amount
  (and typical award) and the same chips as the match cards, with
  "Investigate" (opens the funder's page in a new tab; shown only for a real
  web address) and "Start application" (or "Open application" when one
  exists).
- **Sort by** "Best match" or "Deadline soonest" (open deadlines first, then
  rolling or unknown ones, then passed ones; ties by score), and **Hide not
  eligible**. Both are remembered in this browser.
- **Every match card** shows its next due date and a days-left badge (red
  within 14 days, amber within 45, "Last day", "Past deadline"; no badge for
  rolling or unknown deadlines).
- **Grant facts on each card**, for whatever the grant record has: chips for
  religious eligibility ("Religious orgs eligible", "Non-religious uses
  only", "Religious eligibility not stated", "Doesn't fund religious orgs"),
  who applies when your school or parish can't apply itself ("Teachers apply",
  "Families apply", "Applies: diocese", "Nonprofits apply"), geography, and
  "Verified [date]" or "Partly verified [date]"; then "Funder's words" (what
  the funder says about religious organizations, when the record has it),
  "Typical award", "Deadline details", "What they fund now" (the funder's
  priorities) and "Who can apply".
- **Funder track record** (collapsed under each card, with the award levels in
  its heading): "Catholic schools" (its record with Catholic K-12 schools),
  "Funded in practice", "Past awards" (year, amount, recipient type and city,
  purpose), "Giving trend", "What's ahead" (anything the funder announced),
  and when and from which sources it was researched. Entitlement programs show
  a one-line note instead.
- **Results that changed since matching**: a grant no longer in your database
  (retired by a starter refresh, or deleted) stays on the list, last, marked
  "No longer in your grant database.", and counts in no tier. A grant its
  current record now rules out (closed, deadline passed, the funder doesn't
  fund religious organizations, outside its area, a foundation that takes no
  applications) shows as Not Eligible with the reason and the score it had
  before. A not-eligible card offers "Write anyway", which asks you to
  confirm.
- **Exports**: "Export CSV", "Export Report (Markdown)" and "Add Deadlines to
  Calendar" (`POST /api/export`, formats `csv`, `md`, `pdf`, `ics`), all from
  the results as they stand today (see above). The CSV columns are Rank, Grant
  Name, Funder, Amount, Deadline, Score (%), Tier, Status, Category, Geo
  Qualified, Contact, URL, Explanation, Geography, Religious Eligibility,
  Deadline Notes, Typical Award, Funder Priorities, Eligibility Notes, Last
  Verified, Confidence, Past Award Levels, Catholic School Track Record and
  Funder Outlook; the Markdown report adds a row for each one a grant has
  (plus "Giving trend"). The calendar (`ics`) has an
  all-day event on each upcoming due date of your excellent, good and possible
  matches (and any you shortlisted), with reminders 2 weeks and 3 days before.
  Grants no longer in your database and not-eligible matches are left off.
  Each event's id is the grant id plus the date, so importing the file again
  updates the events instead of adding copies. When no grant has an upcoming
  date (rolling and "Check website" deadlines can't go on a calendar) the
  export answers 422 and says so.
- **Starter update notice**: when a newer starter database is out, the
  Results page shows "The starter grant database was updated [date]." with
  **Update my grants** (run matching again afterwards to score any new grants).
- **Computed on every read, never stored:** `GET /api/processing/match-results/latest`
  and `GET /api/processing/match-results/{session_id}` add to each match
  `next_deadline` (YYYY-MM-DD; "Annual: October 15" becomes the coming October
  15; null for rolling or unreadable deadlines), `days_left` (whole days from
  today, negative once passed, or null) and `deadline_passed`, counted for
  today in `GRANTFINDER_TIMEZONE` (Central time by default), so the countdown
  is right whenever the results are opened. Each match also shows its grant's
  current deadline, amount, link, status and grant facts, the removed and
  ruled-out matches described above (`grant_removed`, and `score_before` for a
  match ruled out on read), and tier counts recomputed to match
  (`withGrantDetails` and `currentMatchResults` in `routes/processing.ts`), so
  a refreshed starter database shows up in saved results and exports without
  matching again. The stored results are never rewritten.

## Data model additions (used by the grant writer)

`Grant` now carries `source`, `eligibility_notes`, and `funds_for` tags, plus
the optional grant facts described under "The starter database"
(`deadline_notes`, `geography`, `applicants`, `religious_eligibility`,
`religious_eligibility_text`, `focus_areas`, `typical_award`, `last_verified`,
`confidence`, `sources`, `funder_intel`). A match copies all of them except
`sources` (`GrantDetails` in `types.ts`). The grant writer reads the funder's
track record too: `funder_research_v1` and `funder_profile_v1` get it as
`grantfinder_funder_research`, and its past awards count as funder material
(`docs/grant-writer.md`).
`OrganizationProfile` now carries `questionnaire_answers` (verbatim Q&A) and
`free_form_notes`. These give an application-drafting feature (v2.0 PRD) the
raw material it needs: what the funder requires, and everything the user told
us about the organization. A document's extraction result also carries
`key_facts` (at most 15), which become profile evidence.

The questions Claude wrote are saved per user: `GET /api/processing/questionnaire`
returns them (404 "No questionnaire yet" before the first set), so the
dashboard shows them again after a reload, with earlier answers filled in,
without a new AI call. If Claude can't write the questions (overloaded, an
unreadable answer, or not finished within the step's minute), the standard
8-question set is used and saved instead.

## Configuration

Environment variables (Netlify: Site configuration > Environment variables):

- `CLAUDE_MODEL` (default `claude-sonnet-5-5`, Claude Sonnet 5.5) — used for all AI processing
- `GRANTS_GOV_API_URL` — optional override of the Grants.gov Search2 address
- `GRANTFINDER_BACKGROUND_JOBS=true` — optional, only for Netlify plans that
  include background functions: each step (matching, discovery, the website
  scan) can then run up to 15 minutes instead of about a minute
  (`docs/deployment.md`)

Constants in `frontend/src/server/config.ts`:

- `GRANTS_GOV_API_URL`, `GRANTS_GOV_MAX_RESULTS`
- `WEB_DISCOVERY_MAX_SEARCHES` — cap on web searches per discovery run with
  the background worker (8); direct mode uses `WEB_DISCOVERY_DIRECT` in
  `services/discovery.ts` (3 searches, one continuation, 5-8 grants)
- `WEBSITE_CRAWL_MAX_PAGES` — pages crawled per org website

Direct-mode matching settings live in `services/ai.ts`
(`MATCH_DIRECT_CONCURRENCY` 8, `MATCH_BATCH_ROOM_MS` 25 seconds,
`MATCH_MAX_PARTS` 12).

Code: `frontend/src/server/services/discovery.ts`, `services/excel.ts`,
`routes/grants.ts`, `routes/discovery.ts`, `handlers/discovery.ts`; the
starter database in `data/seed_grants.json`; grant facts in `types.ts` and
`grantDetails.ts`; profile building and matching in `services/ai.ts`,
`routes/processing.ts`, `handlers/processing.ts`; exports in
`services/exportResults.ts` and `routes/export.ts`; the Results page in
`frontend/src/app/dashboard/page.tsx`.
Tests: `tests/engine/grants.test.mts` (132 checks),
`tests/engine/processing.test.mts` (140 checks: website scan, questionnaire,
documents, matching, and the deadline fields computed when results are read), `tests/engine/direct-processing.test.mts` (20
checks: matching in parts, and the scan, Grants.gov, web discovery, documents
and questionnaire inside one-minute steps), `tests/engine/finder.test.mts`
(144 checks: reading the grant facts and the funder track record, the
starter refresh, the religious exclusion in matching and web discovery, the
results overlay, the calendar export, the CSV and Markdown columns, and the
new spreadsheet columns), `tests/engine/finder-parsing.test.mts` (82 checks:
religious eligibility read clause by clause and the funder's own words, who
applies, deadline dates and times, amounts, spreadsheet phrasings, your
corrections surviving **Update my grants**, and the seed notes) and
`tests/engine/finder-results.test.mts` (84 checks: the Texas-only rule,
foundation duplicates and monitor-only foundations, results computed on read
with removed and ruled-out matches and recomputed tiers, the exports built
from them, and the matching prompt's applicants and funder words).
`cd ~/grantfinder && bash tests/engine/run_all.sh` also runs the grants,
processing, finder and finder-results suites a second time in direct job mode. The suites
compute deadlines from today, and the engine honors
`GRANTFINDER_TODAY=YYYY-MM-DD` in test mode only, so you can check they pass
on another date: `cd ~/grantfinder && GRANTFINDER_TODAY=2028-11-20 bash tests/engine/run_all.sh`.
