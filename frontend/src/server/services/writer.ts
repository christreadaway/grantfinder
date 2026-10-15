/**
 * GrantWriter AI orchestration: a port of backend/services/writer_service.py
 * (Application Writer PRD 4.9).
 *
 * Each stage is one purpose-built Claude task with its own prompt (text kept
 * verbatim from the Python):
 *   Extract  grant_spec_v1, voice_profile_v1
 *   Funder   funder_research_v1 (web search), funder_profile_v1: what the grantor
 *            has actually funded, used by Map, Draft and Score
 *   Map      fit_gap_v1
 *   Route    intake_packets_v1
 *   Draft    section_draft_v1
 *   Score    self_score_v1
 *   Refine   section_refine_v1
 *   Enforce  voice_enforce_v1
 *
 * Hard rules enforced in code, not just prompts:
 *   - Never fabricate: claims without evidence are flagged.
 *   - Format is pass/fail: word/char limits are checked deterministically after
 *     every generation and refinement; export refuses over-limit content.
 *   - Banned phrases are detected deterministically and rewritten before the user sees them.
 *
 * Claude is only called from background jobs (handlers/writer.ts) through the
 * logged client in claude.ts. This module must never import docx.
 */
import crypto from 'node:crypto';

import type { ClaudeCallOptions, ClaudeCallResult } from '../claude';
import { isUrgent } from '../deadlines';
import { errorMessage, HttpError, isFatalClaudeError } from '../errors';
import { asNumber, asRecord, asString, asStringList, clamp, extractJsonArray, extractJsonObject } from '../json';
import { logger } from '../log';
import { fetchPage, normalizeUrl } from '../net';
import { getApplication, getProfile } from '../repo';
import type {
  Application,
  ClaimFlag,
  ComparableGrant,
  CriterionScore,
  FitAnalysis,
  FitEntry,
  FunderPriority,
  FunderProfile,
  FunderRecord,
  FunderRecordView,
  Gap,
  Grant,
  GrantSpec,
  IntakeRequest,
  OrganizationProfile,
  RequiredSection,
  RubricCriterion,
  Scorecard,
  SectionDraft,
} from '../types';
import { cutText } from './ai';

/** PRD 5.2: a deadline within this many days marks the application urgent. */
export const URGENCY_WINDOW_DAYS = 10;

/** AI tells banned by default, merged with the org's own banned-phrase list. */
export const DEFAULT_BANNED_PHRASES = [
  'honored to be considered',
  'we are thrilled',
  "in today's fast-paced world",
  'in an ever-changing world',
  'unwavering commitment',
  'passionate about',
  'cutting-edge',
  'state-of-the-art',
  'world-class',
  'game-changer',
  'at the end of the day',
  'leverage synergies',
  'delve into',
  'it is important to note that',
  'furthermore, ',
  'moreover, ',
];

/** The Python router's exact `detail` wording. */
export const WRITER_MESSAGES = {
  appNotFound: 'Application not found',
  profileMissing: 'No organization profile. Complete grantfinder setup first - the writer reuses that profile.',
  grantNotFound: 'Grant not found in your database',
  underlyingGrantMissing: 'Underlying grant record not found',
  specFirst: 'Run grant-spec enrichment first',
  fitFirst: 'Run fit analysis first',
  strategyNotConfirmed:
    'Strategy not confirmed. Review the fit map and confirm the strategy before drafting (human approval gate).',
  draftSectionNotInSpec: 'Section not found in grant spec',
  draftFirst: 'Draft the application first',
  sectionDraftNotFound: 'Section draft not found',
  sectionNotInSpec: 'Section not in grant spec',
  nothingToExport: 'Nothing to export - draft the application first',
  intakeNotFound: 'Intake request not found',
  gapNotFound: 'Gap not found',
  noSamples: 'Provide at least one writing sample',
  noGaps: 'No gaps to route',
  // Added in the TypeScript engine (no Python equivalent).
  sectionTextEmpty: 'Section text is empty.',
  sectionsBusy:
    'Drafting or refining is still running for this application. Wait for it to finish, then save your edit again.',
  allGapsAsked: 'Every open gap already has a stakeholder request. Record their answers on the requests below.',
} as const;

/** Earlier texts kept per section (newest last): the same cap for redrafts, refinements, voice rewrites and hand edits. */
export const MAX_SECTION_VERSIONS = 12;

/** The most text a hand edit may save into one section. */
export const MAX_SECTION_CHARS = 60000;

/** Compliance notes about where a section's text came from (each is added at most once). */
export const SECTION_NOTES = {
  handEdited: 'Edited by hand.',
  handEditClaims: 'The claim check is from the AI draft; re-check any numbers or names you added.',
  refinedClaims: 'Revised: the claim check is from the earlier draft. Re-check any new numbers or names.',
  redraftKept:
    'This section changed while it was being redrafted, so the saved text was kept. The new draft is the newest of the earlier versions.',
  tightenSkipped:
    'Over the limit: this step ran out of time before it could tighten the text automatically. Refine it again (for example "tighten to the limit") or edit it by hand.',
  tightenFailed:
    'Over the limit: the automatic tightening did not work this time. Refine it again (for example "tighten to the limit") or edit it by hand.',
} as const;

/** The note for banned phrases left in because the voice rewrite had no time to run. */
export function enforceSkippedNote(hits: string[]): string {
  return (
    `Banned phrases left in (${hits.slice(0, 5).join(', ')}): this step ran out of time before it could rewrite them. ` +
    'Refine this section (for example "remove these phrases") or edit it by hand.'
  );
}

/** A refine whose section changed while Claude was writing is not saved (the person's text wins). */
export function refineConflictMessage(title: string): string {
  return `"${title}" was changed while Claude was revising it, so the revision was not saved. Your text is kept; refine again if you still want it.`;
}

/** "[NEEDS INPUT: ...]" markers that drafting leaves where the profile lacked a fact (the writer page uses the same pattern). */
const NEEDS_INPUT = /\[NEEDS INPUT[^\]]*\]/gi;

/** The "[NEEDS INPUT ...]" placeholders still in a text, in order. */
export function findPlaceholders(text: string): string[] {
  return text.match(NEEDS_INPUT) ?? [];
}

// =============================================================================
// Claude access for the stages
// =============================================================================

/** The slice of the Claude client the stages use (claude.ts `Claude`). */
export interface WriterAI {
  call(options: ClaudeCallOptions): Promise<ClaudeCallResult>;
}

/** Everything a stage needs besides its inputs: the client, ids for logs, and the job's note/progress hooks. */
export interface WriterRun {
  ai: WriterAI;
  correlationId: string;
  applicationId?: string | null;
  /** Adds a line to the job's notes (shown in the debug bundle). */
  note?: (line: string) => void;
  /** Updates the job's status line in the website. */
  progress?: (message: string) => Promise<void>;
  /** Milliseconds left before this step's Claude calls are cut off (jobs.ts timeLeftMs); absent = no limit. */
  timeLeftMs?: () => number;
}

/**
 * An optional extra Claude call (the voice rewrite, the automatic tighten pass)
 * starts only with at least this much time left. A step that runs inside one
 * Netlify request has about 50 seconds; without the time, the section is
 * saved flagged, with a note saying how to fix it.
 */
export const OPTIONAL_CALL_MIN_MS = 15_000;

function noTimeForOptionalCall(run: WriterRun): boolean {
  return run.timeLeftMs ? run.timeLeftMs() < OPTIONAL_CALL_MIN_MS : false;
}

// =============================================================================
// Utilities
// =============================================================================

/** Python's len(text.split()). */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Python's len(text): code points, so an emoji or accented letter counts once. */
export function countChars(text: string): number {
  return Array.from(text).length;
}

/** Typographic quotes, dashes and non-breaking spaces read as their plain forms when matching phrases. */
function plainForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u00A0/g, ' ');
}

/** A letter or digit in any script: what words are made of. */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const phraseMatchers = new Map<string, RegExp>();

/**
 * Whole words only: "compassionate about" is not "passionate about", and a
 * banned "just" never blocks "justice". An edge that is punctuation (the comma
 * in "furthermore, ") needs no word boundary; any run of spaces or line breaks
 * inside a phrase matches any other run.
 */
function phraseMatcher(needle: string): RegExp {
  let matcher = phraseMatchers.get(needle);
  if (!matcher) {
    const chars = Array.from(needle);
    const body = needle.split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const start = WORD_CHAR.test(chars[0]) ? '(?<![\\p{L}\\p{N}])' : '';
    const end = WORD_CHAR.test(chars[chars.length - 1]) ? '(?![\\p{L}\\p{N}])' : '';
    matcher = new RegExp(`${start}${body}${end}`, 'u');
    if (phraseMatchers.size > 1000) phraseMatchers.clear(); // org lists are short; never grow without bound
    phraseMatchers.set(needle, matcher);
  }
  return matcher;
}

/** Deterministic banned-phrase scan (case-insensitive, whole words), each phrase reported once. */
export function findBannedPhrases(text: string, extraBanned: unknown[] = []): string[] {
  const extra = extraBanned.filter((phrase): phrase is string => typeof phrase === 'string' && phrase.trim().length > 0);
  const haystack = plainForMatching(text);
  const seen = new Set<string>();
  const hits: string[] = [];
  for (const phrase of [...DEFAULT_BANNED_PHRASES, ...extra]) {
    const needle = plainForMatching(phrase).trim();
    if (!needle || seen.has(needle)) continue;
    seen.add(needle);
    if (phraseMatcher(needle).test(haystack)) hits.push(phrase);
  }
  return hits;
}

/** The org's own banned phrases from its voice profile. */
export function orgBannedPhrases(profile: OrganizationProfile | null): string[] {
  return profile?.voice_profile ? asStringList(asRecord(profile.voice_profile).banned_phrases) : [];
}

/** json.dumps(value) with Python's default separators (", " and ": "), so ported prompts read the same. */
export function pyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => pyJson(item)).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${pyJson(item)}`).join(', ')}}`;
  }
  return JSON.stringify(value === undefined ? null : value) ?? 'null';
}

/** json.dumps(value, indent=2). */
function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Random id like the Python's f"{prefix}_{uuid4().hex[:n]}". */
export function newId(prefix: string, hexChars = 10): string {
  return `${prefix}_${crypto.randomBytes(Math.ceil(hexChars / 2)).toString('hex').slice(0, hexChars)}`;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Text from a model field; a list of strings is joined (models sometimes return guidelines as a list). */
function joinText(value: unknown): string {
  return Array.isArray(value) ? asStringList(value).join(' ') : asString(value);
}

/** A list of strings; a lone string becomes a one-item list (the Python split it into characters). */
function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  return asStringList(value);
}

/** A reference string, or null when the model wrote nothing, "null", "none", "n/a"... */
function refText(value: unknown): string | null {
  const text = (Array.isArray(value) ? asStringList(value).join('; ') : asString(value)).trim();
  if (!text || /^(null|none|n\/?a|unsupported|unknown|missing|no evidence|not in (the )?profile)\.?$/i.test(text)) return null;
  return text;
}

/** A positive whole-number limit ("500", 500.0, "500 words"), else null. Never invents one. */
function limitValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? Math.round(value) : null;
  if (typeof value === 'string') {
    const match = /\d[\d,]*/.exec(value);
    if (match) {
      const n = Number(match[0].replace(/,/g, ''));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return null;
}

/** A score from a number or text like "85" or "85/100"; null when there is none. */
function scoreValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = /-?\d+(?:\.\d+)?/.exec(value);
    if (match) return Number(match[0]);
  }
  return null;
}

/** Section ids end up in URLs and storage keys: keep them simple and unique. */
function sectionId(raw: unknown, index: number, used: Set<string>): string {
  const base = asString(raw).trim().replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, 60) || `s${index + 1}`;
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function stripFences(text: string): string {
  const fenced = /^\s*```[A-Za-z]*\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return fenced ? fenced[1] : text;
}

/**
 * Escape raw line breaks and tabs inside JSON strings. Models sometimes put a
 * real line break inside "draft": "...", which makes strict JSON invalid.
 */
function escapeRawControlChars(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
    } else if (escaped) {
      escaped = false;
      out += ch;
    } else if (ch === '\\') {
      escaped = true;
      out += ch;
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return out;
}

/**
 * Parse with json.ts, and again with raw line breaks inside strings repaired;
 * keep the larger result. (When the outer object is broken, the strict parse
 * can only find a small inner object, such as one claim.)
 */
function parseLenient<T>(text: string, extract: (source: string) => T | null): T | null {
  const strict = extract(text);
  if (!/[\n\r\t]/.test(text)) return strict;
  const repairedText = escapeRawControlChars(text);
  if (repairedText === text) return strict;
  const repaired = extract(repairedText);
  if (!repaired) return strict;
  if (!strict) return repaired;
  return JSON.stringify(repaired).length > JSON.stringify(strict).length ? repaired : strict;
}

/** The JSON object in a model answer. */
export function parseObject(text: string): Record<string, unknown> | null {
  return parseLenient(text, (source) => extractJsonObject(source));
}

function parseArray(text: string): unknown[] | null {
  return parseLenient(text, (source) => extractJsonArray<unknown>(source));
}

/**
 * The value of a "draft" JSON string even when the answer was cut off before
 * the JSON closed. `closed` is false when the string itself was cut off.
 */
function salvageDraftString(text: string): { value: string; closed: boolean } | null {
  const match = /"draft"\s*:\s*"/.exec(text);
  if (!match) return null;
  let out = '';
  for (let i = match.index + match[0].length; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') return { value: out, closed: true };
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    i++;
    if (next === 'n') out += '\n';
    else if (next === 't') out += '\t';
    else if (next === 'r') out += '\r';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === 'u') {
      const hex = text.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      }
    } else out += next;
  }
  return { value: out, closed: false };
}

export interface DraftAnswer {
  draft: string;
  /** The "claims" value when the answer was readable JSON. */
  claims: unknown;
  /** False when the answer was not a complete JSON object (claims cannot be checked). */
  structured: boolean;
  /** True when the draft text itself was cut off mid-answer. */
  truncated: boolean;
}

/**
 * Read a {"draft": "...", "claims": [...]} answer. Falls back like the Python
 * (raw text when the model wrote prose), but salvages a cut-off JSON answer
 * instead of pasting raw JSON into the draft. Null when nothing usable came back.
 */
export function readDraftAnswer(text: string): DraftAnswer | null {
  const data = parseObject(text);
  const draft = data ? asString(data.draft) : '';
  if (data && draft.trim()) return { draft, claims: data.claims, structured: true, truncated: false };

  // The JSON did not parse as a whole (often cut off inside "claims"): take the "draft" string itself.
  const salvaged = salvageDraftString(text);
  if (salvaged && salvaged.value.trim()) {
    return { draft: salvaged.value, claims: undefined, structured: false, truncated: !salvaged.closed };
  }

  // Valid JSON that named the field differently, e.g. {"text": "..."}; never a lone inner claim.
  if (data && !('claim' in data)) {
    const longest = Object.values(data)
      .filter((value): value is string => typeof value === 'string')
      .sort((a, b) => b.length - a.length)[0];
    if (longest && longest.trim().length >= 40) return { draft: longest, claims: data.claims, structured: true, truncated: false };
  }

  // Prose instead of JSON: use it as the draft, as the Python did. Broken JSON is never pasted in.
  const raw = stripFences(text).trim();
  if (!raw || raw.startsWith('{') || raw.startsWith('[')) return null;
  return { draft: raw, claims: undefined, structured: false, truncated: false };
}

/**
 * A clear, logged failure for an answer the stage cannot use (never a silent
 * empty result). `why` replaces the default reason (cut off / wrong format).
 */
function unreadableAnswer(run: WriterRun, promptId: string, res: ClaudeCallResult, what: string, why?: string): HttpError {
  logger.warn('writer_unreadable_answer', {
    correlation_id: run.correlationId,
    application_id: run.applicationId ?? undefined,
    prompt_id: promptId,
    stop_reason: res.stopReason,
    chars: res.text.length,
  });
  run.note?.(
    `${promptId}: answer could not be used (stop_reason=${res.stopReason ?? 'none'}, ${res.text.length} chars). ` +
      `It began: ${res.text.slice(0, 300).replace(/\s+/g, ' ')}`,
  );
  const reason =
    why ??
    (res.stopReason === 'max_tokens'
      ? 'Claude ran out of room before finishing its answer'
      : res.stopReason === 'refusal'
        ? 'Claude declined to answer this request'
        : "Claude's answer was not in the expected format");
  return new HttpError(
    502,
    `Couldn't read the ${what}: ${reason}. Please try again; if it keeps happening, use "Copy debug report" and paste it into Claude Code.`,
  );
}

/** The structured profile slice that grounds writer prompts (PRD 4.9). Key order matches the Python. */
export function profileSlice(profile: OrganizationProfile): Record<string, unknown> {
  return {
    organization_name: profile.organization_name,
    organization_type: profile.organization_type,
    city: profile.city,
    state: profile.state,
    diocese: profile.diocese ?? null,
    has_school: profile.has_school,
    student_count: profile.student_count ?? null,
    is_501c3: profile.is_501c3,
    annual_budget: profile.annual_budget ?? null,
    facility_needs: profile.facility_needs,
    program_needs: profile.program_needs,
    security_concerns: profile.security_concerns,
    current_initiatives: profile.current_initiatives,
    free_form_notes: profile.free_form_notes ?? null,
    questionnaire_answers: profile.questionnaire_answers,
    evidence: profile.evidence,
    team_members: profile.team_members,
    collaborations: profile.collaborations,
    validators: profile.validators,
    in_kind_resources: profile.in_kind_resources,
    prior_grants_detail: profile.prior_grants_detail,
    previous_grants: profile.previous_grants,
    financial_capacity: profile.financial_capacity ?? null,
  };
}

/** Voice conditioning block for Draft/Refine/Enforce prompts. */
export function voiceBlock(profile: OrganizationProfile): string {
  const vp = asRecord(profile.voice_profile);
  const guidelines = joinText(vp.style_guidelines) || 'Plain, direct, warm. Concrete over abstract. No corporate jargon.';
  const samples = listOf(vp.samples).filter((sample): sample is string => typeof sample === 'string');
  const banned = [...asStringList(vp.banned_phrases), ...DEFAULT_BANNED_PHRASES];
  let block = `VOICE GUIDELINES:\n${guidelines}\n\nBANNED PHRASES (never use any of these):\n`;
  block += banned
    .slice(0, 40)
    .map((phrase) => `- ${phrase}`)
    .join('\n');
  if (samples.length) {
    const joined = samples
      .slice(0, 3)
      .map((sample) => sample.slice(0, 1500))
      .join('\n---\n');
    block += `\n\nWRITING SAMPLES IN THE ORGANIZATION'S REAL VOICE:\n${joined}`;
  }
  return block;
}

const rubricJson = (rubric: RubricCriterion[]) =>
  rubric.map((c) => ({ id: c.id, name: c.name, description: c.description, weight: c.weight ?? null }));

const sectionJson = (s: RequiredSection) => ({
  id: s.id,
  title: s.title,
  prompt: s.prompt,
  word_limit: s.word_limit ?? null,
  char_limit: s.char_limit ?? null,
  notes: s.notes,
});

const fitEntryJson = (f: FitEntry) => ({
  criterion_id: f.criterion_id,
  criterion_name: f.criterion_name,
  rating: f.rating,
  evidence: f.evidence,
  missing: f.missing ?? null,
});

// =============================================================================
// Application helpers shared by routes and jobs
// =============================================================================

/** Urgency is recomputed from the deadline on every read, so it turns on as the deadline nears. */
export function withUrgency(app: Application): Application {
  return { ...app, urgent: isUrgent(app.deadline, URGENCY_WINDOW_DAYS) };
}

export async function loadApplication(userId: string, appId: string): Promise<Application> {
  const app = await getApplication(userId, appId);
  if (!app || app.user_id !== userId) throw new HttpError(404, WRITER_MESSAGES.appNotFound);
  return withUrgency(app);
}

export async function loadWriterProfile(userId: string): Promise<OrganizationProfile> {
  const profile = await getProfile(userId);
  if (!profile) throw new HttpError(400, WRITER_MESSAGES.profileMissing);
  return profile;
}

/** High-severity gaps that block drafting until answered, confirmed, or waived. */
export function blockingGaps(gaps: Gap[]): Gap[] {
  return gaps.filter((gap) => gap.severity === 'high' && (gap.status === 'open' || gap.status === 'routed'));
}

/** Human approval gates before drafting (PRD 5.2): confirmed strategy and no open high-severity gaps. */
export function assertDraftAllowed(app: Application, gaps: Gap[]): void {
  if (!app.strategy_confirmed) throw new HttpError(409, WRITER_MESSAGES.strategyNotConfirmed);
  const blocking = blockingGaps(gaps);
  if (blocking.length) {
    throw new HttpError(
      409,
      `${blocking.length} high-severity gap(s) unresolved. Resolve, record 'we don't have that', or explicitly waive them: ` +
        blocking
          .slice(0, 5)
          .map((gap) => gap.description.slice(0, 80))
          .join('; '),
    );
  }
}

/** Drafts in the grant spec's section order (unknown sections last), like the Python export's _ordered. */
export function orderDrafts(drafts: SectionDraft[], spec: GrantSpec | null): SectionDraft[] {
  const order = new Map((spec?.required_sections ?? []).map((section, index) => [section.id, index]));
  return [...drafts].sort((a, b) => (order.get(a.section_id) ?? 999) - (order.get(b.section_id) ?? 999));
}

/**
 * Drafts measured against the CURRENT requirements. Re-analyzing the grant
 * (e.g. after pasting the real guidelines) can drop or add sections, so
 * scoring and export use `current`; `stale` drafts are kept but never
 * exported, and `missing` sections still need drafting.
 */
const titleKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * A draft answers a section only if it was written for that question. Ids
 * alone aren't enough: re-analyzing the grant numbers sections s1, s2, s3...
 * again, so a new "s1" can be a different question from the old "s1".
 */
export function replacedQuestionMessage(oldTitle: string, newTitle: string): string {
  return `This draft answers "${oldTitle}", which the current requirements replaced with "${newTitle}". Use Redraft to write the new section first.`;
}

export function draftFitsSection(draft: SectionDraft, section: RequiredSection | undefined): boolean {
  return Boolean(section) && titleKey(draft.title) === titleKey((section as RequiredSection).title);
}

export function draftsVsSpec(drafts: SectionDraft[], spec: GrantSpec): { current: SectionDraft[]; stale: SectionDraft[]; missing: RequiredSection[] } {
  const byId = new Map(spec.required_sections.map((section) => [section.id, section]));
  const fits = (draft: SectionDraft) => draftFitsSection(draft, byId.get(draft.section_id));
  const current = drafts.filter(fits);
  const covered = new Set(current.map((draft) => draft.section_id));
  return {
    current: orderDrafts(current, spec),
    stale: drafts.filter((draft) => !fits(draft)),
    missing: spec.required_sections.filter((section) => !covered.has(section.id)),
  };
}

/** Read a grant's guidelines from its website (HTML or PDF, SSRF-safe). Never throws. */
export async function fetchGuidelines(url: string, timeoutMs = 30_000): Promise<{ ok: boolean; text: string; reason: string }> {
  // fetchPage's timeout covers the download, not its DNS check or reading a PDF: a hard
  // stop here keeps the step inside its time budget whatever the network does.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hardStop = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs + 2_000);
  });
  const page = await Promise.race([fetchPage(normalizeUrl(url), { maxChars: 60000, timeoutMs }), hardStop]).finally(() => clearTimeout(timer));
  if (!page) return { ok: false, text: '', reason: `Timed out after ${Math.round(timeoutMs / 1000)} seconds` };
  if (page.ok) return { ok: true, text: page.text, reason: '' };
  let reason = page.status !== null && page.status >= 400 ? `HTTP ${page.status}` : page.error || 'no readable text';
  // fetchPage's timeout message assumes its default; say how long this read was allowed.
  if (/^Timed out after/.test(reason)) reason = `Timed out after ${Math.round(timeoutMs / 1000)} seconds`;
  return { ok: false, text: '', reason };
}

// =============================================================================
// Compliance (deterministic, after every generation and refinement)
// =============================================================================

/** Deterministic format + voice compliance (format is pass/fail). Updates the draft in place. */
export function applyCompliance(draft: SectionDraft, section: RequiredSection | null, profile: OrganizationProfile | null): void {
  const text = draft.current_draft;
  draft.word_count = countWords(text);
  draft.char_count = countChars(text);
  let over = false;
  if (section?.word_limit && draft.word_count > section.word_limit) over = true;
  if (section?.char_limit && draft.char_count > section.char_limit) over = true;
  draft.over_limit = over;
  draft.banned_phrase_hits = findBannedPhrases(text, orgBannedPhrases(profile));
}

/** The requirement whose limits apply to a draft: the section it was written for, or null for a stale draft. */
export function limitsFor(draft: SectionDraft, spec: GrantSpec | null): RequiredSection | null {
  const section = spec?.required_sections.find((item) => item.id === draft.section_id);
  return section && draftFitsSection(draft, section) ? section : null;
}

/**
 * Copies of the drafts re-checked against the CURRENT requirements and the
 * CURRENT banned phrases (stored flags go stale when the grant is re-analyzed
 * or a voice profile adds phrases). Nothing is saved.
 */
export function liveCompliance(drafts: SectionDraft[], spec: GrantSpec | null, profile: OrganizationProfile | null): SectionDraft[] {
  return drafts.map((draft) => {
    const checked = structuredClone(draft);
    applyCompliance(checked, limitsFor(checked, spec), profile);
    return checked;
  });
}

/** Add a compliance note unless the section already has it. */
export function addNote(draft: SectionDraft, note: string): void {
  draft.compliance_notes = draft.compliance_notes ?? [];
  if (!draft.compliance_notes.includes(note)) draft.compliance_notes.push(note);
}

/** Keep text that is being replaced in the section's history (newest last, capped). */
function keepVersion(draft: SectionDraft, text: string): void {
  draft.versions = [...(draft.versions ?? []), text].slice(-MAX_SECTION_VERSIONS);
}

/** Line breaks as the browser sends them (\r\n) saved as \n, so counts and comparisons are stable. */
export function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * The person's own edit replaces a section's text: the replaced text goes into
 * the history, counts and banned phrases are re-checked against the current
 * limits, and the claim list (from the AI draft) is kept with a note to re-check it.
 */
export function applyHandEdit(
  draft: SectionDraft,
  text: string,
  section: RequiredSection | null,
  profile: OrganizationProfile | null,
): SectionDraft {
  keepVersion(draft, draft.current_draft);
  draft.current_draft = text;
  applyCompliance(draft, section, profile);
  addNote(draft, SECTION_NOTES.handEdited);
  addNote(draft, SECTION_NOTES.handEditClaims);
  return draft;
}

/** "Portal Summary (1243 of 1000 characters)": which limit a section is over, for the export refusal. */
export function overLimitLabel(draft: SectionDraft, section: RequiredSection | null): string {
  if (section?.word_limit && draft.word_count > section.word_limit) return `${draft.title} (${draft.word_count} of ${section.word_limit} words)`;
  if (section?.char_limit && draft.char_count > section.char_limit) return `${draft.title} (${draft.char_count} of ${section.char_limit} characters)`;
  return draft.title;
}

/**
 * Open gaps split by whether a stakeholder request already covers them. New
 * requests are written only for `uncovered`; a `covered` gap was asked already
 * (an earlier run stopped before marking it) and is treated as routed.
 */
export function openGapsByCoverage(gaps: Gap[], requests: IntakeRequest[]): { uncovered: Gap[]; covered: Gap[] } {
  const asked = new Set(requests.flatMap((request) => request.gap_ids ?? []));
  const open = gaps.filter((gap) => gap.status === 'open');
  return { uncovered: open.filter((gap) => !asked.has(gap.id)), covered: open.filter((gap) => asked.has(gap.id)) };
}

// =============================================================================
// Stage: Extract - voice profile from samples
// =============================================================================

export async function analyzeVoice(run: WriterRun, samples: string[]): Promise<Record<string, unknown>> {
  const usable = samples.filter((sample) => sample.trim()).slice(0, 5);
  const joined = usable.map((sample) => sample.slice(0, 3000)).join('\n\n=== SAMPLE ===\n');
  const prompt = `Analyze these writing samples from one organization and extract a reusable voice profile.

SAMPLES:
${joined}

Return ONLY a JSON object:
{
  "style_guidelines": "3-6 sentences describing tone, sentence rhythm, vocabulary level, and habits to imitate",
  "banned_phrases": ["phrases and cliches this organization would never use"],
  "signature_moves": ["specific stylistic habits worth reproducing"]
}`;
  const res = await run.ai.call({ stage: 'extract', promptId: 'voice_profile_v1', prompt, maxTokens: 4000 });
  const data = parseObject(res.text);
  const guidelines = data ? joinText(data.style_guidelines).trim() : '';
  if (!data || !guidelines) throw unreadableAnswer(run, 'voice_profile_v1', res, 'voice analysis');
  return {
    style_guidelines: guidelines,
    banned_phrases: stringList(data.banned_phrases),
    signature_moves: stringList(data.signature_moves),
    samples: usable,
  };
}

// =============================================================================
// Stage: Extract - grant spec enrichment (PRD 4.2)
// =============================================================================

export async function enrichGrantSpec(run: WriterRun, grant: Grant, guidelinesText: string | null): Promise<GrantSpec> {
  const grantRecord = {
    grant_name: grant.grant_name,
    funder: grant.funder,
    deadline: grant.deadline,
    amount: grant.amount,
    description: grant.description,
    eligibility_notes: grant.eligibility_notes ?? null,
    url: grant.url,
  };
  const guidelinesBlock = guidelinesText
    ? `FULL GUIDELINES TEXT:\n${guidelinesText.slice(0, 60000)}`
    : 'No full guidelines provided - infer conservatively from the grant record and say so in notes.';

  const prompt = `You are preparing a Grant Spec: the complete application requirements for one grant.

EXISTING GRANT RECORD (from grantfinder discovery - do not contradict it):
${pretty(grantRecord)}

${guidelinesBlock}

Extract and return ONLY a JSON object:
{
  "required_sections": [
    {"id": "s1", "title": "Section title", "prompt": "the funder's actual question/prompt", "word_limit": null, "char_limit": null, "notes": ""}
  ],
  "format_constraints": ["hard constraints: page limits, fonts, portal type, attachment rules"],
  "deliverables": ["required extras beyond narrative: budget, letters of support, video, one-pager"],
  "rubric": [
    {"id": "c1", "name": "criterion", "description": "what the funder scores here", "weight": null}
  ],
  "rubric_source": "explicit or inferred",
  "funder_language_cues": ["vocabulary the funder uses that the application should mirror"],
  "funder_priorities": ["what this funder demonstrably cares about"]
}

Rules:
- If the guidelines publish explicit scoring criteria/weights, use them verbatim and set rubric_source to "explicit".
- Otherwise infer a rubric from stated priorities and set rubric_source to "inferred".
- If no guidelines text was provided, produce a typical section set for this kind of grant and mark every section's notes with "INFERRED - verify against actual guidelines".
- Never invent word limits: use null when unknown.`;

  const res = await run.ai.call({ stage: 'extract', promptId: 'grant_spec_v1', prompt, maxTokens: 6000 });
  const data = parseObject(res.text);
  if (!data) throw unreadableAnswer(run, 'grant_spec_v1', res, 'grant requirements');

  const usedIds = new Set<string>();
  const sections: RequiredSection[] = [];
  listOf(data.required_sections).forEach((item, index) => {
    const s = asRecord(item);
    const title = joinText(s.title);
    if (!title.trim()) return;
    let notes = joinText(s.notes);
    // Hard rule: without guidelines every section is a guess, and says so.
    if (!guidelinesText && !/inferred/i.test(notes)) {
      notes = notes.trim() ? `${notes.trim()} (INFERRED - verify against actual guidelines)` : 'INFERRED - verify against actual guidelines';
    }
    sections.push({
      id: sectionId(s.id, index, usedIds),
      title,
      prompt: joinText(s.prompt),
      word_limit: limitValue(s.word_limit),
      char_limit: limitValue(s.char_limit),
      notes,
    });
  });
  if (!sections.length) {
    throw unreadableAnswer(
      run,
      'grant_spec_v1',
      res,
      'grant requirements',
      'no application sections came back' +
        (guidelinesText ? ' (check that the pasted text includes the application questions)' : ' (pasting the guidelines gives the best result)'),
    );
  }

  const rubric: RubricCriterion[] = [];
  listOf(data.rubric).forEach((item, index) => {
    const c = asRecord(item);
    const name = joinText(c.name);
    if (!name.trim()) return;
    rubric.push({
      id: asString(c.id).trim() || `c${index + 1}`,
      name,
      description: joinText(c.description),
      weight: asNumber(c.weight, null),
    });
  });

  let rubricSource = asString(data.rubric_source).trim().toLowerCase() || 'inferred';
  if (rubricSource !== 'explicit' && rubricSource !== 'inferred') rubricSource = 'inferred';
  // Criteria can only be "explicit" when we actually had the published guidelines.
  if (!guidelinesText) rubricSource = 'inferred';

  return {
    grant_id: grant.id,
    required_sections: sections,
    format_constraints: stringList(data.format_constraints),
    deliverables: stringList(data.deliverables),
    rubric,
    rubric_source: rubricSource,
    funder_language_cues: stringList(data.funder_language_cues),
    funder_priorities: stringList(data.funder_priorities),
    guidelines_text: guidelinesText,
    enriched_at: new Date().toISOString(),
  };
}

// =============================================================================
// Stage: Funder History - what the grantor has actually funded
// =============================================================================
//
// The grant spec says what the funder ASKS for; the funder history says what
// it actually FUNDS. One record per grant (writerRepo funder key) holds what
// the person pasted, files they added, and Claude's web research; the profile
// built from it (funder_profile_v1) feeds the fit analysis, drafting and
// scoring. Never invented: comparable grants need a named recipient, and a
// recipient that does not appear in the material is shown flagged and never
// reaches a drafting prompt.

export const FUNDER_RESEARCH_PROMPT_ID = 'funder_research_v1';
export const FUNDER_PROFILE_PROMPT_ID = 'funder_profile_v1';

/** Pasted funder notes are kept up to this many characters. */
export const FUNDER_NOTES_LIMIT = 60_000;
/** Text kept from one uploaded funder file (like documents elsewhere). */
export const FUNDER_FILE_TEXT_LIMIT = 60_000;
/** Files one funder history can hold (a file with the same name replaces the old one). */
export const FUNDER_MAX_FILES = 6;
/** Web research findings kept. */
export const FUNDER_RESEARCH_LIMIT = 30_000;
/** Funder material sent to Claude for one profile. A step inside one Netlify request sends less, so the call fits its minute. */
export const FUNDER_MATERIAL_LIMIT = 80_000;
export const FUNDER_MATERIAL_LIMIT_DIRECT = 50_000;
/** Web research inside one request (direct mode): like AI web discovery, a few searches and one continuation. */
export const FUNDER_RESEARCH_DIRECT = { maxSearches: 3, maxContinuations: 1 } as const;
/** Web research in a long background run. */
export const FUNDER_RESEARCH_MAX_SEARCHES = 6;
/** Comparable grants kept from one profile. */
const MAX_COMPARABLES = 10;
/** Research shorter than this (or "NOTHING FOUND") found nothing usable. */
const MIN_USEFUL_RESEARCH_CHARS = 120;

const withCommas = (n: number) => n.toLocaleString('en-US');

export const FUNDER_MESSAGES = {
  noMaterial:
    'Add something about this funder first: paste what you know, add a file, or click "Research the web and build".',
  busy:
    'Funder research or a funder profile build is still running for this grant. Wait for it to finish, then try again. What you typed is kept.',
  tooManyFiles: `This funder history already has ${FUNDER_MAX_FILES} files. Remove one before adding another.`,
  fileNotFound: 'That file is not in this funder history. Reload the page to see the current files.',
  researchOutOfTime:
    'Web research needs more time than this site allows for one step (about a minute), so it stopped before Claude wrote up what it found. ' +
    'Try again, or paste what you know about this funder and click "Build Funder Profile".',
  researchNothing:
    'Claude found nothing about this funder on the web. Paste what you know (past grantees, annual report or 990-PF grant lists, notes from calls) and click "Build Funder Profile".',
  researchStoppedEarly: 'Web research stopped before Claude finished searching; the funder profile uses what it found so far.',
  researchOutOfTimeKept: 'Web research ran out of time before it found anything new; the funder profile was built from what you already had.',
  researchNothingKept: 'Web research found nothing new about this funder; the funder profile was built from what you already had.',
  notesCut: `Your pasted notes were longer than ${withCommas(FUNDER_NOTES_LIMIT)} characters; only the first ${withCommas(FUNDER_NOTES_LIMIT)} are kept. Add a long grant list as a file instead.`,
  buildOutOfTime:
    'Building the funder profile took longer than this site allows for one step (about a minute). Try again; if it keeps happening, shorten the pasted notes or remove a large file.',
} as const;

export function emptyFunderRecord(grantId: string, now: string): FunderRecord {
  return {
    grant_id: grantId,
    notes_text: '',
    source_files: [],
    research_notes: '',
    research_sources: [],
    researched_at: null,
    profile: null,
    material_updated_at: null,
    updated_at: now,
  };
}

/** Anything to build a profile from: notes, a file, or earlier web research. */
export function hasFunderMaterial(record: FunderRecord | null): boolean {
  return Boolean(record && (record.notes_text.trim() || record.source_files.length || record.research_notes.trim()));
}

/** The notes, files or research changed after the profile was built. */
export function funderProfileOutdated(record: FunderRecord): boolean {
  return Boolean(record.profile && record.material_updated_at && record.material_updated_at > record.profile.generated_at);
}

/** What the website gets: the record without the big texts. */
export function funderRecordView(record: FunderRecord | null): FunderRecordView | null {
  if (!record) return null;
  return {
    grant_id: record.grant_id,
    notes_text: record.notes_text,
    source_files: record.source_files.map((file) => ({ name: file.name, chars: file.chars, added_at: file.added_at })),
    research_chars: record.research_notes.length,
    research_sources: record.research_sources,
    researched_at: record.researched_at,
    profile: record.profile,
    profile_outdated: funderProfileOutdated(record),
    material_updated_at: record.material_updated_at,
    updated_at: record.updated_at,
  };
}

/** Lowercase letters and digits, single-spaced: how names are compared with the material ("[St. Name]" = "st name"). */
function matchable(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** `needle` appears in `haystack` (both matchable) as whole words. */
function containsWords(haystack: string, needle: string): boolean {
  return needle !== '' && ` ${haystack} `.includes(` ${needle} `);
}

/** The funder material for one profile, fitted to the prompt. */
export interface FunderMaterial {
  /** The block sent to Claude. */
  text: string;
  /** Everything Claude saw (material and grant record), matchable: names in the profile must appear here. */
  searchable: string;
  /** Where the material came from: "pasted notes", file names, research URLs. */
  sources: string[];
  /** Parts cut to fit, as the person knows them ("your pasted notes", "\"report.pdf\""). */
  cut: string[];
  /** Characters of material sent. */
  chars: number;
}

export function funderMaterial(record: FunderRecord, grant: Grant | null, limit: number): FunderMaterial {
  // name: how the person knows it; label: the heading Claude sees.
  const parts: Array<{ name: string; label: string; text: string }> = [];
  if (record.notes_text.trim()) parts.push({ name: 'your pasted notes', label: 'Pasted notes', text: record.notes_text.trim() });
  for (const file of record.source_files) {
    if (file.text.trim()) parts.push({ name: `"${file.name}"`, label: `File: ${file.name}`, text: file.text.trim() });
  }
  if (record.research_notes.trim()) {
    parts.push({
      name: 'the web research',
      label: 'Web research (Claude searched the web earlier; source URLs inline)',
      text: record.research_notes.trim(),
    });
  }
  // Share the room fairly: short parts go whole, long ones are cut to an equal share of what is left.
  const order = parts.map((part, index) => ({ index, length: part.text.length })).sort((a, b) => a.length - b.length);
  const room = new Array<number>(parts.length).fill(0);
  let remaining = limit;
  order.forEach((item, position) => {
    room[item.index] = Math.min(item.length, Math.floor(remaining / (order.length - position)));
    remaining -= room[item.index];
  });
  const cut: string[] = [];
  const sent = parts.map((part, index) => {
    if (room[index] >= part.text.length) return { text: part.text, header: `=== ${part.label} ===` };
    cut.push(part.name);
    return {
      text: cutText(part.text, room[index]),
      header: `=== ${part.label} (the first ${withCommas(room[index])} of ${withCommas(part.text.length)} characters) ===`,
    };
  });
  const grantText = grant
    ? [grant.grant_name, grant.funder, grant.description, grant.eligibility_notes ?? '', grant.amount, grant.funder_stats ?? ''].join('\n')
    : '';
  const sources = [
    ...(record.notes_text.trim() ? ['pasted notes'] : []),
    ...record.source_files.map((file) => file.name),
    ...record.research_sources,
  ];
  return {
    text: sent.map((part) => `${part.header}\n${part.text}`).join('\n\n'),
    searchable: matchable([...sent.map((part) => part.text), grantText].join('\n')),
    sources: Array.from(new Set(sources)),
    cut,
    chars: sent.reduce((sum, part) => sum + part.text.length, 0),
  };
}

function funderGrantRecord(grant: Grant): Record<string, unknown> {
  return {
    grant_name: grant.grant_name,
    funder: grant.funder,
    amount: grant.amount,
    deadline: grant.deadline,
    description: grant.description,
    eligibility_notes: grant.eligibility_notes ?? null,
    funder_stats: grant.funder_stats ?? null,
    url: grant.url,
  };
}

/** Who is applying, for judging what is comparable (and whether it was funded before). */
function applicantSlice(profile: OrganizationProfile): Record<string, unknown> {
  return {
    organization_name: profile.organization_name,
    organization_type: profile.organization_type,
    city: profile.city,
    state: profile.state,
    diocese: profile.diocese ?? null,
    has_school: profile.has_school,
    student_count: profile.student_count ?? null,
    annual_budget: profile.annual_budget ?? null,
    program_needs: profile.program_needs,
    facility_needs: profile.facility_needs,
    current_initiatives: profile.current_initiatives,
    previous_grants: profile.previous_grants,
    prior_grants_detail: profile.prior_grants_detail,
  };
}

/** funder_research_v1: web search for what this funder has funded (plain-text findings with source URLs). */
export function funderResearchPrompt(grant: Grant, profile: OrganizationProfile | null, maxSearches: number): string {
  const applicant = profile
    ? { organization_type: profile.organization_type, city: profile.city, state: profile.state, diocese: profile.diocese ?? null, has_school: profile.has_school }
    : { organization_type: 'Catholic parish and/or school' };
  const place = profile && (profile.city || profile.state) ? ` near ${[profile.city, profile.state].filter(Boolean).join(', ')}` : '';
  return `You are researching a grant funder's giving history so a Catholic parish or school can write an application that matches what this funder actually funds, not only its written guidelines.

FUNDER: ${grant.funder || '(not named in the grant record)'}
GRANT: ${grant.grant_name}
GRANT WEBSITE: ${grant.url?.trim() || 'none on record'}

GRANT RECORD:
${pretty(funderGrantRecord(grant))}

APPLICANT (only to judge what is comparable; do not research the applicant):
${pretty(applicant)}

Use web search (at most ${maxSearches} searches) to find what this funder has actually funded:
- past grantees and grant amounts: annual reports, the funder's website, IRS Form 990-PF grant lists, news from recipients
- stated priorities, geographic focus, exclusions, and how applications are reviewed
- grants to Catholic schools, parishes, or similar organizations${place}

Write plain-text findings (no JSON) in these short sections:
FUNDER OVERVIEW
PAST GRANTS (one line each: recipient exactly as the source writes it | year | amount | purpose | source URL)
PRIORITIES AND PATTERNS
EXCLUSIONS AND PROCESS
SOURCES (every URL you used)

Rules:
- Report only what a source says, with its URL. Never invent grantees, amounts, years, priorities or contacts; write "not found" instead.
- Keep it under 1,500 words.
- If you find nothing about this funder, answer exactly: NOTHING FOUND`;
}

/** Plain findings worth keeping (not "NOTHING FOUND", not a one-line apology). */
export function usefulResearch(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= MIN_USEFUL_RESEARCH_CHARS && !/^NOTHING FOUND\b/i.test(trimmed);
}

const URL_PATTERN = /https?:\/\/[^\s<>"'`|)\]]+/gi;

/** Source URLs in the findings and in the answer's citations (real web search answers cite sources). */
export function researchSources(text: string, content: unknown[] = []): string[] {
  const found: string[] = [];
  for (const block of content) {
    const citations = (block as { citations?: unknown } | null)?.citations;
    if (!Array.isArray(citations)) continue;
    for (const citation of citations) {
      const url = (citation as { url?: unknown } | null)?.url;
      if (typeof url === 'string') found.push(url);
    }
  }
  for (const match of text.matchAll(URL_PATTERN)) found.push(match[0]);
  const urls: string[] = [];
  for (const raw of found) {
    const cleaned = raw.trim().replace(/[.,;:!?'"]+$/, '');
    try {
      const url = new URL(cleaned);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !urls.includes(url.href)) urls.push(url.href);
    } catch {
      // not a web address
    }
  }
  return urls.slice(0, 25);
}

/** The findings to save: the text, plus cited URLs it does not mention, cut to the research limit. */
export function researchNotes(text: string, sources: string[]): string {
  const body = text.trim();
  const unlisted = sources.filter((url) => !body.includes(url));
  const withSources = unlisted.length ? `${body}\n\nSOURCES CITED\n${unlisted.join('\n')}` : body;
  return cutText(withSources, FUNDER_RESEARCH_LIMIT);
}

/** funder_profile_v1: the funder profile from the material (JSON). */
export function funderProfilePrompt(grant: Grant, spec: GrantSpec | null, profile: OrganizationProfile, material: FunderMaterial): string {
  const requirements = spec
    ? pretty({
        funder_priorities: spec.funder_priorities,
        rubric: rubricJson(spec.rubric),
        funder_language_cues: spec.funder_language_cues,
      })
    : 'Not analyzed yet.';
  return `You are a grant strategist building a Funder Profile: what this funder has actually funded, so a Catholic parish or school can match its application to the funder's real giving history, not only its written guidelines.

GRANT RECORD (from grantfinder discovery):
${pretty(funderGrantRecord(grant))}

WHAT THE GUIDELINES ASK FOR (already extracted):
${requirements}

APPLICANT (judge what is comparable to this organization):
${pretty(applicantSlice(profile))}

FUNDER MATERIAL (the applicant's notes, files and earlier web research):
${material.text}

Return ONLY a JSON object:
{
  "summary": "2-4 sentences: who this funder really funds, how much, and what that means for this application",
  "priorities": [{"priority": "what they fund in practice", "evidence": "where the material shows it"}],
  "giving_patterns": {"typical_range": "e.g. $5,000-$25,000, or empty if the material doesn't show it", "median_award": null, "grants_per_year": null, "geography": "where they give", "recipient_types": ["kinds of organizations they fund"]},
  "comparable_grants": [
    {"recipient": "exactly as written in the material", "year": null, "amount": null, "purpose": "what the grant paid for", "why_comparable": "how it resembles this applicant or request"}
  ],
  "exclusions": ["what they don't fund, or rules that could disqualify this applicant"],
  "process_requirements": ["how they decide and what they require: letter of inquiry, site visit, one request a year"],
  "ask_recommendation": {"range": "$X-$Y", "rationale": "why, citing the comparable grants or the stated range"},
  "language_cues": ["words the funder uses about its own giving"],
  "positioning": ["3-6 concrete recommendations for framing this application to match what they fund"],
  "unknowns": ["what the material doesn't show that would change the strategy"],
  "sources": ["pasted notes", "file name", "https://..."]
}

Rules:
- Use ONLY the funder material and the grant record. Never invent grantees, amounts, years, priorities, people or contacts.
- comparable_grants: at most ${MAX_COMPARABLES}, only grants the material states, with the recipient copied exactly as written. Most comparable first. If the material names no grants, return [].
- ask_recommendation: null unless the material shows award sizes; the rationale must cite the comparable grants or the stated range.
- Mark anything you infer (rather than read) with "(inferred)".
- Never say the applicant has a relationship with this funder or was funded by it before, unless the APPLICANT section says so.`;
}

/** Text or null (null, "n/a", "unknown" and friends are null). Numbers become text ("2024", "$15,000" for amounts). */
function optionalText(value: unknown, money = false): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return money ? `$${withCommas(value)}` : String(value);
  return refText(value);
}

/** A recipient as written, or null when the entry names none ("", "unknown", "various", "not named"). */
function recipientName(value: unknown): string | null {
  const text = refText(value);
  if (!text) return null;
  if (/^(various|multiple|several|many|(an? )?unnamed|undisclosed|not (named|listed|stated|given|disclosed))\b/i.test(text)) return null;
  return text;
}

/** Parse funder_profile_v1. Null when the answer holds nothing usable. `dropped` = comparable grants with no recipient. */
export function parseFunderProfile(
  text: string,
  material: Pick<FunderMaterial, 'searchable' | 'sources'>,
  generatedAt: string,
): { profile: FunderProfile; dropped: number } | null {
  const data = parseObject(text);
  if (!data) return null;

  const priorities: FunderPriority[] = [];
  for (const item of listOf(data.priorities)) {
    if (typeof item === 'string') {
      if (item.trim()) priorities.push({ priority: item.trim(), evidence: '' });
      continue;
    }
    const p = asRecord(item);
    const priority = joinText(p.priority).trim();
    if (priority) priorities.push({ priority, evidence: joinText(p.evidence).trim() });
  }

  let dropped = 0;
  const comparables: ComparableGrant[] = [];
  for (const item of listOf(data.comparable_grants)) {
    const c = asRecord(item);
    const recipient = recipientName(c.recipient);
    // Never invented: a grant with no named recipient is not a comparable grant.
    if (!recipient) {
      dropped++;
      continue;
    }
    if (comparables.length >= MAX_COMPARABLES) continue;
    comparables.push({
      recipient,
      year: optionalText(c.year),
      amount: optionalText(c.amount, true),
      purpose: joinText(c.purpose).trim(),
      why_comparable: joinText(c.why_comparable).trim(),
      verified: containsWords(material.searchable, matchable(recipient)),
    });
  }

  const patterns = asRecord(data.giving_patterns);
  const ask = asRecord(data.ask_recommendation);
  const askRange = joinText(ask.range).trim();
  const askRationale = joinText(ask.rationale).trim();

  // Sources: where the material came from, plus any other source Claude names that appears in it.
  const known = new Set(material.sources.map((source) => source.toLowerCase()));
  const sources = [...material.sources];
  for (const source of stringList(data.sources)) {
    const trimmed = source.trim();
    if (!trimmed || known.has(trimmed.toLowerCase())) continue;
    if (containsWords(material.searchable, matchable(trimmed))) {
      known.add(trimmed.toLowerCase());
      sources.push(trimmed);
    }
  }

  const profile: FunderProfile = {
    summary: joinText(data.summary).trim(),
    priorities: priorities.slice(0, 12),
    giving_patterns: {
      typical_range: joinText(patterns.typical_range).trim(),
      median_award: optionalText(patterns.median_award, true),
      grants_per_year: optionalText(patterns.grants_per_year),
      geography: joinText(patterns.geography).trim(),
      recipient_types: stringList(patterns.recipient_types).slice(0, 12),
    },
    comparable_grants: comparables,
    exclusions: stringList(data.exclusions).slice(0, 12),
    process_requirements: stringList(data.process_requirements).slice(0, 12),
    ask_recommendation: askRange && askRationale ? { range: askRange, rationale: askRationale } : null,
    language_cues: stringList(data.language_cues).slice(0, 15),
    positioning: stringList(data.positioning).slice(0, 8),
    unknowns: stringList(data.unknowns).slice(0, 12),
    sources: sources.slice(0, 30),
    generated_at: generatedAt,
  };
  if (!profile.summary && !profile.priorities.length && !profile.comparable_grants.length && !profile.positioning.length) return null;
  return { profile, dropped };
}

/** Build the funder profile (one Claude call, no tools). `generatedAt` = when the material was read. */
export async function buildFunderProfile(
  run: WriterRun,
  grant: Grant,
  spec: GrantSpec | null,
  profile: OrganizationProfile,
  material: FunderMaterial,
  generatedAt: string,
): Promise<{ profile: FunderProfile; dropped: number }> {
  const prompt = funderProfilePrompt(grant, spec, profile, material);
  const res = await run.ai.call({ stage: 'funder', promptId: FUNDER_PROFILE_PROMPT_ID, prompt, maxTokens: 5000 });
  const parsed = parseFunderProfile(res.text, material, generatedAt);
  if (!parsed) throw unreadableAnswer(run, FUNDER_PROFILE_PROMPT_ID, res, 'funder profile');
  if (parsed.dropped) run.note?.(`${FUNDER_PROFILE_PROMPT_ID}: left out ${parsed.dropped} comparable grant(s) that named no recipient.`);
  const unverified = parsed.profile.comparable_grants.filter((grantMade) => !grantMade.verified);
  if (unverified.length) {
    run.note?.(
      `${FUNDER_PROFILE_PROMPT_ID}: ${unverified.length} comparable grant(s) name a recipient not found in the material ` +
        '(shown flagged, never used for drafting).',
    );
  }
  return parsed;
}

/** Comparable grants whose recipient appears in the material: the only ones a later prompt sees. */
function verifiedComparables(funder: FunderProfile): ComparableGrant[] {
  return funder.comparable_grants.filter((grantMade) => grantMade.verified);
}

/** The funder history block for the fit analysis (fit_gap_v1). */
function funderBlockForFit(funder: FunderProfile): string {
  return `FUNDER HISTORY (what this funder has actually funded, from the applicant's notes, files and web research; "(inferred)" marks inferences):
${pretty({
  summary: funder.summary,
  priorities: funder.priorities,
  typical_award: funder.giving_patterns.typical_range || null,
  geography: funder.giving_patterns.geography || null,
  recipient_types: funder.giving_patterns.recipient_types,
  comparable_grants: verifiedComparables(funder),
  exclusions: funder.exclusions,
  process_requirements: funder.process_requirements,
  ask_recommendation: funder.ask_recommendation,
  positioning: funder.positioning,
})}`;
}

const FIT_FUNDER_RULES = `
- FUNDER HISTORY is what this funder has actually funded. The recommended_strategy must say how to match it: lead with what resembles the comparable grants, follow the positioning advice, and keep the ask inside the typical range.
- You may add one fit_map entry with criterion_id "funder_history" and criterion_name "Fit with what this funder has funded", rating how closely this applicant and request resemble the funder's past grants.
- Add gaps for the funder's process requirements the profile does not show it can meet, and for exclusions that may apply. Use severity "high" when an exclusion clearly applies to this applicant or request.
- The funder history is about the funder, never evidence about the applicant.`;

/** The funder history block for drafting (section_draft_v1). */
function funderBlockForDraft(funder: FunderProfile): string {
  return `FUNDER HISTORY (emphasize what this funder demonstrably funds; it guides emphasis and scale, it is NOT a source of facts about the organization):
${pretty({
  summary: funder.summary,
  positioning: funder.positioning,
  priorities: funder.priorities.map((item) => item.priority),
  comparable_grants: verifiedComparables(funder).map(({ recipient, year, amount, purpose }) => ({ recipient, year, amount, purpose })),
  ask_recommendation: funder.ask_recommendation,
})}`;
}

/** The funder history block for self-scoring (self_score_v1). */
function funderBlockForScore(funder: FunderProfile): string {
  return `FUNDER HISTORY (what this funder has actually funded):
${pretty({
  summary: funder.summary,
  priorities: funder.priorities.map((item) => item.priority),
  typical_award: funder.giving_patterns.typical_range || null,
  ask_recommendation: funder.ask_recommendation,
  comparable_grants: verifiedComparables(funder).map(({ recipient, year, amount, purpose }) => ({ recipient, year, amount, purpose })),
  exclusions: funder.exclusions,
})}

Also judge how closely this draft matches what this funder has funded before, and whether the amount asked fits their typical range. If that is the biggest weakness, make it the top_fix.`;
}

/** The grant spec's language cues plus the funder history's, each once (case-insensitive), spec first. */
function mergedLanguageCues(specCues: string[], funder: FunderProfile | null): string[] {
  if (!funder) return specCues;
  const seen = new Set<string>();
  return [...specCues, ...funder.language_cues].filter((cue) => {
    const key = cue.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// =============================================================================
// Stage: Map - fit/gap analysis (PRD 4.3, the core value)
// =============================================================================

export async function analyzeFit(
  run: WriterRun,
  profile: OrganizationProfile,
  spec: GrantSpec,
  applicationId: string,
  funder: FunderProfile | null = null,
): Promise<{ analysis: FitAnalysis; gaps: Gap[] }> {
  // Without a funder profile the prompt is exactly the original one.
  const funderBlock = funder ? `\n\n${funderBlockForFit(funder)}` : '';
  const funderRules = funder ? FIT_FUNDER_RULES : '';
  const prompt = `You are a seasoned grant strategist. Cross-reference this organization against this grant's rubric and requirements.

ORGANIZATION PROFILE:
${pretty(profileSlice(profile))}

GRANT RUBRIC (source: ${spec.rubric_source}):
${pretty(rubricJson(spec.rubric))}

REQUIRED SECTIONS:
${pretty(spec.required_sections.map(sectionJson))}

FUNDER PRIORITIES: ${pyJson(spec.funder_priorities)}${funderBlock}

Return ONLY a JSON object:
{
  "fit_map": [
    {"criterion_id": "c1", "criterion_name": "...", "rating": "strong|partial|weak|missing",
      "evidence": ["specific facts from the profile that support this criterion"],
      "missing": "what's absent, or null"}
  ],
  "strength_leads": ["the 2-4 criteria to open with and emphasize"],
  "honesty_ledger": ["weaknesses that should be NAMED AND FRAMED honestly rather than hidden"],
  "recommended_strategy": "3-6 sentences: the narrative strategy - what to lead with, how to frame weaknesses, which evidence carries the application",
  "gaps": [
    {"criterion_ref": "c1 or section id", "description": "the specific missing information",
      "severity": "high|medium|low",
      "suggested_owner_role": "who in a parish/school likely holds this: Finance, Principal, Pastor, Program Lead, Development"}
  ]
}

Rules:
- Evidence must be REAL facts present in the profile. Never invent evidence.
- severity "high" = the application cannot honestly be drafted without it (required field/criterion with nothing to support it).
- Include the "you never named the lead" class of gaps: people, letters, data points quietly required.${funderRules}`;

  const res = await run.ai.call({ stage: 'map', promptId: 'fit_gap_v1', prompt, maxTokens: 6000 });
  const data = parseObject(res.text);
  if (!data) throw unreadableAnswer(run, 'fit_gap_v1', res, 'fit analysis');

  const fitMap: FitEntry[] = [];
  for (const item of listOf(data.fit_map)) {
    const entry = asRecord(item);
    const name = joinText(entry.criterion_name);
    if (!name.trim()) continue;
    let rating = asString(entry.rating).trim().toLowerCase() || 'weak';
    if (!['strong', 'partial', 'weak', 'missing'].includes(rating)) rating = 'weak';
    const missing = joinText(entry.missing).trim();
    fitMap.push({
      criterion_id: asString(entry.criterion_id),
      criterion_name: name,
      rating,
      evidence: stringList(entry.evidence),
      missing: refText(missing) ? missing : null,
    });
  }

  const gaps: Gap[] = [];
  for (const item of listOf(data.gaps)) {
    const g = asRecord(item);
    const description = joinText(g.description);
    if (!description.trim()) continue;
    let severity = asString(g.severity).trim().toLowerCase() || 'medium';
    if (!['high', 'medium', 'low'].includes(severity)) severity = 'medium';
    gaps.push({
      id: newId('gap'),
      application_id: applicationId,
      criterion_ref: asString(g.criterion_ref),
      description,
      severity,
      suggested_owner_role: asString(g.suggested_owner_role),
      status: 'open',
      answer: null,
    });
  }

  const analysis: FitAnalysis = {
    application_id: applicationId,
    fit_map: fitMap,
    strength_leads: stringList(data.strength_leads),
    honesty_ledger: stringList(data.honesty_ledger),
    recommended_strategy: joinText(data.recommended_strategy),
    generated_at: new Date().toISOString(),
  };
  if (!fitMap.length && !analysis.recommended_strategy.trim()) {
    throw unreadableAnswer(run, 'fit_gap_v1', res, 'fit analysis');
  }
  return { analysis, gaps };
}

// =============================================================================
// Stage: Route - stakeholder intake packets (PRD 4.4)
// =============================================================================

/** The packet list from a JSON array answer (or an object wrapping one). */
function packetList(text: string): unknown[] | null {
  const array = parseArray(text);
  if (array) return array;
  const object = parseObject(text);
  if (!object) return null;
  const nested = Object.values(object).find((value) => Array.isArray(value) && value.some((item) => item !== null && typeof item === 'object'));
  if (nested) return nested as unknown[];
  return 'stakeholder_role' in object ? [object] : null;
}

export async function generateIntakePackets(
  run: WriterRun,
  application: Application,
  gaps: Gap[],
  profile: OrganizationProfile,
): Promise<IntakeRequest[]> {
  const openGaps = gaps.filter((gap) => gap.status === 'open');
  if (!openGaps.length) return [];

  const gapsJson = openGaps.map((gap) => ({
    id: gap.id,
    description: gap.description,
    severity: gap.severity,
    suggested_owner_role: gap.suggested_owner_role,
  }));
  const teamJson = profile.team_members || [];

  const prompt = `You are helping a Grant Lead collect missing information for a grant application to ${application.funder} (${application.grant_name}), deadline ${application.deadline || 'unknown'}.

INFORMATION GAPS:
${pretty(gapsJson)}

KNOWN TEAM/STAKEHOLDERS (may be empty):
${pretty(teamJson)}

Group the gaps by the single stakeholder role most likely to hold each answer (one owner per gap - never assign a gap to two people). For each stakeholder, produce a request packet.

Return ONLY a JSON array:
[
  {
    "stakeholder_role": "Finance / Principal / Pastor / Program Lead / Development / ...",
    "gap_ids": ["gap ids assigned to this person"],
    "framing": "one line: why we need this, in plain language",
    "questions": ["specific, answerable questions - each should take a few sentences to answer"],
    "expected_format": "e.g. 'A few sentences is fine' or 'A number and a date'",
    "suggested_deadline": "a reasonable date given the grant deadline, or null",
    "email_packet": "A complete, copy-paste-ready email: warm, brief, explains why, lists the questions, says how much detail is expected, explicitly says 'if we don't have this, just say so - that's a useful answer too'."
  }
]`;

  const res = await run.ai.call({ stage: 'route', promptId: 'intake_packets_v1', prompt, maxTokens: 5000 });
  const items = packetList(res.text);
  if (!items) throw unreadableAnswer(run, 'intake_packets_v1', res, 'stakeholder requests');

  const validGapIds = new Set(openGaps.map((gap) => gap.id));
  const assigned = new Set<string>();
  const requests: IntakeRequest[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const packet = item as Record<string, unknown>;
    // One owner per gap: unknown ids and second assignments are dropped.
    const gapIds = stringList(packet.gap_ids)
      .map((id) => id.trim())
      .filter((id) => validGapIds.has(id) && !assigned.has(id));
    gapIds.forEach((id) => assigned.add(id));
    const deadline = asString(packet.suggested_deadline).trim();
    requests.push({
      id: newId('intake'),
      application_id: application.id,
      stakeholder_role: asString(packet.stakeholder_role).trim() || 'Unassigned',
      gap_ids: gapIds,
      framing: joinText(packet.framing),
      questions: stringList(packet.questions),
      expected_format: joinText(packet.expected_format) || 'A few sentences is fine.',
      suggested_deadline: refText(deadline) ? deadline : null,
      email_packet: joinText(packet.email_packet),
      status: 'draft',
      response: null,
    });
  }
  const unrouted = openGaps.filter((gap) => !assigned.has(gap.id));
  if (unrouted.length) {
    run.note?.(`Not assigned to any stakeholder (still open): ${unrouted.map((gap) => gap.id).join(', ')}`);
  }
  return requests;
}

// =============================================================================
// Stage: Draft - section generation (PRD 4.5)
// =============================================================================

function parseClaims(raw: unknown): ClaimFlag[] {
  const claims: ClaimFlag[] = [];
  for (const item of listOf(raw)) {
    const c = asRecord(item);
    const claim = joinText(c.claim);
    if (!claim.trim()) continue;
    const evidenceRef = refText(c.evidence_ref);
    claims.push({
      claim,
      criterion_ref: refText(c.criterion_ref),
      evidence_ref: evidenceRef,
      flagged: !evidenceRef,
      reason: evidenceRef ? null : 'No supporting evidence in profile',
    });
  }
  return claims;
}

export async function draftSection(
  run: WriterRun,
  application: Application,
  section: RequiredSection,
  spec: GrantSpec,
  profile: OrganizationProfile,
  analysis: FitAnalysis | null,
  confirmedGaps: Gap[],
  funder: FunderProfile | null = null,
): Promise<SectionDraft> {
  let limitText = '';
  if (section.word_limit) {
    limitText = `HARD LIMIT: ${section.word_limit} words maximum. Target ${Math.floor(section.word_limit * 0.92)} words.`;
  } else if (section.char_limit) {
    limitText = `HARD LIMIT: ${section.char_limit} characters maximum. Target ${Math.floor(section.char_limit * 0.9)} characters.`;
  }

  let strategyBlock = '';
  if (analysis) {
    strategyBlock = `CONFIRMED STRATEGY:
${application.strategy || analysis.recommended_strategy}

FIT MAP (lead with strengths, address weaknesses on purpose):
${pretty(analysis.fit_map.map(fitEntryJson))}

HONESTY LEDGER (name and frame these truthfully if relevant to this section):
${pyJson(analysis.honesty_ledger)}`;
  }

  let confirmedBlock = '';
  if (confirmedGaps.length) {
    confirmedBlock =
      'CONFIRMED GAPS (the organization does NOT have these - if relevant, ' +
      'frame honestly as documented learning or planned growth; NEVER claim them):\n' +
      pyJson(confirmedGaps.map((gap) => gap.description));
  }

  // Without a funder profile the prompt is exactly the original one.
  const funderBlock = funder ? `\n\n${funderBlockForDraft(funder)}` : '';
  const funderRules = funder
    ? `\n- Never say or imply that the organization has a relationship with ${application.funder} or was funded by it before, unless the ORGANIZATION PROFILE says so.` +
      "\n- Use FUNDER HISTORY for emphasis and scale only: don't name the funder's other grantees, and never present their grants as this organization's."
    : '';

  const prompt = `Write one section of a grant application to ${application.funder} for "${application.grant_name}".

SECTION: ${section.title}
FUNDER'S PROMPT: ${section.prompt || '(none provided - write what this section conventionally covers)'}
${limitText}

ORGANIZATION PROFILE (the only source of facts you may use):
${pretty(profileSlice(profile))}

${strategyBlock}

${confirmedBlock}${funderBlock}

FUNDER LANGUAGE CUES (mirror naturally, no keyword stuffing): ${pyJson(mergedLanguageCues(spec.funder_language_cues, funder))}

${voiceBlock(profile)}

ABSOLUTE RULES:
- Never fabricate facts, numbers, partnerships, names, or credentials. Every factual claim must come from the profile.
- Where the profile lacks something this section needs, write [NEEDS INPUT: what's missing] inline rather than inventing.
- Every major claim should serve a rubric criterion.${funderRules}

Return ONLY a JSON object:
{
  "draft": "the full section text",
  "claims": [
    {"claim": "each major factual claim made", "criterion_ref": "rubric criterion it serves or null",
      "evidence_ref": "the profile fact backing it, or null if unsupported"}
  ]
}`;

  const res = await run.ai.call({ stage: 'draft', promptId: 'section_draft_v1', prompt, maxTokens: 6000 });
  const answer = readDraftAnswer(res.text);
  if (!answer) throw unreadableAnswer(run, 'section_draft_v1', res, `draft of "${section.title}"`);

  const draft: SectionDraft = {
    id: newId('sec'),
    application_id: application.id,
    section_id: section.id,
    title: section.title,
    current_draft: answer.draft,
    versions: [],
    claims: parseClaims(answer.claims),
    word_count: 0,
    char_count: 0,
    over_limit: false,
    banned_phrase_hits: [],
    compliance_notes: [],
  };
  if (answer.truncated) {
    draft.compliance_notes.push("Claude's answer was cut off before it finished; check the end of this section.");
    run.note?.(`section_draft_v1 for ${section.id}: answer cut off (stop_reason=${res.stopReason ?? 'none'}); saved what arrived.`);
  }
  if (!Array.isArray(answer.claims)) {
    // Never silently ship unverified claims: without the claim list nothing was checked.
    draft.claims.push({
      claim: 'Claims list missing: Claude did not report which profile facts back this section.',
      criterion_ref: null,
      evidence_ref: null,
      flagged: true,
      reason: 'Check every fact in this section against your profile before submitting.',
    });
    draft.compliance_notes.push('Claims could not be checked: Claude did not return its claim-to-evidence list for this section.');
  }
  applyCompliance(draft, section, profile);

  // Enforce voice: deterministic detect, AI rewrite if violated.
  if (draft.banned_phrase_hits.length) {
    if (noTimeForOptionalCall(run)) return skipEnforce(run, draft);
    return enforceVoice(run, draft, section, profile);
  }
  return draft;
}

// =============================================================================
// Stage: Refine (PRD 4.7)
// =============================================================================

export async function refineSection(
  run: WriterRun,
  application: Application,
  sectionDraft: SectionDraft,
  section: RequiredSection,
  profile: OrganizationProfile,
  instruction: string,
  allowAutoTighten = true,
): Promise<SectionDraft> {
  let limitText = '';
  if (section.word_limit) limitText = `HARD LIMIT: ${section.word_limit} words maximum.`;
  else if (section.char_limit) limitText = `HARD LIMIT: ${section.char_limit} characters maximum.`;

  const prompt = `Revise this grant application section according to one instruction. Change nothing else about its meaning; never introduce new facts.

SECTION: ${sectionDraft.title}
${limitText}

CURRENT DRAFT:
${sectionDraft.current_draft}

INSTRUCTION: ${instruction}

${voiceBlock(profile)}

Return ONLY a JSON object: {"draft": "the revised section text"}`;

  const res = await run.ai.call({ stage: 'refine', promptId: 'section_refine_v1', prompt, maxTokens: 6000 });
  const answer = readDraftAnswer(res.text);
  if (!answer) throw unreadableAnswer(run, 'section_refine_v1', res, `revision of "${sectionDraft.title}"`);

  let draft = sectionDraft;
  keepVersion(draft, draft.current_draft);
  draft.current_draft = answer.draft;
  // The claim list was checked against the text before this revision.
  addNote(draft, SECTION_NOTES.refinedClaims);
  if (answer.truncated) {
    draft.compliance_notes.push("Claude's revision was cut off before it finished; check the end of this section.");
  }
  applyCompliance(draft, section, profile);

  if (draft.banned_phrase_hits.length) {
    draft = noTimeForOptionalCall(run) ? skipEnforce(run, draft) : await enforceVoice(run, draft, section, profile);
  }

  // Rule: if a revision pushes over the limit, produce a tightened version
  // (one automatic attempt; if still over, it stays flagged for the user).
  if (draft.over_limit && allowAutoTighten && noTimeForOptionalCall(run)) {
    addNote(draft, SECTION_NOTES.tightenSkipped);
    run.note?.(`Auto-tighten of ${draft.section_id} skipped: not enough time left in this step.`);
    return draft;
  }
  if (draft.over_limit && allowAutoTighten) {
    const wordsOver = Boolean(section.word_limit && draft.word_count > section.word_limit);
    const tighten = wordsOver || !section.char_limit
      ? `Tighten to at most ${section.word_limit} words`
      : `Tighten to at most ${section.char_limit} characters`;
    draft.compliance_notes.push(`Revision exceeded the limit; auto-tightening (${tighten}).`);
    await run.progress?.(`Tightening "${draft.title}" to the limit...`);
    try {
      return await refineSection(run, application, draft, section, profile, tighten, false);
    } catch (error) {
      // A bad key or no credits fails the step; a passing problem (overload, the step's time
      // limit) keeps the revision, flagged OVER LIMIT, instead of throwing it away.
      if (isFatalClaudeError(error)) throw error;
      logger.warn('auto_tighten_failed', { correlation_id: run.correlationId, section_id: draft.section_id, error: errorMessage(error) });
      run.note?.(`Auto-tighten of ${draft.section_id} failed, kept the revision flagged: ${errorMessage(error)}`);
      addNote(draft, SECTION_NOTES.tightenFailed);
      return draft;
    }
  }
  return draft;
}

// =============================================================================
// Stage: Enforce - voice check (PRD 4.9)
// =============================================================================

/** No time for the voice rewrite: keep the section flagged (export stays blocked) and say how to fix it. */
function skipEnforce(run: WriterRun, sectionDraft: SectionDraft): SectionDraft {
  addNote(sectionDraft, enforceSkippedNote(sectionDraft.banned_phrase_hits));
  run.note?.(`Voice rewrite of ${sectionDraft.section_id} skipped: not enough time left in this step.`);
  return sectionDraft;
}

export async function enforceVoice(
  run: WriterRun,
  sectionDraft: SectionDraft,
  section: RequiredSection,
  profile: OrganizationProfile,
): Promise<SectionDraft> {
  const hits = sectionDraft.banned_phrase_hits;
  const prompt = `This text contains banned phrases / AI tells. Rewrite ONLY the offending sentences to remove them, preserving all facts and the overall length.

BANNED PHRASES FOUND: ${pyJson(hits)}

TEXT:
${sectionDraft.current_draft}

${voiceBlock(profile)}

Return ONLY a JSON object: {"draft": "the corrected full text"}`;

  try {
    await run.progress?.(`Removing banned phrases from "${sectionDraft.title}"...`);
    const res = await run.ai.call({ stage: 'enforce', promptId: 'voice_enforce_v1', prompt, maxTokens: 6000 });
    const data = parseObject(res.text);
    const corrected = data ? asString(data.draft) : '';
    if (corrected.trim()) {
      keepVersion(sectionDraft, sectionDraft.current_draft);
      sectionDraft.current_draft = corrected;
      sectionDraft.compliance_notes.push(`Voice enforcement rewrote banned phrases: ${hits.slice(0, 5).join(', ')}`);
      applyCompliance(sectionDraft, section, profile);
    } else {
      logger.warn('voice_enforce_unusable', {
        correlation_id: run.correlationId,
        section_id: sectionDraft.section_id,
        stop_reason: res.stopReason,
        chars: res.text.length,
      });
      sectionDraft.compliance_notes.push(`Banned phrases present (auto-rewrite returned no usable text): ${hits.slice(0, 5).join(', ')}`);
    }
  } catch (error) {
    if (isFatalClaudeError(error)) throw error;
    logger.warn('voice_enforce_failed', {
      correlation_id: run.correlationId,
      section_id: sectionDraft.section_id,
      error: errorMessage(error),
    });
    run.note?.(`Voice enforcement failed for ${sectionDraft.section_id}, flagged instead: ${errorMessage(error)}`);
    sectionDraft.compliance_notes.push(`Banned phrases present (auto-rewrite failed): ${hits.slice(0, 5).join(', ')}`);
  }
  return sectionDraft;
}

// =============================================================================
// Stage: Score - self-critique (PRD 4.6)
// =============================================================================

/** Deterministic pass/fail results per hard constraint, per section. */
export function complianceResults(drafts: SectionDraft[]): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  for (const d of drafts) {
    results.push({ section: d.title, check: 'word/char limit', passed: !d.over_limit, detail: `${d.word_count} words / ${d.char_count} chars` });
    results.push({ section: d.title, check: 'banned phrases', passed: !d.banned_phrase_hits.length, detail: d.banned_phrase_hits.join(', ') || 'clean' });
    const unsupported = d.claims.filter((claim) => claim.flagged).map((claim) => claim.claim);
    results.push({
      section: d.title,
      check: 'evidence-backed claims',
      passed: !unsupported.length,
      detail: unsupported.length ? `${unsupported.length} unsupported claim(s)` : 'all claims backed',
    });
  }
  return results;
}

export async function scoreDraft(
  run: WriterRun,
  application: Application,
  spec: GrantSpec,
  drafts: SectionDraft[],
  funder: FunderProfile | null = null,
): Promise<Scorecard> {
  const sectionsText = drafts.map((d) => `=== ${d.title} (${d.word_count} words) ===\n${d.current_draft}`).join('\n\n');
  // Without a funder profile the prompt is exactly the original one.
  const funderBlock = funder ? `\n\n${funderBlockForScore(funder)}` : '';

  const prompt = `You are a skeptical grant reviewer for ${application.funder}. Score this draft application against the rubric. Be honest - your job is to find what costs points BEFORE the funder does.

RUBRIC (source: ${spec.rubric_source}):
${pretty(rubricJson(spec.rubric))}${funderBlock}

DRAFT APPLICATION:
${sectionsText.slice(0, 60000)}

Return ONLY a JSON object:
{
  "per_criterion": [
    {"criterion_id": "c1", "criterion_name": "...", "score": 0-100, "weight": null,
      "commentary": "what earns and what costs points here, citing the draft"}
  ],
  "overall_score": 0-100,
  "top_fix": "THE single highest-leverage weakness - the 'missing 5 points' problem - stated specifically",
  "ranked_fixes": ["fixes ordered by score impact, most impactful first"]
}`;

  const res = await run.ai.call({ stage: 'score', promptId: 'self_score_v1', prompt, maxTokens: 5000 });
  const data = parseObject(res.text);
  if (!data) throw unreadableAnswer(run, 'self_score_v1', res, 'scorecard');

  const perCriterion: CriterionScore[] = [];
  for (const item of listOf(data.per_criterion)) {
    const c = asRecord(item);
    const name = joinText(c.criterion_name);
    if (!name.trim()) continue;
    perCriterion.push({
      criterion_id: asString(c.criterion_id),
      criterion_name: name,
      score: clamp(scoreValue(c.score) ?? 0, 0, 100),
      weight: asNumber(c.weight, null),
      commentary: joinText(c.commentary),
    });
  }

  let overall = scoreValue(data.overall_score);
  if (overall === null) {
    if (!perCriterion.length) throw unreadableAnswer(run, 'self_score_v1', res, 'scorecard');
    // No overall score came back: use the (weighted) mean of the criterion scores rather than a misleading 0.
    const weights = perCriterion.map((c) => (c.weight && c.weight > 0 ? c.weight : 1));
    const total = weights.reduce((sum, w) => sum + w, 0);
    overall = perCriterion.reduce((sum, c, i) => sum + c.score * weights[i], 0) / total;
    run.note?.('self_score_v1 returned no overall_score; used the weighted mean of the criterion scores.');
  }

  return {
    application_id: application.id,
    per_criterion: perCriterion,
    overall_score: clamp(overall, 0, 100),
    top_fix: joinText(data.top_fix),
    ranked_fixes: stringList(data.ranked_fixes),
    compliance_results: complianceResults(drafts),
    generated_at: new Date().toISOString(),
  };
}
