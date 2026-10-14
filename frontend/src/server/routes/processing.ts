/**
 * /api/processing: website scan, questionnaire, document upload, profile,
 * grant matching, match results, shortlist. Port of backend/routers/processing.py.
 *
 * Routes check everything they can right away (signed in, Claude key saved,
 * grants/profile present, valid input) and answer 4xx at once. Claude work
 * then runs as a background job (handlers/processing.ts); the website polls
 * it and receives exactly the JSON the Python endpoint returned.
 */
import crypto from 'node:crypto';

import { requireApiKey } from '../auth';
import { maxUploadBytes } from '../config';
import { HttpError } from '../errors';
import {
  NO_GRANTS_FOR_MATCHING,
  NO_GRANTS_FOR_QUESTIONNAIRE,
  NO_PROFILE_FOR_MATCHING,
  PROCESSING_JOB_KINDS,
  type DocumentJobInput,
  type ScanJobInput,
} from '../handlers/processing';
import { optionalString, type RequestContext } from '../http';
import { startJob } from '../jobs';
import { logger } from '../log';
import { normalizeUrl } from '../net';
import { getGrants, getMatchResults, getProfile, updateMatchResults, updateProfile } from '../repo';
import type { Router } from '../router';
import {
  applyQuestionnaireAnswers,
  DOCUMENT_TEXT_LIMIT,
  latestMatchSessionId,
  minimalProfile,
  questionnaireKey,
  type StoredQuestionnaire,
} from '../services/ai';
import { documentExtension, extractDocumentText, INVALID_DOCUMENT_TYPE, isAllowedDocument } from '../services/documents';
import { kv } from '../store';
import type { QuestionnaireAnswer } from '../types';
import { applyProfileUpdate, parseProfileBody } from './profile';

export const NO_MATCH_RESULTS = 'No match results yet. Run matching first.';
const NO_PROFILE = 'No profile found. Please complete the setup process.';
/** Room for multipart boundaries and headers around the file itself. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

// =============================================================================
// Input checks
// =============================================================================

/** A typed address ("yourparish.org") as a full URL, or a 400 when it can't be one. */
function websiteUrl(raw: string | null): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const url = normalizeUrl(text);
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol) || !/[.:]/.test(parsed.hostname)) {
    throw new HttpError(400, `"${text}" doesn't look like a website address. Enter it like yourparish.org or https://www.yourparish.org.`);
  }
  return url;
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}

function tooLarge(bytes: number, limit: number): HttpError {
  return new HttpError(
    413,
    `File is too large (${megabytes(bytes)} MB). The limit is ${megabytes(limit)} MB. Upload a smaller file, or save just the pages that matter as a new PDF.`,
  );
}

function wholeNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\s*[-+]?\d+\s*$/.test(value)) return Number(value.trim());
  return null;
}

/** QuestionnaireSubmission: {answers: [{question_id, answer}], free_form_text?} with readable 422s. */
function parseSubmission(body: Record<string, unknown>): { answers: QuestionnaireAnswer[]; freeFormText: string | null } {
  if (body.answers === undefined || body.answers === null) {
    throw new HttpError(422, 'Field "answers" is required: a list of {"question_id": number, "answer": ...}.');
  }
  if (!Array.isArray(body.answers)) {
    throw new HttpError(422, 'Field "answers" must be a list of {"question_id": number, "answer": ...}.');
  }
  const answers = body.answers.map((item: unknown, index: number): QuestionnaireAnswer => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(422, `answers[${index}] must be an object with "question_id" and "answer".`);
    }
    const record = item as Record<string, unknown>;
    const questionId = wholeNumber(record.question_id);
    if (questionId === null) throw new HttpError(422, `answers[${index}].question_id must be a whole number.`);
    if (!('answer' in record)) throw new HttpError(422, `answers[${index}].answer is required.`);
    return { question_id: questionId, answer: record.answer };
  });
  const freeFormText = optionalString(body, 'free_form_text')?.trim() || null;
  return { answers, freeFormText };
}

/** The `shortlist` flag, parsed like FastAPI's bool query parameter (default true). */
function shortlistFlag(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on', 't'].includes(v)) return true;
    if (['false', '0', 'no', 'n', 'off', 'f'].includes(v)) return false;
  }
  throw new HttpError(422, 'shortlist must be true or false.');
}

// =============================================================================
// Routes
// =============================================================================

async function scanWebsite(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  const body = await ctx.json();
  await requireApiKey(user.id);
  const churchUrl = websiteUrl(optionalString(body, 'church_url'));
  const schoolUrl = websiteUrl(optionalString(body, 'school_url'));
  if (!churchUrl && !schoolUrl) throw new HttpError(400, 'At least one website URL is required');
  const input: ScanJobInput = { church_url: churchUrl, school_url: schoolUrl };
  return startJob(ctx, PROCESSING_JOB_KINDS.scanWebsite, input);
}

async function generateQuestionnaire(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  await requireApiKey(user.id);
  const grants = await getGrants(user.id);
  if (!grants.length) throw new HttpError(400, NO_GRANTS_FOR_QUESTIONNAIRE);
  return startJob(ctx, PROCESSING_JOB_KINDS.generateQuestionnaire, {});
}

/** No Claude call here, so it stays synchronous (as in the Python). */
async function submitQuestionnaire(ctx: RequestContext) {
  const user = await ctx.user();
  const { answers, freeFormText } = parseSubmission(await ctx.json());
  const stored = await kv().get<StoredQuestionnaire>(questionnaireKey(user.id));
  const questionsById = new Map<number, string>();
  for (const question of stored?.questions ?? []) {
    if (typeof question?.id === 'number' && typeof question.question === 'string') questionsById.set(question.id, question.question);
  }
  const unmatched = answers.filter((answer) => !questionsById.has(answer.question_id)).length;
  if (unmatched) {
    logger.warn('questionnaire_answers_unmatched', { user_id: user.id, unmatched, has_questionnaire: Boolean(stored) });
  }
  await updateProfile(user.id, (current) =>
    applyQuestionnaireAnswers(current ?? minimalProfile(user.id), answers, freeFormText, questionsById),
  );
  logger.info('questionnaire_submitted', { user_id: user.id, answers: answers.length, free_form: Boolean(freeFormText) });
  return { message: 'Questionnaire submitted successfully', answers_recorded: answers.length };
}

async function uploadDocument(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  await requireApiKey(user.id);
  const limit = maxUploadBytes();
  const declared = Number(ctx.req.headers.get('content-length') || 0);
  if (declared > limit + MULTIPART_OVERHEAD_BYTES) throw tooLarge(declared, limit);

  const form = await ctx.formData();
  const entry = form.get('file');
  if (!entry || typeof entry === 'string') {
    throw new HttpError(422, 'No file was uploaded. Choose a PDF, Word (.docx), or text (.txt) file and try again.');
  }
  const filename = entry.name || '';
  if (!isAllowedDocument(filename)) throw new HttpError(400, INVALID_DOCUMENT_TYPE);
  if (entry.size > limit) throw tooLarge(entry.size, limit);
  if (entry.size === 0) throw new HttpError(400, `"${filename}" is empty (0 bytes). Check that you picked the right file.`);

  // Text is extracted here, so an unreadable document fails now, before any job.
  const text = await extractDocumentText(new Uint8Array(await entry.arrayBuffer()), filename);
  const input: DocumentJobInput = {
    document_id: crypto.randomUUID(),
    filename,
    text: text.slice(0, DOCUMENT_TEXT_LIMIT),
    text_length: text.length,
  };
  logger.info('document_uploaded', { user_id: user.id, filename, type: documentExtension(filename), bytes: entry.size, chars: text.length });
  return startJob(ctx, PROCESSING_JOB_KINDS.uploadDocument, input);
}

async function matchGrants(ctx: RequestContext): Promise<Response> {
  const user = await ctx.user();
  await requireApiKey(user.id);
  const [grants, profile] = await Promise.all([getGrants(user.id), getProfile(user.id)]);
  if (!grants.length) throw new HttpError(400, NO_GRANTS_FOR_MATCHING);
  if (!profile) throw new HttpError(400, NO_PROFILE_FOR_MATCHING);
  return startJob(ctx, PROCESSING_JOB_KINDS.matchGrants, {});
}

/**
 * Python echoed {grant_id, shortlisted} without saving anything, so the
 * shortlist (and "export shortlisted only") never worked. Now the flag is
 * saved on the match results: the session from ?session_id= (or a JSON body
 * field), else the user's newest results.
 */
async function toggleShortlist(ctx: RequestContext) {
  const user = await ctx.user();
  const body = await ctx.json();
  const grantId = ctx.params.grantId;
  const shortlist = shortlistFlag(ctx.query.get('shortlist') ?? body.shortlist);
  const sessionId = ctx.query.get('session_id') || optionalString(body, 'session_id') || (await latestMatchSessionId(user.id));
  if (!sessionId) throw new HttpError(404, NO_MATCH_RESULTS);

  const saved = await updateMatchResults(user.id, sessionId, (current) => {
    if (!current) return undefined;
    const index = current.matches.findIndex((match) => match.grant_id === grantId);
    if (index === -1 || current.matches[index].is_shortlisted === shortlist) return undefined;
    current.matches[index] = { ...current.matches[index], is_shortlisted: shortlist };
    return current;
  });
  if (!saved) throw new HttpError(404, 'Session not found');
  if (!saved.matches.some((match) => match.grant_id === grantId)) {
    throw new HttpError(404, 'Grant not found in these match results');
  }
  logger.info('shortlist_updated', { user_id: user.id, session_id: sessionId, grant_id: grantId, shortlisted: shortlist });
  return { grant_id: grantId, shortlisted: shortlist };
}

export function registerProcessingRoutes(router: Router): void {
  router.post('/api/processing/scan-website', scanWebsite);
  router.post('/api/processing/generate-questionnaire', generateQuestionnaire);
  router.post('/api/processing/submit-questionnaire', submitQuestionnaire);
  router.post('/api/processing/upload-document', uploadDocument);

  router.get('/api/processing/profile', async (ctx) => {
    const user = await ctx.user();
    const profile = await getProfile(user.id);
    if (!profile) throw new HttpError(404, NO_PROFILE);
    return profile;
  });

  /** User edits (and the "enter basics by hand" path). Unlike /api/profile, sources are taken as sent. */
  router.put('/api/processing/profile', async (ctx) => {
    const user = await ctx.user();
    const update = parseProfileBody(await ctx.json());
    const saved = await updateProfile(user.id, (existing) => applyProfileUpdate(existing, update, user.id));
    logger.info('profile_updated', { user_id: user.id, via: 'PUT /api/processing/profile', fields: Object.keys(update) });
    return saved;
  });

  router.post('/api/processing/match-grants', matchGrants);

  // Static path: wins over :sessionId below.
  router.get('/api/processing/match-results/latest', async (ctx) => {
    const user = await ctx.user();
    const sessionId = await latestMatchSessionId(user.id);
    const results = sessionId ? await getMatchResults(user.id, sessionId) : null;
    if (!results) throw new HttpError(404, NO_MATCH_RESULTS);
    return results;
  });

  router.get('/api/processing/match-results/:sessionId', async (ctx) => {
    const user = await ctx.user();
    // Results are stored per user, so another user's session id is simply not found.
    const results = await getMatchResults(user.id, ctx.params.sessionId);
    if (!results) throw new HttpError(404, 'Session not found');
    if (results.user_id !== user.id) throw new HttpError(403, 'Not authorized');
    return results;
  });

  router.post('/api/processing/shortlist/:grantId', toggleShortlist);
}
