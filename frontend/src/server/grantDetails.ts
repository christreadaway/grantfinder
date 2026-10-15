/**
 * The eligibility and verification details a grant record can carry (geography, whether a
 * Catholic school may apply, deadline notes, the funder's priorities, typical award, when it was
 * last checked), read leniently from the starter database, spreadsheets and Claude's answers.
 */
import { asStringList } from './json';
import { RELIGIOUS_ELIGIBILITY_VALUES, type FunderIntel, type GrantBase, type GrantDetails, type PastAward, type ReligiousEligibility } from './types';

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

/** Text the research uses when it found nothing ("Not found", "None found", "N/A"): treated as empty. */
function found(value: unknown, max = 600): string | null {
  const textValue = detailText(value, max);
  return textValue && !/^(?:not found|none found|n\/?a|unknown|not published)\.?$/i.test(textValue) ? textValue : null;
}

/** A funder's track record from a loose dict; null when there is nothing usable. */
export function parseFunderIntel(value: unknown): FunderIntel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const awards: PastAward[] = [];
  for (const raw of Array.isArray(data.past_awards) ? data.past_awards : []) {
    if (!raw || typeof raw !== 'object') continue;
    const award = raw as Record<string, unknown>;
    const recipient = found(award.recipient, 160);
    const amount = found(award.amount, 80);
    if (!recipient && !amount) continue;
    const year = Number(award.year);
    awards.push({
      year: Number.isInteger(year) && year >= 1990 && year <= 2100 ? year : null,
      amount: amount ?? '',
      recipient: recipient ?? '',
      purpose: found(award.purpose, 200) ?? '',
    });
    if (awards.length >= 8) break;
  }
  const intel: FunderIntel = {
    applicable: data.applicable !== false,
    note: found(data.note, 400),
    past_awards: awards,
    award_levels: found(data.award_levels),
    funded_focus: detailList(data.funded_focus, 6).filter((item) => found(item)),
    catholic_school_track_record: found(data.catholic_school_track_record),
    giving_trend: found(data.giving_trend),
    outlook: found(data.outlook) && !/^no announced changes found\.?$/i.test(String(data.outlook).trim()) ? found(data.outlook) : null,
    as_of: isoDateOrNull(data.as_of),
    sources: sourceList(data.sources, 8),
  };
  const hasFacts =
    intel.past_awards.length > 0 || intel.funded_focus.length > 0 ||
    Boolean(intel.award_levels || intel.catholic_school_track_record || intel.giving_trend || intel.outlook || intel.note);
  return hasFacts ? intel : null;
}

/** The optional detail fields of a grant record from a loose dict (seed file, spreadsheet row, Claude's JSON). */
export function parseGrantDetails(data: Record<string, unknown>): Pick<
  GrantBase,
  'deadline_notes' | 'geography' | 'religious_eligibility' | 'focus_areas' | 'typical_award' | 'last_verified' | 'confidence' | 'sources' | 'funder_intel'
> {
  const confidence = text(data.confidence).toLowerCase();
  const typical = detailText(data.typical_award, 300);
  return {
    deadline_notes: detailText(data.deadline_notes, 600),
    geography: detailText(data.geography, 300),
    religious_eligibility: parseReligiousEligibility(data.religious_eligibility),
    focus_areas: detailList(data.focus_areas),
    typical_award: typical && !/^not\s+published\b/i.test(typical) ? typical : null,
    last_verified: isoDateOrNull(data.last_verified),
    confidence: confidence === 'verified' || confidence === 'partial' ? confidence : null,
    sources: sourceList(data.sources),
    funder_intel: parseFunderIntel(data.funder_intel),
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
    funder_intel: grant.funder_intel ?? null,
  };
}

/** The track record in a few words for prompts: only the fields that inform a decision. */
export function intelForPrompt(intel: FunderIntel | null | undefined): Record<string, unknown> | null {
  if (!intel || !intel.applicable) return null;
  const out: Record<string, unknown> = {};
  if (intel.award_levels) out.award_levels = intel.award_levels;
  if (intel.catholic_school_track_record) out.catholic_school_track_record = intel.catholic_school_track_record;
  if (intel.funded_focus.length) out.funded_in_practice = intel.funded_focus;
  if (intel.giving_trend) out.giving_trend = intel.giving_trend;
  if (intel.outlook) out.outlook = intel.outlook;
  if (intel.past_awards.length) {
    out.past_awards = intel.past_awards.slice(0, 5).map((a) => [a.year, a.amount, a.recipient, a.purpose].filter(Boolean).join(' | '));
  }
  return Object.keys(out).length ? out : null;
}
