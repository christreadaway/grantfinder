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
import { jobsPrefix, type Job, type JobContext, type JobHandler } from '../jobs';
import { logger } from '../log';
import { crawlSite, type CrawlResult } from '../net';
import { getFoundations, getGrants, getProfile, saveMatchResults, updateProfile } from '../repo';
import {
  buildDocumentPrompt,
  buildQuestionnairePrompt,
  buildScanPrompt,
  defaultQuestionnaire,
  matchGrants,
  MAX_PROFILE_EVIDENCE,
  mergeDocumentIntoProfile,
  mergeScanIntoProfile,
  minimalProfile,
  parseDocumentSignals,
  parseQuestionnaire,
  parseScanResult,
  PROMPT_IDS,
  QUESTIONNAIRE_GRANT_SAMPLE,
  questionnaireKey,
  withFoundations,
  type DocumentMergeStats,
  type StoredQuestionnaire,
} from '../services/ai';
import { kv } from '../store';
import type { DocumentExtractionResult, MatchResults, Questionnaire, WebsiteScanResult } from '../types';

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

async function scanWebsite(ctx: JobContext): Promise<WebsiteScanResult> {
  const input = ctx.input as ScanJobInput;
  const churchUrl = input.church_url || null;
  const schoolUrl = input.school_url || null;
  const urls = Array.from(new Set([churchUrl, schoolUrl].filter((url): url is string => Boolean(url))));
  await ctx.progress(`Reading ${urls.join(' and ')}...`);

  // Same URL for church and school: crawl it once.
  const crawls = new Map<string, Promise<CrawlResult>>();
  const crawl = (url: string): Promise<CrawlResult> => {
    let pending = crawls.get(url);
    if (!pending) {
      pending = crawlSite(url);
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

async function matchGrantsJob(ctx: JobContext): Promise<MatchResults> {
  const startedAt = Date.now();
  const [grants, foundations, profile] = await Promise.all([
    getGrants(ctx.userId),
    getFoundations(ctx.userId),
    getProfile(ctx.userId),
  ]);
  if (!grants.length) throw new HttpError(400, NO_GRANTS_FOR_MATCHING);
  if (!profile) throw new HttpError(400, NO_PROFILE_FOR_MATCHING);

  const allGrants = withFoundations(grants, foundations, ctx.userId);
  await ctx.progress(`Checking ${allGrants.length} grants against hard requirements (location, deadline, status)...`);
  let results: MatchResults;
  try {
    results = await matchGrants({
      grants: allGrants,
      profile,
      userId: ctx.userId,
      claude: () => ctx.claude(),
      progress: (message) => ctx.progress(message),
      note: (line) => ctx.note(line),
      // Leave room to finish and save before Netlify's 15-minute cutoff.
      startDeadline: startedAt + JOB_MAX_RUNTIME_MS - 3 * 60 * 1000,
    });
  } catch (error) {
    logger.error('grant_matching_failed', { user_id: ctx.userId, grants: allGrants.length, error: errorMessage(error) });
    throw error;
  }
  await ctx.progress('Saving results...');
  await saveMatchResults(results);
  return results;
}

export const processingJobs: Record<string, JobHandler> = {
  [PROCESSING_JOB_KINDS.scanWebsite]: scanWebsite,
  [PROCESSING_JOB_KINDS.generateQuestionnaire]: generateQuestionnaire,
  [PROCESSING_JOB_KINDS.uploadDocument]: uploadDocument,
  [PROCESSING_JOB_KINDS.matchGrants]: matchGrantsJob,
};
