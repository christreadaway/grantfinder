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
  WEB_DISCOVERY_PROMPT_ID,
} from '../services/discovery';
import type { DiscoveryResult } from '../types';

// =============================================================================
// discovery.grants_gov
// =============================================================================

export interface GrantsGovJobInput {
  keywords: string[];
  max_results: number | null;
}

async function runGrantsGov(ctx: JobContext): Promise<DiscoveryResult> {
  const input = (ctx.input ?? {}) as Partial<GrantsGovJobInput>;
  const keywords = Array.isArray(input.keywords) ? input.keywords.filter((k): k is string => typeof k === 'string' && k.trim() !== '') : [];
  const maxResults = typeof input.max_results === 'number' ? input.max_results : null;
  ctx.note(`Grants.gov keywords: ${keywords.join(' | ')}`);

  const search = await searchGrantsGov(ctx.userId, keywords, maxResults, (message) => ctx.progress(message));
  search.notes.forEach((note) => ctx.note(`Grants.gov ${note}`));

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

async function runWebSearch(ctx: JobContext): Promise<DiscoveryResult> {
  const input = (ctx.input ?? {}) as Partial<WebSearchJobInput>;
  const focus = typeof input.focus === 'string' && input.focus.trim() ? input.focus.trim() : null;
  const profile = await getProfile(ctx.userId);
  const prompt = buildWebDiscoveryPrompt(profile, focus);
  ctx.note(`Web discovery for ${profile ? 'the saved profile' : 'a generic Catholic parish/school (no profile yet)'}${focus ? `, focus: ${focus}` : ''}`);

  const ai = await ctx.claude();
  const notes: string[] = [];
  const primaryTool = ai.webSearchTool(WEB_DISCOVERY_MAX_SEARCHES);
  const request = { stage: 'discovery', promptId: WEB_DISCOVERY_PROMPT_ID, prompt, maxTokens: 8000 };

  await ctx.progress('Claude is searching the web for grants that fit your profile (usually 1-3 minutes)...');
  let response: ClaudeCallResult;
  try {
    response = await ai.call({ ...request, tools: [primaryTool] });
  } catch (error) {
    // Like the Python: some accounts/models reject the newest web search tool,
    // so retry once with the basic one. Only for a plain "bad request"; key,
    // billing and model problems fail right away, and a second failure
    // fails the job with Claude's message.
    const retryable = error instanceof ClaudeError && error.kind === 'bad_request' && toolType(primaryTool) !== BASIC_WEB_SEARCH_TYPE;
    if (!retryable) throw error;
    logger.warn('web_discovery_tool_retry', { user_id: ctx.userId, tool: toolType(primaryTool), error: error.detail.slice(0, 300) });
    ctx.note(`Web search tool ${toolType(primaryTool)} was rejected (${error.detail.slice(0, 200)}); retrying with ${BASIC_WEB_SEARCH_TYPE}`);
    notes.push('Retried with basic web search tool');
    await ctx.progress('Retrying with the basic web search tool...');
    response = await ai.call({ ...request, tools: [basicWebSearchTool(WEB_DISCOVERY_MAX_SEARCHES)] });
  }

  const searches = countSearches(response);
  notes.push(`Ran ${searches} web searches`);

  const parsed = parseWebDiscoveryAnswer(response.text);
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

  const grants = grantsFromWebEntries(ctx.userId, parsed.entries);
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
