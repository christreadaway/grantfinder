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
  → 4. Draft all sections (or one)            POST .../draft        (job; blocked by open high gaps)
  → 5. Self-score against rubric              POST .../score                                  (job)
  → 6. Refine sections                        POST .../sections/{sid}/refine                  (job)
  → [GATE 2] Export                           POST .../export       (docx | md | txt | form_map)
```

Steps marked (job) run in the Netlify background function (up to 15 minutes);
the route answers `202 {job_id}` and the website polls `GET /api/jobs/{id}`,
showing live progress ("Drafting section 2 of 6: ...").

UI: `/writer?id=<application_id>` (entered via the "Write Application" button
on any match card in the dashboard results, including foundations, or from
"Your applications" at the top of the dashboard).

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
4. **Draft** — voice-conditioned, criteria-mapped, evidence-backed sections.
   Every claim is traced to a criterion + evidence; unsupported claims are
   flagged, never silently shipped. `[NEEDS INPUT: ...]` markers instead of
   invented facts. Banned phrases (org list + built-in AI-tell list) are
   detected deterministically and rewritten before reaching the user.
   Sections are drafted 3 at a time and each is saved the moment it finishes,
   so a run cut short keeps its finished work; running "Draft" again does the
   missing sections first. "Redraft" rewrites a single section.
5. **Score** — a skeptical-reviewer scorecard per criterion, the single
   highest-leverage fix first, plus deterministic pass/fail compliance checks
   (limits, banned phrases, evidence-backed claims).
6. **Refine** — one instruction per revision ("tighten by 40 words", "warm
   this up"). If a revision exceeds a hard limit, one automatic tighten pass
   runs; if still over, it stays flagged.
7. **Export** — Word (.docx via the `docx` package), Markdown, portal paste-in plain
   text with per-field counts, and a JSON form-field map. Export REFUSES
   over-limit or banned-phrase content. PDF is intentionally not generated
   (no headless browser dependency); Word/Markdown print cleanly to PDF.

## Business rules enforced in code (not just prompts)

- Reuse, never duplicate: applications reference the existing grant record and
  org profile by ID.
- Strategy gate: drafting 409s until the Grant Lead confirms the strategy.
- Gap gate: open/routed high-severity gaps 409 drafting until answered,
  confirmed ("we don't have that"), or explicitly waived.
- Deadline within 10 days → `urgent` flag on the application.
- One stakeholder owner per gap (duplicate assignments are dropped).
- Format is pass/fail: word/char counts computed deterministically after every
  generation; export refuses violations.
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
  background step with its notes and internal error, and errors. The writer
  screen's **Copy debug bundle** button puts it on the clipboard.
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

## Testing

`tests/engine/writer.test.mts` (118 checks, mock Claude, no key needed) walks
the whole pipeline through the API: gates, gap blocking, intake round-trip,
profile enrichment, voice enforcement, unsupported-claim flagging, over-limit
auto-tighten, guidelines fetch success and failure, fatal vs. temporary Claude
errors, all four export formats (the .docx is re-opened and checked), and the
debug bundle. Run it with:

```bash
cd ~/grantfinder/frontend
npx tsx ../tests/engine/writer.test.mts
```

AI prompts themselves require a live key to validate.
