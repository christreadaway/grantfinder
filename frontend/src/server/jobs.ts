/**
 * Jobs: every Claude call runs here, never inside the route that asked for it.
 *
 * An API route checks what it can, records a job and returns 202 {job_id} at
 * once; the website polls GET /api/jobs/{id}. Where the work runs depends on
 * the job mode (config.ts jobMode()):
 * - direct (Netlify default, every plan): the website calls
 *   POST /api/jobs/{id}/run, which runs the job inside that request. Netlify
 *   stops a request at 60 seconds, so a direct job stops its Claude calls at
 *   about 50 seconds; long steps save their progress and hand the website a
 *   follow-up request (a result with __continue) to finish the rest.
 * - background (Netlify, GRANTFINDER_BACKGROUND_JOBS=true): a Netlify
 *   background function runs it, up to 15 minutes.
 * - local (npm run dev, tests): inside the same server process.
 *
 * Each job record keeps its own AI call log and notes, which is what the
 * debug report and the writer's debug bundle show.
 */
import crypto from 'node:crypto';

import { getApiKey } from './auth';
import { Claude } from './claude';
import { directJobBudgetMs, JOB_MAX_RUNTIME_MS, JOB_START_GRACE_MS, jobMode, secretKey, type JobMode } from './config';
import { HttpError, toHttpError } from './errors';
import { jsonResponse, type RequestContext } from './http';
import { logger } from './log';
import { getMany, keyPart, kv, sortableId, update } from './store';
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
  /** Jobs sharing this key never run twice at once (e.g. drafting one application). */
  exclusive_key?: string | null;
  /** Where the job runs (see jobMode()); older records have none and ran in the background. */
  mode?: JobMode;
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
  /** 'direct': the website must call POST /api/jobs/{id}/run to run this job. */
  run?: 'direct';
}

/**
 * A handler result may carry `__continue`: the website then makes this request
 * (which starts the next job) and uses that job's result instead. Direct-mode
 * jobs use it to finish work that doesn't fit in one 60-second request.
 */
export interface JobContinuation {
  path: string;
  body: Record<string, unknown>;
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
  /** Where this job runs. */
  mode: JobMode;
  /** When this run's Claude calls are cut off (ms since epoch). */
  deadline: number;
  /** Milliseconds left before the cutoff: start another Claude call only if it can finish in time. */
  timeLeftMs(): number;
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

export interface JobOptions {
  applicationId?: string | null;
  correlationId?: string | null;
  /**
   * Refuse to start while a job with the same key is queued or running.
   * Defaults to kind + application, so a double click (or a click after a
   * reload) attaches to the running step instead of paying for it twice.
   * Pass null to allow parallel jobs (e.g. several document uploads).
   */
  exclusiveKey?: string | null;
  /**
   * The exclusive key already identifies the request (e.g. the website scan's
   * key holds a hash of its addresses), so any running job of the same kind
   * under that key counts as the same request even if the input differs in
   * form (a trailing slash). Otherwise the inputs must match exactly.
   */
  keyIdentifiesRequest?: boolean;
}

/** Job ids embed their creation time (job_YYYYMMDDTHHMMSSZ_xxxx). */
function jobIdTime(jobId: string): number {
  const match = /^job_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_/.exec(jobId);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : 0;
}

/** A queued or running job with this exclusive key, if any (only recent jobs are read). */
export async function findActiveJob(userId: string, exclusiveKey: string): Promise<Job | null> {
  const since = Date.now() - JOB_MAX_RUNTIME_MS - 2 * 60_000;
  const prefix = jobsPrefix(userId);
  const recentKeys = (await kv().list(prefix)).filter((key) => jobIdTime(key.slice(prefix.length)) >= since).slice(-20);
  const jobs = await Promise.all(recentKeys.map((key) => kv().get<Job>(key)));
  for (const job of jobs.reverse()) {
    if (!job || job.exclusive_key !== exclusiveKey) continue;
    const checked = withStaleCheck(job);
    if (checked.status === 'queued' || checked.status === 'running') return checked;
  }
  return null;
}

export async function createJob(
  userId: string,
  kind: string,
  input: unknown,
  options: JobOptions = {},
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
    exclusive_key: options.exclusiveKey ?? null,
    mode: jobMode(),
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
  logger.info('job_created', { job_id: job.id, kind, mode: job.mode, user_id: userId, correlation_id: job.correlation_id, application_id: job.application_id });
  return job;
}

async function failJob(userId: string, jobId: string, status: number, detail: string, debug: string): Promise<void> {
  await update<Job>(jobKey(userId, jobId), (job) => {
    if (!job || job.status === 'done' || job.status === 'failed') return undefined;
    const now = new Date().toISOString();
    return { ...job, status: 'failed', error: { status, detail }, error_debug: debug, progress: null, updated_at: now, finished_at: now };
  });
}

/**
 * Start the job where its mode says: in-process (local), the Netlify
 * background function (background), or nowhere yet (direct: the website's
 * POST /api/jobs/{id}/run request runs it).
 */
export async function dispatchJob(job: Job, origin: string): Promise<void> {
  const mode = job.mode ?? 'background';
  if (mode === 'direct') return;
  if (mode === 'local') {
    setTimeout(() => {
      runJob(job.user_id, job.id).catch((error) => logger.error('job_runner_crashed', { job_id: job.id, error }));
    }, 0);
    return;
  }
  // The deploy's own address (Netlify sets DEPLOY_URL/URL for functions), never
  // the request's Host header, so a crafted Host can't redirect this call.
  const base = (process.env.GRANTFINDER_JOBS_ORIGIN || process.env.DEPLOY_URL || origin).replace(/\/+$/, '');
  const url = `${base}${BACKGROUND_FUNCTION_PATH}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      // A redirect would turn this POST into a body-less GET that "succeeds"
      // without starting anything; only a real 202 from the worker counts.
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: job.user_id, job_id: job.id, signature: signJob(job.user_id, job.id) }),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 202) {
      const location = response.headers.get('location');
      throw new Error(`HTTP ${response.status}${location ? ` (redirect to ${location})` : ''} from ${url}`);
    }
    logger.info('job_dispatched', { job_id: job.id, kind: job.kind, status: response.status, url });
  } catch (error) {
    const message = (error as Error).message;
    logger.error('job_dispatch_failed', { job_id: job.id, kind: job.kind, url, error: message });
    await failJob(
      job.user_id,
      job.id,
      503,
      "Couldn't start the background worker. If this Netlify account's plan doesn't include background functions, remove GRANTFINDER_BACKGROUND_JOBS from the site's environment variables and redeploy (GrantFinder then works without them). Otherwise redeploy the site; if it keeps happening, open the debug report.",
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
  options: JobOptions = {},
): Promise<Response> {
  const user = await ctx.user();
  const exclusiveKey = options.exclusiveKey === undefined ? `${kind}:${options.applicationId ?? '-'}` : options.exclusiveKey;
  if (exclusiveKey) {
    const active = await findActiveJob(user.id, exclusiveKey);
    if (active) {
      const minutes = Math.max(0, Math.round((Date.now() - Date.parse(active.created_at)) / 60000));
      const ago = minutes === 0 ? 'less than a minute' : `${minutes} minute${minutes === 1 ? '' : 's'}`;
      // Only the very same request (a double click, or a click after a reload)
      // waits for the running job and shares its result. A different request
      // (a refine while a redraft runs, re-analysis with new guidelines) must
      // not be answered with another step's result, so it gets a plain 409.
      const sameRequest =
        active.kind === kind && (options.keyIdentifiesRequest === true || JSON.stringify(active.input ?? null) === JSON.stringify(input ?? null));
      logger.info('job_already_running', { job_id: active.id, kind, running_kind: active.kind, same_request: sameRequest, user_id: user.id });
      if (!sameRequest) {
        throw new HttpError(
          409,
          active.kind === kind
            ? `This step is already running with different details (started ${ago} ago). Wait for it to finish (the page updates when it does), then try again.`
            : `Another step that changes the same sections is still running (started ${ago} ago). Wait for it to finish, then try again. What you typed is kept.`,
        );
      }
      throw new HttpError(
        409,
        `This step is already running (started ${ago} ago). It will finish on its own; the page updates when it does.`,
        { job_id: active.id, kind: active.kind, running: true, ...(active.mode === 'direct' ? { run: 'direct' } : {}) },
      );
    }
  }
  const job = await createJob(user.id, kind, input, { ...options, exclusiveKey });
  await dispatchJob(job, ctx.origin);
  return jsonResponse({ job_id: job.id, status: job.status, kind, ...(job.mode === 'direct' ? { run: 'direct' } : {}) }, 202);
}

// =============================================================================
// Running
// =============================================================================

/**
 * Run a queued job. Safe to call twice: only the first caller claims it.
 * budgetMs (direct mode) cuts Claude calls off that long after this call
 * starts; otherwise they stop a little before Netlify's 15-minute limit.
 */
export async function runJob(userId: string, jobId: string, options: { budgetMs?: number } = {}): Promise<void> {
  const invokedAt = Date.now();
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
  // Stop Claude calls a little before the platform's cutoff (60 seconds for a
  // direct job's request, 15 minutes in the background) so the job can still
  // save what finished and report what didn't.
  const deadline = options.budgetMs ? invokedAt + options.budgetMs : invokedAt + JOB_MAX_RUNTIME_MS - 75_000;
  const hardStop = AbortSignal.timeout(Math.max(options.budgetMs ? 1_000 : 30_000, deadline - Date.now()));
  // Heartbeat: shows the job is alive even during one long Claude call, so a
  // job whose worker died is detected in minutes, not after 16.
  const heartbeat = setInterval(() => {
    update<Job>(key, (job) => {
      if (!job || job.claim !== claim || job.status !== 'running') return undefined;
      return { ...job, updated_at: new Date().toISOString() };
    }).catch(() => {
      // Best effort.
    });
  }, 45_000);
  const aiCalls: AICallLog[] = [];
  const notes: string[] = [];
  let lastProgressWrite = 0;
  let pendingProgress: string | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
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
        signal: hardStop,
        onCall: (entry) => aiCalls.push(entry),
      });
    },
    progress: async (message: string) => {
      pendingProgress = message;
      logger.info('job_progress', { job_id: jobId, kind: claimed.kind, message });
      const writeLatest = async () => {
        lastProgressWrite = Date.now();
        try {
          await flush(pendingProgress);
        } catch (error) {
          logger.warn('job_progress_write_failed', { job_id: jobId, error: (error as Error).message });
        }
      };
      const wait = 1500 - (Date.now() - lastProgressWrite);
      if (wait <= 0) {
        await writeLatest();
      } else if (!progressTimer) {
        // Throttled: write the newest line once the window passes, so quick
        // successive updates ("Scoring grants 11-20...") are not lost.
        progressTimer = setTimeout(() => {
          progressTimer = null;
          void writeLatest();
        }, wait);
      }
    },
    note: (line: string) => {
      notes.push(`${new Date().toISOString()} ${line}`);
      if (notes.length > 200) notes.splice(0, notes.length - 200);
    },
    mode: claimed.mode ?? 'background',
    deadline,
    timeLeftMs: () => Math.max(0, deadline - Date.now()),
  };

  logger.info('job_started', { job_id: jobId, kind: claimed.kind, mode: claimed.mode ?? 'background', user_id: userId, correlation_id: claimed.correlation_id });
  try {
    if (!handler) throw new Error(`No handler registered for job kind "${claimed.kind}"`);
    const result = await handler(ctx);
    clearInterval(heartbeat);
    if (progressTimer) clearTimeout(progressTimer);
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
    clearInterval(heartbeat);
    if (progressTimer) clearTimeout(progressTimer);
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

/** Direct jobs run inside one request, which Netlify stops at 60 seconds. */
const DIRECT_STALE_MS = 75_000;

/** Jobs that died without reporting (crash, time limit, lost dispatch) read as failed. */
function withStaleCheck(job: Job): Job {
  const now = Date.now();
  if (job.mode === 'direct') {
    const quiet = now - Date.parse(job.updated_at) > DIRECT_STALE_MS;
    const long = job.started_at !== null && now - Date.parse(job.started_at) > DIRECT_STALE_MS;
    if (job.status === 'running' && (quiet || long)) {
      return {
        ...job,
        status: 'failed',
        error: {
          status: 504,
          detail:
            'This step was stopped by Netlify (each step can run for about a minute on this site). Try it again: anything that finished was saved. If it keeps happening, use "Copy debug report".',
        },
      };
    }
    if (job.status === 'queued' && now - Date.parse(job.created_at) > JOB_START_GRACE_MS) {
      return {
        ...job,
        status: 'failed',
        error: { status: 503, detail: 'This step never started (the page was closed or lost its connection first). Try it again.' },
      };
    }
    return job;
  }
  const tooLong = job.started_at !== null && now - Date.parse(job.started_at) > JOB_MAX_RUNTIME_MS + 60_000;
  const silent = now - Date.parse(job.updated_at) > 3 * 60_000; // no heartbeat for 3 minutes
  if (job.status === 'running' && (tooLong || silent)) {
    return {
      ...job,
      status: 'failed',
      error: {
        status: 504,
        detail: tooLong
          ? 'This step ran out of time (the background worker stops after 15 minutes). Try it again; anything that finished was saved (drafting again does the missing sections first).'
          : 'The background worker stopped unexpectedly during this step. Try it again; anything that finished was saved. If it repeats, use "Copy debug report".',
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
    ...(checked.mode === 'direct' ? { run: 'direct' as const } : {}),
  };
}

/**
 * POST /api/jobs/{id}/run: run a queued direct-mode job inside this request
 * (within Netlify's 60 seconds) and return it finished. A job already running
 * or finished is just returned; the website keeps polling it.
 */
export async function runDirectJob(userId: string, jobId: string): Promise<Job | null> {
  const job = await getJob(userId, jobId);
  if (!job) return null;
  if (job.status === 'queued' && job.mode === 'direct') {
    await runJob(userId, jobId, { budgetMs: directJobBudgetMs() });
    return getJob(userId, jobId);
  }
  return job;
}

export async function getJob(userId: string, jobId: string): Promise<Job | null> {
  const job = await kv().get<Job>(jobKey(userId, jobId));
  return job ? withStaleCheck(job) : null;
}

/** Most recent jobs first. */
export async function listJobs(userId: string, limit = 20): Promise<Job[]> {
  const keys = (await kv().list(jobsPrefix(userId))).slice(-limit).reverse();
  const jobs = await getMany<Job>(keys);
  return jobs.map(withStaleCheck);
}
