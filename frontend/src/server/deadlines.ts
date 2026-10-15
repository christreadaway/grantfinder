/**
 * Deadline parsing shared by matching (expired-grant filter) and the writer
 * (10-day urgency flag). Port of AIService._parse_deadline.
 *
 * Dates are ISO strings (YYYY-MM-DD), so comparisons are plain string compares.
 * "Today" is computed in GRANTFINDER_TIMEZONE (default America/Chicago), so a
 * deadline of October 15 stays open through the end of October 15 in Texas
 * instead of closing at 7 pm when the UTC date rolls over.
 *
 * A recurring deadline ("Annual: October 15") resolves to its next
 * occurrence on or after today, so a yearly funder is never filtered out as
 * expired and the writer's urgency flag fires every cycle.
 */

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

const ANNUAL_DEADLINE_RE = /^annual(?:ly)?\s*[:,-]?\s*([a-z]+)\.?\s+(\d{1,2})$/i;

export function deadlineTimeZone(): string {
  return (process.env.GRANTFINDER_TIMEZONE || '').trim() || 'America/Chicago';
}

/** Today's date (YYYY-MM-DD) in the configured time zone. */
export function todayIso(timeZone = deadlineTimeZone()): string {
  // Tests only (GRANTFINDER_TEST_MODE=1): pretend it is another day, so suites can prove they
  // don't depend on the calendar (a fixture deadline that has since passed, a yearly date).
  const forced = (process.env.GRANTFINDER_TODAY || '').trim();
  if (forced && process.env.GRANTFINDER_TEST_MODE === '1' && /^\d{4}-\d{2}-\d{2}$/.test(forced)) return forced;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from today until the date (negative when past). */
export function daysUntil(iso: string, today = todayIso()): number {
  const [y1, m1, d1] = today.split('-').map(Number);
  const [y2, m2, d2] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** YYYY-MM-DD for a real calendar date, else null (rejects Feb 30 etc.). */
function isoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function monthNumber(name: string): number | null {
  return MONTHS[name.toLowerCase().replace(/\.$/, '')] ?? null;
}

/**
 * Parse a deadline string into an ISO date if it looks like one.
 * Accepts 2026-10-15, 10/15/2026, 10/15/26, October 15, 2026, Oct 15, 2026,
 * and recurring "Annual: October 15". Anything else (Rolling, Check website) -> null.
 */
export function parseDeadline(deadline: string | null | undefined, today = todayIso()): string | null {
  if (!deadline) return null;
  const text = String(deadline).trim();
  if (!text) return null;

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));

  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (match) return isoDate(Number(match[3]), Number(match[1]), Number(match[2]));

  match = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(text);
  if (match) {
    // Python's %y: 00-68 -> 2000s, 69-99 -> 1900s
    const yy = Number(match[3]);
    return isoDate(yy <= 68 ? 2000 + yy : 1900 + yy, Number(match[1]), Number(match[2]));
  }

  match = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  if (match) {
    const month = monthNumber(match[1]);
    return month ? isoDate(Number(match[3]), month, Number(match[2])) : null;
  }

  match = ANNUAL_DEADLINE_RE.exec(text);
  if (match) {
    const month = monthNumber(match[1]);
    if (!month) return null;
    const year = Number(today.slice(0, 4));
    for (const candidateYear of [year, year + 1]) {
      const due = isoDate(candidateYear, month, Number(match[2]));
      if (due && due >= today) return due;
    }
  }
  return null;
}

/** True only when the deadline parses to a date before today. */
export function deadlinePassed(deadline: string | null | undefined, today = todayIso()): boolean {
  const due = parseDeadline(deadline, today);
  return due !== null && due < today;
}

/** Writer urgency (PRD 5.2): deadline within `windowDays` (default 10). */
export function isUrgent(deadline: string | null | undefined, windowDays = 10, today = todayIso()): boolean {
  const due = parseDeadline(deadline, today);
  return due !== null && due <= addDaysIso(today, windowDays);
}
