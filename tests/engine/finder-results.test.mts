/**
 * Grant finder results as they stand today (QA fixes):
 *  1. saved results never keep offering a grant that was retired, deleted, closed, excluded or
 *     whose deadline passed: removed grants are flagged and counted in no tier, ruled-out ones
 *     become not eligible on read (score_before keeps the old score), the calendar and the
 *     Top-picks tiers skip them, and the stored results are never rewritten;
 *  2. starter foundations that duplicate a grant, or that take no applications, are not scored;
 *  3. Texas-local grants (by their geography text) are ruled out for schools elsewhere;
 *  4. the matching prompt carries who applies and the funder's own religious-eligibility words;
 *  5. CSV "Status" and "Confidence" columns, Markdown "partly verified".
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/finder-results.test.mts
 *   (GRANTFINDER_JOB_MODE=direct runs the AI steps the way Netlify does by default)
 */
import { api, call, check, finish, guest, saveKey, setupEnv, startMock } from './helpers.mts';

setupEnv('finder-results');
const mock = await startMock();

const repo = await import('../../frontend/src/server/repo.ts');
const types = await import('../../frontend/src/server/types.ts');
const deadlines = await import('../../frontend/src/server/deadlines.ts');
const ai = await import('../../frontend/src/server/services/ai.ts');
const exportResults = await import('../../frontend/src/server/services/exportResults.ts');
const processing = await import('../../frontend/src/server/routes/processing.ts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const today = deadlines.todayIso();
const plusDays = (days: number) => deadlines.addDaysIso(today, days);
const OPEN_DEADLINE = plusDays(137);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const REMOVED = processing.GRANT_REMOVED_PREFIX;

async function me(token: string): Promise<{ id: string }> {
  return (await api('GET', '/api/auth/me', { token })).data;
}

/** A complete stored grant record. */
function grantRecord(userId: string, id: string, name: string, extra: Record<string, unknown> = {}): Json {
  return {
    id,
    user_id: userId,
    created_at: '2026-01-01T00:00:00.000Z',
    grant_name: name,
    deadline: OPEN_DEADLINE,
    amount: 'Up to $10,000',
    funder: `${name} Fund`,
    description: 'Example description.',
    contact: 'See website',
    url: `https://example.org/${id}`,
    status: 'OPEN',
    geo_qualified: 'Yes',
    funder_stats: null,
    category: 'catholic_school',
    source: 'upload',
    eligibility_notes: null,
    funds_for: ['education'],
    ...extra,
  };
}

/** A saved match (as matching stores it). */
function matchRecord(grantId: string, name: string, score: number, extra: Record<string, unknown> = {}): Json {
  return {
    grant_id: grantId,
    grant_name: name,
    funder: `${name} Fund`,
    amount: 'Varies',
    deadline: OPEN_DEADLINE,
    url: '',
    contact: 'See website',
    category: 'catholic_school',
    geo_qualified: 'Yes',
    score,
    score_tier: ai.tierFor(score),
    score_breakdown: { eligibility_fit: score, need_alignment: score, capacity_signals: score, timing: score, completeness: score },
    explanation: `Example explanation for ${name}.`,
    evidence: ['Example evidence'],
    is_shortlisted: false,
    ...extra,
  };
}

function resultsOf(userId: string, sessionId: string, matches: Json[]): Json {
  const now = new Date();
  return {
    session_id: sessionId,
    user_id: userId,
    profile_id: 'profile_test',
    total_grants_evaluated: matches.length,
    matches,
    ...ai.tierCounts(matches),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
  };
}

function profileIn(userId: string, state: string, city = '[City]', extra: Record<string, unknown> = {}): Json {
  return types.normalizeProfile({
    user_id: userId,
    organization_name: '[School Name]',
    organization_type: 'both',
    city,
    state,
    has_school: true,
    student_count: 214,
    ...extra,
  });
}

const scoreItem = (id: string, score: number) => ({
  grant_id: id,
  score,
  score_breakdown: { eligibility_fit: score, need_alignment: score, capacity_signals: score, timing: score, completeness: score },
  explanation: `Mock score for ${id}`,
  evidence: ['Mock evidence'],
});

/** The grants JSON of every match prompt (the "GRANTS TO EVALUATE" block). */
function promptGrants(prompts: string[]): Json[] {
  const all: Json[] = [];
  for (const prompt of prompts) {
    const start = prompt.indexOf('GRANTS TO EVALUATE:\n');
    const end = prompt.indexOf('\n\nFor EACH grant');
    try {
      all.push(...JSON.parse(prompt.slice(start + 'GRANTS TO EVALUATE:\n'.length, end)));
    } catch {
      // checked by the callers
    }
  }
  return all;
}

async function matchPrompts(): Promise<string[]> {
  return (await mock.requests()).filter((r) => r.prompt_id === 'grant_match_batch_v1').map((r) => r.prompt);
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The grant ids of the VEVENTs in a calendar file. */
function icsGrantIds(text: string): string[] {
  return text
    .replace(/\r\n[ \t]/g, '')
    .split('\r\n')
    .filter((line) => line.startsWith('UID:'))
    .map((line) => line.slice(4).replace(/-\d{8}@grantfinder$/, ''));
}

// ===========================================================================
// 1. Unit: Texas-only geography
// ===========================================================================

const txOnly = ai.texasOnlyGeography;
const TEXAS_ONLY = [
  'Texas',
  'Texas only',
  'TX',
  'Statewide (Texas)',
  'Central Texas',
  'Central Texas: Travis, Williamson, Hays, Bastrop, Burnet and Caldwell counties',
  'Central Texas / Diocese of Austin',
  'Diocese of Austin only',
  'Catholic schools of the Diocese of Austin only',
  'Rural parishes and missions of the Diocese of Austin only',
  'Diocese of Austin parishes, missions and Catholic schools only',
  'Diocese of Dallas only (not open to Diocese of Austin parishes or schools)',
  'Catholic K-12 schools in the Archdiocese of Galveston-Houston, Archdiocese of San Antonio and Diocese of El Paso only (not Diocese of Austin)',
  'Diocese of Austin (chapters in Austin, Bryan, Waco and Temple)',
  'City of Austin',
  'City of Austin full-purpose jurisdiction only (project must be on civic property inside it)',
  'Travis, Williamson, Hays counties',
  'Bastrop, Hays, Travis and Williamson counties',
  'Seven Central Texas counties: Bastrop, Blanco, Burnet, Caldwell, Hays, Travis and Williamson',
  'LCRA service area: all or part of 73 Texas counties, including Travis, Williamson, Hays, Bastrop, Burnet, Caldwell, Blanco and Llano',
  'Greater Houston',
];
let misses = TEXAS_ONLY.filter((geography) => !txOnly(geography));
check('texasOnlyGeography: Texas, Texas regions, Texas dioceses "only", City of Austin, Texas counties -> true', misses.length === 0, misses);

const NOT_TEXAS_ONLY = [
  'National',
  'National (through the diocese)',
  'Texas focus with national grants',
  'Texas focus (Houston priority for poverty and civic/cultural grants, with secondary consideration for Austin, Dallas and the rest of Texas)',
  'National program; in Texas handled by the district where the private school is located, overseen by TEA',
  'National (Texas applicants apply through the Texas Public Safety Office)',
  'Listed metro areas only; in Texas: Dallas, Fort Worth, Houston and San Antonio (not Austin as of October 2026)',
  'Primary service areas of CHRISTUS Health hospitals in Texas, Louisiana and New Mexico (e.g. Southeast Texas)',
  '87 pre-approved Extension (mission) dioceses only; in Texas: Amarillo, Beaumont, Brownsville, El Paso, Laredo, Lubbock, San Angelo and Tyler',
  'Home mission dioceses and eparchies only (2025 Texas recipient: Diocese of Brownsville)',
  'Hays County priority (organizations serving Hays County exclusively or as part of a regional effort); occasional grants elsewhere in Austin and Central Texas',
  'Organizations where American Association members volunteer; Texas Areas listed: Dallas and Houston',
  'Service areas of participating CommonSpirit hospitals; in Texas: Brazos Valley (Bryan/College Station)',
  'Greater Austin, Texas metropolitan area (also greater Chicago, which is closed to new applicants)',
  '17 states where Honda has major U.S. operations, including Texas (AL, CA, CO, CT, DC, FL, GA, IN, IA, MI, NJ, NY, NC, OH, OR, SC, TX)',
  'States where Sprouts Farmers Market operates stores (includes Texas)',
  'Rural areas and towns of up to 20,000 population (Austin and its suburbs do not qualify)',
  'Texas and Oklahoma',
  'City of Austin, MN',
  'Williamson County',
  'Statewide',
  '',
  '   ',
];
misses = NOT_TEXAS_ONLY.filter((geography) => txOnly(geography));
check('texasOnlyGeography: conservative - "National", "Texas focus with national grants", other states, priorities, Texas parts of national programs -> false', misses.length === 0, misses);
check(
  'texasOnlyGeography: null/undefined -> false; "City of Austin" does not count for an organization in a city named Austin',
  txOnly(null) === false && txOnly(undefined) === false && txOnly('City of Austin', 'Austin') === false && txOnly('City of Austin', 'Columbus') === true &&
    txOnly('Diocese of Austin only', 'Austin') === true,
);

// ===========================================================================
// 2. Unit: deterministicPrefilter with the Texas geography rule
// ===========================================================================

const UNIT = 'user_unit_results';
const ohio = profileIn(UNIT, 'OH');
const texas = profileIn(UNIT, 'TX');
const austinGrant = grantRecord(UNIT, 'grant_00000000a001', 'Example Austin Diocese Grant', { geography: 'Diocese of Austin only', geo_qualified: 'Check eligibility' });
const ruled = ai.deterministicPrefilter(austinGrant, ohio, today);
check(
  'prefilter: geography "Diocese of Austin only" + an Ohio school -> not eligible, with a clear reason naming the geography and the state',
  ruled?.score === 0 && ruled?.score_tier === 'not_eligible' &&
    ruled?.explanation === 'Geographic restriction: this grant is limited to Texas (where applicants must be: "Diocese of Austin only"), and your organization is in OH.',
  ruled,
);
check('prefilter: the same grant for a Texas school goes on to Claude', ai.deterministicPrefilter(austinGrant, texas, today) === null);
check(
  'prefilter: unknown or unreadable state -> left to Claude (no guess)',
  ai.deterministicPrefilter(austinGrant, profileIn(UNIT, ''), today) === null && ai.deterministicPrefilter(austinGrant, profileIn(UNIT, 'Unknown'), today) === null,
);
check('prefilter: "Texas" spelled out or "Tx." counts as Texas', ai.deterministicPrefilter(austinGrant, profileIn(UNIT, 'Texas'), today) === null && ai.deterministicPrefilter(austinGrant, profileIn(UNIT, 'Tx.'), today) === null);
check(
  'prefilter: "National" and "Texas focus with national grants" are never ruled out for an Ohio school',
  ['National', 'Texas focus with national grants', null, ''].every(
    (geography) => ai.deterministicPrefilter(grantRecord(UNIT, 'grant_00000000a002', 'Example National Grant', { geography }), ohio, today) === null,
  ),
);
check(
  'prefilter: "City of Austin" is not ruled out for a school in Austin, Minnesota (but is for one in Columbus, Ohio)',
  ai.deterministicPrefilter(grantRecord(UNIT, 'grant_00000000a003', 'Example City Grant', { geography: 'City of Austin' }), profileIn(UNIT, 'MN', 'Austin'), today) === null &&
    ai.deterministicPrefilter(grantRecord(UNIT, 'grant_00000000a003', 'Example City Grant', { geography: 'City of Austin' }), profileIn(UNIT, 'OH', 'Columbus'), today) !== null,
);
const txFlag = ai.deterministicPrefilter(grantRecord(UNIT, 'grant_00000000a004', 'Example TX Flag Grant', { geo_qualified: 'Yes - TX Only' }), ohio, today);
check(
  'prefilter: geo_qualified "Yes - TX Only" keeps its own reason',
  txFlag?.explanation === 'Geographic restriction: this grant is limited to Texas organizations, and your organization is in OH.',
  txFlag,
);

// ===========================================================================
// 3. Unit: foundations (duplicates, no applications)
// ===========================================================================

let fdnSeq = 0;
const foundation = (name: string, cycle: string, notes: string | null = null): Json => ({
  id: `foundation_${String(++fdnSeq).padStart(12, '0')}`,
  user_id: UNIT,
  foundation_name: name,
  application_cycle: cycle,
  focus_areas: 'Catholic education',
  location: '[City], TX',
  contact: 'Via website',
  website: 'https://example.org/foundation',
  annual_giving: 'Check website',
  notes,
  created_at: '2026-01-01T00:00:00.000Z',
});
const F = {
  koch: foundation('Koch Foundation', 'Annual: Letters of Request January 1 - May 1', 'One request per cycle.'),
  osv: foundation('OSV Institute for Catholic Innovation (Our Sunday Visitor)', 'No open general grant cycle; CorWorks parish program application window October 9 - November 20'),
  theSame: foundation('Example Same Name Fund', 'Spring'),
  lilly: foundation(
    'Lilly Endowment (Religion Division)',
    'Initiative-based and by invitation; other requests start with a mailed preliminary letter of no more than two pages',
    'Runs mostly through announced initiatives and invited applicants; no unsolicited requests through the website contact form.',
  ),
  ghr: foundation('GHR Foundation', 'No application process; works with a focused set of partners', 'Selected partners only.'),
  porticus: foundation('Porticus North America', 'By invitation; does not accept unsolicited grant requests', "It states it 'cannot accept unsolicited requests for grants'."),
  fadica: foundation('FADICA (Foundations and Donors Interested in Catholic Activities)', 'N/A - peer network, not a grantmaker', 'Does not take grant applications.'),
  invitationOnly: foundation('Example Invitation Only Foundation', 'Invitation only', null),
  preferred: foundation('Example Catholic Foundation', 'Annual: March 1', 'Invitation preferred'),
  generic: foundation('Catholic Foundation', 'Annual: April 1'),
  quiet: foundation('Example Quiet Foundation', 'Spring and Fall', 'No unsolicited proposals; send a letter of inquiry first.'),
};
const unitGrants = [
  grantRecord(UNIT, 'grant_00000000f001', 'Koch Foundation Grants', { funder: 'Koch Foundation' }),
  grantRecord(UNIT, 'grant_00000000f002', 'CorWorks Parish Innovation Grants (OSV Institute for Catholic Innovation)', { funder: 'OSV Institute for Catholic Innovation' }),
  grantRecord(UNIT, 'grant_00000000f003', 'Faith and AI Rapid Response Grants (DELTA Partner Program)', {
    funder: 'University of Notre Dame Institute for Ethics and the Common Good (DELTA Network, supported by Lilly Endowment Inc.)',
  }),
  grantRecord(UNIT, 'grant_00000000f004', 'Example Same Name Fund (Foundation)', { funder: 'Someone Else' }),
  grantRecord(UNIT, 'grant_00000000f005', 'Example Community Grant', { funder: 'Texas Catholic Foundation Partners' }),
];
const allFoundations = Object.values(F);
check(
  'noApplicationsText: "not a grantmaker", "peer network", "no application process", "by invitation; does not accept unsolicited", "invitation only" -> monitor only',
  [F.ghr, F.porticus, F.fadica, F.invitationOnly].every((f) => ai.noApplicationsText(f) !== null),
  [F.ghr, F.porticus, F.fadica, F.invitationOnly].map((f) => [f.foundation_name, ai.noApplicationsText(f)]),
);
check(
  'noApplicationsText: foundations with a way in are kept ("other requests start with a preliminary letter", "letter of inquiry first", "Invitation preferred", an annual cycle)',
  [F.koch, F.osv, F.lilly, F.preferred, F.generic, F.quiet].every((f) => ai.noApplicationsText(f) === null),
  [F.koch, F.osv, F.lilly, F.preferred, F.generic, F.quiet].map((f) => [f.foundation_name, ai.noApplicationsText(f)]),
);
const entries = ai.foundationGrants(unitGrants, allFoundations, UNIT);
const skipOf = (f: Json) => entries.find((e: Json) => e.foundation.id === f.id);
check(
  'foundationGrants: Koch (a grant "Koch Foundation Grants" by "Koch Foundation") and OSV (its name without "(Our Sunday Visitor)" is the CorWorks funder) are duplicates',
  skipOf(F.koch)?.skip === 'duplicate' && skipOf(F.koch)?.duplicate_of === 'Koch Foundation Grants' && skipOf(F.osv)?.skip === 'duplicate' &&
    skipOf(F.osv)?.duplicate_of === 'CorWorks Parish Innovation Grants (OSV Institute for Catholic Innovation)',
  [skipOf(F.koch), skipOf(F.osv)].map((e: Json) => [e?.skip, e?.duplicate_of]),
);
check('foundationGrants: a grant already named "<foundation> (Foundation)" still marks it a duplicate (the old rule)', skipOf(F.theSame)?.skip === 'duplicate', skipOf(F.theSame)?.skip);
check(
  'foundationGrants: "supported by Lilly Endowment" in another program\'s funder is not a duplicate; a generic name ("Catholic Foundation") never is',
  skipOf(F.lilly)?.skip === null && skipOf(F.generic)?.skip === null && skipOf(F.preferred)?.skip === null,
  [skipOf(F.lilly)?.skip, skipOf(F.generic)?.skip, skipOf(F.preferred)?.skip],
);
check(
  'foundationGrants: GHR, Porticus, FADICA and "Invitation only" -> no_applications',
  [F.ghr, F.porticus, F.fadica, F.invitationOnly].every((f) => skipOf(f)?.skip === 'no_applications'),
  [F.ghr, F.porticus, F.fadica, F.invitationOnly].map((f) => skipOf(f)?.skip),
);
const matchable = ai.withFoundations(unitGrants, allFoundations, UNIT);
const pseudoNames = matchable.filter((g: Json) => g.category === 'foundations').map((g: Json) => g.grant_name).sort();
check(
  'withFoundations: only foundations that are neither duplicates nor monitor-only become "(Foundation)" grants',
  same(pseudoNames, [
    'Catholic Foundation (Foundation)',
    'Example Catholic Foundation (Foundation)',
    'Example Quiet Foundation (Foundation)',
    'Lilly Endowment (Religion Division) (Foundation)',
  ]) && matchable.length === unitGrants.length + 4,
  pseudoNames,
);
const everything = ai.withFoundations(unitGrants, allFoundations, UNIT, { includeSkipped: true });
check(
  'withFoundations includeSkipped: every foundation (for looking one up by id), stable ids',
  everything.length === unitGrants.length + allFoundations.length &&
    allFoundations.every((f) => everything.some((g: Json) => g.id === ai.foundationGrantId(f) && g.grant_name === `${f.foundation_name} (Foundation)`)),
  everything.length,
);
check(
  'noApplicationsReason says it takes no applications, quotes its own words, and that it stays on the foundations list',
  ai.noApplicationsReason(F.fadica) ===
    'Not eligible: FADICA (Foundations and Donors Interested in Catholic Activities) does not take grant applications ("N/A - peer network, not a grantmaker"). It stays on your foundations list to monitor; there is nothing to apply to.',
  ai.noApplicationsReason(F.fadica),
);

// ===========================================================================
// 4. Unit: withGrantDetails (computed on read)
// ===========================================================================

const U = {
  live: 'grant_00000000b001',
  closed: 'grant_00000000b002',
  gone: 'grant_00000000b003',
  wasNe: 'grant_00000000b004',
  austin: 'grant_00000000b005',
};
const unitStored = resultsOf(UNIT, 'session_unit', [
  matchRecord(U.gone, 'Example Gone Grant', 95, { is_shortlisted: true }),
  matchRecord(U.live, 'Example Live Grant', 90),
  matchRecord(U.closed, 'Example Closed Grant', 80),
  matchRecord(U.austin, 'Example Austin Grant', 70),
  matchRecord(U.wasNe, 'Example Was Not Eligible Grant', 12),
  matchRecord(ai.foundationGrantId(F.fadica), 'FADICA (Foundations and Donors Interested in Catholic Activities) (Foundation)', 64),
  matchRecord(ai.foundationGrantId(F.preferred), 'Example Catholic Foundation (Foundation)', 58),
]);
const unitStoredCopy = JSON.parse(JSON.stringify(unitStored));
const unitCurrentGrants = [
  grantRecord(UNIT, U.live, 'Example Live Grant', { confidence: 'partial', last_verified: '2026-09-01' }),
  grantRecord(UNIT, U.closed, 'Example Closed Grant', { status: 'CLOSED' }),
  grantRecord(UNIT, U.wasNe, 'Example Was Not Eligible Grant', { status: 'CLOSED' }),
  grantRecord(UNIT, U.austin, 'Example Austin Grant', { geography: 'Diocese of Austin only', geo_qualified: 'Check eligibility' }),
];
const unitRead = processing.withGrantDetails(unitStored, unitCurrentGrants, ohio, { foundations: [F.fadica, F.preferred], today });
const unitBy = (id: string) => unitRead.matches.find((m: Json) => m.grant_id === id) as Json;
check(
  'withGrantDetails: a grant no longer in the database -> grant_removed, explanation starts "No longer in your grant database.", saved facts kept',
  unitBy(U.gone)?.grant_removed === true && unitBy(U.gone)?.explanation === `${REMOVED}Example explanation for Example Gone Grant.` &&
    unitBy(U.gone)?.score === 95 && unitBy(U.gone)?.is_shortlisted === true && unitBy(U.gone)?.score_before === undefined,
  unitBy(U.gone),
);
check(
  'withGrantDetails: a grant now CLOSED -> score 0, not_eligible, score_before 80, the prefilter\'s reason, its status, breakdown of a ruled-out grant',
  unitBy(U.closed)?.score === 0 && unitBy(U.closed)?.score_tier === 'not_eligible' && unitBy(U.closed)?.score_before === 80 &&
    unitBy(U.closed)?.explanation === 'This grant is marked CLOSED in the database.' && unitBy(U.closed)?.status === 'CLOSED' &&
    unitBy(U.closed)?.score_breakdown.eligibility_fit === 0 && same(unitBy(U.closed)?.evidence, []) && !unitBy(U.closed)?.grant_removed,
  unitBy(U.closed),
);
check(
  'withGrantDetails: a match that was already not eligible is left as it was (no score_before), with the current status',
  unitBy(U.wasNe)?.score === 12 && unitBy(U.wasNe)?.score_before === undefined && unitBy(U.wasNe)?.explanation === 'Example explanation for Example Was Not Eligible Grant.' &&
    unitBy(U.wasNe)?.status === 'CLOSED',
  unitBy(U.wasNe),
);
check(
  'withGrantDetails: the CURRENT profile decides (Ohio school, "Diocese of Austin only") -> not eligible on read',
  unitBy(U.austin)?.score_tier === 'not_eligible' && unitBy(U.austin)?.score_before === 70 && /^Geographic restriction: this grant is limited to Texas/.test(unitBy(U.austin)?.explanation),
  unitBy(U.austin),
);
const fadicaRead = unitBy(ai.foundationGrantId(F.fadica));
check(
  'withGrantDetails: a saved match for a foundation that takes no applications -> not eligible with noApplicationsReason (score_before kept)',
  fadicaRead?.score_tier === 'not_eligible' && fadicaRead?.score_before === 64 && fadicaRead?.explanation === ai.noApplicationsReason(F.fadica) && !fadicaRead?.grant_removed,
  fadicaRead,
);
const preferredRead = unitBy(ai.foundationGrantId(F.preferred));
check('withGrantDetails: a saved match for a foundation still on the list is found (not removed), score kept', preferredRead?.score === 58 && !preferredRead?.grant_removed && preferredRead?.score_before === undefined, preferredRead);
check(
  'withGrantDetails: the live grant is unchanged, with its current status and confidence',
  unitBy(U.live)?.score === 90 && unitBy(U.live)?.status === 'OPEN' && unitBy(U.live)?.confidence === 'partial' && unitBy(U.live)?.score_before === undefined,
  unitBy(U.live),
);
check(
  'withGrantDetails: tiers recounted without the removed grant (1 excellent, 0 good, 1 possible, 4 not eligible)',
  unitRead.excellent_matches === 1 && unitRead.good_matches === 0 && unitRead.possible_matches === 1 && unitRead.weak_matches === 0 && unitRead.not_eligible === 4,
  [unitRead.excellent_matches, unitRead.good_matches, unitRead.possible_matches, unitRead.weak_matches, unitRead.not_eligible],
);
check(
  'withGrantDetails: best first, ruled-out ones dropped down, the removed one last',
  same(unitRead.matches.map((m: Json) => m.grant_id), [U.live, ai.foundationGrantId(F.preferred), U.wasNe, U.closed, U.austin, ai.foundationGrantId(F.fadica), U.gone]),
  unitRead.matches.map((m: Json) => [m.grant_name, m.score]),
);
check('withGrantDetails never changes the results it is given', same(unitStored, unitStoredCopy));
const noProfile = processing.withGrantDetails(unitStored, unitCurrentGrants, null, { today });
const noProfileBy = (id: string) => noProfile.matches.find((m: Json) => m.grant_id === id) as Json;
check(
  'withGrantDetails without a profile: CLOSED still ruled out; Texas geography left alone (state unknown); foundations not given -> their matches read as removed',
  noProfileBy(U.closed)?.score_tier === 'not_eligible' && noProfileBy(U.austin)?.score === 70 && noProfileBy(ai.foundationGrantId(F.preferred))?.grant_removed === true,
  [noProfileBy(U.closed)?.score_tier, noProfileBy(U.austin)?.score],
);

// Calendar and status labels (unit)
const calUnit = exportResults.calendarMatches(unitRead.matches, today).map((e: Json) => e.match.grant_id);
check('calendarMatches: never a removed grant (even shortlisted) nor one ruled out on read', !calUnit.includes(U.gone) && !calUnit.includes(U.closed) && !calUnit.includes(U.austin) && calUnit.includes(U.live), calUnit);
check(
  'matchStatusLabel: removed, ruled out since matching (with and without a status), the current status, nothing',
  exportResults.matchStatusLabel(unitBy(U.gone)) === exportResults.STATUS_REMOVED && exportResults.STATUS_REMOVED === 'Removed: no longer in your grant database' &&
    exportResults.matchStatusLabel(unitBy(U.closed)) === 'CLOSED; not eligible now (was 80%)' &&
    exportResults.matchStatusLabel({ ...unitBy(U.closed), status: undefined }) === 'Not eligible now (was 80%)' &&
    exportResults.matchStatusLabel(unitBy(U.live)) === 'OPEN' && exportResults.matchStatusLabel(matchRecord(U.live, 'X', 50)) === '',
  [unitBy(U.gone), unitBy(U.closed), unitBy(U.live)].map((m: Json) => exportResults.matchStatusLabel(m)),
);

// The "eligible" label means religious organizations may apply (not that a school can): CSV, Markdown and the calendar agree.
const eligibleMatch = { ...matchRecord('grant_00000000d0e1', 'Example Eligible Label Grant', 90, { deadline: plusDays(30) }), religious_eligibility: 'eligible' };
const labelCsv = parseCsv(exportResults.matchesCsv([eligibleMatch]).replace(/^﻿/, ''));
const labelMd = exportResults.matchesMarkdown([eligibleMatch], resultsOf(UNIT, 'session_label', [eligibleMatch]), new Date());
const labelIcs = exportResults.matchesIcs([eligibleMatch], new Date(), today).replace(/\r\n[ \t]/g, '');
check(
  'RELIGIOUS_ELIGIBILITY_LABELS.eligible is "Religious organizations eligible", used by CSV, Markdown and the calendar',
  exportResults.RELIGIOUS_ELIGIBILITY_LABELS.eligible === 'Religious organizations eligible' &&
    labelCsv[1]?.[labelCsv[0].indexOf('Religious Eligibility')] === 'Religious organizations eligible' &&
    labelMd.includes('| Religious eligibility | Religious organizations eligible |') && labelIcs.includes('\\nReligious eligibility: Religious organizations eligible\\n') &&
    !`${labelMd}${labelIcs}${labelCsv.join()}`.includes('Catholic schools eligible'),
  { csv: labelCsv[1], ics: labelIcs.split('\r\n').find((l) => l.startsWith('DESCRIPTION:')) },
);

// ===========================================================================
// 5. The matching prompt: who applies, the funder's own words
// ===========================================================================

const promptGrantsIn = [
  grantRecord(UNIT, 'grant_00000000c001', 'Example Diocesan Program', {
    applicants: ['diocese'],
    religious_eligibility: 'unclear',
    religious_eligibility_text: 'Open to public and private schools, including faith-based schools; no funds for worship.',
    deadline_notes: '2026 window closed September 30; next window not yet announced',
  }),
  grantRecord(UNIT, 'grant_00000000c002', 'Example Plain Grant'),
  grantRecord(UNIT, 'grant_00000000c003', 'Example Blank Fields Grant', { applicants: [], religious_eligibility_text: '   ' }),
];
const builtPrompt = ai.buildMatchPrompt(promptGrantsIn, profileIn(UNIT, 'TX', '[City]', { diocese: 'Diocese of [Diocese]' }), today);
const builtGrants = promptGrants([builtPrompt]);
const pDiocesan = builtGrants.find((g: Json) => g.id === 'grant_00000000c001');
check(
  'prompt: a grant with applicants and religious_eligibility_text carries both (the words exactly as written)',
  same(pDiocesan?.applicants, ['diocese']) && pDiocesan?.religious_eligibility_text === 'Open to public and private schools, including faith-based schools; no funds for worship.',
  pDiocesan,
);
check(
  'prompt: grants without them (or with empty ones) leave both keys out',
  builtGrants.filter((g: Json) => g.id !== 'grant_00000000c001').every((g: Json) => !('applicants' in g) && !('religious_eligibility_text' in g)) && builtGrants.length === 3,
  builtGrants,
);
check(
  'prompt: says how to read applicants (say so, lower eligibility_fit unless the profile shows the school would go through that channel)',
  builtPrompt.includes('- applicants: who submits the application') && builtPrompt.includes('If the organization can\'t apply itself (only a diocese, teachers or families apply), say so in the explanation') &&
    builtPrompt.includes('lower eligibility_fit, unless the profile shows the organization would go through that channel'),
  builtPrompt.slice(builtPrompt.indexOf('Reading the grant fields:')),
);
check(
  'prompt: says how to read religious_eligibility_text (the funder\'s own words)',
  builtPrompt.includes("- religious_eligibility_text: the funder's own words about religious organizations, exactly as the source wrote them."),
);
check(
  'prompt: a closed window with no next date posted lowers timing (and the old rules stay)',
  builtPrompt.includes('An application window that has closed with no next date posted lowers timing') && builtPrompt.includes('An invitation-only program scores low on timing.') &&
    builtPrompt.includes('- religious_eligibility: "eligible"') && builtPrompt.includes('Real giving outweighs stated priorities'),
);
check('prompt: the profile names its diocese (for diocesan programs)', builtPrompt.includes('"diocese": "Diocese of [Diocese]"'));

// ===========================================================================
// 6. Routes: results read after grants change (the critical QA bug)
// ===========================================================================

const tokenR = await guest();
await saveKey(tokenR);
const userR = await me(tokenR);
await repo.saveProfile(userR.id, profileIn(userR.id, 'TX'));
const R = {
  OPEN: 'grant_0000000a0001',
  CLOSE: 'grant_0000000a0002',
  EXCL: 'grant_0000000a0003',
  PAST: 'grant_0000000a0004',
  REMOVE: 'grant_0000000a0005',
  ALREADY_NE: 'grant_0000000a0006',
  TXONLY: 'grant_0000000a0007',
  TXGEO: 'grant_0000000a0008',
  CITY: 'grant_0000000a0009',
  COUNTIES: 'grant_0000000a000a',
  NATIONAL: 'grant_0000000a000b',
  TXFOCUS: 'grant_0000000a000c',
  ROLLING: 'grant_0000000a000d',
};
const SCORES: Record<string, number> = {
  [R.OPEN]: 90, [R.CLOSE]: 80, [R.EXCL]: 88, [R.PAST]: 60, [R.REMOVE]: 95, [R.ALREADY_NE]: 10, [R.TXONLY]: 75,
  [R.TXGEO]: 72, [R.CITY]: 65, [R.COUNTIES]: 55, [R.NATIONAL]: 78, [R.TXFOCUS]: 74, [R.ROLLING]: 71,
};
const DUE: Record<string, string> = {
  [R.OPEN]: plusDays(40), [R.CLOSE]: plusDays(50), [R.EXCL]: plusDays(60), [R.PAST]: plusDays(30), [R.REMOVE]: plusDays(20),
  [R.ALREADY_NE]: plusDays(25), [R.TXONLY]: plusDays(35), [R.TXGEO]: plusDays(45), [R.CITY]: plusDays(55), [R.COUNTIES]: plusDays(65),
  [R.NATIONAL]: plusDays(70), [R.TXFOCUS]: plusDays(75), [R.ROLLING]: 'Rolling',
};
const rGrant = (id: string, name: string, extra: Record<string, unknown> = {}) => grantRecord(userR.id, id, name, { deadline: DUE[id], ...extra });
await repo.saveGrants(userR.id, [
  rGrant(R.OPEN, 'Example Open Grant', { last_verified: '2026-09-01', confidence: 'partial' }),
  rGrant(R.CLOSE, 'Example Soon Closed Grant'),
  rGrant(R.EXCL, 'Example Soon Excluded Grant'),
  rGrant(R.PAST, 'Example Soon Past Grant'),
  rGrant(R.REMOVE, 'Example Soon Removed Grant'),
  rGrant(R.ALREADY_NE, 'Example Already Not Eligible Grant'),
  rGrant(R.TXONLY, 'Example Diocese Of Austin Grant', { geography: 'Diocese of Austin only', geo_qualified: 'Check eligibility' }),
  rGrant(R.TXGEO, 'Example Texas Flag Grant', { geography: 'Texas', geo_qualified: 'Yes - TX Only' }),
  rGrant(R.CITY, 'Example City Of Austin Grant', { geography: 'City of Austin', geo_qualified: 'Check eligibility' }),
  rGrant(R.COUNTIES, 'Example Central Counties Grant', { geography: 'Travis, Williamson, Hays counties', geo_qualified: 'Check eligibility' }),
  rGrant(R.NATIONAL, 'Example National Grant', { geography: 'National', last_verified: '2026-08-15', confidence: 'verified' }),
  rGrant(R.TXFOCUS, 'Example Texas Focus Grant', { geography: 'Texas focus with national grants', geo_qualified: 'Check eligibility' }),
  rGrant(R.ROLLING, 'Example Rolling Grant', { status: 'Rolling' }),
]);
await mock.reset();
await mock.fixtures({ grant_match_batch_v1: JSON.stringify(Object.entries(SCORES).map(([id, score]) => scoreItem(id, score))) });
const runR = await call('POST', '/api/processing/match-grants', { token: tokenR });
const byIdIn = (results: Json, id: string): Json => results?.matches?.find((m: Json) => m.grant_id === id);
check(
  'matching (Texas school): all 13 grants scored by the mock as given, none ruled out',
  runR.status === 200 && runR.data.matches.length === 13 && Object.entries(SCORES).every(([id, score]) => byIdIn(runR.data, id)?.score === score),
  runR.data?.matches?.map((m: Json) => [m.grant_name, m.score]),
);
const sessionR: string = runR.data.session_id;
for (const id of [R.OPEN, R.CLOSE, R.REMOVE]) {
  await api('POST', `/api/processing/shortlist/${id}?shortlist=true&session_id=${sessionR}`, { token: tokenR });
}
const storedBefore = JSON.stringify(await repo.getMatchResults(userR.id, sessionR));
const icsBefore = await api('POST', '/api/export', { token: tokenR, json: { session_id: sessionR, format: 'ics', include_all_matches: true } });
check(
  'before the grants change: the calendar has every upcoming excellent/good/possible grant (11)',
  icsBefore.status === 200 && icsGrantIds(icsBefore.text).length === 11 && icsGrantIds(icsBefore.text).includes(R.REMOVE) && icsGrantIds(icsBefore.text).includes(R.CLOSE),
  icsGrantIds(icsBefore.text),
);

// The grants change after matching: retired (removed), closed, religious exclusion found, deadline moved into the past.
const PAST_DUE = plusDays(-5);
await repo.updateGrants(userR.id, (list) =>
  list
    .filter((g) => g.id !== R.REMOVE)
    .map((g) => {
      if (g.id === R.CLOSE || g.id === R.ALREADY_NE) return { ...g, status: 'CLOSED' as const };
      if (g.id === R.EXCL) return { ...g, religious_eligibility: 'excluded' as const };
      if (g.id === R.PAST) return { ...g, deadline: PAST_DUE };
      return g;
    }),
);
const latestR = await api('GET', '/api/processing/match-results/latest', { token: tokenR });
const L = latestR.data;
const removedR = byIdIn(L, R.REMOVE);
check(
  'read after the grant was removed: grant_removed, explanation starts "No longer in your grant database.", saved facts kept',
  latestR.status === 200 && removedR?.grant_removed === true && removedR?.explanation === `${REMOVED}Mock score for ${R.REMOVE}` && removedR?.score === 95 &&
    removedR?.deadline === DUE[R.REMOVE] && removedR?.is_shortlisted === true,
  removedR,
);
const closedR = byIdIn(L, R.CLOSE);
check(
  'grant CLOSED after matching -> not_eligible on read, score 0, score_before 80, "marked CLOSED" reason, status CLOSED',
  closedR?.score === 0 && closedR?.score_tier === 'not_eligible' && closedR?.score_before === 80 && closedR?.explanation === 'This grant is marked CLOSED in the database.' &&
    closedR?.status === 'CLOSED',
  closedR,
);
const exclR = byIdIn(L, R.EXCL);
check(
  'grant now excluding religious organizations -> not_eligible on read with RELIGIOUS_EXCLUDED_REASON, score_before 88',
  exclR?.score === 0 && exclR?.score_tier === 'not_eligible' && exclR?.score_before === 88 && exclR?.explanation === ai.RELIGIOUS_EXCLUDED_REASON && exclR?.religious_eligibility === 'excluded',
  exclR,
);
const pastR = byIdIn(L, R.PAST);
check(
  'deadline moved into the past -> not_eligible on read with the "Deadline passed" reason, score_before 60, deadline_passed true',
  pastR?.score === 0 && pastR?.score_tier === 'not_eligible' && pastR?.score_before === 60 &&
    pastR?.explanation === `Deadline passed (${PAST_DUE}). Check the funder's website for the next cycle.` && pastR?.deadline_passed === true,
  pastR,
);
const alreadyR = byIdIn(L, R.ALREADY_NE);
check('a match already not eligible stays as it was (score 10, no score_before), with status CLOSED', alreadyR?.score === 10 && alreadyR?.score_before === undefined && alreadyR?.status === 'CLOSED', alreadyR);
const openR = byIdIn(L, R.OPEN);
check(
  'an unchanged grant keeps its score and carries its current status (no score_before, not removed)',
  openR?.score === 90 && openR?.score_tier === 'excellent' && openR?.status === 'OPEN' && openR?.score_before === undefined && openR?.grant_removed === undefined &&
    byIdIn(L, R.ROLLING)?.status === 'Rolling',
  openR,
);
check(
  'tier counts recomputed from the adjusted matches, the removed one in none (1 excellent, 5 good, 2 possible, 0 weak, 4 not eligible)',
  L.excellent_matches === 1 && L.good_matches === 5 && L.possible_matches === 2 && L.weak_matches === 0 && L.not_eligible === 4 && L.matches.length === 13,
  [L.excellent_matches, L.good_matches, L.possible_matches, L.weak_matches, L.not_eligible],
);
const visible = L.matches.filter((m: Json) => !m.grant_removed);
check(
  'matches best first (the ruled-out ones dropped to 0), the removed one last',
  visible.every((m: Json, i: number) => i === 0 || visible[i - 1].score >= m.score) && L.matches[L.matches.length - 1].grant_id === R.REMOVE,
  L.matches.map((m: Json) => [m.grant_name, m.score, Boolean(m.grant_removed)]),
);
// The dashboard's Top picks take excellent/good (then possible) matches whose deadline hasn't passed: none of these may qualify now.
const topPickPool = L.matches.filter((m: Json) => !m.grant_removed && !m.deadline_passed && ['excellent', 'good', 'possible'].includes(m.score_tier)).map((m: Json) => m.grant_id);
check(
  'Top-picks pool (excellent/good/possible, deadline open, not removed) has none of the closed, excluded, past or removed grants',
  [R.CLOSE, R.EXCL, R.PAST, R.REMOVE].every((id) => !topPickPool.includes(id)) && topPickPool.includes(R.OPEN) && topPickPool.length === 8 &&
    [R.CLOSE, R.EXCL, R.PAST].every((id) => byIdIn(L, id)?.score_tier === 'not_eligible'),
  topPickPool,
);
check('the stored results are never rewritten (computed on read)', JSON.stringify(await repo.getMatchResults(userR.id, sessionR)) === storedBefore);
const bySessionR = await api('GET', `/api/processing/match-results/${sessionR}`, { token: tokenR });
check(
  'GET match-results/:sessionId gives the same adjusted view',
  bySessionR.status === 200 && same(bySessionR.data.matches.map((m: Json) => [m.grant_id, m.score, m.score_tier, m.grant_removed ?? null]), L.matches.map((m: Json) => [m.grant_id, m.score, m.score_tier, m.grant_removed ?? null])) &&
    bySessionR.data.not_eligible === 4,
  bySessionR.data?.not_eligible,
);

// Calendar: skips removed and now-not-eligible grants (even shortlisted).
const icsAfter = await api('POST', '/api/export', { token: tokenR, json: { session_id: sessionR, format: 'ics', include_all_matches: true } });
const icsIds = icsGrantIds(icsAfter.text);
check(
  'calendar after the change: only the 7 upcoming grants still open to the school (removed, closed, excluded, past left off)',
  icsAfter.status === 200 && same([...icsIds].sort(), [R.OPEN, R.TXONLY, R.TXGEO, R.CITY, R.COUNTIES, R.NATIONAL, R.TXFOCUS].sort()),
  icsIds,
);
const icsShortlisted = await api('POST', '/api/export', { token: tokenR, json: { session_id: sessionR, format: 'ics' } });
check(
  'shortlisted calendar: the shortlisted removed and closed grants stay off; only the open one is on it',
  icsShortlisted.status === 200 && same(icsGrantIds(icsShortlisted.text), [R.OPEN]),
  icsShortlisted.status === 200 ? icsGrantIds(icsShortlisted.text) : icsShortlisted.data,
);

// CSV: Status and Confidence columns; exports use the same adjusted view.
const csvR = await api('POST', '/api/export', { token: tokenR, json: { session_id: sessionR, format: 'csv', include_all_matches: true } });
const csvRows = parseCsv(csvR.text.replace(/^﻿/, ''));
const header = csvRows[0] ?? [];
check(
  'CSV header: "Status" right after "Tier", "Confidence" right after "Last Verified"',
  csvR.status === 200 && header[header.indexOf('Tier') + 1] === 'Status' && header[header.indexOf('Last Verified') + 1] === 'Confidence' && header.length === 24,
  header,
);
const csvCell = (id: string, column: string) => {
  const name = byIdIn(L, id)?.grant_name;
  const row = csvRows.find((r) => r[1] === name);
  return row ? row[header.indexOf(column)] : undefined;
};
check(
  'CSV Status: removed, ruled out since matching (status; was N%), current status',
  csvCell(R.REMOVE, 'Status') === exportResults.STATUS_REMOVED && csvCell(R.CLOSE, 'Status') === 'CLOSED; not eligible now (was 80%)' &&
    csvCell(R.EXCL, 'Status') === 'OPEN; not eligible now (was 88%)' && csvCell(R.OPEN, 'Status') === 'OPEN' && csvCell(R.ROLLING, 'Status') === 'Rolling' &&
    csvCell(R.ALREADY_NE, 'Status') === 'CLOSED',
  [R.REMOVE, R.CLOSE, R.EXCL, R.OPEN, R.ROLLING].map((id) => csvCell(id, 'Status')),
);
check(
  'CSV: the adjusted score, tier and explanation (the explanation says why)',
  csvCell(R.CLOSE, 'Score (%)') === '0' && csvCell(R.CLOSE, 'Tier') === 'not_eligible' && csvCell(R.CLOSE, 'Explanation') === 'This grant is marked CLOSED in the database.' &&
    csvCell(R.REMOVE, 'Explanation') === `${REMOVED}Mock score for ${R.REMOVE}`,
  [csvCell(R.CLOSE, 'Score (%)'), csvCell(R.CLOSE, 'Explanation'), csvCell(R.REMOVE, 'Explanation')],
);
check(
  'CSV Confidence: partial / verified / empty',
  csvCell(R.OPEN, 'Confidence') === 'partial' && csvCell(R.OPEN, 'Last Verified') === '2026-09-01' && csvCell(R.NATIONAL, 'Confidence') === 'verified' &&
    csvCell(R.ROLLING, 'Confidence') === '',
  [csvCell(R.OPEN, 'Confidence'), csvCell(R.NATIONAL, 'Confidence'), csvCell(R.ROLLING, 'Confidence')],
);
check('CSV rank order follows the adjusted view (the removed grant last)', csvRows.length === 14 && csvRows[13][1] === byIdIn(L, R.REMOVE)?.grant_name && csvRows[13][0] === '13', csvRows.map((r) => r[1]));

// Markdown: partly verified, Status rows, summary from the adjusted view.
const mdR = await api('POST', '/api/export', { token: tokenR, json: { session_id: sessionR, format: 'md', include_all_matches: true } });
const mdSections = mdR.text.split(/\n(?=### \d+\. )/).slice(1);
const mdSection = (id: string) => mdSections.find((s) => s.split('\n')[0].endsWith(byIdIn(L, id)?.grant_name ?? '???')) ?? '';
check(
  'Markdown: "Last verified | <date> (partly verified)" when partial; just the date when verified',
  mdR.status === 200 && mdSection(R.OPEN).includes('| Last verified | 2026-09-01 (partly verified) |') && mdSection(R.NATIONAL).includes('| Last verified | 2026-08-15 |') &&
    !mdSection(R.NATIONAL).includes('partly verified'),
  mdSection(R.OPEN),
);
check(
  'Markdown: Status rows mark removed and now-not-eligible grants; the explanation says why',
  mdSection(R.REMOVE).includes(`| Status | ${exportResults.STATUS_REMOVED} |`) && mdSection(R.REMOVE).includes(`**Why this match:** ${REMOVED}`) &&
    mdSection(R.CLOSE).includes('| Status | CLOSED; not eligible now (was 80%) |') && mdSection(R.CLOSE).includes('**Score:** ⚫ 0% (Not Eligible)') &&
    mdSection(R.OPEN).includes('| Status | OPEN |'),
  mdSection(R.CLOSE),
);
check(
  'Markdown summary: the adjusted tier counts, plus how many are no longer in the grant database',
  mdR.text.includes('- Excellent Matches (85-100%): 1') && mdR.text.includes('- Good Matches (70-84%): 5') && mdR.text.includes('- Not Eligible (0-24%): 4') &&
    mdR.text.includes('- No longer in your grant database (not counted above): 1'),
  mdR.text.slice(0, 700),
);

// The profile moves out of Texas: Texas-only and Texas-place grants are ruled out on read.
await repo.updateProfile(userR.id, (current) => ({ ...(current ?? profileIn(userR.id, 'OH')), state: 'OH' }));
const ohioRead = (await api('GET', '/api/processing/match-results/latest', { token: tokenR })).data;
const geoReason = (geography: string) =>
  `Geographic restriction: this grant is limited to Texas (where applicants must be: "${geography}"), and your organization is in OH.`;
check(
  'profile moved to Ohio: "Diocese of Austin only", "City of Austin", "Travis, Williamson, Hays counties" -> not eligible on read with the Texas reason',
  byIdIn(ohioRead, R.TXONLY)?.score_tier === 'not_eligible' && byIdIn(ohioRead, R.TXONLY)?.score_before === 75 && byIdIn(ohioRead, R.TXONLY)?.explanation === geoReason('Diocese of Austin only') &&
    byIdIn(ohioRead, R.CITY)?.explanation === geoReason('City of Austin') && byIdIn(ohioRead, R.CITY)?.score_before === 65 &&
    byIdIn(ohioRead, R.COUNTIES)?.explanation === geoReason('Travis, Williamson, Hays counties') && byIdIn(ohioRead, R.COUNTIES)?.score_before === 55,
  [R.TXONLY, R.CITY, R.COUNTIES].map((id) => [byIdIn(ohioRead, id)?.score, byIdIn(ohioRead, id)?.explanation]),
);
check(
  '...and the "Yes - TX Only" grant with its own reason',
  byIdIn(ohioRead, R.TXGEO)?.score_tier === 'not_eligible' && byIdIn(ohioRead, R.TXGEO)?.score_before === 72 &&
    byIdIn(ohioRead, R.TXGEO)?.explanation === 'Geographic restriction: this grant is limited to Texas organizations, and your organization is in OH.',
  byIdIn(ohioRead, R.TXGEO),
);
check(
  '..."National" and "Texas focus with national grants" keep their scores',
  byIdIn(ohioRead, R.NATIONAL)?.score === 78 && byIdIn(ohioRead, R.TXFOCUS)?.score === 74 && byIdIn(ohioRead, R.TXFOCUS)?.score_before === undefined,
  [byIdIn(ohioRead, R.NATIONAL), byIdIn(ohioRead, R.TXFOCUS)].map((m: Json) => [m?.score, m?.explanation]),
);
check(
  '...tiers recounted (1 excellent, 3 good, 0 possible, 8 not eligible)',
  ohioRead.excellent_matches === 1 && ohioRead.good_matches === 3 && ohioRead.possible_matches === 0 && ohioRead.weak_matches === 0 && ohioRead.not_eligible === 8,
  [ohioRead.excellent_matches, ohioRead.good_matches, ohioRead.possible_matches, ohioRead.weak_matches, ohioRead.not_eligible],
);
const icsOhio = await api('POST', '/api/export', { token: tokenR, json: { session_id: sessionR, format: 'ics', include_all_matches: true } });
check('...the calendar now has only the open grants an Ohio school can apply to', icsOhio.status === 200 && same([...icsGrantIds(icsOhio.text)].sort(), [R.OPEN, R.NATIONAL, R.TXFOCUS].sort()), icsGrantIds(icsOhio.text));
check('...and the stored results are still untouched', JSON.stringify(await repo.getMatchResults(userR.id, sessionR)) === storedBefore);

// Matching again as an Ohio school: the Texas-place grants are ruled out before Claude.
await mock.reset();
await mock.fixtures({ grant_match_batch_v1: JSON.stringify(Object.entries(SCORES).map(([id, score]) => scoreItem(id, score))) });
const runOhio = await call('POST', '/api/processing/match-grants', { token: tokenR });
const ohioPrompts = await matchPrompts();
const sentOhio = promptGrants(ohioPrompts).map((g: Json) => g.id);
check(
  'matching as an Ohio school: Texas-only and Texas-place grants never reach Claude; National and "Texas focus" ones do',
  runOhio.status === 200 && ohioPrompts.length >= 1 && [R.TXONLY, R.TXGEO, R.CITY, R.COUNTIES].every((id) => !sentOhio.includes(id)) &&
    [R.NATIONAL, R.TXFOCUS, R.OPEN].every((id) => sentOhio.includes(id)),
  sentOhio,
);
check(
  '...and they are not eligible with the Texas reason in the new results',
  byIdIn(runOhio.data, R.TXONLY)?.explanation === geoReason('Diocese of Austin only') && byIdIn(runOhio.data, R.COUNTIES)?.score === 0 && runOhio.data.matches.length === 12,
  byIdIn(runOhio.data, R.TXONLY),
);

// ===========================================================================
// 7. Routes: a starter grant retired by a refresh (the QA scenario end to end)
// ===========================================================================

const tokenT = await guest();
await saveKey(tokenT);
const userT = await me(tokenT);
await repo.saveProfile(userT.id, profileIn(userT.id, 'TX'));
const T = { dropped: 'grant_0000000d0001', kept: 'grant_0000000d0002', mine: 'grant_0000000d0003' };
await repo.saveGrants(userT.id, [
  grantRecord(userT.id, T.dropped, 'Example Discontinued Starter Grant', { source: 'seed', funder: 'Example Ended Fund' }),
  grantRecord(userT.id, T.kept, 'Example Retired Starter With Application', { source: 'seed', funder: 'Example Closing Fund' }),
  grantRecord(userT.id, T.mine, 'Example My Own Grant', { source: 'upload' }),
]);
await mock.reset();
await mock.fixtures({ grant_match_batch_v1: JSON.stringify([scoreItem(T.dropped, 91), scoreItem(T.kept, 86), scoreItem(T.mine, 77)]) });
const runT = await call('POST', '/api/processing/match-grants', { token: tokenT });
check('matching the three grants', runT.status === 200 && runT.data.excellent_matches === 2 && runT.data.good_matches === 1, runT.data?.matches?.map((m: Json) => [m.grant_name, m.score]));
const appT = await api('POST', '/api/writer/applications', { token: tokenT, json: { grant_id: T.kept } });
check('an application is opened for one starter grant', appT.status === 200, appT.data);
const seedT = await api('POST', '/api/discovery/seed', { token: tokenT });
check('the starter refresh retires both (neither is in the starter file)', seedT.status === 200 && seedT.data.retired === 2, seedT.data);
const latestT = (await api('GET', '/api/processing/match-results/latest', { token: tokenT })).data;
check(
  'the retired grant with no application is gone -> grant_removed, in no tier',
  byIdIn(latestT, T.dropped)?.grant_removed === true && byIdIn(latestT, T.dropped)?.explanation.startsWith(REMOVED) && latestT.excellent_matches === 0,
  byIdIn(latestT, T.dropped),
);
check(
  'the retired grant kept for its application is CLOSED -> not eligible, score_before 86',
  byIdIn(latestT, T.kept)?.score_tier === 'not_eligible' && byIdIn(latestT, T.kept)?.score_before === 86 && byIdIn(latestT, T.kept)?.status === 'CLOSED' &&
    byIdIn(latestT, T.kept)?.explanation === 'This grant is marked CLOSED in the database.',
  byIdIn(latestT, T.kept),
);
check(
  'tiers: only the person\'s own grant still counts (1 good, 1 not eligible)',
  latestT.good_matches === 1 && latestT.not_eligible === 1 && latestT.excellent_matches === 0 && latestT.possible_matches === 0 && latestT.weak_matches === 0,
  [latestT.excellent_matches, latestT.good_matches, latestT.not_eligible],
);

// ===========================================================================
// 8. Routes: foundations in matching (duplicates and monitor-only are not scored)
// ===========================================================================

const tokenF = await guest();
await saveKey(tokenF);
const userF = await me(tokenF);
await repo.saveProfile(userF.id, profileIn(userF.id, 'TX'));
const fGrants = unitGrants.map((g: Json) => ({ ...g, user_id: userF.id }));
const fFoundations = allFoundations.map((f: Json) => ({ ...f, user_id: userF.id }));
await repo.saveGrants(userF.id, fGrants);
await repo.saveFoundations(userF.id, fFoundations);
await mock.reset();
await mock.fixtures({
  grant_match_batch_v1: JSON.stringify([
    ...fGrants.map((g: Json) => scoreItem(g.id, 70)),
    ...fFoundations.map((f: Json) => ({ ...scoreItem(`${f.foundation_name} (Foundation)`, 60), grant_name: `${f.foundation_name} (Foundation)` })),
  ]),
});
const runF = await call('POST', '/api/processing/match-grants', { token: tokenF });
const fNames = (runF.data?.matches ?? []).map((m: Json) => m.grant_name);
const fIds = (runF.data?.matches ?? []).map((m: Json) => m.grant_id);
const SKIPPED = [F.koch, F.osv, F.theSame, F.ghr, F.porticus, F.fadica, F.invitationOnly];
/** A skipped foundation's own "(Foundation)" id (a real grant may share its name, as "Example Same Name Fund (Foundation)" does). */
const skippedIds = SKIPPED.map((f) => ai.foundationGrantId(fFoundations.find((x: Json) => x.id === f.id)));
check(
  'matching: 5 grants + 4 matchable foundations = 9 evaluated',
  runF.status === 200 && runF.data.total_grants_evaluated === 9 && runF.data.matches.length === 9,
  fNames,
);
check(
  'no "(Foundation)" pseudo-grant is scored for a duplicate or a monitor-only foundation',
  skippedIds.every((id) => !fIds.includes(id)) && fNames.filter((n: string) => n === 'Example Same Name Fund (Foundation)').length === 1 &&
    ['Lilly Endowment (Religion Division) (Foundation)', 'Example Catholic Foundation (Foundation)', 'Catholic Foundation (Foundation)', 'Example Quiet Foundation (Foundation)'].every((n) => fNames.includes(n)),
  fNames,
);
const fPrompts = await matchPrompts();
const fSent = promptGrants(fPrompts);
check(
  'the skipped foundations never reach Claude',
  fPrompts.length >= 1 && skippedIds.every((id) => !fSent.some((g: Json) => g.id === id)) &&
    SKIPPED.filter((f) => f !== F.theSame).every((f) => !fSent.some((g: Json) => g.name === `${f.foundation_name} (Foundation)`)) &&
    fSent.some((g: Json) => g.name === 'Lilly Endowment (Religion Division) (Foundation)'),
  fSent.map((g: Json) => [g.id, g.name]),
);
check(
  'skipped foundations stay in the foundations list',
  (await api('GET', '/api/grants/foundations', { token: tokenF })).data?.length === allFoundations.length,
);
const resolvedSkipped = await ai.getGrantOrFoundation(userF.id, ai.foundationGrantId(fFoundations.find((f: Json) => f.foundation_name === 'GHR Foundation')));
check('getGrantOrFoundation still resolves a skipped foundation (an application opened before keeps working)', resolvedSkipped?.grant_name === 'GHR Foundation (Foundation)', resolvedSkipped?.grant_name);

// Results saved before this fix (a monitor-only foundation was scored): ruled out on read.
const ghr = fFoundations.find((f: Json) => f.foundation_name === 'GHR Foundation');
const lilly = fFoundations.find((f: Json) => f.foundation_name === 'Lilly Endowment (Religion Division)');
await repo.saveMatchResults(
  resultsOf(userF.id, 'match_20260101T000000000Z_0000beef', [
    matchRecord(ai.foundationGrantId(ghr), 'GHR Foundation (Foundation)', 82, { category: 'foundations' }),
    matchRecord(ai.foundationGrantId(lilly), 'Lilly Endowment (Religion Division) (Foundation)', 66, { category: 'foundations' }),
  ]),
);
const oldF = (await api('GET', '/api/processing/match-results/match_20260101T000000000Z_0000beef', { token: tokenF })).data;
check(
  'old results: the monitor-only foundation -> not eligible with its own words; the matchable one keeps its score',
  byIdIn(oldF, ai.foundationGrantId(ghr))?.score_tier === 'not_eligible' && byIdIn(oldF, ai.foundationGrantId(ghr))?.score_before === 82 &&
    byIdIn(oldF, ai.foundationGrantId(ghr))?.explanation === ai.noApplicationsReason(ghr) && byIdIn(oldF, ai.foundationGrantId(lilly))?.score === 66 &&
    !byIdIn(oldF, ai.foundationGrantId(lilly))?.grant_removed && oldF.good_matches === 0 && oldF.possible_matches === 1 && oldF.not_eligible === 1,
  oldF?.matches?.map((m: Json) => [m.grant_name, m.score, m.explanation]),
);

// ===========================================================================
// 9. Routes: the prompt carries who applies and the funder's own words
// ===========================================================================

const tokenP = await guest();
await saveKey(tokenP);
const userP = await me(tokenP);
await repo.saveProfile(userP.id, profileIn(userP.id, 'TX'));
await repo.saveGrants(userP.id, [
  grantRecord(userP.id, 'grant_0000000e0001', 'Example Teacher Grant', { applicants: ['teacher'], religious_eligibility_text: 'Teachers at public, private and parochial schools may apply.' }),
  grantRecord(userP.id, 'grant_0000000e0002', 'Example School Grant', { applicants: ['school', 'nonprofit'] }),
]);
await mock.reset();
await mock.fixtures({ grant_match_batch_v1: JSON.stringify([scoreItem('grant_0000000e0001', 40), scoreItem('grant_0000000e0002', 80)]) });
const runP = await call('POST', '/api/processing/match-grants', { token: tokenP });
const pSent = promptGrants(await matchPrompts());
const pTeacher = pSent.find((g: Json) => g.id === 'grant_0000000e0001');
check(
  'matching run: the prompt carries applicants and religious_eligibility_text from the stored grant',
  runP.status === 200 && same(pTeacher?.applicants, ['teacher']) && pTeacher?.religious_eligibility_text === 'Teachers at public, private and parochial schools may apply.' &&
    same(pSent.find((g: Json) => g.id === 'grant_0000000e0002')?.applicants, ['school', 'nonprofit']) && !('religious_eligibility_text' in (pSent.find((g: Json) => g.id === 'grant_0000000e0002') ?? {})),
  pSent,
);
check(
  '...and a match carries them for the results (applicants, religious_eligibility_text)',
  same(byIdIn(runP.data, 'grant_0000000e0001')?.applicants, ['teacher']) && byIdIn(runP.data, 'grant_0000000e0001')?.religious_eligibility_text === 'Teachers at public, private and parochial schools may apply.',
  byIdIn(runP.data, 'grant_0000000e0001'),
);

mock.stop();
finish();
