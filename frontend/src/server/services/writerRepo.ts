/**
 * Storage for the GrantWriter's own artifacts.
 *
 * The writer never copies the shared grant record or org profile (repo.ts
 * owns those). Applications live at applications/{userId}/{appId} (repo.ts);
 * everything the writer produces lives here:
 *
 *   writer/{userId}/specs/{grantId}                     GrantSpec (enriches the grant record)
 *   writer/{userId}/apps/{appId}/fit                    FitAnalysis
 *   writer/{userId}/apps/{appId}/gaps                   Gap[]
 *   writer/{userId}/apps/{appId}/intake                 IntakeRequest[]
 *   writer/{userId}/apps/{appId}/sections/{sectionId}   SectionDraft (one key per section, so
 *                                                       parallel drafting saves each one at once)
 *   writer/{userId}/apps/{appId}/scorecard              Scorecard
 *
 * Every read-modify-write goes through store.update() (compare-and-swap),
 * because routes and background jobs touch the same records concurrently.
 */
import { applicationKey } from '../repo';
import { getMany, keyPart, kv, update } from '../store';
import type { Application, FitAnalysis, Gap, GrantSpec, IntakeRequest, Scorecard, SectionDraft } from '../types';

const userBase = (userId: string) => `writer/${keyPart(userId)}`;
const appBase = (userId: string, appId: string) => `${userBase(userId)}/apps/${keyPart(appId)}`;

export const grantSpecKey = (userId: string, grantId: string) => `${userBase(userId)}/specs/${keyPart(grantId)}`;
export const fitAnalysisKey = (userId: string, appId: string) => `${appBase(userId, appId)}/fit`;
export const gapsKey = (userId: string, appId: string) => `${appBase(userId, appId)}/gaps`;
export const intakeKey = (userId: string, appId: string) => `${appBase(userId, appId)}/intake`;
export const sectionsPrefix = (userId: string, appId: string) => `${appBase(userId, appId)}/sections/`;
export const sectionDraftKey = (userId: string, appId: string, sectionId: string) =>
  `${sectionsPrefix(userId, appId)}${keyPart(sectionId)}`;
export const scorecardKey = (userId: string, appId: string) => `${appBase(userId, appId)}/scorecard`;

// =============================================================================
// Applications (records live in repo.ts's layout; these are the writes)
// =============================================================================

/** Store a new application only if none exists under its id. False when one already does. */
export async function createApplicationIfNew(app: Application): Promise<boolean> {
  return kv().setIf(applicationKey(app.user_id, app.id), app, null);
}

/** Merge changes into the application and bump updated_at (Python's _touch). Null when it is gone. */
export async function touchApplication(
  userId: string,
  appId: string,
  changes: Partial<Application> = {},
): Promise<Application | null> {
  return update<Application>(applicationKey(userId, appId), (current) =>
    current ? { ...current, ...changes, updated_at: new Date().toISOString() } : undefined,
  );
}

// =============================================================================
// Grant specs (keyed by grant, like the Python grant_specs_db, but per user)
// =============================================================================

export async function getGrantSpec(userId: string, grantId: string): Promise<GrantSpec | null> {
  return kv().get<GrantSpec>(grantSpecKey(userId, grantId));
}

export async function saveGrantSpec(userId: string, spec: GrantSpec): Promise<void> {
  await kv().set(grantSpecKey(userId, spec.grant_id), spec);
}

// =============================================================================
// Fit analysis and gaps
// =============================================================================

export async function getFitAnalysis(userId: string, appId: string): Promise<FitAnalysis | null> {
  return kv().get<FitAnalysis>(fitAnalysisKey(userId, appId));
}

export async function saveFitAnalysis(userId: string, analysis: FitAnalysis): Promise<void> {
  await kv().set(fitAnalysisKey(userId, analysis.application_id), analysis);
}

export async function getGaps(userId: string, appId: string): Promise<Gap[]> {
  return (await kv().get<Gap[]>(gapsKey(userId, appId))) ?? [];
}

/** Replace the whole gap list (a new fit analysis starts a fresh one, as in the Python). */
export async function saveGaps(userId: string, appId: string, gaps: Gap[]): Promise<void> {
  await kv().set(gapsKey(userId, appId), gaps);
}

/** Read-modify-write the gap list. `fn` returns the new list, or undefined to leave it unchanged. */
export async function updateGaps(userId: string, appId: string, fn: (gaps: Gap[]) => Gap[] | undefined): Promise<Gap[]> {
  const result = await update<Gap[]>(gapsKey(userId, appId), (current) => fn(current ?? []));
  return result ?? [];
}

// =============================================================================
// Stakeholder intake
// =============================================================================

export async function getIntakeRequests(userId: string, appId: string): Promise<IntakeRequest[]> {
  return (await kv().get<IntakeRequest[]>(intakeKey(userId, appId))) ?? [];
}

export async function updateIntakeRequests(
  userId: string,
  appId: string,
  fn: (requests: IntakeRequest[]) => IntakeRequest[] | undefined,
): Promise<IntakeRequest[]> {
  const result = await update<IntakeRequest[]>(intakeKey(userId, appId), (current) => fn(current ?? []));
  return result ?? [];
}

// =============================================================================
// Section drafts
// =============================================================================

export async function getSectionDraft(userId: string, appId: string, sectionId: string): Promise<SectionDraft | null> {
  return kv().get<SectionDraft>(sectionDraftKey(userId, appId, sectionId));
}

/** Every saved section draft for the application (storage order; callers sort by the spec). */
export async function listSectionDrafts(userId: string, appId: string): Promise<SectionDraft[]> {
  const keys = await kv().list(sectionsPrefix(userId, appId));
  return getMany<SectionDraft>(keys);
}

/** Save one section's draft (replaces that section's previous draft). */
export async function saveSectionDraft(userId: string, draft: SectionDraft): Promise<void> {
  await kv().set(sectionDraftKey(userId, draft.application_id, draft.section_id), draft);
}

// =============================================================================
// Scorecard (latest only)
// =============================================================================

export async function getScorecard(userId: string, appId: string): Promise<Scorecard | null> {
  return kv().get<Scorecard>(scorecardKey(userId, appId));
}

export async function saveScorecard(userId: string, scorecard: Scorecard): Promise<void> {
  await kv().set(scorecardKey(userId, scorecard.application_id), scorecard);
}
