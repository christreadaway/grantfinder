/**
 * Match-results export: CSV and Markdown. "PDF" answers with the Markdown
 * report and says so, as the Python stub did.
 * Port of the export helpers in backend/routers/export.py.
 *
 * Times (file name, "Generated") use GRANTFINDER_TIMEZONE (default Central),
 * the same zone the deadline checks use, instead of the server's UTC clock.
 */
import { deadlineTimeZone } from '../deadlines';
import type { GrantMatch, MatchResults } from '../types';

export type ExportFormat = 'pdf' | 'csv' | 'md';
export const EXPORT_FORMATS: ExportFormat[] = ['pdf', 'csv', 'md'];

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

const CSV_HEADER = ['Rank', 'Grant Name', 'Funder', 'Amount', 'Deadline', 'Score (%)', 'Tier', 'Category', 'Geo Qualified', 'Contact', 'URL', 'Explanation'];

/**
 * Python csv QUOTE_MINIMAL quoting. Text a spreadsheet would run as a formula
 * (=, +, @ at the start; grant text can come from web pages) gets a leading
 * apostrophe so Excel shows it as text.
 */
function csvField(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+@\t\r]/.test(text)) text = `'${text}`;
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
      match.category,
      match.geo_qualified,
      match.contact,
      match.url,
      match.explanation,
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
      `| Category | ${cell(titleCase(match.category))} |`,
      `| Geographic | ${cell(match.geo_qualified)} |`,
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
// Files
// =============================================================================

export function buildExport(format: ExportFormat, matches: GrantMatch[], results: MatchResults, now = new Date()): ExportFile {
  const stamp = fileStamp(now);
  if (format === 'csv') {
    return { body: matchesCsv(matches), filename: `grantfinder_matches_${stamp}.csv`, contentType: 'text/csv; charset=utf-8' };
  }
  // The Python answered "pdf" with the Markdown report (PDF generation was never built).
  return {
    body: matchesMarkdown(matches, results, now, format === 'pdf' ? PDF_NOTICE : undefined),
    filename: `grantfinder_matches_${stamp}.md`,
    contentType: 'text/markdown; charset=utf-8',
  };
}
