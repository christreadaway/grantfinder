/**
 * The one way the engine talks to Claude.
 *
 * - Model from CLAUDE_MODEL (default claude-sonnet-5). Never hardcoded.
 * - Streams each request (long drafts never hit HTTP timeouts) and returns the
 *   finished message. Text is joined from text blocks only: newer models put
 *   a thinking block first, which broke the old Python `content[0].text`.
 * - Continues server-tool turns that pause (web search `pause_turn`).
 * - Logs every call: stage, prompt id, tokens, latency, cost, correlation id.
 * - Translates API failures into ClaudeError with a plain-English fix.
 *   Fatal ones (bad key, no credits, unknown model) must never be hidden
 *   behind fallback results.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, MessageParam, ToolUnion } from '@anthropic-ai/sdk/resources/messages';

import { anthropicBaseUrl, claudeModel, testMode } from './config';
import { ClaudeError } from './errors';
import { logger } from './log';
import type { AICallLog } from './types';

/** $ per million tokens (input, output). Unknown models are estimated at Sonnet 4.6 rates. */
const PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
};
const WEB_SEARCH_USD_EACH = 0.01;

export function priceFor(model: string): [number, number] {
  if (PRICES[model]) return PRICES[model];
  const base = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find((name) => model.startsWith(name));
  return base ? PRICES[base] : [3, 15];
}

/** Dynamic-filtering web search on models that support it, the basic tool elsewhere. */
export function webSearchTool(model: string, maxUses: number): ToolUnion {
  const modern = /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5))/.test(model);
  return (modern
    ? { type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }
    : { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }) as ToolUnion;
}

export interface ClaudeCallOptions {
  /** Pipeline stage for logs: scan | questionnaire | documents | match | discovery | extract | map | route | draft | score | refine | enforce */
  stage: string;
  /** Versioned prompt name, e.g. grant_spec_v1. The test mock keys its canned answers on it. */
  promptId: string;
  prompt: string;
  /** Room for the visible answer. Thinking headroom is added on top automatically. */
  maxTokens?: number;
  system?: string;
  tools?: ToolUnion[];
  /** How many times to continue a paused server-tool turn (default 5). */
  maxContinuations?: number;
}

export interface ClaudeCallResult {
  text: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  latencyMs: number;
  costUsd: number;
  model: string;
  content: ContentBlock[];
}

export interface ClaudeContext {
  apiKey: string;
  correlationId: string;
  applicationId?: string | null;
  jobId?: string | null;
  /** Receives one log entry per call (the job runner stores them on the job). */
  onCall?: (entry: AICallLog) => void;
  /**
   * Aborts calls still running when the job nears Netlify's 15-minute limit.
   * (The SDK timeout only covers waiting for the first response bytes, not a
   * slow stream.)
   */
  signal?: AbortSignal;
}

function apiMessage(error: InstanceType<typeof Anthropic.APIError>): string {
  const body = error.error as { error?: { message?: string; type?: string } } | undefined;
  return body?.error?.message || error.message || 'unknown error';
}

function apiErrorType(error: InstanceType<typeof Anthropic.APIError>): string {
  const body = error.error as { error?: { type?: string } } | undefined;
  return body?.error?.type || '';
}

function apiErrorCode(error: InstanceType<typeof Anthropic.APIError>): string {
  const body = error.error as { error?: { details?: { error_code?: string } } } | undefined;
  return body?.error?.details?.error_code || '';
}

/** Remove anything that looks like an API key (some client errors quote the header). */
const redact = (text: string) => text.replace(/sk-ant-[^\s"',)]+/g, 'sk-ant-[redacted]');

export function translateClaudeError(error: unknown, model: string): ClaudeError {
  const translated = translateClaudeErrorRaw(error, model);
  const detail = redact(translated.detail);
  return detail === translated.detail ? translated : new ClaudeError(translated.kind, translated.status, detail, translated.fatal);
}

function translateClaudeErrorRaw(error: unknown, model: string): ClaudeError {
  if (error instanceof ClaudeError) return error;
  if (error instanceof Anthropic.APIUserAbortError) {
    return new ClaudeError(
      'timeout',
      504,
      'Claude was still working when this step reached its time limit. Run it again; work that finished was saved.',
      false,
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new ClaudeError(
      'auth',
      400,
      'Anthropic rejected your Claude API key (authentication failed). Open Settings and paste a valid key; it starts with sk-ant-.',
      true,
    );
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ClaudeError(
      'permission',
      400,
      `Your Claude API key is not allowed to use this (model ${model}): ${apiMessage(error)}`,
      true,
    );
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ClaudeError(
      'model',
      400,
      `Claude model "${model}" is not available to your API key. Set CLAUDE_MODEL in Netlify to a model your account can use (for example claude-sonnet-5), then redeploy.`,
      true,
    );
  }
  if (error instanceof Anthropic.BadRequestError) {
    const message = apiMessage(error);
    if (/specified (workspace )?API usage limits/i.test(message)) {
      return new ClaudeError(
        'billing',
        400,
        `Your Anthropic account hit a spending limit that was set on it (${message}). Raise it at platform.claude.com/settings/billing, then try again.`,
        true,
      );
    }
    if (/credit balance|billing|purchase credits/i.test(message)) {
      return new ClaudeError(
        'billing',
        400,
        'Your Anthropic account is out of API credits. Add credits at console.anthropic.com (Billing), then try again.',
        true,
      );
    }
    return new ClaudeError('bad_request', 400, `Claude rejected the request: ${message}`, true);
  }
  if (error instanceof Anthropic.RateLimitError) {
    if (apiErrorCode(error) === 'enforced_spend_limit_reached') {
      // Monthly spend cap: retrying can't help until the cap is raised or the month turns.
      return new ClaudeError(
        'billing',
        400,
        `Your Anthropic account reached its monthly API spending cap (${apiMessage(error)}). Raise it at platform.claude.com/settings/billing, then try again.`,
        true,
      );
    }
    return new ClaudeError('rate_limit', 429, 'Claude rate limit reached for your API key. Wait a minute and try again.', false);
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ClaudeError('timeout', 504, 'Claude took too long to answer. Please try again.', false);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ClaudeError('connection', 502, "Couldn't reach Claude (network problem). Try again in a minute.", false);
  }
  if (error instanceof Anthropic.APIError) {
    const type = apiErrorType(error);
    if (error.status === 529 || type === 'overloaded_error') {
      return new ClaudeError('overloaded', 503, 'Claude is overloaded right now. Wait a minute and try again.', false);
    }
    if (error.status === 413 || type === 'request_too_large') {
      return new ClaudeError('bad_request', 400, 'The material sent to Claude was too large. Try a shorter document or fewer pages.', true);
    }
    if (type === 'rate_limit_error') {
      return new ClaudeError('rate_limit', 429, 'Claude rate limit reached for your API key. Wait a minute and try again.', false);
    }
    return new ClaudeError('unknown', 502, `Claude returned an error: ${apiMessage(error)}`, false);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/Streaming is required/i.test(message)) {
    return new ClaudeError('bad_request', 500, `Claude request misconfigured: ${message}`, true);
  }
  return new ClaudeError('unknown', 502, `Claude call failed: ${message}`, false);
}

export class Claude {
  readonly model: string;
  private client: Anthropic;
  private ctx: ClaudeContext;

  constructor(ctx: ClaudeContext) {
    this.ctx = ctx;
    this.model = claudeModel();
    this.client = new Anthropic({
      apiKey: ctx.apiKey,
      baseURL: anthropicBaseUrl(),
      maxRetries: 2,
      timeout: 10 * 60 * 1000,
    });
  }

  webSearchTool(maxUses: number): ToolUnion {
    return webSearchTool(this.model, maxUses);
  }

  async call(options: ClaudeCallOptions): Promise<ClaudeCallResult> {
    const started = Date.now();
    const messages: MessageParam[] = [{ role: 'user', content: options.prompt }];
    const content: ContentBlock[] = [];
    // Adaptive thinking shares max_tokens with the answer. Streaming means a
    // high ceiling costs nothing (only generated tokens are billed, and
    // max_tokens doesn't count toward rate limits), so leave generous room.
    const maxTokens = Math.min(64000, Math.max(options.maxTokens ?? 4000, 1000) + 32000);
    const maxContinuations = options.maxContinuations ?? 5;
    let inputTokens = 0;
    let outputTokens = 0;
    let webSearches = 0;
    let stopReason: string | null = null;
    let failure: ClaudeError | null = null;

    try {
      for (let turn = 0; turn <= maxContinuations; turn++) {
        const stream = this.client.messages.stream(
          {
            model: this.model,
            max_tokens: maxTokens,
            messages,
            ...(options.system ? { system: options.system } : {}),
            ...(options.tools?.length ? { tools: options.tools } : {}),
          },
          {
            ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
            ...(testMode() ? { headers: { 'x-grantfinder-prompt-id': options.promptId } } : {}),
          },
        );
        const message = await stream.finalMessage();
        inputTokens += message.usage?.input_tokens ?? 0;
        outputTokens += message.usage?.output_tokens ?? 0;
        webSearches += message.usage?.server_tool_use?.web_search_requests ?? 0;
        content.push(...message.content);
        stopReason = message.stop_reason ?? null;
        if (stopReason === 'pause_turn' && turn < maxContinuations) {
          messages.push({ role: 'assistant', content: message.content as unknown as MessageParam['content'] });
          continue;
        }
        break;
      }
    } catch (error) {
      failure = translateClaudeError(error, this.model);
    }

    const latencyMs = Date.now() - started;
    const [inPrice, outPrice] = priceFor(this.model);
    const costUsd = Number(((inputTokens * inPrice + outputTokens * outPrice) / 1_000_000 + webSearches * WEB_SEARCH_USD_EACH).toFixed(6));
    const entry: AICallLog = {
      correlation_id: this.ctx.correlationId,
      application_id: this.ctx.applicationId ?? null,
      job_id: this.ctx.jobId ?? null,
      stage: options.stage,
      prompt_id: options.promptId,
      model: this.model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      web_searches: webSearches,
      latency_ms: latencyMs,
      cost_estimate_usd: costUsd,
      status: failure ? 'error' : 'ok',
      stop_reason: stopReason,
      error: failure ? failure.detail.slice(0, 500) : null,
      timestamp: new Date().toISOString(),
    };
    logger[failure ? 'error' : 'info']('ai_call', { ...entry, error_kind: failure?.kind });
    if (!failure && (stopReason === 'max_tokens' || stopReason === 'refusal')) {
      logger.warn('ai_call_incomplete', { prompt_id: options.promptId, stop_reason: stopReason, correlation_id: this.ctx.correlationId });
    }
    try {
      this.ctx.onCall?.(entry);
    } catch {
      // Logging must never break a call.
    }
    if (failure) throw failure;

    const text = content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return { text, stopReason, inputTokens, outputTokens, webSearches, latencyMs, costUsd, model: this.model, content };
  }
}

/**
 * Cheap check that a key works (lists one model; costs nothing).
 * 'invalid' = Anthropic said no; 'unverified' = couldn't check (network), save anyway.
 */
export async function verifyApiKey(apiKey: string): Promise<{ result: 'ok' | 'invalid' | 'unverified'; detail?: string }> {
  const client = new Anthropic({ apiKey, baseURL: anthropicBaseUrl(), maxRetries: 0, timeout: 15000 });
  try {
    await client.models.list({ limit: 1 });
    return { result: 'ok' };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { result: 'invalid', detail: 'Anthropic rejected this API key. Check that you copied the whole key (it starts with sk-ant-).' };
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return { result: 'invalid', detail: 'Anthropic says this API key is not allowed to make requests. Check the key in the Anthropic Console.' };
    }
    const message = redact((error as Error).message || String(error));
    logger.warn('api_key_verify_unavailable', { error: message });
    return { result: 'unverified', detail: message };
  }
}
