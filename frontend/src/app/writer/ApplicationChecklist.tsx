'use client';

/**
 * Application Checklist: one compact card that says, at a glance, what is
 * done, what is left, where the gaps are, and the single next thing to do
 * before the application goes to the funder.
 *
 * It reads the application state the writer page already loads (GET
 * /api/writer/applications/:id), every field defensively because older
 * records can lack some, plus its own small record (GET/PUT
 * /api/writer/applications/:id/checklist, routes/checklist.ts): the items a
 * person ticks off by hand and the deadline counted in days.
 *
 * It never runs a step by itself. With onAction, the "Next step" line gets a
 * button that calls onAction with one stable id (ChecklistAction below), and
 * the writer page decides what that does.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle, Circle, ListChecks, Loader2 } from 'lucide-react';
import api, { errorDetail } from '@/lib/api';
import type { Application, Gap, GrantSpec, RequiredSection, Scorecard, SectionDraft } from '@/server/types';

// =============================================================================
// Contract
// =============================================================================

/**
 * What the "Next step" button asks the writer page to do:
 *   analyze-requirements  step 1: analyze (or re-analyze) the funder's requirements
 *   run-fit               step 2: run the fit analysis
 *   confirm-strategy      step 2: bring the strategy up to review and confirm (a human
 *                         approval gate: the person confirms it, never the page)
 *   draft-missing         step 4: draft the sections with no draft yet (all of them when none is)
 *   score                 step 5: score the draft
 *   export                step 6: export (the person still picks the format and clicks)
 *   scroll:<anchor>       bring something into view: "missing-info" (step 3),
 *                         "section-<section id>" (that section's draft; the page marks it
 *                         with data-section-id), "checklist-attachments" (this card's list)
 */
export type ChecklistAction =
  | 'analyze-requirements'
  | 'run-fit'
  | 'confirm-strategy'
  | 'draft-missing'
  | 'score'
  | 'export'
  | `scroll:${string}`;

/** The application state from GET /api/writer/applications/:id (routes/writer.ts), as this card reads it. */
export interface ChecklistAppState {
  application?: Partial<Application> | null;
  has_voice_profile?: boolean | null;
  grant_spec?: Partial<GrantSpec> | null;
  fit_analysis?: unknown;
  gaps?: Array<Partial<Gap>> | null;
  open_blocking_gaps?: Array<Partial<Gap>> | null;
  sections?: Array<Partial<SectionDraft>> | null;
  missing_sections?: Array<{ id?: string; title?: string }> | null;
  stale_section_ids?: string[] | null;
  scorecard?: Partial<Scorecard> | null;
  /** Funder History stage: { profile: { process_requirements: string[], exclusions: string[], ... } | null, ... } | null */
  funder_profile?: unknown;
}

export interface ApplicationChecklistProps {
  appId: string;
  state: ChecklistAppState;
  /** A writer step is running: every checkbox and button waits. */
  busy: boolean;
  onAction?: (action: ChecklistAction) => void;
}

/** The checklist's own record (routes/checklist.ts). */
export interface ChecklistData {
  done: Record<string, boolean>;
  notes: Record<string, string>;
  next_deadline: string | null;
  days_left: number | null;
  deadline_passed: boolean;
}

// =============================================================================
// Small helpers (pure; exported ones are also used by tests)
// =============================================================================

/** "[NEEDS INPUT: ...]" markers drafting leaves where a fact was missing (same pattern as services/writer.ts). */
const NEEDS_INPUT = /\[NEEDS INPUT[^\]]*\]/gi;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Longest slug kept whole in an item key; a longer text ends in a short hash instead. */
const SLUG_MAX = 80;

const isMap = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function list<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/** The non-empty texts in a list that should hold text, with spacing tidied (anything else is skipped). */
function texts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** The value a plain map holds for a key (never an inherited one such as "constructor"). */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

const num = (value: number) => value.toLocaleString('en-US');

/** "1 day", "3 days". */
const plural = (count: number, one: string, many = `${one}s`) => `${num(count)} ${count === 1 ? one : many}`;

/** Shortened to about `max` characters, at a word break when there is one nearby. */
function clip(text: string, max = 70): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 3);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}...`;
}

/** Same rule as countWords in services/writer.ts. */
function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Same rule as countChars in services/writer.ts: code points. */
function countChars(text: string): number {
  return Array.from(text).length;
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** "2026-10-15" -> "October 15, 2026" (read as a calendar date, so no time zone can shift it). */
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return iso;
  return `${MONTH_NAMES[month - 1]} ${Number(match[3])}, ${match[1]}`;
}

/** A short, stable hash (FNV-1a), to tell long texts apart inside a key. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The stable key for one checklist item: a prefix ("deliverable", "format",
 * "process") and a slug of its text, so the same requirement keeps its tick
 * when the requirements are re-analyzed with the same wording. A long text
 * keeps 80 characters and gets a short hash, so two long items never share a key.
 */
export function itemKey(prefix: string, text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug && slug.length <= SLUG_MAX) return `${prefix}:${slug}`;
  const base = slug ? slug.slice(0, SLUG_MAX).replace(/-+$/, '') : 'item';
  return `${prefix}:${base}-${shortHash(slug || text.trim().toLowerCase())}`;
}

/** The checklist record from the engine, with anything malformed dropped. */
export function cleanChecklist(value: unknown): ChecklistData {
  const data = isMap(value) ? value : {};
  const done = isMap(data.done) ? Object.entries(data.done).filter(([, ticked]) => ticked === true) : [];
  const notes = isMap(data.notes)
    ? Object.entries(data.notes).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    : [];
  const next = typeof data.next_deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.next_deadline) ? data.next_deadline : null;
  const days = typeof data.days_left === 'number' && Number.isFinite(data.days_left) ? Math.round(data.days_left) : null;
  return {
    done: Object.fromEntries(done) as Record<string, boolean>,
    notes: Object.fromEntries(notes),
    next_deadline: next,
    days_left: next === null ? null : days,
    deadline_passed: data.deadline_passed === true,
  };
}

/** One item saved: keep everything else as shown (answers to two quick ticks can arrive in either order). */
function withSavedItem(current: ChecklistData, saved: ChecklistData, key: string): ChecklistData {
  const done = without(current.done, key);
  const notes = without(current.notes, key);
  const note = own(saved.notes, key);
  return {
    ...saved,
    done: own(saved.done, key) === true ? { ...done, [key]: true } : done,
    notes: note !== undefined ? { ...notes, [key]: note } : notes,
  };
}

/** process_requirements and exclusions from the Funder History stage, when it has them. */
function funderLists(value: unknown): { process: string[]; exclusions: string[] } {
  const profile = isMap(value) ? (isMap(value.profile) ? value.profile : value) : null;
  const unique = (items: string[]) => Array.from(new Set(items));
  return { process: unique(texts(profile?.process_requirements)), exclusions: unique(texts(profile?.exclusions)) };
}

// =============================================================================
// What the card shows (pure)
// =============================================================================

export interface ChecklistItem {
  key: string;
  label: string;
}

/** One checkbox per deliverable, format rule and funder process requirement (same key = same item, shown once). */
export function checklistItems(spec: ChecklistAppState['grant_spec'], funderProfile: unknown): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const seen = new Set<string>();
  const add = (prefix: string, text: string, label: string) => {
    const key = itemKey(prefix, text);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ key, label });
  };
  for (const text of texts(spec?.deliverables)) add('deliverable', text, text);
  for (const text of texts(spec?.format_constraints)) add('format', text, `Format: ${text}`);
  for (const text of funderLists(funderProfile).process) add('process', text, `Funder process: ${text}`);
  return items;
}

export interface SectionRow {
  id: string;
  title: string;
  drafted: boolean;
  words: number;
  chars: number;
  wordLimit: number | null;
  charLimit: number | null;
  over: boolean;
  banned: string[];
  /** [NEEDS INPUT] placeholders still in the text. */
  placeholders: number;
  flaggedClaims: string[];
  /** Key for "I checked these claims"; it changes when the flagged claims do (a redraft asks again). */
  claimsKey: string | null;
  claimsChecked: boolean;
  ready: boolean;
}

/** Each required section in the requirements' order, plus titles of drafts no longer required. */
export function sectionRows(state: ChecklistAppState, isDone: (key: string) => boolean): { rows: SectionRow[]; stale: string[] } {
  const requiredIds = new Set<string>();
  const required = list<Partial<RequiredSection>>(state.grant_spec?.required_sections).filter(
    (section): section is Partial<RequiredSection> & { id: string } => {
      if (!isMap(section) || typeof section.id !== 'string' || !section.id || requiredIds.has(section.id)) return false;
      requiredIds.add(section.id); // a repeated id is the same section
      return true;
    },
  );
  const staleIds = new Set(list(state.stale_section_ids).filter((id): id is string => typeof id === 'string'));
  const missingIds = new Set(
    list(state.missing_sections).flatMap((section) => (isMap(section) && typeof section.id === 'string' ? [section.id] : [])),
  );
  const drafts = list(state.sections).filter(
    (draft): draft is Partial<SectionDraft> & { section_id: string } => isMap(draft) && typeof draft.section_id === 'string',
  );

  const rows = required.map((section): SectionRow => {
    const title = typeof section.title === 'string' && section.title.trim() ? section.title.trim() : section.id;
    const wordLimit = positive(section.word_limit);
    const charLimit = positive(section.char_limit);
    // A draft written for a question the requirements replaced is stale, not this section's draft.
    const draft = missingIds.has(section.id) || staleIds.has(section.id) ? undefined : drafts.find((d) => d.section_id === section.id);
    if (!draft) {
      return {
        id: section.id, title, drafted: false, words: 0, chars: 0, wordLimit, charLimit, over: false, banned: [],
        placeholders: 0, flaggedClaims: [], claimsKey: null, claimsChecked: false, ready: false,
      };
    }
    const text = typeof draft.current_draft === 'string' ? draft.current_draft : '';
    const words = typeof draft.word_count === 'number' ? draft.word_count : countWords(text);
    const chars = typeof draft.char_count === 'number' ? draft.char_count : countChars(text);
    const over = draft.over_limit === true || (wordLimit !== null && words > wordLimit) || (charLimit !== null && chars > charLimit);
    const banned = texts(draft.banned_phrase_hits);
    const placeholders = (text.match(NEEDS_INPUT) ?? []).length;
    const flaggedClaims = list(draft.claims)
      .filter((claim) => isMap(claim) && claim.flagged === true)
      .map((claim) => (typeof claim.claim === 'string' ? claim.claim : ''));
    const claimsKey = flaggedClaims.length ? `claims:${section.id.slice(0, 60)}:${shortHash(flaggedClaims.join('\n'))}` : null;
    const claimsChecked = claimsKey !== null && isDone(claimsKey);
    return {
      id: section.id, title, drafted: true, words, chars, wordLimit, charLimit, over, banned, placeholders, flaggedClaims, claimsKey,
      claimsChecked,
      ready: !over && banned.length === 0 && placeholders === 0 && (flaggedClaims.length === 0 || claimsChecked),
    };
  });

  const stale = isMap(state.grant_spec)
    ? drafts
        .filter((d) => staleIds.has(d.section_id) || missingIds.has(d.section_id) || !requiredIds.has(d.section_id))
        .map((d) => (typeof d.title === 'string' && d.title.trim() ? d.title.trim() : d.section_id))
    : [];
  return { rows, stale };
}

type ChipTone = 'gray' | 'plain' | 'green' | 'amber' | 'yellow' | 'red';

/** "212 words of 250 max", "1,840/2,500 chars", "212 words". */
function countsText(row: SectionRow): string {
  const parts: string[] = [];
  if (row.wordLimit !== null) parts.push(`${num(row.words)} words of ${num(row.wordLimit)} max`);
  if (row.charLimit !== null) parts.push(`${num(row.chars)}/${num(row.charLimit)} chars`);
  return parts.length ? parts.join(', ') : plural(row.words, 'word');
}

/** "312 of 300 words" for the limit a section is over ('' when no limit is known). */
function overText(row: SectionRow): string {
  if (row.wordLimit !== null && row.words > row.wordLimit) return `${num(row.words)} of ${num(row.wordLimit)} words`;
  if (row.charLimit !== null && row.chars > row.charLimit) return `${num(row.chars)} of ${num(row.charLimit)} characters`;
  return '';
}

export function sectionChips(row: SectionRow): Array<{ text: string; tone: ChipTone; title?: string }> {
  if (!row.drafted) return [{ text: 'Not drafted', tone: 'gray' }];
  const chips: Array<{ text: string; tone: ChipTone; title?: string }> = [
    { text: `Drafted (${countsText(row)})`, tone: row.over ? 'red' : 'plain' },
  ];
  if (row.over) chips.push({ text: 'Over limit', tone: 'red', title: overText(row) || undefined });
  if (row.placeholders) chips.push({ text: `${num(row.placeholders)} to fill in`, tone: 'amber', title: '[NEEDS INPUT] placeholders to replace' });
  if (row.banned.length) chips.push({ text: 'Banned phrases', tone: 'red', title: row.banned.join(', ') });
  if (row.flaggedClaims.length) {
    chips.push(
      row.claimsChecked
        ? { text: `${plural(row.flaggedClaims.length, 'claim')} checked`, tone: 'gray' }
        : { text: plural(row.flaggedClaims.length, 'unsupported claim'), tone: 'yellow', title: row.flaggedClaims.join('; ') },
    );
  }
  if (row.ready) chips.push({ text: 'Ready', tone: 'green' });
  return chips;
}

export interface GapSummary {
  open: number;
  bySeverity: Array<{ severity: string; count: number }>;
  owners: Array<{ owner: string; open: number; high: number }>;
  /** High-severity gaps still open or asked: they block drafting. */
  blocking: Array<{ description: string; owner: string }>;
}

const SEVERITY_ORDER = ['high', 'medium', 'low'];

export function gapSummary(state: ChecklistAppState): GapSummary {
  const severityOf = (gap: Partial<Gap>) => (typeof gap.severity === 'string' ? gap.severity.trim().toLowerCase() : '') || 'unrated';
  const ownerOf = (gap: Partial<Gap>) =>
    typeof gap.suggested_owner_role === 'string' && gap.suggested_owner_role.trim() ? gap.suggested_owner_role.trim() : 'Unassigned';
  const describe = (gap: Partial<Gap>) => ({
    description: typeof gap.description === 'string' && gap.description.trim() ? gap.description.trim() : 'A missing piece of information',
    owner: ownerOf(gap),
  });
  // "Asked" (routed) gaps still wait for an answer, so they count as open.
  const open = list(state.gaps).filter((gap) => isMap(gap) && (gap.status === 'open' || gap.status === 'routed'));

  const severities = new Map<string, number>();
  const owners = new Map<string, { owner: string; open: number; high: number }>();
  for (const gap of open) {
    const severity = severityOf(gap);
    severities.set(severity, (severities.get(severity) ?? 0) + 1);
    const owner = owners.get(ownerOf(gap)) ?? { owner: ownerOf(gap), open: 0, high: 0 };
    owner.open += 1;
    if (severity === 'high') owner.high += 1;
    owners.set(owner.owner, owner);
  }
  const rank = (severity: string) => (SEVERITY_ORDER.includes(severity) ? SEVERITY_ORDER.indexOf(severity) : SEVERITY_ORDER.length);
  const blockingGaps = Array.isArray(state.open_blocking_gaps)
    ? state.open_blocking_gaps.filter((gap) => isMap(gap))
    : open.filter((gap) => severityOf(gap) === 'high');
  return {
    open: open.length,
    bySeverity: Array.from(severities, ([severity, count]) => ({ severity, count })).sort(
      (a, b) => rank(a.severity) - rank(b.severity) || a.severity.localeCompare(b.severity),
    ),
    owners: Array.from(owners.values()).sort((a, b) => b.high - a.high || b.open - a.open || a.owner.localeCompare(b.owner)),
    blocking: blockingGaps.map(describe),
  };
}

export interface NextStep {
  text: string;
  action: { id: ChecklistAction; label: string } | null;
}

/** "A, B and 2 more" style list of at most `max` names. */
function someOf(names: string[], max = 3, separator = ', '): string {
  const shown = names.slice(0, max).join(separator);
  return names.length > max ? `${shown}${separator}and ${num(names.length - max)} more` : shown;
}

/**
 * The single most important next action, in the order an application has to go.
 * From the claims check on, the answer depends on what was ticked off, so
 * until that record has loaded (`ticks`) the step says so instead of guessing.
 */
export function nextStep(
  state: ChecklistAppState,
  rows: SectionRow[],
  items: ChecklistItem[],
  gaps: GapSummary,
  isDone: (key: string) => boolean,
  ticks: 'loading' | 'loaded' | 'failed' = 'loaded',
): NextStep {
  if (!isMap(state.grant_spec)) {
    return {
      text: "Analyze the funder's requirements (step 1). Paste the guidelines if you have them: the sections and attachments to prepare come from there.",
      action: { id: 'analyze-requirements', label: 'Open step 1' },
    };
  }
  if (rows.length === 0) {
    return {
      text: "The requirements list no sections to write. Paste the funder's full guidelines in step 1 and analyze them again.",
      action: { id: 'analyze-requirements', label: 'Open step 1 to update them' },
    };
  }
  if (!state.fit_analysis) {
    return {
      text: 'Run the fit analysis (step 2) to see how your profile matches what the funder scores and what information is missing.',
      action: { id: 'run-fit', label: 'Start the fit check' },
    };
  }
  if (state.application?.strategy_confirmed !== true) {
    return {
      text: 'Review the narrative strategy in step 2 and confirm it. Drafting waits for your approval.',
      action: { id: 'confirm-strategy', label: 'Go to the strategy' },
    };
  }
  if (gaps.blocking.length) {
    const count = gaps.blocking.length;
    const them = count === 1 ? 'it' : 'them';
    const named = someOf(gaps.blocking.map((gap) => `${clip(gap.description)} (${gap.owner})`), 3, '; ');
    const waits = rows.some((row) => !row.drafted) ? ` Drafting waits for ${them}.` : '';
    return {
      text: `Resolve ${plural(count, 'high-severity gap')}: ${named}. Record the answer, mark "don't have it", or waive ${them} in Missing Info.${waits}`,
      action: { id: 'scroll:missing-info', label: 'Go to Missing Info' },
    };
  }
  const notDrafted = rows.filter((row) => !row.drafted);
  if (notDrafted.length) {
    const all = notDrafted.length === rows.length;
    return {
      text: all
        ? `Draft the application: ${rows.length === 1 ? 'its one section is' : `all ${num(rows.length)} sections are`} still to write.`
        : `Draft the ${plural(notDrafted.length, 'section')} not written yet: ${someOf(notDrafted.map((row) => row.title), 4)}.`,
      action: { id: 'draft-missing', label: all ? 'Start drafting' : 'Draft the rest' },
    };
  }
  const blocked = rows.filter((row) => row.over || row.banned.length);
  if (blocked.length) {
    const problems = blocked.map((row) => {
      const over = overText(row);
      const issues = [
        row.over ? `is over its limit${over ? ` (${over})` : ''}` : '',
        row.banned.length ? `has banned phrases (${row.banned.map((phrase) => `"${phrase}"`).join(', ')})` : '',
      ].filter(Boolean);
      return `${row.title} ${issues.join(' and ')}`;
    });
    return {
      text: `Fix before you export (export is blocked until then): ${someOf(problems, 3, '; ')}. Refine the section or edit it by hand.`,
      action: { id: `scroll:section-${blocked[0].id}`, label: 'Go to section' },
    };
  }
  const toFill = rows.filter((row) => row.placeholders > 0);
  if (toFill.length) {
    const total = toFill.reduce((sum, row) => sum + row.placeholders, 0);
    return {
      text: `Fill in ${plural(total, '[NEEDS INPUT] placeholder')}: ${someOf(toFill.map((row) => `${row.title} (${num(row.placeholders)})`), 4)}. Each one stays in the exported file until you replace it.`,
      action: { id: `scroll:section-${toFill[0].id}`, label: 'Go to section' },
    };
  }
  if (ticks === 'loading') return { text: 'Checking what you have already ticked off...', action: null };
  if (ticks === 'failed') {
    return {
      text: "Couldn't load what you have ticked off, so the rest of this list is unknown. Click Try again under Attachments and requirements.",
      action: null,
    };
  }
  const toCheck = rows.filter((row) => row.flaggedClaims.length > 0 && !row.claimsChecked);
  if (toCheck.length) {
    const total = toCheck.reduce((sum, row) => sum + row.flaggedClaims.length, 0);
    return {
      text: `Check ${plural(total, 'unsupported claim')}: ${someOf(toCheck.map((row) => `${row.title} (${num(row.flaggedClaims.length)})`), 4)}. Add the evidence or take the claim out, then tick "I checked these claims" under Sections.`,
      action: { id: `scroll:section-${toCheck[0].id}`, label: 'Go to section' },
    };
  }
  const left = items.filter((item) => !isDone(item.key));
  if (left.length) {
    return {
      text: `Gather and tick off the attachments and requirements still open (${num(left.length)} of ${num(items.length)}): ${someOf(left.map((item) => clip(item.label, 60)), 3, '; ')}.`,
      action: { id: 'scroll:checklist-attachments', label: 'Go to attachments' },
    };
  }
  if (!isMap(state.scorecard)) {
    return {
      text: "Score the draft against the funder's rubric (step 5). The biggest fix it finds is worth making before you submit.",
      action: { id: 'score', label: 'Get a reviewer score' },
    };
  }
  if (state.application?.status === 'export') {
    return {
      text: "Exported. Read the file through once, then submit it through the funder's own process: nothing is sent automatically.",
      action: { id: 'export', label: 'Go to export' },
    };
  }
  return {
    text: 'Everything on this checklist is ready. Export the application (step 6), read it through once, and submit it yourself: nothing is sent to the funder automatically.',
    action: { id: 'export', label: 'Go to export' },
  };
}

type Tone = 'red' | 'amber' | 'gray';

/** "Due October 30, 2026 · 15 days left" (red within 3 days, amber within 14), "Due today", "Deadline passed". */
export function deadlineLine(data: ChecklistData | null, rawDeadline: string): { text: string; tone: Tone } | null {
  if (data?.next_deadline) {
    const date = formatDate(data.next_deadline);
    const days = data.days_left;
    if (data.deadline_passed || (days !== null && days < 0)) {
      return { text: `Deadline passed: ${date}${days !== null && days < 0 ? ` (${plural(-days, 'day')} ago)` : ''}`, tone: 'red' };
    }
    if (days === null) return { text: `Due ${date}`, tone: 'gray' };
    if (days === 0) return { text: `Due today, ${date}`, tone: 'red' };
    return { text: `Due ${date} · ${plural(days, 'day')} left`, tone: days <= 3 ? 'red' : days <= 14 ? 'amber' : 'gray' };
  }
  const raw = rawDeadline.trim();
  if (raw) return { text: `Deadline: ${formatDate(raw)}`, tone: 'gray' };
  return data ? { text: "No deadline on file: check the funder's guidelines.", tone: 'gray' } : null;
}

// =============================================================================
// Pieces
// =============================================================================

const TONE_TEXT: Record<Tone, string> = { red: 'text-red-400', amber: 'text-amber-400', gray: 'text-gray-400' };

const CHIP_TONES: Record<ChipTone, string> = {
  gray: 'border-gray-700 text-gray-400',
  plain: 'border-gray-700 text-gray-300',
  green: 'border-green-800 text-green-300',
  amber: 'border-amber-800 text-amber-300',
  yellow: 'border-yellow-800 text-yellow-300',
  red: 'border-red-800 text-red-300',
};

const ACTION_BUTTON =
  'inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white ' +
  'enabled:hover:bg-[var(--primary-hover)] disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary)]';

const LINK_BUTTON = 'text-xs text-[var(--primary)] hover:underline disabled:opacity-50 disabled:cursor-not-allowed';

const CHECKBOX = 'mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)] disabled:cursor-not-allowed';

function Chip({ tone, title, children }: { tone: ChipTone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs ${CHIP_TONES[tone]}`}>
      {children}
    </span>
  );
}

function GateLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={`flex items-start gap-2 ${ok ? 'text-gray-200' : 'text-gray-400'}`}>
      {ok
        ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-green-400" aria-hidden="true" />
        : <Circle className="w-4 h-4 mt-0.5 shrink-0 text-gray-600" aria-hidden="true" />}
      <span>{children}</span>
    </li>
  );
}

// =============================================================================
// The card
// =============================================================================

export default function ApplicationChecklist({ appId, state, busy, onAction }: ApplicationChecklistProps) {
  const [loaded, setLoaded] = useState<{ appId: string; data: ChecklistData } | null>(null);
  const [loadFailure, setLoadFailure] = useState<{ appId: string; message: string } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  /** key -> the value being saved: shown at once, rolled back if saving fails. */
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saveError, setSaveError] = useState<{ key: string; message: string } | null>(null);

  const rawDeadline = typeof state.application?.deadline === 'string' ? state.application.deadline : '';

  // The ticked items and the deadline in days; again when the deadline changes or "Try again" is clicked.
  useEffect(() => {
    let cancelled = false;
    api.getChecklist(appId).then(
      (result) => {
        if (cancelled) return;
        setLoaded({ appId, data: cleanChecklist(result) });
        setLoadFailure(null);
      },
      (error: unknown) => {
        if (cancelled) return;
        console.warn('[GrantFinder] Could not load the application checklist:', error);
        setLoadFailure({ appId, message: errorDetail(error, 'Could not load the checklist.') });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId, rawDeadline, loadAttempt]);

  const data = loaded && loaded.appId === appId ? loaded.data : null;
  const loadMessage = !data && loadFailure && loadFailure.appId === appId ? loadFailure.message : null;
  const isDone = (key: string): boolean => own(saving, key) ?? (data ? own(data.done, key) === true : false);

  const toggle = async (key: string, label: string, next: boolean) => {
    if (busy || !data || own(saving, key) !== undefined) return;
    setSaving((current) => ({ ...current, [key]: next }));
    setSaveError(null);
    try {
      const saved = cleanChecklist(await api.setChecklistItem(appId, key, next));
      setLoaded((current) => (current && current.appId === appId ? { appId, data: withSavedItem(current.data, saved, key) } : current));
    } catch (error) {
      console.warn('[GrantFinder] Could not save a checklist item:', error);
      setSaveError({ key, message: `Couldn't save "${clip(label, 80)}", so it is back as it was: ${errorDetail(error, 'Saving failed.')}` });
    } finally {
      setSaving((current) => without(current, key));
    }
  };

  const act = (action: ChecklistAction) => onAction?.(action);
  const spec = isMap(state.grant_spec) ? state.grant_spec : null;
  const { rows, stale } = sectionRows(state, isDone);
  const items = checklistItems(spec, state.funder_profile);
  const gaps = gapSummary(state);
  const step = nextStep(state, rows, items, gaps, isDone, data ? 'loaded' : loadMessage ? 'failed' : 'loading');
  const stepAction = onAction ? step.action : null;
  const deadline = deadlineLine(data, rawDeadline);
  const total = rows.length + items.length;
  const readyCount = rows.filter((row) => row.ready).length + items.filter((item) => isDone(item.key)).length;
  // The count needs the ticked-off record: none while it loads, and none (the error says why) if it could not load.
  const readiness =
    total === 0 ? 'Nothing to check off yet' : data ? `${num(readyCount)} of ${num(total)} ready` : loadMessage ? null : 'Counting what is ready...';
  const exclusions = funderLists(state.funder_profile).exclusions;
  const scorecard = isMap(state.scorecard) ? state.scorecard : null;
  const score = scorecard && typeof scorecard.overall_score === 'number' ? Math.round(scorecard.overall_score) : null;
  const exported = state.application?.status === 'export';

  /** The checkbox for one ticked-off item, with its inline save error. */
  const checkbox = (key: string, label: string, text: ReactNode, className: string) => {
    const checked = isDone(key);
    const pending = own(saving, key) !== undefined;
    return (
      <>
        <label className={`flex items-start gap-2 ${className}`}>
          <input
            type="checkbox"
            className={CHECKBOX}
            checked={checked}
            disabled={busy || !data || pending}
            onChange={(event) => void toggle(key, label, event.target.checked)}
          />
          <span className={`min-w-0 break-words ${checked ? 'text-gray-500' : ''}`}>{text}</span>
          {pending && <Loader2 className="w-3 h-3 mt-1 shrink-0 animate-spin text-gray-500" aria-hidden="true" />}
        </label>
        {saveError?.key === key && (
          <p role="alert" className="ml-6 mt-1 text-xs text-red-300 break-words">{saveError.message}</p>
        )}
      </>
    );
  };

  return (
    <section id="application-checklist" aria-labelledby="application-checklist-title" className="card space-y-4">
      <div className="space-y-2">
        <h2 id="application-checklist-title" className="text-xl font-bold flex items-center gap-2">
          <ListChecks className="w-5 h-5" aria-hidden="true" /> Application Checklist
        </h2>
        <p className="text-sm flex flex-wrap gap-x-2 gap-y-1">
          {deadline && <span className={`font-semibold ${TONE_TEXT[deadline.tone]}`}>{deadline.text}</span>}
          {deadline && readiness && <span className="text-gray-600" aria-hidden="true">·</span>}
          {readiness && <span className="text-gray-300">{readiness}</span>}
        </p>
        {total > 0 && data && (
          <div className="h-1.5 rounded bg-gray-800" aria-hidden="true">
            <div className="h-1.5 rounded bg-green-600" style={{ width: `${Math.round((readyCount / total) * 100)}%` }} />
          </div>
        )}
      </div>

      <div className="rounded border border-blue-900 bg-blue-950/30 p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-blue-300">Next step</h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 basis-64 text-sm text-gray-100 break-words">{step.text}</p>
          {stepAction && (
            <button type="button" className={ACTION_BUTTON} disabled={busy} onClick={() => act(stepAction.id)}>
              {stepAction.label} <ArrowRight className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-x-6 gap-y-5 md:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold mb-2">Sections</h3>
          {rows.length === 0 ? (
            <p className="text-xs text-gray-500">
              {spec ? 'The requirements list no sections to write.' : 'The sections to write appear once the requirements are analyzed.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => (
                <li key={row.id} className="text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 break-words text-gray-200">{row.title}</span>
                    {sectionChips(row).map((chip) => (
                      <Chip key={chip.text} tone={chip.tone} title={chip.title}>{chip.text}</Chip>
                    ))}
                  </div>
                  {row.claimsKey && checkbox(
                    row.claimsKey,
                    `I checked these claims (${row.title})`,
                    <>I checked these claims<span className="sr-only"> in {row.title}</span></>,
                    'mt-1 text-xs text-gray-400',
                  )}
                </li>
              ))}
            </ul>
          )}
          {stale.length > 0 && (
            <p className="mt-2 text-xs text-gray-500 break-words">No longer required, so left out of the export: {stale.join(', ')}</p>
          )}
        </div>

        <div id="checklist-attachments">
          <h3 className="text-sm font-semibold mb-2">Attachments and requirements</h3>
          {!spec ? (
            <p className="text-xs text-gray-500">The attachments and format rules appear once the requirements are analyzed.</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-gray-500">
              The requirements list no attachments or format rules. Check the funder&apos;s guidelines for anything else to send.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {items.map((item) => {
                const note = data ? own(data.notes, item.key) : undefined;
                return (
                  <li key={item.key} className="text-sm">
                    {checkbox(item.key, item.label, item.label, 'text-gray-200')}
                    {note && <p className="ml-6 text-xs text-gray-500 break-words">Note: {note}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {(spec || rows.length > 0) && !data && !loadMessage && (
            <p className="mt-2 text-xs text-gray-500 flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> Loading what you have ticked off...
            </p>
          )}
          {loadMessage && (
            <p role="alert" className="mt-2 text-xs text-red-300 break-words">
              Couldn&apos;t load what you have ticked off: {loadMessage}{' '}
              <button
                type="button"
                className={LINK_BUTTON}
                onClick={() => {
                  setLoadFailure(null);
                  setLoadAttempt((n) => n + 1);
                }}
              >
                Try again
              </button>
            </p>
          )}
        </div>

        <div id="checklist-gaps">
          <h3 className="text-sm font-semibold mb-2">Open gaps</h3>
          {!state.fit_analysis ? (
            <p className="text-xs text-gray-500">Gaps appear after the fit analysis.</p>
          ) : gaps.open === 0 ? (
            <p className="text-sm text-green-400">No open gaps.</p>
          ) : (
            <>
              <p className="text-sm text-gray-200">
                {plural(gaps.open, 'open gap')}: {gaps.bySeverity.map((item) => `${num(item.count)} ${item.severity}`).join(', ')}
              </p>
              <ul className="mt-1 space-y-0.5 text-sm text-gray-300">
                {gaps.owners.map((owner) => (
                  <li key={owner.owner}>
                    {owner.owner}: {num(owner.open)} open
                    {owner.high > 0 && <span className="text-red-400"> ({num(owner.high)} high)</span>}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-gray-500">
                Answer, mark &quot;don&apos;t have it&quot;, or waive them in Missing Info &amp; Stakeholders (step 3).{' '}
                {onAction && (
                  <button type="button" className={LINK_BUTTON} disabled={busy} onClick={() => act('scroll:missing-info')}>
                    Go to Missing Info
                  </button>
                )}
              </p>
            </>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Steps and approvals</h3>
          <ul className="space-y-1 text-sm">
            <GateLine ok={state.application?.strategy_confirmed === true}>
              {state.application?.strategy_confirmed === true ? 'Strategy: confirmed' : 'Strategy: not confirmed yet (drafting waits for it)'}
            </GateLine>
            <GateLine ok={state.has_voice_profile === true}>
              {state.has_voice_profile === true
                ? 'Voice captured'
                : 'Voice not captured (optional: drafts sound more like you with it)'}
            </GateLine>
            <GateLine ok={scorecard !== null}>
              {scorecard ? (score !== null ? `Scored ${num(score)}/100` : 'Scored') : 'Not scored yet'}
            </GateLine>
            <GateLine ok={exported}>
              {exported ? 'Exported' : 'Not exported yet (you export and submit it yourself)'}
            </GateLine>
          </ul>
          {exclusions.length > 0 && (
            <div role="note" className="mt-3 rounded border border-amber-800 bg-amber-950/40 p-2 text-xs text-amber-200">
              <p className="flex items-center gap-1 font-semibold">
                <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" /> This funder says it does not fund:
              </p>
              <ul className="ml-5 mt-1 list-disc space-y-0.5">
                {exclusions.map((exclusion) => <li key={exclusion} className="break-words">{exclusion}</li>)}
              </ul>
              <p className="mt-1">Make sure this request is not one of them.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
