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
type Gap = import('../../frontend/src/server/types.ts').Gap;
type GapStatus = import('../../frontend/src/server/types.ts').GapStatus;

const FIXTURES: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'tests', 'mock-claude', 'fixtures', 'writer.json'), 'utf8'),
);
const restore = (...ids: string[]) => mock.fixtures(Object.fromEntries(ids.map((id) => [id, FIXTURES[id]])));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll a job like the website does; returns the job's result (or its error) as
 * the response. A result carrying __continue (a long step done in parts) is
 * followed the way the website follows it.
 */
async function finishJob(first: ApiResult, token: string): Promise<ApiResult & { job?: Record<string, unknown> }> {
  if (first.status !== 202 || !first.data?.job_id) return first;
  for (let i = 0; i < 1200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const poll = await api('GET', `/api/jobs/${first.data.job_id}`, { token });
    if (poll.status !== 200) return poll;
    if (poll.data.status === 'done') {
      const next = poll.data.result?.__continue;
      if (next?.path) return finishJob(await api('POST', next.path, { token, json: next.body ?? {} }), token);
      return { ...poll, status: 200, data: poll.data.result, job: poll.data };
    }
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
check(
  'banned phrases match whole words only: "compassionate about" is not "passionate about", "justice" is not "just"',
  writer.findBannedPhrases('We are compassionate about every family.').length === 0 &&
    writer.findBannedPhrases('We work for justice and adjust our plans.', ['just']).length === 0 &&
    writer.findBannedPhrases('Our state-of-the-artistry program.').length === 0,
  [writer.findBannedPhrases('We are compassionate about every family.'), writer.findBannedPhrases('justice', ['just'])],
);
check(
  'banned phrases still match as whole words: next to punctuation, across a line break, with a trailing comma phrase',
  JSON.stringify(writer.findBannedPhrases('We just want to help.', ['just'])) === '["just"]' &&
    JSON.stringify(writer.findBannedPhrases('Families who are passionate about reading.')) === '["passionate about"]' &&
    JSON.stringify(writer.findBannedPhrases('A state-of-the-art lab.')) === '["state-of-the-art"]' &&
    JSON.stringify(writer.findBannedPhrases('We are\nthrilled.')) === '["we are thrilled"]' &&
    JSON.stringify(writer.findBannedPhrases('Furthermore, the lab stays open.')) === '["furthermore, "]' &&
    JSON.stringify(writer.findBannedPhrases('(synergy)', ['  synergy '])) === '["  synergy "]',
  [
    writer.findBannedPhrases('We just want to help.', ['just']),
    writer.findBannedPhrases('We are\nthrilled.'),
    writer.findBannedPhrases('Furthermore, the lab stays open.'),
    writer.findBannedPhrases('(synergy)', ['  synergy ']),
  ],
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
check(
  'a refine notes that the claim check is from the earlier draft',
  refined.data?.compliance_notes?.includes('Revised: the claim check is from the earlier draft. Re-check any new numbers or names.'),
  refined.data?.compliance_notes,
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
const mdNotice = decodeURIComponent(md.headers.get('x-grantfinder-notice') || '');
check(
  'export notice lists the [NEEDS INPUT] placeholders still in the file (export not blocked)',
  md.status === 200 &&
    mdNotice ===
      'Still in the file: 3 [NEEDS INPUT] placeholder(s), in Statement of Need (1), Project Description and Budget Narrative (1), ' +
        'Evaluation and Sustainability (1). Fill them in before you submit.',
  mdNotice,
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
  'GATE 2: export refuses over-limit content (409: names the section and its count; tighten or edit by hand)',
  blockedOver.status === 409 &&
    blockedOver.data.detail ===
      `Cannot export: section(s) over their hard limit: Organization Background (${tooLong.data?.word_count} of 250 words). ` +
        'Refine it (for example "tighten to the limit") or edit it by hand first.',
  blockedOver.data,
);
check(
  'a refine adds the "re-check new numbers" claim note exactly once (even with the auto-tighten pass)',
  tooLong.data?.compliance_notes?.filter((n: string) => n === writer.SECTION_NOTES.refinedClaims).length === 1,
  tooLong.data?.compliance_notes,
);

await mock.fixtures({
  section_refine_v1: JSON.stringify({ draft: 'Our cutting-edge reading lab will serve every K-3 reader.' }),
  voice_enforce_v1: JSON.stringify({ draft: 'Our cutting-edge reading lab will serve every K-3 reader, truly.' }),
});
const dirty = await run('POST', `${appPath}/sections/s1/refine`, tokenA, { instruction: 'Make it shorter' });
check('banned phrase left in after enforcement stays flagged', dirty.status === 200 && JSON.stringify(dirty.data.banned_phrase_hits) === '["cutting-edge"]' && dirty.data.over_limit === false, dirty.data);
const blockedDirty = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'md' } });
check(
  'GATE 2: export refuses banned phrases (409: names the section and the phrase; refine or edit by hand)',
  blockedDirty.status === 409 &&
    blockedDirty.data.detail ===
      'Cannot export: banned phrases remain in: Organization Background ("cutting-edge"). ' +
        'Refine that section (for example "remove these phrases") or edit it by hand first.',
  blockedDirty.data,
);
await restore('section_refine_v1', 'voice_enforce_v1');
const clean = await run('POST', `${appPath}/sections/s1/refine`, tokenA, { instruction: 'Restore the plain version' });
const exportOk = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'md' } });
check('after refining, export works again', clean.status === 200 && clean.data.banned_phrase_hits.length === 0 && exportOk.status === 200, exportOk.data ?? exportOk.status);

// ---------------------------------------------------------------------------
// Live compliance: a phrase banned AFTER drafting shows up at once (nothing re-saved)
// ---------------------------------------------------------------------------

type SectionState = { section_id: string; title: string; current_draft: string; versions: string[]; claims: unknown[]; compliance_notes: string[]; banned_phrase_hits: string[]; over_limit: boolean; word_count: number; char_count: number };
const sectionOf = async (sectionId: string, token = tokenA): Promise<SectionState> =>
  (await api('GET', appPath, { token })).data.sections.find((s: SectionState) => s.section_id === sectionId);
const withExtraBanned = (phrases: string[]) =>
  repo.updateProfile(userA, (profile) =>
    profile ? { ...profile, voice_profile: { ...(profile.voice_profile ?? {}), banned_phrases: phrases } } : undefined,
  );
const bannedBefore = ((await repo.getProfile(userA))!.voice_profile as { banned_phrases: string[] }).banned_phrases;
await withExtraBanned([...bannedBefore, 'truest sense']);
const liveS3 = await sectionOf('s3');
const storedS3 = await writerRepo.getSectionDraft(userA, appId, 's3');
check(
  'a phrase banned after drafting shows up in the application state (live check, nothing re-saved)',
  liveS3.banned_phrase_hits.includes('truest sense') && storedS3?.banned_phrase_hits.length === 0,
  [liveS3.banned_phrase_hits, storedS3?.banned_phrase_hits],
);
const blockedLive = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'md' } });
check(
  'export refusal names each section with the newly banned phrase',
  blockedLive.status === 409 &&
    blockedLive.data.detail ===
      'Cannot export: banned phrases remain in: Statement of Need ("truest sense"), Project Description and Budget Narrative ("truest sense"), ' +
        'Evaluation and Sustainability ("truest sense"). Refine those sections (for example "remove these phrases") or edit them by hand first.',
  blockedLive.data,
);
await withExtraBanned(bannedBefore);
const liveAgain = await sectionOf('s3');
check('removing the phrase from the profile clears the flag again', liveAgain.banned_phrase_hits.length === 0, liveAgain.banned_phrase_hits);

// ---------------------------------------------------------------------------
// 4.7b Hand edits: PUT .../sections/:sectionId {text}
// ---------------------------------------------------------------------------

const s2Before = await sectionOf('s2');
const appBeforeEdit = (await api('GET', appPath, { token: tokenA })).data.application;
const EDIT_TEXT = 'Our families walk in together at 7:30 every morning.\r\nWe pray, we learn, and we look after each other. [NEEDS INPUT: number of families]';
const EDIT_SAVED = EDIT_TEXT.replace(/\r\n/g, '\n');
const edited = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: EDIT_TEXT } });
check(
  'hand edit saves the new text (line breaks normalized to \\n)',
  edited.status === 200 && edited.data.section_id === 's2' && edited.data.current_draft === EDIT_SAVED,
  edited.data,
);
check(
  'hand edit keeps the previous text in versions (newest last)',
  edited.data?.versions?.length === s2Before.versions.length + 1 && edited.data.versions[edited.data.versions.length - 1] === s2Before.current_draft,
  edited.data?.versions,
);
check(
  'hand edit recomputes counts and flags',
  edited.data?.word_count === writer.countWords(EDIT_SAVED) && edited.data.char_count === writer.countChars(EDIT_SAVED) &&
    edited.data.over_limit === false && edited.data.banned_phrase_hits.length === 0,
  [edited.data?.word_count, edited.data?.char_count, edited.data?.over_limit, edited.data?.banned_phrase_hits],
);
check(
  'hand edit keeps the claims and adds the two notes',
  JSON.stringify(edited.data?.claims) === JSON.stringify(s2Before.claims) &&
    edited.data.compliance_notes.includes('Edited by hand.') &&
    edited.data.compliance_notes.includes('The claim check is from the AI draft; re-check any numbers or names you added.'),
  edited.data?.compliance_notes,
);
const s2AfterEdit = await sectionOf('s2');
const appAfterEdit = (await api('GET', appPath, { token: tokenA })).data.application;
check(
  'the application state shows the edit; the application was touched',
  s2AfterEdit.current_draft === EDIT_SAVED && appAfterEdit.updated_at > appBeforeEdit.updated_at,
  [s2AfterEdit.current_draft.slice(0, 60), appBeforeEdit.updated_at, appAfterEdit.updated_at],
);
const EDIT_TEXT_2 = `${EDIT_SAVED}\nThank you for considering our families.`;
const edited2 = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: EDIT_TEXT_2 } });
check(
  'a second edit adds one more version and never duplicates the notes',
  edited2.status === 200 && edited2.data.versions.length === s2Before.versions.length + 2 &&
    edited2.data.compliance_notes.filter((n: string) => n === 'Edited by hand.').length === 1 &&
    edited2.data.compliance_notes.filter((n: string) => n.startsWith('The claim check is from the AI draft')).length === 1,
  edited2.data?.compliance_notes,
);
const appBeforeSame = (await api('GET', appPath, { token: tokenA })).data.application;
const same = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: EDIT_TEXT_2.replace(/\n/g, '\r\n') } });
const appAfterSame = (await api('GET', appPath, { token: tokenA })).data.application;
check(
  'saving unchanged text is a no-op (no new version, application not touched)',
  same.status === 200 && same.data.current_draft === EDIT_TEXT_2 && same.data.versions.length === edited2.data.versions.length &&
    appAfterSame.updated_at === appBeforeSame.updated_at,
  [same.status, same.data?.versions?.length, appBeforeSame.updated_at, appAfterSame.updated_at],
);

const LONG_EDIT = Array.from({ length: 320 }, (_, i) => `word${i}`).join(' ');
const overEdit = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: LONG_EDIT } });
const s2Over = await sectionOf('s2');
check(
  'an over-limit edit is saved and flagged OVER LIMIT (response and state)',
  overEdit.status === 200 && overEdit.data.over_limit === true && overEdit.data.word_count === 320 && s2Over.over_limit === true,
  [overEdit.status, overEdit.data?.over_limit, overEdit.data?.word_count, s2Over.over_limit],
);
const liveScorecard = (await api('GET', appPath, { token: tokenA })).data.scorecard;
const storedScorecard = await writerRepo.getScorecard(userA, appId);
type ComplianceRow = { section?: unknown; check?: unknown; passed?: unknown; detail?: unknown };
const limitRow = (rows: ComplianceRow[] | undefined) => rows?.find((c) => c.section === 'Statement of Need' && c.check === 'word/char limit');
check(
  'the scorecard checklist follows the live text (the over-limit edit fails its limit check); the stored scorecard is untouched',
  limitRow(liveScorecard?.compliance_results)?.passed === false && /^320 words/.test(String(limitRow(liveScorecard?.compliance_results)?.detail)) &&
    limitRow(storedScorecard?.compliance_results)?.passed === true && liveScorecard.overall_score === storedScorecard?.overall_score,
  [limitRow(liveScorecard?.compliance_results), limitRow(storedScorecard?.compliance_results)],
);
const blockedByEdit = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'md' } });
check(
  'export refuses the over-limit edit (409) and names the section',
  blockedByEdit.status === 409 &&
    blockedByEdit.data.detail.startsWith('Cannot export: section(s) over their hard limit: Statement of Need (320 of 300 words).') &&
    /tighten/.test(blockedByEdit.data.detail) && /by hand/.test(blockedByEdit.data.detail),
  blockedByEdit.data,
);
const dirtyEdit = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: 'We are thrilled to keep the reading lab open after school.' } });
check(
  'a banned phrase in an edit is flagged',
  dirtyEdit.status === 200 && JSON.stringify(dirtyEdit.data.banned_phrase_hits) === '["we are thrilled"]' && dirtyEdit.data.over_limit === false,
  dirtyEdit.data,
);
const blockedByDirtyEdit = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'md' } });
check(
  'export refuses the banned phrase from the edit and names it',
  blockedByDirtyEdit.status === 409 &&
    blockedByDirtyEdit.data.detail ===
      'Cannot export: banned phrases remain in: Statement of Need ("we are thrilled"). Refine that section (for example "remove these phrases") or edit it by hand first.',
  blockedByDirtyEdit.data,
);
const compassionateEdit = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: 'Our teachers are compassionate about every family we serve.' } });
const compassionateExport = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'md' } });
check(
  'a hand edit saying "compassionate about" is not flagged as "passionate about", and it exports',
  compassionateEdit.status === 200 && compassionateEdit.data.banned_phrase_hits.length === 0 && compassionateExport.status === 200,
  [compassionateEdit.data?.banned_phrase_hits, compassionateExport.status, compassionateExport.data?.detail],
);
for (let i = 1; i <= 8; i++) {
  await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: `Hand edit number ${i}.` } });
}
const versionsNow = (await sectionOf('s2')).versions;
check(
  'versions stay capped at the last 12 (newest last)',
  versionsNow.length === 12 && versionsNow[11] === 'Hand edit number 7.' && versionsNow[10] === 'Hand edit number 6.',
  versionsNow.slice(-3),
);
const restoredEdit = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: s2Before.current_draft } });
const exportAfterEdit = await api('POST', `${appPath}/export`, { token: tokenA, json: { format: 'md' } });
check(
  'restoring an earlier version by saving its text clears the flags; export works again',
  restoredEdit.status === 200 && restoredEdit.data.current_draft === s2Before.current_draft && exportAfterEdit.status === 200 &&
    exportAfterEdit.text.includes(s2Before.current_draft),
  [restoredEdit.status, exportAfterEdit.status, exportAfterEdit.data?.detail],
);

const blankEdit = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: '  \r\n ' } });
const missingEdit = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: {} });
check(
  'blank or missing text -> 400 "Section text is empty."',
  blankEdit.status === 400 && blankEdit.data.detail === 'Section text is empty.' && missingEdit.status === 400 && missingEdit.data.detail === 'Section text is empty.',
  [blankEdit.data, missingEdit.data],
);
const tooLongEdit = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: 'a'.repeat(60001) } });
const notTextEdit = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: 42 } });
check('text over 60,000 characters -> 400; text that is not text -> 422', tooLongEdit.status === 400 && /too long/.test(tooLongEdit.data.detail) && notTextEdit.status === 422, [tooLongEdit.data, notTextEdit.data]);
const unknownSectionEdit = await api('PUT', `${appPath}/sections/s99`, { token: tokenA, json: { text: 'Some text.' } });
const unknownAppEdit = await api('PUT', '/api/writer/applications/app_000000000000/sections/s2', { token: tokenA, json: { text: 'Some text.' } });
check(
  'unknown section -> 404 "Section draft not found"; unknown application -> 404 "Application not found"',
  unknownSectionEdit.status === 404 && unknownSectionEdit.data.detail === 'Section draft not found' &&
    unknownAppEdit.status === 404 && unknownAppEdit.data.detail === 'Application not found',
  [unknownSectionEdit.data, unknownAppEdit.data],
);
const unauthEdit = await api('PUT', `${appPath}/sections/s2`, { json: { text: 'Some text.' } });
check('hand edit needs sign-in (401)', unauthEdit.status === 401, unauthEdit.data);

// While drafting or refining runs for this application, an edit is refused (not attached to the job).
await mock.delay('section_draft_v1', 1500);
const slowDraft = await api('POST', `${appPath}/draft`, { token: tokenA, json: { section_id: 's4' } });
const busyEdit = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: 'An edit while drafting runs.' } });
await mock.delay('section_draft_v1', 0);
const slowDone = await finishJob(slowDraft, tokenA);
check(
  'edit while a drafting job runs -> 409 with what to do, and no "running" flag',
  slowDraft.status === 202 && busyEdit.status === 409 &&
    busyEdit.data.detail === 'Drafting or refining is still running for this application. Wait for it to finish, then save your edit again.' &&
    busyEdit.data.running === undefined && busyEdit.data.job_id === undefined,
  busyEdit.data,
);
const s2AfterBusy = await sectionOf('s2');
check('the refused edit changed nothing; the drafting job still finished', slowDone.status === 200 && s2AfterBusy.current_draft === s2Before.current_draft, [slowDone.status, s2AfterBusy.current_draft.slice(0, 60)]);
const editAfterBusy = await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: `${s2Before.current_draft} ` } });
check('after the job finishes, the edit is accepted', editAfterBusy.status === 200, editAfterBusy.data);
await api('PUT', `${appPath}/sections/s2`, { token: tokenA, json: { text: s2Before.current_draft } });

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

/**
 * A job context for calling a handler directly with a stub Claude. clock.left is
 * the time left before the step's cutoff (each Claude call spends clock.perCall),
 * like a direct-mode step inside one Netlify request.
 */
function stubContext(
  fail: (prompt: string) => Error | null,
  target: { id: string; correlation_id: string } = app,
  clock: { left: number; perCall: number } = { left: 10 * 60_000, perCall: 0 },
) {
  const answer = (promptId: string) => FIXTURES[promptId] ?? '{}';
  return {
    job: {} as never,
    userId: userA,
    input: { app_id: target.id, section_id: null },
    correlationId: target.correlation_id,
    applicationId: target.id,
    mode: 'local',
    deadline: Date.now() + clock.left,
    timeLeftMs: () => Math.max(0, clock.left),
    claude: async () => ({
      call: async (options: { promptId: string; prompt: string }) => {
        clock.left -= clock.perCall;
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
  'one section failing does not lose the others: each saved, clear summary (a redraft that failed keeps its old text: use Redraft)',
  partialError.status === 503 &&
    partialError.detail ===
      'Drafted and saved 3 of 4 sections. Not drafted: "Statement of Need" (Claude is overloaded right now. Wait a minute and try again.). ' +
        'The saved sections are kept. To finish, run drafting again with the Redraft button on "Statement of Need" (it keeps its earlier text until then).' &&
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

let failedAndOutOfTime: { status?: number; detail?: string; __continue?: unknown } = {};
const shortClock = { left: 45_000, perCall: 8_000 };
try {
  const partResult = await handlers.writerJobs['writer.draft'](
    stubContext(
      (prompt) =>
        prompt.includes('SECTION: Statement of Need') ? new errors.ClaudeError('overloaded', 503, 'Claude is overloaded right now. Wait a minute and try again.', false) : null,
      app,
      shortClock,
    ) as never,
  );
  failedAndOutOfTime = { __continue: (partResult as { __continue?: unknown }).__continue };
} catch (error) {
  failedAndOutOfTime = error as { status?: number; detail?: string };
}
check(
  'a part where a section failed reports the failure (today\'s message) and does not continue, even with sections not started for time',
  failedAndOutOfTime.__continue === undefined && failedAndOutOfTime.status === 503 &&
    /^Drafted and saved 2 of 4 sections\. Not drafted: "Statement of Need" \(Claude is overloaded right now\. Wait a minute and try again\.\); "Evaluation and Sustainability" \(not started: no time left in this step\)\. The saved sections are kept\. To finish, run drafting again/.test(
      failedAndOutOfTime.detail ?? '',
    ),
  failedAndOutOfTime,
);

// The automatic tighten pass fails (Claude busy, or the step's time limit): the revision is kept, flagged.
const OVER_LIMIT_TEXT = Array.from({ length: 60 }, () => 'Our families pray, learn, and serve together every day.').join(' ');
let refineCallNo = 0;
const answerOf = (text: string) => ({ text, stopReason: 'end_turn', inputTokens: 1, outputTokens: 1, webSearches: 0, latencyMs: 1, costUsd: 0, model: 'stub', content: [] });
const tightenFails = {
  ...stubContext(() => null),
  input: { app_id: appId, section_id: 's1', instruction: 'Add more detail' },
  claude: async () => ({
    call: async (options: { promptId: string }) => {
      if (options.promptId !== 'section_refine_v1') return answerOf(FIXTURES[options.promptId] ?? '{}');
      refineCallNo += 1;
      if (refineCallNo === 2) {
        throw new errors.ClaudeError('timeout', 504, 'Claude was still working when this step reached its time limit. Run it again; work that finished was saved.', false);
      }
      return answerOf(JSON.stringify({ draft: OVER_LIMIT_TEXT }));
    },
  }),
};
const keptRevision = (await handlers.writerJobs['writer.refine'](tightenFails as never)) as { current_draft: string; over_limit: boolean; compliance_notes: string[] };
check(
  'a tighten pass that fails keeps the revision (saved, flagged OVER LIMIT) with a note on how to fix it',
  refineCallNo === 2 && keptRevision.current_draft === OVER_LIMIT_TEXT && keptRevision.over_limit === true &&
    keptRevision.compliance_notes.includes(writer.SECTION_NOTES.tightenFailed) &&
    (await writerRepo.getSectionDraft(userA, appId, 's1'))?.current_draft === OVER_LIMIT_TEXT,
  [refineCallNo, keptRevision.over_limit, keptRevision.compliance_notes],
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
// First drafting run with one failing section: "Draft missing sections" finishes it
// ---------------------------------------------------------------------------

const confirmFetch = await api('POST', `${fetchPath}/confirm-strategy`, { token: tokenA, json: { strategy: 'Lead with the reading lab.' } });
let firstRunError: { status?: number; detail?: string } = {};
try {
  await handlers.writerJobs['writer.draft'](
    stubContext(
      (prompt) =>
        prompt.includes('SECTION: Statement of Need') ? new errors.ClaudeError('overloaded', 503, 'Claude is overloaded right now. Wait a minute and try again.', false) : null,
      fetchApp,
    ) as never,
  );
} catch (error) {
  firstRunError = error as { status?: number; detail?: string };
}
const fetchState = (await api('GET', fetchPath, { token: tokenA })).data;
check(
  'first run, one section failing: the message says to use "Draft missing sections"',
  confirmFetch.status === 200 && firstRunError.status === 503 &&
    firstRunError.detail ===
      'Drafted and saved 3 of 4 sections. Not drafted: "Statement of Need" (Claude is overloaded right now. Wait a minute and try again.). ' +
        'The saved sections are kept. To finish, run drafting again with "Draft missing sections" (only the unfinished sections are drafted).' &&
    /Drafted and saved [1-3] of 4 sections/.test(firstRunError.detail) && /run drafting again/i.test(firstRunError.detail),
  firstRunError,
);
check(
  '...and the section that was not drafted is in missing_sections (so the page offers that button)',
  fetchState.sections.length === 3 && JSON.stringify(fetchState.missing_sections) === JSON.stringify([{ id: 's2', title: 'Statement of Need' }]),
  [fetchState.sections.length, fetchState.missing_sections],
);
const finishMissing = await run('POST', `${fetchPath}/draft`, tokenA, { only_missing: true });
const fetchFinished = (await api('GET', fetchPath, { token: tokenA })).data;
check(
  '"Draft missing sections" drafts just that section; nothing is missing afterwards',
  finishMissing.status === 200 && finishMissing.data.sections.length === 1 && finishMissing.data.sections[0].section_id === 's2' &&
    fetchFinished.missing_sections.length === 0 && fetchFinished.sections.length === 4,
  [finishMissing.status, finishMissing.data, fetchFinished.missing_sections],
);

// ---------------------------------------------------------------------------
// Stakeholder requests again: only open gaps that no request covers yet
// ---------------------------------------------------------------------------

const downPath = `/api/writer/applications/${downApp.id}`;
const testGap = (id: string, status: GapStatus, description: string): Gap => ({
  id,
  application_id: downApp.id,
  criterion_ref: 'c1',
  description,
  severity: 'medium',
  suggested_owner_role: 'Finance',
  status,
  answer: status === 'answered' ? 'Grades K-8: 214 students.' : null,
});
const testRequest = (id: string, gapIds: string[]) => ({
  id,
  application_id: downApp.id,
  stakeholder_role: 'Finance',
  gap_ids: gapIds,
  framing: 'Earlier request.',
  questions: ['Earlier question?'],
  expected_format: 'A few sentences is fine.',
  suggested_deadline: null,
  email_packet: 'Hi [Staff Name], an earlier request.',
  status: 'draft',
  response: null,
});
await writerRepo.saveGaps(userA, downApp.id, [
  testGap('gap_askedopen1', 'open', 'Audited financial statements'), // open, but an earlier request already asks about it
  testGap('gap_routed0001', 'routed', 'Board list with minutes'),
  testGap('gap_answered01', 'answered', 'Enrollment by grade'),
  testGap('gap_brandnew01', 'open', 'Name and experience of the project lead'), // open and not asked yet
]);
await writerRepo.updateIntakeRequests(userA, downApp.id, () => [testRequest('intake_earlier001', ['gap_askedopen1', 'gap_routed0001', 'gap_answered01'])]);
await mock.fixtures({
  intake_packets_v1: JSON.stringify([
    { stakeholder_role: 'Principal', gap_ids: ['gap_askedopen1', 'gap_routed0001', 'gap_answered01', 'gap_brandnew01'], framing: 'Who leads it?', questions: ['Who will lead the project?'], email_packet: EMAIL },
  ]),
});
const secondRound = await run('POST', `${downPath}/intake/generate`, tokenA);
const secondPrompt = await lastPrompt('intake_packets_v1');
const downState = (await api('GET', downPath, { token: tokenA })).data;
const downStatus = Object.fromEntries(downState.gaps.map((g: { id: string; status: string }) => [g.id, g.status]));
check(
  'second round: a new request only for the open gap no request covers yet',
  secondRound.status === 200 && secondRound.data.intake_requests.length === 1 &&
    JSON.stringify(secondRound.data.intake_requests[0].gap_ids) === '["gap_brandnew01"]',
  secondRound.data,
);
check(
  '...only that gap reaches Claude',
  secondPrompt.includes('gap_brandnew01') && !secondPrompt.includes('gap_askedopen1') && !secondPrompt.includes('gap_routed0001') && !secondPrompt.includes('gap_answered01'),
  secondPrompt.slice(0, 300),
);
check(
  '...no duplicate requests; the already-asked open gap is marked asked; answered stays answered',
  downState.intake_requests.length === 2 && downStatus.gap_askedopen1 === 'routed' && downStatus.gap_brandnew01 === 'routed' &&
    downStatus.gap_routed0001 === 'routed' && downStatus.gap_answered01 === 'answered',
  [downState.intake_requests.length, downStatus],
);
const nothingOpen = await api('POST', `${downPath}/intake/generate`, { token: tokenA });
check(
  'with no open gap left, generating again writes nothing (no job, no new request)',
  nothingOpen.status === 200 && nothingOpen.data.intake_requests.length === 0 && (await writerRepo.getIntakeRequests(userA, downApp.id)).length === 2,
  nothingOpen.data,
);
await writerRepo.updateGaps(userA, downApp.id, (current) => current.map((g): Gap => (g.id === 'gap_askedopen1' ? { ...g, status: 'open' } : g)));
const coveredOnly = await api('POST', `${downPath}/intake/generate`, { token: tokenA });
check(
  'when every open gap already has a request: no Claude call, the gap is marked asked, a note says so',
  coveredOnly.status === 200 && coveredOnly.data.intake_requests.length === 0 &&
    coveredOnly.data.note === 'Every open gap already has a stakeholder request. Record their answers on the requests below.' &&
    (await writerRepo.getGaps(userA, downApp.id)).find((g) => g.id === 'gap_askedopen1')?.status === 'routed',
  coveredOnly.data,
);
await restore('intake_packets_v1');

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
const s1BeforeOther = (await writerRepo.getSectionDraft(userA, appId, 's1'))?.current_draft;
const notMineEdit = await api('PUT', `${appPath}/sections/s1`, { token: tokenB, json: { text: 'Text from another account.' } });
check(
  "someone else's application can't be edited by hand (404, nothing saved)",
  notMineEdit.status === 404 && notMineEdit.data.detail === 'Application not found' &&
    (await writerRepo.getSectionDraft(userA, appId, 's1'))?.current_draft === s1BeforeOther,
  notMineEdit.data,
);

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
// 4.2b Funder history: notes, files and web research -> funder profile -> fit, draft, score
// ---------------------------------------------------------------------------

const FUNDER_FIXTURES: Record<string, unknown> = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'tests', 'mock-claude', 'fixtures', 'funder.json'), 'utf8'),
);
const restoreFunder = (...ids: string[]) => mock.fixtures(Object.fromEntries(ids.map((id) => [id, FUNDER_FIXTURES[id]])));
const directMode = process.env.GRANTFINDER_JOB_MODE === 'direct';
const callsSince = async (promptId: string, before: number) => (await mock.requests()).slice(before).filter((r) => r.prompt_id === promptId);
const requestCount = async () => (await mock.requests()).length;
const FM = writer.FUNDER_MESSAGES;

// Its own account, so the counts and logs checked for user A elsewhere stay as they were.
const tokenD = await guest();
await saveKey(tokenD);
const userD: string = (await api('GET', '/api/auth/me', { token: tokenD })).data.id;
await repo.saveProfile(userD, profileFor(userD));
await repo.saveGrants(userD, [
  makeGrant(userD, 'grant_funder', {
    grant_name: 'Literacy Seed Grant',
    funder: '[Funder Name]',
    amount: '$5,000 to $25,000',
    description: 'Catholic elementary education in Texas.',
    deadline: 'Rolling',
  }),
  makeGrant(userD, 'grant_funder_blank', { grant_name: 'Blank Funder Grant', funder: '[Other Funder Name]', deadline: 'Rolling' }),
]);
const funderApp = (await api('POST', '/api/writer/applications', { token: tokenD, json: { grant_id: 'grant_funder' } })).data;
const funderPath = `/api/writer/applications/${funderApp.id}`;
const funderSpec = await run('POST', `${funderPath}/grant-spec`, tokenD, { guidelines_text: 'Literacy seed grant: background, need, project, evaluation.' });
check('funder app: requirements ready', funderSpec.status === 200, funderSpec.data);

// --- Routes: sign-in, validation, ownership, key, nothing to build from
let mark = await requestCount();
const fpUnauth = await api('POST', `${funderPath}/funder-profile`, { json: { notes_text: 'x' } });
const fpUnauthUpload = await api('POST', `${funderPath}/funder-profile/upload`, { form: new FormData() });
const fpUnauthDelete = await api('DELETE', `${funderPath}/funder-profile/files/a.txt`);
check('funder routes need sign-in (401)', [fpUnauth, fpUnauthUpload, fpUnauthDelete].every((r) => r.status === 401), [fpUnauth.status, fpUnauthUpload.status, fpUnauthDelete.status]);
const fpUnknownApp = await api('POST', '/api/writer/applications/app_nope/funder-profile', { token: tokenD, json: { notes_text: 'x' } });
check('funder profile for an unknown application -> 404', fpUnknownApp.status === 404 && fpUnknownApp.data.detail === 'Application not found', fpUnknownApp.data);
const fpBadNotes = await api('POST', `${funderPath}/funder-profile`, { token: tokenD, json: { notes_text: 42 } });
const fpBadFlag = await api('POST', `${funderPath}/funder-profile`, { token: tokenD, json: { notes_text: 'x', research_web: 'maybe' } });
check(
  'notes_text must be text and research_web true or false (422)',
  fpBadNotes.status === 422 && fpBadNotes.data.detail === 'Field "notes_text" must be text.' &&
    fpBadFlag.status === 422 && fpBadFlag.data.detail === 'Field "research_web" must be true or false.',
  [fpBadNotes.data, fpBadFlag.data],
);
const fpNothing = await api('POST', `${funderPath}/funder-profile`, { token: tokenD, json: { notes_text: '   ' } });
check('nothing to build from (no notes, files or research) -> 400 that says what to add', fpNothing.status === 400 && fpNothing.data.detail === FM.noMaterial, fpNothing.data);
check('...and no Claude call was made for any of these', (await requestCount()) === mark, (await mock.requests()).slice(mark).map((r) => r.prompt_id));

// --- Build from pasted notes
const FUNDER_NOTES =
  'NOTES-MARKER-5521 From the 2023 990-PF: [Other School Name] received $15,000 for K-3 reading intervention; ' +
  '[Parish Name] Food Pantry received $8,000 for weekend meal bags. The program officer said they like measurable reading gains.';
mark = await requestCount();
const fpBuilt = await run('POST', `${funderPath}/funder-profile`, tokenD, { notes_text: FUNDER_NOTES });
const fpView = fpBuilt.data?.funder_profile;
const fpProfile = fpView?.profile;
const fpProfileCalls = await callsSince('funder_profile_v1', mark);
check(
  'Build Funder Profile: one funder_profile_v1 call (no tools, no web research); the profile is saved and returned',
  fpBuilt.status === 200 && String(fpProfile?.summary).includes('FUNDER-SUMMARY-MARKER') && fpProfileCalls.length === 1 &&
    fpProfileCalls[0].tools.length === 0 && (await callsSince('funder_research_v1', mark)).length === 0,
  [fpBuilt.status, fpBuilt.data, fpProfileCalls.length],
);
const fpPrompt = fpProfileCalls[0]?.prompt ?? '';
check(
  'the profile prompt holds the pasted notes, the grant record, the extracted requirements and the applicant',
  fpPrompt.includes('=== Pasted notes ===\nNOTES-MARKER-5521') && fpPrompt.includes('"grant_name": "Literacy Seed Grant"') &&
    fpPrompt.includes('"funder": "[Funder Name]"') && fpPrompt.includes('WHAT THE GUIDELINES ASK FOR (already extracted):') &&
    fpPrompt.includes('"funder_priorities": [') && fpPrompt.includes('"organization_name": "[School Name]"') &&
    fpPrompt.includes('Never invent grantees'),
  fpPrompt.slice(0, 400),
);
const fpComparables: Array<{ recipient: string; year: string | null; amount: string | null; verified: boolean }> = fpProfile?.comparable_grants ?? [];
check(
  'never invented: comparable grants that name no recipient ("" or "unknown") are dropped',
  fpComparables.length === 3 && !JSON.stringify(fpProfile).includes('INVENTED-NO-RECIPIENT-MARKER') &&
    !JSON.stringify(fpProfile).includes('INVENTED-UNKNOWN-RECIPIENT-MARKER'),
  fpComparables,
);
check(
  'recipients found word for word in the material are verified; one that is not stays visible, flagged',
  fpComparables.find((c) => c.recipient === '[Other School Name]')?.verified === true &&
    fpComparables.find((c) => c.recipient === '[Parish Name] Food Pantry')?.verified === true &&
    fpComparables.find((c) => c.recipient === '[Unlisted School Name]')?.verified === false,
  fpComparables,
);
check(
  'numbers become text: year 2024 -> "2024", amount 8000 -> "$8,000", 40 grants a year -> "40"; a priority given as text is kept',
  fpComparables[0]?.year === '2024' && fpComparables[1]?.amount === '$8,000' && fpProfile?.giving_patterns.grants_per_year === '40' &&
    fpProfile?.priorities.length === 3 && fpProfile?.priorities[2].priority === 'Tuition assistance (inferred)',
  [fpComparables, fpProfile?.giving_patterns, fpProfile?.priorities],
);
check(
  'ask recommendation kept with its rationale; sources: "pasted notes" plus only sources found in the material',
  fpProfile?.ask_recommendation?.range === '$12,000 to $18,000' && /ASK-MARKER/.test(fpProfile?.ask_recommendation?.rationale ?? '') &&
    JSON.stringify(fpProfile?.sources) === JSON.stringify(['pasted notes']),
  fpProfile?.sources,
);
const fpState1 = (await api('GET', funderPath, { token: tokenD })).data;
check(
  'GET state: funder_profile has the notes, files, research size and profile; not out of date; no fit analysis yet',
  fpState1.funder_profile?.notes_text === FUNDER_NOTES && fpState1.funder_profile.source_files.length === 0 &&
    fpState1.funder_profile.research_chars === 0 && fpState1.funder_profile.profile_outdated === false &&
    fpState1.funder_profile.profile?.summary === fpProfile?.summary && fpState1.funder_profile_newer_than_fit === false,
  fpState1.funder_profile,
);
const mainState = (await api('GET', appPath, { token: tokenA })).data;
check('an application with no funder history: funder_profile null, nothing newer than its fit', mainState.funder_profile === null && mainState.funder_profile_newer_than_fit === false, [mainState.funder_profile, mainState.funder_profile_newer_than_fit]);

// --- Add a file: the text is kept on the record (never sent back) and the profile is built again with it
const textFile = (name: string, text: string) => {
  const form = new FormData();
  form.append('file', new File([text], name, { type: 'text/plain' }));
  return form;
};
const REPORT = 'ANNUAL-REPORT-MARKER Grants paid in 2024: [Other School Name], $15,000, reading intervention. [Third School Name], $25,000, science lab.';
const reportForm = textFile('annual-report.txt', REPORT);
reportForm.append('notes_text', FUNDER_NOTES);
mark = await requestCount();
const fpUploaded = await finishJob(await api('POST', `${funderPath}/funder-profile/upload`, { token: tokenD, form: reportForm }), tokenD);
const uploadPrompt = (await callsSince('funder_profile_v1', mark))[0]?.prompt ?? '';
check(
  'Add a file: the text file is added and the profile is built again from notes and file',
  fpUploaded.status === 200 && fpUploaded.data.funder_profile.source_files.length === 1 &&
    fpUploaded.data.funder_profile.source_files[0].name === 'annual-report.txt' && fpUploaded.data.funder_profile.source_files[0].chars === REPORT.length &&
    uploadPrompt.includes(`=== File: annual-report.txt ===\n${REPORT}`) && uploadPrompt.includes('NOTES-MARKER-5521'),
  [fpUploaded.status, fpUploaded.data, uploadPrompt.slice(0, 200)],
);
const fpStateAfterFile = await api('GET', funderPath, { token: tokenD });
check(
  'file texts never go back to the website (state and step result hold names and sizes only)',
  !JSON.stringify(fpUploaded.data).includes('ANNUAL-REPORT-MARKER') && !fpStateAfterFile.text.includes('ANNUAL-REPORT-MARKER') &&
    (await writerRepo.getFunderRecord(userD, 'grant_funder'))?.source_files[0].text === REPORT,
);

mark = await requestCount();
const pngForm = new FormData();
pngForm.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'photo.png', { type: 'image/png' }));
const fpPng = await api('POST', `${funderPath}/funder-profile/upload`, { token: tokenD, form: pngForm });
const fpEmpty = await api('POST', `${funderPath}/funder-profile/upload`, { token: tokenD, form: textFile('empty.txt', '') });
const fpNoFile = await api('POST', `${funderPath}/funder-profile/upload`, { token: tokenD, form: new FormData() });
const fpNotMultipart = await api('POST', `${funderPath}/funder-profile/upload`, { token: tokenD, json: { file: 'x' } });
const brokenDocx = new FormData();
brokenDocx.append('file', new File(['not really a word file'], 'notes.docx'));
const fpBadDocx = await api('POST', `${funderPath}/funder-profile/upload`, { token: tokenD, form: brokenDocx });
const fpHuge = await api('POST', `${funderPath}/funder-profile/upload`, { token: tokenD, form: textFile('huge.txt', 'a'.repeat(10 * 1024 * 1024 + 1)) });
check(
  'bad files are refused at once: wrong type (400), empty (400), no file (422), not a form (422), unreadable Word file (400), too large (413)',
  fpPng.status === 400 && fpPng.data.detail === 'Invalid file type. Allowed: .pdf, .docx, .txt' &&
    fpEmpty.status === 400 && fpEmpty.data.detail === '"empty.txt" is empty (0 bytes). Check that you picked the right file.' &&
    fpNoFile.status === 422 && fpNoFile.data.detail === 'No file was uploaded. Choose a PDF, Word (.docx), or text (.txt) file and try again.' &&
    fpNotMultipart.status === 422 && fpBadDocx.status === 400 && /Couldn't open "notes\.docx" as a Word document/.test(fpBadDocx.data.detail) &&
    fpHuge.status === 413 && fpHuge.data.detail === 'File is too large (10.1 MB). The limit is 10 MB. Upload a smaller file, or save just the pages that matter as a new PDF.',
  [fpPng.data, fpEmpty.data, fpNoFile.data, fpNotMultipart.data, fpBadDocx.data, fpHuge.data],
);
check(
  '...nothing was saved and no Claude call was made for them',
  (await writerRepo.getFunderRecord(userD, 'grant_funder'))?.source_files.length === 1 && (await requestCount()) === mark,
  (await mock.requests()).slice(mark).map((r) => r.prompt_id),
);

// At most six files; a file with the same name replaces the earlier one.
const extraNames = ['extra 1.txt', 'extra 2.txt', 'extra 3.txt', 'extra 4.txt', 'extra 5.txt'];
await writerRepo.updateFunderRecord(userD, 'grant_funder', (current) =>
  current
    ? {
        ...current,
        source_files: [
          ...current.source_files,
          ...extraNames.map((name) => ({ name, chars: 10, text: `Extra ${name}`, added_at: new Date().toISOString() })),
        ],
      }
    : undefined,
);
const fpSeventh = await api('POST', `${funderPath}/funder-profile/upload`, { token: tokenD, form: textFile('seventh.txt', 'One file too many.') });
check(`a seventh file is refused (at most ${writer.FUNDER_MAX_FILES})`, fpSeventh.status === 400 && fpSeventh.data.detail === FM.tooManyFiles, fpSeventh.data);
const REPORT_2 = 'ANNUAL-REPORT-2-MARKER Grants paid in 2025: [Other School Name], $16,000, reading intervention.';
const fpReplaced = await finishJob(await api('POST', `${funderPath}/funder-profile/upload`, { token: tokenD, form: textFile('annual-report.txt', REPORT_2) }), tokenD);
const filesNow = (await writerRepo.getFunderRecord(userD, 'grant_funder'))?.source_files ?? [];
check(
  'a file with the same name replaces the earlier one (still six files); notes not sent are kept',
  fpReplaced.status === 200 && filesNow.length === 6 && filesNow.filter((file) => file.name === 'annual-report.txt').length === 1 &&
    filesNow.find((file) => file.name === 'annual-report.txt')?.text === REPORT_2 &&
    (await writerRepo.getFunderRecord(userD, 'grant_funder'))?.notes_text === FUNDER_NOTES,
  [fpReplaced.status, filesNow.map((file) => file.name)],
);
const fpRemoved = await api('DELETE', `${funderPath}/funder-profile/files/${encodeURIComponent('extra 1.txt')}`, { token: tokenD });
const fpRemovedAgain = await api('DELETE', `${funderPath}/funder-profile/files/${encodeURIComponent('extra 1.txt')}`, { token: tokenD });
check(
  'removing a file: 200 with the record (file gone, profile now out of date); removing it again -> 404',
  fpRemoved.status === 200 && fpRemoved.data.source_files.length === 5 && !fpRemoved.data.source_files.some((file: { name: string }) => file.name === 'extra 1.txt') &&
    fpRemoved.data.profile_outdated === true && fpRemovedAgain.status === 404 && fpRemovedAgain.data.detail === FM.fileNotFound,
  [fpRemoved.status, fpRemoved.data, fpRemovedAgain.data],
);
for (const name of extraNames.slice(1)) await api('DELETE', `${funderPath}/funder-profile/files/${encodeURIComponent(name)}`, { token: tokenD });
const fpNotMineFile = await api('DELETE', `${funderPath}/funder-profile/files/annual-report.txt`, { token: tokenB });
check("another account can't remove this application's funder files (404)", fpNotMineFile.status === 404 && (await writerRepo.getFunderRecord(userD, 'grant_funder'))?.source_files.length === 1, fpNotMineFile.data);

// --- Research the web and build: funder_research_v1 (web search) -> __continue -> funder_profile_v1
mark = await requestCount();
const fpResearched = await run('POST', `${funderPath}/funder-profile`, tokenD, { notes_text: FUNDER_NOTES, research_web: true });
const sinceResearch = (await mock.requests()).slice(mark);
const researchCall = sinceResearch.find((r) => r.prompt_id === 'funder_research_v1');
const buildCall = sinceResearch.find((r) => r.prompt_id === 'funder_profile_v1');
check(
  'Research the web and build: a web search call first, then the profile build (the research step continues to it)',
  fpResearched.status === 200 && Boolean(researchCall && buildCall) && sinceResearch.indexOf(researchCall!) < sinceResearch.indexOf(buildCall!) &&
    researchCall!.tools.length === 1 && researchCall!.tools[0] === 'web_search_20260209' && buildCall!.tools.length === 0,
  sinceResearch.map((r) => [r.prompt_id, r.tools]),
);
check(
  'the research prompt names the funder and the grant, asks for past grantees with source URLs, and caps the searches for this mode',
  Boolean(researchCall?.prompt.includes('FUNDER: [Funder Name]') && researchCall.prompt.includes('GRANT: Literacy Seed Grant') &&
    researchCall.prompt.includes('990-PF') && researchCall.prompt.includes(`at most ${directMode ? 3 : 6} searches`) &&
    researchCall.prompt.includes('NOTHING FOUND')),
  researchCall?.prompt.slice(0, 300),
);
const researchedView = fpResearched.data?.funder_profile;
check(
  'the findings and their source URLs are saved, and the build reads them',
  researchedView?.research_chars > 200 &&
    JSON.stringify(researchedView?.research_sources) ===
      JSON.stringify(['https://example.org/funder/about', 'https://example.org/funder/annual-report-2024', 'https://example.org/funder/990pf-2023.pdf']) &&
    Boolean(buildCall?.prompt.includes('=== Web research') && buildCall.prompt.includes('RESEARCH-FINDINGS-MARKER')),
  [researchedView?.research_chars, researchedView?.research_sources],
);
check(
  'sources now list the notes, the file and the research URLs (a made-up URL is still left out)',
  JSON.stringify(researchedView?.profile?.sources) ===
    JSON.stringify(['pasted notes', 'annual-report.txt', 'https://example.org/funder/about', 'https://example.org/funder/annual-report-2024', 'https://example.org/funder/990pf-2023.pdf']),
  researchedView?.profile?.sources,
);
const researchJob = (await jobsModule.listJobs(userD, 100)).find((job) => job.kind === 'writer.funder_research');
check(
  'the research step notes its search cap for this mode, and hands over to the build route',
  Boolean(researchJob?.notes.some((note) => note.includes(`Funder research: at most ${directMode ? 3 : 6} web searches`))) &&
    (researchJob?.result as { __continue?: { path?: string; body?: unknown } })?.__continue?.path === `${funderPath}/funder-profile` &&
    JSON.stringify((researchJob?.result as { __continue?: { body?: unknown } })?.__continue?.body) === JSON.stringify({ research_web: false }),
  [researchJob?.notes, researchJob?.result],
);

// Research that finds nothing: built from what was already there, and says so; with nothing at all, a plain message.
await mock.fixtures({ funder_research_v1: { text: 'NOTHING FOUND', web_searches: 1 } });
const researchBefore = (await writerRepo.getFunderRecord(userD, 'grant_funder'))?.research_notes;
const fpNothingNew = await run('POST', `${funderPath}/funder-profile`, tokenD, { research_web: true });
check(
  'research that finds nothing still builds from the notes, files and earlier research, and says so (earlier research kept)',
  fpNothingNew.status === 200 && fpNothingNew.data.note === FM.researchNothingKept &&
    (await writerRepo.getFunderRecord(userD, 'grant_funder'))?.research_notes === researchBefore,
  [fpNothingNew.status, fpNothingNew.data?.note],
);
const blankApp = (await api('POST', '/api/writer/applications', { token: tokenD, json: { grant_id: 'grant_funder_blank' } })).data;
const blankPath = `/api/writer/applications/${blankApp.id}`;
mark = await requestCount();
const fpBlank = await run('POST', `${blankPath}/funder-profile`, tokenD, { notes_text: '', research_web: true });
check(
  'research that finds nothing, with nothing else to build from -> a plain message; no profile call, nothing saved',
  fpBlank.status === 422 && fpBlank.data.detail === FM.researchNothing && (await callsSince('funder_profile_v1', mark)).length === 0 &&
    (await writerRepo.getFunderRecord(userD, 'grant_funder_blank')) === null,
  [fpBlank.status, fpBlank.data],
);
await restoreFunder('funder_research_v1');
await mock.fail('funder_research_v1', 400, 'invalid_request_error', 1);
mark = await requestCount();
const fpRetried = await run('POST', `${blankPath}/funder-profile`, tokenD, { notes_text: 'BLANK-NOTES-MARKER [Other School Name] received $5,000.', research_web: true });
const retryCalls = await callsSince('funder_research_v1', mark);
check(
  'a web search tool the account rejects is retried once with the basic tool, then the build runs',
  fpRetried.status === 200 && retryCalls.length === 2 && retryCalls[0].tools[0] === 'web_search_20260209' && retryCalls[1].tools[0] === 'web_search_20250305',
  [fpRetried.status, fpRetried.data, retryCalls.map((r) => r.tools)],
);

// --- The funder history reaches the fit analysis, drafting and scoring
mark = await requestCount();
const fpFit = await run('POST', `${funderPath}/analyze`, tokenD);
const fpFitPrompt = (await callsSince('fit_gap_v1', mark))[0]?.prompt ?? '';
check(
  'fit analysis prompt: FUNDER HISTORY with the summary, comparable grants found in the material, exclusions, process, ask and positioning',
  fpFit.status === 200 && fpFitPrompt.includes('FUNDER HISTORY (what this funder has actually funded') && fpFitPrompt.includes('FUNDER-SUMMARY-MARKER') &&
    fpFitPrompt.includes('"recipient": "[Other School Name]"') && !fpFitPrompt.includes('[Unlisted School Name]') &&
    fpFitPrompt.includes('EXCLUSION-MARKER') && fpFitPrompt.includes('PROCESS-MARKER') && fpFitPrompt.includes('ASK-MARKER') &&
    fpFitPrompt.includes('POSITIONING-MARKER'),
  fpFitPrompt.slice(fpFitPrompt.indexOf('FUNDER HISTORY'), fpFitPrompt.indexOf('FUNDER HISTORY') + 300),
);
check(
  '...and asks for a strategy that matches it, a "funder_history" fit entry, and gaps for process requirements and exclusions',
  fpFitPrompt.includes('The recommended_strategy must say how to match it') && fpFitPrompt.includes('criterion_id "funder_history"') &&
    fpFitPrompt.includes('Use severity "high" when an exclusion clearly applies'),
);
check(
  'without a funder history the fit, drafting and scoring prompts are unchanged (no FUNDER HISTORY block)',
  !fitPrompt.includes('FUNDER HISTORY') && draftPrompts.length > 0 && draftPrompts.every((p) => !p.includes('FUNDER HISTORY')) &&
    !scorePrompt.includes('FUNDER HISTORY') && !fitPrompt.includes('funder_history'),
);
const fpAfterFit = (await api('GET', funderPath, { token: tokenD })).data;
check('a fit analysis made after the profile: funder_profile_newer_than_fit is false', fpAfterFit.funder_profile_newer_than_fit === false, fpAfterFit.funder_profile_newer_than_fit);
await api('POST', `${funderPath}/confirm-strategy`, { token: tokenD, json: { strategy: 'FUNDER-STRATEGY-MARKER Lead with early literacy.' } });
for (const gap of fpAfterFit.gaps ?? []) {
  if (gap.severity === 'high') await api('PUT', `${funderPath}/gaps/${gap.id}/waive`, { token: tokenD, json: { reason: 'test' } });
}
mark = await requestCount();
const fpDrafted = await run('POST', `${funderPath}/draft`, tokenD, { section_id: 's1' });
const fpDraftPrompt = (await callsSince('section_draft_v1', mark))[0]?.prompt ?? '';
check(
  'drafting prompt: funder history for emphasis (positioning, comparable grants found in the material, the ask), never the unverified one',
  fpDrafted.status === 200 && fpDraftPrompt.includes('FUNDER HISTORY (emphasize what this funder demonstrably funds') &&
    fpDraftPrompt.includes('POSITIONING-MARKER') && fpDraftPrompt.includes('"recipient": "[Other School Name]"') &&
    fpDraftPrompt.includes('"range": "$12,000 to $18,000"') && !fpDraftPrompt.includes('[Unlisted School Name]') &&
    !fpDraftPrompt.includes('UNVERIFIED-COMPARABLE-MARKER') && !fpDraftPrompt.includes('NOTES-MARKER-5521'),
  fpDraftPrompt.slice(fpDraftPrompt.indexOf('FUNDER HISTORY'), fpDraftPrompt.indexOf('FUNDER HISTORY') + 400),
);
check(
  "drafting prompt: the funder's language cues are added to the guidelines' (each once), and it never claims a relationship or past funding",
  fpDraftPrompt.includes(
    'FUNDER LANGUAGE CUES (mirror naturally, no keyword stuffing): ["breaking the cycle of poverty", "seed money", "ripple effect", "Catholic institutions", "early literacy", "Catholic identity", "FUNDER-CUE-MARKER"]',
  ) &&
    fpDraftPrompt.includes(
      '- Never say or imply that the organization has a relationship with [Funder Name] or was funded by it before, unless the ORGANIZATION PROFILE says so.',
    ) && fpDraftPrompt.includes("don't name the funder's other grantees"),
  fpDraftPrompt.slice(fpDraftPrompt.indexOf('FUNDER LANGUAGE CUES'), fpDraftPrompt.indexOf('FUNDER LANGUAGE CUES') + 300),
);
const fpDraftJob = (await jobsModule.listJobs(userD, 100)).find((job) => job.kind === 'writer.draft' && job.application_id === funderApp.id);
check('the drafting step notes that the funder history was used', Boolean(fpDraftJob?.notes.some((note) => note.includes('Funder history included'))), fpDraftJob?.notes);
mark = await requestCount();
const fpScored = await run('POST', `${funderPath}/score`, tokenD);
const fpScorePrompt = (await callsSince('self_score_v1', mark))[0]?.prompt ?? '';
check(
  'self-score prompt: judged against the funder history and the ask against their typical range (top fix may be funder alignment)',
  fpScored.status === 200 && fpScorePrompt.includes('FUNDER HISTORY (what this funder has actually funded):') &&
    fpScorePrompt.includes('"typical_award": "$5,000 to $25,000"') && fpScorePrompt.includes('make it the top_fix') &&
    fpScorePrompt.includes('"recipient": "[Other School Name]"') && !fpScorePrompt.includes('[Unlisted School Name]'),
  fpScorePrompt.slice(fpScorePrompt.indexOf('FUNDER HISTORY'), fpScorePrompt.indexOf('FUNDER HISTORY') + 300),
);

// A profile built after the fit analysis: the page offers to re-run it, until it is re-run.
const fpRebuilt = await run('POST', `${funderPath}/funder-profile`, tokenD, {});
const fpNewer = (await api('GET', funderPath, { token: tokenD })).data;
check(
  'building the profile again after the fit analysis (notes not sent are kept): funder_profile_newer_than_fit is true',
  fpRebuilt.status === 200 && fpNewer.funder_profile_newer_than_fit === true && fpNewer.funder_profile.notes_text === FUNDER_NOTES &&
    fpNewer.funder_profile.profile_outdated === false,
  [fpRebuilt.status, fpNewer.funder_profile_newer_than_fit],
);
await run('POST', `${funderPath}/analyze`, tokenD);
const fpRefit = (await api('GET', funderPath, { token: tokenD })).data;
check('...and false again once the fit analysis is re-run', fpRefit.funder_profile_newer_than_fit === false, fpRefit.funder_profile_newer_than_fit);

const fpBundle = (await api('GET', `${funderPath}/debug-bundle`, { token: tokenD })).data?.bundle_markdown ?? '';
check(
  'debug bundle: one funder history line with sizes and counts, never the notes or file text',
  /- Funder history: notes \d+ chars, 1 file\(s\), web research \d+ chars \(3 source URLs\), profile yes \(3 comparable grant\(s\), 2 found in the material, ask suggested\)/.test(fpBundle) &&
    !fpBundle.includes('NOTES-MARKER-5521') && !fpBundle.includes('ANNUAL-REPORT') && fpBundle.includes('| funder_profile_v1 |') && fpBundle.includes('| funder_research_v1 |'),
  fpBundle.split('\n').find((line) => line.startsWith('- Funder history')),
);

// Pasted notes over the limit are cut, and the step says so.
const longNotes = `LONG-NOTES-MARKER ${'Grant to [Other School Name] for reading. '.repeat(1600)}`;
const fpLong = await run('POST', `${funderPath}/funder-profile`, tokenD, { notes_text: longNotes });
check(
  `pasted notes over ${writer.FUNDER_NOTES_LIMIT.toLocaleString('en-US')} characters are cut to the limit, and the result says so`,
  longNotes.length > writer.FUNDER_NOTES_LIMIT && fpLong.status === 200 && String(fpLong.data?.note).startsWith(FM.notesCut) &&
    (await writerRepo.getFunderRecord(userD, 'grant_funder'))?.notes_text.length === writer.FUNDER_NOTES_LIMIT,
  [fpLong.status, fpLong.data?.note],
);

// Another account, and an account without an API key
const fpNotMine = await api('POST', `${funderPath}/funder-profile`, { token: tokenB, json: { notes_text: 'x' } });
check("someone else's application: no funder profile (404)", fpNotMine.status === 404 && fpNotMine.data.detail === 'Application not found', fpNotMine.data);
const fpNoKey = await api('POST', `/api/writer/applications/${appB.data.id}/funder-profile`, { token: tokenB, json: { notes_text: 'x' } });
check(
  'missing API key -> 400 before anything is saved',
  fpNoKey.status === 400 && fpNoKey.data.detail === 'Claude API key not set. Please add your API key first.' &&
    (await writerRepo.getFunderRecord(userB, 'grant_kenedy')) === null,
  fpNoKey.data,
);

// Pure rules: comparables capped at ten, whole words only, no half an ask, no empty profile; research sources; fitting the material.
const manyComparables = JSON.stringify({
  summary: 'S',
  comparable_grants: Array.from({ length: 14 }, (_, i) => ({ recipient: `[School ${i + 1}]`, purpose: 'Reading' })),
  ask_recommendation: { range: '$5,000' },
});
const parsedMany = writer.parseFunderProfile(manyComparables, { searchable: 'school 1 school 2', sources: [] }, '2026-01-01T00:00:00.000Z');
check(
  'at most ten comparable grants; an ask without a rationale is left out; each recipient is looked up in the material',
  parsedMany?.profile.comparable_grants.length === 10 && parsedMany.profile.ask_recommendation === null &&
    parsedMany.profile.comparable_grants[0].verified === true && parsedMany.profile.comparable_grants[2].verified === false,
  parsedMany?.profile.comparable_grants.map((c) => [c.recipient, c.verified]),
);
const marySearch = writer.parseFunderProfile(JSON.stringify({ summary: 'S', comparable_grants: [{ recipient: 'Mary' }] }), { searchable: 'grants in maryland', sources: [] }, 't');
check('a name inside another word is not a match ("Mary" in "Maryland")', marySearch?.profile.comparable_grants[0].verified === false, marySearch?.profile.comparable_grants);
check(
  'an answer with no profile in it is refused (null), never saved as an empty profile',
  writer.parseFunderProfile('Sorry, I cannot help with that.', { searchable: '', sources: [] }, 't') === null &&
    writer.parseFunderProfile('{"summary": "", "priorities": [], "comparable_grants": []}', { searchable: '', sources: [] }, 't') === null,
);
check(
  'research sources: URLs in the text (trailing punctuation dropped) and in citations, each once, web addresses only',
  JSON.stringify(
    writer.researchSources('See https://example.org/a. Also (https://example.org/b), https://example.org/a and ftp://example.org/c', [
      { type: 'text', citations: [{ url: 'https://example.org/cited' }, { url: 'javascript:alert(1)' }] },
    ]),
  ) === JSON.stringify(['https://example.org/cited', 'https://example.org/a', 'https://example.org/b']),
);
const fitted = writer.funderMaterial(
  {
    ...writer.emptyFunderRecord('g', 't'),
    notes_text: 'short notes',
    research_notes: 'r'.repeat(30_000),
    source_files: [{ name: 'big.txt', chars: 100_000, text: 'b'.repeat(100_000), added_at: 't' }],
  },
  null,
  80_000,
);
check(
  'material that does not fit is shared fairly: short parts whole, the longest cut, and the cut is named',
  fitted.chars === 80_000 && JSON.stringify(fitted.cut) === JSON.stringify(['"big.txt"']) &&
    fitted.text.includes('=== File: big.txt (the first 49,989 of 100,000 characters) ===') && fitted.text.includes('=== Pasted notes ===\nshort notes'),
  [fitted.chars, fitted.cut, fitted.text.split('\n').filter((line) => line.startsWith('==='))],
);

// ---------------------------------------------------------------------------
// 4.2 Grant requirements from a guidelines file (POST .../grant-spec/upload)
// ---------------------------------------------------------------------------

const specFile = (name: string, text: string, pasted?: string) => {
  const form = textFile(name, text);
  if (pasted !== undefined) form.append('guidelines_text', pasted);
  return form;
};
const GUIDE_FILE = 'GUIDELINES-FILE-MARKER Required sections: Organization Background (250 words); Statement of Need (300 words). Scoring: need 50, fit 50.';
mark = await requestCount();
const gsUnauth = await api('POST', `${blankPath}/grant-spec/upload`, { form: specFile('guidelines.txt', GUIDE_FILE) });
const gsUnknown = await api('POST', '/api/writer/applications/app_nope/grant-spec/upload', { token: tokenD, form: specFile('guidelines.txt', GUIDE_FILE) });
const gsNoKey = await api('POST', `/api/writer/applications/${appB.data.id}/grant-spec/upload`, { token: tokenB, form: specFile('guidelines.txt', GUIDE_FILE) });
const gsPng = new FormData();
gsPng.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'guidelines.png', { type: 'image/png' }));
const gsBadType = await api('POST', `${blankPath}/grant-spec/upload`, { token: tokenD, form: gsPng });
const gsEmpty = await api('POST', `${blankPath}/grant-spec/upload`, { token: tokenD, form: specFile('guidelines.txt', '') });
const gsNoFile = await api('POST', `${blankPath}/grant-spec/upload`, { token: tokenD, form: new FormData() });
check(
  'guidelines file: sign-in (401), unknown application (404), API key (400), file type (400), empty (400) and no file (422) checked before any job',
  gsUnauth.status === 401 && gsUnknown.status === 404 && gsNoKey.status === 400 &&
    gsNoKey.data.detail === 'Claude API key not set. Please add your API key first.' &&
    gsBadType.status === 400 && gsBadType.data.detail === 'Invalid file type. Allowed: .pdf, .docx, .txt' &&
    gsEmpty.status === 400 && gsNoFile.status === 422 && (await requestCount()) === mark,
  [gsUnauth.status, gsUnknown.status, gsNoKey.data, gsBadType.data, gsEmpty.data, gsNoFile.data],
);
mark = await requestCount();
const gsFromFile = await finishJob(
  await api('POST', `${blankPath}/grant-spec/upload`, { token: tokenD, form: specFile('guidelines.txt', GUIDE_FILE, 'PASTED-FIRST-MARKER Deadline: rolling.') }),
  tokenD,
);
const gsPrompt = (await callsSince('grant_spec_v1', mark))[0]?.prompt ?? '';
check(
  'Add the guidelines as a file: the requirements are read from it (text pasted alongside first), with no "inferred" fallback',
  gsFromFile.status === 200 && (gsFromFile.data?.grant_spec?.required_sections?.length ?? 0) > 0 && gsFromFile.data?.note === null &&
    gsPrompt.includes(`FULL GUIDELINES TEXT:\nPASTED-FIRST-MARKER Deadline: rolling.\n\n${GUIDE_FILE}`) &&
    !gsPrompt.includes('No full guidelines provided') &&
    (await writerRepo.getGrantSpec(userD, 'grant_funder_blank'))?.guidelines_text?.startsWith('PASTED-FIRST-MARKER') === true,
  [gsFromFile.status, gsFromFile.data?.note, gsPrompt.slice(gsPrompt.indexOf('FULL GUIDELINES'), gsPrompt.indexOf('FULL GUIDELINES') + 200)],
);
const gsJob = (await jobsModule.listJobs(userD, 100)).find((job) => job.kind === 'writer.grant_spec' && job.application_id === blankApp.id);
check(
  'the step notes where the guidelines came from',
  gsJob?.notes.some((line) => line.includes('Guidelines from the file "guidelines.txt"')) === true,
  gsJob?.notes,
);
const longGuidelines = `LONG-GUIDELINES ${'Section rules and scoring details. '.repeat(2000)}`;
const gsLong = await finishJob(await api('POST', `${blankPath}/grant-spec/upload`, { token: tokenD, form: specFile('long.txt', longGuidelines) }), tokenD);
check(
  'a guidelines file over 60,000 characters: the first 60,000 are read, and the result says so',
  gsLong.status === 200 && String(gsLong.data?.note).startsWith('Only the first 60,000 characters of the guidelines were read') &&
    (await writerRepo.getGrantSpec(userD, 'grant_funder_blank'))?.guidelines_text?.length === 60_000,
  [gsLong.status, gsLong.data?.note],
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
