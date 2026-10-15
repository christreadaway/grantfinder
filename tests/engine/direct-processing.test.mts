/**
 * Direct job mode (the Netlify default, which works on every plan): each AI
 * step runs inside one request that Netlify stops at 60 seconds, so a step
 * cuts its Claude calls off at its budget (50 seconds; 5 here) and must
 * still finish cleanly. With a slow mock Claude, a slow fake parish website
 * and a slow fake Grants.gov, these checks show that matching, the website
 * scan, discovery, documents and the questionnaire end in time with honest
 * results.
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/direct-processing.test.mts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { api, call, check, finish, guest, saveKey, setupEnv, startMock } from './helpers.mts';

const BUDGET_MS = 5000;
/** A step may end a little after its budget: it saves and reports after the cutoff. */
const SLACK_MS = 1500;
setupEnv('direct-processing', {
  GRANTFINDER_JOB_MODE: 'direct',
  GRANTFINDER_DIRECT_JOB_BUDGET_MS: String(BUDGET_MS),
  GRANTFINDER_ALLOW_LOCAL_FETCH: '1',
});
const mock = await startMock();

const repo = await import('../../frontend/src/server/repo.ts');
const store = await import('../../frontend/src/server/store.ts');
const jobs = await import('../../frontend/src/server/jobs.ts');
const ai = await import('../../frontend/src/server/services/ai.ts');
const types = await import('../../frontend/src/server/types.ts');
const deadlines = await import('../../frontend/src/server/deadlines.ts');
/** An open deadline about six months after the suite's today (follows GRANTFINDER_TODAY in test mode). */
const OPEN_DEADLINE = deadlines.addDaysIso(deadlines.todayIso(), 180);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function userIdOf(token: string): Promise<string> {
  return (await api('GET', '/api/auth/me', { token })).data.id;
}

/** Poll a job the way the website does until it is done or failed. */
async function waitForJob(token: string, jobId: string, timeoutMs = 60000): Promise<Json> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const poll = await api('GET', `/api/jobs/${jobId}`, { token });
    if (poll.data?.status === 'done' || poll.data?.status === 'failed') return poll.data;
    await sleep(100);
  }
  throw new Error(`job ${jobId} did not finish in ${timeoutMs}ms`);
}

async function storedJob(userId: string, jobId: string | undefined): Promise<Json> {
  return jobId ? store.kv().get(jobs.jobKey(userId, jobId)) : null;
}

/** How long a finished job ran (started to finished), in ms. */
const ranFor = (job: Json): number => Date.parse(job?.finished_at) - Date.parse(job?.started_at);
const inTime = (job: Json): boolean => Number.isFinite(ranFor(job)) && ranFor(job) < BUDGET_MS + SLACK_MS;

async function requestsFor(promptId: string): Promise<Json[]> {
  return (await mock.requests()).filter((r) => r.prompt_id === promptId);
}

async function newUser(): Promise<{ token: string; userId: string }> {
  const token = await guest();
  await saveKey(token);
  return { token, userId: await userIdOf(token) };
}

function grant(userId: string, id: string, name: string) {
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
  };
}

async function matchingUser(count: number, prefix: string) {
  const user = await newUser();
  await repo.saveProfile(
    user.userId,
    types.normalizeProfile({ user_id: user.userId, organization_name: '[School Name]', organization_type: 'both', city: '[City]', state: 'TX', has_school: true }),
  );
  const grants = Array.from({ length: count }, (_, i) => grant(user.userId, `grant_${prefix}_${String(i).padStart(3, '0')}`, `Example ${prefix} Grant ${i}`));
  await repo.saveGrants(user.userId, grants as Json);
  // One answer that scores every grant; each batch picks out its own by id.
  const answer = JSON.stringify(
    grants.map((g, i) => ({
      grant_id: g.id,
      score: 40 + (i % 55),
      score_breakdown: { eligibility_fit: 80, need_alignment: 70, capacity_signals: 60, timing: 50, completeness: 40 },
      explanation: `Scored ${g.grant_name}`,
      evidence: [],
    })),
  );
  return { ...user, grants, answer };
}

// ===========================================================================
// 1. Matching: every batch at once, honest labels, follow-up parts
// ===========================================================================

const m = await matchingUser(100, 'dm');
await mock.reset();
await mock.fixtures({ grant_match_batch_v1: m.answer });
// Each scoring call takes 3 of the 5 seconds: one wave of 8 batches fits, a second doesn't.
await mock.delay('grant_match_batch_v1', 3000);
const startM = await api('POST', '/api/processing/match-grants', { token: m.token });
check(
  'match-grants in direct mode answers 202 {job_id, run: "direct"} (the website then runs it with POST /api/jobs/{id}/run)',
  startM.status === 202 && startM.data.run === 'direct' && /^job_/.test(startM.data.job_id),
  startM.data,
);
const part1 = await waitForJob(m.token, startM.data.job_id);
const part1Job = await storedJob(m.userId, startM.data.job_id);
const part1Matches: Json[] = part1.result?.matches ?? [];
const next = part1.result?.__continue;
check(
  'part 1: 8 batches scored at once inside the budget; the 2 batches that no longer fit are marked out of time (never sent to Claude)',
  part1.status === 'done' && part1Matches.length === 100 &&
    part1Matches.filter((x) => x.explanation.startsWith('Scored ')).length === 80 &&
    part1Matches.filter((x) => x.explanation === ai.NOT_SCORED_OUT_OF_TIME_DIRECT).length === 20 &&
    (await requestsFor('grant_match_batch_v1')).length === 8 && inTime(part1Job),
  { status: part1.status, ms: ranFor(part1Job), calls: (await requestsFor('grant_match_batch_v1')).length, error: part1.error },
);
check(
  'part 1 hands the website a follow-up request for the rest (__continue) and says so in the job notes',
  next?.path === '/api/processing/match-grants/continue' && next.body?.session_id === part1.result?.session_id && next.body?.part === 2 &&
    (part1Job?.notes ?? []).some((n: string) => /the other 20 will be scored in part 2/.test(n)),
  [next, part1Job?.notes],
);
const savedPart1 = await api('GET', `/api/processing/match-results/${part1.result?.session_id}`, { token: m.token });
check(
  'the saved results never contain __continue (only the job result does)',
  savedPart1.status === 200 && !('__continue' in savedPart1.data) && savedPart1.data.matches.length === 100,
  Object.keys(savedPart1.data ?? {}),
);

const finalM = await call('POST', next?.path ?? '/api/processing/match-grants/continue', { token: m.token, json: next?.body ?? {} });
const part2Job = await storedJob(m.userId, finalM.jobId);
const finalMatches: Json[] = finalM.data?.matches ?? [];
check(
  'part 2 scores the remaining 20 into the same results: all 100 AI-scored, sorted, tiers recounted, nothing left to continue',
  finalM.status === 200 && finalM.data.session_id === part1.result?.session_id && finalMatches.length === 100 &&
    finalMatches.every((x) => x.explanation.startsWith('Scored ')) && !finalM.data.__continue &&
    finalMatches.every((x, i) => i === 0 || finalMatches[i - 1].score >= x.score) &&
    finalM.data.excellent_matches === finalMatches.filter((x) => x.score >= 85).length &&
    finalM.data.not_eligible === finalMatches.filter((x) => x.score < 25).length &&
    (await requestsFor('grant_match_batch_v1')).length === 10 && inTime(part2Job),
  { status: finalM.status, detail: finalM.data?.detail, ms: ranFor(part2Job), notes: part2Job?.notes },
);
const latestM = await api('GET', '/api/processing/match-results/latest', { token: m.token });
check(
  'the newest saved results are the finished ones (same session, every grant scored)',
  latestM.data?.session_id === part1.result?.session_id && latestM.data.matches.every((x: Json) => x.explanation.startsWith('Scored ')),
  latestM.data?.session_id,
);

// Calls still running at the cutoff are stopped and labeled honestly.
const s = await matchingUser(25, 'ds');
await mock.reset();
await mock.fixtures({ grant_match_batch_v1: s.answer });
await mock.delay('grant_match_batch_v1', 7000);
const stuck = await call('POST', '/api/processing/match-grants', { token: s.token });
const stuckJob = await storedJob(s.userId, stuck.jobId);
check(
  'scoring calls still running at the cutoff: grants say "ran out of time" (not "Claude was unavailable"), the step ends inside its budget, no follow-up part',
  stuck.status === 200 && stuck.data.matches.length === 25 &&
    stuck.data.matches.every((x: Json) => x.explanation === ai.NOT_SCORED_OUT_OF_TIME_DIRECT && x.score === 50) &&
    !stuck.data.__continue && inTime(stuckJob) &&
    (stuckJob?.notes ?? []).some((n: string) => /Claude scored no grants this time, so matching stops here/.test(n)),
  { status: stuck.status, ms: ranFor(stuckJob), first: stuck.data?.matches?.[0]?.explanation, notes: stuckJob?.notes },
);
check(
  'the out-of-time label is plain and starts with "Not AI-scored:" (what the dashboard and exports look for)',
  ai.NOT_SCORED_OUT_OF_TIME_DIRECT.startsWith(ai.NOT_AI_SCORED) && !/—/.test(ai.NOT_SCORED_OUT_OF_TIME_DIRECT) &&
    /about a minute/.test(ai.NOT_SCORED_OUT_OF_TIME_DIRECT) && /Re-run matching/.test(ai.NOT_SCORED_OUT_OF_TIME_DIRECT),
  ai.NOT_SCORED_OUT_OF_TIME_DIRECT,
);
await mock.reset();

// ===========================================================================
// 2. Website scan: crawling stops in time to leave Claude its share
// ===========================================================================

const INNER_PAGES = ['/about', '/school', '/ministries', '/news', '/giving'];
const siteHits: string[] = [];
const site = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://site.test').pathname;
  siteHits.push(pathname);
  if (pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<html><body><h1>St. Example Catholic Parish</h1><p>HOMEPAGE-MARKER Our parish school serves families in [City].</p>${INNER_PAGES.map((p) => `<a href="${p}">${p}</a>`).join(' ')}</body></html>`,
    );
    return;
  }
  // Inner pages answer only after 3 seconds: slower than the crawl's share of the step.
  setTimeout(() => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><body><p>Inner page ${pathname}</p></body></html>`);
  }, 3000);
});
await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

const scanner = await newUser();
const scan = await call('POST', '/api/processing/scan-website', { token: scanner.token, json: { church_url: siteUrl } });
const scanJob = await storedJob(scanner.userId, scan.jobId);
const scanPrompt = (await requestsFor('website_scan_v1'))[0]?.prompt ?? '';
check(
  'scan with slow inner pages: the crawl stops in time, Claude still reads what was fetched, the step ends inside its budget',
  scan.status === 200 && scan.data.organization_basics?.name === 'St. Example Catholic Parish' && scanPrompt.includes('HOMEPAGE-MARKER') && inTime(scanJob),
  { status: scan.status, detail: scan.data?.detail, ms: ranFor(scanJob) },
);
check(
  'the crawl started no new pages once its time was up (first 3 inner pages tried and timed out, the last 2 never requested) and says so in the job notes',
  siteHits.includes('/') && ['/about', '/school', '/ministries'].every((p) => siteHits.includes(p)) &&
    !siteHits.includes('/news') && !siteHits.includes('/giving') &&
    (scanJob?.notes ?? []).some((n: string) => /Stopped reading .* early to leave Claude time/.test(n) && /2 more page\(s\) not read/.test(n)) &&
    (scanJob?.notes ?? []).some((n: string) => /Timed out after [\d.]+ seconds/.test(n)),
  { hits: siteHits, notes: scanJob?.notes },
);

await mock.reset();
await mock.delay('website_scan_v1', 7000);
const scanSlowClaude = await call('POST', '/api/processing/scan-website', { token: scanner.token, json: { church_url: `${siteUrl}/` } });
const scanSlowJob = await storedJob(scanner.userId, scanSlowClaude.jobId);
check(
  'scan whose Claude call runs past the cutoff -> 504 in plain words with what to do next, inside the budget',
  scanSlowClaude.status === 504 && /didn't finish reading your website in time/.test(scanSlowClaude.data.detail) &&
    /Enter the basics by hand/.test(scanSlowClaude.data.detail) && !/—/.test(scanSlowClaude.data.detail) && inTime(scanSlowJob),
  { status: scanSlowClaude.status, detail: scanSlowClaude.data?.detail, ms: ranFor(scanSlowJob) },
);
await mock.reset();
site.close();

// ===========================================================================
// 3. Discovery: Grants.gov searches at once with short waits; AI web
//    discovery with fewer searches and a plain message when out of time
// ===========================================================================

const govSeen: string[] = [];
const govServer = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const keyword = String(body.keyword);
  govSeen.push(keyword);
  if (keyword.startsWith('slow')) await sleep(7000);
  if (res.destroyed) return;
  const id = String(370000 + [...keyword].reduce((sum, ch) => sum + ch.charCodeAt(0), 0));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      errorcode: 0,
      data: { oppHits: [{ id, number: `EX-${id}`, title: `Example federal program for ${keyword}`, agency: 'Example Federal Agency', closeDate: '12/31/2027', oppStatus: 'posted' }] },
    }),
  );
});
await new Promise<void>((resolve) => govServer.listen(0, '127.0.0.1', resolve));
process.env.GRANTS_GOV_API_URL = `http://127.0.0.1:${(govServer.address() as AddressInfo).port}/v1/api/search2`;

const finder = await newUser();
const gov = await call('POST', '/api/discovery/grants-gov', { token: finder.token, json: { keywords: ['slow search one', 'school security', 'slow search two', 'food pantry'] } });
const govJob = await storedJob(finder.userId, gov.jobId);
const govNotes: string[] = gov.data?.notes ?? [];
check(
  'Grants.gov in direct mode: keywords searched at once (both slow ones tried, neither skipped), slow ones stop at the step\'s limit, fast results kept',
  gov.status === 200 && gov.data.found === 2 && gov.data.added === 2 &&
    govNotes.filter((n) => /^Search 'slow search (one|two)' failed: no answer within [\d.]+ seconds$/.test(n)).length === 2 &&
    !govNotes.some((n) => /skipped/.test(n)) && inTime(govJob),
  { status: gov.status, notes: govNotes, ms: ranFor(govJob) },
);
check(
  'Grants.gov notes stay in keyword order even though the searches ran at once',
  JSON.stringify(govNotes.map((n) => /^Search '(.+?)'/.exec(n)?.[1])) === JSON.stringify(['slow search one', 'school security', 'slow search two', 'food pantry']),
  govNotes,
);

const govBusy = await call('POST', '/api/discovery/grants-gov', {
  token: finder.token,
  json: { keywords: ['slow a', 'slow b', 'slow c', 'slow d', 'quick after the slow ones'] },
});
const govBusyJob = await storedJob(finder.userId, govBusy.jobId);
check(
  'a keyword that no longer fits in the step is skipped (noted), and when every search tried failed the step says Grants.gov didn\'t answer, inside the budget',
  govBusy.status === 502 && /^Grants\.gov didn't answer; try again later\. \(no answer within [\d.]+ seconds\)$/.test(govBusy.data.detail) &&
    (govBusyJob?.notes ?? []).some((n: string) => /Search 'quick after the slow ones' skipped: not enough time left in this step/.test(n)) &&
    !govSeen.includes('quick after the slow ones') && inTime(govBusyJob),
  { status: govBusy.status, detail: govBusy.data?.detail, notes: govBusyJob?.notes, ms: ranFor(govBusyJob) },
);
govServer.close();

await mock.reset();
await mock.delay('web_discovery_v1', 7000);
const grantsBefore = (await api('GET', '/api/grants', { token: finder.token })).data.length;
const webSlow = await call('POST', '/api/discovery/web-search', { token: finder.token, json: {} });
const webSlowJob = await storedJob(finder.userId, webSlow.jobId);
const webRequests = await requestsFor('web_discovery_v1');
check(
  'AI web discovery still searching at the cutoff -> 504 in plain words, nothing half-saved, inside the budget',
  webSlow.status === 504 && /needs more time than this site allows for one step/.test(webSlow.data.detail) &&
    /narrower focus/.test(webSlow.data.detail) && !/—/.test(webSlow.data.detail) &&
    (await api('GET', '/api/grants', { token: finder.token })).data.length === grantsBefore && inTime(webSlowJob),
  { status: webSlow.status, detail: webSlow.data?.detail, ms: ranFor(webSlowJob) },
);
check(
  'direct mode asks Claude for a shorter list (5-8 grants) and notes the smaller search limits',
  webRequests.length === 1 && webRequests[0].prompt.includes('Aim for 5-8 high-quality opportunities.') &&
    (webSlowJob?.notes ?? []).some((n: string) => /at most 3 web searches and 1 continuation/.test(n)),
  { prompt: webRequests[0]?.prompt?.slice(-900), notes: webSlowJob?.notes },
);

await mock.reset();
await mock.fixtures({
  web_discovery_v1: {
    turns: [
      { text: 'Searching foundation directories...', stop_reason: 'pause_turn', web_searches: 2 },
      { text: 'Still searching diocesan sites...', stop_reason: 'pause_turn', web_searches: 1 },
      { text: '[{"grant_name": "Example Never Reached Grant", "funder": "Example Fund"}]' },
    ],
  },
});
const webPaused = await call('POST', '/api/discovery/web-search', { token: finder.token, json: {} });
check(
  'a search still paused after its one allowed continuation -> the same plain out-of-time message (2 requests, not 3)',
  webPaused.status === 504 && /needs more time than this site allows for one step/.test(webPaused.data.detail) &&
    (await requestsFor('web_discovery_v1')).length === 2,
  { status: webPaused.status, detail: webPaused.data?.detail, calls: (await requestsFor('web_discovery_v1')).length },
);

await mock.reset();
await mock.fixtures({
  web_discovery_v1: {
    turns: [
      { text: 'Searching foundation directories...', stop_reason: 'pause_turn', web_searches: 2 },
      { text: 'So far: [{"grant_name": "Example Partial Grant", "funder": "Example Partial Fund", "url": "https://example.org/partial"}]', stop_reason: 'pause_turn', web_searches: 1 },
    ],
  },
});
const webPartial = await call('POST', '/api/discovery/web-search', { token: finder.token, json: {} });
check(
  'grants Claude had already listed when it had to stop are kept, with a note',
  webPartial.status === 200 && webPartial.data.found === 1 && webPartial.data.added === 1 &&
    webPartial.data.notes.includes("Claude was still searching when it had to stop; kept the 1 grant(s) it had already listed"),
  webPartial.data,
);
await mock.reset();

// ===========================================================================
// 4. Documents and the questionnaire: one Claude call each
// ===========================================================================

const reader = await newUser();
await mock.delay('document_signals_v1', 7000);
const form = new FormData();
form.append('file', new Blob(['Annual report: the gym roof leaks. Enrollment is 240 students.']), 'report.txt');
const docSlow = await call('POST', '/api/processing/upload-document', { token: reader.token, form });
const docJob = await storedJob(reader.userId, docSlow.jobId);
check(
  'a document Claude is still reading at the cutoff -> 504 naming the file and what to do next; nothing saved; inside the budget',
  docSlow.status === 504 && /didn't finish reading "report\.txt" in time/.test(docSlow.data.detail) && /shorter file/.test(docSlow.data.detail) &&
    (await api('GET', '/api/processing/profile', { token: reader.token })).status === 404 && inTime(docJob),
  { status: docSlow.status, detail: docSlow.data?.detail, ms: ranFor(docJob) },
);
await mock.reset();

await repo.saveGrants(reader.userId, [grant(reader.userId, 'grant_dq_001', 'Example Questionnaire Grant')] as Json);
await mock.delay('questionnaire_v1', 7000);
const qSlow = await call('POST', '/api/processing/generate-questionnaire', { token: reader.token });
const qJob = await storedJob(reader.userId, qSlow.jobId);
const savedQ = await api('GET', '/api/processing/questionnaire', { token: reader.token });
check(
  'questionnaire Claude can\'t finish in time -> the standard questions, inside the budget, and they are the saved ones',
  qSlow.status === 200 && qSlow.data.total_questions === 8 && inTime(qJob) &&
    JSON.stringify(savedQ.data) === JSON.stringify(qSlow.data),
  { status: qSlow.status, total: qSlow.data?.total_questions, ms: ranFor(qJob) },
);
await mock.reset();

mock.stop();
finish();
