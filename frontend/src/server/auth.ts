/**
 * Sign-in sessions, users, saved Claude API keys, and rate limiting.
 *
 * Sessions are signed tokens (HS256 with SECRET_KEY) that last 30 days.
 * Users and encrypted API keys live in the store, so they survive deploys.
 */
import crypto from 'node:crypto';

import { jwtVerify, SignJWT } from 'jose';

import { ACCESS_TOKEN_DAYS, secretKey } from './config';
import { HttpError } from './errors';
import { logger } from './log';
import { keyPart, kv, update } from './store';
import type { User } from './types';

// =============================================================================
// Tokens
// =============================================================================

const encoder = new TextEncoder();

export async function issueToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_DAYS}d`)
    .sign(encoder.encode(secretKey()));
}

/** The user id inside a valid token, or null. */
export async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secretKey()), { algorithms: ['HS256'] });
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

// =============================================================================
// Users
// =============================================================================

const userKey = (userId: string) => `users/${keyPart(userId)}`;
const apiKeyKey = (userId: string) => `apikeys/${keyPart(userId)}`;

export async function getUser(userId: string): Promise<User | null> {
  return kv().get<User>(userKey(userId));
}

export async function saveUser(user: User): Promise<void> {
  await kv().set(userKey(user.id), user);
}

/** Resolve the Authorization header to a user, or throw 401. */
export async function authenticate(req: Request): Promise<User> {
  const header = req.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw new HttpError(401, 'Not authenticated');
  const userId = await verifyToken(match[1].trim());
  if (!userId) throw new HttpError(401, 'Invalid token');
  const user = await getUser(userId);
  if (!user) throw new HttpError(401, 'User not found');
  return { ...user, claude_api_key_set: await hasApiKey(user.id) };
}

// =============================================================================
// Claude API keys (AES-256-GCM, key derived from SECRET_KEY)
// =============================================================================

interface StoredApiKey {
  v: 1;
  iv: string;
  tag: string;
  data: string;
  last4: string;
  set_at: string;
}

function encryptionKey(): Buffer {
  return crypto.createHash('sha256').update(`grantfinder-api-key:${secretKey()}`).digest();
}

export async function saveApiKey(userId: string, apiKey: string): Promise<void> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const record: StoredApiKey = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    last4: apiKey.slice(-4),
    set_at: new Date().toISOString(),
  };
  await kv().set(apiKeyKey(userId), record);
}

export async function hasApiKey(userId: string): Promise<boolean> {
  return (await kv().get<StoredApiKey>(apiKeyKey(userId))) !== null;
}

/** The user's decrypted Claude API key, or null when none is saved or it can't be decrypted. */
export async function getApiKey(userId: string): Promise<string | null> {
  const record = await kv().get<StoredApiKey>(apiKeyKey(userId));
  if (!record) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(record.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    // SECRET_KEY changed since the key was saved.
    logger.warn('api_key_decrypt_failed', { user_id: userId, error: (error as Error).message });
    return null;
  }
}

export async function deleteApiKey(userId: string): Promise<void> {
  await kv().delete(apiKeyKey(userId));
}

/** Same message the Python engine used, so the website shows familiar text. */
export const API_KEY_MISSING = 'Claude API key not set. Please add your API key first.';

export async function requireApiKey(userId: string): Promise<string> {
  const key = await getApiKey(userId);
  if (!key) throw new HttpError(400, API_KEY_MISSING);
  return key;
}

// =============================================================================
// Rate limiting (fixed window per IP and bucket, shared across instances)
// =============================================================================

interface Window {
  start: number;
  count: number;
}

/** Throws 429 when this IP has used up `limit` calls in the current window. */
export async function rateLimit(bucket: string, ip: string, limit: number, windowSeconds: number): Promise<void> {
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 20);
  const key = `ratelimit/${keyPart(bucket)}/${ipHash}`;
  const now = Date.now();
  let blocked = false;
  try {
    await update<Window>(key, (current) => {
      if (!current || now - current.start >= windowSeconds * 1000) return { start: now, count: 1 };
      if (current.count >= limit) {
        blocked = true;
        return undefined;
      }
      return { start: current.start, count: current.count + 1 };
    });
  } catch (error) {
    // Never lock people out because the limiter itself failed.
    logger.warn('rate_limit_store_failed', { bucket, error: (error as Error).message });
    return;
  }
  if (blocked) {
    logger.warn('rate_limited', { bucket });
    throw new HttpError(429, 'Too many requests. Please wait a few minutes and try again.');
  }
}
