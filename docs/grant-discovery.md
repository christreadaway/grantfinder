# Grant Discovery

GrantFinder no longer depends solely on a user-uploaded Excel file. Grants can
enter the database from four sources, all merged with automatic deduplication
(matching on normalized grant name + funder):

| Source | Endpoint | Requires Claude API key | What it does |
|---|---|---|---|
| Excel upload | `POST /api/grants/upload` | No | User's own spreadsheet (5-category format, `.xlsx`, up to 4 MB). Merges into the database: a row matching a saved grant updates the cells it filled in; nothing is deleted |
| Starter database | `POST /api/discovery/seed` | No | Built-in curated set: national Catholic funders, secular grants faith-based orgs qualify for, TX-focused foundations, plus foundations to monitor |
| Grants.gov | `POST /api/discovery/grants-gov` | No | Runs as a job. Live search of the free Grants.gov Search2 API for open + forecasted federal opportunities. Keywords derive from the org profile (security concerns, facility needs, food pantry, school programs) or can be passed explicitly. If Grants.gov doesn't answer, the step fails with a clear message instead of reporting 0 grants. In direct mode (the Netlify default, about a minute per step) up to 4 keyword searches run at once, 10 seconds each at most, and a keyword that no longer fits is skipped and noted; with the background worker they run one after another, 30 seconds each at most |
| AI web discovery | `POST /api/discovery/web-search` | Yes | Runs as a job. Claude uses its server-side web search tool to find current grant opportunities tailored to the organization profile (plus an optional focus typed on the dashboard). Instructed to only report grants with real web evidence and to use "Check website" when a deadline can't be verified. In direct mode Claude runs at most 3 web searches (8 with the background worker) and one continuation of a paused search, and is asked for 5-8 grants, so the step ends within its minute. Grants already listed when time runs out are kept; if none were, the step says so plainly and suggests a narrower focus |

`GET /api/discovery/sources` reports how many grants came from each source.

## Recommended flow

1. Load the starter database (instant, free).
2. Complete the profile (website scan, questionnaire, documents, free-form notes).
   If your website blocks automated reading, use "Enter the basics by hand" or
   "Skip to questions" on the Website step (it reads "Go to my questions" once
   Claude has written them); uploaded documents add the detail.
   To add documents later without matching again, use "Add to my profile only
   (no new matching)" on the Documents step.
3. Run Grants.gov search + AI web discovery — both use the profile to target
   the search, so they find more relevant grants after the profile exists.
4. Optionally upload your own Excel on top.
5. Run matching. Discovery is additive and idempotent — re-running a source
   only adds grants you don't already have.

## Matching improvements that ship with discovery

- **Deterministic hard filters** (no AI cost, guaranteed): TX-only grants are
  auto-disqualified for non-TX orgs, `CLOSED` grants and parseable past
  deadlines are marked not-eligible before any AI scoring.
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
  monitorable opportunities and scored alongside grants.
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

## Data model additions (used by the grant writer)

`Grant` now carries `source`, `eligibility_notes`, and `funds_for` tags.
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

- `CLAUDE_MODEL` (default `claude-sonnet-5`) — used for all AI processing
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
`routes/grants.ts`, `routes/discovery.ts`, `handlers/discovery.ts`; profile
building and matching in `services/ai.ts`, `routes/processing.ts`,
`handlers/processing.ts`. Tests: `tests/engine/grants.test.mts` (130 checks),
`tests/engine/processing.test.mts` (133 checks: website scan, questionnaire,
documents, matching) and `tests/engine/direct-processing.test.mts` (20
checks: matching in parts, and the scan, Grants.gov, web discovery, documents
and questionnaire inside one-minute steps).
`cd ~/grantfinder && bash tests/engine/run_all.sh` also runs the grants and
processing suites a second time in direct job mode.
