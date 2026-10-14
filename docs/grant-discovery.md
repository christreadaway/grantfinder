# Grant Discovery

GrantFinder no longer depends solely on a user-uploaded Excel file. Grants can
enter the database from four sources, all merged with automatic deduplication
(matching on normalized grant name + funder):

| Source | Endpoint | Requires Claude API key | What it does |
|---|---|---|---|
| Excel upload | `POST /api/grants/upload` | No | User's own spreadsheet (5-category format, `.xlsx`, up to 4 MB). Merges into the database: a row matching a saved grant updates the cells it filled in; nothing is deleted |
| Starter database | `POST /api/discovery/seed` | No | Built-in curated set: national Catholic funders, secular grants faith-based orgs qualify for, TX-focused foundations, plus foundations to monitor |
| Grants.gov | `POST /api/discovery/grants-gov` | No | Background job. Live search of the free Grants.gov Search2 API for open + forecasted federal opportunities. Keywords derive from the org profile (security concerns, facility needs, food pantry, school programs) or can be passed explicitly. If Grants.gov doesn't answer, the step fails with a clear message instead of reporting 0 grants |
| AI web discovery | `POST /api/discovery/web-search` | Yes | Background job. Claude uses its server-side web search tool to find current grant opportunities tailored to the organization profile (plus an optional focus typed on the dashboard). Instructed to only report grants with real web evidence and to use "Check website" when a deadline can't be verified |

`GET /api/discovery/sources` reports how many grants came from each source.

## Recommended flow

1. Load the starter database (instant, free).
2. Complete the profile (website scan, questionnaire, documents, free-form notes).
   If your website blocks automated reading, use "Enter the basics by hand" or
   "Skip to questions" on the Website step; uploaded documents add the detail.
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
- **Foundations are matched**: Category 5 foundations are converted to
  monitorable opportunities and scored alongside grants.
- **Coverage guarantee**: every grant in the database gets a match entry.
  Anything the AI couldn't score gets a neutral score with an explanation that
  starts "Not AI-scored:" and says why, instead of silently disappearing. A
  bad API key or an empty Anthropic balance stops matching with that message
  rather than producing placeholder scores.
- **Parallel scoring**: 10 grants per Claude call, 4 calls in flight. Matching
  runs as a background job (up to 15 minutes); it stops starting new batches
  after 12 minutes and marks anything left as "Not AI-scored".
- **Documents feed the writer**: every need or signal extracted from an
  uploaded document is also saved to the profile's evidence list, which the
  grant writer cites.
- **Deeper website scan**: the org's site is crawled (homepage + up to 5
  grant-relevant internal pages like /about, /school, /ministries, /news)
  instead of fetching just the single URL.

## Data model additions (for the future grant writer)

`Grant` now carries `source`, `eligibility_notes`, and `funds_for` tags.
`OrganizationProfile` now carries `questionnaire_answers` (verbatim Q&A) and
`free_form_notes`. These give an application-drafting feature (v2.0 PRD) the
raw material it needs: what the funder requires, and everything the user told
us about the organization.

## Configuration

Environment variables (Netlify: Site configuration > Environment variables):

- `CLAUDE_MODEL` (default `claude-sonnet-5`) — used for all AI processing
- `GRANTS_GOV_API_URL` — optional override of the Grants.gov Search2 address

Constants in `frontend/src/server/config.ts`:

- `GRANTS_GOV_API_URL`, `GRANTS_GOV_MAX_RESULTS`
- `WEB_DISCOVERY_MAX_SEARCHES` — cap on web searches per discovery run
- `WEBSITE_CRAWL_MAX_PAGES` — pages crawled per org website

Code: `frontend/src/server/services/discovery.ts`, `services/excel.ts`,
`routes/grants.ts`, `routes/discovery.ts`, `handlers/discovery.ts`. Tests:
`tests/engine/grants.test.mts` (130 checks).
