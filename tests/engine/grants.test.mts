/**
 * Grants, discovery and export: every /api/grants, /api/discovery and
 * /api/export endpoint, with a fake Grants.gov and the mock Claude server.
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/grants.test.mts
 *   (VERBOSE=1 shows the engine's log lines)
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';

import { api, call, check, finish, guest, repoRoot, saveKey, setupEnv, startMock } from './helpers.mts';

const dataDir = setupEnv('grants');
const mock = await startMock();

// exceljs lives in frontend/node_modules; the test sits outside that folder.
const requireFromFrontend = createRequire(path.join(repoRoot, 'frontend', 'package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ExcelJS: any = requireFromFrontend('exceljs');

const repo = await import('../../frontend/src/server/repo.ts');
const types = await import('../../frontend/src/server/types.ts');
const deadlines = await import('../../frontend/src/server/deadlines.ts');

const seedFile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'frontend', 'src', 'server', 'data', 'seed_grants.json'), 'utf8'));
const SEED_GRANTS: Array<Record<string, unknown>> = seedFile.grants;
const SEED_FOUNDATIONS: Array<Record<string, unknown>> = seedFile.foundations;
// The starter database is replaced over time: its size is read from the file, never hardcoded.
const SEED_N = SEED_GRANTS.length;
const FOUNDATION_N = SEED_FOUNDATIONS.length;

// ---------------------------------------------------------------------------
// Fake Grants.gov Search2 API
// ---------------------------------------------------------------------------

type GovMode = 'ok' | 'fail' | 'partial' | 'errorcode';
let govMode: GovMode = 'ok';
const govRequests: Array<{ keyword: string; oppStatuses: string; rows: number; startRecordNum: number }> = [];

function govHits(keyword: string): unknown[] {
  const shared = {
    id: '350001',
    number: 'DHS-26-NSGP',
    title: 'Example Nonprofit Security Grant Program',
    agency: 'Example Department of Homeland Security',
    closeDate: '06/15/2027',
    oppStatus: 'posted',
  };
  if (keyword === 'school security') {
    return [
      shared,
      { id: 350002, number: 'DOJ-26-SAFE', title: 'Example School Safety Equipment Program', agencyName: 'Example Department of Justice', closeDate: '', oppStatus: 'forecasted' },
      { id: '', title: 'Listing without an id' },
      { id: '350003', title: '   ' },
    ];
  }
  if (keyword === 'food pantry') {
    return [
      shared,
      { id: '350004', number: 'USDA-26-FOOD', title: 'Example Emergency Food Assistance Grants', agency: 'Example Department of Agriculture', closeDate: '09/30/2027', oppStatus: 'posted' },
    ];
  }
  const id = String(360000 + [...keyword].reduce((sum, ch) => sum + ch.charCodeAt(0), 0));
  return [{ id, number: `GEN-${id}`, title: `Example federal program for ${keyword}`, agency: 'Example Federal Agency', closeDate: '12/31/2027', oppStatus: 'posted' }];
}

const govServer = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  govRequests.push(body);
  if (govMode === 'fail' || (govMode === 'partial' && body.keyword === 'broken search')) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('Service Unavailable');
    return;
  }
  if (govMode === 'errorcode') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errorcode: 7, msg: 'Example search error' }));
    return;
  }
  const hits = govHits(String(body.keyword));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ errorcode: 0, msg: 'Webservice Succeeds', data: { hitCount: hits.length, startRecord: 0, oppHits: hits } }));
});
await new Promise<void>((resolve) => govServer.listen(0, '127.0.0.1', () => resolve()));
const govUrl = `http://127.0.0.1:${(govServer.address() as AddressInfo).port}/v1/api/search2`;
process.env.GRANTS_GOV_API_URL = govUrl;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function me(token: string): Promise<{ id: string }> {
  return (await api('GET', '/api/auth/me', { token })).data;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function grantsOf(token: string): Promise<any[]> {
  return (await api('GET', '/api/grants', { token })).data;
}

async function upload(token: string | undefined, bytes: Uint8Array, filename = 'grants.xlsx') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
  return api('POST', '/api/grants/upload', { token, form });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function workbookBytes(build: (wb: any) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

/** The template from docs/grant-template-format.md plus the Python column names, across all 5 category sheets. */
async function templateWorkbook(): Promise<Uint8Array> {
  return workbookBytes((wb) => {
    const parish = wb.addWorksheet('Church-Parish Grants'); // Excel forbids "/" in sheet names
    parish.addRow(['Grant Name', 'Granting Authority', 'Deadline', 'Amount Min', 'Amount Max', 'Description', 'Eligibility', 'Apply URL', 'Geographic Restriction', 'Categories', 'Notes']);
    parish.addRow(['Example Parish Roof Grant', 'Example Diocese Fund', new Date(Date.UTC(2027, 2, 1)), 5000, 15000, 'Repairs to parish buildings', '501(c)(3) parish', 'https://example.org/roof', 'Texas', 'facilities, capital', 'Requires two bids']);
    parish.addRow(['Example Youth Ministry Grant', 'Example Youth Fund', 'Rolling', null, 20000, 'Youth programs', null, { text: 'Apply here', hyperlink: 'https://example.org/youth' }, 'Nationwide', 'youth; ministry', null]);
    parish.addRow([]);
    parish.addRow([null, 'Row without a grant name', 'Rolling']);

    const school = wb.addWorksheet('Catholic School Grants');
    school.addRow(['Grant Name', 'Deadline', 'Amount', 'Funder', 'Description', 'Contact', 'URL', 'Status', 'Geo Qualified', 'Funder Stats']);
    school.addRow([{ richText: [{ text: 'Example ' }, { text: 'STEM Lab Grant', font: { bold: true } }] }, '2027-01-15', '$25,000', 'Example STEM Foundation', 'STEM labs', 'grants@example.org', 'example.org/stem', 'Open', 'Yes', 'Avg grant $20k']);
    const tuition = school.addRow(['Example Tuition Aid', null, 10000, 'Example Tuition Fund', 'Tuition help', null, null, 'Closed', 'no', null]);
    tuition.getCell(2).value = { formula: 'DATE(2027,4,1)', result: new Date(Date.UTC(2027, 3, 1)) };
    tuition.getCell(2).numFmt = 'yyyy-mm-dd';

    const mixed = wb.addWorksheet('Mixed Church-School Grants');
    mixed.addRow(['Grant Name', 'Funder', 'Deadline', 'Status', 'Geo Qualified']);
    mixed.addRow(['Example Shared Campus Grant', 'Example Campus Fund', 'Rolling', 'Rolling', 'Yes - TX Only']);

    const secular = wb.addWorksheet('Category 4 Non-Catholic'); // Excel caps sheet names at 31 characters
    secular.addRow(['Grant Name', 'Funder', 'Deadline', 'Description']);
    secular.addRow(['Example Library Books Grant', 'Example Literacy Fund', '2027-05-01', 'Library books']);
    secular.addRow(['Koch Foundation Grants', 'Koch Foundation', '2027-02-01', '']);

    const foundations = wb.addWorksheet('Catholic Foundations');
    foundations.addRow(['Foundation Name', 'Application Cycle', 'Focus Areas', 'Location', 'Contact', 'Website', 'Annual Giving', 'Notes']);
    foundations.addRow(['Example Catholic Foundation', 'Spring and Fall', 'Education', '[City], TX', 'info@example.org', 'https://example.org', 'Check website', 'Invitation preferred']);
    foundations.addRow(['Koch Foundation', 'Annual', null, null, null, null, null, null]);

    const more = wb.addWorksheet('More Foundations');
    more.addRow(['Name', 'Focus']);
    more.addRow(['Example Second Foundation', 'Parish ministry']);

    const notes = wb.addWorksheet('Instructions');
    notes.addRow(['Fill in one grant per row.']);
  });
}

function jobFile(userId: string, jobId: string | undefined): string {
  return jobId ? fs.readFileSync(path.join(dataDir, 'store', 'jobs', userId, `${jobId}.json`), 'utf8') : '';
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

const tokenA = await guest();
await saveKey(tokenA);
const userA = await me(tokenA);
const tokenB = await guest(); // no Claude key
const tokenC = await guest();
const userC = await me(tokenC);

const noAuth = await api('GET', '/api/grants');
check('GET /api/grants without sign-in -> 401', noAuth.status === 401, noAuth.data);

const empty = await api('GET', '/api/grants', { token: tokenA });
check('new user has no grants', empty.status === 200 && Array.isArray(empty.data) && empty.data.length === 0, empty.data);

// ---------------------------------------------------------------------------
// Seed database
// ---------------------------------------------------------------------------

check(`seed file has grants (${SEED_N}) and foundations (${FOUNDATION_N})`, Array.isArray(SEED_GRANTS) && Array.isArray(SEED_FOUNDATIONS) && SEED_N > 0 && FOUNDATION_N > 0, { grants: SEED_N, foundations: FOUNDATION_N });

const seed1 = await api('POST', '/api/discovery/seed', { token: tokenA });
check(
  `seed load: found ${SEED_N}, added ${SEED_N}, duplicates 0, total ${SEED_N}`,
  seed1.status === 200 && seed1.data.source === 'seed' && seed1.data.found === SEED_N && seed1.data.added === SEED_N && seed1.data.duplicates === 0 && seed1.data.total_grants === SEED_N,
  seed1.data,
);
check('first seed load: updated 0, retired 0', seed1.data?.updated === 0 && seed1.data?.retired === 0, seed1.data);
check(`seed notes mention the ${FOUNDATION_N} foundations`, seed1.data?.notes?.[0] === `Starter database also added ${FOUNDATION_N} foundations to monitor`, seed1.data?.notes);

let grantsA = await grantsOf(tokenA);
check(`GET /api/grants returns the ${SEED_N} seed grants`, grantsA.length === SEED_N && grantsA.every((g) => g.source === 'seed' && g.user_id === userA.id && /^grant_[0-9a-f]{12}$/.test(g.id)), grantsA.length);
const fieldsOk = grantsA.every((g) =>
  ['grant_name', 'deadline', 'amount', 'funder', 'description', 'contact', 'url', 'status', 'geo_qualified', 'category', 'source', 'created_at'].every((f) => typeof g[f] === 'string') &&
  Array.isArray(g.funds_for) && 'funder_stats' in g && 'eligibility_notes' in g,
);
check('every grant has the full Grant shape', fieldsOk);

const kenedy = grantsA.find((g) => g.grant_name === 'Kenedy Memorial Foundation Grants');
const kenedySeed = SEED_GRANTS.find((g) => g.grant_name === 'Kenedy Memorial Foundation Grants') as Record<string, unknown>;
check('Kenedy record loaded', Boolean(kenedy));
check('Kenedy status OPEN', kenedy?.status === 'OPEN', kenedy?.status);
check('Kenedy deadline "Annual: October 15"', kenedy?.deadline === 'Annual: October 15', kenedy?.deadline);
check('Kenedy url is the application-process page', kenedy?.url === 'https://kenedy.org/grants/application-process/', kenedy?.url);
// The starter database is re-verified monthly: compare with the file, not with a copy of its text.
check('Kenedy amount matches the seed (the full text, not cut)', typeof kenedySeed?.amount === 'string' && kenedySeed.amount.trim() !== '' && kenedy?.amount === kenedySeed.amount, { loaded: kenedy?.amount, file: kenedySeed?.amount });
check('Kenedy eligibility notes kept in full', kenedy?.eligibility_notes === kenedySeed.eligibility_notes && /Exhibits A-H/.test(kenedy?.eligibility_notes), kenedy?.eligibility_notes?.slice(0, 80));
check('Kenedy funds_for tags', JSON.stringify(kenedy?.funds_for) === JSON.stringify(kenedySeed.funds_for) && kenedy?.funds_for.includes('tuition_assistance'), kenedy?.funds_for);
check('Kenedy is TX-only, mixed category, from the seed', kenedy?.geo_qualified === 'Yes - TX Only' && kenedy?.category === 'mixed' && kenedy?.source === 'seed', kenedy);
check('Kenedy funder and contact', kenedy?.funder === kenedySeed.funder && kenedy?.contact === kenedySeed.contact, kenedy?.funder);
check('Kenedy annual deadline never reads as passed', deadlines.parseDeadline(kenedy?.deadline) !== null && deadlines.deadlinePassed(kenedy?.deadline) === false, deadlines.parseDeadline(kenedy?.deadline));

const seedStatuses = new Set(SEED_GRANTS.map((g) => g.status));
check('all seed statuses/geo/categories are valid enum values', grantsA.every((g) => types.GRANT_STATUSES.includes(g.status) && types.GEO_QUALIFIED_VALUES.includes(g.geo_qualified) && types.GRANT_CATEGORIES.includes(g.category)), [...seedStatuses]);

const foundationsA = await api('GET', '/api/grants/foundations', { token: tokenA });
check(`${FOUNDATION_N} seed foundations`, foundationsA.status === 200 && foundationsA.data.length === FOUNDATION_N && foundationsA.data.every((f: { id: string }) => /^foundation_[0-9a-f]{12}$/.test(f.id)), foundationsA.data?.length);
const koch = foundationsA.data.find((f: { foundation_name: string }) => f.foundation_name === 'Koch Foundation');
check('seed foundation fields', koch?.website === 'https://www.thekochfoundation.org' && koch?.location === 'Gainesville, FL' && typeof koch?.notes === 'string', koch);

const seed2 = await api('POST', '/api/discovery/seed', { token: tokenA });
check(
  `second seed load: added 0, duplicates ${SEED_N}, total still ${SEED_N}`,
  seed2.status === 200 && seed2.data.added === 0 && seed2.data.duplicates === SEED_N && seed2.data.total_grants === SEED_N,
  seed2.data,
);
check(
  'second identical seed load: updated 0, retired 0, no "Updated"/"Retired" notes',
  seed2.data?.updated === 0 && seed2.data?.retired === 0 && Array.isArray(seed2.data?.notes) && !seed2.data.notes.some((n: string) => /^(Updated|Retired) /.test(n)),
  seed2.data,
);
check('second seed load adds no foundations', seed2.data?.notes?.[0] === 'Starter database also added 0 foundations to monitor', seed2.data?.notes);
const foundationsA2 = await api('GET', '/api/grants/foundations', { token: tokenA });
check(`still ${FOUNDATION_N} foundations after the second load`, foundationsA2.data.length === FOUNDATION_N, foundationsA2.data.length);

// ---------------------------------------------------------------------------
// Stats, filters, one grant, sources
// ---------------------------------------------------------------------------

const stats = await api('GET', '/api/grants/stats', { token: tokenA });
const expectCount = (field: string, value: string) => SEED_GRANTS.filter((g) => g[field] === value).length;
check(
  'stats shape: totals and every enum key',
  stats.status === 200 && stats.data.total_grants === SEED_N && stats.data.total_foundations === FOUNDATION_N &&
    JSON.stringify(Object.keys(stats.data.by_category)) === JSON.stringify(types.GRANT_CATEGORIES) &&
    JSON.stringify(Object.keys(stats.data.by_status)) === JSON.stringify(types.GRANT_STATUSES) &&
    JSON.stringify(Object.keys(stats.data.by_geo_qualified)) === JSON.stringify(types.GEO_QUALIFIED_VALUES),
  stats.data,
);
check(
  'stats counts match the seed file',
  types.GRANT_CATEGORIES.every((c: string) => stats.data.by_category[c] === expectCount('category', c)) &&
    types.GRANT_STATUSES.every((s: string) => stats.data.by_status[s] === expectCount('status', s)) &&
    types.GEO_QUALIFIED_VALUES.every((v: string) => stats.data.by_geo_qualified[v] === expectCount('geo_qualified', v)),
  stats.data,
);

const mixed = await api('GET', '/api/grants?category=mixed', { token: tokenA });
check('?category=mixed filters', mixed.status === 200 && mixed.data.length === expectCount('category', 'mixed') && mixed.data.every((g: { category: string }) => g.category === 'mixed'), mixed.data?.length);
const badCategory = await api('GET', '/api/grants?category=parishes', { token: tokenA });
check('invalid ?category -> 422 with the allowed values', badCategory.status === 422 && /Invalid category "parishes"/.test(badCategory.data.detail) && /church_parish/.test(badCategory.data.detail), badCategory.data);
const blankCategory = await api('GET', '/api/grants?category=', { token: tokenA });
check('empty ?category= means no filter', blankCategory.status === 200 && blankCategory.data.length === SEED_N, blankCategory.data?.length);
const trailing = await api('GET', '/api/grants/', { token: tokenA });
check('GET /api/grants/ (trailing slash) works', trailing.status === 200 && trailing.data.length === SEED_N, trailing.status);

const one = await api('GET', `/api/grants/${kenedy.id}`, { token: tokenA });
check('GET /api/grants/:id returns the grant', one.status === 200 && one.data.id === kenedy.id && one.data.grant_name === kenedy.grant_name, one.data);
const missing = await api('GET', '/api/grants/grant_doesnotexist', { token: tokenA });
check('unknown grant -> 404 Grant not found', missing.status === 404 && missing.data.detail === 'Grant not found', missing.data);
const otherUser = await api('GET', `/api/grants/${kenedy.id}`, { token: tokenC });
check("another user's grant -> 404", otherUser.status === 404, otherUser.data);

const sources1 = await api('GET', '/api/discovery/sources', { token: tokenA });
check(
  'sources: total and by_source after seeding',
  sources1.status === 200 && sources1.data.total_grants === SEED_N && JSON.stringify(sources1.data.by_source) === JSON.stringify({ seed: SEED_N }),
  sources1.data,
);
check(
  'sources: the three available sources',
  JSON.stringify(sources1.data.available_sources.map((s: { id: string; requires_api_key: boolean }) => [s.id, s.requires_api_key])) ===
    JSON.stringify([['seed', false], ['grants_gov', false], ['web_discovery', true]]) &&
    sources1.data.available_sources.every((s: { name: string; description: string }) => s.name && s.description),
  sources1.data.available_sources,
);

// ---------------------------------------------------------------------------
// Grants.gov (fake server)
// ---------------------------------------------------------------------------

govRequests.length = 0;
const gov1 = await call('POST', '/api/discovery/grants-gov', { token: tokenA, json: { keywords: ['school security', 'food pantry'] } });
check('Grants.gov runs as a background job', typeof gov1.jobId === 'string', gov1.jobId);
check(
  'Grants.gov: found 3 (ids deduplicated across keywords, blank listings skipped), added 3',
  gov1.status === 200 && gov1.data.source === 'grants_gov' && gov1.data.found === 3 && gov1.data.added === 3 && gov1.data.duplicates === 0 && gov1.data.total_grants === SEED_N + 3,
  gov1.data,
);
check(
  'Grants.gov notes list each search',
  JSON.stringify(gov1.data?.notes) === JSON.stringify(["Search 'school security': 4 results", "Search 'food pantry': 2 results"]),
  gov1.data?.notes,
);
// Direct job mode searches several keywords at once, so requests may arrive in any order.
const securityRequest = govRequests.find((r) => r.keyword === 'school security');
check(
  'Grants.gov request body matches the Python (keyword, statuses, rows, start)',
  govRequests.length === 2 && securityRequest?.oppStatuses === 'forecasted|posted' && securityRequest.rows === 25 && securityRequest.startRecordNum === 0,
  govRequests,
);
grantsA = await grantsOf(tokenA);
const nsgp = grantsA.find((g) => g.grant_name === 'Example Nonprofit Security Grant Program');
check(
  'Grants.gov grant fields',
  nsgp?.url === 'https://www.grants.gov/search-results-detail/350001' && nsgp?.status === 'OPEN' && nsgp?.deadline === '06/15/2027' &&
    nsgp?.funder === 'Example Department of Homeland Security' && nsgp?.source === 'grants_gov' && nsgp?.category === 'non_catholic' &&
    nsgp?.geo_qualified === 'Check eligibility' && nsgp?.amount === 'See listing' && nsgp?.contact === 'See Grants.gov listing' &&
    /^Federal grant - verify/.test(nsgp?.eligibility_notes) && /Federal opportunity DHS-26-NSGP \(matched search: 'school security'\)/.test(nsgp?.description),
  nsgp,
);
const forecast = grantsA.find((g) => g.grant_name === 'Example School Safety Equipment Program');
check(
  'forecasted listing: Check deadline status, "Check website" deadline, agencyName funder',
  forecast?.status === 'Check deadline' && forecast?.deadline === 'Check website' && forecast?.funder === 'Example Department of Justice' && forecast?.url.endsWith('/350002'),
  forecast,
);

const gov2 = await call('POST', '/api/discovery/grants-gov', { token: tokenA, json: { keywords: ['school security', 'food pantry'] } });
check('Grants.gov again: added 0, duplicates 3', gov2.status === 200 && gov2.data.added === 0 && gov2.data.duplicates === 3 && gov2.data.total_grants === SEED_N + 3, gov2.data);

govRequests.length = 0;
await call('POST', '/api/discovery/grants-gov', { token: tokenA, json: { keywords: ['library'], max_results: 5 } });
check('max_results 5 -> at least 10 rows per keyword (Python rule)', govRequests[0]?.rows === 10, govRequests[0]);

/** Keywords in the order the result notes list them ("Search 'x': N results"), which is the search order. */
const notedKeywords = (notes: unknown): string[] =>
  (Array.isArray(notes) ? notes : []).map((note) => /^Search '(.+?)'/.exec(String(note))?.[1] ?? '').filter(Boolean);
const sameSet = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

govRequests.length = 0;
const govDefault = await call('POST', '/api/discovery/grants-gov', { token: tokenB });
const DEFAULT_KEYWORDS = ['nonprofit security', 'private school education', 'faith-based community'];
check(
  'no keywords and no profile -> the 3 default keywords',
  govDefault.status === 200 && sameSet(govRequests.map((r) => r.keyword), DEFAULT_KEYWORDS) && govRequests.every((r) => r.rows === 16) &&
    JSON.stringify(notedKeywords(govDefault.data?.notes)) === JSON.stringify(DEFAULT_KEYWORDS),
  [govRequests.map((r) => r.keyword), govDefault.data?.notes],
);

govMode = 'partial';
const govPartial = await call('POST', '/api/discovery/grants-gov', { token: tokenA, json: { keywords: ['broken search', 'food pantry'] } });
check(
  'one keyword fails: job still succeeds and notes the failure',
  govPartial.status === 200 && govPartial.data.notes.some((n: string) => n === "Search 'broken search' failed: Grants.gov answered HTTP 503"),
  govPartial.data,
);

govMode = 'fail';
const govDown = await call('POST', '/api/discovery/grants-gov', { token: tokenA, json: { keywords: ['school security'] } });
check(
  'Grants.gov HTTP error -> job fails 502 "Grants.gov didn\'t answer; try again later"',
  govDown.status === 502 && /^Grants\.gov didn't answer; try again later\. \(Grants\.gov answered HTTP 503\)$/.test(govDown.data.detail),
  govDown.data,
);

govMode = 'errorcode';
const govError = await call('POST', '/api/discovery/grants-gov', { token: tokenA, json: { keywords: ['school security'] } });
check('Grants.gov errorcode answer -> 502 with its message', govError.status === 502 && /Example search error/.test(govError.data.detail), govError.data);
govMode = 'ok';

const closedPort = await new Promise<number>((resolve) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const port = (probe.address() as AddressInfo).port;
    probe.close(() => resolve(port));
  });
});
process.env.GRANTS_GOV_API_URL = `http://127.0.0.1:${closedPort}/v1/api/search2`;
const govRefused = await call('POST', '/api/discovery/grants-gov', { token: tokenA, json: { keywords: ['school security'] } });
check(
  'Grants.gov unreachable -> 502 with a connection reason',
  govRefused.status === 502 && /Grants\.gov didn't answer; try again later/.test(govRefused.data.detail) && /couldn't connect/.test(govRefused.data.detail),
  govRefused.data,
);
process.env.GRANTS_GOV_API_URL = govUrl;

const govBadKeywords = await api('POST', '/api/discovery/grants-gov', { token: tokenA, json: { keywords: 5 } });
check('keywords that are not a list -> 422', govBadKeywords.status === 422 && /keywords/.test(govBadKeywords.data.detail), govBadKeywords.data);
const govBadMax = await api('POST', '/api/discovery/grants-gov', { token: tokenA, json: { max_results: 'lots' } });
check('max_results that is not a number -> 422', govBadMax.status === 422 && /max_results/.test(govBadMax.data.detail), govBadMax.data);
const govNoAuth = await api('POST', '/api/discovery/grants-gov', { json: {} });
check('Grants.gov without sign-in -> 401', govNoAuth.status === 401, govNoAuth.data);

// ---------------------------------------------------------------------------
// AI web discovery (mock Claude)
// ---------------------------------------------------------------------------

const noKey = await api('POST', '/api/discovery/web-search', { token: tokenB, json: {} });
check(
  'web discovery without a Claude key -> 400 right away (no job)',
  noKey.status === 400 && noKey.data.detail === 'Claude API key not set. Please add your API key first.' && !noKey.data.job_id,
  noKey.data,
);
const badFocus = await api('POST', '/api/discovery/web-search', { token: tokenA, json: { focus: 42 } });
check('focus that is not text -> 422', badFocus.status === 422, badFocus.data);

await mock.reset();
const totalBeforeWeb = (await grantsOf(tokenA)).length;
const web1 = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check(
  'web discovery: plain JSON answer -> found 3, added 3',
  web1.status === 200 && web1.data.source === 'web_discovery' && web1.data.found === 3 && web1.data.added === 3 && web1.data.duplicates === 0 && web1.data.total_grants === totalBeforeWeb + 3,
  { data: web1.data, totalBeforeWeb },
);
check('web discovery notes', JSON.stringify(web1.data?.notes) === JSON.stringify(['Ran 0 web searches', 'AI verified 3 opportunities']), web1.data?.notes);
let calls = await mock.requests();
const firstCall = calls.find((c) => c.prompt_id === 'web_discovery_v1');
check('Claude called with prompt id web_discovery_v1 and the web search tool', Boolean(firstCall) && JSON.stringify(firstCall?.tools) === JSON.stringify(['web_search_20260209']), firstCall?.tools);
check(
  'prompt is the Python text (generic profile when none is saved)',
  Boolean(firstCall?.prompt.startsWith('You are a grant researcher for Catholic parishes and schools.')) &&
    Boolean(firstCall?.prompt.includes('ORGANIZATION PROFILE:\n- A Catholic parish and/or Catholic school in the United States\n')) &&
    Boolean(firstCall?.prompt.includes('After searching, return ONLY a JSON array in exactly this shape (no other text after it):\n[')),
  firstCall?.prompt.slice(0, 300),
);
check('job record never contains the API key', web1.jobId !== undefined && !jobFile(userA.id, web1.jobId).includes('sk-ant-'), web1.jobId);

grantsA = await grantsOf(tokenA);
const security = grantsA.find((g) => g.grant_name === 'Example Parish Security Program');
check(
  'web grant: bare domain gets https://, "Texas only" -> TX only, comma tags split',
  security?.url === 'https://example.org/security' && security?.geo_qualified === 'Yes - TX Only' && JSON.stringify(security?.funds_for) === JSON.stringify(['security', 'facilities']) &&
    security?.category === 'church_parish' && security?.source === 'web_discovery' && security?.deadline === 'Rolling',
  security,
);
const pantry = grantsA.find((g) => g.grant_name === 'Example Food Pantry Grant');
check(
  'web grant: javascript: link dropped, list eligibility joined, "Non-Catholic" -> non_catholic',
  pantry?.url === '' && pantry?.eligibility_notes === '501(c)(3); Serves low-income families' && pantry?.category === 'non_catholic',
  pantry,
);
const tech = grantsA.find((g) => g.grant_name === 'Example Catholic Schools Technology Grant');
check('web grant: no status -> "Check deadline"; fields kept', tech?.status === 'Check deadline' && tech?.amount === 'Up to $10,000' && tech?.category === 'catholic_school' && tech?.geo_qualified === 'Yes', tech);

const web2 = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check('web discovery again: added 0, duplicates 3', web2.status === 200 && web2.data.added === 0 && web2.data.duplicates === 3, web2.data);

const pausedGrants = [
  { grant_name: 'Example Playground Grant', funder: 'Example Play Fund', category: 'catholic_school', deadline: '2027-03-15', url: 'https://example.org/play' },
  { grant_name: 'Example Choir Grant', funder: 'Example Music Fund', category: 'church_parish', deadline: 'Check website', url: 'https://example.org/choir' },
];
await mock.reset();
await mock.fixtures({
  web_discovery_v1: {
    turns: [
      { text: 'Searching the web for grants...', stop_reason: 'pause_turn', web_searches: 2 },
      { text: JSON.stringify(pausedGrants), web_searches: 1 },
    ],
  },
});
const paused = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
calls = (await mock.requests()).filter((c) => c.prompt_id === 'web_discovery_v1');
check('paused web search (pause_turn) is continued and parsed: found 2', paused.status === 200 && paused.data.found === 2 && paused.data.added === 2, paused.data);
check('paused search: second request continues the turn', calls.length === 2 && calls[0].turns === 1 && calls[1].turns === 2, calls.map((c) => c.turns));
check('paused search: web searches counted across turns', paused.data?.notes?.[0] === 'Ran 3 web searches', paused.data?.notes);

await mock.fixtures({
  web_discovery_v1:
    'I searched foundation directories [1] and diocesan sites [2][3]. Here is what I verified:\n\n' +
    JSON.stringify([
      { grant_name: 'Example Bell Tower Restoration Grant', funder: 'Example Heritage Fund', category: 'church_parish', url: 'https://example.org/bells' },
      { grant_name: 'Example Teacher Training Grant', funder: 'Example Teaching Fund', category: 'catholic_school', url: 'https://example.org/teachers' },
    ]) +
    '\n\nSources: [1] example.org [2] example.net [3] example.com',
});
const prose = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check('prose-wrapped answer with [1] citations: the real array is found', prose.status === 200 && prose.data.found === 2 && prose.data.added === 2, prose.data);

await mock.fixtures({
  web_discovery_v1: 'Here you go:\n[{"grant_name": "Example Salvaged Grant", "funder": "Example Salvage Fund", "url": "https://example.org/s"},]',
});
const salvaged = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check(
  'malformed list (trailing comma): complete entries are recovered',
  salvaged.status === 200 && salvaged.data.found === 1 && salvaged.data.notes.includes('Recovered grants from a partly malformed AI answer'),
  salvaged.data,
);

await mock.fixtures({
  web_discovery_v1: 'Sources consulted:\n[{"source": "https://example.org/a", "note": "foundation directory"}, {"source": "https://example.org/b", "note": "diocese page"}]',
});
const citationsOnly = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check('a list of citation objects is not a grant list -> 502', citationsOnly.status === 502 && /readable grant list/.test(citationsOnly.data.detail), citationsOnly.data);

await mock.fixtures({ web_discovery_v1: '[{"title": "Example Titled Grant", "funder": "Example Title Fund"}]' });
const titled = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check('"title" is accepted as the grant name', titled.status === 200 && titled.data.found === 1, titled.data);

await mock.fixtures({ web_discovery_v1: '[]' });
const none = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check('empty list -> found 0 with a note', none.status === 200 && none.data.found === 0 && none.data.notes.includes('Claude found no grants it could verify on the web'), none.data);

await mock.fixtures({ web_discovery_v1: 'I could not find any current grants for this organization [1].' });
const unreadable = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check(
  'answer without a grant list -> job fails 502 with a clear message',
  unreadable.status === 502 && /didn't include a readable grant list/.test(unreadable.data.detail),
  unreadable.data,
);

await mock.fixtures({ web_discovery_v1: { text: '[{"grant_name": "Example Cut', stop_reason: 'max_tokens' } });
const cutOff = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check('answer cut off at max_tokens -> 502 saying so', cutOff.status === 502 && /cut off/.test(cutOff.data.detail), cutOff.data);

await mock.reset();
await mock.fail('web_discovery_v1', 401, 'authentication_error', 5);
const fatal = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check(
  'fatal Claude error (bad key) -> job fails with the fix, no fallback',
  fatal.status === 400 && /rejected your Claude API key/.test(fatal.data.detail),
  fatal.data,
);
calls = (await mock.requests()).filter((c) => c.prompt_id === 'web_discovery_v1');
check('fatal error is not retried', calls.length === 1, calls.length);

await mock.reset();
await mock.fail('web_discovery_v1', 400, 'invalid_request_error', 1);
const retried = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
calls = (await mock.requests()).filter((c) => c.prompt_id === 'web_discovery_v1');
check(
  'tool rejected (400) -> one retry with the basic web search tool, like the Python',
  retried.status === 200 && retried.data.notes[0] === 'Retried with basic web search tool' &&
    JSON.stringify(calls.map((c) => c.tools[0])) === JSON.stringify(['web_search_20260209', 'web_search_20250305']),
  { data: retried.data, tools: calls.map((c) => c.tools) },
);

await mock.reset();
await mock.fail('web_discovery_v1', 400, 'invalid_request_error', 2);
const rejectedTwice = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check('400 on the retry too -> job fails with Claude\'s message', rejectedTwice.status === 400 && /Claude rejected the request/.test(rejectedTwice.data.detail), rejectedTwice.data);

await mock.reset();
await mock.fail('web_discovery_v1', 529, 'overloaded_error', 3);
const overloaded = await call('POST', '/api/discovery/web-search', { token: tokenA, json: {} });
check('Claude overloaded (after SDK retries) -> 503 with a clear message', overloaded.status === 503 && /overloaded/.test(overloaded.data.detail), overloaded.data);
await mock.reset();

// Profile-tailored keywords and prompt.
await repo.saveProfile(
  userA.id,
  types.normalizeProfile({
    user_id: userA.id,
    organization_name: '[Parish Name]',
    organization_type: 'both',
    city: '[City]',
    state: 'TX',
    diocese: '[Diocese]',
    has_school: true,
    has_food_pantry: true,
    facility_needs: ['roof repair', 'HVAC'],
    program_needs: ['STEM lab'],
    security_concerns: ['cameras'],
    free_form_notes: 'Our school serves 200 students.',
  }),
);
govRequests.length = 0;
const govProfile = await call('POST', '/api/discovery/grants-gov', { token: tokenA, json: {} });
const PROFILE_KEYWORDS = ['nonprofit security grant', 'nonprofit security', 'private school education', 'faith-based community', 'community facilities', 'food assistance nonprofit'];
check(
  'keywords derived from the profile (security first, at most 6)',
  govProfile.status === 200 && sameSet(govRequests.map((r) => r.keyword), PROFILE_KEYWORDS) &&
    JSON.stringify(notedKeywords(govProfile.data?.notes)) === JSON.stringify(PROFILE_KEYWORDS),
  [govRequests.map((r) => r.keyword), govProfile.data?.notes],
);

const webFocus = await call('POST', '/api/discovery/web-search', { token: tokenA, json: { focus: '  playground equipment  ' } });
calls = (await mock.requests()).filter((c) => c.prompt_id === 'web_discovery_v1');
const focusPrompt = calls[calls.length - 1]?.prompt ?? '';
check('web discovery with profile and focus succeeds', webFocus.status === 200, webFocus.data);
check(
  'prompt carries the profile lines and the focus',
  focusPrompt.includes('- Organization: [Parish Name]\n- Type: both with school\n- Location: [City], TX\n- Diocese: [Diocese]\n- Facility needs: roof repair, HVAC\n- Program needs: STEM lab\n- Security concerns: cameras\n- Notes: Our school serves 200 students.\n\nEXTRA FOCUS: prioritize opportunities related to: playground equipment\n\nSearch for:'),
  focusPrompt.slice(0, 700),
);

// Two discovery jobs finishing together must not lose each other's grants.
const tokenD = await guest();
await saveKey(tokenD);
const [concurrentGov, concurrentWeb] = await Promise.all([
  call('POST', '/api/discovery/grants-gov', { token: tokenD, json: { keywords: ['school security', 'food pantry'] } }),
  call('POST', '/api/discovery/web-search', { token: tokenD, json: {} }),
]);
const grantsD = await grantsOf(tokenD);
check(
  'concurrent Grants.gov + web discovery jobs: nothing lost',
  concurrentGov.status === 200 && concurrentWeb.status === 200 && grantsD.length === concurrentGov.data.added + concurrentWeb.data.added && grantsD.length === 6,
  { gov: concurrentGov.data, web: concurrentWeb.data, total: grantsD.length },
);

// ---------------------------------------------------------------------------
// Excel upload
// ---------------------------------------------------------------------------

const excel = await import('../../frontend/src/server/services/excel.ts');
const sheetCases: Array<[string, string | null]> = [
  ['Church-Parish Grants', 'church_parish'],
  ['Category 1', 'church_parish'],
  ['Parish Grants', 'church_parish'],
  ['Catholic School Grants', 'catholic_school'],
  ['Mixed Church-School Grants', 'mixed'],
  ['Category 3 - Mixed', 'mixed'],
  ['Non Catholic Qualifying', 'non_catholic'],
  ['Secular Grants', 'non_catholic'],
  ['Catholic Foundations', 'foundations'],
  ['Category 5', 'foundations'],
  ['Sheet1', null],
  ['Instructions', null],
];
const sheetMisses = sheetCases.filter(([name, want]) => excel.sheetCategory(name) !== want).map(([name]) => `${name} -> ${excel.sheetCategory(name)}`);
check('sheet names map to categories (longest match, "-" or "/" alike)', sheetMisses.length === 0, sheetMisses);

const template = await templateWorkbook();
const up1 = await upload(tokenC, template);
check(
  'upload: 7 grants across the category sheets, 3 foundations, Instructions skipped',
  up1.status === 200 && up1.data.total_grants === 7 && up1.data.uploaded_grants === 7 && up1.data.added === 7 && up1.data.updated === 0 &&
    up1.data.foundations_count === 3 && up1.data.uploaded_foundations === 3 && JSON.stringify(up1.data.skipped_sheets) === JSON.stringify(['Instructions']) &&
    /^[0-9a-f-]{36}$/.test(up1.data.upload_id),
  up1.data,
);
check(
  'upload: categories (the "Mixed Church-School Grants" sheet is mixed, not school)',
  JSON.stringify(up1.data?.categories) === JSON.stringify({ church_parish: 2, catholic_school: 2, mixed: 1, non_catholic: 2, foundations: 0 }),
  up1.data?.categories,
);

const grantsC = await grantsOf(tokenC);
const byName = (name: string) => grantsC.find((g) => g.grant_name === name);
const roof = byName('Example Parish Roof Grant');
check(
  'doc-template columns: Granting Authority, Amount Min/Max, Apply URL, Eligibility + Notes, Categories, date cell',
  roof?.funder === 'Example Diocese Fund' && roof?.amount === '$5,000 - $15,000' && roof?.url === 'https://example.org/roof' &&
    roof?.eligibility_notes === '501(c)(3) parish Notes: Requires two bids' && JSON.stringify(roof?.funds_for) === JSON.stringify(['facilities', 'capital']) &&
    roof?.deadline === '2027-03-01' && roof?.geo_qualified === 'Yes - TX Only' && roof?.status === 'Check deadline' && roof?.contact === 'See website' &&
    roof?.source === 'upload' && roof?.category === 'church_parish',
  roof,
);
const youth = byName('Example Youth Ministry Grant');
check(
  'hyperlink cell uses its link; "Up to" amount; "Nationwide" -> Yes',
  youth?.url === 'https://example.org/youth' && youth?.amount === 'Up to $20,000' && youth?.geo_qualified === 'Yes' && JSON.stringify(youth?.funds_for) === JSON.stringify(['youth', 'ministry']),
  youth,
);
const stem = byName('Example STEM Lab Grant');
check(
  'Python columns: rich-text name, status Open, geo Yes, funder stats, bare-domain URL',
  stem?.deadline === '2027-01-15' && stem?.amount === '$25,000' && stem?.funder === 'Example STEM Foundation' && stem?.contact === 'grants@example.org' &&
    stem?.url === 'https://example.org/stem' && stem?.status === 'OPEN' && stem?.geo_qualified === 'Yes' && stem?.funder_stats === 'Avg grant $20k' && stem?.category === 'catholic_school',
  stem,
);
const tuitionGrant = byName('Example Tuition Aid');
check(
  'formula date cell, numeric amount, Closed, "no"',
  tuitionGrant?.deadline === '2027-04-01' && tuitionGrant?.amount === '$10,000' && tuitionGrant?.status === 'CLOSED' && tuitionGrant?.geo_qualified === 'No' && tuitionGrant?.url === '',
  tuitionGrant,
);
check('empty rows and rows without a name are skipped', !grantsC.some((g) => g.funder === 'Row without a grant name'), grantsC.map((g) => g.grant_name));

const foundationsC = (await api('GET', '/api/grants/foundations', { token: tokenC })).data;
const exampleFoundation = foundationsC.find((f: { foundation_name: string }) => f.foundation_name === 'Example Catholic Foundation');
check(
  'foundation rows parsed (Website column, Notes)',
  exampleFoundation?.website === 'https://example.org' && exampleFoundation?.application_cycle === 'Spring and Fall' && exampleFoundation?.notes === 'Invitation preferred' && exampleFoundation?.location === '[City], TX',
  exampleFoundation,
);
check(
  'a foundations sheet with a plain "Name" column still works',
  foundationsC.some((f: { foundation_name: string; focus_areas: string }) => f.foundation_name === 'Example Second Foundation' && f.focus_areas === 'Parish ministry'),
  foundationsC.map((f: { foundation_name: string }) => f.foundation_name),
);

const statsC = await api('GET', '/api/grants/stats', { token: tokenC });
check('stats after upload', statsC.data.total_grants === 7 && statsC.data.total_foundations === 3 && statsC.data.by_status.OPEN === 1 && statsC.data.by_status.CLOSED === 1, statsC.data);
const sourcesC = await api('GET', '/api/discovery/sources', { token: tokenC });
check('sources counts uploads', JSON.stringify(sourcesC.data.by_source) === JSON.stringify({ upload: 7 }), sourcesC.data.by_source);

// Merge into a database that already has seed + discovered grants.
grantsA = await grantsOf(tokenA);
const beforeCount = grantsA.length;
const kochGrantBefore = grantsA.find((g) => g.grant_name === 'Koch Foundation Grants');
const up2 = await upload(tokenA, template);
grantsA = await grantsOf(tokenA);
const kochGrantAfter = grantsA.find((g) => g.grant_name === 'Koch Foundation Grants');
const kenedyAfter = grantsA.find((g) => g.grant_name === 'Kenedy Memorial Foundation Grants');
check(
  'upload merges with discovered grants: 6 added, 1 updated, nothing removed',
  up2.status === 200 && up2.data.added === 6 && up2.data.updated === 1 && up2.data.total_grants === beforeCount + 6 && grantsA.length === beforeCount + 6,
  { data: up2.data, beforeCount },
);
check('Kenedy (and its id) survive the upload', kenedyAfter?.id === kenedy.id && kenedyAfter?.status === 'OPEN', kenedyAfter?.id);
check(
  'matching row updates the saved grant: same id, new deadline, seed details kept',
  kochGrantAfter?.id === kochGrantBefore?.id && kochGrantAfter?.deadline === '2027-02-01' && kochGrantAfter?.eligibility_notes === kochGrantBefore?.eligibility_notes &&
    kochGrantAfter?.amount === kochGrantBefore?.amount && kochGrantAfter?.source === 'seed',
  { before: kochGrantBefore, after: kochGrantAfter },
);
const kochFoundationAfter = (await api('GET', '/api/grants/foundations', { token: tokenA })).data.find((f: { foundation_name: string }) => f.foundation_name === 'Koch Foundation');
check(
  'matching foundation row updates only the filled-in fields',
  kochFoundationAfter?.id === koch.id && kochFoundationAfter?.application_cycle === 'Annual' && kochFoundationAfter?.website === koch.website && up2.data.foundations_updated === 1 && up2.data.foundations_added === 2,
  kochFoundationAfter,
);
const up3 = await upload(tokenA, template, 'GRANTS.XLSX');
check('uploading the same file again changes nothing (upper-case .XLSX accepted)', up3.status === 200 && up3.data.added === 0 && up3.data.updated === 7 && up3.data.total_grants === up2.data.total_grants, up3.data);

// Upload errors.
const xlsName = await upload(tokenC, template, 'grants.xls');
check('.xls file -> 400 "Save the file as .xlsx (Excel Workbook) and upload again"', xlsName.status === 400 && /Save the file as \.xlsx \(Excel Workbook\) and upload again/.test(xlsName.data.detail), xlsName.data);
const oleBytes = new Uint8Array(4096);
oleBytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const xlsRenamed = await upload(tokenC, oleBytes, 'renamed.xlsx');
check('old .xls content renamed to .xlsx -> the same .xls message', xlsRenamed.status === 400 && /Save the file as \.xlsx/.test(xlsRenamed.data.detail), xlsRenamed.data);
const csvFile = await upload(tokenC, new TextEncoder().encode('Grant Name\nX\n'), 'grants.csv');
check('wrong file type -> 400 with the Python wording', csvFile.status === 400 && csvFile.data.detail === 'Invalid file type. Please upload an Excel file (.xlsx)', csvFile.data);
const corrupt = await upload(tokenC, new TextEncoder().encode('this is not a workbook'), 'broken.xlsx');
check('unreadable .xlsx -> 400 "Failed to parse Excel file" with a fix', corrupt.status === 400 && /^Failed to parse Excel file/.test(corrupt.data.detail) && /Save As/.test(corrupt.data.detail), corrupt.data);
const sheet1 = await workbookBytes((wb) => {
  const sheet = wb.addWorksheet('Sheet1');
  sheet.addRow(['Grant Name', 'Description']);
  sheet.addRow(['Example Grant', 'Something']);
});
const noSheets = await upload(tokenC, sheet1);
check('no category sheets -> 400 naming the sheets to rename', noSheets.status === 400 && /No grant sheets found/.test(noSheets.data.detail) && /"Sheet1"/.test(noSheets.data.detail) && /Catholic School Grants/.test(noSheets.data.detail), noSheets.data);
const noNameColumn = await workbookBytes((wb) => {
  const sheet = wb.addWorksheet('Catholic School Grants');
  sheet.addRow(['Program', 'Description']);
  sheet.addRow(['Example', 'Something']);
});
const noRows = await upload(tokenC, noNameColumn);
check('category sheet without a Grant Name column -> 400 explaining row 1', noRows.status === 400 && /No grants found/.test(noRows.data.detail) && /no "Grant Name" column/.test(noRows.data.detail), noRows.data);
const afterErrors = await grantsOf(tokenC);
check('failed uploads leave the saved grants untouched', afterErrors.length === 7, afterErrors.length);

const noFile = await api('POST', '/api/grants/upload', { token: tokenC, form: new FormData() });
check('no file field -> 422', noFile.status === 422 && /No file was uploaded/.test(noFile.data.detail), noFile.data);
const emptyFile = await upload(tokenC, new Uint8Array(0), 'empty.xlsx');
check('empty file -> 400', emptyFile.status === 400 && /empty/.test(emptyFile.data.detail), emptyFile.data);
const big = await upload(tokenC, new Uint8Array(10 * 1024 * 1024 + 1), 'big.xlsx');
check('file over the limit -> 413 naming the limit in MB', big.status === 413 && /limit is 10 MB/.test(big.data.detail), big.data);
const uploadNoAuth = await upload(undefined, template);
check('upload without sign-in -> 401', uploadNoAuth.status === 401, uploadNoAuth.data);

// ---------------------------------------------------------------------------
// Export (match results written directly; matching is another area)
// ---------------------------------------------------------------------------

const breakdown = (n: number) => ({ eligibility_fit: n, need_alignment: n, capacity_signals: n, timing: n, completeness: n });
const now = new Date();
await repo.saveMatchResults({
  session_id: 'session_export_1',
  user_id: userA.id,
  profile_id: 'profile_test',
  total_grants_evaluated: 3,
  matches: [
    {
      grant_id: 'grant_a', grant_name: 'Example Catholic Schools Technology Grant', funder: 'Example Catholic Education Fund', amount: 'Up to $10,000',
      deadline: '2026-12-01', url: 'https://example.org/tech-grant', contact: 'grants@example.org', category: 'catholic_school', geo_qualified: 'Yes',
      score: 92, score_tier: 'excellent', score_breakdown: { eligibility_fit: 95, need_alignment: 90, capacity_signals: 85, timing: 100, completeness: 80 },
      explanation: 'Strong fit: technology needs, "STEM" plan, and eligibility.', evidence: ['Website: new STEM lab planned'], is_shortlisted: true,
    },
    {
      grant_id: 'grant_b', grant_name: '=SUM(1,2) Example Formula Grant', funder: 'Example Fund', amount: 'Varies', deadline: 'Rolling', url: '',
      contact: '555-0100 | Via website', category: 'non_catholic', geo_qualified: 'Check eligibility', score: 55, score_tier: 'possible',
      score_breakdown: breakdown(55), explanation: 'Line one\nline two', evidence: [], is_shortlisted: false,
    },
    {
      grant_id: 'grant_c', grant_name: 'Example Out-of-State Grant', funder: 'Example Ohio Fund', amount: 'Varies', deadline: 'Check website', url: '',
      contact: 'See website', category: 'church_parish', geo_qualified: 'No', score: 10, score_tier: 'not_eligible',
      score_breakdown: breakdown(10), explanation: 'Ohio only.', evidence: [], is_shortlisted: false,
    },
  ],
  excellent_matches: 1, good_matches: 0, possible_matches: 1, weak_matches: 0, not_eligible: 1,
  created_at: now.toISOString(),
  expires_at: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
});

const csv = await api('POST', '/api/export', { token: tokenA, json: { session_id: 'session_export_1', format: 'csv', include_all_matches: true } });
const csvLines = csv.text.split('\r\n');
check('CSV export: 200, text/csv, attachment with the Python file name', csv.status === 200 && csv.headers.get('content-type') === 'text/csv; charset=utf-8' && /^attachment; filename="grantfinder_matches_\d{8}_\d{6}\.csv"$/.test(csv.headers.get('content-disposition') || ''), [csv.status, csv.headers.get('content-type'), csv.headers.get('content-disposition')]);
check('CSV starts with a UTF-8 byte-order mark (Excel)', csv.bytes[0] === 0xef && csv.bytes[1] === 0xbb && csv.bytes[2] === 0xbf);
check(
  'CSV header row (the Python columns, then the grant facts)',
  csvLines[0] ===
    'Rank,Grant Name,Funder,Amount,Deadline,Score (%),Tier,Category,Geo Qualified,Contact,URL,Explanation,' +
      'Geography,Religious Eligibility,Deadline Notes,Typical Award,Funder Priorities,Eligibility Notes,Last Verified',
  csvLines[0],
);
check(
  'CSV row quoting like Python csv',
  csvLines[1] === '1,Example Catholic Schools Technology Grant,Example Catholic Education Fund,"Up to $10,000",2026-12-01,92,excellent,catholic_school,Yes,grants@example.org,https://example.org/tech-grant,"Strong fit: technology needs, ""STEM"" plan, and eligibility.",,,,,,,',
  csvLines[1],
);
check('CSV: formula-looking text is neutralized, multi-line text quoted', csvLines[2].startsWith(`2,"'=SUM(1,2) Example Formula Grant"`) && csvLines[2].endsWith('"Line one\nline two",,,,,,,'), csvLines[2]);
check('CSV: all 3 matches with include_all_matches', csvLines.length === 5 && csvLines[4] === '', csvLines.length);

const csvShort = await api('POST', '/api/export', { token: tokenA, json: { session_id: 'session_export_1', format: 'csv' } });
check('CSV without include_all_matches: shortlisted only', csvShort.status === 200 && csvShort.text.split('\r\n').length === 3, csvShort.text);

const md = await api('POST', '/api/export', { token: tokenA, json: { session_id: 'session_export_1', format: 'md', include_all_matches: true } });
check('Markdown export: text/markdown, .md file', md.status === 200 && md.headers.get('content-type') === 'text/markdown; charset=utf-8' && /grantfinder_matches_\d{8}_\d{6}\.md"$/.test(md.headers.get('content-disposition') || ''), md.headers.get('content-disposition'));
check(
  'Markdown content follows the Python report',
  md.text.startsWith('# GrantFinder AI - Match Results\n\n**Generated:** ') && md.text.includes('**Total Grants Evaluated:** 3') &&
    md.text.includes('- Excellent Matches (85-100%): 1') && md.text.includes('### 1. Example Catholic Schools Technology Grant') &&
    md.text.includes('**Score:** 🟢 92% (Excellent)') && md.text.includes('| Category | Catholic School |') &&
    md.text.includes('- Eligibility Fit (40%): 95%') && md.text.includes('**Evidence:**\n- Website: new STEM lab planned') &&
    md.text.includes('**Score:** ⚫ 10% (Not Eligible)') && md.text.trimEnd().endsWith('*Generated by GrantFinder AI v2.6*'),
  md.text.slice(0, 400),
);
check('Markdown table cells escape "|" and newlines', md.text.includes('| Contact | 555-0100 \\| Via website |'), md.text.match(/\| Contact \|[^\n]*/g));

const pdf = await api('POST', '/api/export', { token: tokenA, json: { session_id: 'session_export_1', format: 'pdf', include_all_matches: true } });
check(
  'PDF request -> the Markdown report with a clear notice (as the Python stub did)',
  pdf.status === 200 && /\.md"$/.test(pdf.headers.get('content-disposition') || '') && pdf.text.includes('> PDF export is not available yet') && /PDF export is not available yet/.test(pdf.headers.get('x-grantfinder-notice') || ''),
  pdf.text.slice(0, 200),
);

const unknownSession = await api('POST', '/api/export', { token: tokenA, json: { session_id: 'session_nope', format: 'csv' } });
check('unknown session -> 404 Match results not found', unknownSession.status === 404 && unknownSession.data.detail === 'Match results not found', unknownSession.data);
const otherSession = await api('POST', '/api/export', { token: tokenC, json: { session_id: 'session_export_1', format: 'csv' } });
check("another user's session -> 404 (results are per user)", otherSession.status === 404, otherSession.data);
const badFormat = await api('POST', '/api/export', { token: tokenA, json: { session_id: 'session_export_1', format: 'docx' } });
check('unsupported format -> 422', badFormat.status === 422 && /Unsupported export format "docx"/.test(badFormat.data.detail), badFormat.data);
const noSession = await api('POST', '/api/export', { token: tokenA, json: { format: 'csv' } });
check('missing session_id -> 422', noSession.status === 422 && /session_id/.test(noSession.data.detail), noSession.data);
const exportNoAuth = await api('POST', '/api/export', { json: { session_id: 'session_export_1', format: 'csv' } });
check('export without sign-in -> 401', exportNoAuth.status === 401, exportNoAuth.data);

const formats = await api('GET', '/api/export/formats');
check(
  'GET /api/export/formats (no sign-in, as before)',
  formats.status === 200 && JSON.stringify(formats.data.formats.map((f: { id: string }) => f.id)) === JSON.stringify(['csv', 'md', 'pdf', 'ics']) &&
    formats.data.formats.every((f: { name: string; description: string }) => f.name && f.description),
  formats.data,
);

// ---------------------------------------------------------------------------
// Sources after everything, then clear
// ---------------------------------------------------------------------------

const sourcesA = await api('GET', '/api/discovery/sources', { token: tokenA });
const bySource = sourcesA.data.by_source;
check(
  'sources: seed, grants_gov, web_discovery and upload all counted',
  bySource.seed === SEED_N && bySource.grants_gov > 0 && bySource.web_discovery > 0 && bySource.upload === 6 &&
    sourcesA.data.total_grants === Object.values(bySource as Record<string, number>).reduce((a, b) => a + b, 0),
  bySource,
);

const cleared = await api('DELETE', '/api/grants', { token: tokenC });
check('DELETE /api/grants -> "Grant database cleared"', cleared.status === 200 && cleared.data.message === 'Grant database cleared', cleared.data);
const afterClear = await api('GET', '/api/grants', { token: tokenC });
const foundationsAfterClear = await api('GET', '/api/grants/foundations', { token: tokenC });
const statsAfterClear = await api('GET', '/api/grants/stats', { token: tokenC });
check(
  'clear removes grants and foundations',
  afterClear.data.length === 0 && foundationsAfterClear.data.length === 0 && statsAfterClear.data.total_grants === 0 && statsAfterClear.data.total_foundations === 0,
  statsAfterClear.data,
);
const clearTrailing = await api('DELETE', '/api/grants/', { token: tokenC });
check('DELETE /api/grants/ (trailing slash) works', clearTrailing.status === 200, clearTrailing.status);
const userCGrants = await repo.getGrants(userC.id);
check('cleared user has no stored grants', userCGrants.length === 0, userCGrants.length);

govServer.close();
mock.stop();
finish();
