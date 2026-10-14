/**
 * Error types the engine turns into HTTP responses.
 *
 * Every error the website sees has the FastAPI shape {"detail": "..."} so the
 * existing screens (which read error.response.data.detail) keep working.
 */

/** An expected failure with a status code and a plain-English message for the user. */
export class HttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** The deployment is missing a setting (for example SECRET_KEY). Shown to the user verbatim. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * A failed Claude call, already translated into something a person can act on.
 *
 * `fatal` errors (bad key, no credits, unknown model, malformed request) will
 * fail the same way on every call, so services must NOT swallow them into
 * fallback results: they propagate and fail the whole job with this message.
 * Non-fatal errors (rate limit, overload, timeout, network) may fall back.
 */
export type ClaudeErrorKind =
  | 'auth'
  | 'permission'
  | 'model'
  | 'billing'
  | 'bad_request'
  | 'rate_limit'
  | 'overloaded'
  | 'timeout'
  | 'connection'
  | 'unknown';

export class ClaudeError extends Error {
  readonly kind: ClaudeErrorKind;
  /** HTTP status to report to the website. Never 401: that would sign the user out. */
  readonly status: number;
  readonly detail: string;
  readonly fatal: boolean;

  constructor(kind: ClaudeErrorKind, status: number, detail: string, fatal: boolean) {
    super(detail);
    this.name = 'ClaudeError';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    this.fatal = fatal;
  }
}

export function isFatalClaudeError(error: unknown): boolean {
  return error instanceof ClaudeError && error.fatal;
}

/** Normalize anything thrown into {status, detail} for a response or a failed job. */
export function toHttpError(error: unknown, requestId?: string): { status: number; detail: string } {
  if (error instanceof HttpError) return { status: error.status, detail: error.detail };
  if (error instanceof ClaudeError) return { status: error.status, detail: error.detail };
  if (error instanceof ConfigError) return { status: 500, detail: `Server setup problem: ${error.message}` };
  const ref = requestId ? ` (reference ${requestId})` : '';
  return { status: 500, detail: `Something went wrong on the server${ref}. The details are in the logs.` };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
