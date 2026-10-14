/**
 * Grant discovery: the ways grants enter the database besides a spreadsheet.
 * Port of backend/services/discovery_service.py.
 *
 *   1. Seed database: the curated starter list in data/seed_grants.json
 *   2. Grants.gov: the free federal Search2 API (no key needed)
 *   3. AI web discovery: Claude with server-side web search, tailored to the profile
 *
 * Every source merges into the user's grant list with name+funder
 * deduplication, so running discovery again is safe and additive.
 *
 * The background job function imports this module: never import exceljs,
 * docx or mammoth here.
 */
import crypto from 'node:crypto';

import { GRANTS_GOV_API_URL, GRANTS_GOV_MAX_RESULTS } from '../config';
import seed from '../data/seed_grants.json';
import { asRecord, asStringList, extractJsonArray } from '../json';
import { logger } from '../log';
import { updateFoundations, updateGrants } from '../repo';
import {
  GEO_QUALIFIED_VALUES,
  GRANT_CATEGORIES,
  GRANT_STATUSES,
  type DiscoveryResult,
  type DiscoverySource,
  type Foundation,
  type GeoQualified,
  type Grant,
  type GrantCategory,
  type GrantStatus,
  type OrganizationProfile,
} from '../types';

// =============================================================================
// Small helpers
// =============================================================================

/** grant_ + 12 hex characters, like the Python uuid4().hex[:12]. */
export function newGrantId(): string {
  return `grant_${crypto.randomBytes(6).toString('hex')}`;
}

export function newFoundationId(): string {
  return `foundation_${crypto.randomBytes(6).toString('hex')}`;
}

/** A loose model/JSON value as trimmed text ('' for missing or non-text values). */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return '';
}

/**
 * Tags like ["facilities", "security"]. A comma-separated string becomes a list
 * (the Python list("a, b") turned a string into single characters).
 */
export function tagList(value: unknown): string[] {
  if (Array.isArray(value)) return asStringList(value).map((tag) => tag.trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/[,;\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Only http(s) links are kept; "kenedy.org/grants" gains https://. Anything
 * else (javascript:, data:, "See website") becomes '' so the website never
 * renders an unsafe or broken link, even if a web page tricked the model.
 */
export function cleanUrl(value: unknown): string {
  const text = textOf(value);
  if (!text) return '';
  const link = /^https?:\/\/\S+/i.exec(text);
  if (link) return link[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return '';
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(text)) return `https://${text}`;
  return '';
}

// =============================================================================
// Deduplication and merging
// =============================================================================

/** Normalize name+funder into a stable dedup key (same rule as the Python). */
export function dedupKey(grantName: string, funder: string): string {
  return `${grantName}|${funder}`.toLowerCase().replace(/[^a-z0-9|]/g, '');
}

export function existingKeys(grants: Grant[]): Set<string> {
  return new Set(grants.map((grant) => dedupKey(grant.grant_name, grant.funder)));
}

/**
 * Merge incoming grants into the current list, skipping duplicates (the
 * existing record wins). Returns a new list; the inputs are not changed.
 */
export function mergeGrants(current: Grant[], incoming: Grant[]): { merged: Grant[]; added: number; duplicates: number } {
  const keys = existingKeys(current);
  const merged = [...current];
  let added = 0;
  let duplicates = 0;
  for (const grant of incoming) {
    const key = dedupKey(grant.grant_name, grant.funder);
    if (keys.has(key)) {
      duplicates += 1;
      continue;
    }
    keys.add(key);
    merged.push(grant);
    added += 1;
  }
  return { merged, added, duplicates };
}

/** Merge foundations by name (case-insensitive); existing records win. */
export function mergeFoundations(current: Foundation[], incoming: Foundation[]): { merged: Foundation[]; added: number } {
  const names = new Set(current.map((foundation) => foundation.foundation_name.trim().toLowerCase()));
  const merged = [...current];
  let added = 0;
  for (const foundation of incoming) {
    const name = foundation.foundation_name.trim().toLowerCase();
    if (names.has(name)) continue;
    names.add(name);
    merged.push(foundation);
    added += 1;
  }
  return { merged, added };
}

export interface MergeOutcome {
  added: number;
  duplicates: number;
  /** Grants in the user's database after the merge. */
  total: number;
}

/**
 * Merge new grants into the user's saved list with compare-and-swap, so two
 * discovery jobs finishing at the same moment never overwrite each other.
 */
export async function mergeIntoDatabase(userId: string, incoming: Grant[]): Promise<MergeOutcome> {
  let outcome: MergeOutcome = { added: 0, duplicates: 0, total: 0 };
  const saved = await updateGrants(userId, (current) => {
    const { merged, added, duplicates } = mergeGrants(current, incoming);
    outcome = { added, duplicates, total: merged.length };
    return added > 0 ? merged : undefined;
  });
  outcome.total = saved.length;
  return outcome;
}

/** Same for foundations (by name). Returns how many were new and the new total. */
export async function mergeFoundationsIntoDatabase(userId: string, incoming: Foundation[]): Promise<{ added: number; total: number }> {
  let added = 0;
  const saved = await updateFoundations(userId, (current) => {
    const result = mergeFoundations(current, incoming);
    added = result.added;
    return result.added > 0 ? result.merged : undefined;
  });
  return { added, total: saved.length };
}

export function discoveryResult(source: DiscoverySource, found: number, merge: MergeOutcome, notes: string[]): DiscoveryResult {
  return { source, found, added: merge.added, duplicates: merge.duplicates, total_grants: merge.total, notes };
}

// =============================================================================
// Value parsers (lenient, for seed data, Grants.gov and model output)
// =============================================================================

const CATEGORY_ALIASES: Record<string, GrantCategory> = {
  mixed_church_school: 'mixed',
  church_school: 'mixed',
  non_catholic_qualifying: 'non_catholic',
  secular: 'non_catholic',
  catholic_foundations: 'foundations',
  foundation: 'foundations',
  church: 'church_parish',
  parish: 'church_parish',
  school: 'catholic_school',
  catholic_schools: 'catholic_school',
};

/** Exact enum value first, then a forgiving match ("Catholic School"); else non_catholic, like the Python. */
export function parseCategory(value: unknown): GrantCategory {
  const text = textOf(value);
  if ((GRANT_CATEGORIES as string[]).includes(text)) return text as GrantCategory;
  const normalized = text.toLowerCase().replace(/[\s/-]+/g, '_');
  if ((GRANT_CATEGORIES as string[]).includes(normalized)) return normalized as GrantCategory;
  return CATEGORY_ALIASES[normalized] ?? 'non_catholic';
}

export function parseGeo(value: unknown): GeoQualified {
  const text = textOf(value);
  if (!text) return 'Check eligibility';
  if ((GEO_QUALIFIED_VALUES as string[]).includes(text)) return text as GeoQualified;
  const upper = text.toUpperCase();
  if (upper.includes('TX') || upper.includes('TEXAS')) return 'Yes - TX Only';
  if (['YES', 'Y', 'TRUE'].includes(upper)) return 'Yes';
  if (['NO', 'N', 'FALSE'].includes(upper)) return 'No';
  return 'Check eligibility';
}

export function parseStatus(value: unknown): GrantStatus {
  const text = textOf(value);
  if (!text) return 'Check deadline';
  if ((GRANT_STATUSES as string[]).includes(text)) return text as GrantStatus;
  const upper = text.toUpperCase();
  if (upper.includes('OPEN') || upper.includes('POSTED')) return 'OPEN';
  if (upper.includes('ROLL')) return 'Rolling';
  if (upper.includes('CLOSE')) return 'CLOSED';
  return 'Check deadline';
}

/** Eligibility notes may come back as a list; keep them as one readable string. */
function notesText(value: unknown): string | null {
  if (Array.isArray(value)) return asStringList(value).map((item) => item.trim()).filter(Boolean).join('; ') || null;
  return textOf(value) || null;
}

/** The grant's name: grant_name, or name/title when a model used those keys. */
function grantNameOf(data: Record<string, unknown>): string {
  return textOf(data.grant_name) || textOf(data.name) || textOf(data.title);
}

/** Build a Grant from a loose dict, tolerating missing fields. Null when it has no name. */
export function makeGrant(
  userId: string,
  source: string,
  data: Record<string, unknown>,
  defaultCategory: GrantCategory = 'non_catholic',
): Grant | null {
  const name = grantNameOf(data);
  if (!name) return null;
  return {
    grant_name: name,
    deadline: textOf(data.deadline) || 'Check website',
    amount: textOf(data.amount) || 'Varies',
    funder: textOf(data.funder) || 'Unknown',
    description: textOf(data.description),
    contact: textOf(data.contact) || 'See website',
    url: cleanUrl(data.url),
    status: parseStatus(data.status),
    geo_qualified: parseGeo(data.geo_qualified),
    funder_stats: textOf(data.funder_stats) || null,
    category: parseCategory(textOf(data.category) || defaultCategory),
    source,
    eligibility_notes: notesText(data.eligibility_notes),
    funds_for: tagList(data.funds_for),
    id: newGrantId(),
    user_id: userId,
    created_at: new Date().toISOString(),
  };
}

// =============================================================================
// Source 1: Seed database
// =============================================================================

interface SeedFile {
  grants?: unknown[];
  foundations?: unknown[];
}

/** The built-in curated grant database, as fresh records for this user. */
export function loadSeedGrants(userId: string): { grants: Grant[]; foundations: Foundation[] } {
  const data = seed as unknown as SeedFile;
  const grants: Grant[] = [];
  for (const entry of data.grants ?? []) {
    const grant = makeGrant(userId, 'seed', asRecord(entry));
    if (grant) grants.push(grant);
  }

  const foundations: Foundation[] = [];
  for (const raw of data.foundations ?? []) {
    const entry = asRecord(raw);
    const name = textOf(entry.foundation_name);
    if (!name) {
      logger.warn('seed_foundation_skipped', { reason: 'no foundation_name' });
      continue;
    }
    foundations.push({
      id: newFoundationId(),
      user_id: userId,
      foundation_name: name,
      application_cycle: entry.application_cycle === undefined ? 'Check website' : textOf(entry.application_cycle),
      focus_areas: textOf(entry.focus_areas),
      location: textOf(entry.location),
      contact: entry.contact === undefined ? 'See website' : textOf(entry.contact),
      website: textOf(entry.website),
      annual_giving: textOf(entry.annual_giving),
      notes: textOf(entry.notes) || null,
      created_at: new Date().toISOString(),
    });
  }

  logger.info('seed_grants_loaded', { grants: grants.length, foundations: foundations.length });
  return { grants, foundations };
}

// =============================================================================
// Source 2: Grants.gov federal opportunity search
// =============================================================================

/** Default search terms for a Catholic parish/school when the profile gives nothing more specific. */
export const DEFAULT_GRANTS_GOV_KEYWORDS = ['nonprofit security', 'private school education', 'faith-based community'];

/** The Search2 endpoint. GRANTS_GOV_API_URL in the environment overrides it (tests use a local fake). */
export function grantsGovUrl(): string {
  return (process.env.GRANTS_GOV_API_URL || '').trim() || GRANTS_GOV_API_URL;
}

/** Derive Grants.gov search keywords from the organization profile (at most 6). */
export function buildGrantsGovKeywords(profile: OrganizationProfile | null): string[] {
  const keywords = [...DEFAULT_GRANTS_GOV_KEYWORDS];
  if (profile) {
    if (profile.security_concerns.length) keywords.unshift('nonprofit security grant');
    if (profile.facility_needs.length) keywords.push('community facilities');
    if (profile.has_food_pantry) keywords.push('food assistance nonprofit');
    if (profile.has_school && profile.program_needs.length) keywords.push('K-12 education program');
  }
  return Array.from(new Set(keywords)).slice(0, 6);
}

export interface GrantsGovSearchResult {
  grants: Grant[];
  notes: string[];
  /** One plain-English reason per keyword search that failed. */
  failures: string[];
  searched: number;
}

const GRANTS_GOV_TIMEOUT_MS = 30_000;

/** Why a fetch failed, in words a person can act on. */
function describeFetchError(error: unknown): string {
  const err = error as { name?: string; message?: string; cause?: unknown };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `no answer within ${GRANTS_GOV_TIMEOUT_MS / 1000} seconds`;
  const cause = err?.cause as { code?: string; message?: string; errors?: Array<{ code?: string }> } | undefined;
  const code = cause?.code || cause?.errors?.find((item) => item?.code)?.code;
  if (code) return `couldn't connect (${code})`;
  if (err?.message === 'fetch failed') return `couldn't connect${cause?.message ? ` (${cause.message})` : ''}`;
  return err?.message || String(error);
}

interface GrantsGovHit {
  id?: unknown;
  number?: unknown;
  title?: unknown;
  agencyName?: unknown;
  agency?: unknown;
  closeDate?: unknown;
  oppStatus?: unknown;
}

/**
 * Search the Grants.gov Search2 API (public, no key) for open and forecasted
 * federal opportunities matching the keywords. One request per keyword; a
 * failed keyword is noted and skipped, as in the Python.
 */
export async function searchGrantsGov(
  userId: string,
  keywords: string[],
  maxResults: number | null,
  onProgress?: (message: string) => Promise<void>,
): Promise<GrantsGovSearchResult> {
  const max = maxResults || GRANTS_GOV_MAX_RESULTS;
  const perKeyword = Math.max(10, Math.floor(max / Math.max(keywords.length, 1)));
  const url = grantsGovUrl();
  const grants: Grant[] = [];
  const notes: string[] = [];
  const failures: string[] = [];
  const seenIds = new Set<string>();

  for (const [index, keyword] of keywords.entries()) {
    await onProgress?.(`Searching Grants.gov for "${keyword}" (${index + 1} of ${keywords.length})...`);
    let payload: Record<string, unknown>;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ keyword, oppStatuses: 'forecasted|posted', rows: perKeyword, startRecordNum: 0 }),
        signal: AbortSignal.timeout(GRANTS_GOV_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Grants.gov answered HTTP ${response.status}`);
      try {
        payload = asRecord(await response.json());
      } catch {
        throw new Error('Grants.gov sent an answer that is not JSON');
      }
      const errorCode = payload.errorcode;
      if (typeof errorCode === 'number' && errorCode !== 0) {
        throw new Error(`Grants.gov reported an error: ${textOf(payload.msg) || `code ${errorCode}`}`);
      }
    } catch (error) {
      const reason = describeFetchError(error);
      logger.warn('grants_gov_search_failed', { keyword, url, error: reason });
      notes.push(`Search '${keyword}' failed: ${reason}`);
      failures.push(reason);
      continue;
    }

    const hitsRaw = asRecord(payload.data).oppHits;
    const hits: GrantsGovHit[] = Array.isArray(hitsRaw) ? (hitsRaw as GrantsGovHit[]) : [];
    notes.push(`Search '${keyword}': ${hits.length} results`);

    for (const raw of hits) {
      const hit = asRecord(raw) as GrantsGovHit;
      const oppId = textOf(hit.id);
      if (!oppId || seenIds.has(oppId)) continue;
      seenIds.add(oppId);
      const title = textOf(hit.title);
      if (!title) continue;
      const number = textOf(hit.number);
      grants.push({
        grant_name: title,
        deadline: textOf(hit.closeDate) || 'Check website',
        amount: 'See listing',
        funder: textOf(hit.agencyName) || textOf(hit.agency) || 'Federal Agency',
        description: `Federal opportunity ${number} (matched search: '${keyword}'). See Grants.gov listing for full details.`.replace(/\s{2,}/g, ' '),
        contact: 'See Grants.gov listing',
        url: `https://www.grants.gov/search-results-detail/${encodeURIComponent(oppId)}`,
        status: parseStatus(hit.oppStatus),
        geo_qualified: 'Check eligibility',
        funder_stats: null,
        category: 'non_catholic',
        source: 'grants_gov',
        eligibility_notes: 'Federal grant - verify nonprofit/faith-based eligibility in the listing.',
        funds_for: [],
        id: newGrantId(),
        user_id: userId,
        created_at: new Date().toISOString(),
      });
    }
  }

  logger.info('grants_gov_search_done', { user_id: userId, keywords: keywords.length, failed: failures.length, found: grants.length });
  return { grants, notes, failures, searched: keywords.length };
}

// =============================================================================
// Source 3: AI web discovery (Claude + web search)
// =============================================================================

export const WEB_DISCOVERY_PROMPT_ID = 'web_discovery_v1';

export const WEB_DISCOVERY_SCHEMA_HINT = `[
  {
    "grant_name": "Name of the grant program",
    "funder": "Funding organization",
    "category": "church_parish | catholic_school | mixed | non_catholic",
    "deadline": "YYYY-MM-DD, 'Rolling', or 'Check website'",
    "amount": "e.g. 'Up to $15,000' or 'Varies'",
    "description": "1-3 sentences on what it funds and who qualifies",
    "eligibility_notes": "Key requirements/restrictions",
    "url": "Direct link to the grant page",
    "geo_qualified": "Yes | No | Check eligibility",
    "funds_for": ["tags", "like", "facilities"]
  }
]`;

/** The Python prompt, verbatim, filled from the profile. */
export function buildWebDiscoveryPrompt(profile: OrganizationProfile | null, focus: string | null): string {
  let profileLines: string[] = [];
  if (profile) {
    profileLines = [
      `- Organization: ${profile.organization_name || 'Catholic parish/school'}`,
      `- Type: ${profile.organization_type}` + (profile.has_school ? ' with school' : ''),
      profile.state ? `- Location: ${profile.city}, ${profile.state}` : '- Location: unknown',
      profile.diocese ? `- Diocese: ${profile.diocese}` : '',
      profile.facility_needs.length ? `- Facility needs: ${profile.facility_needs.slice(0, 5).join(', ')}` : '',
      profile.program_needs.length ? `- Program needs: ${profile.program_needs.slice(0, 5).join(', ')}` : '',
      profile.security_concerns.length ? `- Security concerns: ${profile.security_concerns.slice(0, 3).join(', ')}` : '',
      profile.free_form_notes ? `- Notes: ${profile.free_form_notes.slice(0, 500)}` : '',
    ].filter((line) => line);
  }
  const profileText = profileLines.join('\n') || '- A Catholic parish and/or Catholic school in the United States';
  const focusText = focus ? `\nEXTRA FOCUS: prioritize opportunities related to: ${focus}` : '';

  return `You are a grant researcher for Catholic parishes and schools. Search the web to find CURRENT, real grant opportunities this organization could apply for.

ORGANIZATION PROFILE:
${profileText}
${focusText}

Search for:
1. National Catholic foundations and grant programs currently accepting applications
2. State/regional foundations in the organization's state
3. Corporate and secular grants that faith-based schools/churches qualify for (education, facilities, security, technology, hunger relief)
4. Government programs the organization is eligible for

Rules:
- Only include grants you found real evidence for on the web (a funder page or credible listing). Never invent grants, amounts, or deadlines.
- If you can't verify a deadline, use "Check website".
- Include the direct URL you found for each grant.
- Aim for 8-15 high-quality opportunities.

After searching, return ONLY a JSON array in exactly this shape (no other text after it):
${WEB_DISCOVERY_SCHEMA_HINT}`;
}

/** End index (inclusive) of the balanced {...} starting at `start`, string-aware; -1 if unbalanced. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return ch === '}' ? i : -1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Last resort when the answer's array is malformed (trailing comma, cut off
 * mid-list): collect every complete {...} that looks like a grant.
 */
function salvageGrantObjects(text: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const end = objectEnd(text, i);
    if (end === -1) continue;
    try {
      const value = JSON.parse(text.slice(i, end + 1)) as unknown;
      const record = asRecord(value);
      if (grantNameOf(record)) {
        found.push(record);
        i = end;
      }
    } catch {
      // Not JSON; keep scanning.
    }
  }
  return found;
}

export interface ParsedWebAnswer {
  /** null when the answer had no grant list at all. */
  entries: Array<Record<string, unknown>> | null;
  salvaged: boolean;
}

/**
 * Pull the grant list out of the model's answer. The answer often has prose
 * and citation brackets like "[1]" around the JSON; extractJsonArray prefers
 * the largest array, and only objects with a grant name count as grants.
 */
export function parseWebDiscoveryAnswer(text: string): ParsedWebAnswer {
  const array = extractJsonArray<unknown>(text);
  const named = (array ?? []).filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item) && grantNameOf(item as Record<string, unknown>) !== '',
  );
  if (named.length) return { entries: named, salvaged: false };
  const salvaged = salvageGrantObjects(text);
  if (salvaged.length) return { entries: salvaged, salvaged: true };
  // A bare [] means Claude searched and found nothing it could verify.
  if (array && array.length === 0) return { entries: [], salvaged: false };
  return { entries: null, salvaged: false };
}

/** Grants from the model's entries (entries without a name are skipped). */
export function grantsFromWebEntries(userId: string, entries: Array<Record<string, unknown>>): Grant[] {
  const grants: Grant[] = [];
  for (const entry of entries) {
    const grant = makeGrant(userId, 'web_discovery', entry);
    if (grant) grants.push(grant);
  }
  return grants;
}
