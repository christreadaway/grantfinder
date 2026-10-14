/**
 * Security regressions from the review: DNS rebinding, private address
 * ranges, zip bombs, CSV formulas, API keys in logs and errors.
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/security.test.mts
 */
import dnsCallback from 'node:dns';
import dnsPromises from 'node:dns/promises';
import zlib from 'node:zlib';

import { api, check, finish, guest, saveKey, setupEnv, startMock } from './helpers.mts';

setupEnv('security');
delete process.env.GRANTFINDER_ALLOW_LOCAL_FETCH; // real SSRF protection for this suite
const mock = await startMock();
const { checkUrl, fetchPage } = await import('../../frontend/src/server/net.ts');
const { saveMatchResults } = await import('../../frontend/src/server/repo.ts');

// --- 1. DNS rebinding: public address at check time, loopback at connect time
const realPromiseLookup = dnsPromises.lookup;
const realCallbackLookup = dnsCallback.lookup;
(dnsPromises as unknown as { lookup: unknown }).lookup = async (host: string, options: unknown) =>
  host === 'rebind.example' ? [{ address: '93.184.216.34', family: 4 }] : (realPromiseLookup as (h: string, o: unknown) => unknown)(host, options);
(dnsCallback as unknown as { lookup: unknown }).lookup = (host: string, options: unknown, callback: (e: Error | null, a: unknown, f?: number) => void) => {
  if (host === 'rebind.example') {
    const list = [{ address: '127.0.0.1', family: 4 }];
    return (options as { all?: boolean })?.all ? callback(null, list) : callback(null, '127.0.0.1', 4);
  }
  return (realCallbackLookup as unknown as (h: string, o: unknown, c: unknown) => void)(host, options, callback);
};
const rebound = await fetchPage(`http://rebind.example:${new URL(mock.url).port}/v1/models`);
check('DNS rebinding to 127.0.0.1 is blocked at connect time', !rebound.ok && /private or local/i.test(rebound.error || ''), rebound);
(dnsPromises as unknown as { lookup: unknown }).lookup = realPromiseLookup;
(dnsCallback as unknown as { lookup: unknown }).lookup = realCallbackLookup;

// --- 2. Private / reserved ranges, including IPv6 forms that embed IPv4
for (const url of [
  'http://198.18.0.1/', 'http://224.0.0.1/', 'http://240.0.0.1/', 'http://255.255.255.255/',
  'http://[fec0::1]/', 'http://[2002:7f00:1::]/', 'http://[64:ff9b::7f00:1]/', 'http://[::7f00:1]/',
  'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'http://10.1.2.3/', 'http://localhost/',
]) {
  const result = await checkUrl(url);
  check(`blocked: ${url}`, !result.ok, result);
}
check('a public IP literal is allowed', (await checkUrl('http://8.8.8.8/')).ok);

// --- 3. Malformed API keys are refused before they are stored
const token = await guest();
const spaced = await api('POST', '/api/auth/api-key', { token, json: { api_key: 'sk-ant-api03-abc\ndef-123' } });
check('key with a line break -> 400 hidden characters', spaced.status === 400 && /hidden characters/.test(spaced.data.detail), spaced.data);
const zeroWidth = await api('POST', '/api/auth/api-key', { token, json: { api_key: 'sk-ant-api03-abc​def-123' } });
check('key with a zero-width space -> 400', zeroWidth.status === 400, zeroWidth.data);
await saveKey(token);

// --- 4. Keys never reach a log line
const captured: string[] = [];
const realLog = console.log;
process.env.GRANTFINDER_LOG_STDOUT = '1';
console.log = (line: unknown) => captured.push(String(line));
const { logger } = await import('../../frontend/src/server/log.ts');
logger.info('test_event', { note: 'header was sk-ant-api03-SECRETSECRETSECRET-xyz' });
console.log = realLog;
process.env.GRANTFINDER_LOG_STDOUT = '0';
check('log lines redact API keys', captured.some((line) => line.includes('sk-ant-[redacted]')) && !captured.some((line) => line.includes('SECRETSECRET')), captured);

// --- 5. Zip bombs are refused before exceljs/mammoth unzip them
function zipWith(name: string, payload: Buffer): Buffer {
  const deflated = zlib.deflateRawSync(payload);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(deflated.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(deflated.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const dirOffset = local.length + nameBuf.length + deflated.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(dirOffset, 16);
  return Buffer.concat([local, nameBuf, deflated, central, nameBuf, eocd]);
}
const bomb = zipWith('word/document.xml', Buffer.alloc(200 * 1024 * 1024, 0x20));
check('the test bomb is small on disk', bomb.length < 1024 * 1024, bomb.length);
const docForm = new FormData();
docForm.append('file', new Blob([bomb]), 'bomb.docx');
const docBomb = await api('POST', '/api/processing/upload-document', { token, form: docForm });
check('a .docx zip bomb -> 400 too large, no job', docBomb.status === 400 && /more than 120 MB/.test(docBomb.data.detail), docBomb.data);
const xlsForm = new FormData();
xlsForm.append('file', new Blob([zipWith('xl/worksheets/sheet1.xml', Buffer.alloc(200 * 1024 * 1024, 0x20))]), 'bomb.xlsx');
const xlsBomb = await api('POST', '/api/grants/upload', { token, form: xlsForm });
check('an .xlsx zip bomb -> 400 too large', xlsBomb.status === 400 && /more than 120 MB/.test(xlsBomb.data.detail), xlsBomb.data);
const junkForm = new FormData();
junkForm.append('file', new Blob([Buffer.from('not a zip at all, just text pretending')]), 'fake.docx');
const junk = await api('POST', '/api/processing/upload-document', { token, form: junkForm });
check('a fake .docx -> 400 from the parser (not a crash)', junk.status === 400 && /Word document/.test(junk.data.detail), junk.data);

// --- 6. CSV formulas starting with "-" are neutralized
const me = (await api('GET', '/api/auth/me', { token })).data;
const now = new Date().toISOString();
await saveMatchResults({
  session_id: 'match_20261014T000000000Z_deadbeef',
  user_id: me.id,
  profile_id: 'p',
  total_grants_evaluated: 1,
  matches: [{
    grant_id: 'g1', grant_name: '-2+3+cmd|calc', funder: '=HYPERLINK("x")', amount: '$1', deadline: 'Rolling', url: 'https://x.org',
    contact: '@me', category: 'mixed', geo_qualified: 'Yes', score: 50, score_tier: 'possible',
    score_breakdown: { eligibility_fit: 50, need_alignment: 50, capacity_signals: 50, timing: 50, completeness: 50 },
    explanation: 'ok', evidence: [], is_shortlisted: false,
  }],
  excellent_matches: 0, good_matches: 0, possible_matches: 1, weak_matches: 0, not_eligible: 0,
  created_at: now, expires_at: now,
});
const csv = await api('POST', '/api/export', { token, json: { session_id: 'match_20261014T000000000Z_deadbeef', format: 'csv', include_all_matches: true } });
check('CSV neutralizes cells starting with -, =, @', csv.status === 200 && csv.text.includes("'-2+3") && csv.text.includes("'=HYPERLINK") && csv.text.includes("'@me"), csv.text.slice(0, 400));

// --- 7. Anthropic spending limits fail clearly, with no fallback results
for (const [key, label] of [['sk-ant-spendcap-test-1', 'monthly spend cap (429)'], ['sk-ant-userlimit-test-1', 'user-set spend limit (400)']]) {
  const t = await guest();
  await saveKey(t, key);
  const q = await api('POST', '/api/discovery/seed', { token: t });
  void q;
  let result = await api('POST', '/api/processing/generate-questionnaire', { token: t });
  if (result.status === 202) {
    for (let i = 0; i < 300; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const poll = await api('GET', `/api/jobs/${result.data.job_id}`, { token: t });
      if (poll.data.status === 'done' || poll.data.status === 'failed') {
        result = poll;
        break;
      }
    }
  }
  check(
    `${label} -> step fails with the billing page named`,
    result.data?.status === 'failed' && /spending (cap|limit)/.test(result.data.error?.detail) && /settings\/billing/.test(result.data.error?.detail),
    result.data,
  );
}

mock.stop();
finish();
