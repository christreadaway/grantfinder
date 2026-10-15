/**
 * Match-results export: CSV, Markdown, and a calendar (.ics) of upcoming
 * deadlines with reminders. "PDF" answers with the Markdown report and says
 * so, as the Python stub did.
 * Port of the export helpers in backend/routers/export.py.
 *
 * Times (file name, "Generated") use GRANTFINDER_TIMEZONE (default Central),
 * the same zone the deadline checks use, instead of the server's UTC clock.
 */
import { HttpError } from '../errors';
import { addDaysIso, deadlineTimeZone, parseDeadline, todayIso } from '../deadlines';
import type { GrantMatch, MatchResults } from '../types';

export type ExportFormat = 'pdf' | 'csv' | 'md' | 'ics';
export const EXPORT_FORMATS: ExportFormat[] = ['pdf', 'csv', 'md', 'ics'];

export const PDF_NOTICE =
  'PDF export is not available yet, so this report is in Markdown. To make a PDF, open this file in Word or Google Docs and choose Print > Save as PDF.';

export interface ExportFile {
  body: string;
  filename: string;
  contentType: string;
}

// =============================================================================
// Time
// =============================================================================

interface Clock {
  year: string;
  month: string;
  monthName: string;
  day: string;
  hour24: string;
  hour12: string;
  minute: string;
  second: string;
  dayPeriod: string;
  zone: string;
}

function clock(date: Date): Clock {
  const read = (timeZone: string): Clock => {
    const parts = (options: Intl.DateTimeFormatOptions) =>
      Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, ...options }).formatToParts(date).map((part) => [part.type, part.value]));
    const numeric = parts({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const named = parts({ month: 'long', hour: '2-digit', hour12: true, timeZoneName: 'short' });
    return {
      year: numeric.year,
      month: numeric.month,
      monthName: named.month,
      day: numeric.day,
      hour24: numeric.hour,
      hour12: named.hour.padStart(2, '0'),
      minute: numeric.minute,
      second: numeric.second,
      dayPeriod: (named.dayPeriod || '').toUpperCase(),
      zone: named.timeZoneName || timeZone,
    };
  };
  try {
    return read(deadlineTimeZone());
  } catch {
    return read('UTC'); // GRANTFINDER_TIMEZONE was not a real time zone
  }
}

/** 20261014_214500, like the Python's %Y%m%d_%H%M%S. */
export function fileStamp(date: Date): string {
  const c = clock(date);
  return `${c.year}${c.month}${c.day}_${c.hour24}${c.minute}${c.second}`;
}

/** "October 14, 2026 at 09:45 PM CDT", like the Python's '%B %d, %Y at %I:%M %p'. */
export function generatedLabel(date: Date): string {
  const c = clock(date);
  return `${c.monthName} ${c.day}, ${c.year} at ${c.hour12}:${c.minute} ${c.dayPeriod} ${c.zone}`.trim();
}

// =============================================================================
// CSV
// =============================================================================

const CSV_HEADER = [
  'Rank', 'Grant Name', 'Funder', 'Amount', 'Deadline', 'Score (%)', 'Tier', 'Status', 'Category', 'Geo Qualified', 'Contact', 'URL', 'Explanation',
  'Geography', 'Religious Eligibility', 'Deadline Notes', 'Typical Award', 'Funder Priorities', 'Eligibility Notes', 'Last Verified', 'Confidence',
  'Past Award Levels', 'Catholic School Track Record', 'Funder Outlook',
];

/** The Status of a grant that is no longer in the person's grant database (retired or deleted after matching). */
export const STATUS_REMOVED = 'Removed: no longer in your grant database';

/**
 * Where a match stands today, in words: removed from the grant database; ruled out since it was
 * matched ("CLOSED; not eligible now (was 88%)"); otherwise the grant's current status (OPEN,
 * Rolling, Check deadline, CLOSED), or nothing for results saved before status was carried.
 */
export function matchStatusLabel(match: GrantMatch): string {
  if (match.grant_removed) return STATUS_REMOVED;
  const status = match.status ?? '';
  if (typeof match.score_before === 'number') {
    const now = `not eligible now (was ${match.score_before}%)`;
    return status ? `${status}; ${now}` : `${now.charAt(0).toUpperCase()}${now.slice(1)}`;
  }
  return status;
}

/** "verified", "partial" or nothing: how much of the grant record was confirmed on the funder's site. */
function confidenceText(match: GrantMatch): string {
  return match.confidence === 'verified' || match.confidence === 'partial' ? match.confidence : '';
}

/** How the religious_eligibility values read to a person. */
export const RELIGIOUS_ELIGIBILITY_LABELS: Record<string, string> = {
  eligible: 'Religious organizations eligible',
  secular_purpose_only: 'Eligible for non-religious uses only',
  excluded: 'Does not fund religious organizations',
  unclear: 'Not stated: confirm with the funder',
};

/**
 * Python csv QUOTE_MINIMAL quoting. Text a spreadsheet would run as a formula
 * (=, +, @ at the start; grant text can come from web pages) gets a leading
 * apostrophe so Excel shows it as text.
 */
function csvField(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** UTF-8 with a byte-order mark so Excel shows accents and dashes correctly. */
export function matchesCsv(matches: GrantMatch[]): string {
  const rows: unknown[][] = [CSV_HEADER];
  matches.forEach((match, index) => {
    rows.push([
      index + 1,
      match.grant_name,
      match.funder,
      match.amount,
      match.deadline,
      match.score,
      match.score_tier,
      matchStatusLabel(match),
      match.category,
      match.geo_qualified,
      match.contact,
      match.url,
      match.explanation,
      match.geography ?? '',
      match.religious_eligibility ? RELIGIOUS_ELIGIBILITY_LABELS[match.religious_eligibility] ?? match.religious_eligibility : '',
      match.deadline_notes ?? '',
      match.typical_award ?? '',
      (match.focus_areas ?? []).join('; '),
      match.eligibility_notes ?? '',
      match.last_verified ?? '',
      confidenceText(match),
      match.funder_intel?.applicable ? match.funder_intel.award_levels ?? '' : '',
      match.funder_intel?.applicable ? match.funder_intel.catholic_school_track_record ?? '' : '',
      match.funder_intel?.applicable ? match.funder_intel.outlook ?? '' : '',
    ]);
  });
  return '﻿' + rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

// =============================================================================
// Markdown
// =============================================================================

const TIER_EMOJI: Record<string, string> = {
  excellent: '🟢',
  good: '🟡',
  possible: '🟠',
  weak: '🔴',
  not_eligible: '⚫',
};

/** Python's value.replace('_', ' ').title(): "not_eligible" -> "Not Eligible". */
function titleCase(value: string): string {
  return String(value ?? '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/(^|[^a-z])([a-z])/g, (_match, before: string, letter: string) => before + letter.toUpperCase());
}

/** A table cell: one line, with "|" escaped so it can't break the table. */
function cell(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\|/g, '\\|');
}

const pct = (value: unknown): string => `${typeof value === 'number' && Number.isFinite(value) ? value : 0}%`;

export function matchesMarkdown(matches: GrantMatch[], results: MatchResults, now: Date, notice?: string): string {
  const removed = Array.isArray(results.matches) ? results.matches.filter((match) => match.grant_removed).length : 0;
  const lines: string[] = ['# GrantFinder AI - Match Results', ''];
  if (notice) lines.push(`> ${notice}`, '');
  lines.push(
    `**Generated:** ${generatedLabel(now)}`,
    `**Total Grants Evaluated:** ${results.total_grants_evaluated}`,
    '',
    '## Summary',
    '',
    `- Excellent Matches (85-100%): ${results.excellent_matches}`,
    `- Good Matches (70-84%): ${results.good_matches}`,
    `- Possible Matches (50-69%): ${results.possible_matches}`,
    `- Weak Matches (25-49%): ${results.weak_matches}`,
    `- Not Eligible (0-24%): ${results.not_eligible}`,
    ...(removed ? [`- No longer in your grant database (not counted above): ${removed}`] : []),
    '',
    '---',
    '',
    '## Match Details',
    '',
  );

  if (!matches.length) {
    lines.push('_No matches to include. Shortlist grants first, or export with all matches included._', '');
  }

  matches.forEach((match, index) => {
    const breakdown = match.score_breakdown ?? ({} as Partial<GrantMatch['score_breakdown']>);
    lines.push(
      `### ${index + 1}. ${match.grant_name}`,
      '',
      `**Score:** ${TIER_EMOJI[match.score_tier] ?? '⚪'} ${match.score}% (${titleCase(match.score_tier)})`,
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| Funder | ${cell(match.funder)} |`,
      `| Amount | ${cell(match.amount)} |`,
      `| Deadline | ${cell(match.deadline)} |`,
      ...(matchStatusLabel(match) ? [`| Status | ${cell(matchStatusLabel(match))} |`] : []),
      `| Category | ${cell(titleCase(match.category))} |`,
      `| Geographic | ${cell(match.geo_qualified)} |`,
      ...(match.geography ? [`| Where applicants must be | ${cell(match.geography)} |`] : []),
      ...(match.religious_eligibility ? [`| Religious eligibility | ${cell(RELIGIOUS_ELIGIBILITY_LABELS[match.religious_eligibility] ?? match.religious_eligibility)} |`] : []),
      ...(match.deadline_notes ? [`| Deadline notes | ${cell(match.deadline_notes)} |`] : []),
      ...(match.typical_award ? [`| Typical award | ${cell(match.typical_award)} |`] : []),
      ...(match.focus_areas?.length ? [`| Funder priorities | ${cell(match.focus_areas.join('; '))} |`] : []),
      ...(match.eligibility_notes ? [`| Who can apply | ${cell(match.eligibility_notes)} |`] : []),
      ...(match.last_verified
        ? [`| Last verified | ${cell(match.last_verified)}${match.confidence === 'partial' ? ' (partly verified)' : ''} |`]
        : []),
      ...(match.funder_intel?.applicable && match.funder_intel.award_levels ? [`| Past award levels | ${cell(match.funder_intel.award_levels)} |`] : []),
      ...(match.funder_intel?.applicable && match.funder_intel.catholic_school_track_record
        ? [`| Catholic school track record | ${cell(match.funder_intel.catholic_school_track_record)} |`]
        : []),
      ...(match.funder_intel?.applicable && match.funder_intel.giving_trend ? [`| Giving trend | ${cell(match.funder_intel.giving_trend)} |`] : []),
      ...(match.funder_intel?.applicable && match.funder_intel.outlook ? [`| Funder outlook | ${cell(match.funder_intel.outlook)} |`] : []),
      `| Contact | ${cell(match.contact)} |`,
      `| URL | ${cell(match.url)} |`,
      '',
      '**Score Breakdown:**',
      `- Eligibility Fit (40%): ${pct(breakdown.eligibility_fit)}`,
      `- Need Alignment (30%): ${pct(breakdown.need_alignment)}`,
      `- Capacity Signals (15%): ${pct(breakdown.capacity_signals)}`,
      `- Timing (10%): ${pct(breakdown.timing)}`,
      `- Completeness (5%): ${pct(breakdown.completeness)}`,
      '',
      `**Why this match:** ${match.explanation}`,
      '',
    );
    const awards = match.funder_intel?.applicable ? match.funder_intel.past_awards ?? [] : [];
    if (awards.length) {
      lines.push('**Past awards (from the funder\'s filings and grant lists):**');
      for (const award of awards) lines.push(`- ${[award.year, award.amount, award.recipient, award.purpose].filter(Boolean).join(' | ')}`);
      lines.push('');
    }
    if (match.evidence?.length) {
      lines.push('**Evidence:**');
      for (const evidence of match.evidence) lines.push(`- ${evidence}`);
      lines.push('');
    }
    lines.push('---', '');
  });

  lines.push('', '---', '', '*Generated by GrantFinder AI v2.6*');
  return lines.join('\n');
}

// =============================================================================
// Calendar (.ics)
// =============================================================================

/** Tiers worth a calendar reminder (a shortlisted grant always is). */
const CALENDAR_TIERS = new Set(['excellent', 'good', 'possible']);

export const NO_CALENDAR_DEADLINES =
  "None of these grants has an upcoming due date that can go on a calendar (rolling and \"check the funder's site\" deadlines can't). Open each grant's site for its next date.";

/** RFC 5545 text: backslash, semicolon, comma and new lines escaped. */
function icsText(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line at 75 octets (UTF-8), never inside a character. */
function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const icsDate = (iso: string) => iso.replace(/-/g, '');
const icsStamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * The matches that go on the calendar: an upcoming due date, and a tier worth a reminder (or
 * shortlisted). Never a grant no longer in the grant database, nor one not eligible (including
 * one ruled out since it was matched), even when shortlisted.
 */
export function calendarMatches(matches: GrantMatch[], today = todayIso()): Array<{ match: GrantMatch; due: string }> {
  const events: Array<{ match: GrantMatch; due: string }> = [];
  for (const match of matches) {
    if (match.grant_removed || match.score_tier === 'not_eligible') continue;
    if (!match.is_shortlisted && !CALENDAR_TIERS.has(match.score_tier)) continue;
    const due = parseDeadline(match.deadline, today);
    if (due && due >= today) events.push({ match, due });
  }
  return events.sort((a, b) => a.due.localeCompare(b.due) || b.match.score - a.match.score);
}

/**
 * An all-day event on each grant's due date, with reminders two weeks and three days before.
 * Each event's UID is the grant id plus the date, so importing the file again updates the
 * same events instead of adding copies.
 */
export function matchesIcs(matches: GrantMatch[], now: Date, today = todayIso()): string {
  const events = calendarMatches(matches, today);
  if (!events.length) throw new HttpError(422, NO_CALENDAR_DEADLINES);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GrantFinder//Grant deadlines//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Grant deadlines (GrantFinder)',
  ];
  for (const { match, due } of events) {
    const details = [
      `Amount: ${match.amount || 'Varies'}${match.typical_award ? ` (typical: ${match.typical_award})` : ''}`,
      `Match: ${match.score}% (${titleCase(match.score_tier)})`,
      match.deadline_notes ? `Deadline notes: ${match.deadline_notes}` : '',
      match.focus_areas?.length ? `Funder priorities: ${match.focus_areas.join('; ')}` : '',
      match.funder_intel?.applicable && match.funder_intel.award_levels ? `Past award levels: ${match.funder_intel.award_levels}` : '',
      match.funder_intel?.applicable && match.funder_intel.outlook ? `Funder outlook: ${match.funder_intel.outlook}` : '',
      match.eligibility_notes ? `Who can apply: ${match.eligibility_notes}` : '',
      match.religious_eligibility ? `Religious eligibility: ${RELIGIOUS_ELIGIBILITY_LABELS[match.religious_eligibility] ?? match.religious_eligibility}` : '',
      'Check the date on the funder\'s site: deadlines change.',
      match.url || '',
    ].filter(Boolean);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsText(match.grant_id)}-${icsDate(due)}@grantfinder`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART;VALUE=DATE:${icsDate(due)}`,
      `DTEND;VALUE=DATE:${icsDate(addDaysIso(due, 1))}`,
      `SUMMARY:${icsText(`Grant due: ${match.grant_name} (${match.funder})`)}`,
      `DESCRIPTION:${icsText(details.join('\n'))}`,
      ...(match.url && /^https?:\/\//i.test(match.url) ? [`URL:${match.url.replace(/[\r\n]/g, '')}`] : []),
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-P14D',
      `DESCRIPTION:${icsText(`Grant due in 2 weeks: ${match.grant_name}`)}`,
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-P3D',
      `DESCRIPTION:${icsText(`Grant due in 3 days: ${match.grant_name}`)}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

// =============================================================================
// Files
// =============================================================================

export function buildExport(format: ExportFormat, matches: GrantMatch[], results: MatchResults, now = new Date()): ExportFile {
  const stamp = fileStamp(now);
  if (format === 'csv') {
    return { body: matchesCsv(matches), filename: `grantfinder_matches_${stamp}.csv`, contentType: 'text/csv; charset=utf-8' };
  }
  if (format === 'ics') {
    return { body: matchesIcs(matches, now), filename: `grantfinder_deadlines_${stamp}.ics`, contentType: 'text/calendar; charset=utf-8' };
  }
  // The Python answered "pdf" with the Markdown report (PDF generation was never built).
  return {
    body: matchesMarkdown(matches, results, now, format === 'pdf' ? PDF_NOTICE : undefined),
    filename: `grantfinder_matches_${stamp}.md`,
    contentType: 'text/markdown; charset=utf-8',
  };
}
