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
`handlers/writer.ts`. The original Python version in `backend/` is reference only.

## The pipeline (linear, with human gates)

```
"Write Application" on a match result        (4.0 handoff: {user, grant_id})
  → 1. Grant Spec enrichment                  POST /api/writer/applications/{id}/grant-spec   (job)
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

Steps marked (job) run in the Netlify background function (up to 15 minutes);
the route answers `202 {job_id}` and the website polls `GET /api/jobs/{id}`,
showing live progress ("Drafting section 2 of 6: ..."). Drafting takes
`{section_id}` for one section or `{only_missing: true}` for the sections that
have no draft yet. Drafting and refining share one lock per application, so
they never run at the same time, and a hand edit is refused (409) while either
is running (it would be overwritten).

UI: `/writer?id=<application_id>` (entered via the "Write Application" button
on any match card in the dashboard results, including foundations, or from
"Your applications" at the top of the dashboard).

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
- Text you typed but haven't saved (pasted guidelines, stakeholder answers,
  refine instructions, a voice sample, an unsaved hand edit) is kept in this
  browser tab and comes back after a reload. A step still running when the
  page reloads is picked back up, not started again.
- No dead ends: if the application can't load, the page says why and offers
  "Try again" and "Back to dashboard"; with no application id it points back
  to the dashboard.

## What each stage does

1. **Grant Spec** — enriches the existing grant record (never re-fetches what
   discovery already knows) into required sections, format constraints,
   deliverables, and a rubric. Explicit published criteria are used verbatim;
   otherwise the rubric is inferred and visibly flagged `inferred`.
   Guidelines can be pasted; if absent, the grant's URL is fetched (SSRF-guarded,
   HTML or PDF). If the page can't be read (many funder sites block bots), the
   screen says so and why, and "Paste guidelines and re-analyze" replaces the
   inferred spec with an exact one.
2. **Fit & Gap (the core value)** — maps every rubric criterion to the org's
   strongest real evidence (strong/partial/weak/missing), produces strength
   leads, a gap report, an honesty ledger (weaknesses to name and frame, not
   hide), and a recommended narrative strategy. "Re-run fit analysis" repeats
   it after you add answers or documents.
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
   detected deterministically and rewritten before reaching the user.
   Sections are drafted 3 at a time and each is saved the moment it finishes,
   so a run cut short keeps its finished work; a full run does the sections
   with no draft first. A section that hits a passing problem (Claude
   overloaded or rate-limited, an unreadable answer) gets one more try.
   Partial-drafting recovery: if sections still fail, the message says how
   many were saved and why, and tells you to use "Draft missing sections",
   which drafts only the sections that have no draft yet. A section whose
   redraft failed keeps its earlier text, so the message points to its own
   "Redraft" button instead. "Redraft" rewrites a single section; "Redraft All
   Sections" asks first. A redraft keeps the replaced text (refinements and
   hand edits included) in the section's history.
5. **Score** — a skeptical-reviewer scorecard per criterion, the single
   highest-leverage fix first, plus deterministic pass/fail compliance checks
   (limits, banned phrases, evidence-backed claims).
6. **Refine** — one instruction per revision ("tighten by 40 words", "warm
   this up"). If a revision exceeds a hard limit, one automatic tighten pass
   runs; if still over, it stays flagged. The replaced text goes into the
   section's history, and the section notes that the claim check is from the
   earlier draft. A draft written for a question the current requirements
   replaced can't be refined (409): redraft it first.
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
8. **Export** — Word (.docx via the `docx` package), Markdown, portal paste-in plain
   text with per-field counts, and a JSON form-field map. Export REFUSES
   over-limit or banned-phrase content (see "Live compliance and export rules"
   below). PDF is intentionally not generated
   (no headless browser dependency); Word/Markdown print cleanly to PDF.

## Live compliance and export rules

- **Checked live, never trusted from storage.** The application state
  (`GET /api/writer/applications/{id}`, what the writer page shows), every
  export, and the debug bundle re-check each section's word and character
  counts, its limit, and banned phrases against the CURRENT requirements and
  the CURRENT voice profile. A phrase banned after drafting, or a limit that a
  re-analysis added, shows up at once (copies are checked; nothing is re-saved).
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
- Nothing is auto-sent or auto-submitted, ever.

## Logging & debugging (PRD Section 8)

- JSON-line logs: Netlify > Logs > Functions on the deployed site; on a Mac
  also `~/logs/grantfinder/grantfinder.log` (daily, 14 kept).
  `LOG_LEVEL=debug` enables verbose logging.
- Every AI call logs: correlation ID, stage, prompt ID, model, input/output
  tokens, web searches, latency, cost estimate, status, stop reason. Each call
  is also stored on its background job, so the history survives restarts.
- `GET /api/writer/applications/{id}/debug-bundle` → one paste-ready markdown
  bundle: correlation ID, state summary, AI call timeline with costs, each
  background step with its notes and internal error, and errors. The state
  summary re-checks every section live: words and characters against its
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

`tests/engine/writer.test.mts` (153 checks, mock Claude, no key needed) walks
the whole pipeline through the API: gates, gap blocking, intake round-trip
(including a second round that writes requests only for uncovered gaps),
profile enrichment, voice enforcement, unsupported-claim flagging, over-limit
auto-tighten, guidelines fetch success and failure, fatal vs. temporary Claude
errors, partial drafting and "Draft missing sections", hand edits (history
capped at 12, restore, refused while drafting runs, over-limit and
banned-phrase edits flagged and refused at export), live compliance (a phrase
banned after drafting), the export refusal wording and `[NEEDS INPUT]` notice,
all four export formats (the .docx is re-opened and checked), and the debug
bundle. Run it with:

```bash
cd ~/grantfinder/frontend
npx tsx ../tests/engine/writer.test.mts
```

It is one of the 7 engine suites (515 checks) that
`cd ~/grantfinder && bash tests/engine/run_all.sh` runs; the browser test
(`tests/e2e/README.md`) drives the same writer on screen, hand edit and
"Restore this version" included.

AI prompts themselves require a live key to validate.
