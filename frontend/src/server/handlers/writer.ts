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
import type { JobContext, JobContinuation, JobHandler } from '../jobs';
import { asRecord, asString, asStringList } from '../json';
import { logger } from '../log';
import { updateProfile } from '../repo';
import { getGrantOrFoundation } from '../services/ai';
import {
  addNote,
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
  MAX_SECTION_VERSIONS,
  openGapsByCoverage,
  refineConflictMessage,
  replacedQuestionMessage,
  refineSection,
  scoreDraft,
  SECTION_NOTES,
  WRITER_MESSAGES,
  type WriterAI,
  type WriterRun,
} from '../services/writer';
import {
  getFitAnalysis,
  getGaps,
  getGrantSpec,
  getIntakeRequests,
  getSectionDraft,
  listSectionDrafts,
  saveFitAnalysis,
  saveGaps,
  saveGrantSpec,
  saveScorecard,
  touchApplication,
  updateGaps,
  updateIntakeRequests,
  updateSectionDraft,
  writeSectionDraft,
} from '../services/writerRepo';
import type { RequiredSection, SectionDraft } from '../types';

/** Sections drafted at the same time. */
const DRAFT_CONCURRENCY = 3;
/**
 * No new section (or retry) starts after this long, so sections already in
 * flight (draft + voice check, a few minutes at most) finish inside Netlify's
 * 15-minute limit (background mode).
 */
const DRAFT_START_BUDGET_MS = 10 * 60 * 1000;
/**
 * About how long one section takes (its draft plus the voice check). A section
 * starts only with this much time left before the step's cutoff; the rest go to
 * the next part (a step inside one Netlify request has about 50 seconds).
 */
const SECTION_ESTIMATE_MS = 40_000;
/** What the grant-spec Claude call needs after the guidelines page is read. */
const GRANT_SPEC_CALL_MS = 35_000;

/** Time left before this step's Claude calls are cut off (no limit when the runner doesn't say). */
function timeLeft(ctx: JobContext): number {
  return typeof ctx.timeLeftMs === 'function' ? ctx.timeLeftMs() : Number.POSITIVE_INFINITY;
}

function runFor(ctx: JobContext, ai: WriterAI): WriterRun {
  return {
    ai,
    correlationId: ctx.correlationId,
    applicationId: ctx.applicationId,
    note: (line) => ctx.note(line),
    progress: (message) => ctx.progress(message),
    timeLeftMs: () => timeLeft(ctx),
  };
}

/** A whole number >= 0 from a job input field, else 0. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
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
    // A slow site must leave the Claude call its time (a step inside one Netlify request has
    // about 50 seconds in all): 15 seconds there, the usual 30 in a long background run.
    const fetchTimeoutMs = Math.min(30_000, Math.max(5_000, timeLeft(ctx) - GRANT_SPEC_CALL_MS));
    const fetched = await fetchGuidelines(grant.url, fetchTimeoutMs);
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

  // Only open gaps that no request covers yet: a second round (after re-analysis,
  // or for gaps the first round left unassigned) never asks about a gap twice.
  const { uncovered, covered } = openGapsByCoverage(gaps, await getIntakeRequests(ctx.userId, app.id));
  if (covered.length) {
    // Asked already (an earlier run stopped before marking them): mark them asked.
    const asked = new Set(covered.map((gap) => gap.id));
    await updateGaps(ctx.userId, app.id, (current) =>
      current.map((gap) => (asked.has(gap.id) && gap.status === 'open' ? { ...gap, status: 'routed' } : gap)),
    );
    ctx.note(`Already covered by an earlier request (marked asked): ${covered.map((gap) => gap.id).join(', ')}`);
  }
  if (!uncovered.length) {
    await touchApplication(ctx.userId, app.id);
    return covered.length ? { intake_requests: [], note: WRITER_MESSAGES.allGapsAsked } : { intake_requests: [] };
  }

  await ctx.progress('Writing the stakeholder request emails...');
  const run = runFor(ctx, await ctx.claude());
  const requests = await generateIntakePackets(run, app, uncovered, profile);
  if (requests.length) {
    await updateIntakeRequests(ctx.userId, app.id, (current) => [...current, ...requests]);
    const routed = new Set(requests.flatMap((request) => request.gap_ids));
    await updateGaps(ctx.userId, app.id, (current) =>
      // Only gaps still open: one may have been waived while Claude was writing.
      current.map((gap) => (routed.has(gap.id) && gap.status === 'open' ? { ...gap, status: 'routed' } : gap)),
    );
  }
  await touchApplication(ctx.userId, app.id);
  logger.info('intake_generated', {
    correlation_id: app.correlation_id,
    app_id: app.id,
    requests: requests.length,
    gaps_routed: uncovered.length,
    gaps_already_asked: covered.length,
  });
  return { intake_requests: requests };
}

// =============================================================================
// 4.5 Drafting (blocked by the strategy gate and open high-severity gaps)
// =============================================================================

/**
 * What to click to finish after a partial run. Sections that have no draft at
 * all show up under "Draft missing sections" (the page offers that button). A
 * section that still has its earlier text (its redraft failed) is not missing,
 * so that button skips it: it needs its own Redraft button.
 */
function howToFinish(unfinished: RequiredSection[], hadDraft: Set<string>): string {
  const missingSentence = 'To finish, run drafting again with "Draft missing sections" (only the unfinished sections are drafted).';
  const stillOld = unfinished.filter((section) => hadDraft.has(section.id));
  if (!stillOld.length) return missingSentence;
  const titles = stillOld.map((section) => `"${section.title}"`).join(', ');
  const keeps = stillOld.length === 1 ? 'keeps its' : 'keep their';
  if (stillOld.length === unfinished.length) {
    return `To finish, run drafting again with the Redraft button on ${titles} (${stillOld.length === 1 ? 'it' : 'they'} ${keeps} earlier text until then).`;
  }
  return `${missingSentence} Then use the Redraft button on ${titles}, which ${keeps} earlier text until then.`;
}

async function draftJob(ctx: JobContext): Promise<unknown> {
  const app = await loadApplication(ctx.userId, appIdOf(ctx));
  const profile = await loadWriterProfile(ctx.userId);
  const spec = await getGrantSpec(ctx.userId, app.grant_id);
  if (!spec) throw new HttpError(400, WRITER_MESSAGES.specFirst);
  const gaps = await getGaps(ctx.userId, app.id);
  assertDraftAllowed(app, gaps);

  const params = input(ctx);
  const onlySection = asString(params.section_id);
  const onlyMissing = params.only_missing === true;
  // An explicit list: the next part of a run that did not fit in one step (each section once).
  const listed = new Set(asStringList(params.section_ids));
  // Earlier drafts, so a redraft keeps the replaced text in the section's history.
  const priorDrafts = new Map((await listSectionDrafts(ctx.userId, app.id)).map((draft) => [draft.section_id, draft]));
  // Sections that already have a draft written for the CURRENT question.
  const covered = new Set(draftsVsSpec([...priorDrafts.values()], spec).current.map((draft) => draft.section_id));
  let targets = spec.required_sections;
  if (listed.size) {
    targets = spec.required_sections.filter((section) => listed.has(section.id));
    if (!targets.length) throw new HttpError(404, WRITER_MESSAGES.draftSectionNotInSpec);
  } else if (onlySection) {
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
  // Numbering across the parts of one run ("Drafting section 4 of 6"): earlier parts drafted progress_offset sections.
  const progressOffset = countOf(params.progress_offset);
  const progressTotal = Math.max(countOf(params.progress_total), progressOffset + total);
  // A section starts only if it can finish in this step; the rest continue in the next part.
  const outOfTime = () => Date.now() - started > DRAFT_START_BUDGET_MS || timeLeft(ctx) < SECTION_ESTIMATE_MS;
  let startedCount = 0;
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
      // Compare-and-swap: if the section's text changed after this run read it (a hand edit
      // that slipped in), that text stays current and the new draft goes into its history.
      let keptTheirs = false as boolean;
      const saved = await writeSectionDraft(ctx.userId, app.id, section.id, (stored) => {
        keptTheirs = false;
        if (!stored) return draft;
        if (prior && stored.current_draft === prior.current_draft) {
          // Keep what this replaces (including refinements and hand edits), newest last, capped.
          const replaced = stored.current_draft ? [stored.current_draft] : [];
          return { ...draft, versions: [...(stored.versions ?? []), ...replaced, ...draft.versions].slice(-MAX_SECTION_VERSIONS) };
        }
        keptTheirs = true;
        const kept: SectionDraft = { ...stored, versions: [...(stored.versions ?? []), draft.current_draft].slice(-MAX_SECTION_VERSIONS) };
        addNote(kept, SECTION_NOTES.redraftKept);
        return kept;
      });
      const result = saved ?? draft;
      drafted.set(section.id, result);
      if (keptTheirs) {
        ctx.note(`Section ${section.id} "${section.title}" changed while drafting: kept the saved text; the new draft is in its earlier versions.`);
        logger.warn('section_draft_kept_saved_text', { correlation_id: app.correlation_id, app_id: app.id, section_id: section.id });
        return;
      }
      ctx.note(
        `Drafted ${section.id} "${section.title}": ${result.word_count} words, ${result.char_count} chars` +
          `${result.over_limit ? ', OVER LIMIT' : ''}${result.banned_phrase_hits.length ? `, banned: ${result.banned_phrase_hits.join(', ')}` : ''}` +
          `, ${result.claims.filter((claim) => claim.flagged).length} unsupported claim(s)`,
      );
      logger.info('section_drafted', {
        correlation_id: app.correlation_id,
        app_id: app.id,
        section_id: section.id,
        words: result.word_count,
        over_limit: result.over_limit,
        banned_hits: result.banned_phrase_hits.length,
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
      // Every part starts at least one section, so a run always moves forward.
      if (startedCount > 0 && outOfTime()) {
        skipped.push(section);
        continue;
      }
      startedCount++;
      await ctx.progress(`Drafting section ${progressOffset + index + 1} of ${progressTotal}: ${section.title}`);
      await draftOne(section);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DRAFT_CONCURRENCY, total) }, () => worker()));

  // Second chance, one at a time, for sections that hit a passing problem
  // (rate limit or overload that outlasted the client's retries, an unreadable answer),
  // when the wait and one more section still fit in this step.
  const busyFailure = failed.some(({ error }) => error instanceof ClaudeError && (error.kind === 'rate_limit' || error.kind === 'overloaded'));
  const retryWaitMs = testMode() ? 50 : busyFailure ? 20000 : 2000;
  if (shared.fatal === null && failed.length && !outOfTime() && timeLeft(ctx) - retryWaitMs >= SECTION_ESTIMATE_MS) {
    const retry = failed;
    failed = [];
    await new Promise((resolve) => setTimeout(resolve, retryWaitMs));
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

  // Earlier parts of this run drafted progress_offset sections (a run only continues when nothing failed).
  const draftedInRun = progressOffset + drafted.size;
  if (shared.fatal !== null) {
    // Bad key, no credits, unknown model: every section would fail the same way.
    if (!draftedInRun) throw shared.fatal;
    throw new HttpError(
      failureStatus(shared.fatal),
      `${failureDetail(shared.fatal)} (${draftedInRun} of ${progressTotal} sections were drafted and saved before this.)`,
    );
  }
  if (failed.length && !draftedInRun && !skipped.length) throw failed[0].error;
  if (failed.length) {
    const parts = [
      ...failed.map(({ section, error }) => `"${section.title}" (${failureDetail(error)})`),
      ...skipped.map((section) => `"${section.title}" (not started: no time left in this step)`),
    ];
    throw new HttpError(
      failureStatus(failed[0].error),
      `Drafted and saved ${draftedInRun} of ${progressTotal} sections. Not drafted: ${parts.join('; ')}. ` +
        `The saved sections are kept. ${howToFinish([...failed.map((item) => item.section), ...skipped], covered)}`,
    );
  }

  const sections = targets.filter((section) => drafted.has(section.id)).map((section) => drafted.get(section.id) as SectionDraft);
  if (skipped.length) {
    // More than fits in one step: the website starts the next part with the sections not started
    // yet (by id, so a Redraft All never redoes a section this run already redrafted).
    const next: JobContinuation = {
      path: `/api/writer/applications/${app.id}/draft`,
      body: {
        section_ids: skipped.map((section) => section.id),
        progress_offset: progressOffset + (total - skipped.length),
        progress_total: progressTotal,
      },
    };
    ctx.note(`Drafted ${drafted.size} section(s) in this part; continuing with ${skipped.map((section) => section.id).join(', ')}.`);
    logger.info('draft_part_finished', {
      correlation_id: app.correlation_id,
      app_id: app.id,
      sections: drafted.size,
      remaining: skipped.length,
      ms: Date.now() - started,
    });
    return { sections, __continue: next };
  }

  logger.info('draft_finished', { correlation_id: app.correlation_id, app_id: app.id, sections: drafted.size, ms: Date.now() - started });
  return { sections };
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

  // What the revision starts from. It is saved only if the section still holds exactly this
  // when Claude is done (refineSection changes `draft` in place, so keep copies first).
  const title = draft.title;
  const startedText = draft.current_draft;
  const startedVersions = JSON.stringify(draft.versions ?? []);

  await ctx.progress(`Revising "${title}"...`);
  const run = runFor(ctx, await ctx.claude());
  const revised = await refineSection(run, app, draft, section, profile, instruction);
  let changedMeanwhile = false as boolean;
  const saved = await updateSectionDraft(ctx.userId, app.id, sectionId, (stored) => {
    changedMeanwhile = stored.current_draft !== startedText || JSON.stringify(stored.versions ?? []) !== startedVersions;
    return changedMeanwhile ? undefined : revised;
  });
  if (!saved) throw new HttpError(404, WRITER_MESSAGES.sectionDraftNotFound);
  if (changedMeanwhile) {
    ctx.note(`Refine of ${section.id} not saved: the section changed while Claude was revising it.`);
    logger.warn('section_refine_not_saved', { correlation_id: app.correlation_id, app_id: app.id, section_id: section.id });
    throw new HttpError(409, refineConflictMessage(title));
  }
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
