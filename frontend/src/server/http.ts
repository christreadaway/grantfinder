/**
 * Request/response helpers shared by every API route.
 */
import crypto from 'node:crypto';

import { HttpError } from './errors';
import type { User } from './types';

export interface RequestContext {
  req: Request;
  method: string;
  /** Path without query string or trailing slash, e.g. /api/grants */
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  /** Visitor IP (Netlify's x-nf-client-connection-ip, else x-forwarded-for). */
  ip: string;
  /** Public origin of this site, e.g. https://grantfinder.netlify.app */
  origin: string;
  requestId: string;
  /** Parsed JSON body; {} when empty. Throws 422 on malformed JSON. */
  json<T = Record<string, unknown>>(): Promise<T>;
  formData(): Promise<FormData>;
  /** The signed-in user; throws 401 when the token is missing or invalid. */
  user(): Promise<User>;
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data ?? null), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(status: number, detail: string, requestId?: string): Response {
  return jsonResponse({ detail }, status, requestId ? { 'x-request-id': requestId } : {});
}

/** A file download (CSV, Markdown, Word...). */
export function fileResponse(body: Uint8Array | ArrayBuffer | string, filename: string, contentType: string): Response {
  const safeName = filename.replace(/[^A-Za-z0-9_.-]/g, '_');
  const payload = typeof body === 'string' ? body : body instanceof ArrayBuffer ? body : new Uint8Array(body);
  return new Response(payload as BodyInit, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${safeName}"`,
      'cache-control': 'no-store',
    },
  });
}

export function clientIp(req: Request): string {
  const netlify = req.headers.get('x-nf-client-connection-ip');
  if (netlify) return netlify.trim();
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

export function publicOrigin(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000';
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    return `${proto}://${host}`;
  }
}

export function newRequestId(): string {
  return `req_${crypto.randomBytes(6).toString('hex')}`;
}

/** Read a required string field from a JSON body. */
export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(422, `Field "${field}" is required.`);
  }
  return value;
}

export function optionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(422, `Field "${field}" must be text.`);
  return value;
}
