/**
 * AI processing for matching: website scan, questionnaire, document signals,
 * and grant scoring. Port of backend/services/ai_service.py plus the
 * profile-merge rules from backend/routers/processing.py.
 *
 * Prompts are the Python text verbatim. Claude is only called through the
 * job's client (claude.ts) and answers are parsed leniently (json.ts).
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
/** Match results expire 90 days after they are created (spec v2.6). */
export const MATCH_EXPIRY_DAYS = 90;
/** The Python sent the first 30,000 characters of a document to Claude. */
export const DOCUMENT_TEXT_LIMIT = 30000;
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

${websiteContent}

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

/** A yes/no question that asks whether the organization has (runs, sponsors...) a school. */
const HAS_SCHOOL_QUESTION = /\b(have|has|operate|operates|run|runs|sponsor|sponsors|include|includes|support|supports|own|owns|is there|affiliated|associated|attached)\b[^?]*\bschool/;
/** ...and not one about something else that merely mentions the school ("security concerns at your school?"). */
const OTHER_SCHOOL_TOPIC = /secur|safety|concern|repair|renovat|need|budget|grant|fund|enrol|accredit|tuition|transport|meal|lunch/;

/**
 * Port of submit_questionnaire's mapping of well-known questions onto profile
 * fields. Every answer is also kept verbatim in questionnaire_answers.
 * Fixes: has_school only follows a yes/no question about having a school
 * (the Python let "Is your school accredited?" -> No, or "Security concerns
 * at your school?" -> No, set has_school to false); a state is only taken
 * from an answer that names a US state (the Python stored "True" as the
 * state for "Do you own real estate?"); the organization-type question now
 * sets organization_type/has_school.
 */
export function applyQuestionnaireAnswers(
  profile: OrganizationProfile,
  answers: QuestionnaireAnswer[],
  freeFormText: string | null,
  questionsById: Map<number, string>,
): OrganizationProfile {
  const next: OrganizationProfile = { ...profile };
  const qaPairs: Array<Record<string, unknown>> = [];
  for (const { question_id: questionId, answer } of answers) {
    const questionText = questionsById.get(questionId) ?? `Question ${questionId}`;
    qaPairs.push({ question: questionText, answer });

    const q = questionText.toLowerCase();
    const answerStr = answerText(answer).trim();
    const lower = answerStr.toLowerCase();
    const isYes = ['true', 'yes', 'y', '1'].includes(lower);
    const yesNo = typeof answer === 'boolean' || ['true', 'false', 'yes', 'no'].includes(lower);
    const schoolDecides = q.includes('school') && !q.includes('grade') &&
      (yesNo ? HAS_SCHOOL_QUESTION.test(q) && !OTHER_SCHOOL_TOPIC.test(q) : lower.includes('school'));

    if (q.includes('501')) {
      next.is_501c3 = isYes;
    } else if (q.includes('food pantry') || q.includes('food assistance')) {
      next.has_food_pantry = isYes;
    } else if (schoolDecides) {
      next.has_school = yesNo ? isYes : true;
    } else if (q.includes('state') && answerStr && answerStr.length <= 30) {
      const code = yesNo ? null : usStateCode(answerStr);
      if (code && !next.state) next.state = code;
    } else if (q.includes('budget') && answerStr) {
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
  next.questionnaire_answers = qaPairs;
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

export function buildDocumentPrompt(text: string, filename: string): string {
  return `Analyze this document from a Catholic parish or school and extract information relevant to grant applications.

DOCUMENT: ${filename}
CONTENT:
${text.slice(0, DOCUMENT_TEXT_LIMIT)}

Extract and categorize any mentions of:
1. Facility needs (repairs, renovations, equipment)
2. Program needs (new programs, program expansions, staffing)
3. Security concerns (safety issues, security equipment needs)
4. Other grant-relevant signals (financial challenges, growth opportunities, community needs)

IMPORTANT: Ignore irrelevant content like mass times, prayer intentions, event announcements.
Focus on actionable needs that could be addressed with grant funding.

Return a JSON object:
{
    "facility_needs": ["List of specific facility needs mentioned"],
    "program_needs": ["List of specific program needs mentioned"],
    "security_concerns": ["List of specific security concerns mentioned"],
    "other_signals": ["Other relevant information for grant matching"]
}

Return ONLY the JSON object, no other text.`;
}

export interface DocumentSignals {
  facility_needs: string[];
  program_needs: string[];
  security_concerns: string[];
  other_signals: string[];
}

/** The four signal lists, or null when the answer had no JSON object. */
export function parseDocumentSignals(text: string): DocumentSignals | null {
  const data = extractJsonObject(text);
  if (!data) return null;
  const list = (value: unknown) => mergeUnique([], stringItems(value));
  return {
    facility_needs: list(data.facility_needs),
    program_needs: list(data.program_needs),
    security_concerns: list(data.security_concerns),
    other_signals: list(data.other_signals),
  };
}

/** Stable evidence id: the same item from the same file always gets the same id. */
export function documentEvidenceId(filename: string, item: string): string {
  return `ev_${crypto.createHash('sha1').update(`${filename}\n${item}`).digest('hex').slice(0, 10)}`;
}

/**
 * Add a document's signals to the shared profile: needs lists (deduplicated,
 * case-insensitive) and one evidence entry per item, which is how uploaded
 * documents reach the GrantWriter's drafts.
 */
export function mergeDocumentIntoProfile(profile: OrganizationProfile, result: DocumentExtractionResult): OrganizationProfile {
  const next: OrganizationProfile = { ...profile };
  next.facility_needs = mergeUnique(next.facility_needs, result.facility_needs);
  next.program_needs = mergeUnique(next.program_needs, result.program_needs);
  next.security_concerns = mergeUnique(next.security_concerns, result.security_concerns);

  const evidence = [...next.evidence];
  const seen = new Set(evidence.map((entry) => itemKey(asString(entry.summary))).filter(Boolean));
  const items = [...result.facility_needs, ...result.program_needs, ...result.security_concerns, ...result.other_signals];
  for (const item of items) {
    const key = itemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      id: documentEvidenceId(result.filename, item),
      type: 'document',
      summary: item,
      source_ref: `Document: ${result.filename}`,
      linked_programs: [],
    });
  }
  next.evidence = evidence;
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

/**
 * Score one batch of grants with one Claude call (Python _score_grant_batch).
 * Answer items are matched to grants by id (or by name when the model put
 * the name there); grants the answer skipped still get an honest entry.
 * Fatal Claude errors are re-thrown; other failures become honest fallbacks.
 */
export async function scoreGrantBatch(ai: Claude, batch: Grant[], profile: OrganizationProfile, today: string): Promise<GrantMatch[]> {
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
}

/** Sorts by creation time to the millisecond, so the newest results are the last key. */
export function newMatchSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.]/g, ''); // 20261014T221913123Z
  return `match_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Match every grant against the profile (Python match_grants): hard
 * disqualifiers first, then batches of 10 scored by Claude, 4 at a time.
 */
export async function matchGrants(options: MatchRunOptions): Promise<MatchResults> {
  const { grants, profile, userId } = options;
  const today = todayIso();
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
        batchResults[index] = batch.map((grant) => fallbackMatch(grant, NOT_SCORED_OUT_OF_TIME));
        continue;
      }
      const first = index * MATCH_BATCH_SIZE + 1;
      await options.progress?.(`Scoring grants ${first}-${first + batch.length - 1} of ${toScore.length}`);
      try {
        batchResults[index] = await scoreGrantBatch(await client(), batch, profile, today);
      } catch (error) {
        fatalErrors.push(error);
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MATCH_CONCURRENCY, batches.length) }, () => worker()));
  if (fatalErrors.length) throw fatalErrors[0];

  // Second chance, one batch at a time, for batches Claude couldn't score
  // because of a passing problem (rate limit, overload, timeout) that outlasted
  // the client's own retries. Lower-tier API keys hit this when 4 run at once.
  const unavailable = `${NOT_AI_SCORED} Claude was unavailable (`;
  for (let index = 0; index < batches.length; index++) {
    const result = batchResults[index];
    if (!result.length || !result.every((match) => match.explanation.startsWith(unavailable))) continue;
    if (options.startDeadline && Date.now() > options.startDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, testMode() ? 50 : 15_000));
    const first = index * MATCH_BATCH_SIZE + 1;
    await options.progress?.(`Trying grants ${first}-${first + batches[index].length - 1} again...`);
    options.note?.(`Retrying batch ${index + 1} once after a temporary Claude problem`);
    batchResults[index] = await scoreGrantBatch(await client(), batches[index], profile, today);
  }

  for (const result of batchResults) matches.push(...result);

  matches.sort((a, b) => b.score - a.score);
  const created = new Date();
  const results: MatchResults = {
    session_id: newMatchSessionId(),
    user_id: userId,
    profile_id: profile.id || userId,
    total_grants_evaluated: grants.length,
    matches,
    excellent_matches: matches.filter((m) => m.score >= 85).length,
    good_matches: matches.filter((m) => m.score >= 70 && m.score < 85).length,
    possible_matches: matches.filter((m) => m.score >= 50 && m.score < 70).length,
    weak_matches: matches.filter((m) => m.score >= 25 && m.score < 50).length,
    not_eligible: matches.filter((m) => m.score < 25).length,
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + MATCH_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
  const notScored = matches.filter((m) => m.explanation.startsWith(NOT_AI_SCORED)).length;
  if (notScored) options.note?.(`${notScored} grant(s) could not be AI-scored and are marked "${NOT_AI_SCORED}"`);
  logger.info('match_completed', {
    user_id: userId,
    session_id: results.session_id,
    total: grants.length,
    prefiltered: grants.length - toScore.length,
    batches: batches.length,
    not_ai_scored: notScored,
    excellent: results.excellent_matches,
    good: results.good_matches,
    possible: results.possible_matches,
  });
  return results;
}

// =============================================================================
// Finding a user's newest match results
// =============================================================================

const MATCH_SESSION_RE = /^match_\d{8}T\d{9}Z_[0-9a-f]{8}$/;

/** Newest match session id for this user (session ids sort by time), or null. */
export async function latestMatchSessionId(userId: string): Promise<string | null> {
  const ids = (await listMatchSessionIds(userId)).filter((id) => MATCH_SESSION_RE.test(id)).sort();
  return ids.length ? ids[ids.length - 1] : null;
}
