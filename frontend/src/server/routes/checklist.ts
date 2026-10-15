/**
 * /api/writer/applications/:appId/checklist: the Application Checklist's own
 * small record (the checklist card is app/writer/ApplicationChecklist.tsx).
 *
 * Everything else the checklist shows (sections, gaps, approvals) comes from
 * the application state the writer page already loads. This record keeps only
 * what a person ticks off by hand, plus the deadline counted in days:
 *
 *   GET -> { done, notes, next_deadline, days_left, deadline_passed }
 *   PUT { key, done, note? } -> the same shape, after the change
 *
 *   done             item key -> true for each item ticked off (unticked items are left out)
 *   notes            item key -> a short note (at most 500 characters)
 *   next_deadline    the application's deadline as YYYY-MM-DD, resolved like
 *                    everywhere else (deadlines.ts, Central time by default):
 *                    "Annual: October 15" is the next October 15 on or after
 *                    today; "Rolling" or an unreadable deadline is null
 *   days_left        whole days from today (0 = due today, negative = passed), or null
 *   deadline_passed  true only when the deadline is a date before today
 *
 * Keys are the website's own stable ids, e.g. "deliverable:exhibit-a-board-list"
 * (at most 200 characters); the engine stores them as given and never reads
 * meaning into them. On PUT, a missing note leaves the saved note as it is;
 * an empty note (or null) removes it.
 *
 * Owner-only: an unknown application, or another user's, is a 404 exactly like
 * the other writer routes. Stored at writer/{user}/checklist/{appId} and
 * written with update() (compare-and-swap), so two quick ticks never lose one
 * another.
 */
import { daysUntil, parseDeadline, todayIso } from '../deadlines';
import { HttpError } from '../errors';
import type { RequestContext } from '../http';
import { logger } from '../log';
import type { Router } from '../router';
import { loadApplication } from '../services/writer';
import { keyPart, kv, update } from '../store';
import type { Application } from '../types';

export const MAX_CHECKLIST_KEY_CHARS = 200;
export const MAX_CHECKLIST_NOTE_CHARS = 500;
/** Ticked items and notes one application's checklist can hold (a real application has a few dozen). */
export const MAX_CHECKLIST_ITEMS = 500;

/** What is stored. */
interface ChecklistRecord {
  application_id: string;
  done: Record<string, boolean>;
  notes: Record<string, string>;
  updated_at: string;
}

/** What GET and PUT answer. */
export interface ChecklistState {
  done: Record<string, boolean>;
  notes: Record<string, string>;
  next_deadline: string | null;
  days_left: number | null;
  deadline_passed: boolean;
}

export const checklistKey = (userId: string, appId: string) => `writer/${keyPart(userId)}/checklist/${keyPart(appId)}`;

const isMap = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Characters as a person counts them (an emoji or accented letter is one). */
const charCount = (text: string) => Array.from(text).length;

/** The stored record with anything malformed dropped (older or hand-edited records stay readable). */
function cleanRecord(value: unknown, appId: string): ChecklistRecord {
  const record = isMap(value) ? value : {};
  const done = isMap(record.done) ? Object.entries(record.done).filter(([, ticked]) => ticked === true) : [];
  const notes = isMap(record.notes)
    ? Object.entries(record.notes).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
    : [];
  return {
    application_id: appId,
    // fromEntries defines plain own properties, so even a key like "__proto__" is just a key.
    done: Object.fromEntries(done) as Record<string, boolean>,
    notes: Object.fromEntries(notes),
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : '',
  };
}

/** The answer for GET and PUT: the ticked items and notes, and the deadline counted from today. */
function checklistState(stored: unknown, app: Application): ChecklistState {
  const { done, notes } = cleanRecord(stored, app.id);
  const today = todayIso();
  const due = parseDeadline(app.deadline, today);
  return {
    done,
    notes,
    next_deadline: due,
    days_left: due === null ? null : daysUntil(due, today),
    deadline_passed: due !== null && due < today,
  };
}

interface ItemChange {
  key: string;
  done: boolean;
  /** undefined: keep the saved note; '' : remove it; otherwise the new note. */
  note: string | undefined;
}

/** Validate a PUT body, answering 422 with a plain message. */
function parseChange(body: Record<string, unknown>): ItemChange {
  const key = body.key;
  if (key === undefined || key === null) throw new HttpError(422, 'Field "key" is required.');
  if (typeof key !== 'string') throw new HttpError(422, 'Field "key" must be text.');
  if (!key.trim()) throw new HttpError(422, 'Field "key" is required.');
  if (charCount(key) > MAX_CHECKLIST_KEY_CHARS) {
    throw new HttpError(422, `Field "key" must be ${MAX_CHECKLIST_KEY_CHARS} characters or fewer.`);
  }
  if (typeof body.done !== 'boolean') throw new HttpError(422, 'Field "done" must be true or false.');
  let note: string | undefined;
  if (body.note === null) {
    note = '';
  } else if (body.note !== undefined) {
    if (typeof body.note !== 'string') throw new HttpError(422, 'Field "note" must be text.');
    note = body.note.trim();
    if (charCount(note) > MAX_CHECKLIST_NOTE_CHARS) {
      throw new HttpError(422, `Field "note" must be ${MAX_CHECKLIST_NOTE_CHARS} characters or fewer.`);
    }
  }
  return { key, done: body.done, note };
}

async function getChecklist(ctx: RequestContext): Promise<ChecklistState> {
  const user = await ctx.user();
  const app = await loadApplication(user.id, ctx.params.appId);
  const stored = await kv().get<ChecklistRecord>(checklistKey(user.id, app.id));
  return checklistState(stored, app);
}

/** Tick or untick one item (and set or clear its note). Saving the same thing twice changes nothing. */
async function setChecklistItem(ctx: RequestContext): Promise<ChecklistState> {
  const user = await ctx.user();
  const change = parseChange(await ctx.json());
  const app = await loadApplication(user.id, ctx.params.appId);
  let changed = false as boolean;
  const saved = await update<ChecklistRecord>(checklistKey(user.id, app.id), (current) => {
    changed = false;
    const record = cleanRecord(current, app.id);
    const done = new Map(Object.entries(record.done));
    const notes = new Map(Object.entries(record.notes));
    const sizeBefore = new Set([...done.keys(), ...notes.keys()]).size;
    const wasDone = done.get(change.key) === true;
    const noteBefore = notes.get(change.key);

    if (change.done) done.set(change.key, true);
    else done.delete(change.key);
    if (change.note !== undefined) {
      if (change.note) notes.set(change.key, change.note);
      else notes.delete(change.key);
    }
    if (wasDone === change.done && notes.get(change.key) === noteBefore) return undefined; // nothing to save

    const sizeAfter = new Set([...done.keys(), ...notes.keys()]).size;
    if (sizeAfter > sizeBefore && sizeAfter > MAX_CHECKLIST_ITEMS) {
      throw new HttpError(
        422,
        `This checklist already holds ${MAX_CHECKLIST_ITEMS} items. Untick items you no longer need, then try again.`,
      );
    }
    changed = true;
    return {
      application_id: app.id,
      done: Object.fromEntries(done),
      notes: Object.fromEntries(notes),
      updated_at: new Date().toISOString(),
    };
  });
  // Ids and the item key only: a note can hold names, so it never reaches the logs.
  if (changed) {
    logger.info('checklist_updated', { correlation_id: app.correlation_id, app_id: app.id, user_id: user.id, key: change.key });
  }
  return checklistState(saved, app);
}

export function registerChecklistRoutes(router: Router): void {
  router.get('/api/writer/applications/:appId/checklist', getChecklist);
  router.put('/api/writer/applications/:appId/checklist', setChecklistItem);
}
