/**
 * Deadline parsing, the Kenedy seed record, the matching prefilter, and the
 * writer's urgency flag. TypeScript port of backend/tests/check_deadlines.py.
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/deadlines.test.mts
 */
import fs from 'node:fs';
import path from 'node:path';

import { check, finish, repoRoot, setupEnv } from './helpers.mts';

setupEnv('deadlines');
const { parseDeadline, isUrgent, deadlinePassed } = await import('../../frontend/src/server/deadlines.ts');
const { loadSeedGrants } = await import('../../frontend/src/server/services/discovery.ts');
const { deterministicPrefilter } = await import('../../frontend/src/server/services/ai.ts');
const { normalizeProfile } = await import('../../frontend/src/server/types.ts');

const seedPath = path.join(repoRoot, 'frontend', 'src', 'server', 'data', 'seed_grants.json');
let seedOk = true;
try {
  JSON.parse(fs.readFileSync(seedPath, 'utf8'));
} catch {
  seedOk = false;
}
check('seed_grants.json is valid JSON', seedOk);

const same = (label: string, got: unknown, want: unknown) => check(`${label} -> ${JSON.stringify(got)}`, got === want, `want ${JSON.stringify(want)}`);

same('annual, day before', parseDeadline('Annual: October 15', '2026-10-14'), '2026-10-15');
same('annual, comma + abbrev', parseDeadline('Annually, Oct. 15', '2026-10-14'), '2026-10-15');
same('annual, dash + lowercase', parseDeadline('annual - oct 15', '2026-10-14'), '2026-10-15');
same('annual, on the day', parseDeadline('Annual: October 15', '2026-10-15'), '2026-10-15');
same('annual, day after rolls to next year', parseDeadline('Annual: October 15', '2026-10-16'), '2027-10-15');
same('annual Jan 5 across year end', parseDeadline('Annual: January 5', '2026-12-31'), '2027-01-05');
same('annual Feb 29, next leap year not within 1 yr -> null', parseDeadline('Annual: February 29', '2026-03-01'), null);
same('annual Feb 29 in 2028', parseDeadline('Annual: February 29', '2027-03-01'), '2028-02-29');
same('annual "Sept" abbreviation', parseDeadline('Annual: Sept 30', '2026-09-01'), '2026-09-30');
same('fixed ISO date unchanged', parseDeadline('2026-10-15'), '2026-10-15');
same('US date', parseDeadline('10/15/2026'), '2026-10-15');
same('short US date', parseDeadline('10/15/26'), '2026-10-15');
same('long date', parseDeadline('October 15, 2026'), '2026-10-15');
same('impossible date -> null', parseDeadline('2026-02-30'), null);
same("'Check website' -> null", parseDeadline('Check website'), null);
same("'Rolling' -> null", parseDeadline('Rolling'), null);
same('bogus month -> null', parseDeadline('Annual: Smarch 15', '2026-10-14'), null);
same('empty -> null', parseDeadline(''), null);

const { grants, foundations } = loadSeedGrants('verify-user');
const kenedyAll = grants.filter((grant) => grant.grant_name.startsWith('Kenedy'));
same('Kenedy record loads once', kenedyAll.length, 1);
const kenedy = kenedyAll[0];
same('Kenedy deadline', kenedy?.deadline, 'Annual: October 15');
same('Kenedy status', kenedy?.status, 'OPEN');
same('Kenedy geo', kenedy?.geo_qualified, 'Yes - TX Only');
same('Kenedy url', kenedy?.url, 'https://kenedy.org/grants/application-process/');
console.log(`INFO total seed grants: ${grants.length} foundations: ${foundations.length}`);

const profile = (state: string) =>
  normalizeProfile({ id: 'p1', user_id: 'verify-user', organization_name: '[School Name]', organization_type: 'both', city: '[City]', state });
same('TX parish school passes the Kenedy prefilter', deterministicPrefilter(kenedy, profile('TX'), '2026-10-14'), null);
check('non-Texas org is disqualified', deterministicPrefilter(kenedy, profile('OK'), '2026-10-14') !== null);
same('after Oct 15 the grant is NOT treated as expired', deterministicPrefilter(kenedy, profile('TX'), '2026-10-16'), null);
same('deadlinePassed is false for an annual deadline', deadlinePassed('Annual: October 15', '2026-10-16'), false);
same('a fixed past date is expired', deadlinePassed('2026-10-01', '2026-10-14'), true);
same('writer urgency flag on Oct 14 (deadline tomorrow)', isUrgent(kenedy?.deadline, 10, '2026-10-14'), true);
same('no urgency in the spring', isUrgent(kenedy?.deadline, 10, '2026-04-01'), false);

finish();
