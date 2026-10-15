# GrantWriter — Application Writer Module

Implements the Application Writer PRD (v2.0) inside grantfinder. grantfinder
answers *"which grant should we go after?"* — the writer answers *"how do we
win it?"*

**Stack note:** the PRD assumed Node/React + Firebase. grantfinder runs
entirely on Netlify: a Next.js app whose engine is TypeScript in
`frontend/src/server/` (see `docs/engine.md`), so the module follows that real
stack (per the PRD's own instruction to extend reality rather than fork it).
Firestore collections became Netlify Blobs records (`services/writerRepo.ts`);
`pino`/`winston` became JSON-line logging (`log.ts`). Code: `services/writer.ts`
(stages and prompts), `services/writerExport.ts`, `routes/writer.ts`,
`routes/checklist.ts`, `handlers/writer.ts`; the screens are in
`frontend/src/app/writer/` (`page.tsx`, `ApplicationChecklist.tsx`). The
original Python version in `backend/` is reference only.

## The pipeline (linear, with human gates)

```
"Write Application" on a match result        (4.0 handoff: {user, grant_id})
  → 1. Grant Spec enrichment                  POST /api/writer/applications/{id}/grant-spec   (job)
       or the guidelines as a file            POST .../grant-spec/upload                      (job)
  → 1b. Funder History profile                POST .../funder-profile                         (job)
       research the web first                 POST .../funder-profile  {research_web: true}   (job)
       add a file and build again             POST .../funder-profile/upload                  (job)
       remove a file                          DELETE .../funder-profile/files/{name}
  → 2. Fit & Gap analysis                     POST .../analyze                                (job)
  → [GATE 1] Confirm strategy                 POST .../confirm-strategy
  → 3. Stakeholder intake packets             POST .../intake/generate                        (job)
       record answers / "we don't have that"  PUT  .../intake/{req}/answer
       waive gaps explicitly                  PUT  .../gaps/{gap}/waive
  → 4. Draft all, one, or only missing        POST .../draft        (job; blocked by open high gaps)
  → 5. Self-score against rubric              POST .../score                                  (job)
  → 6. Refine sections                        POST .../sections/{sid}/refine                  (job)
       edit or restore a section by hand      PUT  .../sections/{sid}   {text}    (no AI; answers at once)
  → [GATE 2] Export                           POST .../export       (docx | md | txt | form_map)
```

Steps marked (job) run as jobs: the route answers `202 {job_id}` and the
website polls `GET /api/jobs/{id}`, showing live progress ("Drafting section 2
of 6: ..."). On Netlify a job runs, by default, inside a normal request
(`POST /api/jobs/{id}/run`, on any Netlify plan): Netlify allows about a
minute, so Claude calls stop at 50 seconds and the step saves what finished.
Work that doesn't fit continues in parts on its own (see Draft below). With
`GRANTFINDER_BACKGROUND_JOBS=true` (Netlify plans that include background
functions) a step can run up to 15 minutes instead (`docs/engine.md`).
Drafting takes `{section_id}` for one section or `{only_missing: true}` for
the sections that have no draft yet. Drafting and refining share one lock per
application, so they never run at the same time: the very same click while one
runs waits for it, a different one (a refine while a redraft runs) gets a
plain 409 that says to wait, and a hand edit is refused (409) while either is
running (it would be overwritten).

UI: `/writer?id=<application_id>` (entered via the "Write Application" button
on any match card in the dashboard results, including foundations, or from
"Your applications" at the top of the dashboard). The Application Checklist
sits at the top of the page, then the steps in order: 1 Grant Requirements,
1b Funder History, 2 Fit, Gaps & Strategy, 3 Missing Info & Stakeholders,
Add Materials, Your Voice, 4 Draft, 5 Self-Score, 6 Export.

What the page shows, in plain words:

- Status words instead of codes: "Reading requirements", "Gathering
  information", "Drafting", "Reviewing the draft", "Ready to export"; a gap
  sent to a stakeholder reads "asked", a request not sent yet reads "not sent yet".
- Each section shows the funder's own question ("Funder asks"; a long one
  folds away), its word count against the limit (and character count when
  the limit is in characters), any `[NEEDS INPUT]` placeholders ("Fill in
  before you submit") and any unsupported claims.
- The fit step shows "Lead with" (strength leads) and "Name honestly (don't
  hide)" (the honesty ledger); the scorecard shows "Biggest lever" and
  "Ranked fixes".
- Text you typed but haven't saved (pasted guidelines, funder notes, an
  edited strategy, stakeholder answers, refine instructions, a voice sample,
  an unsaved hand edit) is kept in this browser tab and comes back after a
  reload. A step
  still running when the page reloads is picked back up, not started again.
- No dead ends: if the application can't load, the page says why and offers
  "Try again" and "Back to dashboard"; with no application id it points back
  to the dashboard.

## What each stage does

1. **Grant Spec** — enriches the existing grant record (never re-fetches what
   discovery already knows) into required sections, format constraints,
   deliverables, and a rubric. Explicit published criteria are used verbatim;
   otherwise the rubric is inferred and visibly flagged `inferred`.
   Guidelines can be pasted, or added as a file with "Add the guidelines as a
   file" (`POST .../grant-spec/upload`: PDF, Word .docx or text, up to 4 MB;
   text in the box is read first, then the file's). Claude reads the first
   60,000 characters, and the step says so when there are more. A file that
   can't be read is refused at once, before any AI step. If nothing is pasted
   or added, the grant's URL is fetched (SSRF-guarded, HTML or PDF). If the page can't be read (many funder sites block bots), the
   screen says so and why, and "Paste guidelines and re-analyze" replaces the
   inferred spec with an exact one. In a one-minute step the page gets about
   15 seconds (up to 30 with the background worker), so Claude still has time;
   a page that doesn't answer in time counts as unreadable.
2. **Fit & Gap (the core value)** — maps every rubric criterion to the org's
   strongest real evidence (strong/partial/weak/missing), produces strength
   leads, a gap report, an honesty ledger (weaknesses to name and frame, not
   hide), and a recommended narrative strategy. "Re-run fit analysis" repeats
   it after you add answers or documents. With a funder profile (step 1b),
   the strategy is asked to match what this funder has funded, a "Fit with
   what this funder has funded" entry may appear, and the funder's process
   requirements and exclusions can become gaps (an exclusion that clearly
   applies is a high gap). When the funder profile is newer than the fit
   analysis, the page offers "Update the fit analysis now".
3. **Intake** — one owner per gap; generates copy-paste-ready email packets
   with a "why we need this" framing and explicit permission to answer
   "we don't have that" (recorded as a confirmed gap → honest-framing path,
   not an error). Answers flow back into the SHARED org profile as evidence,
   so the next application and grantfinder matching both start richer.
   Coverage rule: requests are written only for open gaps that no request
   covers yet, so clicking again (after a re-analysis, or for gaps an earlier
   round left unassigned) never asks about the same gap twice. When every
   open gap already has a request, no AI call is made: those gaps are marked
   asked and the step answers at once (200, no job) with a note saying so.
   The button reads "Generate Stakeholder Requests" the first time, then
   "Write requests for the N open gap(s)".
4. **Draft** — voice-conditioned, criteria-mapped, evidence-backed sections.
   Every claim is traced to a criterion + evidence; unsupported claims are
   flagged, never silently shipped. `[NEEDS INPUT: ...]` markers instead of
   invented facts. Banned phrases (org list + built-in AI-tell list) are
   detected deterministically, as whole words ("compassionate about" is not
   "passionate about", and a banned "just" never matches "justice"), and
   rewritten before reaching the user. With a funder profile, each draft
   also gets the funder history for emphasis and scale (positioning, what
   they fund, the comparable grants found in the material, the suggested
   ask) and the funder's own words added to the language cues; it never names
   the funder's other grantees and never claims a relationship with the
   funder or past funding from it unless the organization profile says so.
   Sections are drafted 3 at a time and each is saved the moment it finishes,
   so a run cut short keeps its finished work; a full run does the sections
   with no draft first.
   Drafting in parts (the Netlify default, one request per part): a section
   starts only while at least 40 seconds are left in the step, so a part
   drafts a few sections (3 at a time) and the rest continue in the next part
   on their own (the website sends the remaining `section_ids`, and the count
   keeps going: "Drafting section 4 of 6"). Every part starts at least one
   section, each section is drafted once per run, and "Redraft All Sections"
   redoes each section once. With the background worker, sections keep
   starting for up to 10 minutes, so a whole application usually fits in one
   part.
   If a section fails, the run stops there. A section that hit a passing
   problem (Claude overloaded or rate-limited, an unreadable answer) gets one
   more try first, but only when the wait and another section still fit in
   the step, which is rare in a one-minute part.
   Partial-drafting recovery: the message says how many sections were saved
   and why the others weren't (including any not started yet), and tells you
   to use "Draft missing sections", which drafts only the sections that have
   no draft yet. A section whose redraft failed keeps its earlier text, so the
   message points to its own "Redraft" button instead. "Redraft" rewrites a
   single section; "Redraft All Sections" asks first. A redraft keeps the
   replaced text (refinements and hand edits included) in the section's
   history. If the section changed anyway while it was being redrafted (a hand
   edit that slipped in), the saved text stays and the new draft becomes the
   newest earlier version, with a note.
   With less than 15 seconds left in the step, the voice rewrite is skipped:
   the section is saved with its banned phrases flagged and a note saying to
   refine it or edit it by hand (export stays blocked until then).
5. **Score** — a skeptical-reviewer scorecard per criterion, the single
   highest-leverage fix first, plus deterministic pass/fail compliance checks
   (limits, banned phrases, evidence-backed claims). The pass/fail checklist
   on the page is re-checked against the text as it is now (a hand edit after
   scoring shows up at once); the score itself stays until you re-score.
   With a funder profile, the reviewer also judges how closely the draft
   matches what this funder has funded and whether the ask fits their typical
   range (that can be the top fix).
6. **Refine** — one instruction per revision ("tighten by 40 words", "warm
   this up"). If a revision exceeds a hard limit, one automatic tighten pass
   runs; if still over, it stays flagged. With less than 15 seconds left in
   the step the tighten pass is skipped, and a tighten pass that fails for a
   passing reason keeps the revision; either way the section is saved flagged
   OVER LIMIT with a note saying to refine it again or edit it by hand. The
   replaced text goes into the section's history, and the section notes that
   the claim check is from the earlier draft. A draft written for a question
   the current requirements replaced can't be refined (409): redraft it first.
   If the section changed anyway while Claude was revising it (a hand edit
   that slipped in), the revision is not saved: the step answers 409, your
   text stays, and you can refine again.
7. **Edit by hand (no AI):** "Edit" opens the section's text with live word
   and character counts against its limit; "Save" sends
   `PUT .../sections/{sid}` with `{text}`. The replaced text goes into the
   section's history (the last 12 versions, the same cap as redrafts,
   refinements and voice rewrites). Counts, limits and banned phrases are
   re-checked against the current requirements exactly as after drafting. The
   claim list from the AI draft is kept, with two notes: "Edited by hand." and
   a reminder to re-check any numbers or names you added. An over-limit or
   banned-phrase edit is saved but flagged, and export refuses it until it is
   fixed. Saving the same text changes nothing; empty text or more than 60,000
   characters is refused (400). "Earlier versions (N)" lists the history,
   newest first; "Restore this version" asks first, then saves that text as a
   new edit, so the current text moves into the history.
   Unsaved edits are never lost or skipped: while an edit box holds changes,
   drafting, scoring and export wait (their buttons are off, and a message
   names the sections to Save or Cancel), and closing or reloading the tab
   asks first. Cancel asks before throwing typed changes away. If the saved
   text changed after you clicked Edit (a redraft or another tab), the page
   says so and Save asks first; the newer text stays in Earlier versions.
8. **Export** — Word (.docx via the `docx` package), Markdown, portal paste-in plain
   text with per-field counts, and a JSON form-field map. Export REFUSES
   over-limit or banned-phrase content (see "Live compliance and export rules"
   below). PDF is intentionally not generated
   (no headless browser dependency); Word/Markdown print cleanly to PDF.

## Funder History (step 1b)

The grant requirements say what the funder asks for; the funder history says
what it actually funds. The card appears once the requirements are analyzed.

- **What goes in:** notes you paste (past grantees, annual report or 990-PF
  grant lists, notes from calls, feedback on past applications; up to 60,000
  characters, kept across a reload), files ("Add a file": PDF, Word .docx or
  text, up to 4 MB, at most 6 files, the first 60,000 characters of each; a
  file with the same name replaces the earlier one; "Remove" asks first), and
  web research.
- **"Build Funder Profile"** (`funder_profile_v1`, no web search) builds the
  profile from that material plus the grant record, the extracted
  requirements and your organization profile. A step inside one request sends
  up to 50,000 characters of material (80,000 with the background worker),
  shared fairly: short parts go whole, long ones are cut, and the result says
  what was cut.
- **"Research the web and build"** first runs `funder_research_v1` with
  Claude's web search on your own Claude API key (at most 3 searches and one
  continuation in a one-minute step, 6 searches with the background worker;
  the cost estimate counts each search at 1 cent). The findings, with their
  source URLs, are saved (up to 30,000 characters), and the build then runs
  as a second part on its own. If the search finds nothing (or runs out of
  time), the build still runs from your notes and files and says so; with
  nothing at all to build from, the step says to paste what you know.
- **What the profile shows:** a summary; typical award (and median), grants a
  year, where they give and who they fund; a suggested ask with its reason
  (only when the material shows award sizes); comparable grants they made
  (recipient, year, amount, purpose, why comparable; at most 10); what they
  fund, what they don't fund, how they decide, how to position this
  application, words they use, what the material doesn't show, and sources.
- **Never invented:** a comparable grant must name a recipient, and a
  recipient that does not appear word for word in the material is flagged
  "Not found in your material" and never reaches a drafting prompt. Sources
  are only the notes, file names and research URLs actually used.
- **Where it is used:** the fit analysis, every draft and the self-score read
  the profile (see stages 2, 4 and 5). The Application Checklist adds the
  funder's process requirements as items to tick and shows its exclusions as
  a warning. If the notes, files or research change after the build, the
  profile says it is out of date until you build it again.
- **Storage and safety:** one record per grant (`writer/{user}/funder/{grant_id}`),
  reused by any application to that grant. File texts never go back to the
  website (names and sizes only), the debug bundle shows sizes and counts but
  never the notes, and research and builds for one grant run one at a time
  (the same click again waits for the running step; a different one, or a
  file upload, gets a 409 that says to wait).

## Add Materials

A card after the fit and Missing Info steps adds one more document (budget,
prior report, letters, data) the same way as the dashboard's Documents step
(`POST /api/processing/upload-document`: PDF, Word .docx or text, up to
4 MB). Its key facts become profile evidence that the fit analysis and every
draft can use. If a fit analysis already exists, the card offers "Update the
fit analysis to use it" (re-running replaces the gap list, so it asks first).

**Or paste text** (the same box is on the dashboard's Documents step): pick
what it is (a past proposal that was funded, funder or reviewer comments, an
analysis, report or data, or other notes), optionally name it, paste, and
**Add this text**. The page (`frontend/src/app/PasteMaterial.tsx`) turns it
into a `.txt` file named after the title or the kind, for example
`Funded proposal (pasted).txt`, whose first line tells Claude what it is
("What this is: A grant proposal this school or parish wrote earlier that was
funded. Its facts describe the school as of when it was written."), then
uploads it like any document. The server is unchanged. A character count shows
when the text is longer than the 60,000 characters Claude reads.

## Application Checklist

A card at the top of the writer that says what is done, what is left and
the one next thing to do. Its own small record
(`GET`/`PUT /api/writer/applications/{id}/checklist`, stored at
`writer/{user}/checklist/{appId}`) keeps only what you tick by hand plus the
deadline counted in days; everything else comes from the application itself.
(The record can also hold a short note per item, up to 500 characters; the
page shows a saved note but has no box to write one yet.)

- **Due date:** "Due [date] · N days left" (red within 3 days, amber within
  14), "Due today", or "Deadline passed"; "Annual: October 15" counts to the
  next October 15, and a rolling deadline shows no countdown. Next to it,
  "N of M ready" with a progress bar.
- **Next step:** one line, with a button that takes you there. It runs a
  step only the way that step's own button would (fit analysis, drafting the
  missing sections, scoring), never analyzes the requirements by itself, and
  never approves anything for you: for the strategy it only brings the
  strategy up to read and confirm, and export stays your click.
- **Sections:** each required section with its status (Not drafted, Drafted
  with counts, Over limit, N to fill in, Banned phrases, unsupported claims,
  Ready). A section is ready when it is within its limit, has no
  placeholders or banned phrases, and its unsupported claims are fixed or
  ticked "I checked these claims".
- **Attachments and requirements:** a box to tick for each deliverable, each
  format rule and each funder process requirement.
- **Open gaps:** how many are open by severity and by owner, with a link to
  Missing Info.
- **Steps and approvals:** strategy confirmed, voice captured, scored,
  exported (you export and submit it yourself), plus a warning listing what
  the funder says it does not fund.

## Prompts (one purpose-built prompt per stage, all in `services/writer.ts`)

Extract `grant_spec_v1`, `voice_profile_v1` → Research `funder_research_v1`
(web search), `funder_profile_v1` → Map `fit_gap_v1` → Route
`intake_packets_v1` → Draft `section_draft_v1` → Score `self_score_v1` →
Refine `section_refine_v1` → Enforce `voice_enforce_v1`. Without a funder
profile, the fit, draft and score prompts are exactly as before.

## Live compliance and export rules

- **Checked live, never trusted from storage.** The application state
  (`GET /api/writer/applications/{id}`, what the writer page shows, including
  the scorecard's pass/fail checklist), every export, and the debug bundle
  re-check each section's word and character counts, its limit, and banned
  phrases against the CURRENT requirements and the CURRENT voice profile. A
  phrase banned after drafting, or a limit that a re-analysis added or
  lowered, shows up at once (copies are checked; nothing is re-saved).
- **Never the unsaved text.** The page won't export while an edit box holds
  unsaved changes (the file would hold the saved text, not what is on screen).
- **Export refuses (409)** while any section is over its hard limit or
  contains a banned phrase. The message names each section with its overage
  (for example `Portal Summary (1243 of 1000 characters)`) or the phrases
  found, and says to refine it ("tighten to the limit", "remove these
  phrases") or edit it by hand.
- **Only what the current requirements ask for is exported.** A required
  section with no draft gets a visible `[NOT DRAFTED YET ...]` line in the
  file; a draft the requirements no longer ask for is left out (the page marks
  it "no longer in the requirements (not exported)").
- **Placeholders never block an export.** `[NEEDS INPUT: ...]` markers and
  unsupported claims are listed under each section and counted in the Export
  card. After a download, the notice (the `x-grantfinder-notice` header) says
  how many `[NEEDS INPUT]` placeholders are still in the file and in which
  sections, plus any sections not drafted or left out.

## Business rules enforced in code (not just prompts)

- Reuse, never duplicate: applications reference the existing grant record and
  org profile by ID.
- Strategy gate: drafting 409s until the Grant Lead confirms the strategy.
  A strategy edited after confirming is saved before any drafting ("Save
  strategy changes", and every drafting button saves it first), so drafts
  never silently ignore it.
- Gap gate: open/routed high-severity gaps 409 drafting until answered,
  confirmed ("we don't have that"), or explicitly waived.
- Deadline within 10 days → `urgent` flag on the application.
- One stakeholder owner per gap (duplicate assignments are dropped), and a
  new request only for an open gap that no request covers yet.
- Format is pass/fail: word/char counts computed deterministically after every
  generation and hand edit, and re-checked live against the current
  requirements; export refuses violations.
- Each section keeps its last 12 earlier texts (redrafts, refinements, voice
  rewrites, hand edits); a hand edit never runs at the same time as drafting
  or refining (409).
- The funder history is about the funder, never evidence about the
  applicant: drafts never claim a relationship with the funder or past
  funding from it unless the organization profile says so, never name its
  other grantees, and only comparable grants found in the material reach a
  prompt.
- Saves never overwrite a newer change: a redraft that finishes after a hand
  edit keeps the edited text (the new draft goes into the history), and a
  refine of a section that changed meanwhile is not saved (409).
- Nothing is auto-sent or auto-submitted, ever.

## Logging & debugging (PRD Section 8)

- JSON-line logs: Netlify > Logs > Functions on the deployed site; on a Mac
  also `~/logs/grantfinder/grantfinder.log` (daily, 14 kept).
  `LOG_LEVEL=debug` enables verbose logging.
- Every AI call logs: correlation ID, stage, prompt ID, model, input/output
  tokens, web searches, latency, cost estimate, status, stop reason. Each call
  is also stored on its job, so the history survives restarts.
- `GET /api/writer/applications/{id}/debug-bundle` → one paste-ready markdown
  bundle: correlation ID, state summary, AI call timeline with costs, each
  step (job) with its notes and internal error, and errors. The state
  summary has one funder history line (sizes and counts only, never the
  notes, and whether the profile is out of date or newer than the fit
  analysis), and re-checks every section live: words and characters against its
  limit, OVER LIMIT, banned phrases, unsupported claims, `[NEEDS INPUT]`
  placeholders, and how many earlier versions it has. The writer screen's
  **Copy debug bundle** button puts it on the clipboard (or downloads it as
  `grantfinder-debug-bundle.md` when the browser blocks copying).
- `GET /api/writer/logs/recent` → the signed-in user's recent AI calls.

## Resolved policy decisions (were PRD open questions)

- **Honesty ledger (Q6, decided by Chris):** weaknesses are named and framed
  for the funder by default - never silently omitted.
- **Gates (Q7, decided by Chris):** exactly the three mandated gates
  (strategy confirmation, copy-paste-only stakeholder sends, explicit export).
  No per-section drafting approval.

## Voice profile

`POST /api/writer/voice/analyze` with writing samples extracts style
guidelines + banned phrases onto the shared profile (`voice_profile`). Drafting
works without it (sensible default voice) but improves markedly with it.
Phrases it bans apply to sections already drafted too: the page, export and
debug bundle re-check against the current list.

## Testing

`tests/engine/writer.test.mts` (212 checks, mock Claude, no key needed) walks
the whole pipeline through the API: the guidelines file, the funder history
(notes, files, web research, verified comparable grants, the profile reaching
the fit, draft and score prompts, and unchanged prompts without one), gates,
gap blocking, intake round-trip
(including a second round that writes requests only for uncovered gaps),
profile enrichment, voice enforcement, whole-word banned phrases,
unsupported-claim flagging, over-limit auto-tighten (and a tighten pass that
fails), guidelines fetch success and failure, fatal vs. temporary Claude
errors, partial drafting and "Draft missing sections", hand edits (history
capped at 12, restore, refused while drafting runs, over-limit and
banned-phrase edits flagged and refused at export), live compliance (a phrase
banned after drafting, the scorecard checklist), the export refusal wording
and `[NEEDS INPUT]` notice, all four export formats (the .docx is re-opened
and checked), and the debug bundle. Run it with:

```bash
cd ~/grantfinder/frontend
npx tsx ../tests/engine/writer.test.mts
```

`cd ~/grantfinder && bash tests/engine/run_all.sh` runs it twice: once with
the other 9 suites, and again in direct job mode (the Netlify default).
`tests/engine/direct.test.mts` (21 checks) covers drafting in parts (each
section once, numbering across parts, Redraft All in parts), the skipped
voice rewrite and tighten pass, a guidelines page that never answers, and
funder research and builds inside one-minute steps;
`tests/engine/regressions.test.mts` (33 checks) covers the race-safe saves
and the funder history's one-at-a-time rule; `tests/engine/checklist.test.mts`
(52 checks) covers the Application Checklist record (ticks, notes, the
deadline countdown, validation, owner-only access). The browser test
(`tests/e2e/README.md`) drives the same writer on screen: Funder History,
hand edit and "Restore this version" included.

AI prompts themselves require a live key to validate.
