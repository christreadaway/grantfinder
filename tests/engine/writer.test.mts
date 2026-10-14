/**
 * GrantWriter: the whole application pipeline through the API, with mock Claude.
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/writer.test.mts
 * VERBOSE=1 shows engine logs.
 *
 * Grants and the org profile are stored directly with repo.ts (the writer
 * only reads them), so this test does not depend on other areas' routes.
 * Grant guidelines are served by a local fake website.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

import { api, check, finish, guest, repoRoot, saveKey, setupEnv, startMock, type ApiResult } from './helpers.mts';

setupEnv('writer', { GRANTFINDER_ALLOW_LOCAL_FETCH: '1' });
const mock = await startMock();

const repo = await import('../../frontend/src/server/repo.ts');
const types = await import('../../frontend/src/server/types.ts');
const deadlines = await import('../../frontend/src/server/deadlines.ts');
const jobsModule = await import('../../frontend/src/server/jobs.ts');
const writer = await import('../../frontend/src/server/services/writer.ts');
const writerRepo = await import('../../frontend/src/server/services/writerRepo.ts');
const handlers = await import('../../frontend/src/server/handlers/writer.ts');
const errors = await import('../../frontend/src/server/errors.ts');

type Grant = import('../../frontend/src/server/types.ts').Grant;

const FIXTURES: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'tests', 'mock-claude', 'fixtures', 'writer.json'), 'utf8'),
);
const restore = (...ids: string[]) => mock.fixtures(Object.fromEntries(ids.map((id) => [id, FIXTURES[id]])));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll a job like the website does; returns the job's result (or its error) as the response. */
async function finishJob(first: ApiResult, token: string): Promise<ApiResult & { job?: Record<string, unknown> }> {
  if (first.status !== 202 || !first.data?.job_id) return first;
  for (let i = 0; i < 1200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const poll = await api('GET', `/api/jobs/${first.data.job_id}`, { token });
    if (poll.status !== 200) return poll;
    if (poll.data.status === 'done') return { ...poll, status: 200, data: poll.data.result, job: poll.data };
    if (poll.data.status === 'failed') return { ...poll, status: poll.data.error?.status ?? 500, data: { detail: poll.data.error?.detail }, job: poll.data };
  }
  throw new Error(`job ${first.data.job_id} did not finish`);
}

async function run(method: string, urlPath: string, token: string, json?: unknown) {
  return finishJob(await api(method, urlPath, { token, json }), token);
}

async function prompts(promptId: string): Promise<string[]> {
  return (await mock.requests()).filter((r) => r.prompt_id === promptId).map((r) => r.prompt);
}

async function lastPrompt(promptId: string): Promise<string> {
  const all = await prompts(promptId);
  return all[all.length - 1] ?? '';
}

/** Minimal zip reader (central directory + inflate), to re-open the exported .docx. */
function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const files = new Map<string, Buffer>();
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(offset + 10);
    const size = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Crude XML well-formedness: every opened element closes in order (enough to catch a broken package). */
function wellFormedXml(xml: string): boolean {
  const stack: string[] = [];
  for (const match of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?(\/?)>/g)) {
    const [, closing, name, selfClosing] = match;
    if (selfClosing) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return stack.length === 0 && xml.includes('<w:document') && xml.trim().endsWith('</w:document>');
}

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

// ---------------------------------------------------------------------------
// A fake funder website (guidelines page + a page that blocks robots)
// ---------------------------------------------------------------------------

const GUIDELINES_HTML = `<!doctype html><html><head><title>Application Process</title>
<script>var tracking = "SCRIPT-SHOULD-NOT-APPEAR";</script></head>
<body><nav>Home | Grants | Contact</nav><main><h1>Application Process</h1>
<p>KENEDY-GUIDELINES-MARKER: applications received by October 15 are reviewed by the Board in May.</p>
<p>Required uploads: Exhibits A-H, including the board list and a detailed budget.</p></main>
<footer>Copyright footer</footer></body></html>`;

const site = http.createServer((req, res) => {
  if (req.url === '/guidelines.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(GUIDELINES_HTML);
  } else if (req.url === '/forbidden') {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<h1>Forbidden</h1>');
  } else {
    res.writeHead(404);
    res.end('not found');
  }
});
const sitePort = await listen(site);
const siteUrl = `http://127.0.0.1:${sitePort}`;
const closed = http.createServer();
const closedPort = await listen(closed);
await new Promise((resolve) => closed.close(resolve));

// ---------------------------------------------------------------------------
// Setup: user A (key + profile + grants)
// ---------------------------------------------------------------------------

const tokenA = await guest();
await saveKey(tokenA);
const userA: string = (await api('GET', '/api/auth/me', { token: tokenA })).data.id;

function makeGrant(userId: string, id: string, fields: Partial<Grant>): Grant {
  return {
    id,
    user_id: userId,
    created_at: new Date().toISOString(),
    grant_name: 'Test Grant',
    deadline: '',
    amount: '',
    funder: 'Test Funder',
    description: 'A test grant.',
    contact: '',
    url: '',
    status: 'OPEN',
    geo_qualified: 'Yes',
    funder_stats: null,
    category: 'mixed',
    source: 'seed',
    eligibility_notes: null,
    funds_for: [],
    ...fields,
  };
}

const KENEDY_URL = 'https://kenedy.org/grants/application-process/';
const today = deadlines.todayIso();
const grantsA: Grant[] = [
  makeGrant(userA, 'grant_kenedy', {
    grant_name: 'Kenedy Memorial Foundation Grants',
    funder: 'The John G. and Marie Stella Kenedy Memorial Foundation',
    deadline: 'Annual: October 15',
    amount: 'Typically $6,000 to $50,000',
    description: 'Funds Catholic and non-sectarian charities in Texas only. Catholic education is the top priority.',
    url: KENEDY_URL,
    geo_qualified: 'Yes - TX Only',
    eligibility_notes: 'Required uploads (Exhibits A-H). One application per organization every 12 months.',
    funds_for: ['education', 'tuition_assistance'],
  }),
  makeGrant(userA, 'grant_fetch', { grant_name: 'Reading Lab Seed Grant', deadline: deadlines.addDaysIso(today, 3), url: `${siteUrl}/guidelines.html` }),
  makeGrant(userA, 'grant_down', { grant_name: 'Unreachable Funder Grant', deadline: deadlines.addDaysIso(today, 30), url: `http://127.0.0.1:${closedPort}/guidelines` }),
  makeGrant(userA, 'grant_forbidden', { grant_name: 'Robot-Blocking Funder Grant', deadline: 'Rolling', url: `${siteUrl}/forbidden` }),
];
await repo.saveGrants(userA, grantsA);

const profileFor = (userId: string) =>
  types.normalizeProfile({
    user_id: userId,
    organization_name: '[School Name]',
    organization_type: 'both',
    diocese: 'Diocese of [City]',
    city: '[City]',
    state: 'TX',
    has_school: true,
    student_count: 214,
    is_501c3: true,
    program_needs: ['K-3 reading intervention', 'tuition assistance'],
    current_initiatives: ['Structured literacy pilot in kindergarten'],
    questionnaire_answers: [{ question: 'What share of families receive tuition assistance?', answer: '38%' }],
    free_form_notes: 'Parish school founded in 1952.',
    sources: ['Entered by hand'],
  });
await repo.saveProfile(userA, profileFor(userA));

// ---------------------------------------------------------------------------
// Pure helpers (deterministic rules)
// ---------------------------------------------------------------------------

check('countWords matches Python split()', writer.countWords('  one two\n\nthree\tfour  ') === 4 && writer.countWords('') === 0);
check('countChars counts code points like Python len()', writer.countChars('héllo ✨') === 7);
check(
  'banned phrases: case-insensitive, curly apostrophes, org list, deduped',
  JSON.stringify(writer.findBannedPhrases("We Are Thrilled. In today’s fast-paced world, synergy!", ['synergy', 'we are thrilled', '  '])) ===
    JSON.stringify(['we are thrilled', "in today's fast-paced world", 'synergy']),
);
check('pyJson uses Python separators', writer.pyJson(['a', { b: 1, c: [null, true] }]) === '["a", {"b": 1, "c": [null, true]}]');
const salvaged = writer.readDraftAnswer('```json\n{"draft": "Our school\\nserves 214 students and');
check('cut-off JSON draft is salvaged, not pasted as raw JSON', salvaged?.draft === 'Our school\nserves 214 students and' && salvaged?.truncated === true, salvaged);
const prose = writer.readDraftAnswer('Our school serves 214 students.');
check('prose answer falls back to the raw text (Python behavior)', prose?.draft === 'Our school serves 214 students.' && prose.structured === false, prose);
const rawBreaks = writer.readDraftAnswer('Here it is:\n{"draft": "Line one\nLine two", "claims": [{"claim": "x", "evidence_ref": "y"}]}');
check(
  'raw line breaks inside JSON strings are repaired (claims kept)',
  rawBreaks?.draft === 'Line one\nLine two' && Array.isArray(rawBreaks?.claims) && rawBreaks.structured === true,
  rawBreaks,
);
const cutInClaims = writer.readDraftAnswer(
  '{"draft": "The whole section text is here.", "claims": [{"claim": "Every primary teacher will train in structured literacy across grades", "evidence_ref": "x"}, {"claim": "cut',
);
check(
  'answer cut off inside the claims list keeps the full draft (never a claim as the draft)',
  cutInClaims?.draft === 'The whole section text is here.' && cutInClaims.truncated === false && cutInClaims.structured === false,
  cutInClaims,
);
check('broken JSON without a draft is refused, never pasted in as the draft', writer.readDraftAnswer('{"text": "abc", "claims": [') === null);

// ---------------------------------------------------------------------------
// 4.0 Handoff: create / reopen / list
// ---------------------------------------------------------------------------

const unauth = await api('GET', '/api/writer/applications');
check('writer routes need sign-in (401)', unauth.status === 401, unauth.data);

const unknownGrant = await api('POST', '/api/writer/applications', { token: tokenA, json: { grant_id: 'grant_nope' } });
check('unknown grant -> 404 Python wording', unknownGrant.status === 404 && unknownGrant.data.detail === 'Grant not found in your database', unknownGrant.data);

const missingField = await api('POST', '/api/writer/applications', { token: tokenA, json: {} });
check('missing grant_id -> 422', missingField.status === 422, missingField.data);

const created = await api('POST', '/api/writer/applications', { token: tokenA, json: { grant_id: 'grant_kenedy' } });
const app = created.data;
const appId: string = app?.id;
const appPath = `/api/writer/applications/${appId}`;
const expectedUrgent = deadlines.isUrgent('Annual: October 15', 10);
check(
  'create application (status analysis, correlation id, Kenedy deadline)',
  created.status === 200 && /^app_[0-9a-f]{12}$/.test(appId) && app.status === 'analysis' && app.strategy_confirmed === false &&
    app.deadline === 'Annual: October 15' && /^corr_/.test(app.correlation_id) && app.grant_name === 'Kenedy Memorial Foundation Grants',
  app,
);
check(`urgent flag for "Annual: October 15" on ${today} is ${expectedUrgent}`, app?.urgent === expectedUrgent, app);

const reopened = await api('POST', '/api/writer/applications', { token: tokenA, json: { grant_id: 'grant_kenedy' } });
check('reopen returns the same application', reopened.status === 200 && reopened.data.id === appId && reopened.data.correlation_id === app.correlation_id, reopened.data);

const fetchApp = (await api('POST', '/api/writer/applications', { token: tokenA, json: { grant_id: 'grant_fetch' } })).data;
const downApp = (await api('POST', '/api/writer/applications', { token: tokenA, json: { grant_id: 'grant_down' } })).data;
const blockedApp = (await api('POST', '/api/writer/applications', { token: tokenA, json: { grant_id: 'grant_forbidden' } })).data;
check('deadline in 3 days -> urgent', fetchApp?.urgent === true, fetchApp);
check('deadline in 30 days -> not urgent; Rolling -> not urgent', downApp?.urgent === false && blockedApp?.urgent === false, [downApp, blockedApp]);

const listed = await api('GET', '/api/writer/applications', { token: tokenA });
check(
  'list applications (oldest first)',
  listed.status === 200 && Array.isArray(listed.data) && listed.data.length === 4 && listed.data[0].id === appId,
  listed.data?.map?.((a: { id: string }) => a.id),
);

const initial = await api('GET', appPath, { token: tokenA });
check(
  'application state has every field the writer page reads',
  initial.status === 200 &&
    initial.data.application.id === appId &&
    initial.data.has_voice_profile === false &&
    initial.data.voice_style_guidelines === null &&
    initial.data.grant_spec === null &&
    initial.data.fit_analysis === null &&
    Array.isArray(initial.data.gaps) &&
    Array.isArray(initial.data.open_blocking_gaps) &&
    Array.isArray(initial.data.intake_requests) &&
    Array.isArray(initial.data.sections) &&
    initial.data.scorecard === null,
  initial.data,
);

// ---------------------------------------------------------------------------
// 4.1 Voice profile
// ---------------------------------------------------------------------------

const noSamples = await api('POST', '/api/writer/voice/analyze', { token: tokenA, json: { samples: ['   '] } });
check('voice: blank samples -> 400 Python wording', noSamples.status === 400 && noSamples.data.detail === 'Provide at least one writing sample', noSamples.data);
const badSamples = await api('POST', '/api/writer/voice/analyze', { token: tokenA, json: {} });
check('voice: missing samples -> 422', badSamples.status === 422, badSamples.data);

const SAMPLE = 'Every morning at 7:30 the bell rings and our families walk in together. We pray, we learn, and we look after each other.';
const voiceStart = await api('POST', '/api/writer/voice/analyze', { token: tokenA, json: { samples: [SAMPLE, ''] } });
check('voice analyze starts a job (202)', voiceStart.status === 202 && voiceStart.data.kind === 'writer.voice_analyze', voiceStart.data);
const voice = await finishJob(voiceStart, tokenA);
check(
  'voice profile extracted (fenced JSON parsed)',
  voice.status === 200 && /^Warm and plain-spoken/.test(voice.data.voice_profile.style_guidelines) &&
    voice.data.voice_profile.banned_phrases.includes('synergy') && voice.data.voice_profile.samples.length === 1,
  voice.data,
);
const profileAfterVoice = await repo.getProfile(userA);
check(
  'voice profile saved onto the SHARED profile',
  Boolean(profileAfterVoice?.voice_profile) && profileAfterVoice!.sources.includes('Voice samples analyzed'),
  profileAfterVoice?.sources,
);
const afterVoice = await api('GET', appPath, { token: tokenA });
check('application shows the voice profile', afterVoice.data.has_voice_profile === true && /^Warm/.test(afterVoice.data.voice_style_guidelines), afterVoice.data.voice_style_guidelines);

// ---------------------------------------------------------------------------
// 4.2 Grant spec: pasted guidelines, URL fetch, unreachable URL, 403, bad answer
// ---------------------------------------------------------------------------

const PASTED = 'KENEDY PASTED GUIDELINES: Narrative sections: Organization Background (250 words), Statement of Need (300 words)...';
const specStart = await api('POST', `${appPath}/grant-spec`, { token: tokenA, json: { guidelines_text: PASTED } });
check('grant spec starts a job (202, kind writer.grant_spec)', specStart.status === 202 && specStart.data.kind === 'writer.grant_spec', specStart.data);
const spec = await finishJob(specStart, tokenA);
const specData = spec.data?.grant_spec;
check(
  'grant spec from pasted guidelines (note null, explicit rubric, limits parsed)',
  spec.status === 200 && spec.data.note === null && specData.grant_id === 'grant_kenedy' && specData.rubric_source === 'explicit' &&
    specData.required_sections.length === 4 && specData.required_sections[0].word_limit === 250 &&
    specData.required_sections[1].word_limit === 300 && specData.required_sections[2].char_limit === 2500 &&
    specData.rubric[1].weight === 25 && specData.guidelines_text === PASTED && specData.deliverables.length === 4,
  spec.data,
);
const specPrompt = await lastPrompt('grant_spec_v1');
check(
  'grant spec prompt: verbatim template, grant record, pasted text',
  specPrompt.startsWith('You are preparing a Grant Spec: the complete application requirements for one grant.') &&
    specPrompt.includes('"grant_name": "Kenedy Memorial Foundation Grants"') && specPrompt.includes(`FULL GUIDELINES TEXT:\n${PASTED}`) &&
    specPrompt.includes('- Never invent word limits: use null when unknown.'),
  specPrompt.slice(0, 400),
);

const fetched = await run('POST', `/api/writer/applications/${fetchApp.id}/grant-spec`, tokenA, {});
const fetchPrompt = await lastPrompt('grant_spec_v1');
check(
  'no pasted text: guidelines fetched from the grant URL inside the job',
  fetched.status === 200 && fetched.data.note === `Guidelines fetched from ${siteUrl}/guidelines.html` &&
    fetched.data.grant_spec.guidelines_text.includes('KENEDY-GUIDELINES-MARKER'),
  fetched.data?.note ?? fetched.data,
);
check(
  'fetched page text reaches the prompt without scripts',
  fetchPrompt.includes('KENEDY-GUIDELINES-MARKER') && !fetchPrompt.includes('SCRIPT-SHOULD-NOT-APPEAR'),
);

const down = await run('POST', `/api/writer/applications/${downApp.id}/grant-spec`, tokenA, { guidelines_text: '   ' });
const downPrompt = await lastPrompt('grant_spec_v1');
check(
  'unreachable URL: proceeds with inferred requirements and says why',
  down.status === 200 &&
    /^Could not read http:\/\/127\.0\.0\.1:\d+\/guidelines \(.+\); requirements were inferred\. Paste the guidelines for an exact spec\.$/.test(down.data.note) &&
    downPrompt.includes('No full guidelines provided - infer conservatively'),
  down.data?.note ?? down.data,
);
check(
  'without guidelines the rubric is marked inferred and every section says INFERRED',
  down.data?.grant_spec?.rubric_source === 'inferred' && down.data.grant_spec.required_sections.every((s: { notes: string }) => /INFERRED/.test(s.notes)),
  down.data?.grant_spec?.required_sections,
);

const blockedPath = `/api/writer/applications/${blockedApp.id}`;
const analyzeEarly = await api('POST', `${blockedPath}/analyze`, { token: tokenA });
check('analyze before grant spec -> 400 Python wording', analyzeEarly.status === 400 && analyzeEarly.data.detail === 'Run grant-spec enrichment first', analyzeEarly.data);
const confirmEarly = await api('POST', `${blockedPath}/confirm-strategy`, { token: tokenA, json: { strategy: null } });
check('confirm before fit analysis -> 400 Python wording', confirmEarly.status === 400 && confirmEarly.data.detail === 'Run fit analysis first', confirmEarly.data);
const scoreEarly = await api('POST', `${blockedPath}/score`, { token: tokenA });
check('score before drafting -> 400 Python wording', scoreEarly.status === 400 && scoreEarly.data.detail === 'Draft the application first', scoreEarly.data);
const exportEarly = await api('POST', `${blockedPath}/export`, { token: tokenA, json: { format: 'md' } });
check('export before drafting -> 400 Python wording', exportEarly.status === 400 && exportEarly.data.detail === 'Nothing to export - draft the application first', exportEarly.data);
const refineEarly = await api('POST', `${blockedPath}/sections/s1/refine`, { token: tokenA, json: { instruction: 'shorter' } });
check('refine with no draft -> 404 Python wording', refineEarly.status === 404 && refineEarly.data.detail === 'Section draft not found', refineEarly.data);
const draftEarly = await api('POST', `${blockedPath}/draft`, { token: tokenA, json: {} });
check('draft with no grant spec -> 400 Python wording', draftEarly.status === 400 && draftEarly.data.detail === 'Run grant-spec enrichment first', draftEarly.data);

await mock.fixtures({ grant_spec_v1: 'Sorry, I cannot help with that request.' });
const unreadable = await run('POST', `${blockedPath}/grant-spec`, tokenA, { guidelines_text: 'Some guidelines.' });
const blockedState = await api('GET', blockedPath, { token: tokenA });
check(
  'unreadable grant spec answer fails clearly (502) and saves nothing',
  unreadable.status === 502 && /^Couldn't read the grant requirements: Claude's answer was not in the expected format\./.test(unreadable.data.detail) &&
    blockedState.data.grant_spec === null,
  unreadable.data,
);
await restore('grant_spec_v1');
const forbidden = await run('POST', `${blockedPath}/grant-spec`, tokenA, {});
check('403 guidelines page: note names HTTP 403', forbidden.status === 200 && forbidden.data.note?.includes(`Could not read ${siteUrl}/forbidden (HTTP 403)`), forbidden.data?.note);

// ---------------------------------------------------------------------------
// 4.3 Fit & gap analysis, strategy gate, gap gate
// ---------------------------------------------------------------------------

const analyzeStart = await api('POST', `${appPath}/analyze`, { token: tokenA });
check('analyze starts a job (202)', analyzeStart.status === 202 && analyzeStart.data.kind === 'writer.analyze', analyzeStart.data);
const analysis = await finishJob(analyzeStart, tokenA);
const gaps: Array<{ id: string; severity: string; status: string; description: string }> = analysis.data?.gaps ?? [];
const highGap = gaps.find((g) => g.severity === 'high');
const mediumGap = gaps.find((g) => g.severity === 'medium');
const lowGap = gaps.find((g) => g.severity === 'low');
check(
  'fit analysis: fit map, strategy, gaps (ratings/severity normalized)',
  analysis.status === 200 && analysis.data.fit_analysis.fit_map.length === 4 && analysis.data.fit_analysis.fit_map[2].rating === 'weak' &&
    analysis.data.fit_analysis.fit_map[3].evidence[0] === 'Balanced budget for three years' &&
    analysis.data.fit_analysis.recommended_strategy.length > 50 && gaps.length === 3 && Boolean(highGap && mediumGap && lowGap) &&
    gaps.every((g) => g.status === 'open' && /^gap_[0-9a-f]{10}$/.test(g.id)),
  analysis.data,
);
const fitPrompt = await lastPrompt('fit_gap_v1');
check(
  'fit prompt: profile slice, rubric, Python-style priorities',
  fitPrompt.includes('"organization_name": "[School Name]"') && fitPrompt.includes('GRANT RUBRIC (source: explicit):') &&
    fitPrompt.includes('FUNDER PRIORITIES: ["Catholic education in Texas", "Tuition assistance for families with demonstrated need", "Collaborative partnerships"]'),
);

const stateAfterAnalyze = await api('GET', appPath, { token: tokenA });
check('one high gap is blocking', stateAfterAnalyze.data.open_blocking_gaps.length === 1 && stateAfterAnalyze.data.application.status === 'analysis', stateAfterAnalyze.data.open_blocking_gaps);

const draftNoStrategy = await api('POST', `${appPath}/draft`, { token: tokenA, json: { section_id: null } });
check(
  'GATE 1: drafting before strategy confirmation -> 409',
  draftNoStrategy.status === 409 &&
    draftNoStrategy.data.detail === 'Strategy not confirmed. Review the fit map and confirm the strategy before drafting (human approval gate).',
  draftNoStrategy.data,
);

const STRATEGY = 'Lead with seventy years of Catholic education; frame the reading lab as seed money that reaches every K-3 reader; name the missing audit honestly.';
const confirmed = await api('POST', `${appPath}/confirm-strategy`, { token: tokenA, json: { strategy: STRATEGY } });
check(
  'confirm strategy (edited text kept, status intake)',
  confirmed.status === 200 && confirmed.data.strategy === STRATEGY && confirmed.data.strategy_confirmed === true && confirmed.data.status === 'intake',
  confirmed.data,
);

const draftBlocked = await api('POST', `${appPath}/draft`, { token: tokenA, json: {} });
check(
  'GATE: open high-severity gap blocks drafting -> 409 with the gap',
  draftBlocked.status === 409 && draftBlocked.data.detail.startsWith("1 high-severity gap(s) unresolved. Resolve, record 'we don't have that', or explicitly waive them: ") &&
    draftBlocked.data.detail.includes(highGap!.description.slice(0, 80)),
  draftBlocked.data,
);

// ---------------------------------------------------------------------------
// 4.4 Stakeholder intake
// ---------------------------------------------------------------------------

const EMAIL = "Hi [Staff Name],\n\nCould you help with one question for our Kenedy application?\n\nIf we don't have this, just say so - that's a useful answer too.";
await mock.fixtures({
  intake_packets_v1:
    'Here are the packets.\n```json\n' +
    JSON.stringify([
      { stakeholder_role: 'Finance', gap_ids: [highGap!.id], framing: 'The foundation scores fiscal health.', questions: ['Do we have audited statements?'], expected_format: 'Yes or no', suggested_deadline: 'October 14', email_packet: EMAIL },
      { stakeholder_role: 'Principal', gap_ids: [mediumGap!.id, 'gap_bogus'], framing: 'Shows who we serve.', questions: ['Enrollment by income band?'], expected_format: 'A few numbers', suggested_deadline: 'null', email_packet: EMAIL },
      { stakeholder_role: 'Pastor', gap_ids: [lowGap!.id], framing: 'Exhibit C needs board minutes.', questions: ['Did the council approve this request?'], email_packet: EMAIL },
      { stakeholder_role: 'Development', gap_ids: [highGap!.id], framing: 'Duplicate owner.', questions: [], email_packet: EMAIL },
    ]) +
    '\n```',
});
const intake = await run('POST', `${appPath}/intake/generate`, tokenA);
const requests: Array<{ id: string; stakeholder_role: string; gap_ids: string[]; status: string; email_packet: string; suggested_deadline: string | null; expected_format: string }> =
  intake.data?.intake_requests ?? [];
const byRole = (role: string) => requests.find((r) => r.stakeholder_role === role)!;
check(
  'intake packets: one owner per gap (duplicate and unknown ids dropped)',
  intake.status === 200 && requests.length === 4 && byRole('Development').gap_ids.length === 0 &&
    JSON.stringify(byRole('Principal').gap_ids) === JSON.stringify([mediumGap!.id]) && byRole('Principal').suggested_deadline === null &&
    byRole('Pastor').expected_format === 'A few sentences is fine.' && requests.every((r) => r.status === 'draft' && /^intake_[0-9a-f]{10}$/.test(r.id)),
  intake.data,
);
check('email packets are copy-paste text that allows "we don\'t have that"', requests.every((r) => r.email_packet.includes("just say so")));
const intakePrompt = await lastPrompt('intake_packets_v1');
check(
  'intake prompt: funder, deadline, open gaps',
  intakePrompt.startsWith('You are helping a Grant Lead collect missing information for a grant application to The John G. and Marie Stella Kenedy Memorial Foundation (Kenedy Memorial Foundation Grants), deadline Annual: October 15.') &&
    intakePrompt.includes(highGap!.id),
);
const stateAfterIntake = await api('GET', appPath, { token: tokenA });
check('gaps are routed; requests saved', stateAfterIntake.data.gaps.every((g: { status: string }) => g.status === 'routed') && stateAfterIntake.data.intake_requests.length === 4, stateAfterIntake.data.gaps);

const stillBlocked = await api('POST', `${appPath}/draft`, { token: tokenA, json: {} });
check('routed high gap still blocks drafting (409)', stillBlocked.status === 409, stillBlocked.data);

const ANSWER = 'We have 214 students: 81 qualify for tuition assistance (38%) and 133 pay full tuition.';
const evidenceBefore = (await repo.getProfile(userA))!.evidence.length;
const answered = await api('PUT', `${appPath}/intake/${byRole('Principal').id}/answer`, { token: tokenA, json: { response: ANSWER, is_confirmed_gap: false } });
check(
  'record an answer: request answered, its gap answered',
  answered.status === 200 && answered.data.intake_request.status === 'answered' && answered.data.intake_request.response === ANSWER &&
    answered.data.gaps.find((g: { id: string }) => g.id === mediumGap!.id)?.status === 'answered' &&
    answered.data.gaps.find((g: { id: string }) => g.id === mediumGap!.id)?.answer === ANSWER,
  answered.data,
);
const profileAfterAnswer = (await repo.getProfile(userA))!;
const newEvidence = profileAfterAnswer.evidence[profileAfterAnswer.evidence.length - 1] as Record<string, unknown>;
check(
  'the answer flows into the SHARED profile as evidence',
  profileAfterAnswer.evidence.length === evidenceBefore + 1 && newEvidence.type === 'stakeholder_answer' && newEvidence.summary === ANSWER &&
    newEvidence.source_ref === 'Principal via intake for Kenedy Memorial Foundation Grants' && /^ev_[0-9a-f]{10}$/.test(String(newEvidence.id)) &&
    profileAfterAnswer.sources.includes('Stakeholder answer: Principal'),
  newEvidence,
);

const NO_MINUTES = "We don't have board minutes yet; the council meets in November.";
const confirmedGap = await api('PUT', `${appPath}/intake/${byRole('Pastor').id}/answer`, { token: tokenA, json: { response: NO_MINUTES, is_confirmed_gap: true } });
check(
  '"we don\'t have that" is recorded as a confirmed gap (not added as evidence)',
  confirmedGap.status === 200 && confirmedGap.data.intake_request.status === 'confirmed_gap' &&
    confirmedGap.data.gaps.find((g: { id: string }) => g.id === lowGap!.id)?.status === 'confirmed_gap' &&
    (await repo.getProfile(userA))!.evidence.length === evidenceBefore + 1,
  confirmedGap.data,
);
const badAnswer = await api('PUT', `${appPath}/intake/intake_nope/answer`, { token: tokenA, json: { response: 'x' } });
check('answer unknown intake request -> 404 Python wording', badAnswer.status === 404 && badAnswer.data.detail === 'Intake request not found', badAnswer.data);
const emptyAnswer = await api('PUT', `${appPath}/intake/${byRole('Finance').id}/answer`, { token: tokenA, json: { response: '  ' } });
check('blank answer -> 422 (nothing empty added to the profile)', emptyAnswer.status === 422, emptyAnswer.data);

const badWaive = await api('PUT', `${appPath}/gaps/gap_nope/waive`, { token: tokenA, json: { reason: null } });
check('waive unknown gap -> 404 Python wording', badWaive.status === 404 && badWaive.data.detail === 'Gap not found', badWaive.data);
const waived = await api('PUT', `${appPath}/gaps/${highGap!.id}/waive`, { token: tokenA, json: { reason: 'The diocesan review will be attached instead' } });
check(
  'waive the high gap explicitly',
  waived.status === 200 && waived.data.status === 'waived' && waived.data.answer === 'Waived by Grant Lead: The diocesan review will be attached instead',
  waived.data,
);
const unblocked = await api('GET', appPath, { token: tokenA });
check('no blocking gaps remain', unblocked.data.open_blocking_gaps.length === 0, unblocked.data.open_blocking_gaps);

// ---------------------------------------------------------------------------
// 4.5 Drafting (all sections, then one)
// ---------------------------------------------------------------------------

const draftUnknown = await api('POST', `${appPath}/draft`, { token: tokenA, json: { section_id: 's99' } });
check('draft unknown section -> 404 Python wording', draftUnknown.status === 404 && draftUnknown.data.detail === 'Section not found in grant spec', draftUnknown.data);

await mock.reset(); // fresh request log for counting
const drafted = await run('POST', `${appPath}/draft`, tokenA, { section_id: null });
const sections: Array<Record<string, any>> = drafted.data?.sections ?? [];
const enforcedText = JSON.parse(FIXTURES.voice_enforce_v1).draft as string;
check(
  'draft all: 4 sections in spec order',
  drafted.status === 200 && sections.map((s) => s.section_id).join(',') === 's1,s2,s3,s4',
  drafted.data,
);
check(
  'banned phrase in the draft was detected and rewritten (voice_enforce_v1)',
  sections.every((s) => s.banned_phrase_hits.length === 0 && !/thrilled/i.test(s.current_draft) && s.versions.length === 1 &&
    /We are thrilled/.test(s.versions[0]) && s.compliance_notes.includes('Voice enforcement rewrote banned phrases: we are thrilled')),
  sections[0],
);
check(
  'deterministic counts after enforcement',
  sections.every((s) => s.current_draft === enforcedText && s.word_count === writer.countWords(enforcedText) && s.char_count === writer.countChars(enforcedText) && s.over_limit === false),
  sections.map((s) => [s.word_count, s.char_count, s.over_limit]),
);
check(
  'unsupported claims are flagged (null and "null" evidence)',
  JSON.stringify(sections[0].claims.map((c: { flagged: boolean }) => c.flagged)) === JSON.stringify([false, false, true, true]) &&
    sections[0].claims[2].reason === 'No supporting evidence in profile' && sections[0].claims[3].criterion_ref === null,
  sections[0].claims,
);
const draftPrompts = await prompts('section_draft_v1');
const s1Prompt = draftPrompts.find((p) => p.includes('SECTION: Organization Background')) ?? '';
const s2Prompt = draftPrompts.find((p) => p.includes('SECTION: Statement of Need')) ?? '';
const s3Prompt = draftPrompts.find((p) => p.includes('SECTION: Project Description and Budget Narrative')) ?? '';
check('one section_draft_v1 and one voice_enforce_v1 call per section', draftPrompts.length === 4 && (await prompts('voice_enforce_v1')).length === 4, draftPrompts.length);
check(
  'draft prompts carry the hard limits',
  s1Prompt.includes('HARD LIMIT: 250 words maximum. Target 230 words.') && s2Prompt.includes('HARD LIMIT: 300 words maximum. Target 276 words.') &&
    s3Prompt.includes('HARD LIMIT: 2500 characters maximum. Target 2250 characters.'),
);
check(
  'draft prompt: confirmed strategy, confirmed gap, stakeholder evidence, voice, funder cues',
  s1Prompt.startsWith('Write one section of a grant application to The John G. and Marie Stella Kenedy Memorial Foundation for "Kenedy Memorial Foundation Grants".') &&
    s1Prompt.includes(`CONFIRMED STRATEGY:\n${STRATEGY}`) &&
    s1Prompt.includes('CONFIRMED GAPS (the organization does NOT have these - if relevant, frame honestly as documented learning or planned growth; NEVER claim them):\n["Board minutes authorizing this request (Exhibit C)"]') &&
    s1Prompt.includes(ANSWER) && s1Prompt.includes('- synergy') && s1Prompt.includes("WRITING SAMPLES IN THE ORGANIZATION'S REAL VOICE:\n" + SAMPLE) &&
    s1Prompt.includes('FUNDER LANGUAGE CUES (mirror naturally, no keyword stuffing): ["breaking the cycle of poverty", "seed money", "ripple effect", "Catholic institutions"]') &&
    s1Prompt.includes('[NEEDS INPUT: what\'s missing]'),
);
const enforcePrompt = await lastPrompt('voice_enforce_v1');
check('enforce prompt lists the banned phrases found', enforcePrompt.includes('BANNED PHRASES FOUND: ["we are thrilled"]'));

const afterDraft = await api('GET', appPath, { token: tokenA });
check(
  'application state: sections in spec order, status drafting',
  afterDraft.data.application.status === 'drafting' && afterDraft.data.sections.map((s: { section_id: string }) => s.section_id).join(',') === 's1,s2,s3,s4',
  afterDraft.data.application,
);

const s1Id = sections[0].id;
const one = await run('POST', `${appPath}/draft`, tokenA, { section_id: 's2' });
const afterOne = await api('GET', appPath, { token: tokenA });
check(
  'draft one section (section_id) leaves the others alone',
  one.status === 200 && one.data.sections.length === 1 && one.data.sections[0].section_id === 's2' &&
    afterOne.data.sections[0].id === s1Id && afterOne.data.sections[1].id === one.data.sections[0].id,
  one.data,
);

// ---------------------------------------------------------------------------
// 4.6 Score
// ---------------------------------------------------------------------------

const scored = await run('POST', `${appPath}/score`, tokenA);
check(
  'scorecard: per criterion (string score coerced), overall, top fix, ranked fixes',
  scored.status === 200 && scored.data.per_criterion.length === 4 && scored.data.per_criterion[1].score === 74 &&
    scored.data.overall_score === 72 && /year two/.test(scored.data.top_fix) && scored.data.ranked_fixes.length === 3,
  scored.data,
);
check(
  'deterministic compliance results (3 checks per section; unsupported claims fail)',
  scored.data?.compliance_results?.length === 12 &&
    scored.data.compliance_results.find((c: { check: string }) => c.check === 'evidence-backed claims')?.passed === false &&
    scored.data.compliance_results.find((c: { check: string }) => c.check === 'word/char limit')?.passed === true,
  scored.data?.compliance_results,
);
const scorePrompt = await lastPrompt('self_score_v1');
check('score prompt includes every section with its word count', scorePrompt.includes(`=== Organization Background (${writer.countWords(enforcedText)} words) ===`) && scorePrompt.includes('RUBRIC (source: explicit):'));
const afterScore = await api('GET', appPath, { token: tokenA });
check('scorecard saved; status review', afterScore.data.scorecard?.overall_score === 72 && afterScore.data.application.status === 'review', afterScore.data.application);

// ---------------------------------------------------------------------------
// 4.7 Refine
// ---------------------------------------------------------------------------

const refineText = JSON.parse(FIXTURES.section_refine_v1.replace(/^```\n|\n```$/g, '')).draft as string;
const refined = await run('POST', `${appPath}/sections/s1/refine`, tokenA, { instruction: 'Tighten by 20 words' });
check(
  'refine: new text, previous kept in versions, compliance rechecked',
  refined.status === 200 && refined.data.current_draft === refineText && refined.data.versions.length === 2 &&
    refined.data.versions[1] === enforcedText && refined.data.over_limit === false && refined.data.word_count === writer.countWords(refineText),
  refined.data,
);
const refinePrompt = await lastPrompt('section_refine_v1');
check(
  'refine prompt: one instruction, current draft, hard limit',
  refinePrompt.includes('INSTRUCTION: Tighten by 20 words') && refinePrompt.includes(`CURRENT DRAFT:\n${enforcedText}`) && refinePrompt.includes('HARD LIMIT: 250 words maximum.'),
);
const refineMissing = await api('POST', `${appPath}/sections/s1/refine`, { token: tokenA, json: {} });
check('refine without instruction -> 422', refineMissing.status === 422, refineMissing.data);

// ---------------------------------------------------------------------------
// 4.8 Export: all four formats
// ---------------------------------------------------------------------------

const badFormat = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'pdf' } });
check('unsupported export format -> 422', badFormat.status === 422, badFormat.data);

const stamp = today.replace(/-/g, '');
const md = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'md' } });
check(
  'export md: headers',
  md.status === 200 && md.headers.get('content-type') === 'text/markdown; charset=utf-8' &&
    md.headers.get('content-disposition') === `attachment; filename="Kenedy_Memorial_Foundation_Grants_application_${stamp}.md"`,
  [md.status, md.headers.get('content-type'), md.headers.get('content-disposition'), md.text.slice(0, 200)],
);
check(
  'export md: content and checklist',
  md.text.startsWith('# Kenedy Memorial Foundation Grants\n**Funder:** The John G. and Marie Stella Kenedy Memorial Foundation  \n**Deadline:** Annual: October 15  \n') &&
    md.text.includes(`## Organization Background\n\n${refineText}\n`) && md.text.indexOf('## Statement of Need') < md.text.indexOf('## Evaluation and Sustainability') &&
    md.text.includes('---\n## Submission Checklist\n- [ ] Format: Submit through the online portal after passing the Eligibility Quiz') &&
    md.text.includes('- [ ] Deliverable: Exhibit G: Most recent Form 990'),
  md.text.slice(0, 500),
);

const txt = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'txt' } });
check(
  'export txt: portal paste-in with per-field counts and limits',
  txt.status === 200 && txt.headers.get('content-type') === 'text/plain; charset=utf-8' &&
    txt.headers.get('content-disposition') === `attachment; filename="Kenedy_Memorial_Foundation_Grants_application_${stamp}.txt"` &&
    txt.text.startsWith(`Kenedy Memorial Foundation Grants - The John G. and Marie Stella Kenedy Memorial Foundation\nDeadline: Annual: October 15\n${'='.repeat(60)}`) &&
    txt.text.includes(`FIELD: Organization Background (limit 250 words)\n[${writer.countWords(refineText)} words / ${writer.countChars(refineText)} characters]\n${'-'.repeat(60)}\n${refineText}`) &&
    txt.text.includes('FIELD: Project Description and Budget Narrative (limit 2500 chars)') && txt.text.includes('FIELD: Evaluation and Sustainability\n'),
  txt.text.slice(0, 400),
);

const formMap = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'form_map' } });
check(
  'export form_map: JSON field map',
  formMap.status === 200 && formMap.headers.get('content-type') === 'application/json' &&
    formMap.headers.get('content-disposition') === `attachment; filename="Kenedy_Memorial_Foundation_Grants_form_map_${stamp}.json"` &&
    formMap.data.grant === 'Kenedy Memorial Foundation Grants' && formMap.data.deadline === 'Annual: October 15' && formMap.data.fields.length === 4 &&
    formMap.data.fields[0].field === 'Organization Background' && formMap.data.fields[0].word_limit === 250 && formMap.data.fields[2].char_limit === 2500 &&
    formMap.data.fields[0].content === refineText && formMap.data.submission_checklist.length === 6,
  formMap.data,
);

const docx = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'docx' } });
check(
  'export docx: headers',
  docx.status === 200 && docx.headers.get('content-type') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' &&
    docx.headers.get('content-disposition') === `attachment; filename="Kenedy_Memorial_Foundation_Grants_application_${stamp}.docx"` && docx.bytes.length > 2000,
  [docx.status, docx.headers.get('content-type'), docx.headers.get('content-disposition')],
);
let documentXml = '';
let zipNames: string[] = [];
try {
  const zip = unzip(docx.bytes);
  zipNames = Array.from(zip.keys());
  documentXml = zip.get('word/document.xml')?.toString('utf8') ?? '';
} catch (error) {
  check('docx re-opens as a zip', false, (error as Error).message);
}
check('docx is a Word package', zipNames.includes('[Content_Types].xml') && zipNames.includes('word/document.xml') && zipNames.includes('word/styles.xml'), zipNames);
check('docx document.xml is well-formed XML', wellFormedXml(documentXml), documentXml.slice(-200));
check(
  'docx contains the title, every section heading and text, and the checklist',
  documentXml.includes('<w:pStyle w:val="Title"/>') && documentXml.includes('Kenedy Memorial Foundation Grants') &&
    ['Organization Background', 'Statement of Need', 'Project Description and Budget Narrative', 'Evaluation and Sustainability', 'Submission Checklist'].every((t) => documentXml.includes(`>${t}</w:t>`)) &&
    documentXml.includes('Our K-3 reading lab will train every primary teacher in structured literacy') && documentXml.includes('<w:br w:type="page"/>') &&
    documentXml.includes('Deliverable: Exhibit A: IRS determination letter or Official Catholic Directory page'),
  documentXml.slice(0, 300),
);
check('docx keeps single line breaks as Word line breaks', /The parish hall will host monthly family reading nights/.test(documentXml) && documentXml.includes('<w:br/>'));
const afterExport = await api('GET', appPath, { token: tokenA });
check('status export after an explicit export', afterExport.data.application.status === 'export', afterExport.data.application);

// ---------------------------------------------------------------------------
// Export gates: over limit (after one auto-tighten) and banned phrases
// ---------------------------------------------------------------------------

const LONG = Array.from({ length: 60 }, () => 'Our families pray, learn, and serve together every day.').join(' ');
await mock.fixtures({ section_refine_v1: JSON.stringify({ draft: LONG }) });
const refineCountBefore = (await prompts('section_refine_v1')).length;
const tooLong = await run('POST', `${appPath}/sections/s1/refine`, tokenA, { instruction: 'Add more detail' });
const tightenPrompts = (await prompts('section_refine_v1')).slice(refineCountBefore);
check(
  'over-limit revision triggers exactly one auto-tighten, then stays flagged',
  tooLong.status === 200 && tooLong.data.over_limit === true && tooLong.data.word_count > 250 && tightenPrompts.length === 2 &&
    tightenPrompts[1].includes('INSTRUCTION: Tighten to at most 250 words') &&
    tooLong.data.compliance_notes.includes('Revision exceeded the limit; auto-tightening (Tighten to at most 250 words).'),
  [tooLong.status, tooLong.data?.word_count, tightenPrompts.length],
);
const blockedOver = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'docx' } });
check(
  'GATE 2: export refuses over-limit content (409, Python wording)',
  blockedOver.status === 409 &&
    blockedOver.data.detail === "Cannot export: section(s) over their hard limit: Organization Background. Refine them (e.g. 'tighten to the limit') first.",
  blockedOver.data,
);

await mock.fixtures({
  section_refine_v1: JSON.stringify({ draft: 'Our cutting-edge reading lab will serve every K-3 reader.' }),
  voice_enforce_v1: JSON.stringify({ draft: 'Our cutting-edge reading lab will serve every K-3 reader, truly.' }),
});
const dirty = await run('POST', `${appPath}/sections/s1/refine`, tokenA, { instruction: 'Make it shorter' });
check('banned phrase left in after enforcement stays flagged', dirty.status === 200 && JSON.stringify(dirty.data.banned_phrase_hits) === '["cutting-edge"]' && dirty.data.over_limit === false, dirty.data);
const blockedDirty = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'md' } });
check(
  'GATE 2: export refuses banned phrases (409, Python wording)',
  blockedDirty.status === 409 && blockedDirty.data.detail === 'Cannot export: banned phrases remain in: Organization Background. Refine first.',
  blockedDirty.data,
);
await restore('section_refine_v1', 'voice_enforce_v1');
const clean = await run('POST', `${appPath}/sections/s1/refine`, tokenA, { instruction: 'Restore the plain version' });
const exportOk = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'md' } });
check('after refining, export works again', clean.status === 200 && clean.data.banned_phrase_hits.length === 0 && exportOk.status === 200, exportOk.data ?? exportOk.status);

// ---------------------------------------------------------------------------
// Claude failures: transient with the Python's fallback, transient without, fatal
// ---------------------------------------------------------------------------

await mock.fail('voice_enforce_v1', 529, 'overloaded_error', 3); // 1 try + 2 SDK retries
const fallback = await run('POST', `${appPath}/draft`, tokenA, { section_id: 's4' });
const s4 = fallback.data?.sections?.[0];
check(
  'transient enforce failure falls back like the Python: draft kept, phrase flagged',
  fallback.status === 200 && JSON.stringify(s4?.banned_phrase_hits) === '["we are thrilled"]' &&
    s4.compliance_notes.includes('Banned phrases present (auto-rewrite failed): we are thrilled'),
  fallback.data,
);
const blockedFallback = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'txt' } });
check('...and export stays blocked until it is fixed', blockedFallback.status === 409 && /Evaluation and Sustainability/.test(blockedFallback.data.detail), blockedFallback.data);
const fixedS4 = await run('POST', `${appPath}/sections/s4/refine`, tokenA, { instruction: 'Remove the cliche' });
check('refine clears the flag', fixedS4.status === 200 && fixedS4.data.banned_phrase_hits.length === 0, fixedS4.data);

await mock.fail('self_score_v1', 529, 'overloaded_error', 3);
const overloaded = await run('POST', `${appPath}/score`, tokenA);
check(
  'transient error with no fallback fails the step clearly (503)',
  overloaded.status === 503 && overloaded.data.detail === 'Claude is overloaded right now. Wait a minute and try again.',
  overloaded.data,
);

const before = (await api('GET', appPath, { token: tokenA })).data.sections.map((s: { id: string }) => s.id).join(',');
await mock.fail('section_draft_v1', 401, 'authentication_error', 10);
const fatal = await run('POST', `${appPath}/draft`, tokenA, {});
const after = (await api('GET', appPath, { token: tokenA })).data.sections.map((s: { id: string }) => s.id).join(',');
check(
  'fatal Claude error (bad key) fails the job with the fix, no silent fallback',
  fatal.status === 400 && /^Anthropic rejected your Claude API key \(authentication failed\)\./.test(fatal.data.detail),
  fatal.data,
);
check('fatal error leaves the saved drafts untouched', before === after && before.split(',').length === 4, [before, after]);
await mock.reset();

await mock.fixtures({ section_draft_v1: { text: '{"draft": "[School Name] has taught the children of [City] since 1952. Today 214 students', stop_reason: 'max_tokens' } });
const cutOff = await run('POST', `${appPath}/draft`, tokenA, { section_id: 's3' });
const s3 = cutOff.data?.sections?.[0];
check(
  'answer cut off at max_tokens: text salvaged, flagged for review, claims unverified',
  cutOff.status === 200 && s3?.current_draft === '[School Name] has taught the children of [City] since 1952. Today 214 students' &&
    s3.compliance_notes.some((n: string) => /cut off/.test(n)) && s3.claims.some((c: { flagged: boolean; claim: string }) => c.flagged && /Claims list missing/.test(c.claim)),
  cutOff.data,
);
await restore('section_draft_v1');

// ---------------------------------------------------------------------------
// Draft-all with one failing section (handler run directly with a stub client)
// ---------------------------------------------------------------------------

function stubContext(fail: (prompt: string) => Error | null) {
  const answer = (promptId: string) => FIXTURES[promptId] ?? '{}';
  return {
    job: {} as never,
    userId: userA,
    input: { app_id: appId, section_id: null },
    correlationId: app.correlation_id as string,
    applicationId: appId,
    claude: async () => ({
      call: async (options: { promptId: string; prompt: string }) => {
        const failure = fail(options.prompt);
        if (failure) throw failure;
        return { text: answer(options.promptId), stopReason: 'end_turn', inputTokens: 1, outputTokens: 1, webSearches: 0, latencyMs: 1, costUsd: 0, model: 'stub', content: [] };
      },
    }),
    progress: async () => undefined,
    note: () => undefined,
  };
}

const beforePartial = (await writerRepo.listSectionDrafts(userA, appId)).reduce<Record<string, string>>((m, d) => ({ ...m, [d.section_id]: d.id }), {});
let partialError: { status?: number; detail?: string } = {};
try {
  await handlers.writerJobs['writer.draft'](
    stubContext((prompt) =>
      prompt.includes('SECTION: Statement of Need') ? new errors.ClaudeError('overloaded', 503, 'Claude is overloaded right now. Wait a minute and try again.', false) : null,
    ) as never,
  );
} catch (error) {
  partialError = error as { status?: number; detail?: string };
}
const afterPartial = (await writerRepo.listSectionDrafts(userA, appId)).reduce<Record<string, string>>((m, d) => ({ ...m, [d.section_id]: d.id }), {});
check(
  'one section failing does not lose the others: each saved, clear summary',
  partialError.status === 503 &&
    partialError.detail ===
      'Drafted and saved 3 of 4 sections. Not drafted: "Statement of Need" (Claude is overloaded right now. Wait a minute and try again.). The saved sections are kept; run drafting again to finish (sections without a draft go first).' &&
    afterPartial.s2 === beforePartial.s2 && afterPartial.s1 !== beforePartial.s1 && afterPartial.s3 !== beforePartial.s3 && afterPartial.s4 !== beforePartial.s4,
  partialError,
);

let failedOnce = false;
const recovered = (await handlers.writerJobs['writer.draft'](
  stubContext((prompt) => {
    if (!failedOnce && prompt.includes('SECTION: Evaluation and Sustainability')) {
      failedOnce = true;
      return new errors.ClaudeError('rate_limit', 429, 'Claude rate limit reached for your API key. Wait a minute and try again.', false);
    }
    return null;
  }) as never,
)) as { sections: Array<{ section_id: string }> };
check(
  'a section that hits a rate limit gets one more try, and the run succeeds',
  failedOnce && recovered.sections.map((s) => s.section_id).join(',') === 's1,s2,s3,s4',
  recovered.sections.map((s) => s.section_id),
);

let fatalMid: { status?: number; detail?: string } = {};
try {
  await handlers.writerJobs['writer.draft'](
    stubContext((prompt) =>
      prompt.includes('SECTION: Project Description') ? new errors.ClaudeError('billing', 400, 'Your Anthropic account is out of API credits.', true) : null,
    ) as never,
  );
} catch (error) {
  fatalMid = error as { status?: number; detail?: string };
}
check(
  'fatal error mid-run stops new sections and reports what was saved',
  fatalMid.status === 400 && /^Your Anthropic account is out of API credits\. \(\d of 4 sections were drafted and saved before this\.\)$/.test(fatalMid.detail ?? ''),
  fatalMid,
);

// ---------------------------------------------------------------------------
// Fit analysis without gaps -> intake has nothing to route (no Claude call)
// ---------------------------------------------------------------------------

const fitNoGaps = JSON.parse(FIXTURES.fit_gap_v1.slice(FIXTURES.fit_gap_v1.indexOf('{'), FIXTURES.fit_gap_v1.lastIndexOf('}') + 1));
await mock.fixtures({ fit_gap_v1: JSON.stringify({ ...fitNoGaps, gaps: [] }) });
const fetchPath = `/api/writer/applications/${fetchApp.id}`;
const noGapAnalysis = await run('POST', `${fetchPath}/analyze`, tokenA);
const noGapIntake = await api('POST', `${fetchPath}/intake/generate`, { token: tokenA });
check(
  'no gaps: intake answers at once with the Python note',
  noGapAnalysis.status === 200 && noGapIntake.status === 200 && noGapIntake.data.note === 'No gaps to route' && noGapIntake.data.intake_requests.length === 0,
  noGapIntake.data,
);
await restore('fit_gap_v1');

// ---------------------------------------------------------------------------
// Other users: no API key, no profile, someone else's application
// ---------------------------------------------------------------------------

const tokenB = await guest();
const userB: string = (await api('GET', '/api/auth/me', { token: tokenB })).data.id;
await repo.saveGrants(userB, [makeGrant(userB, 'grant_kenedy', { grant_name: 'Kenedy Memorial Foundation Grants', deadline: 'Annual: October 15' })]);
await repo.saveProfile(userB, profileFor(userB));
const appB = await api('POST', '/api/writer/applications', { token: tokenB, json: { grant_id: 'grant_kenedy' } });
check('another user gets their own application for the same grant', appB.status === 200 && appB.data.id !== appId, appB.data);
const noKey = await api('POST', `/api/writer/applications/${appB.data.id}/grant-spec`, { token: tokenB, json: { guidelines_text: 'x' } });
check('missing API key -> 400 Python wording (before any job)', noKey.status === 400 && noKey.data.detail === 'Claude API key not set. Please add your API key first.', noKey.data);
const noKeyVoice = await api('POST', '/api/writer/voice/analyze', { token: tokenB, json: { samples: [SAMPLE] } });
check('missing API key on voice analysis -> 400', noKeyVoice.status === 400 && noKeyVoice.data.detail === 'Claude API key not set. Please add your API key first.', noKeyVoice.data);
const notMine = await api('GET', appPath, { token: tokenB });
check("someone else's application -> 404", notMine.status === 404 && notMine.data.detail === 'Application not found', notMine.data);
const notMineDraft = await api('POST', `${appPath}/draft`, { token: tokenB, json: {} });
const notMineExport = await api('POST', `${appPath}/export`, { token: tokenB, json: { format: 'md' } });
const notMineBundle = await api('GET', `${appPath}/debug-bundle`, { token: tokenB });
check("someone else's application can't be drafted, exported, or debugged", [notMineDraft, notMineExport, notMineBundle].every((r) => r.status === 404), [notMineDraft.status, notMineExport.status, notMineBundle.status]);

const tokenC = await guest();
await saveKey(tokenC);
const userC: string = (await api('GET', '/api/auth/me', { token: tokenC })).data.id;
await repo.saveGrants(userC, [makeGrant(userC, 'grant_kenedy', { grant_name: 'Kenedy Memorial Foundation Grants' })]);
const noProfile = await api('POST', '/api/writer/applications', { token: tokenC, json: { grant_id: 'grant_kenedy' } });
check(
  'missing profile -> 400 Python wording',
  noProfile.status === 400 && noProfile.data.detail === 'No organization profile. Complete grantfinder setup first - the writer reuses that profile.',
  noProfile.data,
);

// ---------------------------------------------------------------------------
// Section 8: debug bundle, recent AI calls, no secrets
// ---------------------------------------------------------------------------

const bundle = await api('GET', `${appPath}/debug-bundle`, { token: tokenA });
const md2: string = bundle.data?.bundle_markdown ?? '';
check(
  'debug bundle: header, state summary, AI call timeline with every prompt id',
  bundle.status === 200 && md2.startsWith('# GrantFinder Debug Bundle\n') && md2.includes(`- **Correlation ID:** ${app.correlation_id}`) &&
    md2.includes(`- **Application:** ${appId} - Kenedy Memorial Foundation Grants (The John G. and Marie Stella Kenedy Memorial Foundation)`) &&
    md2.includes('strategy_confirmed=True') && md2.includes('## State summary') && md2.includes('- Grant spec: yes') &&
    md2.includes('| time | stage | prompt | in_tok | out_tok | ms | $est | status |') &&
    ['grant_spec_v1', 'fit_gap_v1', 'intake_packets_v1', 'section_draft_v1', 'voice_enforce_v1', 'self_score_v1', 'section_refine_v1'].every((id) => md2.includes(`| ${id} |`)) &&
    md2.includes('**Total estimated AI cost for this application: $'),
  md2.slice(0, 600),
);
check(
  'debug bundle: steps with notes, and the errors section (failed calls and steps)',
  md2.includes('## Steps (background jobs, oldest first)') && md2.includes('`writer.draft`') && md2.includes('## Errors') &&
    md2.includes('section_draft_v1: Anthropic rejected your Claude API key') && md2.includes('Guidelines pasted'),
  md2.slice(md2.indexOf('## Errors'), md2.indexOf('## Errors') + 400),
);
check('debug bundle never contains the API key', !md2.includes('sk-ant-test-key') && !/sk-ant-[A-Za-z0-9]/.test(md2));

const recent = await api('GET', '/api/writer/logs/recent', { token: tokenA });
check(
  'recent AI calls: newest first, Python shape, includes calls outside applications (voice)',
  recent.status === 200 && Array.isArray(recent.data) && recent.data.length > 10 && recent.data[0].timestamp >= recent.data[recent.data.length - 1].timestamp &&
    ['correlation_id', 'application_id', 'stage', 'prompt_id', 'model', 'input_tokens', 'output_tokens', 'latency_ms', 'cost_estimate_usd', 'status', 'error', 'timestamp'].every((k) => k in recent.data[0]) &&
    recent.data.some((c: { prompt_id: string; application_id: string | null }) => c.prompt_id === 'voice_profile_v1' && c.application_id === null),
  recent.data?.slice?.(0, 2),
);
const recentLimited = await api('GET', '/api/writer/logs/recent?limit=3', { token: tokenA });
const recentBad = await api('GET', '/api/writer/logs/recent?limit=lots', { token: tokenA });
check('recent AI calls: limit works; bad limit -> 422', recentLimited.data?.length === 3 && recentBad.status === 422, [recentLimited.data?.length, recentBad.status]);
const recentB = await api('GET', '/api/writer/logs/recent', { token: tokenB });
check("recent AI calls never show another user's calls", recentB.status === 200 && recentB.data.length === 0, recentB.data?.length);

const allJobs = await jobsModule.listJobs(userA, 200);
const writerJobs = allJobs.filter((job) => job.kind.startsWith('writer.'));
check(
  'every writer job carries the application correlation id and never the API key',
  writerJobs.length > 15 && !JSON.stringify(writerJobs.map((job) => job.input)).includes('sk-ant-') &&
    writerJobs.filter((job) => job.application_id === appId).every((job) => job.correlation_id === app.correlation_id),
  writerJobs.length,
);

site.close();
mock.stop();
finish();
