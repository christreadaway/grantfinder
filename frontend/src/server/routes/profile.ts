/**
 * /api/profile: read, edit, delete, and reset the organization profile.
 * Port of backend/routers/profile.py.
 *
 * Also exports the profile-body validation shared with
 * PUT /api/processing/profile: required fields as in the Python's pydantic
 * model, answered with a readable 422 instead of pydantic's error list.
 */
import { HttpError } from '../errors';
import { logger } from '../log';
import { deleteProfile, getProfile, updateProfile } from '../repo';
import type { Router } from '../router';
import { addUnique, minimalProfile } from '../services/ai';
import { normalizeProfile, type OrganizationProfile } from '../types';

const REQUIRED_TEXT = ['organization_name', 'organization_type', 'city', 'state'] as const;
const OPTIONAL_TEXT = [
  'id', 'diocese', 'zip_code', 'website_url', 'school_website_url', 'pastor_name', 'principal_name',
  'parish_size', 'annual_budget', 'free_form_notes', 'financial_capacity',
] as const;
const OPTIONAL_INT = ['staff_count', 'student_count'] as const;
const BOOLEANS = ['is_501c3', 'has_school', 'has_food_pantry', 'has_outreach_programs'] as const;
const TEXT_LISTS = ['facility_needs', 'program_needs', 'security_concerns', 'current_initiatives', 'previous_grants', 'sources'] as const;
const OBJECT_LISTS = [
  'questionnaire_answers', 'evidence', 'team_members', 'collaborations', 'validators', 'in_kind_resources', 'prior_grants_detail',
] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function wholeNumber(value: unknown): number | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\s*[-+]?\d+(\.0+)?\s*$/.test(value)) return Math.trunc(Number(value.trim()));
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 't'].includes(v)) return true;
    if (['false', 'no', 'n', '0', 'off', 'f'].includes(v)) return false;
  }
  return undefined;
}

/**
 * Validate a profile body. Returns only the fields the body contains (with
 * light coercion: numeric strings for counts, "yes"/"no" for flags, one item
 * per line when a list arrives as text). user_id and last_updated are always
 * set by the server; unknown fields are ignored, as pydantic did.
 */
export function parseProfileBody(body: Record<string, unknown>): Partial<OrganizationProfile> {
  const problems: string[] = [];
  const out: Record<string, unknown> = {};

  const missing = REQUIRED_TEXT.filter((field) => body[field] === undefined || body[field] === null);
  if (missing.length) problems.push(`missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  for (const field of REQUIRED_TEXT) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') out[field] = value.trim();
    else if (typeof value === 'number' && Number.isFinite(value)) out[field] = String(value);
    else problems.push(`${field} must be text`);
  }
  for (const field of OPTIONAL_TEXT) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null || typeof value === 'string') out[field] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[field] = String(value);
    else problems.push(`${field} must be text`);
  }
  for (const field of OPTIONAL_INT) {
    if (body[field] === undefined) continue;
    const value = wholeNumber(body[field]);
    if (value === undefined) problems.push(`${field} must be a whole number`);
    else out[field] = value;
  }
  for (const field of BOOLEANS) {
    if (body[field] === undefined) continue;
    const value = booleanValue(body[field]);
    if (value === undefined) problems.push(`${field} must be true or false`);
    else out[field] = value;
  }
  for (const field of TEXT_LISTS) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null) out[field] = [];
    else if (typeof value === 'string') out[field] = value.split('\n').map((line) => line.trim()).filter(Boolean);
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      out[field] = value.map((item) => String(item).trim()).filter(Boolean);
    } else problems.push(`${field} must be a list of text`);
  }
  for (const field of OBJECT_LISTS) {
    const value = body[field];
    if (value === undefined) continue;
    if (value === null) out[field] = [];
    else if (Array.isArray(value) && value.every(isObject)) out[field] = value;
    else problems.push(`${field} must be a list of objects`);
  }
  if (body.voice_profile !== undefined) {
    if (body.voice_profile === null || isObject(body.voice_profile)) out.voice_profile = body.voice_profile;
    else problems.push('voice_profile must be an object or null');
  }
  if (body.confidence_score !== undefined) {
    const value = typeof body.confidence_score === 'string' ? Number(body.confidence_score) : body.confidence_score;
    if (typeof value === 'number' && Number.isFinite(value)) out.confidence_score = value;
    else problems.push('confidence_score must be a number');
  }

  if (problems.length) throw new HttpError(422, `Profile not saved: ${problems.join('; ')}.`);
  return out as Partial<OrganizationProfile>;
}

/**
 * The saved profile after an edit. Fields the body left out keep their saved
 * values (the Python reset them to defaults, wiping evidence and voice
 * profiles whenever a screen sent only the basics).
 */
export function applyProfileUpdate(
  existing: OrganizationProfile | null,
  update: Partial<OrganizationProfile>,
  userId: string,
): OrganizationProfile {
  return normalizeProfile({ ...(existing ?? minimalProfile(userId)), ...update, user_id: userId });
}

export function registerProfileRoutes(router: Router): void {
  /** The profile, or an empty template (not saved) when there is none yet. */
  router.get('/api/profile', async (ctx) => {
    const user = await ctx.user();
    return (await getProfile(user.id)) ?? minimalProfile(user.id);
  });

  router.put('/api/profile', async (ctx) => {
    const user = await ctx.user();
    const update = parseProfileBody(await ctx.json());
    const saved = await updateProfile(user.id, (existing) => {
      const next = applyProfileUpdate(existing, update, user.id);
      if (existing) {
        // Python: keep the sources gathered by AI processing when the edit sends none, then note the edit.
        if (!update.sources?.length) next.sources = existing.sources;
        next.sources = addUnique(next.sources, 'User edit');
      }
      return next;
    });
    logger.info('profile_updated', { user_id: user.id, via: 'PUT /api/profile', fields: Object.keys(update) });
    return saved;
  });

  router.delete('/api/profile', async (ctx) => {
    const user = await ctx.user();
    const existed = (await getProfile(user.id)) !== null;
    await deleteProfile(user.id);
    logger.info('profile_deleted', { user_id: user.id, existed });
    return { message: 'Profile deleted' };
  });

  router.post('/api/profile/reset', async (ctx) => {
    const user = await ctx.user();
    await updateProfile(user.id, () => minimalProfile(user.id));
    logger.info('profile_reset', { user_id: user.id });
    return { message: 'Profile reset' };
  });
}
