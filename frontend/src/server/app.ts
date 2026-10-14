/**
 * The GrantFinder engine's front door: every /api/* request lands here
 * (via src/app/api/[...path]/route.ts), gets routed, and errors become
 * {"detail": "..."} responses with a request id.
 */
import { authenticate } from './auth';
import { HttpError, toHttpError } from './errors';
import { clientIp, errorResponse, jsonResponse, newRequestId, publicOrigin, type RequestContext } from './http';
import { logger } from './log';
import { Router } from './router';
import { registerAuthRoutes } from './routes/auth';
import { registerDiscoveryRoutes } from './routes/discovery';
import { registerExportRoutes } from './routes/export';
import { registerGrantRoutes } from './routes/grants';
import { registerProcessingRoutes } from './routes/processing';
import { registerProfileRoutes } from './routes/profile';
import { registerSystemRoutes } from './routes/system';
import { registerWriterRoutes } from './routes/writer';
import type { User } from './types';

let router: Router | null = null;

export function getRouter(): Router {
  if (router) return router;
  const r = new Router();
  registerSystemRoutes(r);
  registerAuthRoutes(r);
  registerGrantRoutes(r);
  registerDiscoveryRoutes(r);
  registerProcessingRoutes(r);
  registerProfileRoutes(r);
  registerExportRoutes(r);
  registerWriterRoutes(r);
  router = r;
  return r;
}

/** Quiet paths: the website polls jobs every couple of seconds. */
const QUIET = [/^\/api\/jobs\/[^/]+$/, /^\/api\/health$/];

export async function handleRequest(req: Request): Promise<Response> {
  const requestId = newRequestId();
  const started = Date.now();
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let userId: string | undefined;
  let userPromise: Promise<User> | null = null;
  let bodyPromise: Promise<string> | null = null;

  const ctx: RequestContext = {
    req,
    method: req.method.toUpperCase(),
    path,
    params: {},
    query: url.searchParams,
    ip: clientIp(req),
    origin: publicOrigin(req),
    requestId,
    json: async <T>() => {
      bodyPromise ??= req.text();
      const text = (await bodyPromise).trim();
      if (!text) return {} as T;
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new HttpError(422, 'Request body must be a JSON object.');
        }
        return parsed as T;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(422, 'Request body is not valid JSON.');
      }
    },
    formData: async () => {
      try {
        return await req.formData();
      } catch {
        throw new HttpError(422, 'Expected a file upload (multipart form data).');
      }
    },
    user: () => {
      userPromise ??= authenticate(req).then((user) => {
        userId = user.id;
        return user;
      });
      return userPromise;
    },
  };

  let response: Response;
  try {
    const match = getRouter().match(ctx.method, path);
    if (match.kind === 'not_found') {
      response = errorResponse(404, 'Not Found', requestId);
    } else if (match.kind === 'method_not_allowed') {
      response = new Response(JSON.stringify({ detail: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'content-type': 'application/json', allow: match.allowed.join(', ') },
      });
    } else {
      ctx.params = match.params;
      const result = await match.handler(ctx);
      response = result instanceof Response ? result : jsonResponse(result);
    }
  } catch (error) {
    const { status, detail } = toHttpError(error, requestId);
    if (status >= 500) {
      logger.error('request_failed', { request_id: requestId, method: ctx.method, path, user_id: userId, status, detail, error });
    } else {
      logger.info('request_rejected', { request_id: requestId, method: ctx.method, path, user_id: userId, status, detail });
    }
    response = errorResponse(status, detail, requestId, error instanceof HttpError ? error.extra : undefined);
  }

  const fields = { request_id: requestId, method: ctx.method, path, status: response.status, ms: Date.now() - started, user_id: userId };
  if (QUIET.some((pattern) => pattern.test(path)) && response.status < 400) logger.debug('request', fields);
  else logger.info('request', fields);
  response.headers.set('x-request-id', requestId);
  return response;
}
