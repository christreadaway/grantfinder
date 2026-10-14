/**
 * /api/grants: the user's grant database (5 categories + foundations).
 * Port of backend/routers/grants.py.
 *
 *   POST   /api/grants/upload       Excel workbook (.xlsx) -> merged into the database
 *   GET    /api/grants              all grants, ?category= filters
 *   GET    /api/grants/foundations  Category 5 foundations
 *   GET    /api/grants/stats        counts by category, status, geography
 *   GET    /api/grants/:grantId     one grant
 *   DELETE /api/grants              clear grants and foundations
 */
import { maxUploadBytes } from '../config';
import { HttpError } from '../errors';
import { logger } from '../log';
import { deleteFoundations, deleteGrants, getFoundations, getGrant, getGrants, updateFoundations, updateGrants } from '../repo';
import type { Router } from '../router';
import { parseGrantWorkbook, upsertFoundations, upsertGrants, XLS_MESSAGE } from '../services/excel';
import {
  GEO_QUALIFIED_VALUES,
  GRANT_CATEGORIES,
  GRANT_STATUSES,
  type Foundation,
  type Grant,
  type GrantCategory,
  type GrantDatabaseUpload,
} from '../types';

/**
 * The upload answer. The Python fields describe the database after the
 * upload (as they did when an upload replaced everything); the extra fields
 * describe the file itself.
 */
export interface GrantUploadResult extends GrantDatabaseUpload {
  uploaded_grants: number;
  uploaded_foundations: number;
  /** Grants that were new. */
  added: number;
  /** Saved grants (same name + funder) refreshed from the file. */
  updated: number;
  foundations_added: number;
  foundations_updated: number;
  /** Sheets whose names didn't match a category. */
  skipped_sheets: string[];
}

const megabytes = (bytes: number, digits = 1): string => (bytes / (1024 * 1024)).toFixed(digits).replace(/\.0+$/, '');

function tooLarge(size: number, limit: number): HttpError {
  return new HttpError(
    413,
    `The file is too large (${megabytes(size)} MB). The limit is ${megabytes(limit, 0)} MB: remove extra sheets, images or formatting and upload again.`,
  );
}

function countBy<T extends string>(values: readonly T[], grants: Grant[], pick: (grant: Grant) => string): Record<T, number> {
  const counts = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
  for (const grant of grants) {
    const key = pick(grant) as T;
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

/** ?category= must be one of the five values (FastAPI answered 422 otherwise). Empty means no filter. */
function categoryFilter(raw: string | null): GrantCategory | null {
  if (raw === null || raw.trim() === '') return null;
  const value = raw.trim();
  if (!(GRANT_CATEGORIES as string[]).includes(value)) {
    throw new HttpError(422, `Invalid category "${value}". Use one of: ${GRANT_CATEGORIES.join(', ')}.`);
  }
  return value as GrantCategory;
}

export function registerGrantRoutes(router: Router): void {
  /**
   * Upload the grant database workbook. Expected sheets: Church/Parish Grants,
   * Catholic School Grants, Mixed Church-School, Non-Catholic Qualifying,
   * Catholic Foundations. Rows merge into what discovery already found.
   */
  router.post('/api/grants/upload', async (ctx) => {
    const user = await ctx.user();
    const limit = maxUploadBytes();
    const declared = Number(ctx.req.headers.get('content-length') || 0);
    if (declared > limit + 64 * 1024) throw tooLarge(declared, limit);

    const form = await ctx.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      throw new HttpError(422, 'No file was uploaded. Choose your Excel file (.xlsx) and try again.');
    }
    const filename = (file.name || '').trim().toLowerCase();
    if (filename.endsWith('.xls')) throw new HttpError(400, XLS_MESSAGE);
    if (!filename.endsWith('.xlsx')) {
      throw new HttpError(400, 'Invalid file type. Please upload an Excel file (.xlsx)');
    }
    if (file.size > limit) throw tooLarge(file.size, limit);
    if (file.size === 0) throw new HttpError(400, 'The file is empty. Choose your Excel file (.xlsx) and upload again.');

    const content = new Uint8Array(await file.arrayBuffer());
    const parsed = await parseGrantWorkbook(content, user.id);

    let grantCounts = { added: 0, updated: 0 };
    let foundationCounts = { added: 0, updated: 0 };
    let grants: Grant[];
    let foundations: Foundation[];
    try {
      grants = parsed.grants.length
        ? await updateGrants(user.id, (current) => {
            const result = upsertGrants(current, parsed.grants);
            grantCounts = { added: result.added, updated: result.updated };
            return result.merged;
          })
        : await getGrants(user.id);
      foundations = parsed.foundations.length
        ? await updateFoundations(user.id, (current) => {
            const result = upsertFoundations(current, parsed.foundations);
            foundationCounts = { added: result.added, updated: result.updated };
            return result.merged;
          })
        : await getFoundations(user.id);
    } catch (error) {
      logger.error('grant_upload_save_failed', { user_id: user.id, request_id: ctx.requestId, error });
      throw new HttpError(500, `Failed to process grant database (reference ${ctx.requestId}). The details are in the logs.`);
    }

    logger.info('grant_database_uploaded', {
      user_id: user.id,
      bytes: content.byteLength,
      upload_id: parsed.uploadId,
      uploaded_grants: parsed.grants.length,
      uploaded_foundations: parsed.foundations.length,
      added: grantCounts.added,
      updated: grantCounts.updated,
      total_grants: grants.length,
      total_foundations: foundations.length,
      skipped_sheets: parsed.skippedSheets,
    });

    const result: GrantUploadResult = {
      total_grants: grants.length,
      categories: countBy(GRANT_CATEGORIES, grants, (grant) => grant.category),
      foundations_count: foundations.length,
      upload_id: parsed.uploadId,
      uploaded_grants: parsed.grants.length,
      uploaded_foundations: parsed.foundations.length,
      added: grantCounts.added,
      updated: grantCounts.updated,
      foundations_added: foundationCounts.added,
      foundations_updated: foundationCounts.updated,
      skipped_sheets: parsed.skippedSheets,
    };
    return result;
  });

  /** All grants, optionally filtered by category. */
  router.get('/api/grants', async (ctx) => {
    const user = await ctx.user();
    const category = categoryFilter(ctx.query.get('category'));
    const grants = await getGrants(user.id);
    return category ? grants.filter((grant) => grant.category === category) : grants;
  });

  /** Catholic foundations (Category 5). */
  router.get('/api/grants/foundations', async (ctx) => {
    const user = await ctx.user();
    return getFoundations(user.id);
  });

  /** Grant database statistics. */
  router.get('/api/grants/stats', async (ctx) => {
    const user = await ctx.user();
    const [grants, foundations] = await Promise.all([getGrants(user.id), getFoundations(user.id)]);
    return {
      total_grants: grants.length,
      total_foundations: foundations.length,
      by_category: countBy(GRANT_CATEGORIES, grants, (grant) => grant.category),
      by_status: countBy(GRANT_STATUSES, grants, (grant) => grant.status),
      by_geo_qualified: countBy(GEO_QUALIFIED_VALUES, grants, (grant) => grant.geo_qualified),
    };
  });

  /** One grant by id. */
  router.get('/api/grants/:grantId', async (ctx) => {
    const user = await ctx.user();
    const grant = await getGrant(user.id, ctx.params.grantId);
    if (!grant) throw new HttpError(404, 'Grant not found');
    return grant;
  });

  /** Clear all grants and foundations (for a fresh upload). */
  router.delete('/api/grants', async (ctx) => {
    const user = await ctx.user();
    await Promise.all([deleteGrants(user.id), deleteFoundations(user.id)]);
    logger.info('grant_database_cleared', { user_id: user.id });
    return { message: 'Grant database cleared' };
  });
}
