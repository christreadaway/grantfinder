/**
 * Background jobs for grant discovery: Grants.gov search and AI web discovery.
 * Port of the long-running parts of backend/routers/discovery.py.
 *
 * Each handler returns exactly the DiscoveryResult JSON the Python endpoint
 * returned; the website polls the job and uses `result` as the response.
 * The routes in routes/discovery.ts check sign-in, the API key and the request
 * body before a job is created.
 *
 * Must not import exceljs or docx (keeps the background function small).
 */
import type { Claude, ClaudeCallResult } from '../claude';
import { WEB_DISCOVERY_MAX_SEARCHES } from '../config';
import { ClaudeError, HttpError } from '../errors';
import type { JobContext, JobHandler } from '../jobs';
import { logger } from '../log';
import { getProfile } from '../repo';
import {
  buildWebDiscoveryPrompt,
  discoveryResult,
  grantsFromWebEntries,
  mergeIntoDatabase,
  parseWebDiscoveryAnswer,
  searchGrantsGov,
  WEB_DISCOVERY_DIRECT,
  WEB_DISCOVERY_PROMPT_ID,
  type GrantsGovTiming,
} from '../services/discovery';
import type { DiscoveryResult } from '../types';

/** A Claude call stopped by this step's own time limit (direct mode: about a minute per step). */
function stoppedByTimeLimit(ctx: JobContext, error: unknown): boolean {
  return ctx.mode === 'direct' && error instanceof ClaudeError && error.kind === 'timeout' && ctx.timeLeftMs() < 1_000;
}

// =============================================================================
// discovery.grants_gov
// =============================================================================

export interface GrantsGovJobInput {
  keywords: string[];
  max_results: number | null;
}

/** Direct mode: when nothing could be searched before the step's minute ran out. */
export const GRANTS_GOV_OUT_OF_TIME =
  'Grants.gov search ran out of time before it could search (each step on this site can run for about a minute). Try again in a moment.';

/**
 * Direct mode: up to 4 keyword searches at once, each allowed 10 seconds,
 * all finished a few seconds before the step's cutoff so the grants can be
 * saved. Shorter budgets (tests) scale down the same way.
 */
function directGrantsGovTiming(ctx: JobContext): GrantsGovTiming {
  const saveRoom = Math.min(3_000, Math.round(ctx.timeLeftMs() * 0.2));
  return { endBy: ctx.deadline - saveRoom, requestTimeoutMs: 10_000, concurrency: 4 };
}

async function runGrantsGov(ctx: JobContext): Promise<DiscoveryResult> {
  const input = (ctx.input ?? {}) as Partial<GrantsGovJobInput>;
  const keywords = Array.isArray(input.keywords) ? input.keywords.filter((k): k is string => typeof k === 'string' && k.trim() !== '') : [];
  const maxResults = typeof input.max_results === 'number' ? input.max_results : null;
  ctx.note(`Grants.gov keywords: ${keywords.join(' | ')}`);
  const timing = ctx.mode === 'direct' ? directGrantsGovTiming(ctx) : {};
  if (ctx.mode === 'direct') ctx.note('Runs inside one request (about a minute): up to 4 searches at once, 10 seconds each at most');

  const search = await searchGrantsGov(ctx.userId, keywords, maxResults, (message) => ctx.progress(message), timing);
  search.notes.forEach((note) => ctx.note(`Grants.gov ${note}`));

  if (search.searched === 0 && search.skipped > 0) {
    logger.error('grants_gov_out_of_time', { user_id: ctx.userId, skipped: search.skipped });
    throw new HttpError(504, GRANTS_GOV_OUT_OF_TIME);
  }
  if (search.searched > 0 && search.failures.length === search.searched) {
    logger.error('grants_gov_unreachable', { user_id: ctx.userId, searches: search.searched, first_error: search.failures[0] });
    throw new HttpError(502, `Grants.gov didn't answer; try again later. (${search.failures[0]})`);
  }

  await ctx.progress(`Saving ${search.grants.length} federal opportunities...`);
  const merge = await mergeIntoDatabase(ctx.userId, search.grants);
  logger.info('grants_gov_discovery_merged', { user_id: ctx.userId, found: search.grants.length, ...merge });
  return discoveryResult('grants_gov', search.grants.length, merge, search.notes);
}

// =============================================================================
// discovery.web_search
// =============================================================================

export interface WebSearchJobInput {
  focus: string | null;
}

type Tool = ReturnType<Claude['webSearchTool']>;
const BASIC_WEB_SEARCH_TYPE = 'web_search_20250305';

function toolType(tool: Tool): string {
  return (tool as { type?: string }).type ?? '';
}

function basicWebSearchTool(maxUses: number): Tool {
  return { type: BASIC_WEB_SEARCH_TYPE, name: 'web_search', max_uses: maxUses } as Tool;
}

/** Web searches Claude ran: the usage counter, or the search blocks if usage is missing. */
function countSearches(response: ClaudeCallResult): number {
  // Dynamic-filtering web search also emits code-execution tool blocks; only count searches.
  const blocks = response.content.filter(
    (block) => block.type === 'server_tool_use' && (block as { name?: string }).name === 'web_search',
  ).length;
  return Math.max(response.webSearches, blocks);
}

/** Direct mode: the web search was still running when the step's minute ended, and no grants had been listed. */
export const WEB_DISCOVERY_OUT_OF_TIME =
  'AI web discovery needs more time than this site allows for one step (about a minute), so it stopped before Claude listed any grants. ' +
  'Try again, perhaps with a narrower focus (for example, "security cameras"); the starter database and Grants.gov search are quicker ways to add grants.';

async function runWebSearch(ctx: JobContext): Promise<DiscoveryResult> {
  const input = (ctx.input ?? {}) as Partial<WebSearchJobInput>;
  const focus = typeof input.focus === 'string' && input.focus.trim() ? input.focus.trim() : null;
  const profile = await getProfile(ctx.userId);
  const direct = ctx.mode === 'direct';
  const budget = ctx.timeLeftMs();
  const maxSearches = direct ? WEB_DISCOVERY_DIRECT.maxSearches : WEB_DISCOVERY_MAX_SEARCHES;
  const prompt = buildWebDiscoveryPrompt(profile, focus, direct ? WEB_DISCOVERY_DIRECT.aim : undefined);
  ctx.note(`Web discovery for ${profile ? 'the saved profile' : 'a generic Catholic parish/school (no profile yet)'}${focus ? `, focus: ${focus}` : ''}`);
  if (direct) {
    ctx.note(
      `Runs inside one request (about a minute): at most ${maxSearches} web searches and ${WEB_DISCOVERY_DIRECT.maxContinuations} continuation; asks for ${WEB_DISCOVERY_DIRECT.aim} grants`,
    );
  }

  const ai = await ctx.claude();
  const notes: string[] = [];
  const primaryTool = ai.webSearchTool(maxSearches);
  const request = {
    stage: 'discovery',
    promptId: WEB_DISCOVERY_PROMPT_ID,
    prompt,
    maxTokens: 8000,
    ...(direct ? { maxContinuations: WEB_DISCOVERY_DIRECT.maxContinuations } : {}),
  };
  /** The plain direct-mode message when the step's own time limit stopped Claude; other errors unchanged. */
  const outOfTime = (error: unknown): unknown => {
    if (!stoppedByTimeLimit(ctx, error)) return error;
    logger.warn('web_discovery_out_of_time', { user_id: ctx.userId });
    return new HttpError(504, WEB_DISCOVERY_OUT_OF_TIME);
  };

  await ctx.progress(
    direct
      ? 'Claude is searching the web for grants that fit your profile (up to about a minute)...'
      : 'Claude is searching the web for grants that fit your profile (usually 1-3 minutes)...',
  );
  let response: ClaudeCallResult;
  try {
    response = await ai.call({ ...request, tools: [primaryTool] });
  } catch (error) {
    // Like the Python: some accounts/models reject the newest web search tool,
    // so retry once with the basic one. Only for a plain "bad request"; key,
    // billing and model problems fail right away, and a second failure
    // fails the job with Claude's message. In direct mode the retry runs
    // only while most of the step's minute is left (the rejection is instant).
    const retryable = error instanceof ClaudeError && error.kind === 'bad_request' && toolType(primaryTool) !== BASIC_WEB_SEARCH_TYPE;
    if (!retryable || (direct && ctx.timeLeftMs() < budget * 0.6)) throw outOfTime(error);
    logger.warn('web_discovery_tool_retry', { user_id: ctx.userId, tool: toolType(primaryTool), error: error.detail.slice(0, 300) });
    ctx.note(`Web search tool ${toolType(primaryTool)} was rejected (${error.detail.slice(0, 200)}); retrying with ${BASIC_WEB_SEARCH_TYPE}`);
    notes.push('Retried with basic web search tool');
    await ctx.progress('Retrying with the basic web search tool...');
    try {
      response = await ai.call({ ...request, tools: [basicWebSearchTool(maxSearches)] });
    } catch (retryError) {
      throw outOfTime(retryError);
    }
  }

  const searches = countSearches(response);
  notes.push(`Ran ${searches} web searches`);

  const parsed = parseWebDiscoveryAnswer(response.text);
  // Direct mode allows one continuation of a paused search: a turn still
  // paused after that ran out of this step's time.
  const stillSearching = direct && response.stopReason === 'pause_turn';
  if (stillSearching && !parsed.entries?.length) {
    logger.warn('web_discovery_out_of_time', { user_id: ctx.userId, stop_reason: response.stopReason, searches });
    ctx.note(`Claude was still searching (stop reason pause_turn after ${searches} searches) when this step had to stop`);
    throw new HttpError(504, WEB_DISCOVERY_OUT_OF_TIME);
  }
  if (stillSearching && parsed.entries?.length) {
    notes.push(`Claude was still searching when it had to stop; kept the ${parsed.entries.length} grant(s) it had already listed`);
  }
  if (parsed.entries === null) {
    const preview = response.text.slice(0, 300);
    logger.warn('web_discovery_unparseable', {
      user_id: ctx.userId,
      stop_reason: response.stopReason,
      chars: response.text.length,
      searches,
      preview,
    });
    ctx.note(`No parseable grant list in AI response (stop reason ${response.stopReason ?? 'unknown'}, ${response.text.length} chars). Start: ${preview}`);
    // The website shows these after "Discovery failed: ".
    if (response.stopReason === 'max_tokens') {
      throw new HttpError(502, "Claude's web search answer was cut off before the grant list was complete. Please try again.");
    }
    if (response.stopReason === 'refusal') {
      throw new HttpError(502, 'Claude declined to answer this web search. Please try again.');
    }
    throw new HttpError(
      502,
      "Claude's web search answer didn't include a readable grant list. Try again in a minute; if it keeps happening, use \"Copy debug report\".",
    );
  }
  if (parsed.salvaged) {
    notes.push('Recovered grants from a partly malformed AI answer');
    ctx.note(`Grant list was malformed; recovered ${parsed.entries.length} complete entries`);
  }
  if (parsed.entries.length === 0) {
    notes.push('Claude found no grants it could verify on the web');
  }

  const found = grantsFromWebEntries(ctx.userId, parsed.entries);
  // The prompt asks Claude to leave these out; any that slip through are never saved.
  const grants = found.filter((grant) => grant.religious_eligibility !== 'excluded');
  if (grants.length < found.length) {
    const skipped = found.length - grants.length;
    notes.push(`Skipped ${skipped} grant${skipped === 1 ? '' : 's'} that ${skipped === 1 ? "doesn't" : "don't"} fund religious organizations`);
  }
  notes.push(`AI verified ${grants.length} opportunities`);

  await ctx.progress(`Saving ${grants.length} grants...`);
  const merge = await mergeIntoDatabase(ctx.userId, grants);
  logger.info('web_discovery_done', { user_id: ctx.userId, found: grants.length, searches, ...merge });
  return discoveryResult('web_discovery', grants.length, merge, notes);
}

export const discoveryJobs: Record<string, JobHandler> = {
  'discovery.grants_gov': runGrantsGov,
  'discovery.web_search': runWebSearch,
};
