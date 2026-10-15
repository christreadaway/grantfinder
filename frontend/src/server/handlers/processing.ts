/**
 * Background jobs for setup and matching: website scan, questionnaire,
 * document signals, and grant matching. The Claude-calling half of
 * backend/routers/processing.py (the routes validate everything first).
 *
 * Each handler returns exactly the JSON body the Python endpoint returned:
 * the website polls the job and uses `result` as the response.
 * Must not import mammoth, docx, or exceljs (see jobHandlers.ts).
 */
import { JOB_MAX_RUNTIME_MS } from '../config';
import { ClaudeError, errorMessage, HttpError, isFatalClaudeError } from '../errors';
import { jobsPrefix, type Job, type JobContext, type JobContinuation, type JobHandler } from '../jobs';
import { logger } from '../log';
import { crawlSite, type CrawlResult, type CrawlTiming } from '../net';
import { getFoundations, getGrants, getMatchResults, getProfile, saveMatchResults, updateMatchResults, updateProfile } from '../repo';
import {
  buildDocumentPrompt,
  buildQuestionnairePrompt,
  buildScanPrompt,
  defaultQuestionnaire,
  isRetryableUnscored,
  MATCH_BATCH_ROOM_MS,
  MATCH_DIRECT_CONCURRENCY,
  MATCH_MAX_PARTS,
  matchGrantsWithRun,
  MAX_PROFILE_EVIDENCE,
  mergeDocumentIntoProfile,
  mergeScanIntoProfile,
  minimalProfile,
  NOT_AI_SCORED,
  NOT_SCORED_OUT_OF_TIME_DIRECT,
  parseDocumentSignals,
  parseQuestionnaire,
  parseScanResult,
  PROMPT_IDS,
  QUESTIONNAIRE_GRANT_SAMPLE,
  questionnaireKey,
  scoreMatches,
  withFoundations,
  withRescoredMatches,
  type DocumentMergeStats,
  type MatchRunOptions,
  type StoredQuestionnaire,
} from '../services/ai';
import { kv } from '../store';
import type { DocumentExtractionResult, Grant, MatchResults, Questionnaire, WebsiteScanResult } from '../types';

export const PROCESSING_JOB_KINDS = {
  scanWebsite: 'processing.scan_website',
  generateQuestionnaire: 'processing.generate_questionnaire',
  uploadDocument: 'processing.upload_document',
  matchGrants: 'processing.match_grants',
} as const;

/** Python wording, shared with the routes (which check first so the website hears at once). */
export const NO_GRANTS_FOR_QUESTIONNAIRE = 'No grants uploaded. Please upload grant database first.';
export const NO_GRANTS_FOR_MATCHING = 'No grants in database. Upload a grant database or run discovery first.';
export const NO_PROFILE_FOR_MATCHING = 'No organization profile. Please complete the setup process.';

export interface ScanJobInput {
  church_url: string | null;
  school_url: string | null;
}

export interface DocumentJobInput {
  document_id: string;
  filename: string;
  /** Already capped at DOCUMENT_TEXT_LIMIT characters by the route. */
  text: string;
  /** Length of the full extracted text (the Python reported this, not the capped length). */
  text_length: number;
}

/** A scan that finished after the person started a newer one (e.g. with corrected addresses). */
export const SCAN_SUPERSEDED =
  'You started a newer website scan while this one was running, so this one was not saved to your profile. ' +
  "Wait for the newer scan to finish; its results are the ones that count.";

/** Direct mode: the scan's Claude call was still running when the step's minute ended. */
export const SCAN_OUT_OF_TIME =
  "Website scan failed: Claude didn't finish reading your website in time (each step on this site can run for about a minute). " +
  'Try the scan again; if it keeps happening, use "Enter the basics by hand" instead.';

/** A Claude call stopped by this step's own time limit (direct mode: about a minute per step). */
function stoppedByTimeLimit(ctx: JobContext, error: unknown): boolean {
  return ctx.mode === 'direct' && error instanceof ClaudeError && error.kind === 'timeout' && ctx.timeLeftMs() < 1_000;
}

/**
 * Non-fatal Claude failures in a single-call step (scan, document) fail the
 * step with the step name and a retry hint instead of the Python's silent
 * empty result, which looked exactly like "nothing found". Fatal errors
 * propagate unchanged.
 */
function stepFailed(step: string, error: unknown): unknown {
  if (error instanceof ClaudeError && !error.fatal) {
    logger.error('ai_step_failed', { step, kind: error.kind, detail: error.detail });
    return new HttpError(error.status, `${step} failed: ${error.detail}`);
  }
  return error;
}

// =============================================================================
// Website scan
// =============================================================================

/** net.ts reasons, with a plain-English hint where the raw reason is cryptic. */
function friendlyProblem(problem: string): string {
  if (/blocks automated reading/.test(problem)) return problem;
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|network/i.test(problem)) {
    return `${problem} (couldn't connect: check the address, or the site may be down)`;
  }
  if (/Blocked unsafe address/.test(problem)) {
    return `${problem} (no public website answers at that address: check the spelling)`;
  }
  if (/HTTP 404/.test(problem)) return `${problem} (page not found: check the address)`;
  if (/HTTP 5\d\d/.test(problem)) return `${problem} (the website is having trouble right now; try again later)`;
  if (/no readable text/i.test(problem)) return `${problem} (the site may draw its pages with JavaScript, which can't be read automatically)`;
  return problem;
}

export function unreadableWebsiteMessage(urls: string[], problems: string[]): string {
  const details = problems.length ? problems.map(friendlyProblem) : urls.map((url) => `${url}: no readable text`);
  return (
    `Couldn't read any text from ${urls.length > 1 ? 'either website' : 'the website'}. ${details.join('; ')}. ` +
    'Instead, use "Enter the basics by hand" or "Skip to questions" on this step, then upload documents ' +
    '(bulletins, annual reports, newsletters) in the Documents step and add details in the free-form notes on the questions step.'
  );
}

/** Job ids start with their creation second: job_20261014T231502Z_ab12cd34. */
const JOB_SECOND_PREFIX = 'job_YYYYMMDDTHHMMSSZ'.length;

/**
 * Id of a website scan this person started after this one, if any. Scans of
 * different addresses may run side by side (each has its own exclusive key),
 * and the older one must not overwrite the newer one's results when it
 * finishes last.
 */
async function newerScanJob(ctx: JobContext): Promise<string | null> {
  const prefix = jobsPrefix(ctx.userId);
  const ownSecond = ctx.job.id.slice(0, JOB_SECOND_PREFIX);
  const keys = (await kv().list(prefix)).filter((key) => {
    const id = key.slice(prefix.length);
    return id !== ctx.job.id && id.slice(0, JOB_SECOND_PREFIX) >= ownSecond;
  });
  for (const key of keys.slice(-20)) {
    const job = await kv().get<Job>(key);
    if (job && job.kind === PROCESSING_JOB_KINDS.scanWebsite && job.created_at > ctx.job.created_at) return job.id;
  }
  return null;
}

/** Stop (409) when the person started a newer scan: its results are the ones that count. */
async function stopIfSuperseded(ctx: JobContext, stage: 'before_claude' | 'before_save'): Promise<void> {
  const newer = await newerScanJob(ctx);
  if (!newer) return;
  logger.warn('website_scan_superseded', { user_id: ctx.userId, job_id: ctx.job.id, newer_job_id: newer, stage });
  ctx.note(`Not saved: a newer website scan (${newer}) was started while this one was running`);
  throw new HttpError(409, SCAN_SUPERSEDED);
}

/**
 * Direct mode: crawling ends early enough to leave Claude most of the step's
 * minute (about 35 of 50 seconds), and no new pages start in the last 3
 * seconds before that. Shorter budgets (tests) scale down the same way.
 */
function directCrawlTiming(ctx: JobContext): CrawlTiming {
  const budget = ctx.timeLeftMs();
  const forClaude = Math.min(35_000, Math.round(budget * 0.7));
  return { endBy: ctx.deadline - forClaude, minStartMs: Math.min(3_000, Math.round(budget * 0.06)), pageTimeoutMs: 10_000 };
}

async function scanWebsite(ctx: JobContext): Promise<WebsiteScanResult> {
  const input = ctx.input as ScanJobInput;
  const churchUrl = input.church_url || null;
  const schoolUrl = input.school_url || null;
  const urls = Array.from(new Set([churchUrl, schoolUrl].filter((url): url is string => Boolean(url))));
  await ctx.progress(`Reading ${urls.join(' and ')}...`);

  const timing: CrawlTiming = ctx.mode === 'direct' ? directCrawlTiming(ctx) : {};
  // Same URL for church and school: crawl it once.
  const crawls = new Map<string, Promise<CrawlResult>>();
  const crawl = (url: string): Promise<CrawlResult> => {
    let pending = crawls.get(url);
    if (!pending) {
      pending = crawlSite(url, undefined, timing);
      crawls.set(url, pending);
    }
    return pending;
  };
  const [church, school] = await Promise.all([churchUrl ? crawl(churchUrl) : null, schoolUrl ? crawl(schoolUrl) : null]);

  let websiteContent = '';
  const urlsRead: string[] = [];
  const problems = new Set<string>();
  const add = (label: string, url: string | null, result: CrawlResult | null) => {
    if (!url || !result) return;
    result.problems.forEach((problem) => problems.add(problem));
    if (!result.text.trim()) return;
    websiteContent += `\n\n=== ${label} WEBSITE (${url}) ===\n${result.text}`;
    if (!urlsRead.includes(url)) urlsRead.push(url);
    ctx.note(`Read ${result.pagesRead.length} page(s) from ${url}: ${result.pagesRead.join(', ')}`);
    if (result.skippedForTime) {
      ctx.note(`Stopped reading ${url} early to leave Claude time (each step can run for about a minute here); ${result.skippedForTime} more page(s) not read`);
    }
  };
  add('CHURCH', churchUrl, church);
  add('SCHOOL', schoolUrl, school);

  if (!websiteContent.trim()) {
    logger.warn('website_scan_unreadable', { user_id: ctx.userId, urls, problems: [...problems] });
    throw new HttpError(400, unreadableWebsiteMessage(urls, [...problems]));
  }
  if (problems.size) {
    // Partial success (as in the Python): carry on with what could be read.
    ctx.note(`Couldn't read: ${[...problems].join(' | ')}`);
    logger.warn('website_scan_partial', { user_id: ctx.userId, urls_read: urlsRead, problems: [...problems] });
  }

  // Not worth paying Claude for a scan the person already replaced.
  await stopIfSuperseded(ctx, 'before_claude');
  await ctx.progress('Asking Claude to pull out your parish and school details...');
  const ai = await ctx.claude();
  let answer: string;
  try {
    answer = (await ai.call({ stage: 'scan', promptId: PROMPT_IDS.scan, prompt: buildScanPrompt(websiteContent), maxTokens: 2000 })).text;
  } catch (error) {
    if (stoppedByTimeLimit(ctx, error)) {
      logger.warn('website_scan_out_of_time', { user_id: ctx.userId, chars: websiteContent.length });
      throw new HttpError(504, SCAN_OUT_OF_TIME);
    }
    throw stepFailed('Website scan', error);
  }
  const result = parseScanResult(answer, websiteContent.length);
  if (!result) {
    logger.error('website_scan_unreadable_answer', { user_id: ctx.userId, answer_preview: answer.slice(0, 200) });
    throw new HttpError(502, "Website scan failed: Claude's answer couldn't be read. Please run the scan again.");
  }

  await stopIfSuperseded(ctx, 'before_save');
  await ctx.progress('Saving what we found to your profile...');
  await updateProfile(ctx.userId, (current) =>
    mergeScanIntoProfile(current ?? minimalProfile(ctx.userId), result, { churchUrl, schoolUrl, urlsRead }),
  );
  logger.info('website_scan_done', {
    user_id: ctx.userId,
    urls_read: urlsRead,
    chars: websiteContent.length,
    found_name: Boolean(result.organization_basics.name),
    initiatives: result.current_initiatives.length,
  });
  return result;
}

// =============================================================================
// Questionnaire
// =============================================================================

async function generateQuestionnaire(ctx: JobContext): Promise<Questionnaire> {
  const grants = await getGrants(ctx.userId);
  if (!grants.length) throw new HttpError(400, NO_GRANTS_FOR_QUESTIONNAIRE);
  await ctx.progress(`Writing questions based on ${Math.min(grants.length, QUESTIONNAIRE_GRANT_SAMPLE)} of your grants...`);
  const ai = await ctx.claude();

  let answer: string | null = null;
  try {
    answer = (await ai.call({
      stage: 'questionnaire',
      promptId: PROMPT_IDS.questionnaire,
      prompt: buildQuestionnairePrompt(grants),
      maxTokens: 3000,
    })).text;
  } catch (error) {
    if (isFatalClaudeError(error)) throw error;
    // Python fallback, kept for non-fatal errors only: the standard questions.
    logger.error('questionnaire_generation_failed', { user_id: ctx.userId, error: errorMessage(error) });
    ctx.note(`Claude was unavailable (${errorMessage(error)}); showing the standard questions instead`);
  }

  let questionnaire = answer === null ? null : parseQuestionnaire(answer);
  if (answer !== null && !questionnaire) {
    logger.error('questionnaire_unreadable_answer', { user_id: ctx.userId, answer_preview: answer.slice(0, 200) });
    ctx.note("Claude's questions couldn't be read; showing the standard questions instead");
  }
  const source = questionnaire ? 'ai' : 'default';
  questionnaire ??= defaultQuestionnaire();

  // Kept per user (not in memory) so submit-questionnaire can map answers to question text.
  const stored: StoredQuestionnaire = { ...questionnaire, created_at: new Date().toISOString(), source };
  await kv().set(questionnaireKey(ctx.userId), stored);
  logger.info('questionnaire_generated', { user_id: ctx.userId, questions: questionnaire.total_questions, source });
  return questionnaire;
}

// =============================================================================
// Document signals
// =============================================================================

const count = (n: number) => n.toLocaleString('en-US');

async function uploadDocument(ctx: JobContext): Promise<DocumentExtractionResult> {
  const input = ctx.input as DocumentJobInput;
  const fullLength = input.text_length ?? input.text.length;
  const cut = fullLength > input.text.length;
  if (cut) {
    const share = Math.floor((input.text.length / fullLength) * 100);
    ctx.note(
      `Read the first ${count(input.text.length)} of ${count(fullLength)} characters of "${input.filename}" (${share}%); ` +
        'the rest was not sent to Claude. To include later pages, upload them as a separate file.',
    );
  }
  await ctx.progress(
    cut
      ? `Reading ${input.filename} with Claude (the first ${count(input.text.length)} of ${count(fullLength)} characters)...`
      : `Reading ${input.filename} with Claude...`,
  );
  const ai = await ctx.claude();
  let answer: string;
  let stopReason: string | null = null;
  try {
    const response = await ai.call({
      stage: 'documents',
      promptId: PROMPT_IDS.documents,
      prompt: buildDocumentPrompt(input.text, input.filename),
      // Needs lists plus up to 15 key facts from a long report.
      maxTokens: 4000,
    });
    answer = response.text;
    stopReason = response.stopReason;
  } catch (error) {
    if (stoppedByTimeLimit(ctx, error)) {
      logger.warn('document_out_of_time', { user_id: ctx.userId, document_id: input.document_id, chars_sent: input.text.length });
      throw new HttpError(
        504,
        `Document processing failed: Claude didn't finish reading "${input.filename}" in time (each step on this site can run for about a minute). ` +
          'Try again; if it keeps happening, upload a shorter file (for example, only the pages that matter).',
      );
    }
    throw stepFailed('Document processing', error);
  }
  const signals = parseDocumentSignals(answer);
  if (!signals) {
    // Lengths only: Claude's answer about a document can quote the document.
    logger.error('document_unreadable_answer', { user_id: ctx.userId, filename: input.filename, answer_chars: answer.length, stop_reason: stopReason });
    // Uploading again would fail the same way when the answer was cut off or declined.
    const why =
      stopReason === 'max_tokens'
        ? `Claude's answer about "${input.filename}" was cut off before it finished. Upload a shorter version (for example, only the pages that matter).`
        : stopReason === 'refusal'
          ? `Claude declined to read "${input.filename}". Check that it is the right file, or upload a different document.`
          : `Claude's answer about "${input.filename}" couldn't be read. Upload the document again.`;
    throw new HttpError(502, `Document processing failed: ${why}`);
  }

  const result: DocumentExtractionResult = {
    document_id: input.document_id,
    filename: input.filename,
    extracted_text_length: fullLength,
    ...signals,
  };
  await ctx.progress('Adding what we found to your profile...');
  // Creates the profile when the website scan was skipped (the Python dropped these signals).
  const stats: DocumentMergeStats = { evidence_added: 0, evidence_dropped: 0 };
  await updateProfile(ctx.userId, (current) => mergeDocumentIntoProfile(current ?? minimalProfile(ctx.userId), result, stats));
  ctx.note(
    `Claude found ${signals.key_facts.length} key fact(s); ${stats.evidence_added} new evidence item(s) were added to the profile for the writer (repeats are skipped)`,
  );
  if (stats.evidence_dropped) {
    ctx.note(`Profile evidence is capped at ${MAX_PROFILE_EVIDENCE} items: removed the ${stats.evidence_dropped} oldest item(s) that came from documents`);
  }
  logger.info('document_signals_saved', {
    user_id: ctx.userId,
    document_id: result.document_id,
    facility_needs: result.facility_needs.length,
    program_needs: result.program_needs.length,
    security_concerns: result.security_concerns.length,
    other_signals: result.other_signals.length,
    key_facts: signals.key_facts.length,
    evidence_added: stats.evidence_added,
    evidence_dropped: stats.evidence_dropped,
    chars_sent: input.text.length,
    chars_total: fullLength,
  });
  return result;
}

// =============================================================================
// Grant matching
// =============================================================================

/**
 * A matching job's input: {} for a new run. A follow-up part (direct mode)
 * names the saved results whose unscored grants it scores.
 */
export interface MatchJobInput {
  session_id?: string;
  part?: number;
}

/** Where the website starts a follow-up part of matching (routes/processing.ts). */
export const MATCH_CONTINUE_PATH = '/api/processing/match-grants/continue';

type MatchJobResult = MatchResults & { __continue?: JobContinuation };
type MatchSettings = Pick<MatchRunOptions, 'startDeadline' | 'concurrency' | 'retryWaitMs' | 'hardDeadline' | 'outOfTimeExplanation'>;

/** Matching settings for where this job runs. */
function matchSettings(ctx: JobContext, startedAt: number): MatchSettings {
  if (ctx.mode !== 'direct') {
    // Leave room to finish and save before Netlify's 15-minute cutoff.
    return { startDeadline: startedAt + JOB_MAX_RUNTIME_MS - 3 * 60 * 1000 };
  }
  // Every batch at once (up to 8); a scoring call starts only while one still
  // fits: half the step's budget, at most 25 seconds before its cutoff.
  const room = Math.min(MATCH_BATCH_ROOM_MS, Math.floor(ctx.timeLeftMs() / 2));
  return {
    concurrency: MATCH_DIRECT_CONCURRENCY,
    retryWaitMs: 2_000,
    startDeadline: ctx.deadline - room,
    hardDeadline: ctx.deadline,
    outOfTimeExplanation: NOT_SCORED_OUT_OF_TIME_DIRECT,
  };
}

/**
 * Direct mode: when grants are still unscored only because time ran out (or
 * Claude was briefly unavailable) and this part scored something, the result
 * hands the website a follow-up request that scores the rest into the same
 * saved results. Otherwise the results are final and say plainly which
 * grants were not AI-scored.
 */
function withContinuation(ctx: JobContext, results: MatchResults, aiScored: number, part: number): MatchJobResult {
  if (ctx.mode !== 'direct') return results;
  const pending = results.matches.filter(isRetryableUnscored).length;
  if (!pending) {
    if (part > 1) ctx.note(`Part ${part}: every grant that could be scored is scored now`);
    return results;
  }
  if (aiScored === 0) {
    ctx.note(`Part ${part}: Claude scored no grants this time, so matching stops here; ${pending} grant(s) stay marked "${NOT_AI_SCORED}"`);
    return results;
  }
  if (part >= MATCH_MAX_PARTS) {
    ctx.note(`Stopped after ${part} parts; ${pending} grant(s) stay marked "${NOT_AI_SCORED}"`);
    return results;
  }
  ctx.note(`Part ${part}: Claude scored ${aiScored} grant(s); the other ${pending} will be scored in part ${part + 1}`);
  logger.info('match_continues', { user_id: ctx.userId, session_id: results.session_id, part, ai_scored: aiScored, pending });
  return { ...results, __continue: { path: MATCH_CONTINUE_PATH, body: { session_id: results.session_id, part: part + 1 } } };
}

async function matchGrantsJob(ctx: JobContext): Promise<MatchJobResult> {
  const startedAt = Date.now();
  const input = (ctx.input ?? {}) as MatchJobInput;
  const sessionId = typeof input.session_id === 'string' && input.session_id ? input.session_id : null;
  const part = sessionId ? Math.max(2, Math.floor(Number(input.part)) || 2) : 1;
  const [grants, foundations, profile] = await Promise.all([
    getGrants(ctx.userId),
    getFoundations(ctx.userId),
    getProfile(ctx.userId),
  ]);
  if (!grants.length) throw new HttpError(400, NO_GRANTS_FOR_MATCHING);
  if (!profile) throw new HttpError(400, NO_PROFILE_FOR_MATCHING);

  const allGrants = withFoundations(grants, foundations, ctx.userId);
  const settings = matchSettings(ctx, startedAt);
  if (ctx.mode === 'direct') {
    const room = Math.round(((settings.hardDeadline ?? 0) - (settings.startDeadline ?? 0)) / 1000);
    ctx.note(`Runs inside one request (about a minute): up to ${MATCH_DIRECT_CONCURRENCY} batches at once; a batch starts only with ${room}s or more left`);
  }
  const options: Omit<MatchRunOptions, 'grants'> = {
    profile,
    userId: ctx.userId,
    claude: () => ctx.claude(),
    progress: (message) => ctx.progress(message),
    note: (line) => ctx.note(line),
    ...settings,
  };
  try {
    if (sessionId) return await matchRemaining(ctx, sessionId, part, allGrants, options);

    await ctx.progress(`Checking ${allGrants.length} grants against hard requirements (location, deadline, status)...`);
    const { results, run } = await matchGrantsWithRun({ grants: allGrants, ...options });
    await ctx.progress('Saving results...');
    await saveMatchResults(results);
    return withContinuation(ctx, results, run.aiScored, part);
  } catch (error) {
    logger.error('grant_matching_failed', { user_id: ctx.userId, grants: allGrants.length, part, error: errorMessage(error) });
    throw error;
  }
}

/**
 * A follow-up part (direct mode): score the grants an earlier part couldn't
 * (time ran out, or Claude was briefly unavailable) and merge them into the
 * same saved results.
 */
async function matchRemaining(
  ctx: JobContext,
  sessionId: string,
  part: number,
  allGrants: Grant[],
  options: Omit<MatchRunOptions, 'grants'>,
): Promise<MatchJobResult> {
  const saved = await getMatchResults(ctx.userId, sessionId);
  if (!saved) throw new HttpError(404, 'These match results are no longer saved. Run matching again.');
  const pendingIds = new Set(saved.matches.filter(isRetryableUnscored).map((match) => match.grant_id));
  const toScore = allGrants.filter((grant) => pendingIds.has(grant.id));
  await ctx.progress(`Part ${part}: scoring the ${toScore.length} grant(s) that didn't fit in the time so far...`);
  const run = await scoreMatches({ grants: toScore, ...options });
  await ctx.progress('Saving results...');
  const updated = await updateMatchResults(ctx.userId, sessionId, (current) => (current ? withRescoredMatches(current, run.matches) : undefined));
  if (!updated) throw new HttpError(404, 'These match results are no longer saved. Run matching again.');
  logger.info('match_part_done', { user_id: ctx.userId, session_id: sessionId, part, rescored: toScore.length, ai_scored: run.aiScored });
  return withContinuation(ctx, updated, run.aiScored, part);
}

export const processingJobs: Record<string, JobHandler> = {
  [PROCESSING_JOB_KINDS.scanWebsite]: scanWebsite,
  [PROCESSING_JOB_KINDS.generateQuestionnaire]: generateQuestionnaire,
  [PROCESSING_JOB_KINDS.uploadDocument]: uploadDocument,
  [PROCESSING_JOB_KINDS.matchGrants]: matchGrantsJob,
};
