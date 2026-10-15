/**
 * The eligibility and verification details a grant record can carry (geography, whether a
 * Catholic school may apply and the funder's own words on it, who submits the application,
 * deadline notes, the funder's priorities, typical award, when it was last checked), read
 * leniently from the starter database, spreadsheets and Claude's answers.
 */
import { parseDate, todayIso } from './deadlines';
import { asStringList } from './json';
import {
  RELIGIOUS_ELIGIBILITY_VALUES,
  type ApplicantType,
  type FunderIntel,
  type GrantBase,
  type GrantDetails,
  type PastAward,
  type ReligiousEligibility,
} from './types';

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * Text cut to at most `max` characters: at the last word boundary, with "..." added, when it is
 * longer (a single giant word is cut inside the word). Shorter text is returned unchanged.
 */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  const room = max - 3;
  const head = value.slice(0, room);
  const boundary = /\s/.test(value.charAt(room)) ? room : head.search(/\s+\S*$/);
  const cut = boundary >= Math.floor(room * 0.6) ? head.slice(0, boundary) : head;
  const tidy = cut.replace(/[\s,;:.]+$/, '');
  return `${tidy || cut}...`;
}

/** Readable text, or null when empty. A list becomes one "a; b; c" string. Long text is cut at a word ("..."). */
export function detailText(value: unknown, max = 2000): string | null {
  const joined = Array.isArray(value) ? asStringList(value).map((item) => item.trim()).filter(Boolean).join('; ') : text(value);
  return joined ? clip(joined, max) : null;
}

/** A short list of phrases: a list, or text split on commas, semicolons or new lines. */
export function detailList(value: unknown, maxItems = 8): string[] {
  const items = Array.isArray(value) ? asStringList(value) : typeof value === 'string' ? value.split(/[;\n]|,(?![^(]*\))/) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = clip(raw.trim().replace(/\s+/g, ' '), 160);
    if (!item || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

// =============================================================================
// Money and dates
// =============================================================================

const MONEY_TEXT = /^\$?\s*\d{1,3}(,\d{3})*(\.\d+)?$|^\$?\s*\d+(\.\d+)?$/;

/** 15000, "15000" or "$15000" -> "$15,000" (cents kept: "$99.50"); any other text stays as written. */
export function moneyText(value: unknown): string {
  const raw = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value.replace(/ /g, ' ').trim() : '';
  if (!raw) return '';
  const numeric = typeof value === 'number' ? value : MONEY_TEXT.test(raw) ? Number(raw.replace(/[$,\s]/g, '')) : Number.NaN;
  if (!Number.isFinite(numeric)) return raw;
  const digits = Number.isInteger(numeric) ? 0 : 2;
  return `$${numeric.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Excel serial numbers this side of 2000-01-01 .. 2099-12-31 (anything else is not read as a date). */
const SERIAL_MIN = 36526;
const SERIAL_MAX = 73050;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/**
 * A date that lost its formatting and shows as Excel's serial number (46387, or "46387.7083"
 * with a time of day) -> its date, and the time ("HH:MM") when it isn't midnight. Null otherwise.
 */
export function excelSerialDate(value: unknown): { date: string; time: string | null } | null {
  const serial = typeof value === 'number' ? value : typeof value === 'string' && /^\d{5}(?:\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(serial) || serial < SERIAL_MIN || serial >= SERIAL_MAX + 1) return null;
  // Rounded to the second: serials carry floating-point noise (16:59:59.997 is 17:00).
  const at = new Date(Math.round((EXCEL_EPOCH_MS + serial * 86_400_000) / 1000) * 1000);
  return dateAndTime(at);
}

/** A Date's calendar date and its time of day ("HH:MM", null at midnight), both read in UTC as Excel stores them. */
export function dateAndTime(date: Date): { date: string; time: string | null } | null {
  if (Number.isNaN(date.getTime())) return null;
  const iso = new Date(Math.round(date.getTime() / 1000) * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) === '00:00:00' ? null : iso.slice(11, 16) };
}

/** What deadline_notes says about a time of day on the deadline. */
export function dueAtNote(time: string | null): string | null {
  return time ? `Due at ${time}` : null;
}

/** "Due at 17:00" in front of the other deadline notes (once), within the notes' length cap. */
export function withDueAt(time: string | null, notes: string | null | undefined, max = 600): string | null {
  const due = dueAtNote(time);
  const rest = (notes ?? '').trim();
  if (!due) return rest || null;
  if (rest.toLowerCase().startsWith(due.toLowerCase())) return clip(rest, max);
  return clip(rest ? `${due}; ${rest}` : due, max);
}

/**
 * A deadline as stored: text as written, except an Excel serial number (46387), which becomes
 * its YYYY-MM-DD (and its time of day, when it has one, for deadline_notes).
 */
export function deadlineValue(value: unknown): { deadline: string; time: string | null } {
  const serial = excelSerialDate(value);
  if (serial) return { deadline: serial.date, time: serial.time };
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  return { deadline: raw, time: null };
}

/**
 * When the record was last checked: 2026-10-01 (or with a time), 10/01/2026, October 1, 2026, or an
 * Excel serial number. A date after today (a typo, or a date not reached yet) -> null.
 */
export function lastVerifiedDate(value: unknown, today = todayIso()): string | null {
  const raw = text(value);
  if (!raw) return null;
  const date = isoDateOrNull(raw) ?? parseDate(raw) ?? excelSerialDate(value)?.date ?? null;
  return date && date <= today ? date : null;
}

// =============================================================================
// Religious eligibility
// =============================================================================

/** Organizations (who applies), as opposed to activities (what the money pays for). */
const ORG_NOUNS = String.raw`(?:organizations?|orgs?|institutions?|entities|groups|nonprofits?|non-profits?|charities|schools?|applicants|agencies|bodies|501c3s?)`;
const NOT_RELIGIOUS = String.raw`(?:secular|non-?religious|non-?sectarian|non-?faith-based)`;
const PUBLIC_SCHOOLS = String.raw`public\s+(?:(?:and|or|&)\s+(?:public\s+)?charter\s+|charter\s+)?(?:k-12\s+|elementary\s+|secondary\s+)?(?:schools?|school\s+districts?|districts?|school\s+systems?)(?:\s+(?:and|or|&)\s+(?:public\s+)?(?:charter\s+schools?|school\s+districts?|districts?))?`;
const OPEN_TO = String.raw`(?:(?:open|available)\s+(?:only\s+)?to\s+)?`;

/**
 * Only organizations that aren't religious may apply ("secular organizations only", "public
 * schools only"): a Catholic school or parish can't apply at all, whatever the money is for.
 * Read before the secular-purpose words, so "secular organizations only" is never "secular purposes".
 */
const NOT_RELIGIOUS_ORGS_ONLY: RegExp[] = [
  new RegExp(String.raw`\b${OPEN_TO}${NOT_RELIGIOUS}\s+${ORG_NOUNS}\s+only\b`),
  new RegExp(String.raw`\bonly\s+(?:open\s+to\s+|for\s+|available\s+to\s+)?${NOT_RELIGIOUS}\s+${ORG_NOUNS}\b`),
  new RegExp(String.raw`\b(?:must|shall)\s+be\s+(?:a\s+|an\s+)?${NOT_RELIGIOUS}\s+${ORG_NOUNS}\b`),
  new RegExp(String.raw`\b(?:limited|restricted)\s+to\s+${NOT_RELIGIOUS}\s+${ORG_NOUNS}\b`),
  new RegExp(String.raw`\b${OPEN_TO}${PUBLIC_SCHOOLS}\s+only\b`),
  new RegExp(String.raw`\bonly\s+(?:open\s+to\s+|for\s+|available\s+to\s+)?${PUBLIC_SCHOOLS}\b`),
  new RegExp(String.raw`\b(?:limited|restricted)\s+to\s+${PUBLIC_SCHOOLS}\b`),
];

/** Words that rule applicants out (read after the "no restrictions" phrases are taken out). */
const EXCLUDED: RegExp[] = [
  /\bexclu(?:ded|des?|ding|sions?)\b/,
  /\bineligible\b/,
  /(?:\bnot|n't|\bnever|\bno\s+longer)\s+(?:be\s+)?eligible\b/,
  /(?:\bnot|n't)\s+(?:open|available)\s+(?:to|for)\b/,
  /(?:\bnot|n't)\s+(?:accept|consider)\w*/,
  /\b(?:do|does|did|will|would|can|could|may|shall)(?:\s+not|n't)\s+(?:fund|support|award|make\s+(?:grants?|awards?)|give|grant)\b/,
  /\b(?:won't|wont|cannot|can't)\s+(?:fund|support|award|make\s+(?:grants?|awards?)|give|grant|accept|consider)\b/,
  /\b(?:cannot|can't|can\s+not|may\s+not|must\s+not|not\s+able\s+to|unable\s+to)\s+(?:apply|receive|be\s+funded|participate|qualify|benefit)\b/,
  /\b(?:do|does|will)(?:\s+not|n't)\s+qualify\b/,
  /\bnot\s+(?:be\s+)?(?:qualified|permitted|allowed|funded)\b/,
  /\b(?:must|may|can|shall)(?:\s+not|n't|not)\s+be\s+(?:a\s+|an\s+)?(?:religious|faith-based|sectarian|church|pervasively)\b/,
  new RegExp(String.raw`\bno\s+(?:religious|faith-based|sectarian|parochial|church-affiliated|denominational|private)\s+${ORG_NOUNS}\b`),
  /\bno\s+(?:churches|houses\s+of\s+worship|places\s+of\s+worship|congregations|parishes|ministries|dioceses)\b/,
  /\b(?:prohibited|barred|disqualified)\b/,
  /^(?:no|n|false|nope)(?:\s*[.!]|\s*$)/,
];

/** Words that let applicants in. */
const POSITIVE: RegExp[] = [
  /^(?:yes|y|true|yep)\b/,
  /\beligible\b/,
  /\b(?:may|can)\s+(?:also\s+)?apply\b/,
  /\bwelcome[sd]?\b/,
  /\bqualif(?:y|ies)\b/,
  /\baccept(?:s|ed)?\b/,
  /\b(?:allowed|permitted)\b/,
  /\bopen\s+to\b/,
  /\bzxopenzx\b/,
];

/** The money can't pay for religious activity (the organization may still apply). */
const SECULAR_WORDS = /\bsecular\b|\bnon-?religious\b|\bnon-?sectarian\b|\bnot\s+(?:be\s+)?(?:used\s+)?(?:for|to\s+(?:fund|support|pay\s+for))\s+(?:any\s+)?(?:religious|sectarian|worship|proselytiz|evangeli)|\bno\s+(?:religious|sectarian)\s+(?:activit|instruct|purpose|use|content|programm|education|worship|teaching|services?\b|curricul|materials?\b)/;
const RELIGIOUS_ACTIVITY = /\b(?:religious|sectarian|faith-based|spiritual)\s+(?:activit\w*|instruction|worship|purposes?|uses?|content|programm\w*|education|services?|teaching|ministr\w*|curricul\w*|materials?|events?|practices?|observances?|formation)\b|\bproselytiz\w*|\bevangeli[sz]\w*|\bworship\s+services?\b|\bfor\s+worship\b|\bcatechesis\b/;
const RELIGIOUS_ORG = new RegExp(
  String.raw`\b(?:religious|faith-based|sectarian|parochial|private|catholic|christian|church-affiliated|denominational)\s+${ORG_NOUNS}\b|\b(?:churches|houses?\s+of\s+worship|places?\s+of\s+worship|congregations?|parishes|dioceses)\b`,
);
const NEGATION = /\bnot\b|n't\b|\bno\b|\bnever\b|\bcannot\b|\bprohibited\b/;
const DOUBT = /\b(?:unclear|unknown|unsure|uncertain|not\s+(?:stated|specified|mentioned|addressed|clear|known|listed)|silent|unconfirmed|undetermined|ambiguous|whether|may\s+or\s+may\s+not|tbd|to\s+be\s+determined|case[-\s]by[-\s]case)\b/;
const SOFT = /\b(?:check|confirm|verify|ask|contact|inquire|depends|varies)\b/;

/** Phrases that mean anyone may apply: replaced by a marker before anything else is read. */
const OPEN_TO_ALL: RegExp[] = [
  /\bno\s+(?:religious\s+|faith-based\s+|denominational\s+)?(?:restrictions?|exclusions?|limitations?|prohibitions?)\b/g,
  /\bnot\s+(?:restricted|excluded|ineligible|limited|prohibited|disqualified)\b/g,
  /\b(?:ineligible|excluded|exclusions?|restrictions?|limitations?|not\s+eligible)(?:\s+[a-z-]+){0,3}?\s*[:=]\s*(?:none|n\/?a|no|nothing|false)\s*(?=$|[;.,\n])/g,
  /(?:\b(?:do|does|will|would)(?:\s+not|n't)|\bwon't)\s+(?:exclude|restrict|prohibit|discriminate\s+against|bar)\b/g,
  /\bregardless\s+of\s+(?:religio|faith|denomination|creed|affiliation)\w*/g,
  /\bwhether\s+or\s+not\b/g,
];

/** "Religious organizations: No", "Faith-based: Yes", "Excluded: yes". */
const LABEL = /^([^:]{1,80}):\s*(yes|y|true|no|n|false|eligible|not eligible|ineligible|excluded|allowed|not allowed)$/;
const NEGATIVE_LABEL = /ineligib|exclu|restrict|prohibit|not eligible|limitation/;
const RELIGIOUS_SUBJECT = /catholic|religio|faith|church|parish|parochial|christian|dioce|denomination|sectarian|private|congregation|ministr|worship|synagogue|mosque|temple/;
const GENERIC_SUBJECT = /\b(?:all|any|most|other|nonprofits?|non-profits?|501c3s?|charities|organizations|orgs|applicants|schools?|districts?|agencies|entities|institutions|groups|individuals|teachers|public)\b/;
const NARROW_SUBJECT = /\b(?:churches|church|houses?\s+of\s+worship|places?\s+of\s+worship|congregations?|parishes|parish|ministries|clergy|seminar(?:y|ies)|synagogues?|mosques?|temples?|missions?|religious\s+orders?|dioceses?)\b/g;
const BROAD_SUBJECT = /catholic|religio|faith|sectarian|parochial|private|christian|denomination|\bschools?\b|organizations?|\borgs?\b|nonprofits?/;

type ClauseVerdict = 'excluded' | 'secular' | 'eligible' | 'doubt' | 'soft' | null;
interface ClauseRead {
  verdict: ClauseVerdict;
  /** A positive statement ("eligible", "may apply", "yes")... */
  positive?: boolean;
  /** ...about religious applicants, or bare ("Catholic schools eligible", "Yes"), not only "all nonprofits eligible". */
  specific?: boolean;
  /** An exclusion of religious organizations or schools generally, not only of churches or houses of worship. */
  broad?: boolean;
}

function isSpecific(clause: string): boolean {
  return /^(?:yes|y|true|yep)\b/.test(clause) || RELIGIOUS_SUBJECT.test(clause) || !GENERIC_SUBJECT.test(clause);
}

function isBroad(clause: string): boolean {
  NARROW_SUBJECT.lastIndex = 0;
  if (!NARROW_SUBJECT.test(clause)) return true;
  return BROAD_SUBJECT.test(clause.replace(NARROW_SUBJECT, ' '));
}

function excluded(clause: string): ClauseRead {
  return { verdict: 'excluded', broad: isBroad(clause) };
}

/** One clause (a part of the statement between ";", ",", "but"...) read on its own. */
function readClause(clause: string, previous: ClauseRead | undefined): ClauseRead {
  if (clause.startsWith('zxexcept')) {
    // "All nonprofits eligible except religious organizations": the exception is ruled out (or, after an
    // exclusion - "no religious organizations except Catholic schools" - let in); "except religious
    // instruction" limits what the money pays for.
    const body = clause.slice('zxexcept'.length).trim();
    if (!body) return { verdict: null };
    if (previous?.verdict === 'excluded') return { verdict: 'eligible', positive: true, specific: isSpecific(body) };
    if (RELIGIOUS_ACTIVITY.test(body) && !RELIGIOUS_ORG.test(body)) return { verdict: 'secular' };
    return excluded(body);
  }
  if (DOUBT.test(clause)) return { verdict: 'doubt' };
  const label = LABEL.exec(clause);
  if (label) {
    const [, name, answer] = label;
    const yes = /^(?:yes|y|true|eligible|allowed)$/.test(answer);
    if (NEGATIVE_LABEL.test(name)) return yes ? excluded(name) : { verdict: 'eligible', positive: true, specific: isSpecific(name) };
    return yes ? { verdict: 'eligible', positive: true, specific: isSpecific(name) } : excluded(name);
  }
  if (NOT_RELIGIOUS_ORGS_ONLY.some((re) => re.test(clause))) return { verdict: 'excluded', broad: true };

  const ruledOut = EXCLUDED.some((re) => re.test(clause));
  const orgs = RELIGIOUS_ORG.test(clause);
  const secular = SECULAR_WORDS.test(clause) || (RELIGIOUS_ACTIVITY.test(clause) && !orgs && (ruledOut || NEGATION.test(clause)));
  const positive = POSITIVE.some((re) => re.test(clause));
  if (secular && !(ruledOut && orgs)) return { verdict: 'secular', positive, specific: positive && isSpecific(clause) };
  // In a clause that rules applicants out, "eligible" is part of it ("not eligible", "only public schools are eligible").
  if (ruledOut) return excluded(clause);
  if (positive) return { verdict: 'eligible', positive: true, specific: isSpecific(clause) };
  if (SOFT.test(clause)) return { verdict: 'soft' };
  return { verdict: null };
}

/**
 * eligible | secular_purpose_only | excluded | unclear, from the exact value or plain words; unknown -> null.
 *
 * - "No restrictions", "Not excluded", "Ineligible: none", "No exclusions", "Not restricted" -> eligible.
 * - excluded: "No", "Religious organizations are not eligible", "may not apply", "not open to",
 *   "doesn't fund", "cannot receive", "must not be a religious organization", "no religious
 *   organizations", "Religious organizations: No", "public schools only", and "secular (or
 *   nonsectarian) organizations only" (read before the secular-purpose words).
 * - secular_purpose_only: "secular programs only", "not for religious instruction", "no religious activities".
 * - eligible: "Yes", "Catholic schools eligible", "Religious orgs eligible", "may apply", "welcome".
 * - unclear: "Unclear", "Not stated: confirm with the funder", "check with the funder", and mixed
 *   statements ("Catholic schools eligible; churches excluded").
 *
 * The statement is read clause by clause (split on ";", ",", "but", "except"...): an exclusion
 * next to a positive statement about religious applicants is mixed (unclear); next to a general one
 * ("All nonprofits eligible except religious organizations") it stands.
 */
export function parseReligiousEligibility(value: unknown): ReligiousEligibility | null {
  const raw = text(value)
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;
  const exact = raw.replace(/[\s-]+/g, '_');
  if ((RELIGIOUS_ELIGIBILITY_VALUES as string[]).includes(exact)) return exact as ReligiousEligibility;

  let prepared = raw.replace(/501\s*\(\s*c\s*\)\s*\(\s*3\s*\)/g, '501c3');
  for (const re of OPEN_TO_ALL) prepared = prepared.replace(re, ' zxopenzx ');
  prepared = prepared.replace(/\b(?:except(?:\s+for)?|excluding|other\s+than)\b/g, '; zxexcept ');
  const clauses = prepared
    .split(/[;,\n|()[\]]|\.(?:\s|$)|\s-\s|\s(?:but|however|although|though|whereas|while)\s/)
    .map((clause) => clause.replace(/^[\s.:-]+|[\s.:-]+$/g, '').replace(/\s+/g, ' '))
    .filter(Boolean);

  const reads: ClauseRead[] = [];
  for (const clause of clauses) reads.push(readClause(clause, reads[reads.length - 1]));

  const any = (verdict: ClauseVerdict) => reads.some((read) => read.verdict === verdict);
  const positives = reads.filter((read) => read.positive);
  if (any('excluded')) {
    if (any('doubt') || positives.some((read) => read.specific)) return 'unclear';
    if (positives.length && reads.every((read) => read.verdict !== 'excluded' || !read.broad)) return 'unclear';
    return 'excluded';
  }
  if (any('secular')) return any('doubt') ? 'unclear' : 'secular_purpose_only';
  if (any('eligible')) return any('doubt') ? 'unclear' : 'eligible';
  if (any('doubt') || any('soft')) return 'unclear';
  return null;
}

// =============================================================================
// Who applies
// =============================================================================

/** Plain words for each kind of applicant (a regex per type, matched on lowercase text). */
const APPLICANT_WORDS: Array<[ApplicantType, RegExp]> = [
  ['school', /\b(?:schools?|academ(?:y|ies)|k-?12|school\s+districts?)\b/g],
  ['parish', /\b(?:parish(?:es)?|churches|church|congregations?|houses?\s+of\s+worship|places?\s+of\s+worship)\b/g],
  ['diocese', /\b(?:(?:arch)?dioces(?:e|es|an)|bishops?|eparch(?:y|ies))\b/g],
  ['teacher', /\b(?:teachers?|educators?|faculty|instructors?)\b/g],
  ['family', /\b(?:famil(?:y|ies)|students?|parents?|guardians?|households?)\b/g],
  ['nonprofit', /\b(?:non-?profits?|not-for-profits?|501c3s?|charit(?:y|ies))\b/g],
];
/** Where an applicant phrase's head noun ends ("teachers AT Catholic schools", "parents OF students"). */
const HEAD_END = /\b(?:at|of|in|from|for|with|who|that|which|serving|through|on\s+behalf\s+of|applies|apply|applying)\b/;

/** The kind of applicant one phrase names: the last such word before "at/of/in..." ("parish schools" -> school). */
function applicantOf(phrase: string): ApplicantType | null {
  const cut = HEAD_END.exec(phrase);
  const head = cut ? phrase.slice(0, cut.index) : phrase;
  const find = (part: string, last: boolean): ApplicantType | null => {
    let best: { at: number; type: ApplicantType } | null = null;
    for (const [type, re] of APPLICANT_WORDS) {
      re.lastIndex = 0;
      for (let found = re.exec(part); found; found = re.exec(part)) {
        if (!best || (last ? found.index > best.at : found.index < best.at)) best = { at: found.index, type };
      }
    }
    return best?.type ?? null;
  };
  return find(head, true) ?? find(phrase, false);
}

/**
 * Who submits the application, from a list or text in plain words ("Schools and teachers",
 * ["diocese"], "501(c)(3) nonprofits; churches"): schools -> school, parishes/churches -> parish,
 * dioceses/bishops -> diocese, teachers/educators -> teacher, families/students/parents -> family,
 * nonprofits/501(c)(3)s/charities -> nonprofit. Unknown words and negated phrases ("not
 * individuals") are dropped; each type once, in the order written.
 */
export function parseApplicants(value: unknown): ApplicantType[] {
  const parts = Array.isArray(value) ? asStringList(value) : typeof value === 'string' ? [value] : [];
  const out: ApplicantType[] = [];
  for (const part of parts) {
    const normalized = part
      .toLowerCase()
      .replace(/501\s*\(\s*c\s*\)\s*\(\s*3\s*\)/g, '501c3')
      .replace(/\([^)]*\)/g, ' ');
    for (const phrase of normalized.split(/[,;/\n|&+]|\band\b|\bor\b/)) {
      const trimmed = phrase.trim();
      if (!trimmed || /\b(?:not|no|never|except|excluding|ineligible)\b/.test(trimmed)) continue;
      const type = applicantOf(trimmed);
      if (type && !out.includes(type)) out.push(type);
    }
  }
  return out;
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

/** Only http(s) links, at most a few (a link is never cut: one longer than 2,000 characters is dropped). */
export function sourceList(value: unknown, maxItems = 6): string[] {
  const items = Array.isArray(value) ? asStringList(value) : typeof value === 'string' ? value.split(/[;\n]|,(?![^(]*\))/) : [];
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (item.length > 2000 || !/^https?:\/\/\S+$/i.test(item) || out.includes(item)) continue;
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
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

/** A value that says the funder doesn't publish it ("Not published", "N/A", "Unknown", "None"): treated as empty. "Varies" is kept. */
const NO_VALUE = /^(?:n\/?a|none|unknown|not\s+(?:published|available|stated|disclosed|listed|specified|found|known)|none\s+(?:found|published|listed|stated)|tbd|to\s+be\s+determined|-+|\?+)\.?$/i;

/** Typical award: a number becomes money ("$5,000"); "Not published", "N/A", "Unknown", "None"... -> null. */
function typicalAward(value: unknown): string | null {
  const raw = typeof value === 'number' ? moneyText(value) : detailText(value, 300);
  if (!raw || NO_VALUE.test(raw) || /^not\s+published\b/i.test(raw)) return null;
  return moneyText(raw);
}

/**
 * Whether a Catholic school may apply, and the funder's words on it. The value comes from
 * `religious_eligibility` (a code or plain words); the words are `religious_eligibility_text` when the
 * source gives them separately (web discovery), else the plain words of `religious_eligibility`
 * itself (a spreadsheet's "Religious Eligibility" column), kept even when they couldn't be read.
 * A bare code ("eligible") is not stored as words. When a code and separate words disagree about
 * an exclusion, the grant is unclear (never silently ruled in or out).
 */
function religiousDetails(data: Record<string, unknown>): { value: ReligiousEligibility | null; words: string | null } {
  const given = data.religious_eligibility;
  const givenText = detailText(given, 5000);
  const ownWords = detailText(data.religious_eligibility_text, 5000);
  const coded = parseReligiousEligibility(Array.isArray(given) ? givenText : given);
  const fromWords = ownWords ? parseReligiousEligibility(ownWords) : null;
  const value = coded && fromWords && (coded === 'excluded') !== (fromWords === 'excluded') ? 'unclear' : coded ?? fromWords;
  const isCode = (words: string) => (RELIGIOUS_ELIGIBILITY_VALUES as string[]).includes(words.toLowerCase().replace(/[\s-]+/g, '_'));
  const words = ownWords && !isCode(ownWords) ? ownWords : givenText && !isCode(givenText) ? givenText : null;
  return { value, words: words ? clip(words, 300) : null };
}

/**
 * The optional detail fields of a grant record from a loose dict (seed file, spreadsheet row, Claude's JSON).
 * religious_eligibility_text and applicants are only present when the source gave them.
 */
export function parseGrantDetails(
  data: Record<string, unknown>,
  today = todayIso(),
): Pick<
  GrantBase,
  | 'deadline_notes'
  | 'geography'
  | 'religious_eligibility'
  | 'focus_areas'
  | 'typical_award'
  | 'last_verified'
  | 'confidence'
  | 'sources'
  | 'funder_intel'
  | 'religious_eligibility_text'
  | 'applicants'
> {
  const confidence = text(data.confidence).toLowerCase();
  const religious = religiousDetails(data);
  const applicants = parseApplicants(data.applicants);
  return {
    deadline_notes: detailText(data.deadline_notes, 600),
    geography: detailText(data.geography, 300),
    religious_eligibility: religious.value,
    focus_areas: detailList(data.focus_areas),
    typical_award: typicalAward(data.typical_award),
    last_verified: lastVerifiedDate(data.last_verified, today),
    confidence: confidence === 'verified' || confidence === 'partial' ? confidence : null,
    sources: sourceList(data.sources),
    funder_intel: parseFunderIntel(data.funder_intel),
    ...(religious.words ? { religious_eligibility_text: religious.words } : {}),
    ...(applicants.length ? { applicants } : {}),
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
    applicants: Array.isArray(grant.applicants) ? grant.applicants : [],
    religious_eligibility_text: grant.religious_eligibility_text ?? null,
    ...(grant.status ? { status: grant.status } : {}),
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
