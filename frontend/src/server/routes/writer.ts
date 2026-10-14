/**
 * /api/writer: the GrantWriter (Application Writer PRD). Port of backend/routers/writer.py.
 *
 * Linear pipeline with human approval gates:
 *   handoff -> grant spec -> fit/gap analysis -> [GATE: confirm strategy]
 *   -> stakeholder intake -> drafting -> self-scoring -> refinement -> [GATE: export]
 *
 * Routes do every synchronous check first (sign-in, ownership, API key,
 * profile, spec, the gates) and answer 400/404/409 at once with the Python
 * wording. Claude work then starts as a background job (handlers/writer.ts)
 * and the route answers 202 {job_id}; the job's result is the body the Python
 * endpoint returned. Nothing is ever sent or submitted automatically:
 * stakeholder emails are copy-paste only and export is an explicit download.
 *
 * Single source of truth: the writer reads and extends the shared grant
 * record and org profile; an application is just {user, grant_id} plus
 * writer artifacts (services/writerRepo.ts).
 */
import crypto from 'node:crypto';

import { requireApiKey } from '../auth';
import { HttpError } from '../errors';
import { fileResponse, optionalString, requireString, type RequestContext } from '../http';
import { listJobs, newCorrelationId, startJob, type Job } from '../jobs';
import { clamp } from '../json';
import { logger } from '../log';
import { getApplication, getProfile, listApplications, updateProfile } from '../repo';
import { getGrantOrFoundation } from '../services/ai';
import type { Router } from '../router';
import {
  applyCompliance,
  assertDraftAllowed,
  blockingGaps,
  loadApplication,
  loadWriterProfile,
  newId,
  draftFitsSection,
  draftsVsSpec,
  replacedQuestionMessage,
  orderDrafts,
  withUrgency,
  WRITER_MESSAGES,
} from '../services/writer';
import { buildExport, EXPORT_FORMATS } from '../services/writerExport';
import {
  createApplicationIfNew,
  getFitAnalysis,
  getGaps,
  getGrantSpec,
  getIntakeRequests,
  getScorecard,
  getSectionDraft,
  listSectionDrafts,
  touchApplication,
  updateGaps,
  updateIntakeRequests,
} from '../services/writerRepo';
import type { AICallLog, Application, Gap, IntakeRequest, SectionDraft, WriterExportFormat } from '../types';

/** Every job for one application shares its correlation id, so the debug bundle can trace it. */
function jobOptions(app: Application) {
  return { applicationId: app.id, correlationId: app.correlation_id };
}

/** One application per grant per user: the id is derived from both, so a double click can't make two. */
function applicationIdFor(userId: string, grantId: string): string {
  return `app_${crypto.createHash('sha256').update(`${userId}:${grantId}`).digest('hex').slice(0, 12)}`;
}

/** Pydantic-style bool: true/false, "true"/"false", "yes"/"no", 1/0. */
function parseBool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 't', 'y'].includes(text)) return true;
    if (['false', '0', 'no', 'off', 'f', 'n'].includes(text)) return false;
  }
  throw new HttpError(422, `Field "${field}" must be true or false.`);
}

function exportFormat(value: unknown): WriterExportFormat {
  if (typeof value === 'string' && (EXPORT_FORMATS as string[]).includes(value)) return value as WriterExportFormat;
  throw new HttpError(422, `Field "format" must be one of: ${EXPORT_FORMATS.join(', ')}.`);
}

// =============================================================================
// 4.0 Handoff: "Write Application"
// =============================================================================

/** Entry point from grantfinder: reuse the grant record and org profile, create only an application record. */
async function createApplication(ctx: RequestContext): Promise<Application> {
  const user = await ctx.user();
  const body = await ctx.json();
  const grantId = requireString(body, 'grant_id');
  const grant = await getGrantOrFoundation(user.id, grantId);
  if (!grant) throw new HttpError(404, WRITER_MESSAGES.grantNotFound);
  await loadWriterProfile(user.id); // must exist; the writer never creates a parallel one

  // One application per grant per user - reopen if it exists.
  const appId = applicationIdFor(user.id, grant.id);
  const existing =
    (await getApplication(user.id, appId)) ?? (await listApplications(user.id)).find((app) => app.grant_id === grant.id) ?? null;
  if (existing) return withUrgency(existing);

  const now = new Date().toISOString();
  const app: Application = withUrgency({
    id: appId,
    user_id: user.id,
    grant_id: grant.id,
    grant_name: grant.grant_name,
    funder: grant.funder,
    status: 'analysis',
    strategy: null,
    strategy_confirmed: false,
    deadline: grant.deadline ?? null,
    urgent: false,
    correlation_id: newCorrelationId(),
    created_at: now,
    updated_at: now,
  });
  if (!(await createApplicationIfNew(app))) {
    // Someone (a double click) created it a moment ago: reopen theirs.
    const winner = await getApplication(user.id, appId);
    if (winner) return withUrgency(winner);
    logger.error('application_create_conflict', { app_id: appId, user_id: user.id, grant_id: grant.id });
    throw new HttpError(503, "Couldn't save the new application just now. Please try again.");
  }
  logger.info('application_created', {
    correlation_id: app.correlation_id,
    app_id: app.id,
    user_id: user.id,
    grant: grant.grant_name,
    urgent: app.urgent,
  });
  return app;
}

async function listUserApplications(ctx: RequestContext): Promise<Application[]> {
  const user = await ctx.user();
  const apps = await listApplications(user.id);
  return apps.sort((a, b) => a.created_at.localeCompare(b.created_at)).map(withUrgency);
}

/** Full application state: everything the writer page needs in one call. */
async function getApplicationState(ctx: RequestContext): Promise<Record<string, unknown>> {
  const user = await ctx.user();
  const app = await loadApplication(user.id, ctx.params.appId);
  const [gaps, profile, spec, analysis, intake, drafts, scorecard] = await Promise.all([
    getGaps(user.id, app.id),
    getProfile(user.id),
    getGrantSpec(user.id, app.grant_id),
    getFitAnalysis(user.id, app.id),
    getIntakeRequests(user.id, app.id),
    listSectionDrafts(user.id, app.id),
    getScorecard(user.id, app.id),
  ]);
  const voice = profile?.voice_profile ?? null;
  const coverage = spec ? draftsVsSpec(drafts, spec) : null;
  return {
    application: app,
    has_voice_profile: Boolean(voice && voice.style_guidelines),
    voice_style_guidelines: voice ? voice.style_guidelines ?? null : null,
    grant_spec: spec,
    fit_analysis: analysis,
    gaps,
    open_blocking_gaps: blockingGaps(gaps),
    intake_requests: intake,
    sections: orderDrafts(drafts, spec),
    // Required sections with no draft yet, and drafts the current requirements no longer ask for.
    missing_sections: coverage ? coverage.missing.map((section) => ({ id: section.id, title: section.title })) : [],
    stale_section_ids: coverage ? coverage.stale.map((draft) => draft.section_id) : [],
    scorecard,
  };
}

// =============================================================================
// 4.1 Voice profile (writer extension of the shared org profile)
// =============================================================================

/** Extract a voice profile from writing samples; the job saves it onto the shared profile. */
async function analyzeVoiceRoute(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  const body = await ctx.json();
  const samples = body.samples;
  if (!Array.isArray(samples) || samples.some((sample) => typeof sample !== 'string')) {
    throw new HttpError(422, 'Field "samples" must be a list of text.');
  }
  if (!samples.some((sample: string) => sample.trim())) throw new HttpError(400, WRITER_MESSAGES.noSamples);
  await loadWriterProfile(user.id);
  await requireApiKey(user.id);
  return startJob(ctx, 'writer.voice_analyze', { samples });
}

// =============================================================================
// 4.2 Grant Spec enrichment
// =============================================================================

/** Enrich grantfinder's grant record into a full Grant Spec (the job fetches the grant URL when nothing is pasted). */
async function enrichGrantSpecRoute(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  const body = await ctx.json();
  const guidelines = optionalString(body, 'guidelines_text');
  const app = await loadApplication(user.id, ctx.params.appId);
  const grant = await getGrantOrFoundation(user.id, app.grant_id);
  if (!grant) throw new HttpError(404, WRITER_MESSAGES.underlyingGrantMissing);
  await requireApiKey(user.id);
  return startJob(ctx, 'writer.grant_spec', { app_id: app.id, guidelines_text: guidelines }, jobOptions(app));
}

// =============================================================================
// 4.3 Fit / Gap analysis
// =============================================================================

async function analyzeFitRoute(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  const app = await loadApplication(user.id, ctx.params.appId);
  await loadWriterProfile(user.id);
  if (!(await getGrantSpec(user.id, app.grant_id))) throw new HttpError(400, WRITER_MESSAGES.specFirst);
  await requireApiKey(user.id);
  return startJob(ctx, 'writer.analyze', { app_id: app.id }, jobOptions(app));
}

/** GATE 1 (mandatory): the Grant Lead confirms the narrative strategy. */
async function confirmStrategy(ctx: RequestContext): Promise<Application> {
  const user = await ctx.user();
  const body = await ctx.json();
  const strategy = optionalString(body, 'strategy');
  const app = await loadApplication(user.id, ctx.params.appId);
  const analysis = await getFitAnalysis(user.id, app.id);
  if (!analysis) throw new HttpError(400, WRITER_MESSAGES.fitFirst);
  const updated = await touchApplication(user.id, app.id, {
    strategy: strategy && strategy.trim() ? strategy : analysis.recommended_strategy,
    strategy_confirmed: true,
    status: 'intake',
  });
  if (!updated) throw new HttpError(404, WRITER_MESSAGES.appNotFound);
  logger.info('strategy_confirmed', { correlation_id: app.correlation_id, app_id: app.id });
  return withUrgency(updated);
}

// =============================================================================
// 4.4 Stakeholder intake
// =============================================================================

/** Generate per-stakeholder request packets for all open gaps. Sending is human work: copy-paste emails. */
async function generateIntakeRoute(ctx: RequestContext): Promise<unknown> {
  const user = await ctx.user();
  const app = await loadApplication(user.id, ctx.params.appId);
  await loadWriterProfile(user.id);
  const gaps = await getGaps(user.id, app.id);
  if (!gaps.length) return { intake_requests: [], note: WRITER_MESSAGES.noGaps };
  await requireApiKey(user.id);
  if (!gaps.some((gap) => gap.status === 'open')) {
    // Every gap is already routed or resolved: nothing for Claude to write (the Python returned the same).
    await touchApplication(user.id, app.id);
    return { intake_requests: [] };
  }
  return startJob(ctx, 'writer.intake_generate', { app_id: app.id }, jobOptions(app));
}

/** Record a stakeholder's answer. It flows back into the SHARED org profile (reused next time and by matching). */
async function recordIntakeAnswer(ctx: RequestContext): Promise<Record<string, unknown>> {
  const user = await ctx.user();
  const body = await ctx.json();
  const response = body.response;
  if (typeof response !== 'string') throw new HttpError(422, 'Field "response" is required.');
  const confirmedGap = parseBool(body.is_confirmed_gap, 'is_confirmed_gap', false);
  // An empty "answer" would add an empty evidence item to the shared profile.
  if (!confirmedGap && !response.trim()) throw new HttpError(422, 'Field "response" is required.');
  const app = await loadApplication(user.id, ctx.params.appId);
  await loadWriterProfile(user.id);

  let answered = null as IntakeRequest | null;
  await updateIntakeRequests(user.id, app.id, (requests) => {
    answered = null;
    const index = requests.findIndex((request) => request.id === ctx.params.requestId);
    if (index < 0) return undefined;
    const next: IntakeRequest = { ...requests[index], response, status: confirmedGap ? 'confirmed_gap' : 'answered' };
    requests[index] = next;
    answered = next;
    return requests;
  });
  if (!answered) throw new HttpError(404, WRITER_MESSAGES.intakeNotFound);
  const request: IntakeRequest = answered;

  // "We don't have that" is a valid, useful outcome -> honest framing path.
  const gapIds = new Set(request.gap_ids);
  const gaps = await updateGaps(user.id, app.id, (current) =>
    current.map((gap): Gap => (gapIds.has(gap.id) ? { ...gap, status: confirmedGap ? 'confirmed_gap' : 'answered', answer: response } : gap)),
  );

  if (!confirmedGap) {
    // Compounding asset: the answer enriches the shared profile.
    await updateProfile(user.id, (profile) =>
      profile
        ? {
            ...profile,
            evidence: [
              ...profile.evidence,
              {
                id: newId('ev'),
                type: 'stakeholder_answer',
                summary: response,
                source_ref: `${request.stakeholder_role} via intake for ${app.grant_name}`,
                linked_programs: [],
              },
            ],
            sources: [...profile.sources, `Stakeholder answer: ${request.stakeholder_role}`],
          }
        : undefined,
    );
  }
  await touchApplication(user.id, app.id);
  logger.info('intake_answered', {
    correlation_id: app.correlation_id,
    app_id: app.id,
    request_id: request.id,
    confirmed_gap: confirmedGap,
    gaps: request.gap_ids.length,
  });
  return { intake_request: request, gaps };
}

/** Explicitly waive a gap (unblocks drafting for high-severity gaps). */
async function waiveGap(ctx: RequestContext): Promise<Gap> {
  const user = await ctx.user();
  const body = await ctx.json();
  const reason = optionalString(body, 'reason');
  const app = await loadApplication(user.id, ctx.params.appId);
  let waived = null as Gap | null;
  await updateGaps(user.id, app.id, (gaps) => {
    waived = null;
    const index = gaps.findIndex((gap) => gap.id === ctx.params.gapId);
    if (index < 0) return undefined;
    const next: Gap = { ...gaps[index], status: 'waived', answer: `Waived by Grant Lead: ${reason || 'no reason given'}` };
    gaps[index] = next;
    waived = next;
    return gaps;
  });
  if (!waived) throw new HttpError(404, WRITER_MESSAGES.gapNotFound);
  await touchApplication(user.id, app.id);
  logger.info('gap_waived', { correlation_id: app.correlation_id, app_id: app.id, gap_id: ctx.params.gapId });
  return waived;
}

// =============================================================================
// 4.5 Drafting
// =============================================================================

/**
 * Draft all sections (or one). Blocked until the strategy is confirmed and
 * every high-severity gap is resolved, confirmed, or waived (PRD 5.2).
 */
async function draftSectionsRoute(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  const body = await ctx.json();
  const sectionId = optionalString(body, 'section_id');
  const onlyMissing = body.only_missing === true;
  const app = await loadApplication(user.id, ctx.params.appId);
  await loadWriterProfile(user.id);
  const spec = await getGrantSpec(user.id, app.grant_id);
  if (!spec) throw new HttpError(400, WRITER_MESSAGES.specFirst);
  assertDraftAllowed(app, await getGaps(user.id, app.id));
  if (sectionId && !spec.required_sections.some((section) => section.id === sectionId)) {
    throw new HttpError(404, WRITER_MESSAGES.draftSectionNotInSpec);
  }
  await requireApiKey(user.id);
  return startJob(ctx, 'writer.draft', { app_id: app.id, section_id: sectionId || null, only_missing: onlyMissing }, {
    ...jobOptions(app),
    exclusiveKey: `writer.sections:${app.id}`,
  });
}

// =============================================================================
// 4.6 Self-scoring
// =============================================================================

async function scoreApplicationRoute(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  const app = await loadApplication(user.id, ctx.params.appId);
  const [spec, drafts] = await Promise.all([getGrantSpec(user.id, app.grant_id), listSectionDrafts(user.id, app.id)]);
  if (!spec || !drafts.length) throw new HttpError(400, WRITER_MESSAGES.draftFirst);
  await requireApiKey(user.id);
  return startJob(ctx, 'writer.score', { app_id: app.id }, jobOptions(app));
}

// =============================================================================
// 4.7 Refinement
// =============================================================================

async function refineSectionRoute(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  const body = await ctx.json();
  const instruction = requireString(body, 'instruction');
  const app = await loadApplication(user.id, ctx.params.appId);
  await loadWriterProfile(user.id);
  const sectionId = ctx.params.sectionId;
  const [spec, draft] = await Promise.all([getGrantSpec(user.id, app.grant_id), getSectionDraft(user.id, app.id, sectionId)]);
  if (!spec || !draft) throw new HttpError(404, WRITER_MESSAGES.sectionDraftNotFound);
  const section = spec.required_sections.find((item) => item.id === sectionId);
  if (!section) throw new HttpError(404, WRITER_MESSAGES.sectionNotInSpec);
  if (!draftFitsSection(draft, section)) throw new HttpError(409, replacedQuestionMessage(draft.title, section.title));
  await requireApiKey(user.id);
  // Drafting and refining write the same section records, so they never run at once.
  return startJob(ctx, 'writer.refine', { app_id: app.id, section_id: sectionId, instruction }, {
    ...jobOptions(app),
    exclusiveKey: `writer.sections:${app.id}`,
  });
}

// =============================================================================
// 4.8 Export (GATE 2: explicit human action; nothing auto-submitted)
// =============================================================================

async function exportApplication(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  const body = await ctx.json();
  const format = exportFormat(body.format);
  const app = await loadApplication(user.id, ctx.params.appId);
  const [spec, stored, profile] = await Promise.all([
    getGrantSpec(user.id, app.grant_id),
    listSectionDrafts(user.id, app.id),
    getProfile(user.id),
  ]);
  if (!spec || !stored.length) throw new HttpError(400, WRITER_MESSAGES.nothingToExport);

  // Only sections the CURRENT requirements ask for are exported (re-analyzing
  // the grant can drop or add sections). Undrafted ones get a visible placeholder.
  const { current, stale, missing } = draftsVsSpec(stored, spec);
  if (!current.length) throw new HttpError(400, WRITER_MESSAGES.nothingToExport);

  // Re-check every section against the CURRENT limits and banned phrases (never trust a stale flag).
  const limits = new Map(spec.required_sections.map((section) => [section.id, section]));
  const checkedDrafts = current.map((draft) => {
    const checked = structuredClone(draft);
    applyCompliance(checked, limits.get(draft.section_id) ?? null, profile);
    return checked;
  });

  // Hard rule: never export over-limit content.
  const overLimit = checkedDrafts.filter((draft) => draft.over_limit).map((draft) => draft.title);
  if (overLimit.length) {
    throw new HttpError(
      409,
      `Cannot export: section(s) over their hard limit: ${overLimit.join(', ')}. Refine them (e.g. 'tighten to the limit') first.`,
    );
  }
  const dirty = checkedDrafts.filter((draft) => draft.banned_phrase_hits.length).map((draft) => draft.title);
  if (dirty.length) {
    throw new HttpError(409, `Cannot export: banned phrases remain in: ${dirty.join(', ')}. Refine first.`);
  }

  const placeholders: SectionDraft[] = missing.map((section) => ({
    id: `missing_${section.id}`,
    application_id: app.id,
    section_id: section.id,
    title: section.title,
    current_draft: '[NOT DRAFTED YET: draft this section in GrantFinder before you submit.]',
    versions: [],
    claims: [],
    word_count: 0,
    char_count: 0,
    over_limit: false,
    banned_phrase_hits: [],
    compliance_notes: ['Not drafted yet'],
  }));
  const drafts = orderDrafts([...checkedDrafts, ...placeholders], spec);

  const file = await buildExport(format, app, spec, drafts);
  await touchApplication(user.id, app.id, { status: 'export' });
  const notices = [
    missing.length ? `Not drafted yet (marked in the file): ${missing.map((section) => section.title).join(', ')}.` : '',
    stale.length ? `Left out because the current requirements no longer ask for them: ${stale.map((draft) => draft.title).join(', ')}.` : '',
  ].filter(Boolean);
  logger.info('application_exported', {
    correlation_id: app.correlation_id,
    app_id: app.id,
    format,
    file: file.filename,
    missing_sections: missing.length,
    stale_sections: stale.length,
  });
  const response = fileResponse(file.body, file.filename, file.contentType);
  if (notices.length) response.headers.set('x-grantfinder-notice', encodeURIComponent(notices.join(' ')));
  return response;
}

// =============================================================================
// Section 8: Debug bundle and recent AI calls
// =============================================================================

const pyBool = (value: boolean) => (value ? 'True' : 'False');
const cell = (text: string) => text.replace(/\s+/g, ' ').replace(/\|/g, '\\|');

function describeJob(job: Job): string[] {
  const ms = job.started_at && job.finished_at ? Date.parse(job.finished_at) - Date.parse(job.started_at) : null;
  const lines = [
    `- ${job.created_at} \`${job.kind}\` ${job.status.toUpperCase()}${ms !== null ? ` in ${(ms / 1000).toFixed(1)}s` : ''} ` +
      `(job \`${job.id}\`, ${job.ai_calls.length} AI call(s))${job.progress ? ` | last status: ${job.progress}` : ''}`,
  ];
  if (job.error) lines.push(`  - Error shown (HTTP ${job.error.status}): ${job.error.detail}`);
  if (job.error_debug) {
    lines.push('  - Internal error:', '    ```', ...job.error_debug.replace(/```/g, "'''").split('\n').map((line) => `    ${line}`), '    ```');
  }
  for (const note of job.notes.slice(-20)) lines.push(`  - ${note}`);
  return lines;
}

/** One paste-ready markdown bundle: correlation id, state, AI call timeline with costs, steps, errors. */
async function debugBundle(ctx: RequestContext): Promise<{ bundle_markdown: string }> {
  const user = await ctx.user();
  const app = await loadApplication(user.id, ctx.params.appId);
  const [jobs, spec, analysis, gaps, intake, stored, scorecard] = await Promise.all([
    listJobs(user.id, 200),
    getGrantSpec(user.id, app.grant_id),
    getFitAnalysis(user.id, app.id),
    getGaps(user.id, app.id),
    getIntakeRequests(user.id, app.id),
    listSectionDrafts(user.id, app.id),
    getScorecard(user.id, app.id),
  ]);
  const appJobs = jobs.filter((job) => job.application_id === app.id).reverse(); // oldest first
  const calls: AICallLog[] = appJobs.flatMap((job) => job.ai_calls).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const drafts = orderDrafts(stored, spec);
  const limits = new Map((spec?.required_sections ?? []).map((section) => [section.id, section]));
  const statusCounts = Array.from(new Set(gaps.map((gap) => gap.status)))
    .map((status) => `${status} ${gaps.filter((gap) => gap.status === status).length}`)
    .join(', ');

  const lines = [
    '# GrantFinder Debug Bundle',
    `- **Correlation ID:** ${app.correlation_id}`,
    `- **Application:** ${app.id} - ${app.grant_name} (${app.funder})`,
    `- **Status:** ${app.status} | strategy_confirmed=${pyBool(app.strategy_confirmed)} | urgent=${pyBool(app.urgent)}`,
    `- **Created:** ${app.created_at} | Updated: ${app.updated_at}`,
    `- **Model:** ${calls.length ? calls[calls.length - 1].model : 'n/a'}`,
    `- **Deadline:** ${app.deadline || 'n/a'} | Bundle generated: ${new Date().toISOString()}`,
    '',
    '## State summary',
    `- Grant spec: ${
      spec
        ? `yes (${spec.required_sections.length} sections, rubric ${spec.rubric_source}, ` +
          `guidelines ${spec.guidelines_text ? `${spec.guidelines_text.length} chars` : 'none'})`
        : 'MISSING'
    }`,
    `- Fit analysis: ${analysis ? 'yes' : 'MISSING'}`,
    `- Gaps: ${gaps.length} (${gaps.filter((gap) => gap.severity === 'high').length} high)${statusCounts ? ` [${statusCounts}]` : ''}`,
    `- Intake requests: ${intake.length}`,
    `- Sections drafted: ${drafts.length} (${drafts.filter((d) => d.over_limit).length} over limit, ` +
      `${drafts.filter((d) => d.banned_phrase_hits.length).length} with banned phrases)`,
    ...drafts.map((d) => {
      const section = limits.get(d.section_id);
      const limit = section?.word_limit ? `limit ${section.word_limit} words` : section?.char_limit ? `limit ${section.char_limit} chars` : 'no limit';
      return (
        `  - ${d.section_id} ${d.title}: ${d.word_count} words / ${d.char_count} chars (${limit})` +
        `${d.over_limit ? ' OVER LIMIT' : ''}${d.banned_phrase_hits.length ? ` banned: ${d.banned_phrase_hits.join(', ')}` : ''}` +
        ` | ${d.claims.filter((c) => c.flagged).length} unsupported claim(s) | ${d.versions.length} earlier version(s)`
      );
    }),
    `- Scorecard: ${scorecard ? 'yes' : 'no'}`,
    '',
    '## AI call timeline',
    '| time | stage | prompt | in_tok | out_tok | ms | $est | status |',
    '|---|---|---|---|---|---|---|---|',
  ];
  let totalCost = 0;
  for (const c of calls) {
    totalCost += c.cost_estimate_usd;
    lines.push(
      `| ${c.timestamp.slice(11, 19)} | ${c.stage} | ${c.prompt_id} | ${c.input_tokens} | ${c.output_tokens} | ${c.latency_ms} ` +
        `| ${c.cost_estimate_usd.toFixed(4)} | ${c.status}${c.error ? ` - ${cell(c.error.slice(0, 80))}` : ''} |`,
    );
  }
  lines.push('', `**Total estimated AI cost for this application: $${totalCost.toFixed(4)}**`);

  lines.push('', '## Steps (background jobs, oldest first)');
  if (!appJobs.length) lines.push('_No steps yet._');
  for (const job of appJobs) lines.push(...describeJob(job));

  const errorCalls = calls.filter((c) => c.status === 'error');
  const failedJobs = appJobs.filter((job) => job.status === 'failed');
  if (errorCalls.length || failedJobs.length) {
    lines.push('', '## Errors');
    for (const c of errorCalls) lines.push(`- [${c.timestamp}] ${c.stage}/${c.prompt_id}: ${c.error}`);
    for (const job of failedJobs) {
      lines.push(`- [${job.finished_at || job.updated_at}] step ${job.kind} (${job.id}): HTTP ${job.error?.status ?? '?'} ${job.error?.detail ?? ''}`);
    }
  }
  return { bundle_markdown: lines.join('\n') };
}

/** In-app log surface: this user's recent AI calls (newest first). */
async function recentAiLogs(ctx: RequestContext): Promise<AICallLog[]> {
  const user = await ctx.user();
  let limit = 50;
  const raw = ctx.query.get('limit');
  if (raw !== null && raw.trim() !== '') {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) throw new HttpError(422, 'Query parameter "limit" must be a whole number.');
    limit = clamp(parsed, 1, 500);
  }
  const jobs = await listJobs(user.id, 100);
  const calls = jobs.flatMap((job) => job.ai_calls);
  calls.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return calls.slice(0, limit);
}

export function registerWriterRoutes(router: Router): void {
  router.post('/api/writer/applications', createApplication);
  router.get('/api/writer/applications', listUserApplications);
  router.get('/api/writer/applications/:appId', getApplicationState);
  router.post('/api/writer/voice/analyze', analyzeVoiceRoute);
  router.post('/api/writer/applications/:appId/grant-spec', enrichGrantSpecRoute);
  router.post('/api/writer/applications/:appId/analyze', analyzeFitRoute);
  router.post('/api/writer/applications/:appId/confirm-strategy', confirmStrategy);
  router.post('/api/writer/applications/:appId/intake/generate', generateIntakeRoute);
  router.put('/api/writer/applications/:appId/intake/:requestId/answer', recordIntakeAnswer);
  router.put('/api/writer/applications/:appId/gaps/:gapId/waive', waiveGap);
  router.post('/api/writer/applications/:appId/draft', draftSectionsRoute);
  router.post('/api/writer/applications/:appId/score', scoreApplicationRoute);
  router.post('/api/writer/applications/:appId/sections/:sectionId/refine', refineSectionRoute);
  router.post('/api/writer/applications/:appId/export', exportApplication);
  router.get('/api/writer/applications/:appId/debug-bundle', debugBundle);
  router.get('/api/writer/logs/recent', recentAiLogs);
}
