/**
 * Storage layout and accessors for the shared records.
 *
 * Single source of truth (as in the Python engine): grants and the org
 * profile are stored once per user; matching and the writer both read them.
 *
 *   users/{userId}                       User                (auth.ts)
 *   apikeys/{userId}                     encrypted Claude key (auth.ts)
 *   grants/{userId}                      Grant[]
 *   foundations/{userId}                 Foundation[]
 *   profiles/{userId}                    OrganizationProfile
 *   matches/{userId}/{sessionId}         MatchResults
 *   applications/{userId}/{appId}        Application         (writer)
 *   writer/{userId}/...                  writer artifacts     (writer, see services/writerRepo.ts)
 *   jobs/{userId}/{jobId}                Job                 (jobs.ts)
 *   ratelimit/{bucket}/{ipHash}          rate-limit window   (auth.ts)
 */
import { HttpError } from './errors';
import { keyPart, kv, update } from './store';
import { normalizeProfile, type Application, type Foundation, type Grant, type MatchResults, type OrganizationProfile } from './types';

const grantsKey = (userId: string) => `grants/${keyPart(userId)}`;
const foundationsKey = (userId: string) => `foundations/${keyPart(userId)}`;
const profileKey = (userId: string) => `profiles/${keyPart(userId)}`;
const matchKey = (userId: string, sessionId: string) => `matches/${keyPart(userId)}/${keyPart(sessionId)}`;
export const applicationKey = (userId: string, appId: string) => `applications/${keyPart(userId)}/${keyPart(appId)}`;
export const applicationsPrefix = (userId: string) => `applications/${keyPart(userId)}/`;

// =============================================================================
// Grants and foundations
// =============================================================================

export async function getGrants(userId: string): Promise<Grant[]> {
  return (await kv().get<Grant[]>(grantsKey(userId))) ?? [];
}

export async function saveGrants(userId: string, grants: Grant[]): Promise<void> {
  await kv().set(grantsKey(userId), grants);
}

/** Read-modify-write the grant list (safe when two discovery jobs finish together). */
export async function updateGrants(userId: string, fn: (grants: Grant[]) => Grant[] | undefined): Promise<Grant[]> {
  const result = await update<Grant[]>(grantsKey(userId), (current) => fn(current ?? []));
  return result ?? [];
}

export async function getGrant(userId: string, grantId: string): Promise<Grant | null> {
  return (await getGrants(userId)).find((grant) => grant.id === grantId) ?? null;
}

export async function deleteGrants(userId: string): Promise<void> {
  await kv().delete(grantsKey(userId));
}

export async function getFoundations(userId: string): Promise<Foundation[]> {
  return (await kv().get<Foundation[]>(foundationsKey(userId))) ?? [];
}

export async function saveFoundations(userId: string, foundations: Foundation[]): Promise<void> {
  await kv().set(foundationsKey(userId), foundations);
}

export async function updateFoundations(userId: string, fn: (foundations: Foundation[]) => Foundation[] | undefined): Promise<Foundation[]> {
  const result = await update<Foundation[]>(foundationsKey(userId), (current) => fn(current ?? []));
  return result ?? [];
}

export async function deleteFoundations(userId: string): Promise<void> {
  await kv().delete(foundationsKey(userId));
}

// =============================================================================
// Organization profile
// =============================================================================

export async function getProfile(userId: string): Promise<OrganizationProfile | null> {
  const stored = await kv().get<OrganizationProfile>(profileKey(userId));
  return stored ? normalizeProfile({ ...stored, user_id: userId }) : null;
}

export async function saveProfile(userId: string, profile: OrganizationProfile): Promise<OrganizationProfile> {
  const normalized = normalizeProfile({ ...profile, user_id: userId, last_updated: new Date().toISOString() });
  await kv().set(profileKey(userId), normalized);
  return normalized;
}

/**
 * Read-modify-write the profile. `fn` gets the current profile (or null when
 * none exists) and returns the new one, or undefined to leave it unchanged.
 */
export async function updateProfile(
  userId: string,
  fn: (current: OrganizationProfile | null) => OrganizationProfile | undefined | Promise<OrganizationProfile | undefined>,
): Promise<OrganizationProfile | null> {
  const result = await update<OrganizationProfile>(profileKey(userId), async (current) => {
    const next = await fn(current ? normalizeProfile({ ...current, user_id: userId }) : null);
    if (next === undefined) return undefined;
    return normalizeProfile({ ...next, user_id: userId, last_updated: new Date().toISOString() });
  });
  return result ? normalizeProfile({ ...result, user_id: userId }) : null;
}

export async function deleteProfile(userId: string): Promise<void> {
  await kv().delete(profileKey(userId));
}

export async function requireProfile(userId: string, message?: string): Promise<OrganizationProfile> {
  const profile = await getProfile(userId);
  if (!profile) {
    throw new HttpError(400, message ?? 'No organization profile found. Please complete setup first.');
  }
  return profile;
}

// =============================================================================
// Match results
// =============================================================================

export const matchesPrefix = (userId: string) => `matches/${keyPart(userId)}/`;

/** The user's match session ids, oldest first (session ids sort by time). */
export async function listMatchSessionIds(userId: string): Promise<string[]> {
  const prefix = matchesPrefix(userId);
  return (await kv().list(prefix)).map((key) => key.slice(prefix.length)).filter((id) => id && !id.includes('/'));
}

export async function saveMatchResults(results: MatchResults): Promise<void> {
  await kv().set(matchKey(results.user_id, results.session_id), results);
}

export async function getMatchResults(userId: string, sessionId: string): Promise<MatchResults | null> {
  return kv().get<MatchResults>(matchKey(userId, sessionId));
}

export async function updateMatchResults(
  userId: string,
  sessionId: string,
  fn: (current: MatchResults | null) => MatchResults | undefined,
): Promise<MatchResults | null> {
  return update<MatchResults>(matchKey(userId, sessionId), fn);
}

// =============================================================================
// Applications (writer)
// =============================================================================

export async function getApplication(userId: string, appId: string): Promise<Application | null> {
  return kv().get<Application>(applicationKey(userId, appId));
}

export async function listApplications(userId: string): Promise<Application[]> {
  const keys = await kv().list(applicationsPrefix(userId));
  const apps = await Promise.all(keys.map((key) => kv().get<Application>(key)));
  return apps.filter((app): app is Application => app !== null);
}
