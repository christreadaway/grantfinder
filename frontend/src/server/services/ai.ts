/**
 * AI processing for matching: website scan, questionnaire, document signals,
 * and grant scoring. Port of backend/services/ai_service.py plus the
 * profile-merge rules from backend/routers/processing.py.
 *
 * Prompts are the Python text verbatim, except that the document prompt also
 * asks for citable key facts (they become profile evidence for the writer).
 * Claude is only called through the job's client (claude.ts) and answers are
 * parsed leniently (json.ts).
 * Fatal Claude errors (bad key, no credits, unknown model) always propagate;
 * where the Python silently fell back, the fallback here says plainly that
 * it is not an AI assessment.
 *
 * Background job handlers import this file, so it must stay free of heavy
 * dependencies (mammoth, docx, exceljs).
 */
import crypto from 'node:crypto';

import type { Claude } from '../claude';
import { MAX_QUESTIONNAIRE_QUESTIONS, testMode } from '../config';
import { deadlinePassed, todayIso } from '../deadlines';
import { ClaudeError, errorMessage, isFatalClaudeError } from '../errors';
import { asInt, asNumber, asRecord, asString, asStringList, clamp, extractJsonArray, extractJsonObject } from '../json';
import { logger } from '../log';
import { getFoundations, getGrants, listMatchSessionIds } from '../repo';
import { keyPart } from '../store';
import {
  normalizeProfile,
  type DocumentExtractionResult,
  type Foundation,
  type GeoQualified,
  type Grant,
  type GrantCategory,
  type GrantMatch,
  type MatchResults,
  type MatchScoreBreakdown,
  type MatchScoreTier,
  type OrganizationProfile,
  type Questionnaire,
  type QuestionnaireAnswer,
  type QuestionnaireQuestion,
  type WebsiteScanResult,
} from '../types';

// =============================================================================
// Constants
// =============================================================================

export const PROMPT_IDS = {
  scan: 'website_scan_v1',
  questionnaire: 'questionnaire_v1',
  documents: 'document_signals_v1',
  match: 'grant_match_batch_v1',
} as const;

/** Python: batches of 10 grants, at most 4 scored at once (asyncio.Semaphore(4)). */
export const MATCH_BATCH_SIZE = 10;
export const MATCH_CONCURRENCY = 4;
/**
 * Direct job mode (each step must end within about a minute): every batch
 * is scored at once, up to this many, so a typical database is scored in one
 * request.
 */
export const MATCH_DIRECT_CONCURRENCY = 8;
/** Direct mode: a scoring call starts only with about this much time left (one call). */
export const MATCH_BATCH_ROOM_MS = 25_000;
/** Direct mode: at most this many parts (about a minute each) to score grants that didn't fit. */
export const MATCH_MAX_PARTS = 12;
/** Match results expire 90 days after they are created (spec v2.6). */
export const MATCH_EXPIRY_DAYS = 90;
/**
 * Characters of a document sent to Claude (a hard cap). The Python sent
 * 30,000, which cut most grant reports off before their results and numbers.
 */
export const DOCUMENT_TEXT_LIMIT = 60000;
/** At most this many key facts are kept from one document. */
export const MAX_KEY_FACTS = 15;
/**
 * The shared profile keeps at most this many evidence items. When a document
 * pushes it over, the oldest items taken from documents go first; items the
 * person or the writer added are never removed here.
 */
export const MAX_PROFILE_EVIDENCE = 200;
/** The Python summarized the first 50 grants for the questionnaire prompt. */
export const QUESTIONNAIRE_GRANT_SAMPLE = 50;
/** Every grant that Claude did not actually score has an explanation starting with this. */
export const NOT_AI_SCORED = 'Not AI-scored:';

const TX_STATE_VALUES = new Set(['TX', 'TEXAS']);

// =============================================================================
// Small helpers
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Comparison key for de-duplicating list items: case, spacing and trailing punctuation ignored. */
export function itemKey(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/[.;,:!]+$/, '').trim();
}

/** `existing` plus the incoming items it doesn't already have (case-insensitive). Blanks are dropped. */
export function mergeUnique(existing: string[], incoming: string[]): string[] {
  const out = [...existing];
  const seen = new Set(existing.map(itemKey));
  for (const raw of incoming) {
    const item = String(raw ?? '').trim();
    const key = itemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function addUnique(list: string[], entry: string): string[] {
  return mergeUnique(list, [entry]);
}

/** Lenient boolean (pydantic-style strings like "yes"/"false" included). */
export function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 't'].includes(v)) return true;
    if (['false', 'no', 'n', '0', 'off', 'f'].includes(v)) return false;
  }
  return fallback;
}

/** Strings the model uses for "nothing found", plus echoes of the prompt's own template. */
const EMPTY_ANSWER_RE = /^(n\/?a|none|null|nil|unknown|tbd|-+|\?+|not (found|mentioned|provided|available|listed|specified|stated|given|applicable)|no (info|information|data))$/i;
const TEMPLATE_ECHOES = new Set([
  'parish/school name', 'city', 'state', 'state (2-letter code)', 'diocese name if mentioned',
  'full address if found', 'pastor name if found', 'principal name if found', 'school name',
  'grade levels served', 'accreditation info if mentioned',
]);

/** A trimmed string value, or '' when the model said "unknown" or echoed the template. */
export function cleanText(value: unknown): string {
  const text = asString(value).trim();
  if (!text || EMPTY_ANSWER_RE.test(text) || TEMPLATE_ECHOES.has(text.toLowerCase())) return '';
  return text;
}

function hasRealValue(value: unknown): boolean {
  if (typeof value === 'string') return cleanText(value) !== '';
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (Array.isArray(value)) return value.some(hasRealValue);
  if (isRecord(value)) return Object.values(value).some(hasRealValue);
  return value === true;
}

/** A list of strings from a list, or from a single non-empty string. */
function stringItems(value: unknown): string[] {
  if (Array.isArray(value)) return asStringList(value).map((item) => item.trim()).filter(Boolean);
  const single = cleanText(value);
  return single ? [single] : [];
}

/**
 * Half of an emoji (a lone UTF-16 surrogate, e.g. left by cutting text at a
 * character limit) makes the Claude API reject the whole request as invalid
 * JSON. Replaced with U+FFFD, which keeps the length unchanged.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD');
}

/** The first `limit` characters of `text`, never ending in half an emoji. */
export function cutText(text: string, limit: number): string {
  let cut = text;
  if (text.length > limit) {
    cut = text.slice(0, limit);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  }
  return wellFormed(cut);
}

/** The same minimal profile the Python created before the first scan/answers. */
export function minimalProfile(userId: string): OrganizationProfile {
  return normalizeProfile({ user_id: userId, organization_name: '', organization_type: 'parish', city: '', state: '', sources: [] });
}

// =============================================================================
// US states (questionnaire and scan answers -> profile.state)
// =============================================================================

const US_STATES: Array<[string, string]> = [
  ['AL', 'alabama'], ['AK', 'alaska'], ['AZ', 'arizona'], ['AR', 'arkansas'], ['CA', 'california'],
  ['CO', 'colorado'], ['CT', 'connecticut'], ['DE', 'delaware'], ['FL', 'florida'], ['GA', 'georgia'],
  ['HI', 'hawaii'], ['ID', 'idaho'], ['IL', 'illinois'], ['IN', 'indiana'], ['IA', 'iowa'],
  ['KS', 'kansas'], ['KY', 'kentucky'], ['LA', 'louisiana'], ['ME', 'maine'], ['MD', 'maryland'],
  ['MA', 'massachusetts'], ['MI', 'michigan'], ['MN', 'minnesota'], ['MS', 'mississippi'], ['MO', 'missouri'],
  ['MT', 'montana'], ['NE', 'nebraska'], ['NV', 'nevada'], ['NH', 'new hampshire'], ['NJ', 'new jersey'],
  ['NM', 'new mexico'], ['NY', 'new york'], ['NC', 'north carolina'], ['ND', 'north dakota'], ['OH', 'ohio'],
  ['OK', 'oklahoma'], ['OR', 'oregon'], ['PA', 'pennsylvania'], ['RI', 'rhode island'], ['SC', 'south carolina'],
  ['SD', 'south dakota'], ['TN', 'tennessee'], ['TX', 'texas'], ['UT', 'utah'], ['VT', 'vermont'],
  ['VA', 'virginia'], ['WA', 'washington'], ['WV', 'west virginia'], ['WI', 'wisconsin'], ['WY', 'wyoming'],
  ['DC', 'district of columbia'], ['DC', 'washington dc'], ['PR', 'puerto rico'], ['GU', 'guam'],
  ['VI', 'virgin islands'], ['VI', 'us virgin islands'], ['AS', 'american samoa'], ['MP', 'northern mariana islands'],
];
const STATE_CODES = new Set(US_STATES.map(([code]) => code));
const STATE_BY_NAME = new Map(US_STATES.map(([code, name]) => [name, code]));

/** "Texas", "TX", "tx.", "Texas, USA", "TX - Diocese of X" -> "TX". Anything else -> null. */
export function usStateCode(value: string): string | null {
  const cleaned = value.toLowerCase().replace(/\./g, '').trim();
  const whole = cleaned.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const head = cleaned.split(/[,(/]|\s[-–]\s/)[0].replace(/\s+/g, ' ').trim();
  for (const candidate of [whole, head]) {
    if (/^[a-z]{2}$/.test(candidate) && STATE_CODES.has(candidate.toUpperCase())) return candidate.toUpperCase();
    const byName = STATE_BY_NAME.get(candidate);
    if (byName) return byName;
  }
  return null;
}

// =============================================================================
// Prompt 1: website scan
// =============================================================================

export function buildScanPrompt(websiteContent: string): string {
  return `Analyze these Catholic parish/school website(s) and extract structured information.

${wellFormed(websiteContent)}

Extract and return a JSON object with:
{
    "organization_basics": {
        "name": "Parish/School name",
        "city": "City",
        "state": "State (2-letter code)",
        "diocese": "Diocese name if mentioned",
        "address": "Full address if found"
    },
    "leadership": {
        "pastor": "Pastor name if found",
        "principal": "Principal name if found",
        "staff": ["Other key staff mentioned"]
    },
    "school_info": {
        "name": "School name",
        "grades": "Grade levels served",
        "student_count": number or null,
        "accreditation": "Accreditation info if mentioned"
    },
    "facilities": ["List of facilities/buildings mentioned"],
    "current_initiatives": ["List of programs, projects, or initiatives mentioned"]
}

If school website is not provided or no school info found, set school_info to null.
Return ONLY the JSON object, no other text.`;
}

/** The model's answer as a WebsiteScanResult, or null when no JSON object could be found. */
export function parseScanResult(text: string, extractedTextLength: number): WebsiteScanResult | null {
  const data = extractJsonObject(text);
  if (!data) return null;
  return {
    organization_basics: asRecord(data.organization_basics),
    leadership: asRecord(data.leadership),
    school_info: isRecord(data.school_info) ? data.school_info : null,
    facilities: stringItems(data.facilities),
    current_initiatives: stringItems(data.current_initiatives),
    extracted_text_length: extractedTextLength,
  };
}

export interface ScanTargets {
  churchUrl: string | null;
  schoolUrl: string | null;
  /** The URLs that actually returned text. */
  urlsRead: string[];
}

/**
 * Python merge rules (routers/processing.py scan_website), minus its data
 * loss: a value the scan didn't find never overwrites one the profile has,
 * and current initiatives are added to, not replaced.
 */
export function mergeScanIntoProfile(profile: OrganizationProfile, result: WebsiteScanResult, targets: ScanTargets): OrganizationProfile {
  const next: OrganizationProfile = { ...profile };
  if (targets.churchUrl) next.website_url = targets.churchUrl;
  if (targets.schoolUrl) next.school_website_url = targets.schoolUrl;

  const basics = result.organization_basics;
  if (Object.keys(basics).length) {
    next.organization_name = cleanText(basics.name) || next.organization_name;
    next.city = cleanText(basics.city) || next.city;
    const state = cleanText(basics.state);
    if (state) next.state = usStateCode(state) ?? state;
    next.diocese = cleanText(basics.diocese) || next.diocese || null;
  }

  const leadership = result.leadership;
  if (Object.keys(leadership).length) {
    next.pastor_name = cleanText(leadership.pastor) || next.pastor_name || null;
    next.principal_name = cleanText(leadership.principal) || next.principal_name || null;
  }

  // The Python set has_school for any non-empty dict, even one full of nulls.
  if (result.school_info && hasRealValue(result.school_info)) {
    next.has_school = true;
    const students = asInt(result.school_info.student_count);
    if (students !== null && students > 0) next.student_count = students;
  }

  next.current_initiatives = mergeUnique(next.current_initiatives, result.current_initiatives);
  if (targets.urlsRead.length) next.sources = addUnique(next.sources, `Website scan: ${targets.urlsRead.join(', ')}`);
  return next;
}

// =============================================================================
// Prompt 2: questionnaire
// =============================================================================

export const questionnaireKey = (userId: string) => `questionnaires/${keyPart(userId)}`;

/** The last questionnaire shown to a user, so submitted answers map back to question text. */
export interface StoredQuestionnaire extends Questionnaire {
  created_at: string;
  /** "ai" when Claude wrote it, "default" for the standard questions. */
  source: string;
}

export function buildQuestionnairePrompt(grants: Grant[]): string {
  const grantSummary = grants.slice(0, QUESTIONNAIRE_GRANT_SAMPLE).map((grant) => ({
    name: grant.grant_name,
    funder: grant.funder,
    description: asString(grant.description).slice(0, 200),
    geo_qualified: grant.geo_qualified,
  }));
  return `You are helping a Catholic parish or school find grant opportunities.

Based on these grants, generate a smart questionnaire to gather information needed to match organizations with appropriate grants. The questionnaire should focus on eligibility criteria commonly found in these grants.

GRANTS DATABASE (sample):
${JSON.stringify(grantSummary, null, 2)}

Generate a questionnaire with EXACTLY ${MAX_QUESTIONNAIRE_QUESTIONS} or fewer questions that will help determine:
1. Basic eligibility (501c3 status, Catholic affiliation, location)
2. Organization type and size
3. Current programs and services
4. Facility needs and conditions
5. Security concerns
6. Financial capacity
7. Past grant experience

Return a JSON array of questions:
[
    {
        "id": 1,
        "question": "Question text",
        "question_type": "boolean|text|select|multiselect",
        "options": ["option1", "option2"] (for select/multiselect only),
        "required": true/false,
        "grant_relevance": ["Grant names this question helps evaluate"]
    }
]

Make questions clear, specific, and relevant to Catholic parish/school contexts.
Return ONLY the JSON array, no other text.`;
}

/** The website renders boolean, text, and select; map the model's synonyms onto the four types. */
function normalizeQuestionType(value: unknown): string {
  const type = asString(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['boolean', 'bool', 'yes_no', 'yes/no', 'yesno', 'true_false', 'true/false', 'checkbox_single'].includes(type)) return 'boolean';
  if (['select', 'single_select', 'dropdown', 'multiple_choice', 'choice', 'radio', 'single_choice', 'enum'].includes(type)) return 'select';
  if (['multiselect', 'multi_select', 'multiple_select', 'multiselection', 'multi_choice', 'checkbox', 'checkboxes', 'multiple_selection'].includes(type)) return 'multiselect';
  return 'text';
}

/** The model's questions (at most MAX_QUESTIONNAIRE_QUESTIONS), or null when none were usable. */
export function parseQuestionnaire(text: string): Questionnaire | null {
  let raw: unknown[] | null = extractJsonArray<unknown>(text);
  if (!raw || !raw.some(isRecord)) {
    const wrapper = extractJsonObject(text);
    raw = wrapper && Array.isArray(wrapper.questions) ? wrapper.questions : null;
  }
  if (!raw) return null;

  const questions: QuestionnaireQuestion[] = [];
  const usedIds = new Set<number>();
  for (const item of raw) {
    if (questions.length >= MAX_QUESTIONNAIRE_QUESTIONS) break;
    if (!isRecord(item)) continue;
    const question = asString(item.question ?? item.text).trim();
    if (!question) continue;
    // Answers are mapped back by id, so ids must be unique positive integers.
    let id = asInt(item.id);
    if (id === null || id < 1 || usedIds.has(id)) {
      id = 1;
      while (usedIds.has(id)) id++;
    }
    usedIds.add(id);
    let questionType = normalizeQuestionType(item.question_type ?? item.type);
    const options = asStringList(item.options).map((option) => option.trim()).filter(Boolean);
    if ((questionType === 'select' || questionType === 'multiselect') && options.length === 0) questionType = 'text';
    questions.push({
      id,
      question,
      question_type: questionType,
      options: options.length ? options : null,
      required: asBool(item.required, true),
      grant_relevance: asStringList(item.grant_relevance),
    });
  }
  if (!questions.length) return null;
  return { questions, total_questions: questions.length };
}

/** Python's _get_default_questionnaire: used when Claude is unavailable (never for fatal errors). */
export function defaultQuestionnaire(): Questionnaire {
  const q = (
    id: number,
    question: string,
    questionType: string,
    grantRelevance: string[],
    options: string[] | null = null,
  ): QuestionnaireQuestion => ({ id, question, question_type: questionType, options, required: true, grant_relevance: grantRelevance });
  const questions = [
    q(1, 'Is your organization a registered 501(c)(3) nonprofit?', 'boolean', ['All grants']),
    q(2, 'What type of organization are you?', 'select', ['All grants'], ['Parish only', 'School only', 'Parish with school']),
    q(3, 'In which state is your organization located?', 'text', ['Geographic grants']),
    q(4, 'What is your approximate annual operating budget?', 'select', ['Capacity-based grants'], ['Under $250,000', '$250,000-$500,000', '$500,000-$1M', 'Over $1M']),
    q(5, 'Do you have any current facility repair or renovation needs?', 'boolean', ['Facility grants']),
    q(6, 'Do you operate a food pantry or food assistance program?', 'boolean', ['Hunger relief grants']),
    q(7, 'Have you received grant funding in the past 3 years?', 'boolean', ['All grants']),
    q(8, 'Do you have security concerns or need security improvements?', 'boolean', ['Security grants']),
  ];
  return { questions, total_questions: questions.length };
}

/** Python's str(answer), except lists read "a, b" instead of "['a', 'b']". */
function answerText(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(answerText).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A question's text as a comparison key: trimmed, with case and spacing ignored. */
export function questionKey(question: unknown): string {
  return typeof question === 'string' ? question.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

/** No answer at all: nothing, empty text, or a list of those (an emptied text box, "Select...", no boxes ticked). */
export function isBlankAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.every(isBlankAnswer);
  return false;
}

/**
 * Questionnaire answers are never erased. Earlier answers stay in their
 * order; a new answer to the same question (same text, ignoring case and
 * spacing) replaces the earlier one in place (an older duplicate of that
 * question is dropped, since it would contradict the new answer); answers to
 * questions not seen before are added at the end.
 */
export function mergeQuestionnaireAnswers(
  existing: Array<Record<string, unknown>>,
  incoming: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged = [...existing];
  const positions = new Map<string, number[]>();
  merged.forEach((entry, index) => {
    const key = questionKey(entry?.question);
    if (!key) return;
    positions.set(key, [...(positions.get(key) ?? []), index]);
  });
  const superseded = new Set<number>();
  for (const pair of incoming) {
    const key = questionKey(pair.question);
    const at = key ? positions.get(key) : undefined;
    if (at) {
      merged[at[0]] = pair;
      at.slice(1).forEach((index) => superseded.add(index));
      positions.set(key, [at[0]]);
    } else {
      if (key) positions.set(key, [merged.length]);
      merged.push(pair);
    }
  }
  return merged.filter((_, index) => !superseded.has(index));
}

/** true/false for a clear yes or no (true, "No", "Yes, through the diocese"); null for anything else. */
export function yesNoValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = answerText(value).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(text)) return true;
  if (['false', 'no', 'n', '0'].includes(text)) return false;
  if (/^(yes|yeah|yep)\b/.test(text)) return true;
  if (/^(no|nope)\b/.test(text)) return false;
  return null;
}

/**
 * The answer to a 501(c)(3) question. Catholic parishes and schools are
 * usually exempt through the USCCB group ruling (listed in the Official
 * Catholic Directory), so an answer that says so counts as yes.
 */
function taxExemptAnswer(value: unknown): boolean | null {
  const text = answerText(value).toLowerCase();
  if (/group (ruling|exemption)|usccb|official catholic directory/.test(text) && !/\bnot\b|n['\u2019]t\b/.test(text)) return true;
  return yesNoValue(value);
}

/** A yes/no question that asks whether the organization has (runs, sponsors...) a school. */
const HAS_SCHOOL_QUESTION = /\b(have|has|operate|operates|run|runs|sponsor|sponsors|include|includes|support|supports|own|owns|is there|affiliated|associated|attached)\b[^?]*\bschool/;
/** ...and not one about something else that merely mentions the school ("security concerns at your school?"). */
const OTHER_SCHOOL_TOPIC = /secur|safety|concern|repair|renovat|need|budget|grant|fund|enrol|accredit|tuition|transport|meal|lunch/;

/**
 * Port of submit_questionnaire's mapping of well-known questions onto profile
 * fields. Every answer is also kept verbatim in questionnaire_answers, merged
 * with the earlier answers (mergeQuestionnaireAnswers): the Python replaced
 * the whole list, so answering a second questionnaire erased the first.
 * Blank answers are skipped: they never replace an earlier answer.
 * Fixes: has_school only follows a yes/no question about having a school
 * (the Python let "Is your school accredited?" -> No, or "Security concerns
 * at your school?" -> No, set has_school to false); a state is only taken
 * from an answer that names a US state (the Python stored "True" as the
 * state for "Do you own real estate?"); the organization-type question now
 * sets organization_type/has_school; 501(c)(3) and food pantry change only
 * on a clear yes or no (the Python turned "Yes, through the USCCB group
 * ruling" into "not a 501(c)(3)"); a yes/no answer is never saved as the
 * annual budget.
 */
export function applyQuestionnaireAnswers(
  profile: OrganizationProfile,
  answers: QuestionnaireAnswer[],
  freeFormText: string | null,
  questionsById: Map<number, string>,
): OrganizationProfile {
  const next: OrganizationProfile = { ...profile };
  const qaPairs: Array<Record<string, unknown>> = [];
  for (const { question_id: questionId, answer, question } of answers) {
    if (isBlankAnswer(answer)) continue;
    const questionText = (typeof question === 'string' && question.trim()) || questionsById.get(questionId)?.trim() || `Question ${questionId}`;
    qaPairs.push({ question: questionText, answer });

    const q = questionText.toLowerCase();
    const answerStr = answerText(answer).trim();
    const lower = answerStr.toLowerCase();
    const isYes = ['true', 'yes', 'y', '1'].includes(lower);
    const yesNo = typeof answer === 'boolean' || ['true', 'false', 'yes', 'no'].includes(lower);
    const schoolDecides = q.includes('school') && !q.includes('grade') &&
      (yesNo ? HAS_SCHOOL_QUESTION.test(q) && !OTHER_SCHOOL_TOPIC.test(q) : lower.includes('school'));

    if (q.includes('501')) {
      const exempt = taxExemptAnswer(answer);
      if (exempt !== null) next.is_501c3 = exempt;
    } else if (q.includes('food pantry') || q.includes('food assistance')) {
      const pantry = yesNoValue(answer);
      if (pantry !== null) next.has_food_pantry = pantry;
    } else if (schoolDecides) {
      next.has_school = yesNo ? isYes : true;
    } else if (q.includes('state') && answerStr && answerStr.length <= 30) {
      const code = yesNo ? null : usStateCode(answerStr);
      if (code && !next.state) next.state = code;
    } else if (q.includes('budget') && answerStr && !yesNo) {
      next.annual_budget = answerStr;
    } else if (q.includes('grant') && (q.includes('past') || q.includes('previous') || q.includes('received'))) {
      if (answerStr && !yesNo && lower !== 'none') next.previous_grants = addUnique(next.previous_grants, answerStr);
    } else if ((q.includes('type of organization') || q.includes('organization type')) && answerStr && !yesNo) {
      const parish = lower.includes('parish') || lower.includes('church');
      const school = lower.includes('school');
      if (parish && school && !lower.includes('only')) {
        next.organization_type = 'both';
        next.has_school = true;
      } else if (school) {
        next.organization_type = 'school';
        next.has_school = true;
      } else if (parish) {
        next.organization_type = 'parish';
      }
    }
  }
  next.questionnaire_answers = mergeQuestionnaireAnswers(next.questionnaire_answers, qaPairs);
  if (freeFormText) {
    next.free_form_notes = freeFormText;
    next.sources = addUnique(next.sources, 'User free-form text');
  }
  next.sources = addUnique(next.sources, 'Questionnaire responses');
  return next;
}

// =============================================================================
// Prompt 3: document signals
// =============================================================================

/**
 * The Python prompt (needs and signals) plus key facts: the numbers and
 * results a grant writer cites, which "focus on actionable needs" left out.
 */
export function buildDocumentPrompt(text: string, filename: string): string {
  return `Analyze this document from a Catholic parish or school and extract information relevant to grant applications.

DOCUMENT: ${wellFormed(filename)}
CONTENT:
${cutText(text, DOCUMENT_TEXT_LIMIT)}

Extract and categorize any mentions of:
1. Facility needs (repairs, renovations, equipment)
2. Program needs (new programs, program expansions, staffing)
3. Security concerns (safety issues, security equipment needs)
4. Other grant-relevant signals (financial challenges, growth opportunities, community needs)
5. Key facts a grant writer could cite: enrollment and demographics, percentages (for example, the share of families receiving tuition assistance), outcomes and results, prior grants received (funder, amount, and year), program descriptions, staff counts, founding year

IMPORTANT: Ignore irrelevant content like mass times, prayer intentions, event announcements.
For items 1-4, focus on actionable needs that could be addressed with grant funding.
For key facts:
- Include only facts this document states. Never invent, estimate, round, or calculate a number.
- Write each fact as one short sentence that keeps the document's own numbers and wording, with the year or time period when the document gives one.
- List at most ${MAX_KEY_FACTS}, the most useful for a grant application first. Leave out the names of students and families.
- If the document states no such facts, return an empty list.

Return a JSON object:
{
    "facility_needs": ["List of specific facility needs mentioned"],
    "program_needs": ["List of specific program needs mentioned"],
    "security_concerns": ["List of specific security concerns mentioned"],
    "other_signals": ["Other relevant information for grant matching"],
    "key_facts": ["Concrete facts stated in the document, one short sentence each"]
}

Return ONLY the JSON object, no other text.`;
}

export interface DocumentSignals {
  facility_needs: string[];
  program_needs: string[];
  security_concerns: string[];
  other_signals: string[];
  key_facts: string[];
}

/** The document prompt's own placeholder lines, which a model sometimes echoes when it found nothing. */
const DOCUMENT_TEMPLATE_ECHOES = new Set([
  'list of specific facility needs mentioned',
  'list of specific program needs mentioned',
  'list of specific security concerns mentioned',
  'other relevant information for grant matching',
  'concrete facts stated in the document, one short sentence each',
]);

const notTemplateEcho = (item: string) => !DOCUMENT_TEMPLATE_ECHOES.has(itemKey(item));

/** Key facts as plain sentences: list or single text, {"fact": ...} objects read, bullets and blanks dropped, at most MAX_KEY_FACTS. */
function factItems(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const facts: string[] = [];
  for (const item of raw) {
    const record = isRecord(item) ? item : null;
    const text = typeof item === 'string' ? item : record ? asString(record.fact ?? record.text ?? record.summary ?? record.statement) : '';
    const fact = cleanText(text.replace(/\s+/g, ' ').replace(/^(?:[-*\u2022]|\d{1,2}[.)])\s+/, ''));
    if (fact && notTemplateEcho(fact)) facts.push(fact);
  }
  return mergeUnique([], facts).slice(0, MAX_KEY_FACTS);
}

/**
 * The signal lists and key facts, or null when the answer had no JSON object.
 * An answer without key_facts (the Python format) gives an empty list.
 */
export function parseDocumentSignals(text: string): DocumentSignals | null {
  const data = extractJsonObject(text);
  if (!data) return null;
  const list = (value: unknown) => mergeUnique([], stringItems(value).filter(notTemplateEcho));
  return {
    facility_needs: list(data.facility_needs),
    program_needs: list(data.program_needs),
    security_concerns: list(data.security_concerns),
    other_signals: list(data.other_signals),
    key_facts: factItems(data.key_facts ?? data.facts),
  };
}

/** Stable evidence id: the same item from the same file always gets the same id. */
export function documentEvidenceId(filename: string, item: string): string {
  return `ev_${crypto.createHash('sha1').update(`${filename}\n${item}`).digest('hex').slice(0, 10)}`;
}

/** What one document added to (and, at the cap, removed from) profile.evidence. */
export interface DocumentMergeStats {
  evidence_added: number;
  evidence_dropped: number;
}

/**
 * Keep evidence at MAX_PROFILE_EVIDENCE: the oldest document items go first,
 * then (only if still needed) the oldest of `justAdded`. Items of any other
 * type (stakeholder answers, the person's own notes) are never removed.
 */
export function capEvidence(
  evidence: Array<Record<string, unknown>>,
  justAdded: ReadonlySet<Record<string, unknown>> = new Set(),
): Array<Record<string, unknown>> {
  const excess = evidence.length - MAX_PROFILE_EVIDENCE;
  if (excess <= 0) return evidence;
  const fromDocument = (entry: Record<string, unknown>) => entry?.type === 'document';
  const candidates = [
    ...evidence.filter((entry) => fromDocument(entry) && !justAdded.has(entry)),
    ...evidence.filter((entry) => fromDocument(entry) && justAdded.has(entry)),
  ];
  const dropped = new Set(candidates.slice(0, excess));
  return evidence.filter((entry) => !dropped.has(entry));
}

/**
 * Add a document's signals to the shared profile: needs lists (deduplicated,
 * case-insensitive) and one evidence entry per item and key fact, which is
 * how uploaded documents reach the GrantWriter's drafts. Evidence is
 * deduplicated by normalized text across the whole profile (so uploading the
 * same document again adds nothing) and capped at MAX_PROFILE_EVIDENCE.
 */
export function mergeDocumentIntoProfile(
  profile: OrganizationProfile,
  result: DocumentExtractionResult,
  stats?: DocumentMergeStats,
): OrganizationProfile {
  const next: OrganizationProfile = { ...profile };
  next.facility_needs = mergeUnique(next.facility_needs, result.facility_needs);
  next.program_needs = mergeUnique(next.program_needs, result.program_needs);
  next.security_concerns = mergeUnique(next.security_concerns, result.security_concerns);

  const evidence = [...next.evidence];
  const seen = new Set(evidence.map((entry) => itemKey(asString(entry?.summary))).filter(Boolean));
  const added = new Set<Record<string, unknown>>();
  const items = [
    ...result.facility_needs,
    ...result.program_needs,
    ...result.security_concerns,
    ...result.other_signals,
    ...(result.key_facts ?? []),
  ];
  for (const item of items) {
    const key = itemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = {
      id: documentEvidenceId(result.filename, item),
      type: 'document',
      summary: item,
      source_ref: `Document: ${result.filename}`,
      linked_programs: [],
    };
    evidence.push(entry);
    added.add(entry);
  }
  next.evidence = capEvidence(evidence, added);
  if (stats) {
    stats.evidence_added = next.evidence.filter((entry) => added.has(entry)).length;
    stats.evidence_dropped = evidence.length - next.evidence.length;
  }
  next.sources = addUnique(next.sources, `Document: ${result.filename}`);
  return next;
}

// =============================================================================
// Prompt 4: grant matching
// =============================================================================

export function tierFor(score: number): MatchScoreTier {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'possible';
  if (score >= 25) return 'weak';
  return 'not_eligible';
}

/** Spec v2.6 weights: eligibility 40%, need 30%, capacity 15%, timing 10%, completeness 5%. */
export const SCORE_WEIGHTS: MatchScoreBreakdown = {
  eligibility_fit: 0.4,
  need_alignment: 0.3,
  capacity_signals: 0.15,
  timing: 0.1,
  completeness: 0.05,
};

export function weightedScore(breakdown: MatchScoreBreakdown): number {
  return (Object.keys(SCORE_WEIGHTS) as Array<keyof MatchScoreBreakdown>)
    .reduce((sum, key) => sum + breakdown[key] * SCORE_WEIGHTS[key], 0);
}

function matchBase(grant: Grant): Omit<GrantMatch, 'score' | 'score_tier' | 'score_breakdown' | 'explanation' | 'evidence' | 'is_shortlisted'> {
  return {
    grant_id: grant.id,
    grant_name: asString(grant.grant_name),
    funder: asString(grant.funder),
    amount: asString(grant.amount),
    deadline: asString(grant.deadline),
    url: asString(grant.url),
    contact: asString(grant.contact),
    category: (asString(grant.category) || 'mixed') as GrantCategory,
    geo_qualified: (asString(grant.geo_qualified) || 'Check eligibility') as GeoQualified,
  };
}

/**
 * Hard disqualifiers in code, before any (billed) AI call: Texas-only grants
 * for organizations outside Texas, "No" geography, CLOSED, deadline passed.
 * Returns the not-eligible match, or null to send the grant to Claude.
 */
export function deterministicPrefilter(grant: Grant, profile: OrganizationProfile, today = todayIso()): GrantMatch | null {
  // Letters only, so "Tx." and "Texas " still count as Texas.
  const state = (profile.state || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  const geo = asString(grant.geo_qualified).trim().toLowerCase();
  const disqualified = (reason: string, timing = 0): GrantMatch => ({
    ...matchBase(grant),
    score: 0,
    score_tier: 'not_eligible',
    score_breakdown: { eligibility_fit: 0, need_alignment: 0, capacity_signals: 0, timing, completeness: 100 },
    explanation: reason,
    evidence: [],
    is_shortlisted: false,
  });

  if (geo === 'yes - tx only' && state && !TX_STATE_VALUES.has(state)) {
    return disqualified(
      `Geographic restriction: this grant is limited to Texas organizations, and your organization is in ${profile.state}.`,
    );
  }
  if (geo === 'no') {
    return disqualified("This grant's geographic restriction excludes your organization per the grant database.");
  }
  if (asString(grant.status).trim().toUpperCase() === 'CLOSED') {
    return disqualified('This grant is marked CLOSED in the database.', 0);
  }
  if (deadlinePassed(grant.deadline, today)) {
    return disqualified(`Deadline passed (${grant.deadline}). Check the funder's website for the next cycle.`, 0);
  }
  return null;
}

/**
 * Neutral placeholder for a grant Claude did not score (Python's
 * _fallback_match). It keeps the grant visible mid-list for manual review,
 * and its explanation says plainly that it is not an assessment.
 */
export function fallbackMatch(grant: Grant, explanation: string): GrantMatch {
  return {
    ...matchBase(grant),
    score: 50,
    score_tier: 'possible',
    score_breakdown: { eligibility_fit: 50, need_alignment: 50, capacity_signals: 50, timing: 50, completeness: 50 },
    explanation,
    evidence: [],
    is_shortlisted: false,
  };
}

const NOT_SCORED_UNREADABLE = `${NOT_AI_SCORED} Claude's answer could not be read. Re-run matching for a real score.`;
const NOT_SCORED_SKIPPED = `${NOT_AI_SCORED} Claude's answer skipped this grant. Re-run matching for a real score.`;
const NOT_SCORED_OUT_OF_TIME = `${NOT_AI_SCORED} matching ran out of time before reaching this grant (the background worker stops after 15 minutes). Re-run matching for a real score.`;
/** Direct mode: the step's minute ended before Claude scored this grant (a follow-up part tries again). */
export const NOT_SCORED_OUT_OF_TIME_DIRECT = `${NOT_AI_SCORED} matching ran out of time before Claude could score this grant (each step on this site can run for about a minute). Re-run matching for a real score.`;
const NOT_SCORED_UNAVAILABLE = `${NOT_AI_SCORED} Claude was unavailable (`;

/** Not scored for a passing reason (time ran out, Claude briefly unavailable): worth trying again in a follow-up part. */
export function isRetryableUnscored(match: GrantMatch): boolean {
  const text = match.explanation;
  return text === NOT_SCORED_OUT_OF_TIME || text === NOT_SCORED_OUT_OF_TIME_DIRECT || text.startsWith(NOT_SCORED_UNAVAILABLE);
}

function unavailableExplanation(error: unknown): string {
  const kind = error instanceof ClaudeError ? error.kind : 'unknown';
  const reason: Record<string, string> = {
    overloaded: 'overloaded',
    rate_limit: 'rate limit reached',
    timeout: 'timed out',
    connection: 'network problem',
  };
  return `${NOT_AI_SCORED} Claude was unavailable (${reason[kind] ?? 'error'}). Re-run matching for a real score.`;
}

/** Stable id for a foundation shown as a grant, so re-runs (and shortlists) line up. */
export function foundationGrantId(foundation: Foundation): string {
  const basis = foundation.id || foundation.foundation_name;
  return `grant_${crypto.createHash('sha1').update(`foundation:${basis}`).digest('hex').slice(0, 12)}`;
}

/**
 * Category 5 foundations join matching as monitorable opportunities, as in
 * the Python router (skipped when a grant with that name already exists).
 */
export function withFoundations(grants: Grant[], foundations: Foundation[], userId: string): Grant[] {
  const names = new Set(grants.map((grant) => asString(grant.grant_name).toLowerCase()));
  const all = [...grants];
  const now = new Date().toISOString();
  for (const foundation of foundations) {
    const pseudoName = `${foundation.foundation_name} (Foundation)`;
    if (names.has(pseudoName.toLowerCase())) continue;
    names.add(pseudoName.toLowerCase());
    all.push({
      id: foundationGrantId(foundation),
      user_id: userId,
      grant_name: pseudoName,
      deadline: foundation.application_cycle || 'Check website',
      amount: foundation.annual_giving || 'Varies',
      funder: foundation.foundation_name,
      description: `Catholic grant-making foundation to monitor. Focus areas: ${foundation.focus_areas ?? ''}. ${foundation.notes || ''}`.trim(),
      contact: foundation.contact ?? '',
      url: foundation.website ?? '',
      status: 'Check deadline',
      geo_qualified: 'Check eligibility',
      funder_stats: null,
      category: 'foundations',
      source: 'upload',
      eligibility_notes: null,
      funds_for: [],
      created_at: now,
    });
  }
  return all;
}

/**
 * A grant by id, including a foundation that matching showed as a
 * "(Foundation)" grant (stable id, not stored in the grant list). Lets the
 * writer open an application from any match.
 */
export async function getGrantOrFoundation(userId: string, grantId: string): Promise<Grant | null> {
  const grants = await getGrants(userId);
  const direct = grants.find((grant) => grant.id === grantId);
  if (direct) return direct;
  if (!/^grant_[0-9a-f]{12}$/.test(grantId)) return null;
  const foundations = await getFoundations(userId);
  return withFoundations(grants, foundations, userId).find((grant) => grant.id === grantId) ?? null;
}

export function buildMatchPrompt(grants: Grant[], profile: OrganizationProfile, today: string): string {
  const profileSummary = {
    name: profile.organization_name,
    type: profile.organization_type,
    city: profile.city,
    state: profile.state,
    has_school: profile.has_school,
    is_501c3: profile.is_501c3,
    facility_needs: profile.facility_needs,
    program_needs: profile.program_needs,
    security_concerns: profile.security_concerns,
    current_initiatives: profile.current_initiatives,
    annual_budget: profile.annual_budget ?? null,
    free_form_notes: profile.free_form_notes ?? null,
    questionnaire_answers: profile.questionnaire_answers,
    previous_grants: profile.previous_grants,
    student_count: profile.student_count ?? null,
  };
  const grantsData = grants.map((grant) => ({
    id: grant.id,
    name: grant.grant_name,
    funder: grant.funder,
    amount: grant.amount,
    deadline: grant.deadline,
    description: grant.description,
    eligibility_notes: grant.eligibility_notes ?? null,
    funds_for: Array.isArray(grant.funds_for) ? grant.funds_for : [],
    geo_qualified: grant.geo_qualified,
    category: grant.category,
    url: grant.url,
    contact: grant.contact,
  }));
  return `Score each grant for this Catholic organization.

TODAY'S DATE: ${today}

ORGANIZATION PROFILE:
${JSON.stringify(profileSummary, null, 2)}

GRANTS TO EVALUATE:
${JSON.stringify(grantsData, null, 2)}

For EACH grant, calculate a probability score (0-100%) using these weights:
- Eligibility fit (40%): Does org meet hard requirements? (501c3, geography, Catholic status)
- Need alignment (30%): Does org have documented need matching grant purpose?
- Capacity signals (15%): Size, staffing, volunteer base indicate ability to use grant
- Timing (10%): Deadline is feasible, project readiness
- Completeness (5%): Do we have enough info to assess accurately?

Score interpretation:
- 85-100%: Excellent Match
- 70-84%: Good Match
- 50-69%: Possible Match
- 25-49%: Weak Match
- 0-24%: Not Eligible

Return a JSON array with one object per grant:
[
    {
        "grant_id": "id from input",
        "score": 75,
        "score_breakdown": {
            "eligibility_fit": 80,
            "need_alignment": 70,
            "capacity_signals": 75,
            "timing": 80,
            "completeness": 60
        },
        "explanation": "Brief explanation of why this score",
        "evidence": ["Specific evidence from profile that influenced score"]
    }
]

Be conservative - if information is missing, lower the completeness score.
Return ONLY the JSON array.`;
}

/** End index (inclusive) of the balanced {...} or [...] opening at `start`, string-aware; -1 if unbalanced. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
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
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

const SCORE_KEYS = ['grant_id', 'id', 'score', 'score_breakdown', 'grant_name', 'name'];

/** Every complete score object in a cut-off answer (stop_reason max_tokens), so one truncation doesn't lose a whole batch. */
function salvageScoreObjects(text: string): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const end = balancedEnd(text, i);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(i, end + 1));
      if (isRecord(value) && SCORE_KEYS.some((key) => key in value) && ('score' in value || 'score_breakdown' in value)) {
        found.push(value);
        i = end;
      }
    } catch {
      // Not JSON at this brace; keep scanning inside it.
    }
  }
  return found;
}

/** The score objects in Claude's answer, or null when there are none. */
export function parseScoreItems(text: string): Array<Record<string, unknown>> | null {
  const array = extractJsonArray<unknown>(text);
  const records = array ? array.filter(isRecord) : [];
  if (records.length) return records;
  const wrapper = extractJsonObject(text);
  if (wrapper) {
    for (const key of ['scores', 'grants', 'results', 'matches', 'items', 'data']) {
      const inner = wrapper[key];
      if (Array.isArray(inner) && inner.some(isRecord)) return inner.filter(isRecord);
    }
  }
  const salvaged = salvageScoreObjects(text);
  return salvaged.length ? salvaged : null;
}

function nameKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** One scored match from one answer item. */
function matchFromItem(grant: Grant, item: Record<string, unknown>): GrantMatch {
  const raw = asRecord(item.score_breakdown ?? item.breakdown);
  const part = (key: keyof MatchScoreBreakdown) => clamp(asNumber(raw[key], 0) ?? 0, 0, 100);
  const breakdown: MatchScoreBreakdown = {
    eligibility_fit: part('eligibility_fit'),
    need_alignment: part('need_alignment'),
    capacity_signals: part('capacity_signals'),
    timing: part('timing'),
    completeness: part('completeness'),
  };
  // Python trusted the model's score (default 0); a missing score now comes from the weighted breakdown.
  const given = asNumber(item.score, null);
  const score = Math.round(clamp(given ?? (Object.keys(raw).length ? weightedScore(breakdown) : 0), 0, 100));
  return {
    ...matchBase(grant),
    score,
    score_tier: tierFor(score),
    score_breakdown: breakdown,
    explanation: asString(item.explanation).trim(),
    evidence: stringItems(item.evidence),
    is_shortlisted: false,
  };
}

/** When a run's Claude calls are cut off, and the label for grants that time ran out for. */
export interface OutOfTime {
  /** ms since epoch */
  at: number;
  explanation: string;
}

/**
 * Score one batch of grants with one Claude call (Python _score_grant_batch).
 * Answer items are matched to grants by id (or by name when the model put
 * the name there); grants the answer skipped still get an honest entry.
 * Fatal Claude errors are re-thrown; other failures become honest fallbacks.
 */
export async function scoreGrantBatch(
  ai: Claude,
  batch: Grant[],
  profile: OrganizationProfile,
  today: string,
  outOfTime?: OutOfTime,
): Promise<GrantMatch[]> {
  let text: string;
  try {
    const response = await ai.call({
      stage: 'match',
      promptId: PROMPT_IDS.match,
      prompt: buildMatchPrompt(batch, profile, today),
      maxTokens: 4000,
    });
    text = response.text;
  } catch (error) {
    if (isFatalClaudeError(error)) throw error;
    // Stopped by the step's own time limit: say that, not "Claude was unavailable".
    if (outOfTime && error instanceof ClaudeError && error.kind === 'timeout' && Date.now() >= outOfTime.at - 1000) {
      logger.warn('grant_scoring_out_of_time', { grants: batch.length, grant_ids: batch.map((g) => g.id) });
      return batch.map((grant) => fallbackMatch(grant, outOfTime.explanation));
    }
    logger.error('grant_scoring_failed', { grants: batch.length, grant_ids: batch.map((g) => g.id), error: errorMessage(error) });
    const explanation = unavailableExplanation(error);
    return batch.map((grant) => fallbackMatch(grant, explanation));
  }

  const items = parseScoreItems(text);
  if (!items) {
    logger.error('grant_scoring_unreadable', { grants: batch.length, answer_preview: text.slice(0, 200) });
    return batch.map((grant) => fallbackMatch(grant, NOT_SCORED_UNREADABLE));
  }

  const byId = new Map(batch.map((grant) => [grant.id, grant]));
  const byName = new Map<string, Grant | null>();
  for (const grant of batch) {
    const key = nameKey(asString(grant.grant_name));
    if (key) byName.set(key, byName.has(key) ? null : grant); // null = ambiguous name
  }
  const findGrant = (item: Record<string, unknown>): Grant | undefined => {
    const id = asString(item.grant_id ?? item.id).trim();
    if (id && byId.has(id)) return byId.get(id);
    for (const candidate of [id, asString(item.grant_name), asString(item.name)]) {
      const key = nameKey(candidate);
      const grant = key ? byName.get(key) : undefined;
      if (grant) return grant;
    }
    return undefined;
  };

  const scored = new Map<string, GrantMatch>();
  let unmatched = 0;
  for (const item of items) {
    const grant = findGrant(item);
    if (!grant) {
      unmatched++;
      continue;
    }
    if (!scored.has(grant.id)) scored.set(grant.id, matchFromItem(grant, item));
  }
  // Coverage guarantee: a grant the answer skipped never silently disappears.
  const skipped = batch.filter((grant) => !scored.has(grant.id));
  if (skipped.length || unmatched) {
    logger.warn('grant_scoring_incomplete', { grants: batch.length, skipped: skipped.map((g) => g.id), unmatched_items: unmatched });
  }
  return batch.map((grant) => scored.get(grant.id) ?? fallbackMatch(grant, NOT_SCORED_SKIPPED));
}

export interface MatchRunOptions {
  grants: Grant[];
  profile: OrganizationProfile;
  userId: string;
  /** The job's Claude client; only requested when some grant needs AI scoring. */
  claude: () => Promise<Claude>;
  progress?: (message: string) => Promise<void>;
  note?: (line: string) => void;
  /** No new batch starts after this time (epoch ms); the rest get an honest "ran out of time" entry. */
  startDeadline?: number;
  /** Batches scored at the same time (default MATCH_CONCURRENCY). */
  concurrency?: number;
  /** Wait before the second-chance pass for batches Claude couldn't score (default 15 seconds; 50 ms in tests). */
  retryWaitMs?: number;
  /** When this run's Claude calls are cut off (epoch ms): a batch stopped by it is "out of time", not "unavailable". */
  hardDeadline?: number;
  /** Label for grants that time ran out for (default: the background worker's 15-minute limit). */
  outOfTimeExplanation?: string;
}

/** What one scoring run did. */
export interface MatchRun {
  /** One match per grant given, in no particular order. */
  matches: GrantMatch[];
  /** Grants ruled out by the hard filters (no Claude call). */
  prefiltered: number;
  batches: number;
  /** Grants Claude actually scored in this run. */
  aiScored: number;
}

/** Tier counts for a match list (spec v2.6 tiers). */
export function tierCounts(
  matches: GrantMatch[],
): Pick<MatchResults, 'excellent_matches' | 'good_matches' | 'possible_matches' | 'weak_matches' | 'not_eligible'> {
  return {
    excellent_matches: matches.filter((m) => m.score >= 85).length,
    good_matches: matches.filter((m) => m.score >= 70 && m.score < 85).length,
    possible_matches: matches.filter((m) => m.score >= 50 && m.score < 70).length,
    weak_matches: matches.filter((m) => m.score >= 25 && m.score < 50).length,
    not_eligible: matches.filter((m) => m.score < 25).length,
  };
}

/**
 * Saved results with some grants scored again (a follow-up part in direct
 * mode): each rescored grant replaces its earlier entry (keeping the
 * shortlist flag), then the list is re-sorted and the tiers recounted.
 */
export function withRescoredMatches(saved: MatchResults, rescored: GrantMatch[]): MatchResults {
  const byId = new Map(rescored.map((match) => [match.grant_id, match]));
  const matches = saved.matches
    .map((match) => {
      const next = byId.get(match.grant_id);
      return next ? { ...next, is_shortlisted: match.is_shortlisted } : match;
    })
    .sort((a, b) => b.score - a.score);
  return { ...saved, matches, ...tierCounts(matches) };
}

/** Sorts by creation time to the millisecond, so the newest results are the last key. */
export function newMatchSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, ''); // 20261014T221913123Z
  return `match_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Score grants against the profile: hard disqualifiers first, then batches
 * of 10 scored by Claude (4 at a time, or every batch at once in direct
 * mode), then one second chance for batches Claude was briefly unavailable
 * for, time permitting. Every grant gets a match; the unscored say why.
 */
export async function scoreMatches(options: MatchRunOptions): Promise<MatchRun> {
  const { grants, profile } = options;
  const today = todayIso();
  const outOfTimeText = options.outOfTimeExplanation ?? NOT_SCORED_OUT_OF_TIME;
  const outOfTime = options.hardDeadline ? { at: options.hardDeadline, explanation: outOfTimeText } : undefined;
  const matches: GrantMatch[] = [];
  const toScore: Grant[] = [];
  for (const grant of grants) {
    const disqualified = deterministicPrefilter(grant, profile, today);
    if (disqualified) matches.push(disqualified);
    else toScore.push(grant);
  }
  options.note?.(`${grants.length} grants: ${matches.length} ruled out by hard filters, ${toScore.length} sent to Claude`);

  const batches: Grant[][] = [];
  for (let i = 0; i < toScore.length; i += MATCH_BATCH_SIZE) batches.push(toScore.slice(i, i + MATCH_BATCH_SIZE));
  const batchResults: GrantMatch[][] = batches.map(() => []);

  let clientPromise: Promise<Claude> | null = null;
  const client = () => (clientPromise ??= options.claude());
  let nextBatch = 0;
  // A fatal error (bad key, no credits...) stops new batches; in-flight ones finish, then it is re-thrown.
  const fatalErrors: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (fatalErrors.length === 0) {
      const index = nextBatch++;
      if (index >= batches.length) return;
      const batch = batches[index];
      if (options.startDeadline && Date.now() > options.startDeadline) {
        batchResults[index] = batch.map((grant) => fallbackMatch(grant, outOfTimeText));
        continue;
      }
      const first = index * MATCH_BATCH_SIZE + 1;
      await options.progress?.(`Scoring grants ${first}-${first + batch.length - 1} of ${toScore.length}`);
      try {
        batchResults[index] = await scoreGrantBatch(await client(), batch, profile, today, outOfTime);
      } catch (error) {
        fatalErrors.push(error);
        return;
      }
    }
  };
  const workers = Math.min(Math.max(1, options.concurrency ?? MATCH_CONCURRENCY), batches.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (fatalErrors.length) throw fatalErrors[0];

  // Second chance, one batch at a time, for batches Claude couldn't score
  // because of a passing problem (rate limit, overload, timeout) that outlasted
  // the client's own retries. Lower-tier API keys hit this when 4 run at once.
  // Only when the wait plus one scoring call still fits before startDeadline.
  const retryWait = testMode() ? 50 : (options.retryWaitMs ?? 15_000);
  for (let index = 0; index < batches.length; index++) {
    const result = batchResults[index];
    if (!result.length || !result.every((match) => match.explanation.startsWith(NOT_SCORED_UNAVAILABLE))) continue;
    if (options.startDeadline && Date.now() + retryWait > options.startDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, retryWait));
    const first = index * MATCH_BATCH_SIZE + 1;
    await options.progress?.(`Trying grants ${first}-${first + batches[index].length - 1} again...`);
    options.note?.(`Retrying batch ${index + 1} once after a temporary Claude problem`);
    batchResults[index] = await scoreGrantBatch(await client(), batches[index], profile, today, outOfTime);
  }

  for (const result of batchResults) matches.push(...result);
  const sent = new Set(toScore.map((grant) => grant.id));
  const aiScored = matches.filter((match) => sent.has(match.grant_id) && !match.explanation.startsWith(NOT_AI_SCORED)).length;
  return { matches, prefiltered: grants.length - toScore.length, batches: batches.length, aiScored };
}

/**
 * Match every grant against the profile (Python match_grants): hard
 * disqualifiers first, then batches of 10 scored by Claude, 4 at a time.
 */
export async function matchGrants(options: MatchRunOptions): Promise<MatchResults> {
  return (await matchGrantsWithRun(options)).results;
}

/** matchGrants, plus what the run did (how many grants Claude actually scored). */
export async function matchGrantsWithRun(options: MatchRunOptions): Promise<{ results: MatchResults; run: MatchRun }> {
  const { grants, profile, userId } = options;
  const run = await scoreMatches(options);
  const matches = [...run.matches].sort((a, b) => b.score - a.score);
  const created = new Date();
  const results: MatchResults = {
    session_id: newMatchSessionId(),
    user_id: userId,
    profile_id: profile.id || userId,
    total_grants_evaluated: grants.length,
    matches,
    ...tierCounts(matches),
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + MATCH_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
  const notScored = matches.filter((m) => m.explanation.startsWith(NOT_AI_SCORED)).length;
  if (notScored) options.note?.(`${notScored} grant(s) could not be AI-scored and are marked "${NOT_AI_SCORED}"`);
  logger.info('match_completed', {
    user_id: userId,
    session_id: results.session_id,
    total: grants.length,
    prefiltered: run.prefiltered,
    batches: run.batches,
    not_ai_scored: notScored,
    excellent: results.excellent_matches,
    good: results.good_matches,
    possible: results.possible_matches,
  });
  return { results, run };
}

// =============================================================================
// Finding a user's newest match results
// =============================================================================

const MATCH_SESSION_RE = /^match_\d{8}T\d{9}Z_[0-9a-f]{8}$/;

/** A match session id as newMatchSessionId() makes them. */
export function isMatchSessionId(value: string): boolean {
  return MATCH_SESSION_RE.test(value);
}

/** Newest match session id for this user (session ids sort by time), or null. */
export async function latestMatchSessionId(userId: string): Promise<string | null> {
  const ids = (await listMatchSessionIds(userId)).filter((id) => MATCH_SESSION_RE.test(id)).sort();
  return ids.length ? ids[ids.length - 1] : null;
}
