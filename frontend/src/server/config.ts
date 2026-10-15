/**
 * Runtime settings for the GrantFinder engine.
 *
 * The engine runs in three places and reads everything lazily so each sees
 * its own environment:
 *   - Next.js API routes (src/app/api/[...path]/route.ts) on Netlify or `npm run dev`
 *   - the Netlify background function that runs long AI jobs
 *   - local tests
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ConfigError } from './errors';

export const APP_NAME = 'GrantFinder AI';
export const APP_VERSION = '3.0.0';

const raw = (name: string): string => (process.env[name] ?? '').trim();

function flag(name: string, fallback = false): boolean {
  const value = raw(name).toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

// =============================================================================
// Where are we running?
// =============================================================================

/**
 * True on Netlify (production, previews, `netlify dev`). Next.js inlines
 * GRANTFINDER_ON_NETLIFY at build time (see next.config.js); the background
 * function, which Netlify bundles separately, is detected by the `Netlify`
 * global that Netlify's function runtime provides.
 */
export function onNetlify(): boolean {
  if (process.env.GRANTFINDER_ON_NETLIFY === 'true') return true;
  if (typeof (globalThis as { Netlify?: unknown }).Netlify !== 'undefined') return true;
  return false;
}

/** Netlify Blobs credentials are present (injected by Netlify into functions). */
export function blobsContextPresent(): boolean {
  const g = globalThis as { netlifyBlobsContext?: unknown; Netlify?: { env?: { get?: (k: string) => string | undefined } } };
  if (g.netlifyBlobsContext) return true;
  if (raw('NETLIFY_BLOBS_CONTEXT')) return true;
  try {
    if (g.Netlify?.env?.get?.('NETLIFY_BLOBS_CONTEXT')) return true;
  } catch {
    // Netlify.env.get can throw outside a request; treat as absent.
  }
  return false;
}

export type StoreKind = 'blobs' | 'fs';

/**
 * Netlify Blobs on Netlify, JSON files on disk everywhere else.
 * GRANTFINDER_STORE=fs|blobs overrides the choice.
 */
export function storeKind(): StoreKind {
  const forced = raw('GRANTFINDER_STORE').toLowerCase();
  if (forced === 'fs' || forced === 'blobs') return forced;
  if (blobsContextPresent()) return 'blobs';
  if (onNetlify()) return 'blobs'; // getStore() will explain clearly if Blobs truly is missing
  return 'fs';
}

/** Local data folder for the file store and the dev secret (git-ignored). */
export function dataDir(): string {
  return raw('GRANTFINDER_DATA_DIR') || path.join(process.cwd(), '.data');
}

/** Test runs point the Claude client at a mock server and tag each call with its prompt id. */
export function testMode(): boolean {
  return raw('GRANTFINDER_TEST_MODE') === '1';
}

// =============================================================================
// Secrets and sign-in
// =============================================================================

let cachedDevSecret: string | null = null;

/**
 * SECRET_KEY signs sign-in sessions and encrypts saved Claude API keys.
 * Required on Netlify. Locally, a random key is generated once and kept in
 * .data/ so sessions and saved keys survive restarts.
 */
export function secretKey(): string {
  const configured = raw('SECRET_KEY');
  if (configured) {
    if (configured.length < 32) {
      throw new ConfigError('SECRET_KEY must be at least 32 characters. Generate a new one (see docs/deployment.md, Step 2).');
    }
    return configured;
  }
  if (onNetlify()) {
    throw new ConfigError(
      'SECRET_KEY is not set. In Netlify: Site configuration > Environment variables > add SECRET_KEY ' +
        '(at least 32 random characters), then redeploy.',
    );
  }
  if (cachedDevSecret) return cachedDevSecret;
  const file = path.join(dataDir(), 'dev-secret-key.txt');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      cachedDevSecret = existing;
      return existing;
    }
  } catch {
    // Not created yet.
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  console.warn(`[GrantFinder] SECRET_KEY not set; generated a local development key in ${file}`);
  cachedDevSecret = generated;
  return generated;
}

/** One Google OAuth client ID serves both the button and the server-side check. */
export function googleClientId(): string {
  return raw('GOOGLE_CLIENT_ID') || (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '').trim();
}

/** Guest sign-in: temporary accounts without Google. Off unless turned on. */
export function allowGuestLogin(): boolean {
  return flag('ALLOW_GUEST_LOGIN', false);
}

export const ACCESS_TOKEN_DAYS = 30;

// =============================================================================
// AI
// =============================================================================

/**
 * Never hardcode the model: CLAUDE_MODEL picks it (default claude-sonnet-5-5, Claude Sonnet 5.5:
 * $2 / $10 per million tokens). Sonnet 5.5 rejects thinking {type:'disabled'} and forced
 * tool_choice; the engine sends neither (the mock Claude refuses both in tests).
 */
export function claudeModel(): string {
  return raw('CLAUDE_MODEL') || 'claude-sonnet-5-5';
}

/** Anthropic's own API: where every Claude call goes outside the tests. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com';

/**
 * Where Claude calls go. Always handed to the SDK explicitly, because left unset the SDK reads
 * ANTHROPIC_BASE_URL, and Netlify's AI Gateway injects that variable into every function on
 * credit-based plans: the gateway then rejects the person's own Anthropic key (401) and the app
 * would say the key was rejected. ANTHROPIC_BASE_URL is ignored on purpose; only
 * GRANTFINDER_CLAUDE_BASE_URL (the tests' mock Claude) changes it.
 */
export function anthropicBaseUrl(): string {
  return raw('GRANTFINDER_CLAUDE_BASE_URL') || ANTHROPIC_API_URL;
}

/** Host of anthropicBaseUrl(), for health checks and debug reports. */
export function anthropicHost(): string {
  try {
    return new URL(anthropicBaseUrl()).host;
  } catch {
    return 'invalid GRANTFINDER_CLAUDE_BASE_URL';
  }
}

export function logLevel(): 'debug' | 'info' {
  return raw('LOG_LEVEL').toLowerCase() === 'debug' ? 'debug' : 'info';
}

// =============================================================================
// Limits (mirroring backend/config.py)
// =============================================================================

/**
 * Netlify functions accept request bodies up to about 6 MB, and file uploads
 * are base64-encoded on the way in, so the hosted limit is 4 MB.
 */
export function maxUploadBytes(): number {
  return onNetlify() ? 4 * 1024 * 1024 : 10 * 1024 * 1024;
}

export const ALLOWED_DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.txt'];
export const MAX_QUESTIONNAIRE_QUESTIONS = 20;
export const GRANTS_GOV_API_URL = 'https://api.grants.gov/v1/api/search2';
export const GRANTS_GOV_MAX_RESULTS = 50;
export const WEB_DISCOVERY_MAX_SEARCHES = 8;
export const WEBSITE_CRAWL_MAX_PAGES = 6;

/**
 * How AI jobs run.
 * - 'direct' (Netlify default): inside a normal request that the website makes
 *   right after starting the job. Works on every Netlify plan (no background
 *   functions needed); each request must finish within Netlify's 60 seconds,
 *   so long steps save their progress and the website continues them.
 * - 'background' (Netlify, GRANTFINDER_BACKGROUND_JOBS=true): a Netlify
 *   background function, up to 15 minutes per step. Needs a Netlify plan that
 *   includes background functions (the current credit-based plans do; legacy
 *   Starter does not, and a deploy containing one fails there).
 * - 'local' (your Mac, tests): in the same server process.
 * GRANTFINDER_JOB_MODE=direct forces direct mode anywhere (used by tests).
 */
export type JobMode = 'direct' | 'background' | 'local';

export function jobMode(): JobMode {
  if ((process.env.GRANTFINDER_JOB_MODE || '').trim().toLowerCase() === 'direct') return 'direct';
  if (!onNetlify()) return 'local';
  return (process.env.GRANTFINDER_BACKGROUND_JOBS || '').trim().toLowerCase() === 'true' ? 'background' : 'direct';
}

/**
 * Netlify stops a normal request at 60 seconds. A direct-mode step stops its
 * Claude calls at this point (from the start of its request) so it can still
 * save what finished and say what didn't. GRANTFINDER_DIRECT_JOB_BUDGET_MS
 * overrides it (tests).
 */
export function directJobBudgetMs(): number {
  const override = Number(process.env.GRANTFINDER_DIRECT_JOB_BUDGET_MS);
  return Number.isFinite(override) && override > 0 ? override : 50_000;
}

/** Background jobs: Netlify stops background functions at 15 minutes. */
export const JOB_MAX_RUNTIME_MS = 15 * 60 * 1000;
/** A queued job nobody picked up within this window is reported as failed. */
export const JOB_START_GRACE_MS = 3 * 60 * 1000;
