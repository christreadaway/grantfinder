/**
 * The eligibility and verification details a grant record can carry (geography, whether a
 * Catholic school may apply, deadline notes, the funder's priorities, typical award, when it was
 * last checked), read leniently from the starter database, spreadsheets and Claude's answers.
 */
import { asStringList } from './json';
import { RELIGIOUS_ELIGIBILITY_VALUES, type GrantBase, type GrantDetails, type ReligiousEligibility } from './types';

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Readable text, or null when empty. A list becomes one "a; b; c" string. */
export function detailText(value: unknown, max = 2000): string | null {
  const joined = Array.isArray(value) ? asStringList(value).map((item) => item.trim()).filter(Boolean).join('; ') : text(value);
  return joined ? joined.slice(0, max) : null;
}

/** A short list of phrases: a list, or text split on commas, semicolons or new lines. */
export function detailList(value: unknown, maxItems = 8): string[] {
  const items = Array.isArray(value) ? asStringList(value) : typeof value === 'string' ? value.split(/[;\n]|,(?![^(]*\))/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim().replace(/\s+/g, ' ').slice(0, 160);
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * eligible | secular_purpose_only | excluded | unclear, from the exact value or plain words
 * ("Yes", "No restrictions", "Catholic schools eligible", "religious organizations not eligible",
 * "secular programs only"). Unknown -> null. Order matters: "no restrictions" and "not excluded"
 * mean anyone may apply, so they are read before the words that mean excluded, and a bare "No" only
 * counts as excluded when it is the whole answer.
 */
export function parseReligiousEligibility(value: unknown): ReligiousEligibility | null {
  const raw = text(value).toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return null;
  const exact = raw.replace(/[\s-]+/g, '_');
  if ((RELIGIOUS_ELIGIBILITY_VALUES as string[]).includes(exact)) return exact as ReligiousEligibility;
  if (/\bno (?:religious )?restrictions?\b|\bnot (?:excluded|ineligible)\b/.test(raw)) return 'eligible';
  if (/secular|non-? ?religious|not for religious|no religious (?:activit|instruct|purpose|use)/.test(raw)) return 'secular_purpose_only';
  if (/^(?:no|n|false)\.?$/.test(raw) || /exclud|ineligible|not eligible|not accept|(?:does|do) not fund|cannot apply|can't apply/.test(raw)) {
    return 'excluded';
  }
  if (/^(?:yes|y|true)\b/.test(raw) || /\beligible\b|\bmay apply\b|\bcan apply\b|\bwelcome\b/.test(raw)) return 'eligible';
  if (/unclear|unknown|check|unsure|not stated/.test(raw)) return 'unclear';
  return null;
}

/** YYYY-MM-DD for a real date, else null. */
export function isoDateOrNull(value: unknown): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
    ? `${match[1]}-${match[2]}-${match[3]}`
    : null;
}

/** Only http(s) links, at most a few. */
export function sourceList(value: unknown, maxItems = 6): string[] {
  return detailList(value, 50)
    .filter((item) => /^https?:\/\/\S+$/i.test(item))
    .slice(0, maxItems);
}

/** The optional detail fields of a grant record from a loose dict (seed file, spreadsheet row, Claude's JSON). */
export function parseGrantDetails(data: Record<string, unknown>): Pick<
  GrantBase,
  'deadline_notes' | 'geography' | 'religious_eligibility' | 'focus_areas' | 'typical_award' | 'last_verified' | 'confidence' | 'sources'
> {
  const confidence = text(data.confidence).toLowerCase();
  const typical = detailText(data.typical_award, 300);
  return {
    deadline_notes: detailText(data.deadline_notes, 600),
    geography: detailText(data.geography, 300),
    religious_eligibility: parseReligiousEligibility(data.religious_eligibility),
    focus_areas: detailList(data.focus_areas),
    typical_award: typical && !/^not\s+published$/i.test(typical) ? typical : null,
    last_verified: isoDateOrNull(data.last_verified),
    confidence: confidence === 'verified' || confidence === 'partial' ? confidence : null,
    sources: sourceList(data.sources),
  };
}

/** What a match copies from its grant so the results can show it. */
export function grantDetails(grant: Partial<GrantBase>): GrantDetails {
  return {
    eligibility_notes: grant.eligibility_notes ?? null,
    deadline_notes: grant.deadline_notes ?? null,
    geography: grant.geography ?? null,
    religious_eligibility: grant.religious_eligibility ?? null,
    focus_areas: Array.isArray(grant.focus_areas) ? grant.focus_areas : [],
    typical_award: grant.typical_award ?? null,
    last_verified: grant.last_verified ?? null,
    confidence: grant.confidence ?? null,
  };
}
