/**
 * In-process test harness for the GrantFinder engine (frontend/src/server).
 *
 * Calls the real request handler directly (no browser, no Next.js build),
 * with a mock Claude server, a throwaway data folder, and guest sign-in.
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/<area>.test.mts
 *
 * Jobs run in-process exactly as they do in `npm run dev`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');

// ---------------------------------------------------------------------------
// Environment (must run before the engine is imported)
// ---------------------------------------------------------------------------

export function setupEnv(name: string, extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `grantfinder-${name}-`));
  Object.assign(process.env, {
    GRANTFINDER_DATA_DIR: dir,
    GRANTFINDER_STORE: 'fs',
    GRANTFINDER_FILE_LOGS: '0',
    GRANTFINDER_LOG_STDOUT: process.env.VERBOSE ? '1' : '0',
    GRANTFINDER_TEST_MODE: '1',
    ALLOW_GUEST_LOGIN: 'true',
    SECRET_KEY: 'test-secret-key-0123456789-abcdefghijklmnopqrstuvwxyz',
    CLAUDE_MODEL: 'claude-sonnet-5',
    ...extra,
  });
  return dir;
}

// ---------------------------------------------------------------------------
// Mock Claude
// ---------------------------------------------------------------------------

export interface MockClaude {
  url: string;
  stop(): void;
  requests(): Promise<Array<{ prompt_id: string; prompt: string; key_suffix: string; tools: string[]; turns: number; max_tokens: number }>>;
  reset(): Promise<void>;
  fail(promptId: string, status?: number, type?: string, times?: number): Promise<void>;
  fixtures(map: Record<string, unknown>): Promise<void>;
  delay(promptId: string, ms: number): Promise<void>;
}

let mockProcess: ChildProcess | null = null;

export async function startMock(port = 4000 + Math.floor(Math.random() * 900)): Promise<MockClaude> {
  const url = `http://127.0.0.1:${port}`;
  mockProcess = spawn(process.execPath, [path.join(repoRoot, 'tests', 'mock-claude', 'server.mjs'), '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock Claude did not start')), 10000);
    mockProcess!.stdout!.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    mockProcess!.on('exit', (code) => reject(new Error(`mock Claude exited (${code})`)));
  });
  process.env.ANTHROPIC_BASE_URL = url;
  const post = (p: string, body: unknown) =>
    fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    url,
    stop: () => mockProcess?.kill(),
    requests: async () => (await fetch(`${url}/__requests`)).json(),
    reset: async () => {
      await post('/__reset', {});
    },
    fail: async (promptId, status = 529, type = 'overloaded_error', times = 1) => {
      await post('/__fail', { prompt_id: promptId, status, type, times });
    },
    fixtures: async (map) => {
      await post('/__fixtures', map);
    },
    delay: async (promptId, ms) => {
      await post('/__delay', { prompt_id: promptId, ms });
    },
  };
}

process.on('exit', () => mockProcess?.kill());

// ---------------------------------------------------------------------------
// Calling the engine
// ---------------------------------------------------------------------------

type Handler = (req: Request) => Promise<Response>;
let handler: Handler | null = null;

async function engine(): Promise<Handler> {
  if (!handler) {
    const mod = await import('../../frontend/src/server/app.ts');
    handler = mod.handleRequest as Handler;
  }
  return handler;
}

export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  text: string;
  headers: Headers;
  bytes: Uint8Array;
}

export interface ApiOptions {
  token?: string;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
}

export async function api(method: string, urlPath: string, options: ApiOptions = {}): Promise<ApiResult> {
  const headers: Record<string, string> = { ...(options.headers || {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form) {
    body = options.form;
  }
  const request = new Request(`http://localhost:3000${urlPath}`, { method, headers, body });
  const response = await (await engine())(request);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, data, text, headers: response.headers, bytes };
}

/**
 * Like the website: when a route answers 202 {job_id}, poll the job and
 * return {status: 200, data: result} or {status: error.status, data: {detail}}.
 */
export async function call(method: string, urlPath: string, options: ApiOptions = {}, timeoutMs = 90000): Promise<ApiResult & { jobId?: string }> {
  const first = await api(method, urlPath, options);
  if (first.status !== 202 || !first.data?.job_id) return first;
  const jobId: string = first.data.job_id;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const poll = await api('GET', `/api/jobs/${jobId}`, { token: options.token });
    if (poll.status !== 200) return { ...poll, jobId };
    if (poll.data.status === 'done') return { ...poll, status: 200, data: poll.data.result, jobId };
    if (poll.data.status === 'failed') return { ...poll, status: poll.data.error?.status ?? 500, data: { detail: poll.data.error?.detail }, jobId };
  }
  throw new Error(`job ${jobId} for ${method} ${urlPath} did not finish in ${timeoutMs}ms`);
}

export async function guest(): Promise<string> {
  const result = await api('POST', '/api/auth/guest');
  if (result.status !== 200) throw new Error(`guest sign-in failed: ${result.status} ${result.text}`);
  return result.data.access_token;
}

export async function saveKey(token: string, key = 'sk-ant-test-key-0000'): Promise<void> {
  const result = await api('POST', '/api/auth/api-key', { token, json: { api_key: key } });
  if (result.status !== 200) throw new Error(`saving API key failed: ${result.status} ${result.text}`);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

export function check(name: string, ok: boolean, detail?: unknown): boolean {
  const text = detail === undefined ? undefined : typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600);
  results.push({ name, ok, detail: text });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && text ? `\n      ${text}` : ''}`);
  return ok;
}

/** Print the summary and exit non-zero when anything failed. */
export function finish(): never {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  mockProcess?.kill();
  process.exit(failed.length ? 1 : 0);
}
