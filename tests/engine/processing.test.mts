/**
 * Processing, profile, and matching: website scan, questionnaire, document
 * upload, profile endpoints, grant matching, match results, shortlist.
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/processing.test.mts
 *
 * VERBOSE=1 shows engine logs. A fake parish website is served from a local
 * server (GRANTFINDER_ALLOW_LOCAL_FETCH=1 lets the engine read it).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { api, call, check, finish, guest, repoRoot, saveKey, setupEnv, startMock } from './helpers.mts';

setupEnv('processing', { GRANTFINDER_ALLOW_LOCAL_FETCH: '1' });
const mock = await startMock();

const repo = await import('../../frontend/src/server/repo.ts');
const store = await import('../../frontend/src/server/store.ts');
const jobs = await import('../../frontend/src/server/jobs.ts');
const ai = await import('../../frontend/src/server/services/ai.ts');
const processingRoutes = await import('../../frontend/src/server/routes/processing.ts');
const writer = await import('../../frontend/src/server/services/writer.ts');
const deadlines = await import('../../frontend/src/server/deadlines.ts');
/** The test grants' open deadline: about six months after the suite's today (follows GRANTFINDER_TODAY in test mode). */
const OPEN_DEADLINE = deadlines.addDaysIso(deadlines.todayIso(), 180);

// The docx package lives in frontend/node_modules.
const frontendRequire = createRequire(path.join(repoRoot, 'frontend', 'package.json'));
const { Document, Packer, Paragraph } = frontendRequire('docx');

const FIXTURES = path.join(repoRoot, 'tests', 'engine', 'fixtures', 'processing');
const API_KEY_MISSING = 'Claude API key not set. Please add your API key first.';
const NO_MATCH_RESULTS = 'No match results yet. Run matching first.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function userIdOf(token: string): Promise<string> {
  return (await api('GET', '/api/auth/me', { token })).data.id;
}

function fileForm(filename: string, content: string | Uint8Array, field = 'file'): FormData {
  const form = new FormData();
  form.append(field, new Blob([content]), filename);
  return form;
}

const upload = (token: string, filename: string, content: string | Uint8Array) =>
  api('POST', '/api/processing/upload-document', { token, form: fileForm(filename, content) });
const uploadAndWait = (token: string, filename: string, content: string | Uint8Array) =>
  call('POST', '/api/processing/upload-document', { token, form: fileForm(filename, content) });

async function prompts(promptId: string): Promise<string[]> {
  return (await mock.requests()).filter((r) => r.prompt_id === promptId).map((r) => r.prompt);
}

async function profileOf(token: string): Promise<Json> {
  return (await api('GET', '/api/processing/profile', { token })).data;
}

/** Poll a job the way the website does (GET /api/jobs/{id}) until it is done or failed. */
async function waitForJob(token: string, jobId: string, timeoutMs = 90000): Promise<Json> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const poll = await api('GET', `/api/jobs/${jobId}`, { token });
    if (poll.data?.status === 'done' || poll.data?.status === 'failed') return poll.data;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`job ${jobId} did not finish in ${timeoutMs}ms`);
}

async function storedJob(userId: string, jobId: string | undefined): Promise<Json> {
  return jobId ? store.kv().get(jobs.jobKey(userId, jobId)) : null;
}

/** A one-page PDF with real text (built by hand, correct xref offsets). */
function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = ['BT', '/F1 12 Tf', '14 TL', '72 720 Td', ...lines.map((line) => `(${esc(line)}) Tj T*`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

async function makeDocx(paragraphs: string[]): Promise<Uint8Array> {
  const doc = new Document({ sections: [{ children: paragraphs.map((text) => new Paragraph(text)) }] });
  return new Uint8Array(await Packer.toBuffer(doc));
}

function grant(userId: string, id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    user_id: userId,
    grant_name: name,
    deadline: OPEN_DEADLINE,
    amount: 'Up to $25,000',
    funder: `${name} Funder`,
    description: `Supports ${name.toLowerCase()} for Catholic parishes and schools.`,
    contact: 'grants@example.org',
    url: `https://example.org/${id}`,
    status: 'OPEN',
    geo_qualified: 'Yes',
    funder_stats: null,
    category: 'church_parish',
    source: 'seed',
    eligibility_notes: null,
    funds_for: ['facilities'],
    created_at: new Date().toISOString(),
    ...extra,
  };
}

/** Fixed ids: tests/mock-claude/fixtures/processing.json scores these. */
function testGrants(userId: string) {
  return [
    grant(userId, 'grant_pt_01', 'Parish Hall Roof Repair Fund'),
    grant(userId, 'grant_pt_02', 'School STEM Lab Grant', { deadline: 'Rolling', status: 'Rolling', category: 'catholic_school' }),
    grant(userId, 'grant_pt_03', 'Texas Parish Security Grant', { geo_qualified: 'Yes - TX Only' }),
    grant(userId, 'grant_pt_04', 'Closed Capital Campaign Grant', { status: 'CLOSED' }),
    grant(userId, 'grant_pt_05', 'Expired Library Books Grant', { deadline: '2020-01-15' }),
    grant(userId, 'grant_pt_06', 'Out-of-Area Community Grant', { geo_qualified: 'No' }),
    grant(userId, 'grant_pt_07', 'Annual Catholic Education Grant', { deadline: 'Annual: October 15', category: 'catholic_school' }),
    grant(userId, 'grant_pt_08', 'Food Pantry Expansion Grant', { category: 'non_catholic' }),
    grant(userId, 'grant_pt_09', 'Large Hospital Equipment Grant', { category: 'non_catholic' }),
    grant(userId, 'grant_pt_10', 'Youth Ministry Retreat Grant'),
    grant(userId, 'grant_pt_11', 'Playground Safety Grant', { category: 'mixed' }),
    grant(userId, 'grant_pt_12', 'Diocesan Youth Formation Grant'),
    grant(userId, 'grant_pt_13', 'Organ Restoration Grant'),
    grant(userId, 'grant_pt_14', 'Security Camera Grant'),
  ];
}

function testFoundation(userId: string) {
  return {
    id: 'fdn_pt_01',
    user_id: userId,
    foundation_name: 'Example Catholic Foundation',
    application_cycle: 'Annual: March 1',
    focus_areas: 'Catholic education, parish facilities',
    location: 'Texas',
    contact: 'info@example.org',
    website: 'https://example.org/foundation',
    annual_giving: '$2M',
    notes: 'Invitation preferred',
    created_at: new Date().toISOString(),
  };
}

const byId = (results: Json, id: string): Json => results.matches.find((m: Json) => m.grant_id === id);

// ---------------------------------------------------------------------------
// Fake parish website
// ---------------------------------------------------------------------------

const SITE_PAGES: Record<string, string> = {
  '/': 'site-home.html',
  '/about-us': 'site-about.html',
  '/school': 'site-school.html',
  '/school/admissions': 'site-admissions.html',
  '/ministries': 'site-ministries.html',
  '/news/bulletin': 'site-bulletin.html',
};
const siteHits: string[] = [];
const site = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://site.test').pathname.replace(/\/+$/, '') || '/';
  siteHits.push(pathname);
  if (pathname.startsWith('/blocked')) {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Access denied</h1><p>Automated access is not allowed.</p></body></html>');
    return;
  }
  const file = SITE_PAGES[pathname];
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(FIXTURES, file)));
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ===========================================================================
// 1. Sign-in and the Claude key are checked before any work
// ===========================================================================

const tokenA = await guest();
const userA = await userIdOf(tokenA);

const unauth = await Promise.all([
  api('POST', '/api/processing/scan-website', { json: { church_url: siteUrl } }),
  api('POST', '/api/processing/generate-questionnaire'),
  api('GET', '/api/processing/questionnaire'),
  api('POST', '/api/processing/submit-questionnaire', { json: { answers: [] } }),
  api('POST', '/api/processing/upload-document', { form: fileForm('a.txt', 'hello') }),
  api('GET', '/api/processing/profile'),
  api('PUT', '/api/processing/profile', { json: {} }),
  api('POST', '/api/processing/match-grants'),
  api('POST', '/api/processing/match-grants/continue', { json: {} }),
  api('GET', '/api/processing/match-results/latest'),
  api('GET', '/api/processing/match-results/x'),
  api('POST', '/api/processing/shortlist/x'),
  api('GET', '/api/profile'),
  api('PUT', '/api/profile', { json: {} }),
  api('DELETE', '/api/profile'),
  api('POST', '/api/profile/reset'),
]);
check('every processing/profile route needs sign-in (401)', unauth.every((r) => r.status === 401), unauth.map((r) => r.status));

const noKey = await Promise.all([
  api('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: siteUrl } }),
  api('POST', '/api/processing/generate-questionnaire', { token: tokenA }),
  api('POST', '/api/processing/upload-document', { token: tokenA, form: fileForm('notes.txt', 'Roof leaks.') }),
  api('POST', '/api/processing/match-grants', { token: tokenA }),
]);
check(
  'scan, questionnaire, upload, match without a Claude key -> 400 with the Python message, no job',
  noKey.every((r) => r.status === 400 && r.data.detail === API_KEY_MISSING),
  noKey.map((r) => [r.status, r.data]),
);

await saveKey(tokenA);

// ===========================================================================
// 2. Profile before setup
// ===========================================================================

const noProfile = await api('GET', '/api/processing/profile', { token: tokenA });
check(
  'GET /api/processing/profile with no profile -> 404 Python wording',
  noProfile.status === 404 && noProfile.data.detail === 'No profile found. Please complete the setup process.',
  noProfile.data,
);
const template = await api('GET', '/api/profile', { token: tokenA });
check(
  'GET /api/profile with no profile -> empty template with every field',
  template.status === 200 && template.data.organization_type === 'parish' && template.data.organization_name === '' &&
    template.data.user_id === userA && Array.isArray(template.data.facility_needs) && Array.isArray(template.data.evidence) &&
    template.data.is_501c3 === true && template.data.voice_profile === null,
  template.data,
);

// ===========================================================================
// 3. Website scan
// ===========================================================================

const scanNoUrl = await api('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: '', school_url: null } });
check('scan with no URL -> 400 Python wording', scanNoUrl.status === 400 && scanNoUrl.data.detail === 'At least one website URL is required', scanNoUrl.data);

const scanBadUrl = await api('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: 'not a website' } });
check('scan with a non-address -> 400 explaining the format', scanBadUrl.status === 400 && /doesn't look like a website address/.test(scanBadUrl.data.detail), scanBadUrl.data);

const scanBadType = await api('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: 42 } });
check('scan with a non-text URL -> 422', scanBadType.status === 422, scanBadType.data);

await mock.reset();
const scan = await call('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: siteUrl, school_url: `${siteUrl}/school` } });
check(
  'scan reads the parish site and returns WebsiteScanResult',
  scan.status === 200 && scan.data.organization_basics?.name === 'St. Example Catholic Parish' &&
    scan.data.leadership?.pastor === 'Rev. [Staff Name]' && scan.data.school_info?.student_count === 240 &&
    Array.isArray(scan.data.facilities) && scan.data.facilities.includes('Parish hall') &&
    scan.data.current_initiatives?.length === 3 && scan.data.extracted_text_length > 500,
  scan.data,
);
check(
  'scan result has exactly the Python fields',
  JSON.stringify(Object.keys(scan.data ?? {}).sort()) ===
    JSON.stringify(['current_initiatives', 'extracted_text_length', 'facilities', 'leadership', 'organization_basics', 'school_info']),
  Object.keys(scan.data ?? {}),
);
check(
  'crawler followed the grant-relevant internal pages (about, school, ministries, bulletin, admissions), not contact',
  ['/', '/about-us', '/school', '/ministries', '/news/bulletin', '/school/admissions'].every((p) => siteHits.includes(p)) && !siteHits.includes('/contact'),
  siteHits,
);
const scanPrompts = await prompts('website_scan_v1');
check(
  'scan prompt (website_scan_v1) has both sites, sub-page text, and no script/footer text',
  scanPrompts.length === 1 && scanPrompts[0].includes(`=== CHURCH WEBSITE (${siteUrl}) ===`) &&
    scanPrompts[0].includes(`=== SCHOOL WEBSITE (${siteUrl}/school) ===`) && scanPrompts[0].includes('food pantry serves 120 families') &&
    scanPrompts[0].includes('playground equipment is 30 years old') && !scanPrompts[0].includes('SCRIPT_TEXT_SHOULD_NOT_APPEAR') &&
    !scanPrompts[0].includes('FOOTER_TEXT_SHOULD_NOT_APPEAR') && scanPrompts[0].includes('Return ONLY the JSON object, no other text.'),
  scanPrompts[0]?.slice(0, 400),
);
const scannedProfile = await profileOf(tokenA);
check(
  'scan saved the profile (name, city, state, diocese, leaders, school, URLs, initiatives, source)',
  scannedProfile.organization_name === 'St. Example Catholic Parish' && scannedProfile.city === 'Exampleville' &&
    scannedProfile.state === 'TX' && scannedProfile.diocese === 'Diocese of Example' && scannedProfile.pastor_name === 'Rev. [Staff Name]' &&
    scannedProfile.principal_name === '[Staff Name]' && scannedProfile.has_school === true && scannedProfile.student_count === 240 &&
    scannedProfile.website_url === siteUrl && scannedProfile.school_website_url === `${siteUrl}/school` &&
    scannedProfile.current_initiatives.length === 3 && scannedProfile.sources.some((s: string) => s.startsWith('Website scan: ')),
  scannedProfile,
);
const scanJob = await storedJob(userA, scan.jobId);
check('scan job input holds only the URLs (never the API key)', scanJob && !JSON.stringify(scanJob.input).includes('sk-ant-') && scanJob.kind === 'processing.scan_website', scanJob?.input);

const blocked = await call('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: `${siteUrl}/blocked` } });
check(
  'scan of a site that blocks bots (HTTP 403) fails with the URL, the reason, and what to do instead',
  blocked.status === 400 && blocked.data.detail.includes(`${siteUrl}/blocked`) && /HTTP 403/.test(blocked.data.detail) &&
    /blocks automated reading/.test(blocked.data.detail) && /Enter the basics by hand/.test(blocked.data.detail) && /upload documents/.test(blocked.data.detail) && /free-form notes/.test(blocked.data.detail),
  blocked.data,
);

const deadUrl = `http://127.0.0.1:${await closedPort()}`;
const unreachable = await call('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: deadUrl, school_url: `${siteUrl}/blocked/school` } });
check(
  'scan of unreachable + blocked URLs names each URL with its reason',
  unreachable.status === 400 && unreachable.data.detail.includes(deadUrl) && /couldn't connect/.test(unreachable.data.detail) &&
    unreachable.data.detail.includes(`${siteUrl}/blocked/school`) && /either website/.test(unreachable.data.detail),
  unreachable.data,
);

await mock.reset();
const partial = await call('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: siteUrl, school_url: `${siteUrl}/blocked` } });
const partialPrompt = (await prompts('website_scan_v1'))[0] ?? '';
check(
  'partial success: one site blocked, the other read -> scan still completes with what was read',
  partial.status === 200 && partial.data.organization_basics?.name === 'St. Example Catholic Parish' &&
    partialPrompt.includes('=== CHURCH WEBSITE') && !partialPrompt.includes('=== SCHOOL WEBSITE'),
  partial.data,
);

await mock.fail('website_scan_v1', 529, 'overloaded_error', 3);
const scanOverloaded = await call('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: siteUrl } });
check(
  'scan when Claude stays overloaded -> clear retry message (no silent empty result)',
  scanOverloaded.status === 503 && scanOverloaded.data.detail === 'Website scan failed: Claude is overloaded right now. Wait a minute and try again.',
  scanOverloaded.data,
);

const tokenB = await guest();
await saveKey(tokenB, 'sk-ant-nocredit-1');
const scanNoCredit = await call('POST', '/api/processing/scan-website', { token: tokenB, json: { church_url: siteUrl } });
check(
  'scan with an out-of-credit key -> job fails with the billing message (fatal, no fallback)',
  scanNoCredit.status === 400 && /out of API credits/.test(scanNoCredit.data.detail),
  scanNoCredit.data,
);
const profileB = await api('GET', '/api/processing/profile', { token: tokenB });
check('failed scan saved nothing', profileB.status === 404, profileB.data);

// Re-scan with corrected addresses while a scan is still running.
await mock.reset();
await mock.delay('website_scan_v1', 1500);
const slowScan = await api('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: siteUrl } });
const sameUrls = await api('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: `${siteUrl}/` } });
const corrected = await api('POST', '/api/processing/scan-website', { token: tokenA, json: { church_url: siteUrl, school_url: `${siteUrl}/school` } });
check(
  'scan with the same addresses while one runs -> 409 attached to the running scan (a trailing slash is the same address)',
  slowScan.status === 202 && sameUrls.status === 409 && sameUrls.data.job_id === slowScan.data.job_id && sameUrls.data.running === true &&
    /already running/.test(sameUrls.data.detail),
  [slowScan.data, sameUrls.data],
);
check(
  'scan with different addresses while one runs -> a new scan starts (not attached to the old one)',
  corrected.status === 202 && /^job_/.test(corrected.data.job_id) && corrected.data.job_id !== slowScan.data.job_id,
  corrected.data,
);
const bothStarted = slowScan.status === 202 && corrected.status === 202;
const [slowDone, correctedDone]: Json[] = bothStarted
  ? await Promise.all([waitForJob(tokenA, slowScan.data.job_id), waitForJob(tokenA, corrected.data.job_id)])
  : [null, null];
await mock.delay('website_scan_v1', 0);
const slowJob = await storedJob(userA, slowScan.data?.job_id);
check(
  'the older scan finishing last does not overwrite the newer one: it fails with a plain message, the newer one is saved',
  slowDone?.status === 'failed' && slowDone.error?.status === 409 && /newer website scan/.test(slowDone.error.detail) && !/\u2014/.test(slowDone.error.detail) &&
    correctedDone?.status === 'done' && correctedDone.result?.organization_basics?.name === 'St. Example Catholic Parish' &&
    (slowJob?.notes ?? []).some((n: string) => n.includes('Not saved: a newer website scan')) &&
    (await profileOf(tokenA)).school_website_url === `${siteUrl}/school`,
  [slowDone?.error, correctedDone?.status],
);
check(
  'scan exclusive keys: same addresses (ignoring case of the host, a trailing slash) share a key, other addresses do not',
  processingRoutes.scanExclusiveKey('https://Example.org/', null) === processingRoutes.scanExclusiveKey('https://example.org', null) &&
    processingRoutes.scanExclusiveKey('https://example.org', null) !== processingRoutes.scanExclusiveKey('https://example.org', 'https://school.example.org') &&
    processingRoutes.scanExclusiveKey('https://example.org', null) !== processingRoutes.scanExclusiveKey(null, 'https://example.org') &&
    /^processing\.scan_website:[0-9a-f]{12}$/.test(processingRoutes.scanExclusiveKey('https://example.org', null)),
  processingRoutes.scanExclusiveKey('https://example.org', null),
);

// ===========================================================================
// 4. Questionnaire
// ===========================================================================

const qNoGrants = await api('POST', '/api/processing/generate-questionnaire', { token: tokenA });
check(
  'questionnaire with no grants -> 400 Python wording',
  qNoGrants.status === 400 && qNoGrants.data.detail === 'No grants uploaded. Please upload grant database first.',
  qNoGrants.data,
);

await repo.saveGrants(userA, testGrants(userA) as Json);
await repo.saveFoundations(userA, [testFoundation(userA)] as Json);

const noSavedQ = await api('GET', '/api/processing/questionnaire', { token: tokenA });
check(
  'GET /api/processing/questionnaire before any questionnaire -> 404 "No questionnaire yet"',
  noSavedQ.status === 404 && noSavedQ.data.detail === 'No questionnaire yet',
  noSavedQ.data,
);

await mock.reset();
const questionnaire = await call('POST', '/api/processing/generate-questionnaire', { token: tokenA });
const questions: Json[] = questionnaire.data?.questions ?? [];
const savedQ = await api('GET', '/api/processing/questionnaire', { token: tokenA });
check(
  'GET /api/processing/questionnaire after generating -> exactly the generate result (same questions, same shape)',
  savedQ.status === 200 && JSON.stringify(savedQ.data) === JSON.stringify(questionnaire.data) &&
    JSON.stringify(Object.keys(savedQ.data).sort()) === JSON.stringify(['questions', 'total_questions']) && savedQ.data.total_questions === 10,
  savedQ.data,
);
const otherUserQ = await api('GET', '/api/processing/questionnaire', { token: tokenB });
check("another user can't read the saved questionnaire (404 for them)", otherUserQ.status === 404 && otherUserQ.data.detail === 'No questionnaire yet', otherUserQ.data);
check(
  'questionnaire job returns {questions, total_questions} parsed from a fenced answer',
  questionnaire.status === 200 && questions.length === 10 && questionnaire.data.total_questions === 10,
  questionnaire.data,
);
check(
  'every question has the fields the dashboard reads',
  questions.every((q) => Number.isInteger(q.id) && typeof q.question === 'string' && ['boolean', 'text', 'select', 'multiselect'].includes(q.question_type) &&
    typeof q.required === 'boolean' && Array.isArray(q.grant_relevance) && (q.options === null || Array.isArray(q.options))) &&
    questions.filter((q) => q.question_type === 'select').every((q) => q.options.length > 0),
  questions,
);
const qPrompt = (await prompts('questionnaire_v1'))[0] ?? '';
check(
  'questionnaire prompt summarizes the grants (name, funder, geography)',
  qPrompt.includes('"name": "Parish Hall Roof Repair Fund"') && qPrompt.includes('"geo_qualified": "Yes - TX Only"') &&
    qPrompt.includes('EXACTLY 20 or fewer questions'),
  qPrompt.slice(0, 300),
);
const storedQ: Json = await store.kv().get(`questionnaires/${store.keyPart(userA)}`);
check('questionnaire saved per user for answer mapping', storedQ?.questions?.length === 10 && storedQ.source === 'ai', storedQ);

const submitBad = await Promise.all([
  api('POST', '/api/processing/submit-questionnaire', { token: tokenA, json: {} }),
  api('POST', '/api/processing/submit-questionnaire', { token: tokenA, json: { answers: 'yes' } }),
  api('POST', '/api/processing/submit-questionnaire', { token: tokenA, json: { answers: [{ question_id: 'abc', answer: true }] } }),
  api('POST', '/api/processing/submit-questionnaire', { token: tokenA, json: { answers: [{ question_id: 1 }] } }),
  api('POST', '/api/processing/submit-questionnaire', { token: tokenA, json: { answers: [], free_form_text: 5 } }),
]);
check(
  'submit-questionnaire validation -> 422 with readable text',
  submitBad.every((r) => r.status === 422 && typeof r.data.detail === 'string') && /question_id must be a whole number/.test(submitBad[2].data.detail) &&
    /answer is required/.test(submitBad[3].data.detail),
  submitBad.map((r) => [r.status, r.data]),
);

const submitted = await api('POST', '/api/processing/submit-questionnaire', {
  token: tokenA,
  json: {
    answers: [
      { question_id: 1, answer: true },
      { question_id: 2, answer: 'Parish with school' },
      { question_id: 3, answer: 'Texas' },
      { question_id: 4, answer: true },
      { question_id: 5, answer: '$500,000-$1M' },
      { question_id: 6, answer: 'Diocesan capital grant for HVAC (2023)' },
      { question_id: 7, answer: ['Roof', 'Playground'] },
      { question_id: '9', answer: 'true' },
      { question_id: 8, answer: false },
      { question_id: 99, answer: 'extra detail' },
    ],
    free_form_text: 'We need a new roof on the parish hall before winter.',
  },
});
check(
  'submit-questionnaire answers synchronously with the Python body',
  submitted.status === 200 && submitted.data.message === 'Questionnaire submitted successfully' && submitted.data.answers_recorded === 10,
  submitted.data,
);
const answeredProfile = await profileOf(tokenA);
const qa: Json[] = answeredProfile.questionnaire_answers ?? [];
check(
  'answers are mapped onto profile fields',
  answeredProfile.is_501c3 === true && answeredProfile.has_food_pantry === true && answeredProfile.annual_budget === '$500,000-$1M' &&
    answeredProfile.previous_grants.includes('Diocesan capital grant for HVAC (2023)') && answeredProfile.organization_type === 'both' &&
    answeredProfile.state === 'TX' && answeredProfile.free_form_notes === 'We need a new roof on the parish hall before winter.',
  answeredProfile,
);
check(
  '"security concerns at your church or school" answered No does not unset has_school (Python bug)',
  answeredProfile.has_school === true,
  answeredProfile.has_school,
);
check(
  'every answer kept verbatim with its question text (unknown ids as "Question N")',
  qa.length === 10 && qa[0].question === questions[0].question && qa[0].answer === true &&
    qa.some((p) => p.question === 'Question 99' && p.answer === 'extra detail') &&
    answeredProfile.sources.includes('Questionnaire responses') && answeredProfile.sources.includes('User free-form text'),
  qa,
);
// Resubmitting does not duplicate previous grants or sources.
await api('POST', '/api/processing/submit-questionnaire', {
  token: tokenA,
  json: { answers: [{ question_id: 6, answer: 'Diocesan capital grant for HVAC (2023)' }], free_form_text: 'We need a new roof on the parish hall before winter.' },
});
const resubmitted = await profileOf(tokenA);
check(
  'resubmitting does not duplicate previous grants or sources',
  resubmitted.previous_grants.filter((g: string) => g === 'Diocesan capital grant for HVAC (2023)').length === 1 &&
    resubmitted.sources.filter((s: string) => s === 'Questionnaire responses').length === 1,
  resubmitted,
);

// State mapping: only a real US state becomes profile.state (Python stored "True" from a yes/no question).
const tokenG = await guest();
const userG = await userIdOf(tokenG);
await api('PUT', '/api/processing/profile', { token: tokenG, json: { organization_name: 'Test Parish', organization_type: 'both', city: 'Exampleville', state: '', has_school: true } });
const qText = (id: number, question: string, questionType = 'boolean') => ({ id, question, question_type: questionType, options: null, required: true, grant_relevance: [] });
await store.kv().set(`questionnaires/${store.keyPart(userG)}`, {
  questions: [
    qText(1, 'Do you own real estate besides the church?'),
    qText(2, 'In which state is your organization located?', 'text'),
    qText(3, 'Is your school accredited?'),
    qText(4, 'Has your school received grants in the past? List them.', 'text'),
  ],
  total_questions: 4,
  created_at: new Date().toISOString(),
  source: 'ai',
});
const submitG = await api('POST', '/api/processing/submit-questionnaire', {
  token: tokenG,
  json: {
    answers: [
      { question_id: 1, answer: true },
      { question_id: 2, answer: 'Texas, USA' },
      { question_id: 3, answer: false },
      { question_id: 4, answer: 'Diocesan technology grant (2024)' },
    ],
  },
});
const profileG = await profileOf(tokenG);
check(
  'submit works without a Claude key; state comes from the state answer ("Texas, USA" -> TX), not a yes/no answer',
  submitG.status === 200 && profileG.state === 'TX',
  [submitG.data, profileG.state],
);
check('"Is your school accredited?" answered No does not unset has_school', profileG.has_school === true, profileG.has_school);
check(
  'a school question about past grants reaches previous_grants (the Python stopped at the word "school")',
  profileG.previous_grants.includes('Diocesan technology grant (2024)'),
  profileG.previous_grants,
);

// Answers are merged, never erased.
const tokenH = await guest();
const userH = await userIdOf(tokenH);
const saveQuestionsH = (list: Json[]) =>
  store.kv().set(`questionnaires/${store.keyPart(userH)}`, { questions: list, total_questions: list.length, created_at: new Date().toISOString(), source: 'ai' });
const submitH = (answers: Json[]) => api('POST', '/api/processing/submit-questionnaire', { token: tokenH, json: { answers } });
const Q_501 = 'Is your parish a registered 501(c)(3) nonprofit?';
const Q_GRANTS = 'Which grants has your organization received in the past five years?';
const Q_PANTRY = 'Does your parish operate a food pantry?';
const Q_BUDGET = 'Do you have a budget for security improvements?';
await saveQuestionsH([qText(1, Q_501, 'text'), qText(2, Q_GRANTS, 'text'), qText(3, Q_PANTRY, 'text'), qText(4, Q_BUDGET)]);
const firstH = await submitH([
  { question_id: 1, answer: 'Yes, through the USCCB group ruling' },
  { question_id: 2, answer: 'Diocesan HVAC grant (2023)' },
  { question_id: 3, answer: 'Yes, we serve 120 families each month' },
  { question_id: 4, answer: true },
]);
const afterFirstH = await profileOf(tokenH);
check(
  'a "Yes, ..." sentence counts as yes: 501(c)(3) stays true and the food pantry is set (the Python read both as "no")',
  firstH.status === 200 && firstH.data.answers_recorded === 4 && afterFirstH.is_501c3 === true && afterFirstH.has_food_pantry === true,
  [firstH.data, afterFirstH.is_501c3, afterFirstH.has_food_pantry],
);
check('a yes/no answer to a budget question is not saved as the annual budget', afterFirstH.annual_budget === null, afterFirstH.annual_budget);

// A newer questionnaire: different ids, one question reworded only in case and spacing, one new question, one blank answer.
await saveQuestionsH([qText(1, `  ${Q_GRANTS.toUpperCase()}  `, 'text'), qText(2, Q_PANTRY, 'text'), qText(3, 'How many students are enrolled in your school?', 'text')]);
const secondH = await submitH([
  { question_id: 1, answer: 'Diocesan HVAC grant (2023); parish capital campaign match (2025)' },
  { question_id: 2, answer: '   ' },
  { question_id: 3, answer: '240' },
]);
const qaH: Json[] = (await profileOf(tokenH)).questionnaire_answers;
check(
  'second submission answering a subset keeps every earlier answer in order, updates the repeated one in place, adds the new one',
  secondH.status === 200 && secondH.data.answers_recorded === 2 && qaH.length === 5 &&
    qaH[0].question === Q_501 && qaH[0].answer === 'Yes, through the USCCB group ruling' &&
    qaH[1].answer === 'Diocesan HVAC grant (2023); parish capital campaign match (2025)' &&
    qaH[2].question === Q_PANTRY && qaH[2].answer === 'Yes, we serve 120 families each month' &&
    qaH[3].question === Q_BUDGET && qaH[3].answer === true &&
    qaH[4].question === 'How many students are enrolled in your school?' && qaH[4].answer === '240',
  qaH,
);
check('a blank answer never erases or flips anything (food pantry still yes)', (await profileOf(tokenH)).has_food_pantry === true);
const thirdH = await submitH([{ question_id: 99, question: Q_501, answer: 'No' }]);
const afterThirdH = await profileOf(tokenH);
check(
  'question text sent with an answer is used (it replaces the earlier 501(c)(3) answer in place; "No" still maps to false)',
  thirdH.status === 200 && afterThirdH.questionnaire_answers.length === 5 && afterThirdH.questionnaire_answers[0].answer === 'No' &&
    afterThirdH.is_501c3 === false && !afterThirdH.questionnaire_answers.some((p: Json) => p.question === 'Question 99'),
  afterThirdH.questionnaire_answers,
);
const merged = ai.mergeQuestionnaireAnswers(
  [{ question: 'A?', answer: 1 }, { question: 'B?', answer: 2 }, { question: 'a?', answer: 'old duplicate' }, { note: 'not a Q&A pair' }],
  [{ question: ' A? ', answer: 3 }, { question: 'C?', answer: 4 }],
);
check(
  'mergeQuestionnaireAnswers: replaced in place, an older duplicate of the same question dropped, other entries kept, new ones appended',
  JSON.stringify(merged) === JSON.stringify([{ question: ' A? ', answer: 3 }, { question: 'B?', answer: 2 }, { note: 'not a Q&A pair' }, { question: 'C?', answer: 4 }]),
  merged,
);

// Fallback questionnaire for non-fatal errors only.
await mock.fail('questionnaire_v1', 529, 'overloaded_error', 3);
const qOverloaded = await call('POST', '/api/processing/generate-questionnaire', { token: tokenA });
check(
  'Claude overloaded -> the standard 8-question questionnaire (Python fallback)',
  qOverloaded.status === 200 && qOverloaded.data.total_questions === 8 &&
    qOverloaded.data.questions[0].question === 'Is your organization a registered 501(c)(3) nonprofit?',
  qOverloaded.data,
);
const storedDefault: Json = await store.kv().get(`questionnaires/${store.keyPart(userA)}`);
check('fallback questionnaire is the one saved for answer mapping', storedDefault?.source === 'default' && storedDefault.questions.length === 8, storedDefault?.source);
const savedDefault = await api('GET', '/api/processing/questionnaire', { token: tokenA });
check(
  'GET /api/processing/questionnaire returns the newest questionnaire (the standard one after a fallback), matching what answers map to',
  savedDefault.status === 200 && JSON.stringify(savedDefault.data) === JSON.stringify(qOverloaded.data),
  savedDefault.data?.total_questions,
);

await mock.fail('questionnaire_v1', 401, 'authentication_error', 1);
const qFatal = await call('POST', '/api/processing/generate-questionnaire', { token: tokenA });
check(
  'bad API key during questionnaire -> job fails with the key message, no fallback questionnaire',
  qFatal.status === 400 && /rejected your Claude API key/.test(qFatal.data.detail),
  qFatal.data,
);

await mock.fixtures({ questionnaire_v1: 'Sorry, I cannot produce that right now.' });
const qUnreadable = await call('POST', '/api/processing/generate-questionnaire', { token: tokenA });
check('unreadable answer -> standard questionnaire', qUnreadable.status === 200 && qUnreadable.data.total_questions === 8, qUnreadable.data);

const many = Array.from({ length: 25 }, (_, i) => ({
  id: i === 4 ? 3 : i === 6 ? String(i + 1) : i + 1,
  question: i === 9 ? '' : `Question number ${i + 1}?`,
  question_type: i === 0 ? 'yes_no' : i === 1 ? 'select' : i === 2 ? 'Multiple Choice' : 'text',
  options: i === 2 ? ['A', 'B'] : null,
  required: i % 2 === 0,
  grant_relevance: [],
}));
await mock.fixtures({ questionnaire_v1: JSON.stringify(many) });
const qMany = await call('POST', '/api/processing/generate-questionnaire', { token: tokenA });
const manyQs: Json[] = qMany.data?.questions ?? [];
check(
  'more than 20 questions -> capped at 20, unique integer ids, types normalized, blank questions dropped',
  qMany.status === 200 && manyQs.length === 20 && qMany.data.total_questions === 20 &&
    new Set(manyQs.map((q) => q.id)).size === 20 && manyQs.every((q) => Number.isInteger(q.id)) &&
    manyQs[0].question_type === 'boolean' && manyQs[1].question_type === 'text' && manyQs[2].question_type === 'select' &&
    !manyQs.some((q) => q.question === ''),
  manyQs.slice(0, 5),
);
await mock.reset();

// ===========================================================================
// 5. Document upload
// ===========================================================================

const tokenC = await guest();
const userC = await userIdOf(tokenC);
await saveKey(tokenC);

const badType = await upload(tokenC, 'malware.exe', 'MZ');
check('upload .exe -> 400 Python wording', badType.status === 400 && badType.data.detail === 'Invalid file type. Allowed: .pdf, .docx, .txt', badType.data);
const noExt = await upload(tokenC, 'README', 'text');
check('upload without an extension -> 400', noExt.status === 400 && noExt.data.detail === 'Invalid file type. Allowed: .pdf, .docx, .txt', noExt.data);
const tooBig = await upload(tokenC, 'big.txt', new Uint8Array(10 * 1024 * 1024 + 1).fill(97));
check('upload over 10 MB -> 413 naming the limit', tooBig.status === 413 && /too large/.test(tooBig.data.detail) && /The limit is 10 MB/.test(tooBig.data.detail), tooBig.data);
const emptyFile = await upload(tokenC, 'empty.txt', '');
check('empty file -> 400 before any job', emptyFile.status === 400 && /empty/.test(emptyFile.data.detail), emptyFile.data);
const blankFile = await upload(tokenC, 'blank.txt', '   \n \n  ');
check('whitespace-only file -> 400 "No readable text"', blankFile.status === 400 && /No readable text found in "blank.txt"/.test(blankFile.data.detail), blankFile.data);
const wrongField = await api('POST', '/api/processing/upload-document', { token: tokenC, form: fileForm('a.txt', 'hello', 'document') });
check('multipart without a "file" field -> 422', wrongField.status === 422 && /No file was uploaded/.test(wrongField.data.detail), wrongField.data);
const brokenPdf = await upload(tokenC, 'broken.pdf', 'this is not a pdf');
check('damaged PDF -> 400 with what to do', brokenPdf.status === 400 && /Couldn't read "broken.pdf" as a PDF/.test(brokenPdf.data.detail), brokenPdf.data);
const brokenDocx = await upload(tokenC, 'broken.docx', 'not a zip file');
check('fake .docx -> 400 with what to do', brokenDocx.status === 400 && /Word document/.test(brokenDocx.data.detail), brokenDocx.data);
const scannedPdf = await upload(tokenC, 'scan.pdf', makePdf([]));
check('PDF with no text layer -> 400 mentioning scanned images', scannedPdf.status === 400 && /scanned image/.test(scannedPdf.data.detail), scannedPdf.data);
check('no profile was created by rejected uploads', (await api('GET', '/api/processing/profile', { token: tokenC })).status === 404);

await mock.reset();
const bulletin = fs.readFileSync(path.join(FIXTURES, 'bulletin.txt'), 'utf8');
const txt = await uploadAndWait(tokenC, 'bulletin.txt', bulletin);
const UPLOAD_RESULT_KEYS = ['document_id', 'extracted_text_length', 'facility_needs', 'filename', 'key_facts', 'other_signals', 'program_needs', 'security_concerns'];
const KEY_FACTS = [
  'The school enrolls 240 students in grades PK-8.',
  '38% of school families receive tuition assistance in the 2025-26 school year.',
  'The parish received a $15,000 grant from the Diocese of Example in 2023 to repair the HVAC system.',
  'School enrollment grew 12% over the last two years.',
];
check(
  'txt upload -> DocumentExtractionResult with every field, including key_facts',
  txt.status === 200 && /^[0-9a-f-]{36}$/.test(txt.data.document_id) && txt.data.filename === 'bulletin.txt' &&
    txt.data.extracted_text_length === bulletin.trim().length && txt.data.facility_needs.length === 2 && txt.data.program_needs.length === 2 &&
    txt.data.security_concerns.length === 1 && txt.data.other_signals.length === 2 &&
    JSON.stringify(txt.data.key_facts) === JSON.stringify(KEY_FACTS) &&
    JSON.stringify(Object.keys(txt.data).sort()) === JSON.stringify(UPLOAD_RESULT_KEYS),
  txt.data,
);
const docPrompt = (await prompts('document_signals_v1'))[0] ?? '';
check('document prompt (document_signals_v1) has the filename and text', docPrompt.includes('DOCUMENT: bulletin.txt') && docPrompt.includes('parish hall roof leaks during heavy rain'), docPrompt.slice(0, 300));
check(
  'document prompt asks for key facts: citable, the document\'s own numbers and wording, at most 15, never invented',
  docPrompt.includes('"key_facts"') && /enrollment and demographics/.test(docPrompt) && /prior grants received \(funder, amount, and year\)/.test(docPrompt) &&
    /keeps the document's own numbers and wording/.test(docPrompt) && /at most 15/.test(docPrompt) && /Never invent/.test(docPrompt) &&
    docPrompt.includes('Return ONLY the JSON object, no other text.'),
  docPrompt.slice(-1600),
);

const docProfile = await profileOf(tokenC);
const evidence: Json[] = docProfile.evidence ?? [];
check(
  'upload with no profile yet creates the minimal profile and keeps the signals (Python dropped them)',
  docProfile.organization_type === 'parish' && docProfile.organization_name === '' && docProfile.facility_needs.length === 2 &&
    docProfile.program_needs.length === 2 && docProfile.security_concerns.length === 1 && docProfile.sources.includes('Document: bulletin.txt'),
  docProfile,
);
check(
  'every extracted item and key fact became profile evidence for the GrantWriter (7 signals + 3 new facts; the 4th fact repeats a signal)',
  evidence.length === 10 && evidence.every((e) => /^ev_[0-9a-f]{10}$/.test(e.id) && e.type === 'document' && e.source_ref === 'Document: bulletin.txt' &&
    Array.isArray(e.linked_programs) && e.linked_programs.length === 0 && typeof e.summary === 'string') &&
    evidence.some((e) => e.summary === 'School enrollment grew 12% over the last two years') && new Set(evidence.map((e) => e.id)).size === 10,
  evidence,
);
check(
  'key facts land in profile.evidence with the document\'s source_ref, de-duplicated by normalized text',
  KEY_FACTS.slice(0, 3).every((fact) => evidence.some((e) => e.summary === fact && e.source_ref === 'Document: bulletin.txt' && e.type === 'document')) &&
    evidence.filter((e) => /^school enrollment grew 12% over the last two years\.?$/i.test(e.summary)).length === 1,
  evidence.map((e) => e.summary),
);
// services/writer.ts builds the Map (fit_gap_v1) and Draft (section_draft_v1) prompts from profileSlice(profile).
const sliceForWriter = typeof writer.profileSlice === 'function' ? JSON.stringify(writer.profileSlice(docProfile)) : '(writer.profileSlice not found)';
check(
  'the writer\'s profile slice (Map and Draft prompts) carries the key facts and their source',
  KEY_FACTS.slice(0, 3).every((fact) => sliceForWriter.includes(JSON.stringify(fact))) && sliceForWriter.includes('Document: bulletin.txt'),
  sliceForWriter.slice(0, 300),
);
const txtJob = await storedJob(userC, txt.jobId);
check(
  'finished document job keeps the file name but not the document text (and never the API key)',
  txtJob?.kind === 'processing.upload_document' && txtJob.input.filename === 'bulletin.txt' &&
    /characters, not kept/.test(String(txtJob.input.text)) && !String(txtJob.input.text).includes('roof') &&
    !JSON.stringify(txtJob.input).includes('sk-ant-'),
  txtJob?.input,
);

const again = await uploadAndWait(tokenC, 'bulletin.txt', bulletin);
const againProfile = await profileOf(tokenC);
check(
  'uploading the same document twice does not duplicate needs, evidence (key facts included), or sources',
  again.status === 200 && JSON.stringify(again.data.key_facts) === JSON.stringify(KEY_FACTS) && againProfile.facility_needs.length === 2 &&
    againProfile.program_needs.length === 2 && againProfile.security_concerns.length === 1 && againProfile.evidence.length === 10 &&
    KEY_FACTS.slice(0, 3).every((fact) => againProfile.evidence.filter((e: Json) => e.summary === fact).length === 1) &&
    againProfile.sources.filter((s: string) => s === 'Document: bulletin.txt').length === 1,
  againProfile,
);

await mock.reset();
const docx = await uploadAndWait(tokenC, 'parish-report.docx', await makeDocx(['Annual report: the boiler is 40 years old.', 'We plan to add an after-school robotics club.']));
const docxPrompt = (await prompts('document_signals_v1'))[0] ?? '';
check(
  '.docx upload: text extracted (mammoth) and sent to Claude',
  docx.status === 200 && docx.data.filename === 'parish-report.docx' && docxPrompt.includes('the boiler is 40 years old') && docxPrompt.includes('robotics club'),
  [docx.data, docxPrompt.slice(0, 200)],
);
check('.docx source recorded', (await profileOf(tokenC)).sources.includes('Document: parish-report.docx'));

await mock.reset();
await mock.fixtures({
  document_signals_v1: 'Here is what I found:\n```json\n{"facility_needs": ["Gym roof leaks over the stage"], "program_needs": [], "security_concerns": [], "other_signals": ["Finance council approved a 10% local match"]}\n```',
});
const pdf = await uploadAndWait(tokenC, 'minutes.pdf', makePdf(['Parish Finance Council minutes', 'The gym roof leaks over the stage.']));
const pdfPrompt = (await prompts('document_signals_v1'))[0] ?? '';
const pdfProfile = await profileOf(tokenC);
check(
  '.pdf upload: text extracted and new signals added to needs and evidence',
  pdf.status === 200 && pdfPrompt.includes('The gym roof leaks over the stage.') && pdfProfile.facility_needs.length === 3 &&
    pdfProfile.evidence.length === 12 && pdfProfile.evidence.some((e: Json) => e.summary === 'Finance council approved a 10% local match' && e.source_ref === 'Document: minutes.pdf'),
  [pdf.data, pdfProfile.evidence.length],
);
check(
  'an answer without key_facts (the old format) works as before: same result shape with key_facts: []',
  Array.isArray(pdf.data.key_facts) && pdf.data.key_facts.length === 0 && JSON.stringify(Object.keys(pdf.data).sort()) === JSON.stringify(UPLOAD_RESULT_KEYS),
  pdf.data,
);
await mock.reset();

const mediumText = `START_MARKER ${'Parish hall roof repairs are needed. '.repeat(1200)} END_OF_MEDIUM_MARKER`;
const mediumDoc = await uploadAndWait(tokenC, 'medium.txt', mediumText);
const mediumPrompt = (await prompts('document_signals_v1'))[0] ?? '';
const mediumJob = await storedJob(userC, mediumDoc.jobId);
check(
  'a 44,000-character document is sent whole (the Python cut it at 30,000), with no "cut" note',
  mediumDoc.status === 200 && mediumText.length > 40000 && mediumPrompt.includes('END_OF_MEDIUM_MARKER') &&
    !(mediumJob?.notes ?? []).some((n: string) => /Read the first/.test(n)),
  [mediumText.length, mediumJob?.notes],
);
await mock.reset();

const longText = `START_MARKER ${'Parish hall roof repairs are needed. '.repeat(1700)} MARKER_BEYOND_LIMIT`;
const longDoc = await uploadAndWait(tokenC, 'long.txt', longText);
const longPrompt = (await prompts('document_signals_v1'))[0] ?? '';
const longJob = await storedJob(userC, longDoc.jobId);
check(
  'long document: full length reported, only the first 60,000 characters sent',
  longDoc.status === 200 && longDoc.data.extracted_text_length === longText.length && longText.length > ai.DOCUMENT_TEXT_LIMIT &&
    ai.DOCUMENT_TEXT_LIMIT === 60000 && longPrompt.includes('START_MARKER') && !longPrompt.includes('MARKER_BEYOND_LIMIT'),
  longDoc.data,
);
check(
  'a cut document gets a job note saying how much was read',
  (longJob?.notes ?? []).some((n: string) => n.includes(`Read the first 60,000 of ${longText.length.toLocaleString('en-US')} characters of "long.txt"`)),
  longJob?.notes,
);
check(
  'cutting text never leaves half an emoji (the Claude API rejects that as invalid JSON)',
  ai.cutText('ab\u{1F64F}cd', 3) === 'ab' && ai.cutText('ab\u{1F64F}cd', 4) === 'ab\u{1F64F}' && ai.wellFormed('x\uD83Dy') === 'x\uFFFDy' &&
    ai.buildDocumentPrompt('Roof \uD83D', 'a.txt').includes('Roof \uFFFD'),
  ai.cutText('ab\u{1F64F}cd', 3),
);

const evidenceBefore = (await profileOf(tokenC)).evidence.length;
await mock.fail('document_signals_v1', 401, 'authentication_error', 1);
const docFatal = await uploadAndWait(tokenC, 'other.txt', 'The sanctuary carpet is worn through.');
check('bad API key during document job -> job fails with the key message', docFatal.status === 400 && /rejected your Claude API key/.test(docFatal.data.detail), docFatal.data);
await mock.fail('document_signals_v1', 529, 'overloaded_error', 3);
const docBusy = await uploadAndWait(tokenC, 'other.txt', 'The sanctuary carpet is worn through.');
check(
  'Claude overloaded during document job -> clear retry message (not "0 items found")',
  docBusy.status === 503 && docBusy.data.detail === 'Document processing failed: Claude is overloaded right now. Wait a minute and try again.',
  docBusy.data,
);
await mock.reset();
await mock.fixtures({ document_signals_v1: { text: '{"facility_needs": ["Gym roof', stop_reason: 'max_tokens' } });
const docCutOff = await uploadAndWait(tokenC, 'other.txt', 'The sanctuary carpet is worn through.');
await mock.fixtures({ document_signals_v1: 'I am sorry, but I cannot help with that document.' });
const docUnreadable = await uploadAndWait(tokenC, 'other.txt', 'The sanctuary carpet is worn through.');
check(
  'an answer cut off at max_tokens says so and what to do (uploading the same file again would fail the same way); other unreadable answers keep the old message',
  docCutOff.status === 502 && /"other\.txt" was cut off before it finished\. Upload a shorter version/.test(docCutOff.data.detail) &&
    docUnreadable.status === 502 &&
    docUnreadable.data.detail === 'Document processing failed: Claude\'s answer about "other.txt" couldn\'t be read. Upload the document again.',
  [docCutOff.data, docUnreadable.data],
);
check('failed document jobs changed nothing', (await profileOf(tokenC)).evidence.length === evidenceBefore);
await mock.reset();

// Evidence stays at a sensible cap: the oldest document items go first, never the person's own items.
const tokenK = await guest();
const userK = await userIdOf(tokenK);
await saveKey(tokenK);
const ownItems = Array.from({ length: 5 }, (_, i) => ({ id: `ev_own_${i}`, type: i % 2 ? 'stakeholder_answer' : 'note', summary: `Own item ${i}`, source_ref: 'Principal', linked_programs: [] }));
const oldDocItems = Array.from({ length: 190 }, (_, i) => ({ id: `ev_old_${i}`, type: 'document', summary: `Old document fact ${i}`, source_ref: 'Document: old-report.pdf', linked_programs: [] }));
await repo.saveProfile(userK, { ...ai.minimalProfile(userK), evidence: [ownItems[0], ...oldDocItems.slice(0, 100), ...ownItems.slice(1), ...oldDocItems.slice(100)] } as Json);
const manyFacts = Array.from({ length: 17 }, (_, i) => `Fact number ${i + 1} from the annual report.`);
await mock.fixtures({
  document_signals_v1: JSON.stringify({ facility_needs: [], program_needs: [], security_concerns: [], other_signals: [], key_facts: manyFacts }),
});
const capped = await uploadAndWait(tokenK, 'annual-report.txt', 'Annual report text for the cap test.');
const cappedProfile = await profileOf(tokenK);
const cappedJob = await storedJob(userK, capped.jobId);
const cappedIds = new Set(cappedProfile.evidence.map((e: Json) => e.id));
check(
  'at most 15 key facts per document are kept (and returned)',
  capped.status === 200 && JSON.stringify(capped.data.key_facts) === JSON.stringify(manyFacts.slice(0, 15)),
  capped.data?.key_facts?.length,
);
check(
  'evidence capped at 200: the 10 oldest document items were dropped; the person\'s own items and the new facts were kept',
  cappedProfile.evidence.length === ai.MAX_PROFILE_EVIDENCE && ai.MAX_PROFILE_EVIDENCE === 200 &&
    ownItems.every((item) => cappedIds.has(item.id)) && oldDocItems.slice(0, 10).every((item) => !cappedIds.has(item.id)) &&
    oldDocItems.slice(10).every((item) => cappedIds.has(item.id)) &&
    manyFacts.slice(0, 15).every((fact) => cappedProfile.evidence.some((e: Json) => e.summary === fact && e.source_ref === 'Document: annual-report.txt')) &&
    (cappedJob?.notes ?? []).some((n: string) => /removed the 10 oldest item\(s\) that came from documents/.test(n)),
  [cappedProfile.evidence.length, cappedJob?.notes],
);
await mock.reset();

const odd = ai.parseDocumentSignals(JSON.stringify({
  facility_needs: ['List of specific facility needs mentioned', 'Roof leaks'],
  other_signals: 'None',
  key_facts: [
    { fact: 'Founded in 1952.' },
    '- 38% of families receive tuition assistance.',
    '38% of families receive tuition assistance',
    'Concrete facts stated in the document, one short sentence each',
    '',
    'N/A',
    42,
  ],
}));
check(
  'key facts parse leniently: {"fact": ...} objects read, bullets stripped, duplicates, blanks and template echoes dropped',
  JSON.stringify(odd) === JSON.stringify({
    facility_needs: ['Roof leaks'],
    program_needs: [],
    security_concerns: [],
    other_signals: [],
    key_facts: ['Founded in 1952.', '38% of families receive tuition assistance.'],
  }),
  odd,
);

// ===========================================================================
// 6. Matching prerequisites
// ===========================================================================

const tokenD = await guest();
const userD = await userIdOf(tokenD);
await saveKey(tokenD);
const matchNoGrants = await api('POST', '/api/processing/match-grants', { token: tokenD });
check(
  'match with no grants -> 400 Python wording',
  matchNoGrants.status === 400 && matchNoGrants.data.detail === 'No grants in database. Upload a grant database or run discovery first.',
  matchNoGrants.data,
);
await repo.saveGrants(userD, testGrants(userD) as Json);
const matchNoProfile = await api('POST', '/api/processing/match-grants', { token: tokenD });
check(
  'match with grants but no profile -> 400 Python wording',
  matchNoProfile.status === 400 && matchNoProfile.data.detail === 'No organization profile. Please complete the setup process.',
  matchNoProfile.data,
);

const latestNone = await api('GET', '/api/processing/match-results/latest', { token: tokenA });
check('latest match results before any run -> 404', latestNone.status === 404 && latestNone.data.detail === NO_MATCH_RESULTS, latestNone.data);

// The follow-up part of matching (direct job mode) checks its input at once.
const continueChecks = await Promise.all([
  api('POST', '/api/processing/match-grants/continue', { token: tokenA, json: {} }),
  api('POST', '/api/processing/match-grants/continue', { token: tokenA, json: { session_id: '../profiles/x' } }),
  api('POST', '/api/processing/match-grants/continue', { token: tokenA, json: { session_id: 'match_20261014T000000000Z_00000000', part: 2 } }),
]);
check(
  'match-grants/continue: a missing or malformed session id -> 422; unknown results -> 404 (no job started)',
  continueChecks[0].status === 422 && /session_id/.test(continueChecks[0].data.detail) && continueChecks[1].status === 422 &&
    continueChecks[2].status === 404 && continueChecks[2].data.detail === 'Session not found' && continueChecks.every((r) => !r.data?.job_id),
  continueChecks.map((r) => [r.status, r.data]),
);

// ===========================================================================
// 7. Matching (profile in TX)
// ===========================================================================

await mock.reset();
const matchStart = await api('POST', '/api/processing/match-grants', { token: tokenA });
check(
  'match-grants answers 202 {job_id, status, kind} at once',
  matchStart.status === 202 && matchStart.data.kind === 'processing.match_grants' && /^job_/.test(matchStart.data.job_id) && matchStart.data.status === 'queued',
  matchStart.data,
);
const matchPolled = await waitForJob(tokenA, matchStart.data.job_id);
check('polling GET /api/jobs/{id} ends "done" with the results', matchPolled.status === 'done' && matchPolled.error === null && matchPolled.result?.session_id, matchPolled.status);
const match = { status: matchPolled.status === 'done' ? 200 : 500, data: matchPolled.result, jobId: matchStart.data.job_id as string };
const results: Json = match.data;
check(
  'match results shape and tier counts (15 grants incl. 1 foundation)',
  match.status === 200 && /^match_/.test(results.session_id) && results.user_id === userA && results.profile_id === userA &&
    results.total_grants_evaluated === 15 && results.matches.length === 15 && results.excellent_matches === 3 && results.good_matches === 3 &&
    results.possible_matches === 4 && results.weak_matches === 1 && results.not_eligible === 4,
  { ...results, matches: results?.matches?.map((m: Json) => [m.grant_id, m.score]) },
);
check(
  'matches sorted by score, every field the dashboard and export read present',
  results.matches.every((m: Json, i: number) => i === 0 || results.matches[i - 1].score >= m.score) &&
    results.matches.every((m: Json) =>
      typeof m.grant_id === 'string' && typeof m.grant_name === 'string' && typeof m.funder === 'string' && typeof m.amount === 'string' &&
      typeof m.deadline === 'string' && typeof m.url === 'string' && typeof m.contact === 'string' && typeof m.category === 'string' &&
      typeof m.geo_qualified === 'string' && Number.isInteger(m.score) && ['excellent', 'good', 'possible', 'weak', 'not_eligible'].includes(m.score_tier) &&
      typeof m.explanation === 'string' && Array.isArray(m.evidence) && m.is_shortlisted === false &&
      ['eligibility_fit', 'need_alignment', 'capacity_signals', 'timing', 'completeness'].every((k) => typeof m.score_breakdown?.[k] === 'number')),
  results.matches[0],
);
check(
  '90-day expiry',
  Math.round((Date.parse(results.expires_at) - Date.parse(results.created_at)) / 86400000) === 90,
  [results.created_at, results.expires_at],
);
check(
  'hard filters: CLOSED, deadline passed, geography "No" -> 0 / not eligible with the Python reasons',
  byId(results, 'grant_pt_04').score === 0 && byId(results, 'grant_pt_04').explanation === 'This grant is marked CLOSED in the database.' &&
    byId(results, 'grant_pt_05').explanation === "Deadline passed (2020-01-15). Check the funder's website for the next cycle." &&
    byId(results, 'grant_pt_06').explanation === "This grant's geographic restriction excludes your organization per the grant database." &&
    byId(results, 'grant_pt_06').score_tier === 'not_eligible' && byId(results, 'grant_pt_06').score_breakdown.completeness === 100,
  [byId(results, 'grant_pt_04'), byId(results, 'grant_pt_05')],
);
check(
  'Texas-only grant is scored for a Texas parish; "Annual: October 15" is not treated as expired',
  byId(results, 'grant_pt_03').score === 88 && byId(results, 'grant_pt_03').score_tier === 'excellent' && byId(results, 'grant_pt_07').score === 61,
  [byId(results, 'grant_pt_03'), byId(results, 'grant_pt_07')],
);
check(
  'AI scores parsed: "78%" -> 78, 105 -> 100, missing score -> weighted breakdown (78), name in grant_id matched, first duplicate wins',
  byId(results, 'grant_pt_02').score === 78 && byId(results, 'grant_pt_02').score_tier === 'good' && byId(results, 'grant_pt_10').score === 100 &&
    byId(results, 'grant_pt_11').score === 78 && byId(results, 'grant_pt_12').score === 55 && byId(results, 'grant_pt_14').score === 70 &&
    byId(results, 'grant_pt_01').score === 92 && byId(results, 'grant_pt_01').evidence[0] === 'Capital campaign to replace the parish hall roof' &&
    byId(results, 'grant_pt_09').score_tier === 'not_eligible' && byId(results, 'grant_pt_08').score_tier === 'weak',
  results.matches.map((m: Json) => [m.grant_id, m.score, m.score_tier]),
);
check(
  'coverage guarantee: a grant the answer skipped is listed and says plainly it was not AI-scored',
  byId(results, 'grant_pt_13')?.score === 50 && byId(results, 'grant_pt_13').explanation === "Not AI-scored: Claude's answer skipped this grant. Re-run matching for a real score.",
  byId(results, 'grant_pt_13'),
);
const fdn = results.matches.find((m: Json) => m.grant_name === 'Example Catholic Foundation (Foundation)');
check(
  'Category 5 foundation joins matching as a "(Foundation)" grant with a stable id',
  fdn && fdn.category === 'foundations' && fdn.score === 64 && /^grant_[0-9a-f]{12}$/.test(fdn.grant_id) && fdn.deadline === 'Annual: March 1' && fdn.amount === '$2M',
  fdn,
);
const resolvedFoundation = fdn ? await ai.getGrantOrFoundation(userA, fdn.grant_id) : null;
const resolvedGrant = await ai.getGrantOrFoundation(userA, 'grant_pt_01');
check(
  'getGrantOrFoundation resolves foundation matches (for the writer) and plain grants; unknown ids -> null',
  resolvedFoundation?.grant_name === 'Example Catholic Foundation (Foundation)' && resolvedFoundation.category === 'foundations' &&
    resolvedGrant?.grant_name === 'Parish Hall Roof Repair Fund' && (await ai.getGrantOrFoundation(userA, 'grant_000000000000')) === null,
  [resolvedFoundation?.grant_name, resolvedGrant?.grant_name],
);
const matchPrompts = await prompts('grant_match_batch_v1');
check(
  'grants scored in batches of 10 (2 calls for 12 grants); filtered grants never sent to Claude',
  matchPrompts.length === 2 && matchPrompts.every((p) => p.includes("TODAY'S DATE: ") && p.includes('ORGANIZATION PROFILE:')) &&
    matchPrompts.some((p) => p.includes('"id": "grant_pt_01"')) && !matchPrompts.some((p) => p.includes('grant_pt_04') || p.includes('grant_pt_05') || p.includes('grant_pt_06')),
  matchPrompts.map((p) => p.length),
);
const matchJob = await storedJob(userA, match.jobId);
check('match job notes record the filter counts', (matchJob?.notes ?? []).some((n: string) => n.includes('3 ruled out by hard filters, 12 sent to Claude')), matchJob?.notes);

const fetched = await api('GET', `/api/processing/match-results/${results.session_id}`, { token: tokenA });
check('GET match-results/{session_id} returns the saved results', fetched.status === 200 && fetched.data.session_id === results.session_id && fetched.data.matches.length === 15, fetched.data?.session_id);
const latest = await api('GET', '/api/processing/match-results/latest', { token: tokenA });
check('GET match-results/latest returns the newest results', latest.status === 200 && latest.data.session_id === results.session_id, latest.data?.session_id);

// Each match read back carries its deadline worked out for today (computed on read, never stored).
{
  const today = deadlines.todayIso();
  const dayCount = (iso: string) => {
    const [y1, m1, d1] = today.split('-').map(Number);
    const [y2, m2, d2] = iso.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  };
  const year = Number(today.slice(0, 4));
  const nextOct15 = `${year}-10-15` >= today ? `${year}-10-15` : `${year + 1}-10-15`;
  const fields = (m: Json) => (m ? [m.next_deadline, m.days_left, m.deadline_passed] : null);
  for (const [label, read] of [['latest', latest.data], ['by session', fetched.data]] as const) {
    const annual = byId(read, 'grant_pt_07');
    const pastFixed = byId(read, 'grant_pt_05');
    const futureFixed = byId(read, 'grant_pt_01');
    const rolling = byId(read, 'grant_pt_02');
    check(
      `match results (${label}): "Annual: October 15" -> the next October 15, days left, not passed`,
      annual?.deadline === 'Annual: October 15' && annual.next_deadline === nextOct15 && annual.days_left === dayCount(nextOct15) &&
        annual.days_left >= 0 && annual.deadline_passed === false,
      fields(annual),
    );
    check(
      `match results (${label}): a fixed date in the past -> that date, negative days, passed; a future date -> not passed`,
      pastFixed?.next_deadline === '2020-01-15' && pastFixed.days_left === dayCount('2020-01-15') && pastFixed.days_left < 0 && pastFixed.deadline_passed === true &&
        futureFixed?.next_deadline === OPEN_DEADLINE && futureFixed.days_left === dayCount(OPEN_DEADLINE) && futureFixed.days_left === 180 && futureFixed.deadline_passed === false,
      [fields(pastFixed), fields(futureFixed)],
    );
    check(
      `match results (${label}): "Rolling" -> no date, no days left, not passed; every match has the three fields`,
      rolling?.next_deadline === null && rolling.days_left === null && rolling.deadline_passed === false &&
        read.matches.every((m: Json) => 'next_deadline' in m && 'days_left' in m && typeof m.deadline_passed === 'boolean'),
      fields(rolling),
    );
  }
  const stored: Json = await repo.getMatchResults(userA, results.session_id);
  check(
    'deadline fields are computed when read, never stored',
    stored && stored.matches.length === 15 && stored.matches.every((m: Json) => !('next_deadline' in m) && !('days_left' in m) && !('deadline_passed' in m)),
    stored?.matches?.[0],
  );
}
const unknownSession = await api('GET', '/api/processing/match-results/match_nope', { token: tokenA });
check('unknown session -> 404 Session not found', unknownSession.status === 404 && unknownSession.data.detail === 'Session not found', unknownSession.data);
const otherUser = await api('GET', `/api/processing/match-results/${results.session_id}`, { token: tokenD });
check("another user's session -> 404", otherUser.status === 404, otherUser.data);

// ===========================================================================
// 8. Matching outside Texas, injected answers, failures
// ===========================================================================

const current = await profileOf(tokenA);
const toLouisiana = await api('PUT', '/api/processing/profile', { token: tokenA, json: { ...current, state: 'Louisiana' } });
check('a full profile from GET round-trips through PUT', toLouisiana.status === 200 && toLouisiana.data.state === 'Louisiana' && toLouisiana.data.evidence.length === current.evidence.length, toLouisiana.data);
await mock.reset();
const laMatch = await call('POST', '/api/processing/match-grants', { token: tokenA });
check(
  'Texas-only grant for a Louisiana parish -> not eligible with the Python reason, no AI call for it',
  laMatch.status === 200 && byId(laMatch.data, 'grant_pt_03').score === 0 &&
    byId(laMatch.data, 'grant_pt_03').explanation === 'Geographic restriction: this grant is limited to Texas organizations, and your organization is in Louisiana.' &&
    laMatch.data.not_eligible === 5 && !(await prompts('grant_match_batch_v1')).some((p) => p.includes('grant_pt_03')),
  byId(laMatch.data, 'grant_pt_03'),
);
const latest2 = await api('GET', '/api/processing/match-results/latest', { token: tokenA });
check('latest now points at the newer run', latest2.data?.session_id === laMatch.data.session_id && laMatch.data.session_id !== results.session_id, latest2.data?.session_id);

// Fixture injected at runtime with whatever ids the grants have.
const tokenE = await guest();
const userE = await userIdOf(tokenE);
await saveKey(tokenE);
const randomGrants = ['A', 'B', 'C'].map((letter) => grant(userE, crypto.randomUUID(), `Random Id Grant ${letter}`));
await repo.saveGrants(userE, randomGrants as Json);
await api('PUT', '/api/processing/profile', { token: tokenE, json: { organization_name: 'Test Parish', organization_type: 'parish', city: 'Exampleville', state: 'TX' } });
await mock.fixtures({
  grant_match_batch_v1: JSON.stringify(randomGrants.map((g, index) => ({
    grant_id: g.id,
    score: [91, 73, 40][index],
    score_breakdown: { eligibility_fit: 90, need_alignment: 80, capacity_signals: 70, timing: 60, completeness: 50 },
    explanation: `Injected score for ${g.grant_name}`,
    evidence: ['Injected evidence'],
  }))),
});
const injected = await call('POST', '/api/processing/match-grants', { token: tokenE });
check(
  'runtime-injected answer with random grant ids is matched by id',
  injected.status === 200 && byId(injected.data, randomGrants[0].id).score === 91 && byId(injected.data, randomGrants[1].id).score_tier === 'good' &&
    byId(injected.data, randomGrants[2].id).score_tier === 'weak' && injected.data.excellent_matches === 1,
  injected.data?.matches?.map((m: Json) => [m.grant_name, m.score]),
);
await mock.reset();

const beforeFailures = (await api('GET', '/api/processing/match-results/latest', { token: tokenA })).data.session_id;
// Overloaded for the whole run: the first pass and the one retry pass both fail.
await mock.fail('grant_match_batch_v1', 529, 'overloaded_error', 100);
const busy = await call('POST', '/api/processing/match-grants', { token: tokenA });
const unscored = busy.data?.matches?.filter((m: Json) => m.score_tier !== 'not_eligible') ?? [];
check(
  'Claude overloaded during matching -> job still finishes; every unscored grant says so plainly',
  busy.status === 200 && unscored.length === 11 &&
    unscored.every((m: Json) => m.explanation === 'Not AI-scored: Claude was unavailable (overloaded). Re-run matching for a real score.' &&
      m.score === 50 && m.score_tier === 'possible' && m.evidence.length === 0) &&
    busy.data.not_eligible === 4 && byId(busy.data, 'grant_pt_04').explanation === 'This grant is marked CLOSED in the database.',
  busy.data?.matches?.slice(0, 2),
);
await mock.reset();

// A passing overload: both batches fail all 3 client attempts (6 calls), then
// the one-batch-at-a-time retry pass scores them for real.
await mock.fail('grant_match_batch_v1', 529, 'overloaded_error', 6);
const recovered = await call('POST', '/api/processing/match-grants', { token: tokenA });
const stillUnscored = (recovered.data?.matches ?? []).filter((m: Json) => String(m.explanation).startsWith('Not AI-scored: Claude was unavailable'));
const retryReport = (await api('GET', '/api/debug/report', { token: tokenA })).text;
check(
  'a passing overload during matching is retried: every grant gets a real score, and the debug report says so',
  recovered.status === 200 && stillUnscored.length === 0 && /Retrying batch \d+ once after a temporary Claude problem/.test(retryReport),
  [stillUnscored.length, retryReport.slice(0, 300)],
);
await mock.reset();

const beforeFatal = (await api('GET', '/api/processing/match-results/latest', { token: tokenA })).data.session_id;
await mock.fail('grant_match_batch_v1', 401, 'authentication_error', 5);
const fatal = await call('POST', '/api/processing/match-grants', { token: tokenA });
const afterFatal = (await api('GET', '/api/processing/match-results/latest', { token: tokenA })).data.session_id;
check(
  'bad API key during matching -> job fails with the key message; no fallback results saved',
  fatal.status === 400 && /rejected your Claude API key/.test(fatal.data.detail) && afterFatal === beforeFatal && beforeFatal !== beforeFailures,
  [fatal.data, beforeFatal, afterFatal],
);
await mock.reset();

await mock.fixtures({
  grant_match_batch_v1: {
    text: '[\n  {"grant_id": "grant_pt_01", "score": 90, "score_breakdown": {"eligibility_fit": 90, "need_alignment": 90, "capacity_signals": 90, "timing": 90, "completeness": 90}, "explanation": "Roof fits.", "evidence": ["Roof"]},\n  {"grant_id": "grant_pt_02", "score": 7',
    stop_reason: 'max_tokens',
  },
});
const truncated = await call('POST', '/api/processing/match-grants', { token: tokenA });
check(
  'answer cut off at max_tokens -> complete items still used, the rest honestly marked',
  truncated.status === 200 && byId(truncated.data, 'grant_pt_01').score === 90 &&
    byId(truncated.data, 'grant_pt_02').explanation.startsWith('Not AI-scored:'),
  [byId(truncated.data, 'grant_pt_01'), byId(truncated.data, 'grant_pt_02')],
);
await mock.fixtures({ grant_match_batch_v1: 'I am sorry, but I cannot score these grants.' });
const unreadable = await call('POST', '/api/processing/match-grants', { token: tokenA });
check(
  'unreadable answer -> grants marked "Not AI-scored: Claude\'s answer could not be read"',
  unreadable.status === 200 &&
    unreadable.data.matches.filter((m: Json) => m.score_tier !== 'not_eligible').every((m: Json) => m.explanation === "Not AI-scored: Claude's answer could not be read. Re-run matching for a real score."),
  unreadable.data?.matches?.[0],
);
await mock.reset();

// ===========================================================================
// 9. Shortlist
// ===========================================================================

const sessionId = results.session_id;
const add = await api('POST', `/api/processing/shortlist/grant_pt_01?session_id=${sessionId}`, { token: tokenA });
const afterAdd = await api('GET', `/api/processing/match-results/${sessionId}`, { token: tokenA });
check(
  'shortlist a grant in a session -> {grant_id, shortlisted} and it is saved',
  add.status === 200 && add.data.grant_id === 'grant_pt_01' && add.data.shortlisted === true &&
    byId(afterAdd.data, 'grant_pt_01').is_shortlisted === true && byId(afterAdd.data, 'grant_pt_02').is_shortlisted === false,
  [add.data, byId(afterAdd.data, 'grant_pt_01')],
);
const remove = await api('POST', `/api/processing/shortlist/grant_pt_01?session_id=${sessionId}&shortlist=false`, { token: tokenA });
const afterRemove = await api('GET', `/api/processing/match-results/${sessionId}`, { token: tokenA });
check('shortlist=false removes it', remove.status === 200 && remove.data.shortlisted === false && byId(afterRemove.data, 'grant_pt_01').is_shortlisted === false, remove.data);
const toLatest = await api('POST', '/api/processing/shortlist/grant_pt_02', { token: tokenA });
const latestAfter = await api('GET', '/api/processing/match-results/latest', { token: tokenA });
check(
  'shortlist without a session id applies to the newest results',
  toLatest.status === 200 && toLatest.data.shortlisted === true && byId(latestAfter.data, 'grant_pt_02').is_shortlisted === true,
  toLatest.data,
);
const badGrant = await api('POST', `/api/processing/shortlist/grant_nope?session_id=${sessionId}`, { token: tokenA });
const badSession = await api('POST', '/api/processing/shortlist/grant_pt_01?session_id=match_nope', { token: tokenA });
const badFlag = await api('POST', `/api/processing/shortlist/grant_pt_01?session_id=${sessionId}&shortlist=maybe`, { token: tokenA });
const noResults = await api('POST', '/api/processing/shortlist/grant_pt_01', { token: tokenC });
check(
  'shortlist errors: unknown grant 404, unknown session 404, bad flag 422, no results yet 404',
  badGrant.status === 404 && badGrant.data.detail === 'Grant not found in these match results' &&
    badSession.status === 404 && badSession.data.detail === 'Session not found' && badFlag.status === 422 &&
    noResults.status === 404 && noResults.data.detail === NO_MATCH_RESULTS,
  [badGrant.data, badSession.data, badFlag.data, noResults.data],
);

// ===========================================================================
// 10. Profile endpoints
// ===========================================================================

const tokenF = await guest();
const userF = await userIdOf(tokenF);
const missingFields = await api('PUT', '/api/processing/profile', { token: tokenF, json: { organization_name: 'X' } });
check(
  'PUT profile missing required fields -> 422 naming them',
  missingFields.status === 422 && missingFields.data.detail === 'Profile not saved: missing required fields: organization_type, city, state.',
  missingFields.data,
);
const badTypes = await api('PUT', '/api/processing/profile', {
  token: tokenF,
  json: { organization_name: 'X', organization_type: 'parish', city: 'Y', state: 'TX', student_count: 'lots', has_school: 'maybe', facility_needs: [{ a: 1 }], evidence: 'text' },
});
check(
  'PUT profile with wrong types -> 422 listing each problem',
  badTypes.status === 422 && /student_count must be a whole number/.test(badTypes.data.detail) && /has_school must be true or false/.test(badTypes.data.detail) &&
    /facility_needs must be a list of text/.test(badTypes.data.detail) && /evidence must be a list of objects/.test(badTypes.data.detail),
  badTypes.data,
);
check('rejected PUT saved nothing', (await api('GET', '/api/processing/profile', { token: tokenF })).status === 404);

const hand = await api('PUT', '/api/processing/profile', {
  token: tokenF,
  json: { organization_name: 'St. Example Parish', organization_type: 'parish', city: 'Exampleville', state: 'TX', student_count: '240', has_school: 'yes', facility_needs: 'Roof replacement\nNew HVAC\n' },
});
check(
  'hand-entered basics (no lists) -> 200 with every list defaulted',
  hand.status === 200 && hand.data.user_id === userF && hand.data.organization_name === 'St. Example Parish' && hand.data.student_count === 240 &&
    hand.data.has_school === true && JSON.stringify(hand.data.facility_needs) === JSON.stringify(['Roof replacement', 'New HVAC']) &&
    Array.isArray(hand.data.program_needs) && hand.data.program_needs.length === 0 && Array.isArray(hand.data.evidence) &&
    hand.data.is_501c3 === true && typeof hand.data.last_updated === 'string',
  hand.data,
);
check('GET /api/processing/profile shows the hand-entered profile', (await profileOf(tokenF)).organization_name === 'St. Example Parish');

await api('PUT', '/api/processing/profile', {
  token: tokenF,
  json: {
    organization_name: 'St. Example Parish', organization_type: 'parish', city: 'Exampleville', state: 'TX',
    evidence: [{ id: 'ev_manual', type: 'note', summary: 'Roof leaks', source_ref: 'Pastor', linked_programs: [] }],
    voice_profile: { style_guidelines: 'Warm and plain' },
    sources: ['Website scan: https://example.org'],
  },
});
const basicsOnly = await api('PUT', '/api/processing/profile', { token: tokenF, json: { organization_name: 'St. Example Parish', organization_type: 'both', city: 'Newtown', state: 'TX' } });
check(
  'PUT with only the basics keeps evidence, voice profile, and sources saved earlier',
  basicsOnly.status === 200 && basicsOnly.data.city === 'Newtown' && basicsOnly.data.organization_type === 'both' && basicsOnly.data.evidence.length === 1 &&
    basicsOnly.data.voice_profile?.style_guidelines === 'Warm and plain' && basicsOnly.data.sources[0] === 'Website scan: https://example.org' &&
    basicsOnly.data.facility_needs.length === 2,
  basicsOnly.data,
);

const edit1 = await api('PUT', '/api/profile', { token: tokenF, json: { organization_name: 'St. Example Parish', organization_type: 'both', city: 'Newtown', state: 'TX', sources: [] } });
const edit2 = await api('PUT', '/api/profile', { token: tokenF, json: { organization_name: 'St. Example Parish', organization_type: 'both', city: 'Newtown', state: 'TX' } });
check(
  'PUT /api/profile keeps AI sources when none are sent and notes "User edit" once',
  edit1.status === 200 && edit2.status === 200 &&
    JSON.stringify(edit2.data.sources) === JSON.stringify(['Website scan: https://example.org', 'User edit']),
  edit2.data.sources,
);
const editBad = await api('PUT', '/api/profile', { token: tokenF, json: { city: 'Nowhere' } });
check('PUT /api/profile validates like the processing PUT', editBad.status === 422 && /missing required fields/.test(editBad.data.detail), editBad.data);

const reset = await api('POST', '/api/profile/reset', { token: tokenF });
const afterReset = await api('GET', '/api/processing/profile', { token: tokenF });
check(
  'POST /api/profile/reset -> {"message": "Profile reset"} and an empty saved profile',
  reset.status === 200 && reset.data.message === 'Profile reset' && afterReset.status === 200 && afterReset.data.organization_name === '' &&
    afterReset.data.evidence.length === 0 && afterReset.data.voice_profile === null && afterReset.data.sources.length === 0,
  [reset.data, afterReset.data],
);
const deleted = await api('DELETE', '/api/profile', { token: tokenF });
const afterDelete = await api('GET', '/api/processing/profile', { token: tokenF });
const templateAfter = await api('GET', '/api/profile', { token: tokenF });
check(
  'DELETE /api/profile -> {"message": "Profile deleted"}; processing GET 404, /api/profile template',
  deleted.status === 200 && deleted.data.message === 'Profile deleted' && afterDelete.status === 404 && templateAfter.data.organization_name === '',
  [deleted.data, afterDelete.status],
);
const firstEdit = await api('PUT', '/api/profile', { token: tokenF, json: { organization_name: 'Fresh', organization_type: 'parish', city: 'A', state: 'TX' } });
check('PUT /api/profile on a new profile adds no "User edit" source (as in the Python)', firstEdit.status === 200 && firstEdit.data.sources.length === 0, firstEdit.data.sources);
const deletedAgain = await api('DELETE', '/api/profile', { token: tokenF });
check('DELETE twice is fine', deletedAgain.status === 200);

// ===========================================================================
// 11. Nothing secret leaks into the debug report
// ===========================================================================

const report = await api('GET', '/api/debug/report', { token: tokenA });
check(
  'debug report lists processing jobs and never contains the saved API key',
  report.status === 200 && report.text.includes('processing.match_grants') && !report.text.includes('sk-ant-test-key'),
  report.text.slice(0, 200),
);

site.close();
mock.stop();
finish();
