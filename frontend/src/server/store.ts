/**
 * Persistent key-value storage for everything the engine keeps: users,
 * saved API keys, grants, profiles, match results, applications, jobs.
 *
 *   - On Netlify: Netlify Blobs (store "grantfinder", strong consistency).
 *     Data survives deploys and restarts.
 *   - Locally: one JSON file per key under frontend/.data/ (git-ignored).
 *
 * Keys look like "profiles/user_123". Values are JSON.
 * update() gives safe read-modify-write: two background jobs touching the
 * same record retry instead of overwriting each other.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getStore, type Store as BlobStore } from '@netlify/blobs';

import { dataDir, storeKind, type StoreKind } from './config';
import { ConfigError } from './errors';
import { logger } from './log';

export interface Versioned<T> {
  value: T | null;
  etag: string | null;
}

export interface KV {
  readonly kind: StoreKind;
  get<T>(key: string): Promise<T | null>;
  getVersioned<T>(key: string): Promise<Versioned<T>>;
  set(key: string, value: unknown): Promise<void>;
  /** Write only if the key still has this etag (null = only if the key doesn't exist yet). */
  setIf(key: string, value: unknown, etag: string | null): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Keys starting with prefix, sorted ascending. */
  list(prefix: string): Promise<string[]>;
}

const KEY_RE = /^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.@-]+)*$/;

export function assertKey(key: string): void {
  if (!KEY_RE.test(key) || key.length > 500 || key.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  }
}

/** Make an arbitrary id safe to use as one key segment. */
export function keyPart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 200);
  if (!cleaned || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

// =============================================================================
// Netlify Blobs
// =============================================================================

/**
 * The fetch the Blobs client uses: it reads each response completely before
 * handing it over. Inside Netlify's function runtime, cancelling an unread
 * response body (which the Blobs client does on every 404, i.e. every lookup
 * of a key that doesn't exist yet) never settles, so without this the first
 * sign-in on a fresh site would hang until the function timed out.
 * Next.js's patched fetch is bypassed too: storage calls must never be cached.
 */
const blobsFetch: typeof fetch = async (input, init) => {
  const base = (globalThis.fetch as typeof fetch & { _nextOriginalFetch?: typeof fetch })._nextOriginalFetch ?? globalThis.fetch;
  const response = await base(input, init);
  const bodyless = [204, 205, 304].includes(response.status) || String(init?.method || '').toUpperCase() === 'HEAD';
  const body = bodyless ? null : await response.arrayBuffer();
  return new Response(body && body.byteLength ? body : null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

class BlobsKV implements KV {
  readonly kind = 'blobs' as const;
  private store: BlobStore;

  constructor() {
    try {
      this.store = getStore({ name: 'grantfinder', consistency: 'strong', fetch: blobsFetch });
    } catch (error) {
      throw new ConfigError(
        `Netlify Blobs is not available to this function (${(error as Error).message}). ` +
          'Redeploy the site; if it persists, check that the site was deployed by Netlify from Git.',
      );
    }
  }

  async get<T>(key: string): Promise<T | null> {
    assertKey(key);
    const value = await this.store.get(key, { type: 'json' });
    return (value ?? null) as T | null;
  }

  async getVersioned<T>(key: string): Promise<Versioned<T>> {
    assertKey(key);
    const first = await this.store.getWithMetadata(key, { type: 'json' });
    if (!first) return { value: null, etag: null };
    if (first.etag) return { value: (first.data ?? null) as T | null, etag: first.etag };
    // Some Blobs servers (Netlify's local sandbox) send no ETag on reads, but
    // listings carry one. List BEFORE re-reading, so the tag is never newer
    // than the value: if the record changes in between, the conditional
    // write simply fails and update() retries.
    const { blobs } = await this.store.list({ prefix: key });
    const etag = blobs.find((blob) => blob.key === key)?.etag ?? null;
    const second = await this.store.getWithMetadata(key, { type: 'json' });
    if (!second) return { value: null, etag: null };
    return { value: (second.data ?? null) as T | null, etag: second.etag ?? etag };
  }

  async set(key: string, value: unknown): Promise<void> {
    assertKey(key);
    await this.store.setJSON(key, value);
  }

  async setIf(key: string, value: unknown, etag: string | null): Promise<boolean> {
    assertKey(key);
    const result = etag
      ? await this.store.setJSON(key, value, { onlyIfMatch: etag })
      : await this.store.setJSON(key, value, { onlyIfNew: true });
    return result.modified;
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.store.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const { blobs } = await this.store.list({ prefix });
    return blobs.map((blob) => blob.key).sort();
  }
}

// =============================================================================
// Local JSON files
// =============================================================================

/**
 * Synchronous file I/O inside async methods is deliberate: each read-compare-
 * write runs without yielding, so compare-and-set is atomic within the single
 * Node process that `next dev` / `next start` uses.
 */
class FileKV implements KV {
  readonly kind = 'fs' as const;
  private root: string;

  constructor(root: string) {
    this.root = path.join(root, 'store');
    fs.mkdirSync(this.root, { recursive: true });
  }

  private file(key: string): string {
    assertKey(key);
    return path.join(this.root, ...key.split('/')) + '.json';
  }

  private readRaw(key: string): string | null {
    try {
      return fs.readFileSync(this.file(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private static etagOf(rawText: string): string {
    return crypto.createHash('sha1').update(rawText).digest('hex');
  }

  private writeRaw(key: string, value: unknown): void {
    const target = this.file(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value));
    fs.renameSync(temp, target);
  }

  async get<T>(key: string): Promise<T | null> {
    const text = this.readRaw(key);
    return text === null ? null : (JSON.parse(text) as T);
  }

  async getVersioned<T>(key: string): Promise<Versioned<T>> {
    const text = this.readRaw(key);
    if (text === null) return { value: null, etag: null };
    return { value: JSON.parse(text) as T, etag: FileKV.etagOf(text) };
  }

  async set(key: string, value: unknown): Promise<void> {
    this.writeRaw(key, value);
  }

  async setIf(key: string, value: unknown, etag: string | null): Promise<boolean> {
    const text = this.readRaw(key);
    const current = text === null ? null : FileKV.etagOf(text);
    if (current !== etag) return false;
    this.writeRaw(key, value);
    return true;
  }

  async delete(key: string): Promise<void> {
    try {
      fs.unlinkSync(this.file(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    const walk = (dir: string, keyPrefix: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), `${keyPrefix}${entry.name}/`);
        } else if (entry.name.endsWith('.json')) {
          const key = `${keyPrefix}${entry.name.slice(0, -5)}`;
          if (key.startsWith(prefix)) keys.push(key);
        }
      }
    };
    // Start from the deepest directory the prefix fully names.
    const slash = prefix.lastIndexOf('/');
    const dirPart = slash >= 0 ? prefix.slice(0, slash + 1) : '';
    walk(path.join(this.root, ...dirPart.split('/').filter(Boolean)), dirPart);
    return keys.sort();
  }
}

// =============================================================================
// Access
// =============================================================================

let fileKV: FileKV | null = null;

/**
 * The store for this runtime. Blobs stores are created per call because
 * Netlify provides their credentials per invocation.
 */
export function kv(): KV {
  if (storeKind() === 'blobs') return new BlobsKV();
  if (!fileKV) fileKV = new FileKV(dataDir());
  return fileKV;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Safe read-modify-write. `fn` receives the current value (or null) and
 * returns the new value; return undefined to leave the record untouched.
 * Retries when another writer got there first.
 */
export async function update<T>(
  key: string,
  fn: (current: T | null) => T | undefined | Promise<T | undefined>,
  attempts = 12,
): Promise<T | null> {
  const store = kv();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { value, etag } = await store.getVersioned<T>(key);
    const draft = value === null ? null : (structuredClone(value) as T);
    const next = await fn(draft);
    if (next === undefined) return value;
    if (value !== null && etag === null) {
      // Storage returned no version tag; fall back to a plain write.
      await store.set(key, next);
      return next;
    }
    if (await store.setIf(key, next, etag)) return next;
    logger.debug('store_update_conflict', { key, attempt });
    await sleep(25 * attempt + Math.floor(Math.random() * 50));
  }
  throw new Error(`Could not save ${key}: too many simultaneous changes. Please try again.`);
}

/** Time-sortable unique id, e.g. 20261014T231502Z_ab12cd34. */
export function sortableId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Fetch many keys with limited parallelism, skipping missing ones. */
export async function getMany<T>(keys: string[], concurrency = 8): Promise<T[]> {
  const store = kv();
  const results: Array<T | null> = new Array(keys.length).fill(null);
  let index = 0;
  const worker = async () => {
    while (index < keys.length) {
      const mine = index++;
      try {
        results[mine] = await store.get<T>(keys[mine]);
      } catch (error) {
        logger.warn('store_get_failed', { key: keys[mine], error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, worker));
  return results.filter((item): item is NonNullable<typeof item> => item !== null) as T[];
}
