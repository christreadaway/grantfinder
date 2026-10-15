/**
 * /api/export: download match results as CSV or Markdown ("pdf" gets the
 * Markdown report, as in the Python), or the upcoming deadlines as a calendar
 * file (ics). Port of backend/routers/export.py.
 *
 *   POST /api/export          {session_id, format, include_profile?, include_all_matches?} -> file
 *   GET  /api/export/formats  the formats on offer (no sign-in needed, as before)
 */
import { HttpError } from '../errors';
import { fileResponse, requireString } from '../http';
import { logger } from '../log';
import { getGrants, getMatchResults } from '../repo';
import type { Router } from '../router';
import { buildExport, EXPORT_FORMATS, PDF_NOTICE, type ExportFile, type ExportFormat } from '../services/exportResults';
import { withGrantDetails } from './processing';

function exportFormat(value: unknown): ExportFormat {
  if (value === undefined || value === null || value === '') {
    throw new HttpError(422, 'Field "format" is required: use csv, md, pdf or ics.');
  }
  const text = String(value).trim().toLowerCase();
  const format = text === 'markdown' ? 'md' : text;
  if (!(EXPORT_FORMATS as string[]).includes(format)) {
    throw new HttpError(422, `Unsupported export format "${String(value)}". Use csv, md, pdf or ics.`);
  }
  return format as ExportFormat;
}

/** Booleans the way pydantic accepted them (true/false, "true"/"false", 1/0). */
function flag(body: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = body[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(text)) return true;
    if (['false', '0', 'no', 'off'].includes(text)) return false;
  }
  throw new HttpError(422, `Field "${name}" must be true or false.`);
}

export function registerExportRoutes(router: Router): void {
  /** Export match results. Only shortlisted matches unless include_all_matches is true. */
  router.post('/api/export', async (ctx) => {
    const user = await ctx.user();
    const body = await ctx.json();
    const sessionId = requireString(body, 'session_id').trim();
    const format = exportFormat(body.format);
    flag(body, 'include_profile', true); // accepted for compatibility; the Python never used it
    const includeAll = flag(body, 'include_all_matches', false);

    const saved = await getMatchResults(user.id, sessionId);
    if (!saved) throw new HttpError(404, 'Match results not found');
    if (saved.user_id !== user.id) throw new HttpError(403, 'Not authorized');
    // The grants' current details (a refreshed starter database), as the results page shows them.
    const results = withGrantDetails(saved, await getGrants(user.id));

    const matches = includeAll ? results.matches : results.matches.filter((match) => match.is_shortlisted);
    let file: ExportFile;
    try {
      file = buildExport(format, matches, results);
    } catch (error) {
      if (error instanceof HttpError) throw error; // e.g. a calendar with no upcoming due dates
      logger.error('export_failed', { user_id: user.id, session_id: sessionId, format, error });
      throw new HttpError(500, `Export failed: ${(error as Error).message || String(error)}`);
    }

    logger.info('export_created', { user_id: user.id, session_id: sessionId, format, matches: matches.length, bytes: file.body.length });
    const response = fileResponse(file.body, file.filename, file.contentType);
    if (format === 'pdf') response.headers.set('x-grantfinder-notice', PDF_NOTICE);
    return response;
  });

  /** Available export formats. */
  router.get('/api/export/formats', () => ({
    formats: [
      { id: 'csv', name: 'CSV', description: 'Spreadsheet format' },
      { id: 'md', name: 'Markdown', description: 'Formatted text' },
      { id: 'pdf', name: 'PDF', description: 'Print-ready report (delivered as Markdown for now; print it to PDF)' },
      { id: 'ics', name: 'Calendar', description: 'Upcoming deadlines with reminders 2 weeks and 3 days before (Google, Outlook, Apple Calendar)' },
    ],
  }));
}
