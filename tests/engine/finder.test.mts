/**
 * Grant finder: the eligibility and verification details a grant can carry
 * (religious eligibility, geography, deadline notes, funder priorities,
 * typical award, last verified), the starter-database refresh, the
 * religious-exclusion filter in matching and web discovery, the match
 * results overlay, the calendar (.ics) export, the new CSV/Markdown columns
 * and the new spreadsheet columns.
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/finder.test.mts
 *   (VERBOSE=1 shows the engine's log lines)
 *
 * The starter database (seed_grants.json) changes over time: counts and
 * names are read from the file at runtime, never hardcoded (only
 * "Kenedy Memorial Foundation Grants" is looked up by name, with a fallback).
 */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { api, call, check, finish, guest, repoRoot, saveKey, setupEnv, startMock } from './helpers.mts';

setupEnv('finder');
const mock = await startMock();

// exceljs lives in frontend/node_modules; the test sits outside that folder.
const requireFromFrontend = createRequire(path.join(repoRoot, 'frontend', 'package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ExcelJS: any = requireFromFrontend('exceljs');

const repo = await import('../../frontend/src/server/repo.ts');
const types = await import('../../frontend/src/server/types.ts');
const deadlines = await import('../../frontend/src/server/deadlines.ts');
const details = await import('../../frontend/src/server/grantDetails.ts');
const discovery = await import('../../frontend/src/server/services/discovery.ts');
const ai = await import('../../frontend/src/server/services/ai.ts');
const exportResults = await import('../../frontend/src/server/services/exportResults.ts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const today = deadlines.todayIso();
const plusDays = (days: number) => deadlines.addDaysIso(today, days);
/** Default deadline of the test grants: always about 4.5 months ahead of the suite's today (GRANTFINDER_TODAY in test mode). */
const OPEN_DEADLINE = plusDays(137);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

async function me(token: string): Promise<{ id: string }> {
  return (await api('GET', '/api/auth/me', { token })).data;
}

async function grantsOf(token: string): Promise<Json[]> {
  return (await api('GET', '/api/grants', { token })).data;
}

/** A complete stored grant record (what saveGrants expects). */
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

/** A saved match (as matching stores it); details only when given. */
function matchRecord(grantId: string, name: string, tier: string, score: number, deadline: string, extra: Record<string, unknown> = {}): Json {
  return {
    grant_id: grantId,
    grant_name: name,
    funder: `${name} Fund`,
    amount: 'Varies',
    deadline,
    url: '',
    contact: 'See website',
    category: 'catholic_school',
    geo_qualified: 'Yes',
    score,
    score_tier: tier,
    score_breakdown: { eligibility_fit: score, need_alignment: score, capacity_signals: score, timing: score, completeness: score },
    explanation: `Example explanation for ${name}.`,
    evidence: [],
    is_shortlisted: false,
    ...extra,
  };
}

async function saveResults(userId: string, sessionId: string, matches: Json[]): Promise<void> {
  const now = new Date();
  await repo.saveMatchResults({
    session_id: sessionId,
    user_id: userId,
    profile_id: 'profile_test',
    total_grants_evaluated: matches.length,
    matches,
    ...ai.tierCounts(matches),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
  });
}

function texasProfile(userId: string): Json {
  return types.normalizeProfile({
    user_id: userId,
    organization_name: '[School Name]',
    organization_type: 'both',
    city: '[City]',
    state: 'TX',
    has_school: true,
    student_count: 214,
  });
}

// ===========================================================================
// 1. Unit: grantDetails.ts
// ===========================================================================

const religious = details.parseReligiousEligibility;
const religiousMisses = (cases: Array<[unknown, string | null]>) =>
  cases.filter(([input, want]) => religious(input) !== want).map(([input, want]) => `${JSON.stringify(input)} -> ${religious(input)} (want ${want})`);

let misses = religiousMisses([
  ['eligible', 'eligible'],
  ['secular_purpose_only', 'secular_purpose_only'],
  ['excluded', 'excluded'],
  ['unclear', 'unclear'],
  ['  Excluded ', 'excluded'],
  ['Secular purpose only', 'secular_purpose_only'],
  ['SECULAR-PURPOSE-ONLY', 'secular_purpose_only'],
]);
check('parseReligiousEligibility: the four exact values (any case, spaces or dashes for underscores)', misses.length === 0, misses);

misses = religiousMisses([
  ['Yes', 'eligible'],
  ['yes - Catholic schools welcome', 'eligible'],
  ['Y', 'eligible'],
  ['TRUE', 'eligible'],
]);
check('parseReligiousEligibility: "Yes" and similar -> eligible', misses.length === 0, misses);

misses = religiousMisses([
  ['No', 'excluded'],
  ['Religious organizations not eligible', 'excluded'],
  ['Religious organizations are not eligible', 'excluded'],
  ['Ineligible', 'excluded'],
  ['Does not fund religious organizations', 'excluded'],
  ['Does not accept applications from churches', 'excluded'],
]);
check('parseReligiousEligibility: "No", "Religious organizations not eligible" and similar -> excluded', misses.length === 0, misses);

misses = religiousMisses([
  ['secular programs only', 'secular_purpose_only'],
  ['Eligible for non-religious uses only', 'secular_purpose_only'],
  ['Yes, but not for religious instruction', 'secular_purpose_only'],
  ['No religious activities may be funded', 'secular_purpose_only'],
]);
check('parseReligiousEligibility: "secular programs only" and similar -> secular_purpose_only (checked before "no"/"eligible")', misses.length === 0, misses);

misses = religiousMisses([
  ['Unclear', 'unclear'],
  ['Not stated: confirm with the funder', 'unclear'],
  ['Unknown', 'unclear'],
  ['check with the funder', 'unclear'],
]);
check('parseReligiousEligibility: "unclear", "Not stated", "check" -> unclear', misses.length === 0, misses);

misses = religiousMisses([
  ['', null],
  ['   ', null],
  [null, null],
  [undefined, null],
  [{}, null],
  [['eligible'], null],
  [true, null],
  ['banana', null],
  ['42', null],
]);
check('parseReligiousEligibility: empty, non-text and junk -> null', misses.length === 0, misses);

// "No restrictions" means anyone may apply: it must never rule a grant out ("No need to apply")
// or make web discovery drop it.
misses = ['No restrictions', 'No religious restrictions'].filter((input) => religious(input) === 'excluded').map((input) => `${JSON.stringify(input)} -> excluded`);
check('parseReligiousEligibility: "No restrictions" / "No religious restrictions" are NOT read as excluded', misses.length === 0, misses);
misses = religiousMisses([
  ['No restrictions', 'eligible'],
  ['Not excluded', 'eligible'],
  ['Catholic schools eligible', 'eligible'], // the app's own CSV label reads back the same
  ['Religious organizations eligible', 'eligible'],
  ['Yes, religious schools may apply', 'eligible'],
  ['Faith-based schools welcome', 'eligible'],
  ['No, religious organizations are excluded', 'excluded'],
  ['Does not fund religious organizations', 'excluded'], // the app's own label for excluded
  ['Eligible for non-religious uses only', 'secular_purpose_only'], // the app's own label
  ['Not stated: confirm with the funder', 'unclear'], // the app's own label
]);
check('parseReligiousEligibility: plain phrasings and the app\'s own labels read back correctly', misses.length === 0, misses);

const dl = details.detailList;
check('detailList: splits text on commas, semicolons and new lines, trimmed', same(dl('STEM, literacy; arts\nmusic '), ['STEM', 'literacy', 'arts', 'music']), dl('STEM, literacy; arts\nmusic '));
check(
  'detailList: commas inside parentheses stay in one item',
  same(dl('Central Texas (Travis, Hays), Austin; robotics (K-8, after school)'), ['Central Texas (Travis, Hays)', 'Austin', 'robotics (K-8, after school)']),
  dl('Central Texas (Travis, Hays), Austin; robotics (K-8, after school)'),
);
check('detailList: duplicates dropped (case-insensitive, first spelling kept), inner spaces collapsed', same(dl('STEM, stem ,  Teacher   training, STEM'), ['STEM', 'Teacher training']), dl('STEM, stem ,  Teacher   training, STEM'));
const tenItems = Array.from({ length: 10 }, (_, i) => `item ${i + 1}`);
check(
  'detailList: at most 8 items by default, maxItems honored',
  dl(tenItems.join(', ')).length === 8 && dl(tenItems).length === 8 && same(dl(tenItems, 3), ['item 1', 'item 2', 'item 3']),
  [dl(tenItems.join(', ')).length, dl(tenItems, 3)],
);
check('detailList: each item cut to 160 characters', dl(['x'.repeat(300)])[0]?.length === 160, dl(['x'.repeat(300)])[0]?.length);
check(
  'detailList: a list is taken item by item (not split again); blanks skipped; non-text values -> []',
  same(dl(['a, b', '', '  ', 'c']), ['a, b', 'c']) && same(dl(5), []) && same(dl(null), []) && same(dl({ a: 1 }), []),
  [dl(['a, b', '', '  ', 'c']), dl(5)],
);

const iso = details.isoDateOrNull;
check('isoDateOrNull: a valid date (and a leap day) is kept', iso('2026-09-30') === '2026-09-30' && iso('2024-02-29') === '2024-02-29' && iso(' 2026-01-05 ') === '2026-01-05', [iso('2026-09-30'), iso('2024-02-29')]);
check('isoDateOrNull: a timestamp keeps only its date', iso('2026-09-30T12:00:00Z') === '2026-09-30', iso('2026-09-30T12:00:00Z'));
check(
  'isoDateOrNull: Feb 30, month 13, Feb 29 in a non-leap year -> null',
  iso('2026-02-30') === null && iso('2026-13-01') === null && iso('2026-02-29') === null && iso('2026-04-31') === null,
  [iso('2026-02-30'), iso('2026-13-01'), iso('2026-02-29')],
);
check('isoDateOrNull: junk, other formats and non-text -> null', [iso('junk'), iso(''), iso(null), iso('9/30/2026'), iso('2026-9-3'), iso(20260930), iso({})].every((v) => v === null));

const src = details.sourceList;
check(
  'sourceList: only http(s) links kept (javascript:, ftp:, bare domains, links with spaces dropped)',
  same(src(['https://a.org/x', 'http://b.org', 'javascript:alert(1)', 'ftp://c.org/f', 'example.org/no-scheme', 'https://d.org/has space', 'See website']), ['https://a.org/x', 'http://b.org']),
  src(['https://a.org/x', 'http://b.org', 'javascript:alert(1)', 'ftp://c.org/f', 'example.org/no-scheme', 'https://d.org/has space']),
);
check('sourceList: text with several links is split; at most 6 kept', same(src('https://a.org; https://b.org'), ['https://a.org', 'https://b.org']) && src(Array.from({ length: 9 }, (_, i) => `https://e${i}.org`)).length === 6);

const pgd = details.parseGrantDetails;
check(
  'parseGrantDetails: "Not published" typical award dropped (any case), real ones kept',
  pgd({ typical_award: 'Not published' }).typical_award === null && pgd({ typical_award: ' not  PUBLISHED ' }).typical_award === null && pgd({ typical_award: '$5,000 median' }).typical_award === '$5,000 median',
  [pgd({ typical_award: 'Not published' }).typical_award, pgd({ typical_award: '$5,000 median' }).typical_award],
);
check(
  'parseGrantDetails: confidence only verified/partial (any case); anything else -> null',
  pgd({ confidence: 'Verified' }).confidence === 'verified' && pgd({ confidence: 'PARTIAL' }).confidence === 'partial' &&
    pgd({ confidence: 'high' }).confidence === null && pgd({ confidence: 5 }).confidence === null && pgd({}).confidence === null,
);
const full = pgd({
  deadline_notes: ['LOI by Jan 15', 'Full proposal by invitation'],
  geography: 'Texas',
  religious_eligibility: 'Yes',
  focus_areas: 'STEM, literacy',
  typical_award: '$8,000',
  last_verified: '2026-10-01',
  confidence: 'verified',
  sources: ['https://example.org/a', 'javascript:alert(1)'],
});
check(
  'parseGrantDetails: every field read leniently (list notes joined with "; ")',
  same(full, {
    deadline_notes: 'LOI by Jan 15; Full proposal by invitation',
    geography: 'Texas',
    religious_eligibility: 'eligible',
    focus_areas: ['STEM', 'literacy'],
    typical_award: '$8,000',
    last_verified: '2026-10-01',
    confidence: 'verified',
    sources: ['https://example.org/a'],
    funder_intel: null,
  }),
  full,
);
check(
  'parseGrantDetails: an empty record -> nulls and empty lists',
  same(pgd({}), { deadline_notes: null, geography: null, religious_eligibility: null, focus_areas: [], typical_award: null, last_verified: null, confidence: null, sources: [], funder_intel: null }),
  pgd({}),
);
check(
  'parseGrantDetails: long text capped (deadline notes 600, geography 300)',
  pgd({ deadline_notes: 'n'.repeat(900), geography: 'g'.repeat(900) }).deadline_notes?.length === 600 && pgd({ geography: 'g'.repeat(900) }).geography?.length === 300,
);
check(
  'grantDetails: defaults for a grant without details (older records)',
  same(details.grantDetails({}), {
    eligibility_notes: null, deadline_notes: null, geography: null, religious_eligibility: null, focus_areas: [], typical_award: null, last_verified: null, confidence: null,
    funder_intel: null,
  }) && same(details.grantDetails({ focus_areas: 'not a list' as unknown as string[] }).focus_areas, []),
  details.grantDetails({}),
);
check(
  'grantDetails: copies the detail fields (and not the sources list)',
  same(details.grantDetails({ ...full, eligibility_notes: '501(c)(3)' }), {
    eligibility_notes: '501(c)(3)', deadline_notes: full.deadline_notes, geography: 'Texas', religious_eligibility: 'eligible', focus_areas: ['STEM', 'literacy'],
    typical_award: '$8,000', last_verified: '2026-10-01', confidence: 'verified', funder_intel: null,
  }),
  details.grantDetails({ ...full, eligibility_notes: '501(c)(3)' }),
);

// Funder intelligence: the track record the grant research gathers (filings, grant lists, announcements).
const intel = details.parseFunderIntel({
  past_awards: [
    { year: 2024, amount: '$25,000', recipient: 'Catholic elementary school (San Antonio, TX)', purpose: 'tuition assistance' },
    { year: '2023', amount: '$10,000', recipient: 'Parish school (Corpus Christi, TX)', purpose: 'roof repair' },
    { year: 1850, amount: '$5,000', recipient: 'Old record', purpose: 'x' },
    { amount: 'Not found', recipient: 'Not found' },
    'junk',
  ],
  award_levels: 'Most 2024 school grants $10,000-$50,000 (2024 Form 990-PF)',
  funded_focus: ['tuition assistance', 'Not found', 'facilities'],
  catholic_school_track_record: '14 grants to Catholic K-12 schools in 2024',
  giving_trend: 'Not found',
  outlook: 'No announced changes found',
  as_of: '2026-10-15',
  sources: ['https://projects.propublica.org/nonprofits/x', 'ftp://bad'],
});
check(
  'parseFunderIntel: real awards kept (bad years blanked, "Not found" and junk entries dropped), "Not found"/"No announced changes" read as empty',
  intel !== null && intel.applicable === true && intel.past_awards.length === 3 && intel.past_awards[1].year === 2023 && intel.past_awards[2].year === null &&
    same(intel.funded_focus, ['tuition assistance', 'facilities']) && intel.giving_trend === null && intel.outlook === null &&
    intel.as_of === '2026-10-15' && same(intel.sources, ['https://projects.propublica.org/nonprofits/x']),
  intel,
);
check('parseFunderIntel: nothing usable -> null; not an object -> null', details.parseFunderIntel({ giving_trend: 'Not found', past_awards: [] }) === null && details.parseFunderIntel('x') === null && details.parseFunderIntel(null) === null);
const formula = details.parseFunderIntel({ applicable: false, note: 'Formula program: no discretionary awards.' });
check('parseFunderIntel: a formula program keeps applicable false and its note', formula?.applicable === false && formula?.note === 'Formula program: no discretionary awards.', formula);
check(
  'parseFunderIntel: at most 8 past awards',
  details.parseFunderIntel({ past_awards: Array.from({ length: 12 }, (_, i) => ({ year: 2020, amount: `$${i}`, recipient: 'School', purpose: 'p' })) })?.past_awards.length === 8,
);
const promptIntel = details.intelForPrompt(intel);
check(
  'intelForPrompt: the decision-relevant fields only, past awards as one line each',
  promptIntel !== null && promptIntel.award_levels === intel?.award_levels && same(promptIntel.funded_in_practice, ['tuition assistance', 'facilities']) &&
    (promptIntel.past_awards as string[])[0] === '2024 | $25,000 | Catholic elementary school (San Antonio, TX) | tuition assistance' && !('sources' in promptIntel),
  promptIntel,
);
check('intelForPrompt: nothing for a formula program or no intel', details.intelForPrompt(formula) === null && details.intelForPrompt(null) === null);
const withIntel = details.parseGrantDetails({ funder_intel: { award_levels: 'Up to $5,000 (2025 grants list)' } });
check('parseGrantDetails carries funder_intel; grantDetails copies it', withIntel.funder_intel?.award_levels === 'Up to $5,000 (2025 grants list)' && details.grantDetails({ funder_intel: withIntel.funder_intel }).funder_intel === withIntel.funder_intel);
const madeGrant = discovery.makeGrant('user_x', 'web_discovery', { grant_name: 'Example Made Grant', religious_eligibility: 'secular programs only', focus_areas: ['STEM'], typical_award: 'Not published' });
check(
  'makeGrant carries the parsed details',
  madeGrant?.religious_eligibility === 'secular_purpose_only' && same(madeGrant?.focus_areas, ['STEM']) && madeGrant?.typical_award === null && same(madeGrant?.sources, []),
  madeGrant,
);

// ===========================================================================
// 2. Unit: refreshSeedGrants
// ===========================================================================

const UNIT_USER = 'user_unit_refresh';
const OLD_STAMP = '2025-01-01T00:00:00.000Z';
const make = (source: string, data: Record<string, unknown>, id?: string): Json => {
  const grant = discovery.makeGrant(UNIT_USER, source, data)!;
  return id ? { ...grant, id, created_at: OLD_STAMP } : grant;
};
const C_DATA = { grant_name: 'Example Starter C', funder: 'Fund C', deadline: 'Annual: March 1', religious_eligibility: 'eligible', focus_areas: ['STEM'] };
const unitCurrent = [
  make('seed', { grant_name: 'Example Starter A', funder: 'Fund A', deadline: '2027-01-01', amount: 'Up to $5,000' }, 'grant_s1'),
  make('seed', { grant_name: 'Example Old Name B', funder: 'Fund B', deadline: 'Rolling' }, 'grant_s2'),
  make('seed', C_DATA, 'grant_s3'),
  make('seed', { grant_name: 'Example Dropped D', funder: 'Fund D' }, 'grant_s4'),
  make('seed', { grant_name: 'Example Dropped E', funder: 'Fund E', eligibility_notes: 'Parishes only.' }, 'grant_s5'),
  make('seed', { grant_name: 'Example Dropped K', funder: 'Fund K' }, 'grant_s6'),
  make('upload', { grant_name: 'Example New F', funder: 'Fund F', deadline: '2027-05-01' }, 'grant_u1'),
  make('grants_gov', { grant_name: 'Example Federal G', funder: 'Agency G' }, 'grant_g1'),
  make('web_discovery', { grant_name: 'Example Dropped D', funder: 'Other Fund' }, 'grant_w1'),
];
const unitIncoming = [
  make('seed', { grant_name: 'Example Starter A', funder: 'Fund A', deadline: '2027-02-01', amount: 'Up to $5,000', geography: 'Texas', religious_eligibility: 'eligible' }),
  make('seed', { grant_name: 'Example New Name B', funder: 'Fund B', deadline: 'Rolling' }),
  make('seed', C_DATA),
  make('seed', { grant_name: 'Example New F', funder: 'Fund F', deadline: '2027-06-01' }),
  make('seed', { grant_name: 'Example Brand New H', funder: 'Fund H' }),
];
const previousNames = new Map([['Example New Name B', ['Example Old Name B']]]);
const unitKeep = new Set(['grant_s5', 'grant_s6']);
const currentBefore = clone(unitCurrent);
const incomingBefore = clone(unitIncoming);
const refresh1 = discovery.refreshSeedGrants(unitCurrent, unitIncoming, previousNames, unitKeep, '2026-10-15');
const byIdIn = (list: Json[], id: string) => list.find((g) => g.id === id);
const merged1 = refresh1.merged as Json[];

check(
  'refreshSeedGrants: outcome counts (1 added, 2 updated, 2 duplicates, 3 retired, total 9)',
  refresh1.outcome.added === 1 && refresh1.outcome.updated === 2 && refresh1.outcome.duplicates === 2 && refresh1.outcome.retired === 3 &&
    refresh1.outcome.total === 9 && merged1.length === 9 && same(refresh1.outcome.retired_names, ['Example Dropped D', 'Example Dropped E', 'Example Dropped K']),
  refresh1.outcome,
);
const a1 = byIdIn(merged1, 'grant_s1');
check(
  'refreshSeedGrants: a changed starter record is updated in place (same id and created_at, new deadline and details)',
  a1?.deadline === '2027-02-01' && a1?.geography === 'Texas' && a1?.religious_eligibility === 'eligible' && a1?.created_at === OLD_STAMP && a1?.user_id === UNIT_USER &&
    merged1.filter((g) => g.grant_name === 'Example Starter A').length === 1,
  a1,
);
const b1 = byIdIn(merged1, 'grant_s2');
check(
  'refreshSeedGrants: renamed_from maps the old name to the new record (same id, new name, old name gone)',
  b1?.grant_name === 'Example New Name B' && b1?.created_at === OLD_STAMP && !merged1.some((g) => g.grant_name === 'Example Old Name B'),
  b1,
);
const c1 = byIdIn(merged1, 'grant_s3');
check('refreshSeedGrants: an unchanged record is kept and counted as a duplicate, not updated', Boolean(c1) && c1.created_at === OLD_STAMP && same({ ...c1, id: 0, created_at: 0 }, { ...unitCurrent[2], id: 0, created_at: 0 }), c1);
const f1 = merged1.filter((g) => g.grant_name === 'Example New F');
check(
  "refreshSeedGrants: the person's own grant with the same name+funder is kept (theirs wins, no starter copy)",
  f1.length === 1 && f1[0].id === 'grant_u1' && f1[0].source === 'upload' && f1[0].deadline === '2027-05-01',
  f1,
);
check('refreshSeedGrants: a starter record no longer listed (and not used) is removed', !byIdIn(merged1, 'grant_s4'), merged1.map((g) => g.id));
const e1 = byIdIn(merged1, 'grant_s5');
const k1 = byIdIn(merged1, 'grant_s6');
const RETIRE_NOTE = "No longer in GrantFinder's starter database as of 2026-10-15: the program ended or Catholic schools aren't eligible. Check the funder's site before applying.";
check(
  'refreshSeedGrants: a dropped record an application uses is kept, CLOSED, with the note before its old notes',
  e1?.status === 'CLOSED' && e1?.eligibility_notes === `${RETIRE_NOTE} Parishes only.` && e1?.source === 'seed' && e1?.created_at === OLD_STAMP,
  e1,
);
check('refreshSeedGrants: ...and with only the note when it had no notes', k1?.status === 'CLOSED' && k1?.eligibility_notes === RETIRE_NOTE, k1);
check(
  'refreshSeedGrants: Grants.gov and web discovery grants are never touched (even one named like a dropped starter grant)',
  same(byIdIn(merged1, 'grant_g1'), unitCurrent[7]) && same(byIdIn(merged1, 'grant_w1'), unitCurrent[8]),
  [byIdIn(merged1, 'grant_g1'), byIdIn(merged1, 'grant_w1')],
);
const h1 = merged1.find((g) => g.grant_name === 'Example Brand New H');
check('refreshSeedGrants: a new starter grant is added with its own id', Boolean(h1) && h1.source === 'seed' && !unitCurrent.some((g) => g.id === h1.id), h1);
check('refreshSeedGrants: inputs are not mutated', same(unitCurrent, currentBefore) && same(unitIncoming, incomingBefore));

const refresh2 = discovery.refreshSeedGrants(merged1, unitIncoming, previousNames, unitKeep, '2026-11-01');
const e2 = byIdIn(refresh2.merged as Json[], 'grant_s5');
check(
  'refreshSeedGrants: a second retire does not add the note again (original date kept)',
  e2?.eligibility_notes === `${RETIRE_NOTE} Parishes only.` && (e2?.eligibility_notes.match(/No longer in GrantFinder/g) ?? []).length === 1 && e2?.status === 'CLOSED',
  e2?.eligibility_notes,
);
check('refreshSeedGrants: a second refresh adds and updates nothing', refresh2.outcome.added === 0 && refresh2.outcome.updated === 0 && refresh2.outcome.duplicates === 5, refresh2.outcome);
// BUG CHECK: an already-closed record is counted (and named in the notes) as "retired" again on every load.
check('refreshSeedGrants: a record already closed by an earlier refresh is not counted as retired again', refresh2.outcome.retired === 0, refresh2.outcome);

// ===========================================================================
// 3. Route: POST /api/discovery/seed (refresh, retire, keep)
// ===========================================================================

const seedFile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'frontend', 'src', 'server', 'data', 'seed_grants.json'), 'utf8'));
const entryName = (entry: Json) => String(entry?.grant_name ?? entry?.name ?? entry?.title ?? '').trim();
const seedEntries: Json[] = (Array.isArray(seedFile.grants) ? seedFile.grants : []).filter((entry: Json) => entry && typeof entry === 'object' && entryName(entry));

const tokenS = await guest();
const userS = await me(tokenS);
const seed1 = await api('POST', '/api/discovery/seed', { token: tokenS });
check(
  'seed load: found = the file\'s grants; added + duplicates = found; updated 0, retired 0; total = added',
  seed1.status === 200 && seed1.data.found === seedEntries.length && seed1.data.added + seed1.data.duplicates === seed1.data.found &&
    seed1.data.updated === 0 && seed1.data.retired === 0 && seed1.data.total_grants === seed1.data.added && seed1.data.added > 0,
  { data: seed1.data, file: seedEntries.length },
);
let grantsS = await grantsOf(tokenS);
check('stored grants = total_grants, all from the seed', grantsS.length === seed1.data.total_grants && grantsS.every((g) => g.source === 'seed'), grantsS.length);
check(
  'every seeded grant: religious_eligibility is not "excluded" and the url is a real link',
  grantsS.every((g) => g.religious_eligibility !== 'excluded' && /^https?:\/\/\S+$/.test(g.url)),
  grantsS.filter((g) => g.religious_eligibility === 'excluded' || !/^https?:\/\//.test(g.url)).map((g) => g.grant_name),
);
const detailMisses = grantsS.filter((g) => {
  const entry = seedEntries.find((e) => entryName(e) === g.grant_name);
  if (!entry) return true;
  const want = details.parseGrantDetails(entry);
  return (Object.keys(want) as Array<keyof typeof want>).some((key) => !same(g[key], want[key]));
});
check('every seeded grant carries the file\'s details as parseGrantDetails reads them', detailMisses.length === 0, detailMisses.map((g) => g.grant_name));

const seed2 = await api('POST', '/api/discovery/seed', { token: tokenS });
check(
  'second seed load: updated 0, retired 0, added 0, all duplicates, total unchanged',
  seed2.status === 200 && seed2.data.updated === 0 && seed2.data.retired === 0 && seed2.data.added === 0 &&
    seed2.data.duplicates === seed1.data.found && seed2.data.total_grants === seed1.data.total_grants,
  seed2.data,
);
check('second seed load: no "Updated"/"Retired" notes', !seed2.data.notes.some((n: string) => /^(Updated|Retired) /.test(n)), seed2.data.notes);

const target = grantsS.find((g) => g.grant_name === 'Kenedy Memorial Foundation Grants') ?? grantsS[0];
await repo.updateGrants(userS.id, (list) => list.map((g) => (g.id === target.id ? { ...g, deadline: 'Example stale deadline', amount: 'Example stale amount' } : g)));
const seed3 = await api('POST', '/api/discovery/seed', { token: tokenS });
grantsS = await grantsOf(tokenS);
const targetAfter = grantsS.find((g) => g.id === target.id);
check(
  'a starter grant changed in the store -> reload says updated 1 (with a note), nothing added or retired',
  seed3.status === 200 && seed3.data.updated === 1 && seed3.data.added === 0 && seed3.data.retired === 0 &&
    seed3.data.notes[0] === 'Updated 1 starter grant with the latest deadlines and details.',
  seed3.data,
);
check(
  '...and the deadline and amount are restored on the SAME grant id (created_at kept)',
  targetAfter?.deadline === target.deadline && targetAfter?.amount === target.amount && targetAfter?.created_at === target.created_at &&
    grantsS.filter((g) => g.grant_name === target.grant_name).length === 1 && grantsS.length === seed1.data.total_grants,
  { before: target.deadline, after: targetAfter?.deadline },
);

const FAKE_NAME = 'Example Discontinued Starter Grant';
const fakeSeed = grantRecord(userS.id, 'grant_00000000fa01', FAKE_NAME, { source: 'seed', funder: 'Example Ended Fund' });
await repo.updateGrants(userS.id, (list) => [...list, fakeSeed]);
const seed4 = await api('POST', '/api/discovery/seed', { token: tokenS });
grantsS = await grantsOf(tokenS);
check(
  'a starter grant the file no longer lists -> reload retires it, and the notes name it',
  seed4.status === 200 && seed4.data.retired === 1 && seed4.data.updated === 0 &&
    seed4.data.notes.includes(`Retired 1 grant no longer offered or not open to Catholic schools: ${FAKE_NAME}.`),
  seed4.data,
);
check('...it is removed from the database (no application uses it)', !grantsS.some((g) => g.id === fakeSeed.id) && seed4.data.total_grants === seed1.data.total_grants && grantsS.length === seed1.data.total_grants, grantsS.length);

await repo.saveProfile(userS.id, texasProfile(userS.id));
const KEPT_NAME = 'Example Retired Starter With Application';
const keptSeed = grantRecord(userS.id, 'grant_00000000ab02', KEPT_NAME, { source: 'seed', funder: 'Example Closing Fund', eligibility_notes: 'Parish schools only.' });
await repo.updateGrants(userS.id, (list) => [...list, keptSeed]);
const appS = await api('POST', '/api/writer/applications', { token: tokenS, json: { grant_id: keptSeed.id } });
check('an application is opened for that starter grant', appS.status === 200 && appS.data?.grant_id === keptSeed.id, appS.data);
const seed5 = await api('POST', '/api/discovery/seed', { token: tokenS });
grantsS = await grantsOf(tokenS);
const keptAfter = grantsS.find((g) => g.id === keptSeed.id);
check(
  'with an application using it -> retired 1 (named in the notes), but kept',
  seed5.status === 200 && seed5.data.retired === 1 && seed5.data.notes.some((n: string) => n.includes(KEPT_NAME)) && Boolean(keptAfter) &&
    seed5.data.total_grants === seed1.data.total_grants + 1,
  seed5.data,
);
check(
  '...kept as CLOSED with the "No longer in GrantFinder\'s starter database" note before its notes',
  keptAfter?.status === 'CLOSED' &&
    keptAfter?.eligibility_notes ===
      `No longer in GrantFinder's starter database as of ${today}: the program ended or Catholic schools aren't eligible. Check the funder's site before applying. Parish schools only.`,
  keptAfter,
);
const appState = await api('GET', `/api/writer/applications/${appS.data?.id}`, { token: tokenS });
check('...and the application still opens', appState.status === 200, appState.status);
const seed6 = await api('POST', '/api/discovery/seed', { token: tokenS });
grantsS = await grantsOf(tokenS);
const keptAgain = grantsS.find((g) => g.id === keptSeed.id);
check(
  'another reload keeps it CLOSED with the note once (not duplicated)',
  keptAgain?.status === 'CLOSED' && (keptAgain?.eligibility_notes.match(/No longer in GrantFinder/g) ?? []).length === 1,
  keptAgain?.eligibility_notes,
);
// BUG CHECK (same root cause as the unit check above): the note "Retired 1 grant..." comes back on every load.
check(
  'another reload does not report the already-closed grant as retired again',
  seed6.data?.retired === 0 && !seed6.data?.notes.some((n: string) => n.startsWith('Retired ')),
  seed6.data,
);

// ===========================================================================
// 4. Matching: religious exclusion and the batch prompt
// ===========================================================================

const tokenM = await guest();
await saveKey(tokenM);
const userM = await me(tokenM);
await repo.saveProfile(userM.id, texasProfile(userM.id));
const EXCL_ID = 'grant_0000000e0c01';
const FULL_ID = 'grant_00000000f011';
const BARE_ID = 'grant_00000000ba1e';
const UNCLEAR_ID = 'grant_00000000c1ea';
const EXCL_NAME = 'Example Secular Foundation Excluded Grant';
await repo.saveGrants(userM.id, [
  grantRecord(userM.id, EXCL_ID, EXCL_NAME, { religious_eligibility: 'excluded' }),
  grantRecord(userM.id, FULL_ID, 'Example Detailed STEM Grant', {
    geography: 'Central Texas (Travis, Hays)',
    religious_eligibility: 'secular_purpose_only',
    deadline_notes: 'Letter of inquiry due 30 days before',
    focus_areas: ['STEM labs', 'Teacher training'],
    typical_award: '$7,500',
    last_verified: '2026-09-30',
    confidence: 'verified',
    sources: ['https://example.org/stem'],
    funder_intel: {
      applicable: true,
      past_awards: [{ year: 2025, amount: '$6,000', recipient: 'Catholic K-8 school (Austin, TX)', purpose: 'STEM lab equipment' }],
      award_levels: 'Most 2025 awards $5,000-$10,000 (2025 grants list)',
      funded_focus: ['STEM labs'],
      catholic_school_track_record: '3 Catholic schools funded in 2025',
      giving_trend: 'Rising: $1.1M (2023), $1.4M (2025)',
      outlook: 'Announced 2026: awards up to $15,000 from 2027',
      as_of: '2026-10-15',
      sources: ['https://example.org/stem/grants-list'],
    },
  }),
  grantRecord(userM.id, BARE_ID, 'Example Older Record Grant'),
  grantRecord(userM.id, UNCLEAR_ID, 'Example Unclear Grant', { religious_eligibility: 'unclear', focus_areas: [], geography: null, deadline_notes: '', typical_award: null }),
]);

const profileM = await repo.getProfile(userM.id);
const prefiltered = ai.deterministicPrefilter(grantRecord(userM.id, EXCL_ID, EXCL_NAME, { religious_eligibility: 'excluded' }), profileM!);
check(
  'deterministicPrefilter: religious_eligibility "excluded" -> not_eligible with RELIGIOUS_EXCLUDED_REASON',
  prefiltered?.score === 0 && prefiltered?.score_tier === 'not_eligible' && prefiltered?.explanation === ai.RELIGIOUS_EXCLUDED_REASON,
  prefiltered,
);
check(
  'deterministicPrefilter: secular_purpose_only, unclear and eligible grants go on to Claude',
  ['secular_purpose_only', 'unclear', 'eligible', null].every((value) => ai.deterministicPrefilter(grantRecord(userM.id, FULL_ID, 'X', { religious_eligibility: value }), profileM!) === null),
);
check(
  'RELIGIOUS_EXCLUDED_REASON wording',
  ai.RELIGIOUS_EXCLUDED_REASON === 'Not eligible: this funder does not fund religious organizations or religious schools (per the grant database). No need to apply.',
  ai.RELIGIOUS_EXCLUDED_REASON,
);

await mock.reset();
const scoreItem = (id: string, score: number) => ({
  grant_id: id,
  score,
  score_breakdown: { eligibility_fit: score, need_alignment: score, capacity_signals: score, timing: score, completeness: score },
  explanation: `Mock score for ${id}`,
  evidence: ['Mock evidence'],
});
await mock.fixtures({ grant_match_batch_v1: JSON.stringify([scoreItem(FULL_ID, 88), scoreItem(BARE_ID, 72), scoreItem(UNCLEAR_ID, 55)]) });
const matchRun = await call('POST', '/api/processing/match-grants', { token: tokenM });
const matchOf = (results: Json, id: string) => results?.matches?.find((m: Json) => m.grant_id === id);
const exclMatch = matchOf(matchRun.data, EXCL_ID);
check('matching runs (200) with 4 matches', matchRun.status === 200 && matchRun.data.matches.length === 4, matchRun.data);
check(
  'excluded grant -> not_eligible, score 0, the exact RELIGIOUS_EXCLUDED_REASON',
  exclMatch?.score === 0 && exclMatch?.score_tier === 'not_eligible' && exclMatch?.explanation === ai.RELIGIOUS_EXCLUDED_REASON && exclMatch?.religious_eligibility === 'excluded',
  exclMatch,
);
const matchPrompts = (await mock.requests()).filter((r) => r.prompt_id === 'grant_match_batch_v1').map((r) => r.prompt);
check(
  'the excluded grant is never sent to Claude',
  matchPrompts.length >= 1 && matchPrompts.every((p) => !p.includes(EXCL_ID) && !p.includes(EXCL_NAME)),
  matchPrompts.length,
);
const promptGrants = (() => {
  const all: Json[] = [];
  for (const prompt of matchPrompts) {
    const start = prompt.indexOf('GRANTS TO EVALUATE:\n');
    const end = prompt.indexOf('\n\nFor EACH grant');
    try {
      all.push(...JSON.parse(prompt.slice(start + 'GRANTS TO EVALUATE:\n'.length, end)));
    } catch {
      // checked below
    }
  }
  return all;
})();
const pFull = promptGrants.find((g) => g.id === FULL_ID);
const pBare = promptGrants.find((g) => g.id === BARE_ID);
const pUnclear = promptGrants.find((g) => g.id === UNCLEAR_ID);
const DETAIL_KEYS = ['geography', 'religious_eligibility', 'deadline_notes', 'funder_priorities', 'typical_award', 'funder_track_record'];
check(
  'batch prompt: a grant with details carries geography, religious_eligibility, deadline_notes, funder_priorities, typical_award',
  pFull?.geography === 'Central Texas (Travis, Hays)' && pFull?.religious_eligibility === 'secular_purpose_only' && pFull?.deadline_notes === 'Letter of inquiry due 30 days before' &&
    same(pFull?.funder_priorities, ['STEM labs', 'Teacher training']) && pFull?.typical_award === '$7,500',
  pFull,
);
check('batch prompt: a grant without details has none of those keys', Boolean(pBare) && DETAIL_KEYS.every((key) => !(key in pBare)), pBare);
check(
  'batch prompt: empty or null details are left out (only religious_eligibility "unclear" kept)',
  Boolean(pUnclear) && pUnclear.religious_eligibility === 'unclear' && ['geography', 'deadline_notes', 'funder_priorities', 'typical_award'].every((key) => !(key in pUnclear)),
  pUnclear,
);
check(
  'batch prompt: the funder track record (levels, Catholic-school record, trend, outlook, past awards) reaches Claude',
  pFull?.funder_track_record?.award_levels === 'Most 2025 awards $5,000-$10,000 (2025 grants list)' &&
    pFull?.funder_track_record?.catholic_school_track_record === '3 Catholic schools funded in 2025' &&
    pFull?.funder_track_record?.outlook === 'Announced 2026: awards up to $15,000 from 2027' &&
    same(pFull?.funder_track_record?.past_awards, ['2025 | $6,000 | Catholic K-8 school (Austin, TX) | STEM lab equipment']) &&
    !('sources' in (pFull?.funder_track_record ?? {})),
  pFull?.funder_track_record,
);
check('batch prompt says how to weigh the track record', matchPrompts.some((p) => p.includes('- funder_track_record:') && p.includes('Real giving outweighs stated priorities')));
check(
  'batch prompt explains how to read the new fields',
  matchPrompts.some((p) => p.includes('Reading the grant fields:') && p.includes('- religious_eligibility: "eligible"') && p.includes('funder_priorities')),
);
const fullMatch = matchOf(matchRun.data, FULL_ID);
const bareMatch = matchOf(matchRun.data, BARE_ID);
check(
  'a scored match carries the funder track record (for the results card and exports)',
  fullMatch?.funder_intel?.award_levels === 'Most 2025 awards $5,000-$10,000 (2025 grants list)' && fullMatch?.funder_intel?.past_awards.length === 1 &&
    (bareMatch?.funder_intel ?? null) === null,
  fullMatch?.funder_intel,
);
check(
  'a scored match copies the grant\'s details',
  fullMatch?.score === 88 && fullMatch?.geography === 'Central Texas (Travis, Hays)' && fullMatch?.religious_eligibility === 'secular_purpose_only' &&
    same(fullMatch?.focus_areas, ['STEM labs', 'Teacher training']) && fullMatch?.typical_award === '$7,500' && fullMatch?.last_verified === '2026-09-30' &&
    fullMatch?.confidence === 'verified' && fullMatch?.deadline_notes === 'Letter of inquiry due 30 days before',
  fullMatch,
);
check(
  'a match for an older grant has null details and an empty focus list',
  bareMatch?.score === 72 && bareMatch?.geography === null && bareMatch?.religious_eligibility === null && same(bareMatch?.focus_areas, []) && bareMatch?.typical_award === null,
  bareMatch,
);

// ===========================================================================
// 5. Reading match results: the grant's current details
// ===========================================================================

const sessionM = matchRun.data.session_id;
const NEW_DEADLINE = plusDays(20);
const PAST_DEADLINE = plusDays(-2);
await repo.updateGrants(userM.id, (list) =>
  list
    .map((g) => {
      if (g.id === FULL_ID) {
        return { ...g, deadline: NEW_DEADLINE, amount: 'Up to $99,000', geography: 'Statewide (Texas)', url: 'https://example.org/new-link', religious_eligibility: 'eligible' as const, focus_areas: ['Literacy'] };
      }
      if (g.id === UNCLEAR_ID) return { ...g, deadline: PAST_DEADLINE };
      return g;
    })
    .filter((g) => g.id !== BARE_ID),
);
const latest = await api('GET', '/api/processing/match-results/latest', { token: tokenM });
const lFull = matchOf(latest.data, FULL_ID);
const lBare = matchOf(latest.data, BARE_ID);
const lUnclear = matchOf(latest.data, UNCLEAR_ID);
check(
  'latest results show the grant\'s CURRENT deadline, amount, url and geography',
  latest.status === 200 && lFull?.deadline === NEW_DEADLINE && lFull?.amount === 'Up to $99,000' && lFull?.url === 'https://example.org/new-link' && lFull?.geography === 'Statewide (Texas)',
  lFull,
);
check('...and its current religious eligibility and priorities', lFull?.religious_eligibility === 'eligible' && same(lFull?.focus_areas, ['Literacy']), lFull);
check('...with next_deadline and days_left recomputed from the new deadline', lFull?.next_deadline === NEW_DEADLINE && lFull?.days_left === 20 && lFull?.deadline_passed === false, lFull);
check('a deadline moved into the past -> negative days_left, deadline_passed true', lUnclear?.next_deadline === PAST_DEADLINE && lUnclear?.days_left === -2 && lUnclear?.deadline_passed === true, lUnclear);
check(
  'a match whose grant was deleted keeps its saved values',
  lBare?.deadline === OPEN_DEADLINE && lBare?.amount === 'Up to $10,000' && lBare?.url === `https://example.org/${BARE_ID}` && lBare?.score === 72 &&
    lBare?.next_deadline === OPEN_DEADLINE && lBare?.days_left === 137 && lBare?.deadline_passed === false,
  lBare,
);
const storedM = await repo.getMatchResults(userM.id, sessionM);
check('the overlay is computed on read: the saved results are unchanged', matchOf(storedM, FULL_ID)?.deadline === OPEN_DEADLINE && matchOf(storedM, FULL_ID)?.amount === 'Up to $10,000', matchOf(storedM, FULL_ID));
const bySession = await api('GET', `/api/processing/match-results/${sessionM}`, { token: tokenM });
check('GET /api/processing/match-results/:sessionId shows the same current details', bySession.status === 200 && matchOf(bySession.data, FULL_ID)?.deadline === NEW_DEADLINE && matchOf(bySession.data, FULL_ID)?.days_left === 20, matchOf(bySession.data, FULL_ID));

// ===========================================================================
// 6. Web discovery: details saved, religious exclusions skipped
// ===========================================================================

const tokenW = await guest();
await saveKey(tokenW);
await mock.reset();
await mock.fixtures({
  web_discovery_v1:
    'I verified these on the funders\' sites [1][2].\n\n' +
    JSON.stringify([
      {
        grant_name: 'Example Verified STEM Grant', funder: 'Example STEM Fund', category: 'catholic_school', deadline: '2027-02-15',
        deadline_notes: 'Letter of inquiry by January 15; full proposal by invitation', amount: 'Up to $20,000', typical_award: '$8,000 median',
        focus_areas: ['STEM labs', 'teacher training', 'STEM labs'], eligibility_notes: '501(c)(3) schools', religious_eligibility: 'eligible',
        geography: 'Texas', last_verified: '2026-10-01', confidence: 'verified', sources: ['https://example.org/stem', 'javascript:alert(1)'],
        url: 'https://example.org/stem', geo_qualified: 'Yes', funds_for: ['technology'],
      },
      {
        grant_name: 'Example Secular Tutoring Grant', funder: 'Example Tutoring Fund', category: 'non_catholic', religious_eligibility: 'secular_purpose_only',
        typical_award: 'Not published', focus_areas: 'tutoring, after-school (grades 3-5, 6-8)', geography: 'National', url: 'https://example.org/tutoring',
      },
      { grant_name: 'Example Excluded Grant', funder: 'Example Secular Fund', religious_eligibility: 'excluded', url: 'https://example.org/excluded' },
      { grant_name: 'Example Plain Words Excluded Grant', funder: 'Example Other Fund', religious_eligibility: 'Religious organizations are not eligible', url: 'https://example.org/excluded2' },
    ]),
});
const web1 = await call('POST', '/api/discovery/web-search', { token: tokenW, json: {} });
check(
  'web discovery: 4 entries, 2 excluded -> found 2, added 2',
  web1.status === 200 && web1.data.found === 2 && web1.data.added === 2 && web1.data.total_grants === 2,
  web1.data,
);
check(
  'web discovery notes say the 2 were skipped, then "AI verified 2"',
  web1.data?.notes?.includes("Skipped 2 grants that don't fund religious organizations") && web1.data?.notes?.includes('AI verified 2 opportunities'),
  web1.data?.notes,
);
const grantsW = await grantsOf(tokenW);
check(
  'excluded entries ("excluded" and "Religious organizations are not eligible") are not saved',
  grantsW.length === 2 && !grantsW.some((g) => /Excluded Grant$/.test(g.grant_name)),
  grantsW.map((g) => g.grant_name),
);
const webStem = grantsW.find((g) => g.grant_name === 'Example Verified STEM Grant');
check(
  'a web grant is saved with its new fields (deadline notes, typical award, priorities deduplicated, eligibility, geography, verified date, confidence)',
  webStem?.deadline_notes === 'Letter of inquiry by January 15; full proposal by invitation' && webStem?.typical_award === '$8,000 median' &&
    same(webStem?.focus_areas, ['STEM labs', 'teacher training']) && webStem?.religious_eligibility === 'eligible' && webStem?.geography === 'Texas' &&
    webStem?.last_verified === '2026-10-01' && webStem?.confidence === 'verified' && webStem?.source === 'web_discovery',
  webStem,
);
check('web grant sources keep only http(s) links', same(webStem?.sources, ['https://example.org/stem']), webStem?.sources);
const webTutor = grantsW.find((g) => g.grant_name === 'Example Secular Tutoring Grant');
check(
  'a secular-purpose web grant is kept; "Not published" award dropped; text priorities split (parentheses kept)',
  webTutor?.religious_eligibility === 'secular_purpose_only' && webTutor?.typical_award === null && same(webTutor?.focus_areas, ['tutoring', 'after-school (grades 3-5, 6-8)']) &&
    webTutor?.geography === 'National' && webTutor?.last_verified === null && webTutor?.confidence === null,
  webTutor,
);
const webPrompt = (await mock.requests()).find((r) => r.prompt_id === 'web_discovery_v1')?.prompt ?? '';
check(
  'web discovery prompt asks for religious_eligibility and the other new fields',
  webPrompt.includes('"religious_eligibility": "eligible | secular_purpose_only | excluded | unclear"') && webPrompt.includes('"deadline_notes"') &&
    webPrompt.includes('"typical_award"') && webPrompt.includes('"focus_areas"') && webPrompt.includes('"geography"'),
  webPrompt.slice(-1200),
);
check(
  'web discovery prompt carries the skip rule',
  webPrompt.includes('Skip programs that exclude religious organizations, religious schools or private schools') && webPrompt.includes('"secular_purpose_only"'),
  webPrompt.slice(0, 1600),
);
await mock.fixtures({ web_discovery_v1: JSON.stringify([{ grant_name: 'Example Lone Excluded Grant', funder: 'Example Lone Fund', religious_eligibility: 'No' }]) });
const web2 = await call('POST', '/api/discovery/web-search', { token: tokenW, json: {} });
check(
  'one excluded entry -> singular note, nothing saved',
  web2.status === 200 && web2.data.found === 0 && web2.data.added === 0 && web2.data.notes.includes("Skipped 1 grant that doesn't fund religious organizations") &&
    web2.data.notes.includes('AI verified 0 opportunities') && (await grantsOf(tokenW)).length === 2,
  web2.data,
);
await mock.reset();

// Grants.gov listings are national and say nothing about religious eligibility.
const govServer = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ errorcode: 0, data: { oppHits: [{ id: '370001', number: 'ED-27-EX', title: 'Example Federal Education Program', agency: 'Example Department of Education', closeDate: '03/01/2027', oppStatus: 'posted' }] } }));
  });
});
await new Promise<void>((resolve) => govServer.listen(0, '127.0.0.1', () => resolve()));
process.env.GRANTS_GOV_API_URL = `http://127.0.0.1:${(govServer.address() as AddressInfo).port}/v1/api/search2`;
const gov = await call('POST', '/api/discovery/grants-gov', { token: tokenW, json: { keywords: ['education'] } });
const govGrant = (await grantsOf(tokenW)).find((g) => g.source === 'grants_gov');
check(
  "Grants.gov grants carry geography 'National (federal)' and religious_eligibility 'unclear'",
  gov.status === 200 && govGrant?.geography === 'National (federal)' && govGrant?.religious_eligibility === 'unclear' && same(govGrant?.focus_areas, []) && same(govGrant?.sources, []),
  govGrant,
);
govServer.close();

// ===========================================================================
// 7. Calendar export (.ics)
// ===========================================================================

const tokenX = await guest();
const userX = await me(tokenX);
const LIVE_ID = 'grant_00000011fe01';
const LIVE_DUE = plusDays(45);
await repo.saveGrants(userX.id, [grantRecord(userX.id, LIVE_ID, 'Example Live Deadline Grant', { deadline: LIVE_DUE })]);

const year = Number(today.slice(0, 4));
const nextAnnual = (mmdd: string) => (`${year}-${mmdd}` >= today ? `${year}-${mmdd}` : `${year + 1}-${mmdd}`);
const slashDate = (isoDate: string) => `${isoDate.slice(5, 7)}/${isoDate.slice(8, 10)}/${isoDate.slice(0, 4)}`;
const LONG_NAME = 'Fundación Católica San José — Programa de Becas para Escuelas Parroquiales y Tecnología Educativa 🎓';
const calMatches = [
  matchRecord('grant_0000000ca101', 'Example Grant, Phase 1; Pilot', 'excellent', 91, plusDays(30), {
    funder: 'Example Fund', amount: 'Up to $10,000', typical_award: '$5,000', deadline_notes: 'LOI due first\nthen full proposal',
    focus_areas: ['STEM', 'literacy'], eligibility_notes: 'Schools only', url: 'https://example.org/exc',
  }),
  matchRecord('grant_0000000ca102', 'Example Annual Grant', 'good', 75, 'Annual: January 5'),
  matchRecord('grant_0000000ca103', 'Example Slash Date Grant', 'possible', 60, slashDate(plusDays(100))),
  matchRecord('grant_0000000ca104', 'Example Weak Shortlisted Grant', 'weak', 30, plusDays(10), { is_shortlisted: true }),
  matchRecord('grant_0000000ca105', 'Example Weak Grant', 'weak', 40, plusDays(12)),
  matchRecord('grant_0000000ca106', 'Example Not Eligible Shortlisted Grant', 'not_eligible', 0, plusDays(14), { is_shortlisted: true }),
  matchRecord('grant_0000000ca107', 'Example Passed Grant', 'excellent', 95, plusDays(-3)),
  matchRecord('grant_0000000ca108', 'Example Rolling Grant', 'good', 80, 'Rolling'),
  matchRecord('grant_0000000ca109', 'Example Check Website Grant', 'good', 78, 'Check website'),
  matchRecord('grant_0000000ca10a', 'Example Due Today Grant', 'possible', 52, today),
  matchRecord('grant_0000000ca10b', LONG_NAME, 'excellent', 86, 'Annual: December 31', { funder: 'Fundación Ejemplo' }),
  matchRecord(LIVE_ID, 'Example Live Deadline Grant', 'good', 71, 'Rolling'),
];
await saveResults(userX.id, 'session_finder_ics', calMatches);
const expectedDue: Record<string, string> = {
  grant_0000000ca101: plusDays(30),
  grant_0000000ca102: nextAnnual('01-05'),
  grant_0000000ca103: plusDays(100),
  grant_0000000ca104: plusDays(10),
  grant_0000000ca10a: today,
  grant_0000000ca10b: `${year}-12-31`,
  [LIVE_ID]: LIVE_DUE,
};
const compact = (isoDate: string) => isoDate.replace(/-/g, '');

const ics = await api('POST', '/api/export', { token: tokenX, json: { session_id: 'session_finder_ics', format: 'ics', include_all_matches: true } });
const icsText = ics.text;
check('ics export: 200, text/calendar', ics.status === 200 && ics.headers.get('content-type') === 'text/calendar; charset=utf-8', [ics.status, ics.headers.get('content-type'), ics.text.slice(0, 200)]);
check('ics file name grantfinder_deadlines_YYYYMMDD_HHMMSS.ics', /^attachment; filename="grantfinder_deadlines_\d{8}_\d{6}\.ics"$/.test(ics.headers.get('content-disposition') || ''), ics.headers.get('content-disposition'));
check('ics starts with BEGIN:VCALENDAR, VERSION:2.0 and a PRODID', icsText.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:'), icsText.slice(0, 80));
check('ics ends with END:VCALENDAR + CRLF', icsText.endsWith('\r\nEND:VCALENDAR\r\n'), JSON.stringify(icsText.slice(-30)));
check('every ics line ends with CRLF (no bare CR or LF)', !/\r(?!\n)|(?<!\r)\n/.test(icsText));
const physical = icsText.split('\r\n').slice(0, -1);
const longLines = physical.filter((line) => Buffer.byteLength(line, 'utf8') > 75);
check('no ics line is longer than 75 octets (UTF-8 bytes)', longLines.length === 0 && physical.length > 20, longLines);
// RFC 5545: a continuation line starts with one space (its text may itself start with a space).
check('long lines are folded onto continuation lines that start with a space', physical.some((line) => line.startsWith(' ')), physical.filter((l) => l.startsWith(' ')).slice(0, 3));

const unfold = (text: string) => text.replace(/\r\n[ \t]/g, '').split('\r\n').filter((line) => line !== '');
const icsEvents = (text: string): string[][] => {
  const out: string[][] = [];
  let current: string[] | null = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') current = [];
    else if (line === 'END:VEVENT') {
      if (current) out.push(current);
      current = null;
    } else if (current) current.push(line);
  }
  return out;
};
const eventUid = (event: string[]) => event.find((l) => l.startsWith('UID:'))?.slice(4) ?? '';
const eventGrant = (event: string[]) => eventUid(event).replace(/-\d{8}@grantfinder$/, '');
const prop = (event: string[], name: string) => event.find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`)) ?? '';
const events = icsEvents(icsText);
const logical = unfold(icsText);
check(
  'one VEVENT per qualifying match (7): upcoming date, excellent/good/possible or shortlisted',
  events.length === 7 && logical.filter((l) => l === 'BEGIN:VEVENT').length === 7 && same(events.map(eventGrant).sort(), Object.keys(expectedDue).sort()),
  events.map(eventGrant),
);
check(
  'left out: weak (not shortlisted), not_eligible (even shortlisted), passed, Rolling and "Check website"',
  ['grant_0000000ca105', 'grant_0000000ca106', 'grant_0000000ca107', 'grant_0000000ca108', 'grant_0000000ca109'].every((id) => !icsText.includes(id)),
);
const dateMisses = events.filter((event) => {
  const due = expectedDue[eventGrant(event)];
  return !due || prop(event, 'DTSTART') !== `DTSTART;VALUE=DATE:${compact(due)}` || prop(event, 'DTEND') !== `DTEND;VALUE=DATE:${compact(deadlines.addDaysIso(due, 1))}`;
});
check('DTSTART;VALUE=DATE is the next due date and DTEND the next day', dateMisses.length === 0, dateMisses.map((e) => [eventGrant(e), prop(e, 'DTSTART'), prop(e, 'DTEND')]));
const annualEvent = events.find((e) => eventGrant(e) === 'grant_0000000ca102');
check('"Annual: January 5" resolves to its next occurrence', prop(annualEvent ?? [], 'DTSTART') === `DTSTART;VALUE=DATE:${compact(nextAnnual('01-05'))}`, prop(annualEvent ?? [], 'DTSTART'));
const yearEndEvent = events.find((e) => eventGrant(e) === 'grant_0000000ca10b');
check('"Annual: December 31" ends on January 1 of the next year', prop(yearEndEvent ?? [], 'DTEND') === `DTEND;VALUE=DATE:${year + 1}0101`, prop(yearEndEvent ?? [], 'DTEND'));
check('a deadline due today is still on the calendar', prop(events.find((e) => eventGrant(e) === 'grant_0000000ca10a') ?? [], 'DTSTART') === `DTSTART;VALUE=DATE:${compact(today)}`);
check(
  "the calendar uses the grant's CURRENT deadline (saved match said Rolling)",
  prop(events.find((e) => eventGrant(e) === LIVE_ID) ?? [], 'DTSTART') === `DTSTART;VALUE=DATE:${compact(LIVE_DUE)}`,
  events.find((e) => eventGrant(e) === LIVE_ID),
);
const starts = events.map((e) => prop(e, 'DTSTART'));
check('events are in date order', same(starts, [...starts].sort()), starts);
check(
  'UID is grant id + due date @grantfinder; DTSTAMP is UTC',
  events.every((e) => /^grant_[0-9a-f]{12}-\d{8}@grantfinder$/.test(eventUid(e)) && eventUid(e).includes(compact(expectedDue[eventGrant(e)] ?? 'x'))) &&
    events.every((e) => /^DTSTAMP:\d{8}T\d{6}Z$/.test(prop(e, 'DTSTAMP'))),
  events.map((e) => [eventUid(e), prop(e, 'DTSTAMP')]),
);
const alarmMisses = events.filter((event) => {
  const triggers = event.filter((l) => l.startsWith('TRIGGER:'));
  return event.filter((l) => l === 'BEGIN:VALARM').length !== 2 || event.filter((l) => l === 'END:VALARM').length !== 2 || !same(triggers, ['TRIGGER:-P14D', 'TRIGGER:-P3D']);
});
check('every event has two VALARMs: 14 days and 3 days before', alarmMisses.length === 0, alarmMisses.map(eventGrant));
const excEvent = events.find((e) => eventGrant(e) === 'grant_0000000ca101') ?? [];
const icsEscape = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
const summaryMisses = events.filter((event) => {
  const match = calMatches.find((m) => m.grant_id === eventGrant(event));
  return !match || prop(event, 'SUMMARY') !== `SUMMARY:${icsEscape(`Grant due: ${match.grant_name} (${match.funder})`)}`;
});
check('every SUMMARY unfolds to exactly "Grant due: <name> (<funder>)" (including folds just before a space)', summaryMisses.length === 0, summaryMisses.map((e) => prop(e, 'SUMMARY')));
check('SUMMARY escapes commas and semicolons',prop(excEvent, 'SUMMARY') === 'SUMMARY:Grant due: Example Grant\\, Phase 1\\; Pilot (Example Fund)', prop(excEvent, 'SUMMARY'));
const excDescription = prop(excEvent, 'DESCRIPTION');
check(
  'DESCRIPTION escapes commas, semicolons and new lines; carries award, notes, priorities and who can apply',
  excDescription.startsWith('DESCRIPTION:Amount: Up to $10\\,000 (typical: $5\\,000)\\nMatch: 91% (Excellent)\\n') &&
    excDescription.includes('Deadline notes: LOI due first\\nthen full proposal\\n') && excDescription.includes('Funder priorities: STEM\\; literacy\\n') &&
    excDescription.includes('Who can apply: Schools only\\n') && excDescription.endsWith('https://example.org/exc'),
  excDescription,
);
check('URL property for a grant with a link', prop(excEvent, 'URL') === 'URL:https://example.org/exc', prop(excEvent, 'URL'));
const longEvent = events.find((e) => eventGrant(e) === 'grant_0000000ca10b') ?? [];
const longSummaryPhysical = physical.slice(physical.findIndex((l) => l.startsWith('SUMMARY:Grant due: Fundaci')));
const longSummaryParts = [longSummaryPhysical[0], ...longSummaryPhysical.slice(1, longSummaryPhysical.findIndex((l, i) => i > 0 && !l.startsWith(' ')))];
check(
  'a long SUMMARY with accents, a dash and an emoji is folded and unfolds to the exact text',
  prop(longEvent, 'SUMMARY') === `SUMMARY:Grant due: ${LONG_NAME} (Fundación Ejemplo)` && longSummaryParts.length >= 2 &&
    longSummaryParts.every((line) => Buffer.byteLength(line, 'utf8') <= 75) && !icsText.includes('�'),
  { summary: prop(longEvent, 'SUMMARY'), parts: longSummaryParts },
);
const ics2 = await api('POST', '/api/export', { token: tokenX, json: { session_id: 'session_finder_ics', format: 'ics', include_all_matches: true } });
check('UIDs are stable across two exports', ics2.status === 200 && same(icsEvents(ics2.text).map(eventUid), events.map(eventUid)), icsEvents(ics2.text).map(eventUid));
const icsShort = await api('POST', '/api/export', { token: tokenX, json: { session_id: 'session_finder_ics', format: 'ics' } });
check(
  'without include_all_matches: shortlisted only (the weak shortlisted grant; the not-eligible one stays off)',
  icsShort.status === 200 && same(icsEvents(icsShort.text).map(eventGrant), ['grant_0000000ca104']),
  icsShort.status === 200 ? icsEvents(icsShort.text).map(eventGrant) : icsShort.data,
);
const icsUpper = await api('POST', '/api/export', { token: tokenX, json: { session_id: 'session_finder_ics', format: ' ICS ', include_all_matches: true } });
check('format " ICS " is accepted (case and spaces ignored)', icsUpper.status === 200 && icsUpper.text.startsWith('BEGIN:VCALENDAR'), icsUpper.status);

await saveResults(userX.id, 'session_finder_ics_none', [
  matchRecord('grant_0000000cb001', 'Example Rolling Only Grant', 'excellent', 90, 'Rolling'),
  matchRecord('grant_0000000cb002', 'Example Check Only Grant', 'good', 75, 'Check website'),
  matchRecord('grant_0000000cb003', 'Example Weak Only Grant', 'weak', 30, plusDays(20)),
  matchRecord('grant_0000000cb004', 'Example Passed Only Grant', 'good', 80, plusDays(-1)),
]);
const icsNone = await api('POST', '/api/export', { token: tokenX, json: { session_id: 'session_finder_ics_none', format: 'ics', include_all_matches: true } });
check(
  'no qualifying deadline -> 422 with the NO_CALENDAR_DEADLINES message',
  icsNone.status === 422 && icsNone.data?.detail === exportResults.NO_CALENDAR_DEADLINES,
  icsNone.data,
);
const badFormat = await api('POST', '/api/export', { token: tokenX, json: { session_id: 'session_finder_ics', format: 'docx' } });
check('unsupported format -> 422 whose message lists ics', badFormat.status === 422 && /Unsupported export format "docx"/.test(badFormat.data.detail) && /\bics\b/.test(badFormat.data.detail), badFormat.data);
const noFormat = await api('POST', '/api/export', { token: tokenX, json: { session_id: 'session_finder_ics' } });
check('missing format -> 422 whose message lists ics', noFormat.status === 422 && /\bics\b/.test(noFormat.data.detail), noFormat.data);

// ===========================================================================
// 8. CSV / Markdown: the new columns and rows
// ===========================================================================

const DETAILED_ID = 'grant_00000011fe02';
const UNCLEAR_ONLY_ID = 'grant_00000011fe03';
await repo.updateGrants(userX.id, (list) => [
  ...list,
  grantRecord(userX.id, DETAILED_ID, 'Example Detailed Grant', {
    geography: 'Texas', religious_eligibility: 'secular_purpose_only', deadline_notes: 'LOI first', typical_award: '$7,500',
    focus_areas: ['STEM labs', 'Teacher training'], eligibility_notes: 'K-12 only', last_verified: '2026-09-30',
  }),
  grantRecord(userX.id, UNCLEAR_ONLY_ID, 'Example Unclear Only Grant', { religious_eligibility: 'unclear', focus_areas: [] }),
]);
await saveResults(userX.id, 'session_finder_csv', [
  matchRecord(DETAILED_ID, 'Example Detailed Grant', 'excellent', 90, OPEN_DEADLINE),
  matchRecord(UNCLEAR_ONLY_ID, 'Example Unclear Only Grant', 'good', 75, OPEN_DEADLINE),
  matchRecord('grant_00000011fe04', 'Example No Details Grant', 'possible', 60, 'Rolling'),
]);

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
const csvExport = await api('POST', '/api/export', { token: tokenX, json: { session_id: 'session_finder_csv', format: 'csv', include_all_matches: true } });
const csvRows = parseCsv(csvExport.text.replace(/^﻿/, ''));
const header = csvRows[0] ?? [];
const NEW_COLUMNS = [
  'Geography', 'Religious Eligibility', 'Deadline Notes', 'Typical Award', 'Funder Priorities', 'Eligibility Notes', 'Last Verified',
  'Past Award Levels', 'Catholic School Track Record', 'Funder Outlook',
];
check('CSV header ends with the new columns (grant facts, then the funder track record)', csvExport.status === 200 && same(header.slice(-NEW_COLUMNS.length), NEW_COLUMNS), header);
const csvCell = (row: string[] | undefined, column: string) => (row ? row[header.indexOf(column)] : undefined);
const detailedRow = csvRows.find((r) => r[1] === 'Example Detailed Grant');
check(
  "CSV: new columns filled from the grant's current details (religious label text, priorities joined with \"; \")",
  csvCell(detailedRow, 'Geography') === 'Texas' && csvCell(detailedRow, 'Religious Eligibility') === 'Eligible for non-religious uses only' &&
    csvCell(detailedRow, 'Religious Eligibility') === exportResults.RELIGIOUS_ELIGIBILITY_LABELS.secular_purpose_only &&
    csvCell(detailedRow, 'Deadline Notes') === 'LOI first' && csvCell(detailedRow, 'Typical Award') === '$7,500' &&
    csvCell(detailedRow, 'Funder Priorities') === 'STEM labs; Teacher training' && csvCell(detailedRow, 'Eligibility Notes') === 'K-12 only' &&
    csvCell(detailedRow, 'Last Verified') === '2026-09-30',
  detailedRow,
);
check('CSV: "$7,500" is quoted so the comma stays in one cell', csvExport.text.includes(',"$7,500",'), csvExport.text.split('\r\n')[1]);
const unclearRow = csvRows.find((r) => r[1] === 'Example Unclear Only Grant');
check('CSV: "unclear" reads "Not stated: confirm with the funder"', csvCell(unclearRow, 'Religious Eligibility') === 'Not stated: confirm with the funder', unclearRow);
const noDetailsRow = csvRows.find((r) => r[1] === 'Example No Details Grant');
check('CSV: a match without details leaves the new columns empty', Boolean(noDetailsRow) && NEW_COLUMNS.every((c) => csvCell(noDetailsRow, c) === ''), noDetailsRow);
check(
  'RELIGIOUS_ELIGIBILITY_LABELS cover all four values',
  types.RELIGIOUS_ELIGIBILITY_VALUES.every((v: string) => typeof exportResults.RELIGIOUS_ELIGIBILITY_LABELS[v] === 'string' && exportResults.RELIGIOUS_ELIGIBILITY_LABELS[v] !== v),
);

const mdExport = await api('POST', '/api/export', { token: tokenX, json: { session_id: 'session_finder_csv', format: 'md', include_all_matches: true } });
const mdSections = mdExport.text.split(/\n(?=### \d+\. )/).slice(1);
const mdSection = (name: string) => mdSections.find((s) => s.startsWith(`### `) && s.split('\n')[0].endsWith(name)) ?? '';
const mdDetailed = mdSection('Example Detailed Grant');
check(
  'Markdown: rows for religious eligibility, funder priorities and last verified when the data exists',
  mdExport.status === 200 && mdDetailed.includes('| Religious eligibility | Eligible for non-religious uses only |') &&
    mdDetailed.includes('| Funder priorities | STEM labs; Teacher training |') && mdDetailed.includes('| Last verified | 2026-09-30 |'),
  mdDetailed,
);
check(
  'Markdown: the other detail rows too (where applicants must be, deadline notes, typical award, who can apply)',
  mdDetailed.includes('| Where applicants must be | Texas |') && mdDetailed.includes('| Deadline notes | LOI first |') &&
    mdDetailed.includes('| Typical award | $7,500 |') && mdDetailed.includes('| Who can apply | K-12 only |'),
  mdDetailed,
);
const mdUnclear = mdSection('Example Unclear Only Grant');
check(
  'Markdown: only the rows with data (unclear eligibility, but no priorities or verified date)',
  mdUnclear.includes('| Religious eligibility | Not stated: confirm with the funder |') && !mdUnclear.includes('Funder priorities') && !mdUnclear.includes('Last verified'),
  mdUnclear,
);
const mdNone = mdSection('Example No Details Grant');
check(
  'Markdown: no detail rows for a match without details',
  Boolean(mdNone) && ['Religious eligibility', 'Funder priorities', 'Last verified', 'Where applicants must be', 'Typical award', 'Deadline notes'].every((row) => !mdNone.includes(row)),
  mdNone,
);

// ===========================================================================
// 9. Excel upload: the new columns
// ===========================================================================

async function workbookBytes(build: (wb: Json) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array(await wb.xlsx.writeBuffer());
}
async function upload(token: string, bytes: Uint8Array, filename = 'grants.xlsx') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
  return api('POST', '/api/grants/upload', { token, form });
}

const tokenY = await guest();
const detailWorkbook = await workbookBytes((wb) => {
  const school = wb.addWorksheet('Catholic School Grants');
  school.addRow(['Grant Name', 'Funder', 'Deadline', 'Religious Eligibility', 'Deadline Notes', 'Typical Award', 'Funding Priorities', 'Last Verified', 'Region']);
  school.addRow(['Example Upload Robotics Grant', 'Example Robotics Fund', '2027-04-01', 'Religious organizations not eligible', 'LOI by March 1; invitation only', 'Not published', 'STEM; robotics (K-8, after school)', new Date(Date.UTC(2026, 8, 15)), 'Central Texas (Travis, Hays)']);
  school.addRow(['Example Upload Library Grant', 'Example Library Fund', 'Rolling', 'Yes', null, '$12,000 typical', 'Literacy, Tutoring, literacy', '2026-02-30', null]);
  school.addRow(['Example Upload Secular Grant', 'Example Secular Fund', '2027-01-10', 'secular programs only', null, null, null, '2026-08-01', 'Statewide']);
  const mixedSheet = wb.addWorksheet('Mixed Church-School Grants');
  mixedSheet.addRow(['Grant Name', 'Funder', 'Geography', 'Region']);
  mixedSheet.addRow(['Example Geo Yes Grant', 'Example Geo Fund', 'Yes', null]);
  mixedSheet.addRow(['Example Geo Region Grant', 'Example Region Fund', 'Central Texas (Travis, Hays)', null]);
  mixedSheet.addRow(['Example Geo Yes With Region Grant', 'Example Diocese Fund', 'Yes', 'Diocese of [Diocese]']);
});
const upY = await upload(tokenY, detailWorkbook);
check('upload with the new columns: 6 grants added', upY.status === 200 && upY.data.uploaded_grants === 6 && upY.data.added === 6, upY.data);
let grantsY = await grantsOf(tokenY);
const yByName = (name: string) => grantsY.find((g) => g.grant_name === name);
const robotics = yByName('Example Upload Robotics Grant');
check(
  'upload: "Religious organizations not eligible" -> excluded; deadline notes kept; "Not published" award dropped',
  robotics?.religious_eligibility === 'excluded' && robotics?.deadline_notes === 'LOI by March 1; invitation only' && robotics?.typical_award === null,
  robotics,
);
check(
  'upload: Funding Priorities split (commas in parentheses kept); Last Verified date cell -> YYYY-MM-DD; Region -> geography',
  same(robotics?.focus_areas, ['STEM', 'robotics (K-8, after school)']) && robotics?.last_verified === '2026-09-15' && robotics?.geography === 'Central Texas (Travis, Hays)',
  robotics,
);
const library = yByName('Example Upload Library Grant');
check(
  'upload: "Yes" -> eligible; typical award text kept; priorities deduplicated; Feb 30 last-verified -> null; no region -> null',
  library?.religious_eligibility === 'eligible' && library?.typical_award === '$12,000 typical' && same(library?.focus_areas, ['Literacy', 'Tutoring']) &&
    library?.last_verified === null && library?.geography === null && library?.deadline_notes === null,
  library,
);
const secularUp = yByName('Example Upload Secular Grant');
check(
  'upload: "secular programs only" -> secular_purpose_only; text date kept; Region "Statewide" -> geography',
  secularUp?.religious_eligibility === 'secular_purpose_only' && secularUp?.last_verified === '2026-08-01' && secularUp?.geography === 'Statewide' && same(secularUp?.focus_areas, []),
  secularUp,
);
const geoYes = yByName('Example Geo Yes Grant');
check('upload: a "Geography" column of "Yes" still maps to geo_qualified and leaves geography empty', geoYes?.geo_qualified === 'Yes' && geoYes?.geography === null, geoYes);
const geoRegion = yByName('Example Geo Region Grant');
check(
  'upload: Geography "Central Texas (Travis, Hays)" sets geography (and geo_qualified TX only)',
  geoRegion?.geography === 'Central Texas (Travis, Hays)' && geoRegion?.geo_qualified === 'Yes - TX Only',
  geoRegion,
);
const geoBoth = yByName('Example Geo Yes With Region Grant');
check('upload: Geography "Yes" plus a Region -> geo_qualified Yes, geography from Region', geoBoth?.geo_qualified === 'Yes' && geoBoth?.geography === 'Diocese of [Diocese]', geoBoth);

const partialWorkbook = await workbookBytes((wb) => {
  const school = wb.addWorksheet('Catholic School Grants');
  school.addRow(['Grant Name', 'Funder', 'Religious Eligibility']);
  school.addRow(['Example Upload Robotics Grant', 'Example Robotics Fund', 'Eligible']);
});
const upY2 = await upload(tokenY, partialWorkbook);
grantsY = await grantsOf(tokenY);
const roboticsAfter = yByName('Example Upload Robotics Grant');
check(
  're-upload with only Religious Eligibility: same grant updated, other details kept',
  upY2.status === 200 && upY2.data.updated === 1 && upY2.data.added === 0 && roboticsAfter?.id === robotics?.id && roboticsAfter?.religious_eligibility === 'eligible' &&
    roboticsAfter?.deadline_notes === 'LOI by March 1; invitation only' && same(roboticsAfter?.focus_areas, ['STEM', 'robotics (K-8, after school)']) &&
    roboticsAfter?.last_verified === '2026-09-15' && roboticsAfter?.geography === 'Central Texas (Travis, Hays)',
  { data: upY2.data, roboticsAfter },
);

mock.stop();
finish();
