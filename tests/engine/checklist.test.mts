/**
 * Application Checklist: GET/PUT /api/writer/applications/:id/checklist, with mock Claude.
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/checklist.test.mts
 *   GRANTFINDER_JOB_MODE=direct npx tsx ../tests/engine/checklist.test.mts   (AI steps run inside one request, as on Netlify)
 * VERBOSE=1 shows engine logs.
 *
 * Grants and the org profile are stored directly with repo.ts; the
 * application itself is built through the API (requirements, fit analysis,
 * strategy, gap waived, drafts, score) the way the writer page builds it.
 */
import { api, call, check, finish, guest, saveKey, setupEnv, startMock, type ApiResult } from './helpers.mts';

setupEnv('checklist');
const mock = await startMock();

const repo = await import('../../frontend/src/server/repo.ts');
const types = await import('../../frontend/src/server/types.ts');
const deadlines = await import('../../frontend/src/server/deadlines.ts');
const store = await import('../../frontend/src/server/store.ts');
const log = await import('../../frontend/src/server/log.ts');

type Grant = import('../../frontend/src/server/types.ts').Grant;

const direct = (process.env.GRANTFINDER_JOB_MODE || '').trim().toLowerCase() === 'direct';
console.log(`Job mode: ${direct ? 'direct (each AI step runs inside one request)' : 'local (in-process background jobs)'}`);

// checklist_updated log lines, captured to prove what they hold.
const logged: Array<Record<string, unknown>> = [];
const realInfo = log.logger.info;
log.logger.info = (event: string, fields?: Record<string, unknown>) => {
  if (event === 'checklist_updated') logged.push({ ...(fields ?? {}) });
  realInfo(event, fields);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll a job like the website does (following a step done in parts); returns its result as the response. */
async function finishJob(first: ApiResult, token: string): Promise<ApiResult> {
  if (first.status !== 202 || !first.data?.job_id) return first;
  for (let i = 0; i < 1200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const poll = await api('GET', `/api/jobs/${first.data.job_id}`, { token });
    if (poll.status !== 200) return poll;
    if (poll.data.status === 'done') {
      const next = poll.data.result?.__continue;
      if (next?.path) return finishJob(await api('POST', next.path, { token, json: next.body ?? {} }), token);
      return { ...poll, status: 200, data: poll.data.result };
    }
    if (poll.data.status === 'failed') return { ...poll, status: poll.data.error?.status ?? 500, data: { detail: poll.data.error?.detail } };
  }
  throw new Error(`job ${first.data.job_id} did not finish`);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const FIELDS = ['days_left', 'deadline_passed', 'done', 'next_deadline', 'notes'];
const hasFields = (data: unknown) => Boolean(data) && same(Object.keys(data as object).sort(), FIELDS);

/** Whole days between two YYYY-MM-DD dates, counted here independently of deadlines.ts. */
const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------------------
// Setup: user A with a key, a profile, and grants with different deadlines
// ---------------------------------------------------------------------------

const tokenA = await guest();
await saveKey(tokenA);
const userA: string = (await api('GET', '/api/auth/me', { token: tokenA })).data.id;
const today = deadlines.todayIso();

const soonIso = deadlines.addDaysIso(today, 5);
const soonAnnual = `Annual: ${MONTHS[Number(soonIso.slice(5, 7)) - 1]} ${Number(soonIso.slice(8, 10))}`;
const isoIn20 = deadlines.addDaysIso(today, 20);

function makeGrant(id: string, fields: Partial<Grant>): Grant {
  return {
    id,
    user_id: userA,
    created_at: new Date().toISOString(),
    grant_name: 'Reading Lab Grant',
    deadline: '',
    amount: '',
    funder: '[Funder Name]',
    description: 'Funds Catholic schools in Texas.',
    contact: '',
    url: '',
    status: 'OPEN',
    geo_qualified: 'Yes',
    funder_stats: null,
    category: 'mixed',
    source: 'seed',
    eligibility_notes: null,
    funds_for: ['education'],
    ...fields,
  };
}

await repo.saveGrants(userA, [
  makeGrant('grant_annual', { grant_name: 'Reading Lab Grant', deadline: 'Annual: October 15' }),
  makeGrant('grant_soon', { grant_name: 'Library Refresh Grant', deadline: soonAnnual }),
  makeGrant('grant_iso', { grant_name: 'Science Lab Grant', deadline: isoIn20 }),
  makeGrant('grant_past', { grant_name: 'Closed Grant', deadline: '2020-01-15' }),
  makeGrant('grant_rolling', { grant_name: 'Rolling Grant', deadline: 'Rolling' }),
]);
await repo.saveProfile(
  userA,
  types.normalizeProfile({
    user_id: userA,
    organization_name: '[School Name]',
    organization_type: 'school',
    diocese: 'Diocese of [City]',
    city: '[City]',
    state: 'TX',
    has_school: true,
    student_count: 214,
    program_needs: ['K-3 reading intervention'],
    sources: ['Entered by hand'],
  }),
);

async function createApp(grantId: string): Promise<string> {
  const created = await api('POST', '/api/writer/applications', { token: tokenA, json: { grant_id: grantId } });
  if (created.status !== 200) throw new Error(`creating the application for ${grantId} failed: ${created.status} ${created.text}`);
  return created.data.id;
}
const appId = await createApp('grant_annual');
const appPath = `/api/writer/applications/${appId}`;
const listPath = `${appPath}/checklist`;
const storageKey = `writer/${store.keyPart(userA)}/checklist/${store.keyPart(appId)}`;

// ---------------------------------------------------------------------------
// Sign-in and defaults
// ---------------------------------------------------------------------------

const noTokenGet = await api('GET', listPath);
const noTokenPut = await api('PUT', listPath, { json: { key: 'deliverable:x', done: true } });
const badToken = await api('GET', listPath, { token: 'not-a-real-token' });
check('checklist needs sign-in: GET and PUT without a token -> 401', noTokenGet.status === 401 && noTokenPut.status === 401, [noTokenGet.data, noTokenPut.data]);
check('a made-up token -> 401', badToken.status === 401, badToken.data);

const thisYear = Number(today.slice(0, 4));
const annualDue = `${thisYear}-10-15` >= today ? `${thisYear}-10-15` : `${thisYear + 1}-10-15`;
const annualDays = dayNumber(annualDue) - dayNumber(today);

const first = await api('GET', listPath, { token: tokenA });
check(
  'GET on a new application: nothing ticked, no notes, exactly the documented fields',
  first.status === 200 && hasFields(first.data) && same(first.data.done, {}) && same(first.data.notes, {}),
  first.data,
);
check(
  `"Annual: October 15" on ${today} is ${annualDue}, ${annualDays} day(s) left, not passed`,
  first.data?.next_deadline === annualDue && first.data?.days_left === annualDays && first.data?.deadline_passed === false,
  first.data,
);
check('reading the checklist saves nothing', (await store.kv().get(storageKey)) === null);

// ---------------------------------------------------------------------------
// Build the application through the API (mock Claude)
// ---------------------------------------------------------------------------

const GUIDELINES = 'PASTED GUIDELINES: Narrative sections: Organization Background (250 words), Statement of Need (300 words)...';
const specStart = await api('POST', `${appPath}/grant-spec`, { token: tokenA, json: { guidelines_text: GUIDELINES } });
check(
  `grant spec starts a job${direct ? ' that runs inside a request (direct mode)' : ''}`,
  specStart.status === 202 && (direct ? specStart.data.run === 'direct' : specStart.data.run === undefined),
  specStart.data,
);
const spec = await finishJob(specStart, tokenA);
const deliverables: string[] = spec.data?.grant_spec?.deliverables ?? [];
const formats: string[] = spec.data?.grant_spec?.format_constraints ?? [];
check(
  'requirements analyzed: 4 sections, 4 deliverables, 2 format rules',
  spec.status === 200 && spec.data.grant_spec.required_sections.length === 4 && deliverables.length === 4 && formats.length === 2,
  spec.data,
);

const analysis = await call('POST', `${appPath}/analyze`, { token: tokenA });
const highGap = (analysis.data?.gaps ?? []).find((gap: { severity: string }) => gap.severity === 'high');
check('fit analysis finds a high-severity gap', analysis.status === 200 && Boolean(highGap), analysis.data);
const confirmed = await api('POST', `${appPath}/confirm-strategy`, { token: tokenA, json: { strategy: null } });
check('strategy confirmed', confirmed.status === 200 && confirmed.data.strategy_confirmed === true, confirmed.data);
const waived = await api('PUT', `${appPath}/gaps/${highGap?.id}/waive`, { token: tokenA, json: { reason: 'Attaching the diocesan review instead' } });
check('high gap waived', waived.status === 200 && waived.data.status === 'waived', waived.data);
const drafted = await call('POST', `${appPath}/draft`, { token: tokenA, json: { section_id: null } });
check('all 4 sections drafted', drafted.status === 200 && (drafted.data?.sections ?? []).length === 4, drafted.data);
const scored = await call('POST', `${appPath}/score`, { token: tokenA });
check('draft scored', scored.status === 200 && typeof scored.data?.overall_score === 'number', scored.data);

const stateBefore = await api('GET', appPath, { token: tokenA });
check(
  'the application state lists the deliverables and format rules the checklist ticks off',
  stateBefore.status === 200 && same(stateBefore.data.grant_spec.deliverables, deliverables) && same(stateBefore.data.grant_spec.format_constraints, formats),
  stateBefore.data?.grant_spec,
);

// ---------------------------------------------------------------------------
// PUT: tick, untick, notes
// ---------------------------------------------------------------------------

// The website's keys: a prefix and a slug of the item's text.
const KEY_A = 'deliverable:exhibit-a-irs-determination-letter-or-official-catholic-directory-page';
const KEY_E = 'deliverable:exhibit-e-detailed-project-budget';
const KEY_PORTAL = 'format:submit-through-the-online-portal-after-passing-the-eligibility-quiz';
const claudeCallsBefore = (await mock.requests()).length;

const tickA = await api('PUT', listPath, { token: tokenA, json: { key: KEY_A, done: true } });
check(
  'PUT ticks one item and answers the updated record (same fields, deadline included)',
  tickA.status === 200 && hasFields(tickA.data) && same(tickA.data.done, { [KEY_A]: true }) && same(tickA.data.notes, {}) &&
    tickA.data.next_deadline === annualDue && tickA.data.days_left === annualDays,
  tickA.data,
);
const afterTick = await api('GET', listPath, { token: tokenA });
check('the tick is there on the next GET', afterTick.status === 200 && same(afterTick.data.done, { [KEY_A]: true }), afterTick.data);
const stored = await store.kv().get<{ application_id: string; done: Record<string, boolean>; updated_at: string }>(storageKey);
check(
  'saved under writer/{user}/checklist/{appId}',
  stored?.application_id === appId && stored?.done?.[KEY_A] === true && typeof stored?.updated_at === 'string',
  stored,
);

const NOTE = '  Finance is sending it by noon. NOTE-TEXT-MARKER  ';
const noted = await api('PUT', listPath, { token: tokenA, json: { key: KEY_E, done: false, note: NOTE } });
check(
  'a note is saved (trimmed) on an item that is not ticked',
  noted.status === 200 && same(noted.data.notes, { [KEY_E]: NOTE.trim() }) && noted.data.done[KEY_E] === undefined && noted.data.done[KEY_A] === true,
  noted.data,
);
const tickE = await api('PUT', listPath, { token: tokenA, json: { key: KEY_E, done: true } });
check('ticking without a note keeps the saved note', tickE.status === 200 && tickE.data.done[KEY_E] === true && tickE.data.notes[KEY_E] === NOTE.trim(), tickE.data);
const clearE = await api('PUT', listPath, { token: tokenA, json: { key: KEY_E, done: false, note: '' } });
check(
  'unticking with an empty note removes both (the item is gone from the record)',
  clearE.status === 200 && same(clearE.data.done, { [KEY_A]: true }) && same(clearE.data.notes, {}),
  clearE.data,
);
const nullNote = await api('PUT', listPath, { token: tokenA, json: { key: KEY_PORTAL, done: true, note: 'Quiz passed' } });
const nullNoteCleared = await api('PUT', listPath, { token: tokenA, json: { key: KEY_PORTAL, done: true, note: null } });
check(
  'note: null removes the note and keeps the tick',
  nullNote.data?.notes?.[KEY_PORTAL] === 'Quiz passed' && nullNoteCleared.status === 200 && nullNoteCleared.data.done[KEY_PORTAL] === true &&
    nullNoteCleared.data.notes[KEY_PORTAL] === undefined,
  nullNoteCleared.data,
);
const untickPortal = await api('PUT', listPath, { token: tokenA, json: { key: KEY_PORTAL, done: false } });
check('unticking removes the item from done', untickPortal.status === 200 && same(untickPortal.data.done, { [KEY_A]: true }), untickPortal.data);

const storedBeforeRepeat = await store.kv().get<{ updated_at: string }>(storageKey);
const logsBeforeRepeat = logged.length;
const repeat = await api('PUT', listPath, { token: tokenA, json: { key: KEY_A, done: true } });
const storedAfterRepeat = await store.kv().get<{ updated_at: string }>(storageKey);
check(
  'saving the same thing again changes nothing (no write, no log line)',
  repeat.status === 200 && same(repeat.data.done, { [KEY_A]: true }) && storedAfterRepeat?.updated_at === storedBeforeRepeat?.updated_at &&
    logged.length === logsBeforeRepeat,
  [storedBeforeRepeat, storedAfterRepeat],
);

const unicodeKey = `process:${'é'.repeat(192)}`; // 200 characters, more UTF-16 units than that
const unicode = await api('PUT', listPath, { token: tokenA, json: { key: unicodeKey, done: true } });
check('a 200-character key is accepted (characters, not bytes, are counted)', unicode.status === 200 && unicode.data.done[unicodeKey] === true, unicode.data);
await api('PUT', listPath, { token: tokenA, json: { key: unicodeKey, done: false } });

const protoKey = await api('PUT', listPath, { token: tokenA, json: { key: '__proto__', done: true } });
const protoRead = await api('GET', listPath, { token: tokenA });
check(
  'a key like "__proto__" is stored as a plain key',
  protoKey.status === 200 && Object.prototype.hasOwnProperty.call(protoRead.data.done, '__proto__') && protoRead.data.done.__proto__ === true,
  protoRead.text,
);
await api('PUT', listPath, { token: tokenA, json: { key: '__proto__', done: false } });

// ---------------------------------------------------------------------------
// Logging: ids and the key only
// ---------------------------------------------------------------------------

const lastLog = logged[logged.length - 1] ?? {};
const noteLog = logged.find((entry) => entry.key === KEY_E) ?? {};
check(
  'checklist_updated is logged with ids and the key only (never the note)',
  logged.length > 0 &&
    logged.every((entry) => same(Object.keys(entry).sort(), ['app_id', 'correlation_id', 'key', 'user_id'])) &&
    lastLog.app_id === appId && lastLog.user_id === userA && lastLog.correlation_id === stateBefore.data.application.correlation_id &&
    noteLog.key === KEY_E && !JSON.stringify(logged).includes('NOTE-TEXT-MARKER'),
  logged.slice(-3),
);

// ---------------------------------------------------------------------------
// Two quick ticks never lose one another (compare-and-swap)
// ---------------------------------------------------------------------------

const parallelKeys = Array.from({ length: 12 }, (_, i) => `format:rule-${i}`);
const parallel = await Promise.all(parallelKeys.map((key) => api('PUT', listPath, { token: tokenA, json: { key, done: true } })));
const afterParallel = await api('GET', listPath, { token: tokenA });
check(
  '12 ticks at once: every one is saved',
  parallel.every((result) => result.status === 200) && parallelKeys.every((key) => afterParallel.data.done[key] === true) &&
    afterParallel.data.done[KEY_A] === true,
  afterParallel.data,
);
await Promise.all(parallelKeys.map((key) => api('PUT', listPath, { token: tokenA, json: { key, done: false } })));

// ---------------------------------------------------------------------------
// Validation: 422 with plain messages, nothing saved
// ---------------------------------------------------------------------------

const beforeBad = await api('GET', listPath, { token: tokenA });
const invalid: Array<[string, unknown, string]> = [
  ['no key', { done: true }, 'Field "key" is required.'],
  ['key null', { key: null, done: true }, 'Field "key" is required.'],
  ['blank key', { key: '   ', done: true }, 'Field "key" is required.'],
  ['key not text', { key: 42, done: true }, 'Field "key" must be text.'],
  ['key over 200 characters', { key: 'x'.repeat(201), done: true }, 'Field "key" must be 200 characters or fewer.'],
  ['no done', { key: KEY_E }, 'Field "done" must be true or false.'],
  ['done as text', { key: KEY_E, done: 'yes' }, 'Field "done" must be true or false.'],
  ['done as a number', { key: KEY_E, done: 1 }, 'Field "done" must be true or false.'],
  ['note not text', { key: KEY_E, done: true, note: 5 }, 'Field "note" must be text.'],
  ['note over 500 characters', { key: KEY_E, done: true, note: 'n'.repeat(501) }, 'Field "note" must be 500 characters or fewer.'],
  ['a list instead of an object', [KEY_E, true], 'Request body must be a JSON object.'],
];
for (const [name, body, message] of invalid) {
  const result = await api('PUT', listPath, { token: tokenA, json: body });
  check(`422 for ${name}: "${message}"`, result.status === 422 && result.data?.detail === message, result.data);
}
const afterBad = await api('GET', listPath, { token: tokenA });
check('rejected requests saved nothing', same(afterBad.data, beforeBad.data), afterBad.data);

const longest = await api('PUT', listPath, { token: tokenA, json: { key: 'x'.repeat(200), done: true, note: 'n'.repeat(500) } });
check(
  'a 200-character key with a 500-character note is accepted',
  longest.status === 200 && longest.data.done['x'.repeat(200)] === true && longest.data.notes['x'.repeat(200)]?.length === 500,
  longest.status,
);
await api('PUT', listPath, { token: tokenA, json: { key: 'x'.repeat(200), done: false, note: '' } });

check('the checklist never calls Claude', (await mock.requests()).length === claudeCallsBefore);

const stateAfter = await api('GET', appPath, { token: tokenA });
check(
  'ticking items leaves the application record alone',
  stateAfter.data.application.updated_at === stateBefore.data.application.updated_at &&
    stateAfter.data.application.status === stateBefore.data.application.status,
  [stateBefore.data.application, stateAfter.data.application],
);

// ---------------------------------------------------------------------------
// Owner only: 404 for an unknown application or another user's
// ---------------------------------------------------------------------------

const unknownGet = await api('GET', '/api/writer/applications/app_000000000000/checklist', { token: tokenA });
const unknownPut = await api('PUT', '/api/writer/applications/app_000000000000/checklist', { token: tokenA, json: { key: KEY_A, done: true } });
check(
  'unknown application -> 404 "Application not found" (GET and PUT)',
  unknownGet.status === 404 && unknownGet.data.detail === 'Application not found' && unknownPut.status === 404 && unknownPut.data.detail === 'Application not found',
  [unknownGet.data, unknownPut.data],
);

const tokenB = await guest();
const userB: string = (await api('GET', '/api/auth/me', { token: tokenB })).data.id;
const recordBeforeB = await store.kv().get(storageKey);
const otherGet = await api('GET', listPath, { token: tokenB });
const otherPut = await api('PUT', listPath, { token: tokenB, json: { key: KEY_E, done: true, note: 'from another account' } });
check(
  "another user's application -> 404 (GET and PUT), the same answer as an unknown one",
  otherGet.status === 404 && otherGet.data.detail === 'Application not found' && otherPut.status === 404 && otherPut.data.detail === 'Application not found',
  [otherGet.data, otherPut.data],
);
check(
  "another user's PUT changed nothing and stored nothing",
  same(await store.kv().get(storageKey), recordBeforeB) &&
    (await store.kv().get(`writer/${store.keyPart(userB)}/checklist/${store.keyPart(appId)}`)) === null,
);

// ---------------------------------------------------------------------------
// Deadlines: annual, fixed date, passed, rolling (relative to todayIso)
// ---------------------------------------------------------------------------

const soonApp = await createApp('grant_soon');
const soon = await api('GET', `/api/writer/applications/${soonApp}/checklist`, { token: tokenA });
check(
  `"${soonAnnual}" (5 days from ${today}) -> ${soonIso}, 5 days left`,
  soon.status === 200 && soon.data.next_deadline === soonIso && soon.data.days_left === 5 && soon.data.deadline_passed === false,
  soon.data,
);
check('each application has its own checklist', same(soon.data.done, {}) && same(soon.data.notes, {}), soon.data);

const isoApp = await createApp('grant_iso');
const iso = await api('GET', `/api/writer/applications/${isoApp}/checklist`, { token: tokenA });
check(`a fixed date (${isoIn20}) -> 20 days left`, iso.status === 200 && iso.data.next_deadline === isoIn20 && iso.data.days_left === 20 && iso.data.deadline_passed === false, iso.data);

const pastApp = await createApp('grant_past');
const past = await api('GET', `/api/writer/applications/${pastApp}/checklist`, { token: tokenA });
const pastDays = dayNumber('2020-01-15') - dayNumber(today);
check(
  `a date that has passed (2020-01-15) -> deadline_passed, ${pastDays} days`,
  past.status === 200 && past.data.next_deadline === '2020-01-15' && past.data.days_left === pastDays && past.data.deadline_passed === true,
  past.data,
);
const pastTick = await api('PUT', `/api/writer/applications/${pastApp}/checklist`, { token: tokenA, json: { key: KEY_A, done: true } });
check('items can still be ticked after the deadline', pastTick.status === 200 && pastTick.data.done[KEY_A] === true && pastTick.data.deadline_passed === true, pastTick.data);

const rollingApp = await createApp('grant_rolling');
const rolling = await api('GET', `/api/writer/applications/${rollingApp}/checklist`, { token: tokenA });
check(
  '"Rolling" -> no date: next_deadline null, days_left null, not passed',
  rolling.status === 200 && rolling.data.next_deadline === null && rolling.data.days_left === null && rolling.data.deadline_passed === false,
  rolling.data,
);

// A record written by hand (or an older shape) is read safely: only real ticks and text notes count.
await store.kv().set(`writer/${store.keyPart(userA)}/checklist/${store.keyPart(rollingApp)}`, {
  done: { 'deliverable:a': true, 'deliverable:b': false, 'deliverable:c': 'yes' },
  notes: { 'deliverable:a': 'kept', 'deliverable:b': 7, 'deliverable:c': '   ' },
});
const odd = await api('GET', `/api/writer/applications/${rollingApp}/checklist`, { token: tokenA });
check(
  'a malformed stored record reads as the valid part',
  odd.status === 200 && same(odd.data.done, { 'deliverable:a': true }) && same(odd.data.notes, { 'deliverable:a': 'kept' }),
  odd.data,
);
const oddPut = await api('PUT', `/api/writer/applications/${rollingApp}/checklist`, { token: tokenA, json: { key: 'deliverable:b', done: true } });
check(
  'saving over a malformed record keeps the valid part and adds the change',
  oddPut.status === 200 && same(oddPut.data.done, { 'deliverable:a': true, 'deliverable:b': true }) && same(oddPut.data.notes, { 'deliverable:a': 'kept' }),
  oddPut.data,
);

finish();
