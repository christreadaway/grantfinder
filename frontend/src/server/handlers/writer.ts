/**
 * Background job handlers for the GrantWriter: every writer Claude call runs here.
 *
 * Each handler is the AI half of one endpoint in backend/routers/writer.py.
 * The route already checked everything it could and answered 202; the handler
 * re-checks the same gates (state can change between the request and the
 * run), runs the stage from services/writer.ts, saves the result, and returns
 * exactly the JSON body the Python endpoint returned (the website uses the
 * job's `result` as the response).
 *
 * Must not import docx or services/writerExport.ts (keeps the background function small).
 */
import { testMode } from '../config';
import { ClaudeError, errorMessage, HttpError, isFatalClaudeError } from '../errors';
import type { JobContext, JobHandler } from '../jobs';
import { asRecord, asString, asStringList } from '../json';
import { logger } from '../log';
import { updateProfile } from '../repo';
import { getGrantOrFoundation } from '../services/ai';
import {
  analyzeFit,
  analyzeVoice,
  assertDraftAllowed,
  draftSection,
  enrichGrantSpec,
  fetchGuidelines,
  generateIntakePackets,
  loadApplication,
  loadWriterProfile,
  draftFitsSection,
  draftsVsSpec,
  replacedQuestionMessage,
  refineSection,
  scoreDraft,
  WRITER_MESSAGES,
  type WriterAI,
  type WriterRun,
} from '../services/writer';
import {
  getFitAnalysis,
  getGaps,
  getGrantSpec,
  getSectionDraft,
  listSectionDrafts,
  saveFitAnalysis,
  saveGaps,
  saveGrantSpec,
  saveScorecard,
  saveSectionDraft,
  touchApplication,
  updateGaps,
  updateIntakeRequests,
} from '../services/writerRepo';
import type { RequiredSection, SectionDraft } from '../types';

/** Sections drafted at the same time. */
const DRAFT_CONCURRENCY = 3;
/**
 * No new section (or retry) starts after this long, so sections already in
 * flight (draft + voice check, a few minutes at most) finish inside Netlify's
 * 15-minute limit.
 */
const DRAFT_START_BUDGET_MS = 10 * 60 * 1000;

function runFor(ctx: JobContext, ai: WriterAI): WriterRun {
  return {
    ai,
    correlationId: ctx.correlationId,
    applicationId: ctx.applicationId,
    note: (line) => ctx.note(line),
    progress: (message) => ctx.progress(message),
  };
}

function input(ctx: JobContext): Record<string, unknown> {
  return asRecord(ctx.input);
}

function appIdOf(ctx: JobContext): string {
  const appId = asString(input(ctx).app_id) || ctx.applicationId;
  if (!appId) throw new HttpError(400, 'This step lost track of its application. Reopen the application and try again.');
  return appId;
}

/** The plain-English reason a section failed, for the summary message. */
function failureDetail(error: unknown): string {
  if (error instanceof HttpError || error instanceof ClaudeError) return error.detail;
  return errorMessage(error).slice(0, 200);
}

function failureStatus(error: unknown): number {
  if (error instanceof HttpError || error instanceof ClaudeError) return error.status;
  return 500;
}

// =============================================================================
// 4.1 Voice profile (writer extension of the shared org profile)
// =============================================================================

async function voiceAnalyzeJob(ctx: JobContext): Promise<unknown> {
  const samples = asStringList(input(ctx).samples).filter((sample) => sample.trim());
  if (!samples.length) throw new HttpError(400, WRITER_MESSAGES.noSamples);
  await loadWriterProfile(ctx.userId);
  await ctx.progress('Reading your writing samples...');
  const run = runFor(ctx, await ctx.claude());
  const voice = await analyzeVoice(run, samples);
  const saved = await updateProfile(ctx.userId, (profile) =>
    profile ? { ...profile, voice_profile: voice, sources: [...profile.sources, 'Voice samples analyzed'] } : undefined,
  );
  if (!saved) throw new HttpError(400, WRITER_MESSAGES.profileMissing);
  logger.info('voice_profile_saved', {
    user_id: ctx.userId,
    correlation_id: ctx.correlationId,
    samples: samples.length,
    banned_phrases: asStringList(voice.banned_phrases).length,
  });
  return { voice_profile: voice };
}

// =============================================================================
// 4.2 Grant Spec enrichment
// =============================================================================

async function grantSpecJob(ctx: JobContext): Promise<unknown> {
  const app = await loadApplication(ctx.userId, appIdOf(ctx));
  const grant = await getGrantOrFoundation(ctx.userId, app.grant_id);
  if (!grant) throw new HttpError(404, WRITER_MESSAGES.underlyingGrantMissing);

  const pasted = asString(input(ctx).guidelines_text);
  let guidelines: string | null = pasted.trim() ? pasted : null;
  let note: string | null = null;
  if (guidelines) {
    ctx.note(`Guidelines pasted (${guidelines.length} characters).`);
  } else if (grant.url && grant.url.trim()) {
    // Fall back to the source grantfinder already has (HTML or PDF, SSRF-safe).
    await ctx.progress('Reading the grant guidelines from the funder website...');
    const fetched = await fetchGuidelines(grant.url);
    if (fetched.ok) {
      guidelines = fetched.text;
      note = `Guidelines fetched from ${grant.url}`;
      ctx.note(`${note} (${fetched.text.length} characters).`);
    } else {
      note = `Could not read ${grant.url} (${fetched.reason}); requirements were inferred. Paste the guidelines for an exact spec.`;
      ctx.note(note);
      logger.warn('guidelines_fetch_failed', { correlation_id: app.correlation_id, app_id: app.id, url: grant.url, reason: fetched.reason });
    }
  } else {
    note = 'No guidelines were pasted and the grant record has no website; requirements were inferred. Paste the guidelines for an exact spec.';
    ctx.note(note);
  }

  await ctx.progress('Extracting the application requirements...');
  const run = runFor(ctx, await ctx.claude());
  const spec = await enrichGrantSpec(run, grant, guidelines);
  await saveGrantSpec(ctx.userId, spec);
  await touchApplication(ctx.userId, app.id);
  logger.info('grant_spec_enriched', {
    correlation_id: app.correlation_id,
    app_id: app.id,
    sections: spec.required_sections.length,
    rubric: spec.rubric.length,
    rubric_source: spec.rubric_source,
    guidelines: pasted.trim() ? 'pasted' : guidelines ? 'fetched' : 'none',
  });
  return { grant_spec: spec, note };
}

// =============================================================================
// 4.3 Fit / Gap analysis
// =============================================================================

async function analyzeJob(ctx: JobContext): Promise<unknown> {
  const app = await loadApplication(ctx.userId, appIdOf(ctx));
  const profile = await loadWriterProfile(ctx.userId);
  const spec = await getGrantSpec(ctx.userId, app.grant_id);
  if (!spec) throw new HttpError(400, WRITER_MESSAGES.specFirst);

  await ctx.progress('Comparing your profile with the grant rubric...');
  const run = runFor(ctx, await ctx.claude());
  const { analysis, gaps } = await analyzeFit(run, profile, spec, app.id);
  await saveFitAnalysis(ctx.userId, analysis);
  await saveGaps(ctx.userId, app.id, gaps);
  await touchApplication(ctx.userId, app.id, { status: 'analysis' });
  logger.info('fit_analyzed', {
    correlation_id: app.correlation_id,
    app_id: app.id,
    criteria: analysis.fit_map.length,
    gaps: gaps.length,
    high_gaps: gaps.filter((gap) => gap.severity === 'high').length,
  });
  return { fit_analysis: analysis, gaps };
}

// =============================================================================
// 4.4 Stakeholder intake (packets are copy-paste emails: nothing is ever sent)
// =============================================================================

async function intakeGenerateJob(ctx: JobContext): Promise<unknown> {
  const app = await loadApplication(ctx.userId, appIdOf(ctx));
  const profile = await loadWriterProfile(ctx.userId);
  const gaps = await getGaps(ctx.userId, app.id);
  if (!gaps.length) return { intake_requests: [], note: WRITER_MESSAGES.noGaps };

  await ctx.progress('Writing the stakeholder request emails...');
  const run = runFor(ctx, await ctx.claude());
  const requests = await generateIntakePackets(run, app, gaps, profile);
  if (requests.length) {
    await updateIntakeRequests(ctx.userId, app.id, (current) => [...current, ...requests]);
    const routed = new Set(requests.flatMap((request) => request.gap_ids));
    await updateGaps(ctx.userId, app.id, (current) =>
      // Only gaps still open: one may have been waived while Claude was writing.
      current.map((gap) => (routed.has(gap.id) && gap.status === 'open' ? { ...gap, status: 'routed' } : gap)),
    );
  }
  await touchApplication(ctx.userId, app.id);
  logger.info('intake_generated', { correlation_id: app.correlation_id, app_id: app.id, requests: requests.length });
  return { intake_requests: requests };
}

// =============================================================================
// 4.5 Drafting (blocked by the strategy gate and open high-severity gaps)
// =============================================================================

async function draftJob(ctx: JobContext): Promise<unknown> {
  const app = await loadApplication(ctx.userId, appIdOf(ctx));
  const profile = await loadWriterProfile(ctx.userId);
  const spec = await getGrantSpec(ctx.userId, app.grant_id);
  if (!spec) throw new HttpError(400, WRITER_MESSAGES.specFirst);
  const gaps = await getGaps(ctx.userId, app.id);
  assertDraftAllowed(app, gaps);

  const onlySection = asString(input(ctx).section_id);
  const onlyMissing = (input(ctx) as { only_missing?: unknown }).only_missing === true;
  // Earlier drafts, so a redraft keeps the replaced text in the section's history.
  const priorDrafts = new Map((await listSectionDrafts(ctx.userId, app.id)).map((draft) => [draft.section_id, draft]));
  // Sections that already have a draft written for the CURRENT question.
  const covered = new Set(draftsVsSpec([...priorDrafts.values()], spec).current.map((draft) => draft.section_id));
  let targets = spec.required_sections;
  if (onlySection) {
    targets = spec.required_sections.filter((section) => section.id === onlySection);
    if (!targets.length) throw new HttpError(404, WRITER_MESSAGES.draftSectionNotInSpec);
  } else if (onlyMissing) {
    targets = spec.required_sections.filter((section) => !covered.has(section.id));
    if (!targets.length) return { sections: [], note: 'Every required section already has a draft.' };
  }
  const analysis = await getFitAnalysis(ctx.userId, app.id);
  const confirmedGaps = gaps.filter((gap) => gap.status === 'confirmed_gap');

  // Sections that have no draft yet go first, so a run cut short still fills the holes.
  const existing = covered;
  const queue = [...targets.filter((s) => !existing.has(s.id)), ...targets.filter((s) => existing.has(s.id))];

  const run = runFor(ctx, await ctx.claude());
  const started = Date.now();
  const total = queue.length;
  const outOfTime = () => Date.now() - started > DRAFT_START_BUDGET_MS;
  const drafted = new Map<string, SectionDraft>();
  let failed: Array<{ section: RequiredSection; error: unknown }> = [];
  const skipped: RequiredSection[] = [];
  // Shared by the workers (an object, so TypeScript sees the closures' writes).
  const shared: { fatal: unknown; next: number } = { fatal: null, next: 0 };

  /** Draft one section and save it the moment it is finished, so nothing finished is ever lost. */
  const draftOne = async (section: RequiredSection): Promise<void> => {
    try {
      const draft = await draftSection(run, app, section, spec, profile, analysis, confirmedGaps);
      const prior = priorDrafts.get(section.id);
      if (prior?.current_draft) {
        // Keep what this replaces (including refinements), newest last, capped.
        draft.versions = [...(prior.versions ?? []), prior.current_draft, ...draft.versions].slice(-12);
      }
      await saveSectionDraft(ctx.userId, draft);
      drafted.set(section.id, draft);
      ctx.note(
        `Drafted ${section.id} "${section.title}": ${draft.word_count} words, ${draft.char_count} chars` +
          `${draft.over_limit ? ', OVER LIMIT' : ''}${draft.banned_phrase_hits.length ? `, banned: ${draft.banned_phrase_hits.join(', ')}` : ''}` +
          `, ${draft.claims.filter((claim) => claim.flagged).length} unsupported claim(s)`,
      );
      logger.info('section_drafted', {
        correlation_id: app.correlation_id,
        app_id: app.id,
        section_id: section.id,
        words: draft.word_count,
        over_limit: draft.over_limit,
        banned_hits: draft.banned_phrase_hits.length,
      });
    } catch (error) {
      if (isFatalClaudeError(error)) {
        if (shared.fatal === null) shared.fatal = error;
        return;
      }
      failed.push({ section, error });
      ctx.note(`Section ${section.id} "${section.title}" failed: ${failureDetail(error)}`);
      logger.error('section_draft_failed', { correlation_id: app.correlation_id, app_id: app.id, section_id: section.id, error });
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (shared.fatal !== null) return;
      const index = shared.next++;
      if (index >= total) return;
      const section = queue[index];
      if (outOfTime()) {
        skipped.push(section);
        continue;
      }
      await ctx.progress(`Drafting section ${index + 1} of ${total}: ${section.title}`);
      await draftOne(section);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DRAFT_CONCURRENCY, total) }, () => worker()));

  // Second chance, one at a time, for sections that hit a passing problem
  // (rate limit or overload that outlasted the client's retries, an unreadable answer).
  if (shared.fatal === null && failed.length && !outOfTime()) {
    const retry = failed;
    failed = [];
    const busy = retry.some(({ error }) => error instanceof ClaudeError && (error.kind === 'rate_limit' || error.kind === 'overloaded'));
    await new Promise((resolve) => setTimeout(resolve, testMode() ? 50 : busy ? 20000 : 2000));
    for (const item of retry) {
      if (shared.fatal !== null || outOfTime()) {
        failed.push(item);
        continue;
      }
      await ctx.progress(`Trying "${item.section.title}" again...`);
      ctx.note(`Retrying ${item.section.id} "${item.section.title}" once.`);
      await draftOne(item.section);
    }
  }

  if (drafted.size) await touchApplication(ctx.userId, app.id, { status: 'drafting' });

  if (shared.fatal !== null) {
    // Bad key, no credits, unknown model: every section would fail the same way.
    if (!drafted.size) throw shared.fatal;
    throw new HttpError(
      failureStatus(shared.fatal),
      `${failureDetail(shared.fatal)} (${drafted.size} of ${total} sections were drafted and saved before this.)`,
    );
  }
  if (failed.length && !drafted.size && !skipped.length) throw failed[0].error;
  if (failed.length || skipped.length) {
    const parts = [
      ...failed.map(({ section, error }) => `"${section.title}" (${failureDetail(error)})`),
      ...skipped.map((section) => `"${section.title}" (not started: stopped early to finish within the 15-minute limit)`),
    ];
    throw new HttpError(
      failed.length ? failureStatus(failed[0].error) : 503,
      `Drafted and saved ${drafted.size} of ${total} sections. Not drafted: ${parts.join('; ')}. ` +
        'The saved sections are kept; run drafting again to finish (sections without a draft go first).',
    );
  }

  logger.info('draft_finished', { correlation_id: app.correlation_id, app_id: app.id, sections: drafted.size, ms: Date.now() - started });
  return { sections: targets.filter((section) => drafted.has(section.id)).map((section) => drafted.get(section.id) as SectionDraft) };
}

// =============================================================================
// 4.6 Self-scoring
// =============================================================================

async function scoreJob(ctx: JobContext): Promise<unknown> {
  const app = await loadApplication(ctx.userId, appIdOf(ctx));
  const spec = await getGrantSpec(ctx.userId, app.grant_id);
  // Only sections the current requirements ask for are scored.
  const drafts = spec ? draftsVsSpec(await listSectionDrafts(ctx.userId, app.id), spec).current : [];
  if (!spec || !drafts.length) throw new HttpError(400, WRITER_MESSAGES.draftFirst);

  await ctx.progress('Scoring the draft against the rubric...');
  const run = runFor(ctx, await ctx.claude());
  const scorecard = await scoreDraft(run, app, spec, drafts);
  await saveScorecard(ctx.userId, scorecard);
  await touchApplication(ctx.userId, app.id, { status: 'review' });
  logger.info('scorecard_generated', {
    correlation_id: app.correlation_id,
    app_id: app.id,
    overall_score: scorecard.overall_score,
    criteria: scorecard.per_criterion.length,
  });
  return scorecard;
}

// =============================================================================
// 4.7 Refinement
// =============================================================================

async function refineJob(ctx: JobContext): Promise<unknown> {
  const app = await loadApplication(ctx.userId, appIdOf(ctx));
  const profile = await loadWriterProfile(ctx.userId);
  const sectionId = asString(input(ctx).section_id);
  const instruction = asString(input(ctx).instruction);
  const spec = await getGrantSpec(ctx.userId, app.grant_id);
  const draft = await getSectionDraft(ctx.userId, app.id, sectionId);
  if (!spec || !draft) throw new HttpError(404, WRITER_MESSAGES.sectionDraftNotFound);
  const section = spec.required_sections.find((s) => s.id === sectionId);
  if (!section) throw new HttpError(404, WRITER_MESSAGES.sectionNotInSpec);
  if (!draftFitsSection(draft, section)) throw new HttpError(409, replacedQuestionMessage(draft.title, section.title));

  await ctx.progress(`Revising "${draft.title}"...`);
  const run = runFor(ctx, await ctx.claude());
  const revised = await refineSection(run, app, draft, section, profile, instruction);
  await saveSectionDraft(ctx.userId, revised);
  await touchApplication(ctx.userId, app.id);
  ctx.note(`Refined ${section.id}: ${revised.word_count} words${revised.over_limit ? ', still OVER LIMIT' : ''}`);
  logger.info('section_refined', {
    correlation_id: app.correlation_id,
    app_id: app.id,
    section_id: section.id,
    words: revised.word_count,
    over_limit: revised.over_limit,
    banned_hits: revised.banned_phrase_hits.length,
  });
  return revised;
}

export const writerJobs: Record<string, JobHandler> = {
  'writer.voice_analyze': voiceAnalyzeJob,
  'writer.grant_spec': grantSpecJob,
  'writer.analyze': analyzeJob,
  'writer.intake_generate': intakeGenerateJob,
  'writer.draft': draftJob,
  'writer.score': scoreJob,
  'writer.refine': refineJob,
};
