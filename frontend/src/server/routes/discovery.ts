/**
 * /api/discovery: fill the grant database without building a spreadsheet.
 * Port of backend/routers/discovery.py.
 *
 *   POST /api/discovery/seed        built-in curated database (instant)
 *   POST /api/discovery/grants-gov  Grants.gov federal search (job discovery.grants_gov)
 *   POST /api/discovery/web-search  AI web discovery (job discovery.web_search; needs the Claude key)
 *   GET  /api/discovery/sources     where the user's grants came from
 *
 * Every source merges into the user's grants with name+funder deduplication.
 */
import { requireApiKey } from '../auth';
import { HttpError } from '../errors';
import type { GrantsGovJobInput, WebSearchJobInput } from '../handlers/discovery';
import { optionalString } from '../http';
import { startJob } from '../jobs';
import { logger } from '../log';
import { todayIso } from '../deadlines';
import { getGrants, getProfile, listApplications } from '../repo';
import type { Router } from '../router';
import {
  buildGrantsGovKeywords,
  discoveryResult,
  loadSeedGrants,
  mergeFoundationsIntoDatabase,
  refreshSeedIntoDatabase,
} from '../services/discovery';

/** More keywords than this would keep the job running for many minutes. */
const MAX_KEYWORDS = 10;
const MAX_RESULTS_CAP = 500;
const MAX_FOCUS_CHARS = 500;

/** keywords: optional list of search phrases (a single string is accepted too). */
function parseKeywords(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
    throw new HttpError(422, 'Field "keywords" must be a list of search phrases, for example ["school security"].');
  }
  const cleaned = (list as string[]).map((item) => item.trim().slice(0, 100)).filter(Boolean);
  return Array.from(new Set(cleaned)).slice(0, MAX_KEYWORDS);
}

/** max_results: optional whole number; 0 or less means the default (like the Python's `or`). */
function parseMaxResults(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    throw new HttpError(422, 'Field "max_results" must be a whole number.');
  }
  if (number <= 0) return null;
  return Math.min(number, MAX_RESULTS_CAP);
}

const AVAILABLE_SOURCES = [
  {
    id: 'seed',
    name: 'Starter Database',
    description: 'Curated Catholic and faith-eligible grants built into GrantFinder',
    requires_api_key: false,
  },
  {
    id: 'grants_gov',
    name: 'Grants.gov Federal Search',
    description: 'Live search of open and forecasted federal opportunities',
    requires_api_key: false,
  },
  {
    id: 'web_discovery',
    name: 'AI Web Discovery',
    description: 'Claude searches the web for grants matching your profile',
    requires_api_key: true,
  },
];

export function registerDiscoveryRoutes(router: Router): void {
  /**
   * Load the built-in curated grant database (national Catholic funders,
   * secular grants faith-based orgs qualify for, TX-focused foundations).
   * Merges with whatever is already there; safe to run more than once.
   */
  router.post('/api/discovery/seed', async (ctx) => {
    const user = await ctx.user();
    let seed: ReturnType<typeof loadSeedGrants>;
    try {
      seed = loadSeedGrants(user.id);
    } catch (error) {
      logger.error('seed_load_failed', { user_id: user.id, error });
      throw new HttpError(500, 'Failed to load starter database');
    }
    // Grants an application uses are closed, never deleted, if the starter database drops them.
    const keepIds = new Set((await listApplications(user.id)).map((app) => app.grant_id));
    const refresh = await refreshSeedIntoDatabase(user.id, seed.grants, seed.previousNames, keepIds, todayIso());
    const foundations = await mergeFoundationsIntoDatabase(user.id, seed.foundations);
    logger.info('seed_merged', {
      user_id: user.id,
      found: seed.grants.length,
      added: refresh.added,
      updated: refresh.updated,
      retired: refresh.retired,
      retired_names: refresh.retired_names,
      duplicates: refresh.duplicates,
      total: refresh.total,
      foundations_added: foundations.added,
    });
    const notes: string[] = [];
    if (refresh.updated) notes.push(`Updated ${refresh.updated} starter grant${refresh.updated === 1 ? '' : 's'} with the latest deadlines and details.`);
    if (refresh.retired) {
      notes.push(
        `Retired ${refresh.retired} grant${refresh.retired === 1 ? '' : 's'} no longer offered or not open to Catholic schools: ${refresh.retired_names.slice(0, 5).join('; ')}${refresh.retired > 5 ? '; ...' : ''}.`,
      );
    }
    notes.push(`Starter database also added ${foundations.added} foundations to monitor`);
    return {
      ...discoveryResult('seed', seed.grants.length, { added: refresh.added, duplicates: refresh.duplicates, total: refresh.total }, notes),
      updated: refresh.updated,
      retired: refresh.retired,
    };
  });

  /**
   * Search Grants.gov (free federal API) for open and forecasted
   * opportunities. Keywords come from the profile unless provided. Several
   * requests, so it runs as a job (in direct job mode several at once, with
   * shorter waits, so it ends within about a minute).
   */
  router.post('/api/discovery/grants-gov', async (ctx) => {
    const user = await ctx.user();
    const body = await ctx.json();
    const requested = parseKeywords(body.keywords);
    const maxResults = parseMaxResults(body.max_results);
    const keywords = requested.length ? requested : buildGrantsGovKeywords(await getProfile(user.id));
    const input: GrantsGovJobInput = { keywords, max_results: maxResults };
    return startJob(ctx, 'discovery.grants_gov', input);
  });

  /**
   * AI web discovery: Claude searches the web for current grant
   * opportunities tailored to the profile. Needs the user's Claude API key.
   */
  router.post('/api/discovery/web-search', async (ctx) => {
    const user = await ctx.user();
    const body = await ctx.json();
    const focus = optionalString(body, 'focus');
    await requireApiKey(user.id);
    const input: WebSearchJobInput = { focus: focus && focus.trim() ? focus.trim().slice(0, MAX_FOCUS_CHARS) : null };
    return startJob(ctx, 'discovery.web_search', input);
  });

  /** Summarize where the user's grants came from. */
  router.get('/api/discovery/sources', async (ctx) => {
    const user = await ctx.user();
    const grants = await getGrants(user.id);
    const bySource: Record<string, number> = {};
    for (const grant of grants) {
      const source = grant.source || 'upload';
      bySource[source] = (bySource[source] ?? 0) + 1;
    }
    return {
      total_grants: grants.length,
      by_source: bySource,
      available_sources: AVAILABLE_SOURCES,
    };
  });
}
