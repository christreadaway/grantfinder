/**
 * Regression checks for problems found by the browser test and reviews:
 * no duplicate paid AI steps, drafting only missing sections, redraft keeps
 * history, export after the requirements change, parallel document uploads.
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/regressions.test.mts
 */
import { api, call, check, finish, guest, saveKey, setupEnv, startMock } from './helpers.mts';

setupEnv('regressions');
const mock = await startMock();
const { saveGrants, saveProfile } = await import('../../frontend/src/server/repo.ts');
const { normalizeProfile } = await import('../../frontend/src/server/types.ts');

const token = await guest();
await saveKey(token);
const me = (await api('GET', '/api/auth/me', { token })).data;
const now = new Date().toISOString();
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
    evidence: [{ id: 'ev_1', type: 'document', summary: '38% of families receive tuition assistance', source_ref: 'Document: report.pdf', linked_programs: [] }],
  }),
);
await saveGrants(me.id, [
  {
    id: 'grant_kenedy_test',
    user_id: me.id,
    created_at: now,
    grant_name: 'Kenedy Memorial Foundation Grant',
    funder: 'John G. and Marie Stella Kenedy Memorial Foundation',
    deadline: 'Annual: October 15',
    amount: 'Varies',
    description: 'Catholic education and ministry in Texas.',
    contact: 'Via website',
    url: 'https://kenedy.org/grants/application-process/',
    status: 'OPEN',
    geo_qualified: 'Yes - TX Only',
    category: 'mixed',
    source: 'seed',
    eligibility_notes: null,
    funds_for: ['education'],
  },
]);

const app = (await api('POST', '/api/writer/applications', { token, json: { grant_id: 'grant_kenedy_test' } })).data;
const base = `/api/writer/applications/${app.id}`;
const spec = await call('POST', `${base}/grant-spec`, { token, json: { guidelines_text: 'Sections: background, need, project.' } });
check('spec created', spec.status === 200 && spec.data.grant_spec.required_sections.length >= 2, spec.data);
const fit = await call('POST', `${base}/analyze`, { token });
for (const gap of fit.data?.gaps ?? []) {
  if (gap.severity === 'high') await api('PUT', `${base}/gaps/${gap.id}/waive`, { token, json: { reason: 'test' } });
}
await api('POST', `${base}/confirm-strategy`, { token, json: { strategy: 'Lead with outcomes.' } });

// --- 1. A second click while drafting runs attaches instead of starting a duplicate job
await mock.delay('section_draft_v1', 1500);
const first = await api('POST', `${base}/draft`, { token, json: {} });
const second = await api('POST', `${base}/draft`, { token, json: {} });
check('first draft click starts a job (202)', first.status === 202 && Boolean(first.data.job_id), first.data);
check(
  'second click while running -> 409 running with the same job id',
  second.status === 409 && second.data.running === true && second.data.job_id === first.data.job_id && /already running/.test(second.data.detail),
  second.data,
);
await mock.delay('section_draft_v1', 0);
/** Poll a job until it settles. */
const waitJob = async (jobId: string) => {
  let job = (await api('GET', `/api/jobs/${jobId}`, { token })).data;
  for (let i = 0; i < 300 && job.status !== 'done' && job.status !== 'failed'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    job = (await api('GET', `/api/jobs/${jobId}`, { token })).data;
  }
  return job;
};
const finished = await waitJob(first.data.job_id);
check('the drafting job finished', finished.status === 'done', finished);
const afterRun = await api('POST', `${base}/draft`, { token, json: { only_missing: true } });
check('after it finishes, a new run is allowed again', afterRun.status === 202, afterRun.data);
const afterRunDone = afterRun.status === 202 ? await waitJob(afterRun.data.job_id) : null;
check(
  'only_missing with nothing missing says so',
  afterRunDone?.status === 'done' && /Every required section already has a draft/.test(JSON.stringify(afterRunDone.result)),
  afterRunDone,
);

// --- 2. Redraft keeps the refined text in the section's history
const state1 = (await api('GET', base, { token })).data;
const firstSection = state1.sections[0];
const refined = await call('POST', `${base}/sections/${firstSection.section_id}/refine`, { token, json: { instruction: 'tighten' } });
check('refine works', refined.status === 200, refined.data);
const refinedText = (await api('GET', base, { token })).data.sections.find((s: { section_id: string }) => s.section_id === firstSection.section_id).current_draft;
const redraft = await call('POST', `${base}/draft`, { token, json: { section_id: firstSection.section_id } });
check('single-section redraft works', redraft.status === 200, redraft.data);
const afterRedraft = (await api('GET', base, { token })).data.sections.find((s: { section_id: string }) => s.section_id === firstSection.section_id);
check('redraft keeps the refined text in versions', afterRedraft.versions.includes(refinedText), afterRedraft.versions);

// --- 3. Requirements change after drafting: stale and missing sections
const oldIds: string[] = state1.sections.map((s: { section_id: string }) => s.section_id);
await mock.fixtures({
  grant_spec_v1: JSON.stringify({
    required_sections: [
      { id: oldIds[0], title: state1.sections[0].title, prompt: 'Background', word_limit: 400, char_limit: null, notes: '' },
      { id: 'budget', title: 'Budget Narrative', prompt: 'Explain the budget.', word_limit: 300, char_limit: null, notes: '' },
    ],
    format_constraints: [],
    deliverables: [],
    rubric: [{ id: 'c1', name: 'Need', description: '', weight: null }],
    rubric_source: 'explicit',
    funder_language_cues: [],
    funder_priorities: [],
  }),
});
const respec = await call('POST', `${base}/grant-spec`, { token, json: { guidelines_text: 'Real guidelines: background and budget narrative only.' } });
check('re-analyze with new guidelines works', respec.status === 200, respec.data);
const state2 = (await api('GET', base, { token })).data;
check('state lists the new section as missing', state2.missing_sections.some((m: { id: string }) => m.id === 'budget'), state2.missing_sections);
check('state marks dropped sections as stale', oldIds.slice(1).every((id) => state2.stale_section_ids.includes(id)), state2.stale_section_ids);

const md = await api('POST', `${base}/export`, { token, json: { format: 'md' } });
const notice = decodeURIComponent(md.headers.get('x-grantfinder-notice') || '');
check('export still works (200)', md.status === 200, md.text.slice(0, 200));
check('export marks the undrafted section in the file', md.text.includes('Budget Narrative') && md.text.includes('NOT DRAFTED YET'), md.text.slice(0, 400));
check('export leaves out stale sections', state1.sections.slice(1).every((s: { title: string }) => !md.text.includes(s.title)), md.text.slice(0, 400));
check('export notice names missing and stale sections', /Not drafted yet/.test(notice) && /Budget Narrative/.test(notice) && /no longer ask/.test(notice), notice);

const fillIn = await call('POST', `${base}/draft`, { token, json: { only_missing: true } });
check('draft missing sections drafts only the new one', fillIn.status === 200 && fillIn.data.sections.length === 1 && fillIn.data.sections[0].section_id === 'budget', fillIn.data);
const state3 = (await api('GET', base, { token })).data;
check('nothing missing afterwards', state3.missing_sections.length === 0, state3.missing_sections);
const md2 = await api('POST', `${base}/export`, { token, json: { format: 'md' } });
check('export notice now only mentions stale sections', !/Not drafted yet/.test(decodeURIComponent(md2.headers.get('x-grantfinder-notice') || '')), md2.headers.get('x-grantfinder-notice'));

// --- 4. Several documents can process at the same time (not "already running")
const doc = (name: string) => {
  const form = new FormData();
  form.append('file', new Blob([`Our gym roof leaks. ${name} needs security cameras and new classroom laptops for every teacher.`], { type: 'text/plain' }), name);
  return form;
};
await mock.delay('document_signals_v1', 800);
const [up1, up2] = await Promise.all([
  api('POST', '/api/processing/upload-document', { token, form: doc('a.txt') }),
  api('POST', '/api/processing/upload-document', { token, form: doc('b.txt') }),
]);
check('two document uploads both start their own job', up1.status === 202 && up2.status === 202 && up1.data.job_id !== up2.data.job_id, [up1.data, up2.data]);
await mock.delay('document_signals_v1', 0);

mock.stop();
finish();
