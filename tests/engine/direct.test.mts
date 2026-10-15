/**
 * Direct job mode (any Netlify plan): each writer step runs inside one request,
 * which Netlify stops at 60 seconds, so a step has a time budget (about 50
 * seconds). With a small budget and a slow mock Claude this proves that:
 * drafting several sections continues in parts, drafts each section exactly
 * once (also for Redraft All), numbers its progress across the parts, and
 * skips an optional extra Claude call (voice rewrite, automatic tightening)
 * when time is short, leaving the section flagged with a note.
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/direct.test.mts
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { api, check, finish, guest, saveKey, setupEnv, startMock } from './helpers.mts';

setupEnv('direct', { GRANTFINDER_JOB_MODE: 'direct', GRANTFINDER_DIRECT_JOB_BUDGET_MS: '45000', GRANTFINDER_ALLOW_LOCAL_FETCH: '1' });
const mock = await startMock();
const { saveGrants, saveProfile } = await import('../../frontend/src/server/repo.ts');
const { normalizeProfile } = await import('../../frontend/src/server/types.ts');

const token = await guest();
await saveKey(token);
const me = (await api('GET', '/api/auth/me', { token })).data;
await saveProfile(
  me.id,
  normalizeProfile({
    user_id: me.id,
    organization_name: '[School Name]',
    organization_type: 'both',
    city: '[City]',
    state: 'TX',
    has_school: true,
    student_count: 214,
  }),
);
// A funder website that accepts the connection and never answers.
const silentSite = http.createServer(() => {
  // never responds
});
const silentPort = await new Promise<number>((resolve) => silentSite.listen(0, '127.0.0.1', () => resolve((silentSite.address() as AddressInfo).port)));
const grantFields = {
  user_id: me.id,
  created_at: new Date().toISOString(),
  funder: 'Test Funder',
  deadline: 'Rolling',
  amount: 'Varies',
  description: 'Catholic education in Texas.',
  contact: '',
  status: 'OPEN' as const,
  geo_qualified: 'Yes' as const,
  category: 'mixed' as const,
  source: 'seed',
  eligibility_notes: null,
  funds_for: ['education'],
};
await saveGrants(me.id, [
  { ...grantFields, id: 'grant_slow_site', grant_name: 'Slow Website Grant', url: `http://127.0.0.1:${silentPort}/guidelines` },
  {
    id: 'grant_direct_test',
    user_id: me.id,
    created_at: new Date().toISOString(),
    grant_name: 'Direct Mode Test Grant',
    funder: 'Test Funder',
    deadline: 'Rolling',
    amount: 'Varies',
    description: 'Catholic education in Texas.',
    contact: '',
    url: '',
    status: 'OPEN',
    geo_qualified: 'Yes',
    category: 'mixed',
    source: 'seed',
    eligibility_notes: null,
    funds_for: ['education'],
  },
]);

type Continuation = { path: string; body: Record<string, unknown> };
type Part = { jobId: string; progress: string[]; next: Continuation | null };
type SectionState = { section_id: string; title: string; current_draft: string; versions: string[]; banned_phrase_hits: string[]; over_limit: boolean; compliance_notes: string[] };

/** Start a step and follow its parts like the website does, recording each part's job, progress lines and continuation. */
async function runInParts(path: string, body: Record<string, unknown>) {
  const parts: Part[] = [];
  let request: Continuation | null = { path, body };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let final: { status: number; data: any } = { status: 0, data: null };
  while (request) {
    const started = await api('POST', request.path, { token, json: request.body });
    if (started.status !== 202) return { parts, final: { status: started.status, data: started.data } };
    const jobId: string = started.data.job_id;
    const progress: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let job: any = null;
    for (let i = 0; i < 1200; i++) {
      job = (await api('GET', `/api/jobs/${jobId}`, { token })).data;
      if (job.progress && !progress.includes(job.progress)) progress.push(job.progress);
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const next: Continuation | null = job.status === 'done' ? job.result?.__continue ?? null : null;
    parts.push({ jobId, progress, next });
    if (job.status !== 'done') return { parts, final: { status: job.error?.status ?? 500, data: { detail: job.error?.detail } } };
    final = { status: 200, data: job.result };
    request = next;
  }
  return { parts, final };
}

const draftPrompts = async (before: number) =>
  (await mock.requests()).slice(before).filter((r) => r.prompt_id === 'section_draft_v1').map((r) => (/SECTION: (.*)/.exec(r.prompt) || [])[1]);
const sectionsNow = async (): Promise<SectionState[]> => (await api('GET', base, { token })).data.sections;

// --- Setup: requirements, fit analysis (high gaps waived), confirmed strategy
const created = await api('POST', '/api/writer/applications', { token, json: { grant_id: 'grant_direct_test' } });
const base = `/api/writer/applications/${created.data.id}`;
const spec = await runInParts(`${base}/grant-spec`, { guidelines_text: 'Sections: background, need, project, evaluation.' });
const sectionTitles: string[] = (spec.final.data?.grant_spec?.required_sections ?? []).map((s: { title: string }) => s.title);
check('direct mode: a step answers 202 and runs inside its own request', spec.final.status === 200 && sectionTitles.length === 4 && spec.parts.length === 1, spec.final);
const fit = await runInParts(`${base}/analyze`, {});
for (const gap of fit.final.data?.gaps ?? []) {
  if (gap.severity === 'high') await api('PUT', `${base}/gaps/${gap.id}/waive`, { token, json: { reason: 'test' } });
}
await api('POST', `${base}/confirm-strategy`, { token, json: { strategy: 'Lead with outcomes.' } });

// --- 1. A first draft of four sections continues in a second part (budget 45 s, each section ~6 s:
// three start at once; when the first finishes there is less than the 40 s a section needs)
await mock.delay('section_draft_v1', 6000);
let before = (await mock.requests()).length;
const first = await runInParts(`${base}/draft`, {});
const firstCalls = await draftPrompts(before);
check(
  'drafting four sections in direct mode continues in a second part',
  first.final.status === 200 && first.parts.length === 2 && first.parts[1].next === null &&
    JSON.stringify(first.parts[0].next) ===
      JSON.stringify({ path: `${base}/draft`, body: { section_ids: ['s4'], progress_offset: 3, progress_total: 4 } }),
  first.parts.map((p) => p.next),
);
check(
  'every section is drafted exactly once across the parts',
  firstCalls.length === 4 && sectionTitles.every((title) => firstCalls.filter((t) => t === title).length === 1),
  firstCalls,
);
check(
  'progress numbering spans the parts ("Drafting section 4 of 4" in part two)',
  first.parts[0].progress.some((line) => /^Drafting section [1-3] of 4: /.test(line)) &&
    first.parts[1].progress.includes(`Drafting section 4 of 4: ${sectionTitles[3]}`) &&
    !first.parts.flatMap((p) => p.progress).some((line) => /^Drafting section \d+ of [^4]/.test(line)),
  first.parts.map((p) => p.progress),
);
const afterFirst = (await api('GET', base, { token })).data;
check('all four sections saved; nothing missing', afterFirst.sections.length === 4 && afterFirst.missing_sections.length === 0, afterFirst.missing_sections);

// --- 2. Redraft All in parts redrafts each section once (the next part gets only the sections not redrafted yet)
const versionsBefore = new Map((await sectionsNow()).map((s) => [s.section_id, s.versions.length]));
before = (await mock.requests()).length;
const redraft = await runInParts(`${base}/draft`, {});
const redraftCalls = await draftPrompts(before);
const versionsAfter = new Map((await sectionsNow()).map((s) => [s.section_id, s.versions.length]));
check(
  'Redraft All in parts redrafts each section exactly once',
  redraft.final.status === 200 && redraft.parts.length === 2 && redraftCalls.length === 4 &&
    sectionTitles.every((title) => redraftCalls.filter((t) => t === title).length === 1),
  [redraft.parts.map((p) => p.next), redraftCalls],
);
check(
  'each section gained exactly one redraft in its history (the replaced text and the pre-rewrite draft)',
  [...versionsBefore.entries()].every(([id, count]) => versionsAfter.get(id) === count + 2),
  [[...versionsBefore.entries()], [...versionsAfter.entries()]],
);
check('Redraft All progress also reads "of 4" across parts', redraft.parts[1].progress.some((line) => /^Drafting section 4 of 4: /.test(line)), redraft.parts.map((p) => p.progress));

// --- 3. An explicit list: validated, duplicates dropped, only those sections drafted
await mock.delay('section_draft_v1', 0);
const notAList = await api('POST', `${base}/draft`, { token, json: { section_ids: 's2' } });
const emptyList = await api('POST', `${base}/draft`, { token, json: { section_ids: [] } });
const unknownId = await api('POST', `${base}/draft`, { token, json: { section_ids: ['s2', 'nope'] } });
const badOffset = await api('POST', `${base}/draft`, { token, json: { section_ids: ['s2'], progress_offset: -1 } });
check(
  'section_ids is validated: a list (422), not empty (422), every id in the requirements (404); progress fields are whole numbers (422)',
  notAList.status === 422 && emptyList.status === 422 && unknownId.status === 404 && unknownId.data.detail === 'Section not found in grant spec' && badOffset.status === 422,
  [notAList.data, emptyList.data, unknownId.data, badOffset.data],
);
before = (await mock.requests()).length;
const listed = await runInParts(`${base}/draft`, { section_ids: ['s2', ' s2 ', 's3'] });
const listedCalls = await draftPrompts(before);
check(
  'an explicit list drafts just those sections, each once (duplicates dropped)',
  listed.final.status === 200 && listed.parts.length === 1 && listedCalls.length === 2 &&
    listedCalls.includes(sectionTitles[1]) && listedCalls.includes(sectionTitles[2]),
  listedCalls,
);

// --- 4. Too little time left for the voice rewrite: the section is saved flagged, with a note (budget 20 s, draft ~6 s)
process.env.GRANTFINDER_DIRECT_JOB_BUDGET_MS = '20000';
await mock.delay('section_draft_v1', 6000);
before = (await mock.requests()).length;
const noTimeForEnforce = await runInParts(`${base}/draft`, { section_id: 's1' });
const enforceCalls = (await mock.requests()).slice(before).filter((r) => r.prompt_id === 'voice_enforce_v1').length;
const s1Flagged = (await sectionsNow()).find((s) => s.section_id === 's1');
check(
  'with under 15 s left, the voice rewrite is skipped: banned phrase kept and flagged, with a note on how to fix it',
  noTimeForEnforce.final.status === 200 && enforceCalls === 0 && s1Flagged?.banned_phrase_hits.includes('we are thrilled') === true &&
    s1Flagged.compliance_notes.includes(
      'Banned phrases left in (we are thrilled): this step ran out of time before it could rewrite them. Refine this section (for example "remove these phrases") or edit it by hand.',
    ),
  [enforceCalls, s1Flagged?.banned_phrase_hits, s1Flagged?.compliance_notes],
);
const blockedExport = await api('POST', `${base}/export`, { token, json: { format: 'md' } });
check('...and export stays blocked until it is fixed', blockedExport.status === 409 && /banned phrases remain in: Organization Background/.test(blockedExport.data.detail), blockedExport.data);

// --- 5. Too little time left for the automatic tightening after an over-limit revision (refine ~6 s)
await mock.delay('section_draft_v1', 0);
const LONG = Array.from({ length: 60 }, () => 'Our families pray, learn, and serve together every day.').join(' ');
await mock.fixtures({ section_refine_v1: JSON.stringify({ draft: LONG }) });
await mock.delay('section_refine_v1', 6000);
before = (await mock.requests()).length;
const noTimeForTighten = await runInParts(`${base}/sections/s1/refine`, { instruction: 'Add more detail' });
const refineCalls = (await mock.requests()).slice(before).filter((r) => r.prompt_id === 'section_refine_v1').length;
const s1Over = (await sectionsNow()).find((s) => s.section_id === 's1');
check(
  'with under 15 s left, the automatic tightening is skipped: the section stays OVER LIMIT, with a note on how to fix it',
  noTimeForTighten.final.status === 200 && refineCalls === 1 && s1Over?.over_limit === true &&
    s1Over.compliance_notes.includes(
      'Over the limit: this step ran out of time before it could tighten the text automatically. Refine it again (for example "tighten to the limit") or edit it by hand.',
    ),
  [refineCalls, s1Over?.over_limit, s1Over?.compliance_notes],
);

// --- 6. A funder page that never answers gives up in time for the Claude call (45 s step: 10 s for the page)
process.env.GRANTFINDER_DIRECT_JOB_BUDGET_MS = '45000';
await mock.delay('section_refine_v1', 0);
const slowApp = await api('POST', '/api/writer/applications', { token, json: { grant_id: 'grant_slow_site' } });
const slowStarted = Date.now();
const slowSpec = await runInParts(`/api/writer/applications/${slowApp.data.id}/grant-spec`, {});
const slowSeconds = (Date.now() - slowStarted) / 1000;
check(
  'a guidelines page that never answers is given up on in time: requirements inferred inside the step, and the note says why',
  slowSpec.final.status === 200 && slowSeconds < 30 && slowSpec.final.data.grant_spec?.rubric_source === 'inferred' &&
    slowSpec.final.data.note ===
      `Could not read http://127.0.0.1:${silentPort}/guidelines (Timed out after 10 seconds); requirements were inferred. Paste the guidelines for an exact spec.`,
  [slowSpec.final.status, slowSeconds, slowSpec.final.data?.note],
);
silentSite.closeAllConnections();
silentSite.close();

// --- 7. Funder history inside one request: research has at most 3 searches and 1 continuation, then
// continues to the profile build in a request of its own; time limits end in plain messages.
const { FUNDER_MESSAGES } = await import('../../frontend/src/server/services/writer.ts');
await saveGrants(me.id, [
  { ...grantFields, id: 'grant_slow_site', grant_name: 'Slow Website Grant', url: `http://127.0.0.1:${silentPort}/guidelines` },
  { ...grantFields, id: 'grant_direct_test', grant_name: 'Direct Mode Test Grant', url: '' },
  { ...grantFields, id: 'grant_direct_funder', grant_name: 'Direct Funder Grant', funder: '[Funder Name]', url: '' },
  { ...grantFields, id: 'grant_direct_funder_blank', grant_name: 'Blank Funder Grant', funder: '[Other Funder Name]', url: '' },
]);
const funderApp = await api('POST', '/api/writer/applications', { token, json: { grant_id: 'grant_direct_funder' } });
const funderBase = `/api/writer/applications/${funderApp.data.id}`;
const blankFunderApp = await api('POST', '/api/writer/applications', { token, json: { grant_id: 'grant_direct_funder_blank' } });
const blankFunderBase = `/api/writer/applications/${blankFunderApp.data.id}`;
const FUNDER_NOTES = 'From the 990-PF: [Other School Name] received $15,000 for K-3 reading intervention in 2024.';
const PARTIAL =
  'PAST GRANTS (so far)\n- [Other School Name] | 2024 | $15,000 | K-3 reading intervention | https://example.org/funder/partial-report\n' +
  'PARTIAL-RESEARCH-MARKER: still checking the 2023 990-PF.';
await mock.fixtures({
  funder_research_v1: {
    turns: [
      { text: PARTIAL, stop_reason: 'pause_turn', web_searches: 2 },
      { text: ' Still searching.', stop_reason: 'pause_turn', web_searches: 1 },
    ],
  },
});
before = (await mock.requests()).length;
const paused = await runInParts(`${funderBase}/funder-profile`, { notes_text: FUNDER_NOTES, research_web: true });
const pausedCalls = (await mock.requests()).slice(before).filter((r) => r.prompt_id === 'funder_research_v1');
const pausedRecord = (await api('GET', funderBase, { token })).data.funder_profile;
check(
  'research still searching after its one continuation: 2 requests (3 searches at most), what it found is kept, and the build runs in a second part',
  paused.final.status === 200 && pausedCalls.length === 2 && pausedCalls[1].turns === 2 && paused.parts.length === 2 &&
    paused.parts[0].next?.path === `${funderBase}/funder-profile` && paused.parts[0].next?.body.research_web === false &&
    pausedRecord?.research_sources.includes('https://example.org/funder/partial-report') && Boolean(pausedRecord?.profile),
  [paused.final, pausedCalls.length, paused.parts.map((p) => p.next), pausedRecord?.research_sources],
);
check(
  '...and the result says the research stopped early',
  paused.final.data?.note === FUNDER_MESSAGES.researchStoppedEarly,
  paused.final.data?.note,
);
const { getJob } = await import('../../frontend/src/server/jobs.ts');
const researchJob = await getJob(me.id, paused.parts[0].jobId);
check(
  'the research step notes its direct-mode limits',
  (researchJob?.notes ?? []).some((note: string) => note.includes('Funder research: at most 3 web searches and 1 continuation (runs inside one request, about a minute)')),
  researchJob?.notes,
);

// Research cut off by the step's time limit (3 s step, Claude takes 6 s).
await mock.fixtures({ funder_research_v1: { text: PARTIAL, web_searches: 1 } });
process.env.GRANTFINDER_DIRECT_JOB_BUDGET_MS = '3000';
await mock.delay('funder_research_v1', 6000);
let started = Date.now();
const cutWithNotes = await runInParts(`${funderBase}/funder-profile`, { research_web: true });
const cutSeconds = (Date.now() - started) / 1000;
check(
  'research stopped by the time limit, with notes to build from: the profile is still built, and the result says why',
  cutWithNotes.final.status === 200 && cutWithNotes.parts.length === 2 && cutWithNotes.final.data?.note === FUNDER_MESSAGES.researchOutOfTimeKept &&
    cutSeconds < 15,
  [cutWithNotes.final, cutSeconds],
);
const cutBlank = await runInParts(`${blankFunderBase}/funder-profile`, { notes_text: '', research_web: true });
check(
  'research stopped by the time limit, with nothing else to build from: a plain message (504), nothing saved',
  cutBlank.final.status === 504 && cutBlank.final.data?.detail === FUNDER_MESSAGES.researchOutOfTime && cutBlank.parts.length === 1,
  cutBlank.final,
);
await mock.delay('funder_research_v1', 0);
await mock.delay('funder_profile_v1', 6000);
const cutBuild = await runInParts(`${funderBase}/funder-profile`, {});
check(
  'a profile build stopped by the time limit: a plain message (504); the earlier profile is kept',
  cutBuild.final.status === 504 && cutBuild.final.data?.detail === FUNDER_MESSAGES.buildOutOfTime &&
    Boolean((await api('GET', funderBase, { token })).data.funder_profile?.profile),
  cutBuild.final,
);
await mock.delay('funder_profile_v1', 0);

// Inside one request the profile reads at most 50,000 characters of material, and says what was cut.
process.env.GRANTFINDER_DIRECT_JOB_BUDGET_MS = '45000';
before = (await mock.requests()).length;
const longNotes = 'Grant to [Other School Name] for reading. '.repeat(1430);
const bigBuild = await runInParts(`${funderBase}/funder-profile`, { notes_text: longNotes });
const bigPrompt = (await mock.requests()).slice(before).find((r) => r.prompt_id === 'funder_profile_v1')?.prompt ?? '';
check(
  'inside one request the profile reads at most 50,000 characters of material, and the result names what was cut',
  bigBuild.final.status === 200 && longNotes.length === 60_060 &&
    /=== Pasted notes \(the first [\d,]+ of 60,000 characters\) ===/.test(bigPrompt) &&
    String(bigBuild.final.data?.note).includes('Only part of your pasted notes fit in one request'),
  [bigBuild.final.status, bigBuild.final.data?.note, (/=== Pasted notes.*===/.exec(bigPrompt) || [])[0]],
);

await mock.reset();
mock.stop();
finish();
