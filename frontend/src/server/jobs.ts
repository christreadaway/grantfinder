/**
 * Background jobs: every Claude call runs here, never inside a web request.
 *
 * Why: Netlify stops a normal function after 60 seconds, and scoring grants
 * or drafting a whole application takes minutes. So an API route records a
 * job and returns 202 {job_id} at once; the work runs in a Netlify background
 * function (up to 15 minutes); the website polls GET /api/jobs/{id}.
 * Locally (npm run dev, tests) the same job runs inside the server process.
 *
 * Each job record keeps its own AI call log and notes, which is what the
 * debug report and the writer's debug bundle show.
 */
import crypto from 'node:crypto';

import { getApiKey } from './auth';
import { Claude } from './claude';
import { JOB_MAX_RUNTIME_MS, JOB_START_GRACE_MS, onNetlify, secretKey } from './config';
import { HttpError, toHttpError } from './errors';
import { jsonResponse, type RequestContext } from './http';
import { logger } from './log';
import { keyPart, kv, sortableId, update } from './store';
import type { AICallLog } from './types';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  user_id: string;
  kind: string;
  status: JobStatus;
  input: unknown;
  result: unknown;
  error: { status: number; detail: string } | null;
  /** Full error text for the debug report (what went wrong internally). */
  error_debug: string | null;
  progress: string | null;
  application_id: string | null;
  correlation_id: string;
  ai_calls: AICallLog[];
  notes: string[];
  claim: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * Finished jobs keep a short summary of their input instead of the input
 * itself: uploaded document text and pasted guidelines are not stored
 * after the step that needed them is done. Short values (ids, file names,
 * instructions) stay, so debug reports still show what was asked.
 */
export function summarizeInput(input: unknown): unknown {
  if (typeof input === 'string') return input.length > 300 ? `(${input.length.toLocaleString('en-US')} characters, not kept)` : input;
  if (Array.isArray(input)) return input.length > 20 ? `(${input.length} items, not kept)` : input.map(summarizeInput);
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([key, value]) => [key, summarizeInput(value)]));
  }
  return input;
}

/** What the website sees when it polls. */
export interface PublicJob {
  id: string;
  kind: string;
  status: JobStatus;
  progress: string | null;
  result: unknown;
  error: { status: number; detail: string } | null;
  application_id: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobContext {
  job: Job;
  userId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  correlationId: string;
  applicationId: string | null;
  /** A Claude client with the user's saved key; every call is logged on this job. */
  claude(): Promise<Claude>;
  /** Show a short status line in the website ("Scoring grants 10-15 of 40"). */
  progress(message: string): Promise<void>;
  /** Add a line to this job's notes (shown in debug reports). */
  note(line: string): void;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export const BACKGROUND_FUNCTION_PATH = '/.netlify/functions/grantfinder-jobs-background';

export const jobKey = (userId: string, jobId: string) => `jobs/${keyPart(userId)}/${keyPart(jobId)}`;
export const jobsPrefix = (userId: string) => `jobs/${keyPart(userId)}/`;

export function newCorrelationId(): string {
  return `corr_${crypto.randomBytes(6).toString('hex')}`;
}

// =============================================================================
// Signing (only our own API routes may start the background function)
// =============================================================================

export function signJob(userId: string, jobId: string): string {
  return crypto.createHmac('sha256', secretKey()).update(`job:${userId}:${jobId}`).digest('hex');
}

export function verifyJobSignature(userId: string, jobId: string, signature: string): boolean {
  const expected = Buffer.from(signJob(userId, jobId), 'hex');
  const given = Buffer.from(String(signature || ''), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// =============================================================================
// Creating and dispatching
// =============================================================================

export async function createJob(
  userId: string,
  kind: string,
  input: unknown,
  options: { applicationId?: string | null; correlationId?: string | null } = {},
): Promise<Job> {
  const now = new Date().toISOString();
  const job: Job = {
    id: `job_${sortableId()}`,
    user_id: userId,
    kind,
    status: 'queued',
    input,
    result: null,
    error: null,
    error_debug: null,
    progress: 'Waiting to start...',
    application_id: options.applicationId ?? null,
    correlation_id: options.correlationId || newCorrelationId(),
    ai_calls: [],
    notes: [],
    claim: null,
    attempts: 0,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
  };
  await kv().set(jobKey(userId, job.id), job);
  logger.info('job_created', { job_id: job.id, kind, user_id: userId, correlation_id: job.correlation_id, application_id: job.application_id });
  return job;
}

async function failJob(userId: string, jobId: string, status: number, detail: string, debug: string): Promise<void> {
  await update<Job>(jobKey(userId, jobId), (job) => {
    if (!job || job.status === 'done' || job.status === 'failed') return undefined;
    const now = new Date().toISOString();
    return { ...job, status: 'failed', error: { status, detail }, error_debug: debug, progress: null, updated_at: now, finished_at: now };
  });
}

/** Hand the job to the Netlify background function, or run it in-process locally. */
export async function dispatchJob(job: Job, origin: string): Promise<void> {
  if (!onNetlify()) {
    setTimeout(() => {
      runJob(job.user_id, job.id).catch((error) => logger.error('job_runner_crashed', { job_id: job.id, error }));
    }, 0);
    return;
  }
  const base = (process.env.GRANTFINDER_JOBS_ORIGIN || origin).replace(/\/+$/, '');
  const url = `${base}${BACKGROUND_FUNCTION_PATH}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: job.user_id, job_id: job.id, signature: signJob(job.user_id, job.id) }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 202 && !response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    logger.info('job_dispatched', { job_id: job.id, kind: job.kind, status: response.status });
  } catch (error) {
    const message = (error as Error).message;
    logger.error('job_dispatch_failed', { job_id: job.id, kind: job.kind, url, error: message });
    await failJob(
      job.user_id,
      job.id,
      503,
      "Couldn't start the background worker. Redeploy the site on Netlify; if it keeps happening, open the debug report.",
      `dispatch to ${url} failed: ${message}`,
    );
  }
}

/**
 * Create + dispatch, returning 202 {job_id, status, kind} for the website to poll.
 * Check preconditions (API key, profile...) BEFORE calling this so problems
 * show up immediately instead of as a failed job.
 */
export async function startJob(
  ctx: RequestContext,
  kind: string,
  input: unknown,
  options: { applicationId?: string | null; correlationId?: string | null } = {},
): Promise<Response> {
  const user = await ctx.user();
  const job = await createJob(user.id, kind, input, options);
  await dispatchJob(job, ctx.origin);
  return jsonResponse({ job_id: job.id, status: job.status, kind }, 202);
}

// =============================================================================
// Running
// =============================================================================

/** Run a queued job. Safe to call twice: only the first caller claims it. */
export async function runJob(userId: string, jobId: string): Promise<void> {
  const key = jobKey(userId, jobId);
  const claim = crypto.randomBytes(8).toString('hex');
  const startedAt = new Date().toISOString();
  const claimed = await update<Job>(key, (job) => {
    if (!job || job.status !== 'queued') return undefined;
    return { ...job, status: 'running', claim, started_at: startedAt, updated_at: startedAt, attempts: job.attempts + 1, progress: 'Working...' };
  });
  if (!claimed || claimed.claim !== claim) {
    logger.warn('job_not_claimed', { job_id: jobId, status: claimed?.status ?? 'missing' });
    return;
  }

  const { JOB_HANDLERS } = await import('./jobHandlers');
  const handler = JOB_HANDLERS[claimed.kind];
  const aiCalls: AICallLog[] = [];
  const notes: string[] = [];
  let lastProgressWrite = 0;
  let pendingProgress: string | null = null;
  const t0 = Date.now();

  const flush = async (progress: string | null) => {
    await update<Job>(key, (job) => {
      if (!job || job.claim !== claim || job.status !== 'running') return undefined;
      return { ...job, progress: progress ?? job.progress, ai_calls: [...aiCalls], notes: [...notes], updated_at: new Date().toISOString() };
    });
  };

  const ctx: JobContext = {
    job: claimed,
    userId,
    input: claimed.input,
    correlationId: claimed.correlation_id,
    applicationId: claimed.application_id,
    claude: async () => {
      const apiKey = await getApiKey(userId);
      if (!apiKey) throw new HttpError(400, 'Claude API key not set. Please add your API key first.');
      return new Claude({
        apiKey,
        correlationId: claimed.correlation_id,
        applicationId: claimed.application_id,
        jobId,
        onCall: (entry) => aiCalls.push(entry),
      });
    },
    progress: async (message: string) => {
      pendingProgress = message;
      logger.info('job_progress', { job_id: jobId, kind: claimed.kind, message });
      if (Date.now() - lastProgressWrite < 1500) return;
      lastProgressWrite = Date.now();
      try {
        await flush(message);
      } catch (error) {
        logger.warn('job_progress_write_failed', { job_id: jobId, error: (error as Error).message });
      }
    },
    note: (line: string) => {
      notes.push(`${new Date().toISOString()} ${line}`);
      if (notes.length > 200) notes.splice(0, notes.length - 200);
    },
  };

  logger.info('job_started', { job_id: jobId, kind: claimed.kind, user_id: userId, correlation_id: claimed.correlation_id });
  try {
    if (!handler) throw new Error(`No handler registered for job kind "${claimed.kind}"`);
    const result = await handler(ctx);
    const finishedAt = new Date().toISOString();
    await update<Job>(key, (job) => {
      if (!job || job.claim !== claim) return undefined;
      return {
        ...job,
        status: 'done',
        input: summarizeInput(job.input),
        result: result ?? null,
        progress: null,
        ai_calls: [...aiCalls],
        notes: [...notes],
        updated_at: finishedAt,
        finished_at: finishedAt,
      };
    });
    const cost = aiCalls.reduce((sum, call) => sum + call.cost_estimate_usd, 0);
    logger.info('job_done', { job_id: jobId, kind: claimed.kind, ms: Date.now() - t0, ai_calls: aiCalls.length, cost_usd: Number(cost.toFixed(4)) });
  } catch (error) {
    const { status, detail } = toHttpError(error, jobId);
    const raw = error instanceof Error ? `${error.name}: ${error.message}\n${(error.stack || '').split('\n').slice(1, 8).join('\n')}` : String(error);
    const friendly = status >= 500 && !(error instanceof HttpError) && detail.startsWith('Something went wrong')
      ? `Something went wrong (reference ${jobId}): ${(error as Error)?.message?.slice(0, 300) || 'unknown error'}`
      : detail;
    const finishedAt = new Date().toISOString();
    try {
      await update<Job>(key, (job) => {
        if (!job || job.claim !== claim) return undefined;
        return {
          ...job,
          status: 'failed',
          input: summarizeInput(job.input),
          error: { status, detail: friendly },
          error_debug: raw.slice(0, 4000),
          progress: pendingProgress,
          ai_calls: [...aiCalls],
          notes: [...notes],
          updated_at: finishedAt,
          finished_at: finishedAt,
        };
      });
    } catch (writeError) {
      logger.error('job_failure_write_failed', { job_id: jobId, error: writeError });
    }
    logger.error('job_failed', { job_id: jobId, kind: claimed.kind, status, detail: friendly, error });
  }
}

// =============================================================================
// Reading
// =============================================================================

/** Jobs that died without reporting (crash, 15-minute cutoff, lost dispatch) read as failed. */
function withStaleCheck(job: Job): Job {
  const now = Date.now();
  if (job.status === 'running' && job.started_at && now - Date.parse(job.started_at) > JOB_MAX_RUNTIME_MS + 60_000) {
    return {
      ...job,
      status: 'failed',
      error: {
        status: 504,
        detail: 'This step ran out of time (the background worker stops after 15 minutes). Try again: finished drafts were saved, and drafting again does the missing sections first.',
      },
    };
  }
  if (job.status === 'queued' && now - Date.parse(job.created_at) > JOB_START_GRACE_MS) {
    return {
      ...job,
      status: 'failed',
      error: { status: 503, detail: 'The background worker never started this step. Try again; if it repeats, open the debug report.' },
    };
  }
  return job;
}

export function toPublicJob(job: Job): PublicJob {
  const checked = withStaleCheck(job);
  return {
    id: checked.id,
    kind: checked.kind,
    status: checked.status,
    progress: checked.progress,
    result: checked.status === 'done' ? checked.result : null,
    error: checked.error,
    application_id: checked.application_id,
    created_at: checked.created_at,
    updated_at: checked.updated_at,
    started_at: checked.started_at,
    finished_at: checked.finished_at,
  };
}

export async function getJob(userId: string, jobId: string): Promise<Job | null> {
  const job = await kv().get<Job>(jobKey(userId, jobId));
  return job ? withStaleCheck(job) : null;
}

/** Most recent jobs first. */
export async function listJobs(userId: string, limit = 20): Promise<Job[]> {
  const keys = (await kv().list(jobsPrefix(userId))).slice(-limit).reverse();
  const jobs = await Promise.all(keys.map((key) => kv().get<Job>(key)));
  return jobs.filter((job): job is Job => job !== null).map(withStaleCheck);
}
