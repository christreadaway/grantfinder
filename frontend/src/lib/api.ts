/**
 * API client for the GrantFinder engine.
 *
 * The engine is part of this same site (Next.js routes at /api/*), so every
 * call is same-origin: no API URL to configure, no CORS.
 *
 * Long AI steps run as background jobs: the engine answers 202 {job_id} and
 * this client polls GET /api/jobs/{id} until the job finishes, then hands the
 * page the job's result as if the call had answered directly. Screens keep
 * reading response.data and error.response.data.detail exactly as before.
 * Pages can show live progress with onJobProgress().
 */
import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';

/** Same-origin: the engine lives at /api on this site. */
export const API_BASE_URL = '';

export interface JobProgress {
  jobId: string;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: string | null;
}

type ProgressListener = (info: JobProgress) => void;
const progressListeners = new Set<ProgressListener>();

/** Subscribe to background-job progress; returns an unsubscribe function. */
export function onJobProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

function emitProgress(info: JobProgress) {
  progressListeners.forEach((listener) => {
    try {
      listener(info);
    } catch {
      // A broken listener must never break the request.
    }
  });
}

/** An error shaped like an axios error, so pages can read error.response.data.detail. */
function apiError(status: number, detail: string): Error & { response: { status: number; data: { detail: string } } } {
  const error = new Error(detail) as Error & { response: { status: number; data: { detail: string } } };
  error.response = { status, data: { detail } };
  return error;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Netlify stops background work at 15 minutes; give polling a little longer. */
const JOB_POLL_LIMIT_MS = 17 * 60 * 1000;

/** How long a step may go without one successful status check before polling gives up. */
const LOST_CONTACT_MS = 3 * 60 * 1000;

const NETWORK_MESSAGE =
  'Lost the connection to GrantFinder. Check your internet, then click the same button again: a step still running is picked back up, not started twice.';

/** Resolves when the browser reports it is back online, or after maxMs (whichever comes first). */
function waitForOnline(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    const done = () => {
      window.removeEventListener('online', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, maxMs);
    window.addEventListener('online', done);
  });
}

/**
 * The sentence to show a person when a call fails: the engine's own detail when
 * there is one, otherwise a plain explanation (lost connection, timeout, a
 * Netlify error page) instead of axios's raw "Network Error".
 */
/** The parts of an axios (or apiError) error that the messages below read. */
interface ErrorLike {
  code?: string;
  isAxiosError?: boolean;
  message?: string;
  response?: { status?: number; data?: unknown };
}

function asErrorLike(error: unknown): ErrorLike {
  return error && typeof error === 'object' ? (error as ErrorLike) : {};
}

export function errorDetail(error: unknown, fallback: string): string {
  const e = asErrorLike(error);
  const data = e.response?.data;
  const detail = data && typeof data === 'object' ? (data as { detail?: unknown }).detail : undefined;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail && typeof detail === 'object') {
    try {
      return JSON.stringify(detail);
    } catch {
      // fall through
    }
  }
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT') {
    return 'GrantFinder took too long to answer. Check your internet connection, then click the same button again (a step still running is picked back up, not started twice).';
  }
  if (e.code === 'ERR_NETWORK' || (e.isAxiosError && !e.response)) return NETWORK_MESSAGE;
  const status = e.response?.status;
  if (status && status >= 500) {
    return `GrantFinder had a problem (HTTP ${status}). Wait a minute and try again. If it keeps happening, use "Copy debug report" and paste it into Claude Code.`;
  }
  if (status) return `${fallback} (HTTP ${status})`;
  return e.message || fallback;
}

/** errorDetail for downloads: their error bodies arrive as a Blob that must be read first. */
export async function blobErrorDetail(error: unknown, fallback: string): Promise<string> {
  const e = asErrorLike(error);
  const data = e.response?.data as { text?: () => Promise<string> } | undefined;
  if (data && typeof data.text === 'function') {
    try {
      const parsed = JSON.parse(await data.text()) as { detail?: unknown };
      if (typeof parsed?.detail === 'string' && parsed.detail.trim()) return parsed.detail;
    } catch {
      // Not JSON (e.g. a Netlify error page): fall back to the status.
    }
    return errorDetail({ code: e.code, isAxiosError: e.isAxiosError, message: e.message, response: { status: e.response?.status, data: {} } }, fallback);
  }
  return errorDetail(error, fallback);
}

/** True when the engine said the session is over (as opposed to a network blip or a server error). */
export function isSessionEnded(error: unknown): boolean {
  return asErrorLike(error).response?.status === 401;
}

class ApiClient {
  private client: AxiosInstance;
  private token: string | null = null;
  /** False when the browser refused to store the session (it then lasts only while this tab stays open). */
  private sessionStored = true;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add auth interceptor
    this.client.interceptors.request.use((config) => {
      if (this.token) {
        config.headers.Authorization = `Bearer ${this.token}`;
      }
      return config;
    });

    // Jobs: turn 202 {job_id} into the finished result. A 409 that says the
    // same step is already running (a double click, or a click after
    // reloading mid-step) waits for that run instead of failing or paying
    // twice. A result carrying __continue (a long step that saved part of its
    // work) is followed by its next request automatically.
    this.client.interceptors.response.use(
      async (response: AxiosResponse) => {
        const data = response.data as { job_id?: string; kind?: string; run?: string } | undefined;
        if (response.status === 202 && data?.job_id && response.config.responseType !== 'blob') {
          const result = await this.pollJob(data.job_id, data.kind || 'job', data.run === 'direct');
          return { ...response, status: 200, statusText: 'OK', data: await this.followContinuation(result, response.config) };
        }
        return response;
      },
      async (error: AxiosError<{ job_id?: string; kind?: string; running?: boolean; run?: string }>) => {
        const data = error?.response?.data;
        if (error?.response?.status === 409 && data?.running && data.job_id && error.config?.responseType !== 'blob') {
          console.info(`[GrantFinder] ${data.kind || 'step'} is already running (job ${data.job_id}); waiting for it.`);
          emitProgress({ jobId: data.job_id, kind: data.kind || 'job', status: 'running', progress: 'Already running from an earlier click; waiting for it to finish...' });
          const result = await this.pollJob(data.job_id, data.kind || 'job', data.run === 'direct');
          const followed = error.config ? await this.followContinuation(result, error.config) : result;
          return { data: followed, status: 200, statusText: 'OK', headers: {}, config: error.config } as AxiosResponse;
        }
        return Promise.reject(error);
      },
    );

    // A session can end (expired, or signed in on another device and the
    // server was reset). Any later auth failure sends the user back to sign in
    // with an explanation instead of leaving every button failing.
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError<{ detail?: string }>) => {
        const status = error?.response?.status;
        const url: string = error?.config?.url || '';
        const missingToken = status === 403 && error?.response?.data?.detail === 'Not authenticated';
        if ((status === 401 || missingToken) && !url.startsWith('/api/auth/') && typeof window !== 'undefined') {
          console.warn(`[GrantFinder] Session ended (${status} on ${url}); returning to sign-in.`);
          this.clearToken();
          if (window.location.pathname !== '/') {
            window.location.href = '/?expired=1';
          }
        }
        return Promise.reject(error);
      },
    );
  }

  /**
   * A long step that saved part of its work returns {..., __continue: {path,
   * body}}: make that request (it starts the next part, and is followed the
   * same way) and hand back the final result. At most 30 parts.
   */
  private async followContinuation(result: unknown, config: { headers?: unknown }): Promise<unknown> {
    const next = (result as { __continue?: { path?: unknown; body?: unknown } } | null)?.__continue;
    if (!next || typeof next.path !== 'string' || !next.path.startsWith('/api/')) return result;
    const headers = (config.headers ?? {}) as Record<string, unknown>;
    const depth = Number(headers['x-grantfinder-part'] ?? 0) + 1;
    if (depth > 30) {
      console.warn('[GrantFinder] Stopped following a step after 30 parts.');
      return result;
    }
    console.info(`[GrantFinder] Continuing a long step (part ${depth + 1}): ${next.path}`);
    const response = await this.client.post(next.path, next.body ?? {}, { headers: { 'x-grantfinder-part': String(depth) } });
    return response.data;
  }

  /**
   * Wait for a job a page found still running (e.g. after a reload): its
   * result, with any follow-up parts of a long step done too.
   */
  async waitForJob(jobId: string, kind: string, direct = false): Promise<unknown> {
    return this.followContinuation(await this.pollJob(jobId, kind, direct), {});
  }

  /**
   * Poll a job until it is done (returns its result) or failed (throws its
   * detail). In direct mode (any Netlify plan) this also starts the job with
   * POST /api/jobs/{id}/run, which runs it inside that request; polling shows
   * its progress meanwhile. The step runs on the server either way, so a
   * Wi-Fi drop, a sleeping laptop, or a passing Netlify error only pauses the
   * checking: polling gives up only after 3 minutes without one good answer
   * while the browser is online.
   */
  private async pollJob(jobId: string, kind: string, direct = false): Promise<unknown> {
    const started = Date.now();
    let delay = 1000;
    // When the current run of failed checks began (null while checks succeed).
    // Measured from the first failure, not the last success, so a laptop that
    // slept for an hour and fails one check on waking doesn't give up at once.
    let failingSince: number | null = null;
    let runInFlight = false;
    let lastRunAt = 0;
    const startRun = () => {
      if (runInFlight) return;
      runInFlight = true;
      lastRunAt = Date.now();
      this.client
        .post(`/api/jobs/${jobId}/run`, {}, { timeout: 90_000 })
        .catch((error) => console.warn(`[GrantFinder] Running ${kind} (job ${jobId}) did not answer; still checking its status.`, error))
        .finally(() => {
          runInFlight = false;
        });
    };
    console.info(`[GrantFinder] ${kind} started (job ${jobId})${direct ? ' (runs in this request)' : ''}`);
    emitProgress({ jobId, kind, status: 'queued', progress: 'Starting...' });
    if (direct) startRun();
    for (;;) {
      await sleep(delay);
      delay = Math.min(3000, delay + 250);
      let job: { status: JobProgress['status']; progress: string | null; result?: unknown; error?: { status: number; detail: string } | null; run?: string };
      try {
        job = (await this.client.get(`/api/jobs/${jobId}`, { timeout: 20000 })).data;
        failingSince = null;
      } catch (error) {
        const status = (error as AxiosError)?.response?.status;
        if (status === 401 || status === 403 || status === 404) throw error;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          console.warn(`[GrantFinder] Offline while ${kind} runs (job ${jobId}); waiting for the connection.`);
          emitProgress({ jobId, kind, status: 'running', progress: 'Waiting for your internet connection (the step keeps running on the server)...' });
          await waitForOnline(30000);
          failingSince = null; // time offline doesn't count against the step
          delay = 1000;
          continue;
        }
        failingSince ??= Date.now();
        const silentMs = Date.now() - failingSince;
        console.warn(`[GrantFinder] Checking ${kind} failed (no answer for ${Math.round(silentMs / 1000)}s); retrying.`, error);
        if (silentMs < LOST_CONTACT_MS) {
          if (silentMs > 15000) {
            emitProgress({ jobId, kind, status: 'running', progress: 'Having trouble reaching GrantFinder; still checking (the step keeps running on the server)...' });
          }
          continue;
        }
        throw apiError(503, 'Lost contact with GrantFinder while this step was running. It may still finish: wait a minute, then reload the page or click the same button again (a step still running is picked back up, not started twice).');
      }
      emitProgress({ jobId, kind, status: job.status, progress: job.progress });
      if (job.status === 'done') {
        console.info(`[GrantFinder] ${kind} finished in ${Math.round((Date.now() - started) / 1000)}s (job ${jobId})`);
        return job.result;
      }
      if (job.status === 'failed') {
        const detail = job.error?.detail || 'This step failed. Use "Copy debug report" for details.';
        console.error(`[GrantFinder] ${kind} failed (job ${jobId}): ${detail}`);
        throw apiError(job.error?.status || 500, detail);
      }
      // A direct-mode job nobody is running yet (its first run request was
      // lost, or the page reloaded before starting it): start it from here.
      if (job.run === 'direct' && job.status === 'queued' && !runInFlight && Date.now() - lastRunAt > 5000) startRun();
      if (Date.now() - started > JOB_POLL_LIMIT_MS) {
        throw apiError(504, 'This step is taking much longer than expected. Reload the page in a minute; if it is still not done, use "Copy debug report" and paste it into Claude Code.');
      }
    }
  }

  // Browser storage can be blocked (strict privacy settings, some private
  // windows). The session then lasts only while this page stays open, which
  // is better than failing to sign in at all.
  setToken(token: string) {
    this.token = token;
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem('auth_token', token);
      this.sessionStored = true;
    } catch (error) {
      this.sessionStored = false;
      console.warn('[GrantFinder] Browser storage is blocked; this sign-in lasts only while the page stays open.', error);
    }
  }

  /** False when this browser blocks saving the session: closing or reloading the tab would lose it. */
  isSessionStored(): boolean {
    return this.sessionStored;
  }

  /** True when this browser lets GrantFinder keep a session (checked before a guest sign-in). */
  canStoreSession(): boolean {
    if (typeof window === 'undefined') return true;
    try {
      const probe = 'grantfinder_storage_probe';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  loadToken() {
    if (typeof window === 'undefined') return this.token;
    try {
      this.token = localStorage.getItem('auth_token') ?? this.token;
    } catch {
      // Storage blocked: keep the session held in memory, if any.
    }
    return this.token;
  }

  clearToken() {
    this.token = null;
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem('auth_token');
    } catch {
      // Storage blocked: nothing was saved there.
    }
  }

  // Auth endpoints
  async getAuthOptions(): Promise<{ google: boolean; guest: boolean }> {
    const response = await this.client.get('/api/auth/options', { timeout: 15000 });
    return response.data;
  }

  async googleAuth(credential: string) {
    const response = await this.client.post('/api/auth/google', { credential });
    this.setToken(response.data.access_token);
    return response.data;
  }

  async guestAuth() {
    const response = await this.client.post('/api/auth/guest');
    this.setToken(response.data.access_token);
    return response.data;
  }

  async getMe() {
    const response = await this.client.get('/api/auth/me');
    return response.data;
  }

  async setApiKey(apiKey: string) {
    const response = await this.client.post('/api/auth/api-key', { api_key: apiKey });
    return response.data;
  }

  async getApiKeyStatus() {
    const response = await this.client.get('/api/auth/api-key/status');
    return response.data;
  }

  // Grant endpoints
  async uploadGrantDatabase(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.client.post('/api/grants/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  }

  async getGrants(category?: string) {
    const params = category ? { category } : {};
    const response = await this.client.get('/api/grants', { params });
    return response.data;
  }

  async getGrantStats() {
    const response = await this.client.get('/api/grants/stats');
    return response.data;
  }

  // Grant discovery endpoints
  async loadStarterDatabase() {
    const response = await this.client.post('/api/discovery/seed');
    return response.data;
  }

  async searchGrantsGov(keywords?: string[], maxResults?: number) {
    const response = await this.client.post('/api/discovery/grants-gov', {
      keywords,
      max_results: maxResults,
    });
    return response.data;
  }

  async webDiscovery(focus?: string) {
    const response = await this.client.post('/api/discovery/web-search', { focus });
    return response.data;
  }

  async getDiscoverySources() {
    const response = await this.client.get('/api/discovery/sources');
    return response.data;
  }

  // Processing endpoints
  async scanWebsite(churchUrl?: string, schoolUrl?: string) {
    const response = await this.client.post('/api/processing/scan-website', {
      church_url: churchUrl || null,
      school_url: schoolUrl || null,
    });
    return response.data;
  }

  async generateQuestionnaire() {
    const response = await this.client.post('/api/processing/generate-questionnaire');
    return response.data;
  }

  async submitQuestionnaire(answers: Array<{ question_id: number; answer: unknown; question?: string }>, freeFormText?: string) {
    const response = await this.client.post('/api/processing/submit-questionnaire', {
      answers,
      free_form_text: freeFormText,
    });
    return response.data;
  }

  /** The last questionnaire Claude wrote for this account, or null (so a reload doesn't pay for a new one). */
  async getSavedQuestionnaire() {
    try {
      const response = await this.client.get('/api/processing/questionnaire');
      return response.data;
    } catch (error) {
      if ((error as AxiosError)?.response?.status === 404) return null;
      throw error;
    }
  }

  async uploadDocument(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.client.post('/api/processing/upload-document', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  }

  /** The saved organization profile, or null when there isn't one yet. */
  async getProfile() {
    try {
      const response = await this.client.get('/api/processing/profile');
      return response.data;
    } catch (error) {
      if ((error as AxiosError)?.response?.status === 404) return null;
      throw error;
    }
  }

  async updateProfile(profile: Record<string, unknown>) {
    const response = await this.client.put('/api/processing/profile', profile);
    return response.data;
  }

  async matchGrants() {
    const response = await this.client.post('/api/processing/match-grants');
    return response.data;
  }

  /** The newest saved match results, or null when matching hasn't run yet. */
  async getLatestMatchResults() {
    try {
      const response = await this.client.get('/api/processing/match-results/latest');
      return response.data;
    } catch (error) {
      if ((error as AxiosError)?.response?.status === 404) return null;
      throw error;
    }
  }

  // Writer module endpoints
  async createApplication(grantId: string) {
    const response = await this.client.post('/api/writer/applications', { grant_id: grantId });
    return response.data;
  }

  async listApplications() {
    const response = await this.client.get('/api/writer/applications');
    return response.data;
  }

  async getApplication(appId: string) {
    const response = await this.client.get(`/api/writer/applications/${appId}`);
    return response.data;
  }

  async enrichGrantSpec(appId: string, guidelinesText?: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/grant-spec`, {
      guidelines_text: guidelinesText || null,
    });
    return response.data;
  }

  async analyzeFit(appId: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/analyze`);
    return response.data;
  }

  async confirmStrategy(appId: string, strategy?: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/confirm-strategy`, {
      strategy: strategy || null,
    });
    return response.data;
  }

  async generateIntake(appId: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/intake/generate`);
    return response.data;
  }

  async answerIntake(appId: string, requestId: string, responseText: string, isConfirmedGap: boolean) {
    const response = await this.client.put(
      `/api/writer/applications/${appId}/intake/${requestId}/answer`,
      { response: responseText, is_confirmed_gap: isConfirmedGap },
    );
    return response.data;
  }

  async waiveGap(appId: string, gapId: string, reason?: string) {
    const response = await this.client.put(
      `/api/writer/applications/${appId}/gaps/${gapId}/waive`,
      { reason: reason || null },
    );
    return response.data;
  }

  /** Draft all sections, one section, or (onlyMissing) just the sections with no draft yet. */
  async draftSections(appId: string, sectionId?: string, onlyMissing = false) {
    const response = await this.client.post(`/api/writer/applications/${appId}/draft`, {
      section_id: sectionId || null,
      only_missing: onlyMissing,
    });
    return response.data;
  }

  async scoreApplication(appId: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/score`);
    return response.data;
  }

  async refineSection(appId: string, sectionId: string, instruction: string) {
    const response = await this.client.post(
      `/api/writer/applications/${appId}/sections/${sectionId}/refine`,
      { instruction },
    );
    return response.data;
  }

  /** Save a hand edit of one section (limits and banned phrases are re-checked on the server). */
  async editSection(appId: string, sectionId: string, text: string) {
    const response = await this.client.put(`/api/writer/applications/${appId}/sections/${sectionId}`, { text });
    return response.data;
  }

  async exportApplication(appId: string, format: 'docx' | 'md' | 'txt' | 'form_map') {
    const response = await this.client.post(
      `/api/writer/applications/${appId}/export`,
      { format },
      { responseType: 'blob' },
    );
    return response;
  }

  async analyzeVoice(samples: string[]) {
    const response = await this.client.post('/api/writer/voice/analyze', { samples });
    return response.data;
  }

  /** One application's debug bundle (markdown for Claude Code). */
  async getApplicationDebugBundle(appId: string): Promise<string> {
    const response = await this.client.get(`/api/writer/applications/${appId}/debug-bundle`);
    return response.data?.bundle_markdown ?? JSON.stringify(response.data, null, 2);
  }

  // Export endpoints
  async exportResults(sessionId: string, format: 'csv' | 'md' | 'pdf', includeAll: boolean = false) {
    const response = await this.client.post('/api/export', {
      session_id: sessionId,
      format,
      include_all_matches: includeAll,
    }, { responseType: 'blob' });
    return response.data;
  }

  /** Recent background steps (newest first), e.g. to pick up one still running after a reload. */
  async listJobs(): Promise<Array<{ id: string; kind: string; status: JobProgress['status']; application_id: string | null; progress: string | null }>> {
    const response = await this.client.get('/api/jobs');
    return response.data?.jobs ?? [];
  }

  // Debugging
  /** Paste-ready markdown: settings, recent steps, errors, AI calls. No secrets. */
  async getDebugReport(): Promise<string> {
    const response = await this.client.get('/api/debug/report', { responseType: 'text' });
    return typeof response.data === 'string' ? response.data : JSON.stringify(response.data, null, 2);
  }
}

export const api = new ApiClient();
export default api;
