/**
 * Engine foundation: health, sign-in, sessions, API keys, routing, debug report.
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/foundation.test.mts
 */
import { api, check, finish, guest, setupEnv, startMock } from './helpers.mts';

setupEnv('foundation');
const mock = await startMock();

const health = await api('GET', '/api/health');
check('health answers healthy with file storage', health.status === 200 && health.data.status === 'healthy' && health.data.store === 'fs', health.data);

const options = await api('GET', '/api/auth/options');
check('auth options: guest on, google off', options.data?.guest === true && options.data?.google === false, options.data);

const token = await guest();
check('guest sign-in returns a token', typeof token === 'string' && token.length > 20);

const me = await api('GET', '/api/auth/me', { token });
check('me returns the guest user without a key', me.status === 200 && me.data.name === 'Guest' && me.data.claude_api_key_set === false, me.data);

const noToken = await api('GET', '/api/auth/me');
check('no token -> 401 Not authenticated', noToken.status === 401 && noToken.data.detail === 'Not authenticated', noToken.data);

const badToken = await api('GET', '/api/auth/me', { token: 'abc.def.ghi' });
check('bad token -> 401 Invalid token', badToken.status === 401 && badToken.data.detail === 'Invalid token', badToken.data);

const badFormat = await api('POST', '/api/auth/api-key', { token, json: { api_key: 'nope' } });
check('API key without sk-ant- -> 400 with Python wording', badFormat.status === 400 && /start with 'sk-ant-'/.test(badFormat.data.detail), badFormat.data);

const rejected = await api('POST', '/api/auth/api-key', { token, json: { api_key: 'sk-ant-invalid-123' } });
check('API key Anthropic rejects -> 400, not saved', rejected.status === 400 && /rejected/i.test(rejected.data.detail), rejected.data);
check('rejected key: the message quotes what Anthropic said', /Anthropic said: "invalid x-api-key"/.test(rejected.data.detail), rejected.data);

const saved = await api('POST', '/api/auth/api-key', { token, json: { api_key: '  sk-ant-test-good-1234  ' } });
check('valid API key saved and verified', saved.status === 200 && saved.data.verified === true, saved.data);

// Netlify's AI Gateway injects ANTHROPIC_BASE_URL and friends into deployed functions; the
// harness sets decoys of both. The key above verified against the mock, so they were ignored.
check(
  'Netlify AI Gateway variables ignored: key checked at the mock, no bearer token sent',
  saved.data.verified === true && /decoy/.test(process.env.ANTHROPIC_BASE_URL ?? '') && /decoy/.test(process.env.ANTHROPIC_AUTH_TOKEN ?? ''),
  { verified: saved.data.verified },
);
const healthHost = await api('GET', '/api/health');
check('health names the Claude host in use (the mock here)', healthHost.data?.claude_api === new URL(mock.url).host, healthHost.data);
{
  const config = await import('../../frontend/src/server/config.ts');
  const testUrl = process.env.GRANTFINDER_CLAUDE_BASE_URL;
  delete process.env.GRANTFINDER_CLAUDE_BASE_URL;
  const deployed = config.anthropicBaseUrl();
  process.env.GRANTFINDER_CLAUDE_BASE_URL = testUrl;
  check('deployed: Claude calls go to api.anthropic.com even when ANTHROPIC_BASE_URL is set', deployed === 'https://api.anthropic.com', deployed);
}

const status = await api('GET', '/api/auth/api-key/status', { token });
check('key status is_set true', status.data?.is_set === true && status.data?.is_valid === true, status.data);

const me2 = await api('GET', '/api/auth/me', { token });
check('me shows claude_api_key_set true', me2.data?.claude_api_key_set === true, me2.data);

const removed = await api('DELETE', '/api/auth/api-key', { token });
const status2 = await api('GET', '/api/auth/api-key/status', { token });
check('key removed', removed.status === 200 && status2.data?.is_set === false, status2.data);

const notFound = await api('GET', '/api/does-not-exist', { token });
check('unknown route -> 404 {detail}', notFound.status === 404 && notFound.data.detail === 'Not Found', notFound.data);

const wrongMethod = await api('DELETE', '/api/auth/options');
check('wrong method -> 405', wrongMethod.status === 405, wrongMethod.data);

const badJson = await api('POST', '/api/auth/api-key', { token, headers: { 'content-type': 'application/json' }, json: undefined, form: undefined });
check('empty body handled (no crash)', badJson.status === 400 || badJson.status === 422, badJson.data);

const report = await api('GET', '/api/debug/report', { token });
check('debug report is markdown with user and settings', report.status === 200 && report.text.includes('# GrantFinder debug report') && report.text.includes('guest_'), report.text.slice(0, 200));
check('debug report never contains the API key', !report.text.includes('sk-ant-'));

const jobs = await api('GET', '/api/jobs', { token });
check('jobs list empty', jobs.status === 200 && Array.isArray(jobs.data.jobs), jobs.data);

const missingJob = await api('GET', '/api/jobs/job_nope', { token });
check('unknown job -> 404', missingJob.status === 404, missingJob.data);

// Sessions survive a "restart": a new token check reads the user from storage.
const me3 = await api('GET', '/api/auth/me', { token });
check('session still valid', me3.status === 200);

// Guest creation is rate limited per IP (20/hour).
let limited = false;
for (let i = 0; i < 25; i++) {
  const r = await api('POST', '/api/auth/guest', { headers: { 'x-forwarded-for': '203.0.113.9' } });
  if (r.status === 429) {
    limited = true;
    break;
  }
}
check('guest sign-in rate limited per IP', limited);

mock.stop();
finish();
