/**
 * Tiny path router: "/api/writer/applications/:appId/draft" style patterns.
 */
import type { RequestContext } from './http';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

interface Route {
  method: Method;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

export type RouteMatch =
  | { kind: 'found'; handler: Handler; params: Record<string, string>; pattern: string }
  | { kind: 'method_not_allowed'; allowed: Method[] }
  | { kind: 'not_found' };

export class Router {
  private routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const source = pattern
      .replace(/\/+$/, '')
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  get(pattern: string, handler: Handler) {
    return this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler) {
    return this.add('POST', pattern, handler);
  }
  put(pattern: string, handler: Handler) {
    return this.add('PUT', pattern, handler);
  }
  delete(pattern: string, handler: Handler) {
    return this.add('DELETE', pattern, handler);
  }
  patch(pattern: string, handler: Handler) {
    return this.add('PATCH', pattern, handler);
  }

  /** Exact (static) routes win over parameter routes, so /api/grants/stats beats /api/grants/:grantId. */
  match(method: string, path: string): RouteMatch {
    const candidates = this.routes
      .map((route) => ({ route, found: route.regex.exec(path) }))
      .filter((item): item is { route: Route; found: RegExpExecArray } => item.found !== null)
      .sort((a, b) => a.route.keys.length - b.route.keys.length);
    if (candidates.length === 0) return { kind: 'not_found' };
    const hit = candidates.find((item) => item.route.method === method);
    if (!hit) {
      return { kind: 'method_not_allowed', allowed: Array.from(new Set(candidates.map((item) => item.route.method))) };
    }
    const params: Record<string, string> = {};
    hit.route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(hit.found[index + 1]);
    });
    return { kind: 'found', handler: hit.route.handler, params, pattern: hit.route.pattern };
  }

  list(): Array<{ method: Method; pattern: string }> {
    return this.routes.map(({ method, pattern }) => ({ method, pattern }));
  }
}
