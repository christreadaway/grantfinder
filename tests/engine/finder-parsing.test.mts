/**
 * Grant finder parsing (QA fixes):
 *  1. religious eligibility: the funder's words are always kept (religious_eligibility_text), the
 *     many ways funders say "religious organizations can't apply" are read as excluded, "secular
 *     organizations only" is an exclusion (not a secular purpose), mixed statements are unclear, and
 *     "Ineligible: none" / "No exclusions" are eligible; who applies (applicants) is read from plain words;
 *  2. a person's spreadsheet corrections to a starter grant survive "Update my grants";
 *  3. deadlines with a time of day, and common date formats, are read (and can pass);
 *  4. web discovery never saves closed or past-deadline grants; plain notes everywhere; money,
 *     Excel serial dates, future verified dates, "N/A" awards and long texts cut at a word.
 *
 *   cd ~/grantfinder/frontend && npx tsx ../tests/engine/finder-parsing.test.mts
 *   (VERBOSE=1 shows the engine's log lines)
 *
 * Dates are computed from the suite's today (GRANTFINDER_TODAY in test mode), never fixed, and the
 * starter database is read from the file at runtime (its counts and names change over time).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { api, call, check, finish, guest, repoRoot, saveKey, setupEnv, startMock } from './helpers.mts';

setupEnv('finder-parsing');
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
const excel = await import('../../frontend/src/server/services/excel.ts');
const ai = await import('../../frontend/src/server/services/ai.ts');
const discoveryRoutes = await import('../../frontend/src/server/routes/discovery.ts');
const discoveryJobs = await import('../../frontend/src/server/handlers/discovery.ts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const today = deadlines.todayIso();
const plusDays = (days: number) => deadlines.addDaysIso(today, days);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
/** 2026-09-01 -> 9/1/2026 */
const usDate = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}/${iso.slice(0, 4)}`;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** 2026-09-01 -> { month: 'September', day: 1, year: 2026 } */
const parts = (iso: string) => ({ month: MONTH_NAMES[Number(iso.slice(5, 7)) - 1], day: Number(iso.slice(8, 10)), year: Number(iso.slice(0, 4)) });
/** The Excel serial number of a date (and fraction of a day). */
const serialOf = (iso: string, fraction = 0) => Math.round((Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) - Date.UTC(1899, 11, 30)) / 86_400_000) + fraction;

async function me(token: string): Promise<{ id: string }> {
  return (await api('GET', '/api/auth/me', { token })).data;
}

async function grantsOf(token: string): Promise<Json[]> {
  return (await api('GET', '/api/grants', { token })).data;
}

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
// 1. parseReligiousEligibility
// ===========================================================================

const religious = details.parseReligiousEligibility;
const religiousMisses = (cases: Array<[unknown, string | null]>) =>
  cases.filter(([input, want]) => religious(input) !== want).map(([input, want]) => `${JSON.stringify(input)} -> ${religious(input)} (want ${want})`);

let misses = religiousMisses([
  ['Religious organizations may not apply', 'excluded'],
  ['Churches and religious schools may not apply.', 'excluded'],
  ['Not open to religious organizations', 'excluded'],
  ['This program is not open to faith-based schools', 'excluded'],
  ['Not available to religious organizations', 'excluded'],
  ["Don't fund churches", 'excluded'],
  ["We don’t fund religious organizations", 'excluded'],
  ["Doesn't fund religious schools", 'excluded'],
  ["Won't fund sectarian organizations", 'excluded'],
  ['Do not fund religious groups', 'excluded'],
  ['Does not fund religious organizations.', 'excluded'],
  ['Will not fund faith-based organizations', 'excluded'],
  ['Religious organizations cannot receive funds', 'excluded'],
  ["Religious schools can't receive grants", 'excluded'],
  ['Applicant must not be a religious organization', 'excluded'],
  ['No religious organizations', 'excluded'],
  ['Religious organizations: No', 'excluded'],
  ['Religious Orgs Eligible: No', 'excluded'],
  ['Faith-based organizations: not eligible', 'excluded'],
  ['Public schools only', 'excluded'],
  ['Public and charter schools only', 'excluded'],
  ['Open to public schools only', 'excluded'],
  ['Only public schools are eligible', 'excluded'],
  ['Limited to public school districts', 'excluded'],
  ['Private schools not eligible', 'excluded'],
  ["Religious organizations aren't eligible", 'excluded'],
  ['Houses of worship are not eligible', 'excluded'],
]);
check('religious: "may not apply", "not open to", "don\'t/doesn\'t/won\'t/do not/does not/will not fund", "cannot receive", "must not be a religious organization", "no religious organizations", "Religious organizations: No", "public schools only" -> excluded', misses.length === 0, misses);

misses = religiousMisses([
  ['Secular organizations only', 'excluded'],
  ['Non-religious organizations only', 'excluded'],
  ['Nonsectarian organizations only', 'excluded'],
  ['Non-sectarian nonprofits only', 'excluded'],
  ['Open to secular nonprofits only', 'excluded'],
  ['Only nonsectarian organizations may apply', 'excluded'],
  ['Applicants must be a secular organization', 'excluded'],
  ['Does not fund religious organizations (secular nonprofits only)', 'excluded'],
]);
check('religious: "(secular|non-religious|nonsectarian) organizations only" -> excluded (read before the secular-purpose words)', misses.length === 0, misses);

misses = religiousMisses([
  ['Secular purposes only', 'secular_purpose_only'],
  ['secular programs only', 'secular_purpose_only'],
  ['Secular uses only', 'secular_purpose_only'],
  ['Not for religious instruction', 'secular_purpose_only'],
  ['Yes, but not for religious instruction', 'secular_purpose_only'],
  ['Funds may not be used for religious purposes', 'secular_purpose_only'],
  ['Does not fund religious instruction or worship services', 'secular_purpose_only'],
  ['No religious activities may be funded', 'secular_purpose_only'],
  ['Faith-based organizations may apply, but funds cannot support religious activities', 'secular_purpose_only'],
  ['Eligible except for religious instruction', 'secular_purpose_only'],
  ['Eligible for non-religious uses only', 'secular_purpose_only'],
]);
check('religious: "secular purposes/programs/uses only", "not for religious instruction", "no religious activities" stay secular_purpose_only', misses.length === 0, misses);

misses = religiousMisses([
  ['Catholic schools eligible; churches excluded', 'unclear'],
  ['Catholic schools eligible, churches excluded', 'unclear'],
  ['Catholic schools are eligible but churches are not eligible', 'unclear'],
  ['Religious organizations eligible; houses of worship excluded', 'unclear'],
  ['Eligible except churches', 'unclear'],
  ['Yes - but parishes may not apply', 'unclear'],
  ['Unclear whether religious organizations are eligible', 'unclear'],
  ['Churches excluded; unclear for schools', 'unclear'],
]);
check('religious: mixed statements ("Catholic schools eligible; churches excluded") -> unclear, not excluded', misses.length === 0, misses);

misses = religiousMisses([
  ['Ineligible: none', 'eligible'],
  ['Exclusions: None.', 'eligible'],
  ['No exclusions', 'eligible'],
  ['Not restricted', 'eligible'],
  ['No restrictions', 'eligible'],
  ['No religious restrictions', 'eligible'],
  ['Not excluded', 'eligible'],
  ['Does not exclude religious organizations', 'eligible'],
  ['Eligible regardless of religious affiliation', 'eligible'],
  ['Religious orgs eligible', 'eligible'],
  ['Religious organizations: Yes', 'eligible'],
  ['Open to all nonprofits, including religious organizations', 'eligible'],
  ['Eligible (confirm with the funder)', 'eligible'],
]);
check('religious: "Ineligible: none", "No exclusions", "Not restricted", "No restrictions" and plain yeses -> eligible', misses.length === 0, misses);

misses = religiousMisses([
  ['All nonprofits eligible except religious organizations', 'excluded'],
  ['Schools may apply; religious organizations are not eligible', 'excluded'],
  ['Must be a 501(c)(3); religious organizations not eligible', 'excluded'],
  ['Religious organizations, including Catholic schools, are not eligible', 'excluded'],
  ['Eligible: 501(c)(3)s and public agencies; ineligible: religious organizations', 'excluded'],
]);
check('religious: a general "all nonprofits eligible" next to an exclusion of religious organizations stays excluded', misses.length === 0, misses);

// Every case the earlier suite (finder.test.mts) pins, and the app's own labels reading back.
misses = religiousMisses([
  ['eligible', 'eligible'], ['secular_purpose_only', 'secular_purpose_only'], ['excluded', 'excluded'], ['unclear', 'unclear'], ['  Excluded ', 'excluded'],
  ['Secular purpose only', 'secular_purpose_only'], ['SECULAR-PURPOSE-ONLY', 'secular_purpose_only'],
  ['Yes', 'eligible'], ['yes - Catholic schools welcome', 'eligible'], ['Y', 'eligible'], ['TRUE', 'eligible'],
  ['No', 'excluded'], ['Religious organizations not eligible', 'excluded'], ['Religious organizations are not eligible', 'excluded'], ['Ineligible', 'excluded'],
  ['Does not accept applications from churches', 'excluded'], ['No, religious organizations are excluded', 'excluded'],
  ['Unclear', 'unclear'], ['Unknown', 'unclear'], ['check with the funder', 'unclear'],
  ['Religious organizations eligible', 'eligible'], ['Yes, religious schools may apply', 'eligible'], ['Faith-based schools welcome', 'eligible'],
  ['', null], ['   ', null], [null, null], [undefined, null], [{}, null], [['eligible'], null], [true, null], ['banana', null], ['42', null],
]);
check('religious: every earlier case still reads the same', misses.length === 0, misses);
const LABELS: Record<string, string> = {
  'Catholic schools eligible': 'eligible',
  'Religious orgs eligible': 'eligible',
  'Does not fund religious organizations': 'excluded',
  'Eligible for non-religious uses only': 'secular_purpose_only',
  'Not stated: confirm with the funder': 'unclear',
};
misses = religiousMisses(Object.entries(LABELS));
check("religious: the app's own labels read back as their value", misses.length === 0, misses);

// ===========================================================================
// 2. The funder's words: religious_eligibility_text
// ===========================================================================

const pgd = details.parseGrantDetails;
const words = (data: Record<string, unknown>) => {
  const read = pgd(data);
  return [read.religious_eligibility, read.religious_eligibility_text ?? null];
};
check(
  'words: an excluded phrasing keeps its words (trimmed) beside the value',
  same(words({ religious_eligibility: '  Religious organizations may not apply  ' }), ['excluded', 'Religious organizations may not apply']),
  words({ religious_eligibility: '  Religious organizations may not apply  ' }),
);
check(
  'words: words that can\'t be read are still kept (value null)',
  same(words({ religious_eligibility: 'Parishes in the [Diocese] only, per the 2026 guidelines' }), [null, 'Parishes in the [Diocese] only, per the 2026 guidelines']),
  words({ religious_eligibility: 'Parishes in the [Diocese] only, per the 2026 guidelines' }),
);
check(
  'words: a bare code ("eligible", "Secular purpose only") is a value, not words: no religious_eligibility_text key',
  !('religious_eligibility_text' in pgd({ religious_eligibility: 'eligible' })) && !('religious_eligibility_text' in pgd({ religious_eligibility: 'Secular purpose only' })) &&
    !('religious_eligibility_text' in pgd({})) && !('applicants' in pgd({})),
  pgd({ religious_eligibility: 'eligible' }),
);
const longWords = `Religious organizations may not apply. ${'The funder explains its reasons at length in the guidelines. '.repeat(10)}`;
const longRead = pgd({ religious_eligibility: longWords }).religious_eligibility_text ?? '';
check(
  'words: at most 300 characters, cut at a word with "..."',
  longRead.length <= 300 && longRead.endsWith('...') && longWords.startsWith(longRead.slice(0, -3)) && /[\s.,;:]/.test(longWords.charAt(longRead.length - 3)) &&
    pgd({ religious_eligibility: longWords }).religious_eligibility === 'excluded',
  { length: longRead.length, end: longRead.slice(-40) },
);
check(
  'words: a list is joined with "; " and read whole',
  same(words({ religious_eligibility: ['Catholic schools eligible', 'churches excluded'] }), ['unclear', 'Catholic schools eligible; churches excluded']),
  words({ religious_eligibility: ['Catholic schools eligible', 'churches excluded'] }),
);
check(
  'words: separate funder words (web discovery) are kept beside the code',
  same(words({ religious_eligibility: 'secular_purpose_only', religious_eligibility_text: 'Funds may not support worship or religious instruction.' }), [
    'secular_purpose_only',
    'Funds may not support worship or religious instruction.',
  ]),
  words({ religious_eligibility: 'secular_purpose_only', religious_eligibility_text: 'Funds may not support worship or religious instruction.' }),
);
check(
  'words: no code, words that exclude -> excluded',
  same(words({ religious_eligibility_text: 'Public schools only' }), ['excluded', 'Public schools only']),
  words({ religious_eligibility_text: 'Public schools only' }),
);
check(
  'words: a code and words that disagree about an exclusion -> unclear (never silently in or out)',
  pgd({ religious_eligibility: 'eligible', religious_eligibility_text: 'Religious organizations are not eligible' }).religious_eligibility === 'unclear' &&
    pgd({ religious_eligibility: 'excluded', religious_eligibility_text: 'Catholic schools welcome' }).religious_eligibility === 'unclear' &&
    pgd({ religious_eligibility: 'eligible', religious_eligibility_text: 'Catholic schools welcome' }).religious_eligibility === 'eligible',
);
const madeWords = discovery.makeGrant('user_x', 'web_discovery', { grant_name: 'Example Words Grant', religious_eligibility: 'Not open to religious organizations' });
check(
  'makeGrant passes the words through',
  madeWords?.religious_eligibility === 'excluded' && madeWords?.religious_eligibility_text === 'Not open to religious organizations',
  madeWords,
);

// ===========================================================================
// 3. Who applies: parseApplicants
// ===========================================================================

const applicants = details.parseApplicants;
const applicantMisses = (cases: Array<[unknown, string[]]>) =>
  cases.filter(([input, want]) => !same(applicants(input), want)).map(([input, want]) => `${JSON.stringify(input)} -> ${JSON.stringify(applicants(input))} (want ${JSON.stringify(want)})`);
misses = applicantMisses([
  [['school', 'teacher'], ['school', 'teacher']],
  [['diocese'], ['diocese']],
  ['Schools', ['school']],
  ['Parishes and churches', ['parish']],
  ['Dioceses; bishops', ['diocese']],
  ['Teachers, educators', ['teacher']],
  ['Families, students and parents', ['family']],
  ['501(c)(3) nonprofits; charities', ['nonprofit']],
  ['Schools and teachers', ['school', 'teacher']],
  ['Teachers at Catholic schools', ['teacher']],
  ['Parish schools', ['school']],
  ['Parents of students', ['family']],
  ['Dioceses apply on behalf of their schools', ['diocese']],
  ['Schools, parishes, dioceses, teachers, families, nonprofits', ['school', 'parish', 'diocese', 'teacher', 'family', 'nonprofit']],
]);
check('applicants: plain words -> school, parish, diocese, teacher, family, nonprofit (in the order written)', misses.length === 0, misses);
misses = applicantMisses([
  ['Individuals', []],
  [['teacher', 'banana', 'nonprofit'], ['teacher', 'nonprofit']],
  ['school, School, SCHOOLS', ['school']],
  ['Schools (not individuals)', ['school']],
  ['Schools; not families', ['school']],
  ['', []],
  [null, []],
  [42, []],
  [{ school: true }, []],
]);
check('applicants: unknown words and negated phrases dropped; each type once; non-text -> []', misses.length === 0, misses);
check(
  'applicants: parseGrantDetails and makeGrant carry them (key only when known)',
  same(pgd({ applicants: 'Teachers' }).applicants, ['teacher']) && !('applicants' in pgd({ applicants: 'Individuals' })) &&
    same(discovery.makeGrant('u', 'seed', { grant_name: 'Example Applicants Grant', applicants: ['diocese', 'school'] })?.applicants, ['diocese', 'school']),
);
const seedFile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'frontend', 'src', 'server', 'data', 'seed_grants.json'), 'utf8'));
const seedEntries: Json[] = (Array.isArray(seedFile.grants) ? seedFile.grants : []).filter((entry: Json) => entry && typeof entry === 'object' && entry.grant_name);
const seedApplicantMisses = seedEntries.filter((entry) => Array.isArray(entry.applicants) && !same(applicants(entry.applicants), entry.applicants.filter((a: string) => (types.APPLICANT_TYPES as string[]).includes(a))));
check('applicants: every starter grant\'s list reads back as written', seedApplicantMisses.length === 0, seedApplicantMisses.map((e) => e.grant_name));
check(
  'spreadsheet columns "Applicants", "Who Applies", "Applicant Type" map to applicants',
  ['Applicants', 'Who Applies', 'Applicant Type', 'applicant types', ' WHO APPLIES: '].every((name) => excel.normalizeColumnName(name) === 'applicants'),
  ['Applicants', 'Who Applies', 'Applicant Type'].map((name) => excel.normalizeColumnName(name)),
);

// ===========================================================================
// 4. Deadlines: times and common formats
// ===========================================================================

const pd = deadlines.parseDeadline;
const dlMisses = (cases: Array<[string, string | null]>) =>
  cases.filter(([input, want]) => pd(input, '2026-10-15') !== want).map(([input, want]) => `${JSON.stringify(input)} -> ${pd(input, '2026-10-15')} (want ${want})`);
misses = dlMisses([
  ['2026-09-01 17:00', '2026-09-01'],
  ['2026-09-01 5:00 PM', '2026-09-01'],
  ['2026-09-01T17:00:00Z', '2026-09-01'],
  ['2026-09-01T23:30:00-05:00', '2026-09-01'],
  ['2026-09-01T17:00:00.000Z', '2026-09-01'],
  ['2026-09-01 at noon', '2026-09-01'],
  ['September 1st, 2026', '2026-09-01'],
  ['Sept. 2nd 2026', '2026-09-02'],
  ['October 23rd, 2026', '2026-10-23'],
  ['1 September 2026', '2026-09-01'],
  ['1st of September, 2026', '2026-09-01'],
  ['9/1/2026 5:00 PM', '2026-09-01'],
  ['9/1/2026 17:00', '2026-09-01'],
  ['09/01/26 11:59 p.m. CT', '2026-09-01'],
  ['2026/09/01', '2026-09-01'],
  ['Friday, October 16, 2026', '2026-10-16'],
  ['October 15, 2026 at 11:59 PM CT', '2026-10-15'],
  ['Oct. 15, 2026, 5 p.m. Central Time', '2026-10-15'],
]);
check('parseDeadline: ISO date + time (the date as written), ordinals, "1 September 2026", US date + time, 2026/09/01, a weekday in front', misses.length === 0, misses);
misses = dlMisses([
  ['2026-02-30 17:00', null],
  ['2026-09-01 25:00', null],
  ['2026-09-01 17:75', null],
  ['9/1/2026 17:00 PM', null],
  ['2026-09-01 5', null],
  ['2026-09-01Tjunk', null],
  ['2026-09/01', null],
  ['31 June 2026', null],
  ['June 31st, 2026', null],
  ['2026/02/29', null],
  ['Smarch 1st, 2026', null],
  ['Rolling', null],
  ['Check website', null],
  ['', null],
]);
check('parseDeadline: still strict (impossible dates and times, mixed separators, junk -> null)', misses.length === 0, misses);
misses = dlMisses([
  ['2026-10-15', '2026-10-15'],
  ['10/15/2026', '2026-10-15'],
  ['10/15/26', '2026-10-15'],
  ['October 15, 2026', '2026-10-15'],
  ['Oct 15 2026', '2026-10-15'],
  ['Annual: October 15', '2026-10-15'],
  ['Annual: October 14', '2027-10-14'],
]);
check('parseDeadline: the earlier formats are unchanged', misses.length === 0, misses);
check(
  'deadlinePassed: a past deadline with a time has passed; one later today or ahead has not',
  deadlines.deadlinePassed(`${plusDays(-1)} 17:00`) && deadlines.deadlinePassed(`${usDate(plusDays(-3))} 5:00 PM`) && deadlines.deadlinePassed(`${plusDays(-2)}T09:00:00Z`) &&
    !deadlines.deadlinePassed(`${today} 17:00`) && !deadlines.deadlinePassed(`${plusDays(5)}T17:00:00Z`) &&
    deadlines.deadlinePassed(`${parts(plusDays(-4)).month} ${parts(plusDays(-4)).day}th, ${parts(plusDays(-4)).year}`),
);
check('parseDate never reads a yearly deadline (that is parseDeadline\'s job)', deadlines.parseDate('Annual: October 15') === null && deadlines.parseDate('2026-10-15 17:00') === '2026-10-15');

// ===========================================================================
// 5. Money, Excel serial dates, verified dates, "N/A" awards, long texts
// ===========================================================================

const made = (data: Record<string, unknown>) => discovery.makeGrant('user_x', 'web_discovery', { grant_name: 'Example Made Grant', ...data })!;
check(
  'makeGrant: a numeric amount becomes money; text amounts stay as written',
  made({ amount: 5000 }).amount === '$5,000' && made({ amount: 1234.5 }).amount === '$1,234.50' && made({ amount: '15000' }).amount === '$15,000' &&
    made({ amount: 'Up to $10,000' }).amount === 'Up to $10,000' && made({}).amount === 'Varies' && made({ amount: '' }).amount === 'Varies',
  [made({ amount: 5000 }).amount, made({ amount: 1234.5 }).amount, made({ amount: '15000' }).amount],
);
check(
  'makeGrant: an Excel serial deadline becomes its date (46387 -> 2026-12-31); a time of day goes into the deadline notes',
  made({ deadline: 46387 }).deadline === '2026-12-31' && made({ deadline: '46387' }).deadline === '2026-12-31' && made({ deadline: 46387 }).deadline_notes === null &&
    made({ deadline: 46387 + 17 / 24, deadline_notes: 'LOI first' }).deadline === '2026-12-31' &&
    made({ deadline: 46387 + 17 / 24, deadline_notes: 'LOI first' }).deadline_notes === 'Due at 17:00; LOI first' &&
    made({ deadline: 2026 }).deadline === '2026' && made({ deadline: 'Rolling' }).deadline === 'Rolling',
  [made({ deadline: 46387 }).deadline, made({ deadline: 46387 + 17 / 24, deadline_notes: 'LOI first' }).deadline_notes, made({ deadline: 2026 }).deadline],
);
check(
  'excelSerialDate: only serials between 2000 and 2099; floating-point noise rounds to the second',
  details.excelSerialDate(36525) === null && details.excelSerialDate(73051) === null && details.excelSerialDate('12345') === null &&
    same(details.excelSerialDate(serialOf('2026-09-01', 0.7083333)), { date: '2026-09-01', time: '17:00' }) &&
    same(details.excelSerialDate(serialOf('2026-09-01', 0.99999999)), { date: '2026-09-02', time: null }),
  details.excelSerialDate(serialOf('2026-09-01', 0.7083333)),
);
const lv = (value: unknown) => pgd({ last_verified: value }).last_verified;
check(
  'last_verified: a date after today -> null; today and earlier kept',
  lv(plusDays(1)) === null && lv(plusDays(400)) === null && lv(today) === today && lv(plusDays(-30)) === plusDays(-30),
  [lv(plusDays(1)), lv(today)],
);
check(
  'last_verified: US date text, month names, timestamps and Excel serials are read',
  lv(usDate(plusDays(-14))) === plusDays(-14) && lv(`${parts(plusDays(-14)).month} ${parts(plusDays(-14)).day}, ${parts(plusDays(-14)).year}`) === plusDays(-14) &&
    lv(`${plusDays(-14)}T12:00:00Z`) === plusDays(-14) && lv(serialOf(plusDays(-14))) === plusDays(-14) && lv(String(serialOf(plusDays(-14)))) === plusDays(-14),
  [lv(usDate(plusDays(-14))), lv(serialOf(plusDays(-14)))],
);
check('last_verified: impossible dates and junk -> null', lv('2026-02-30') === null && lv('13/45/2026') === null && lv('last spring') === null && lv(true) === null);
const ta = (value: unknown) => pgd({ typical_award: value }).typical_award;
check(
  'typical award: "N/A", "Unknown", "None", "Not published", "Not available", "TBD" -> null; "Varies" kept',
  ['N/A', 'n/a.', 'NA', 'Unknown', 'None', 'none', 'Not published', 'Not published (check site)', 'Not available', 'TBD', '-', ''].every((value) => ta(value) === null) &&
    ta('Varies') === 'Varies' && ta('$8,000 median') === '$8,000 median',
  ['N/A', 'Unknown', 'None', 'Varies'].map(ta),
);
check('typical award: a number becomes money', ta(5000) === '$5,000' && ta('7500') === '$7,500', [ta(5000), ta('7500')]);

const longNotes = `${'Letters of inquiry are reviewed each quarter by the program committee. '.repeat(12)}`.trim();
const cutNotes = pgd({ deadline_notes: longNotes }).deadline_notes ?? '';
check(
  'deadline notes: cut at a word boundary with "..." (never mid-word), at most 600 characters',
  cutNotes.length <= 600 && cutNotes.endsWith('...') && longNotes.startsWith(cutNotes.slice(0, -3)) && /[\s.]/.test(longNotes.charAt(cutNotes.length - 3)),
  cutNotes.slice(-50),
);
const cutGeo = pgd({ geography: `Counties: ${'Travis, Williamson, Hays, Bastrop, Caldwell, Burnet, '.repeat(10)}` }).geography ?? '';
check('geography: cut at a word with "..." (at most 300)', cutGeo.length <= 300 && cutGeo.endsWith('...') && !/,\.\.\.$/.test(cutGeo), cutGeo.slice(-40));
check(
  'clip: short text unchanged; a single giant word is still cut to the limit; trailing punctuation dropped before "..."',
  details.clip('short', 10) === 'short' && details.clip('x'.repeat(50), 20) === `${'x'.repeat(17)}...` && details.clip('alpha beta, gamma delta', 16) === 'alpha beta...',
  [details.clip('x'.repeat(50), 20), details.clip('alpha beta, gamma delta', 16)],
);
check(
  'detailList items: cut at a word with "..." (160)',
  (details.detailList([`${'robotics '.repeat(30)}`])[0] ?? '').endsWith('robotics...') && (details.detailList([`${'robotics '.repeat(30)}`])[0] ?? '').length <= 160,
);
check(
  'sources: links are never cut (an over-long link is dropped, not shortened)',
  same(details.sourceList([`https://example.org/${'a'.repeat(200)}`]), [`https://example.org/${'a'.repeat(200)}`]) && same(details.sourceList([`https://example.org/${'a'.repeat(2100)}`]), []),
);

// ===========================================================================
// 6. Spreadsheet upload: problem phrasings, words stored, excluded = Not Eligible with no Claude call
// ===========================================================================

const EXCLUDED_PHRASES = [
  'Religious organizations may not apply',
  'Not open to religious organizations',
  "We don't fund churches or religious schools",
  'Religious organizations cannot receive funds',
  'Applicant must not be a religious organization',
  'No religious organizations',
  'Religious organizations: No',
  'Public schools only',
  'Public and charter schools only',
  'Secular organizations only',
  'Nonsectarian organizations only',
];
const excludedName = (index: number) => `Example Excluded Phrasing Grant ${index + 1}`;
const tokenE = await guest();
await saveKey(tokenE);
const userE = await me(tokenE);
await repo.saveProfile(userE.id, texasProfile(userE.id));
const excludedBook = await workbookBytes((wb) => {
  const sheet = wb.addWorksheet('Catholic School Grants');
  sheet.addRow(['Grant Name', 'Funder', 'Deadline', 'Religious Eligibility', 'Who Applies']);
  EXCLUDED_PHRASES.forEach((phrase, index) => sheet.addRow([excludedName(index), `Example Funder ${index + 1}`, plusDays(90), phrase, 'Schools']));
});
const upE = await upload(tokenE, excludedBook);
check(`upload: ${EXCLUDED_PHRASES.length} grants with the problem phrasings added`, upE.status === 200 && upE.data.added === EXCLUDED_PHRASES.length, upE.data);
const grantsE = await grantsOf(tokenE);
const wordMisses = EXCLUDED_PHRASES.filter((phrase, index) => {
  const grant = grantsE.find((g) => g.grant_name === excludedName(index));
  return !grant || grant.religious_eligibility !== 'excluded' || grant.religious_eligibility_text !== phrase || !same(grant.applicants, ['school']);
});
check('upload: every phrasing is stored as excluded, with the words exactly as typed and who applies', wordMisses.length === 0, wordMisses);

await mock.reset();
const matchE = await call('POST', '/api/processing/match-grants', { token: tokenE });
const matchById = (results: Json, name: string) => results?.matches?.find((m: Json) => m.grant_name === name);
const notEligibleMisses = EXCLUDED_PHRASES.filter((phrase, index) => {
  const match = matchById(matchE.data, excludedName(index));
  return !match || match.score !== 0 || match.score_tier !== 'not_eligible' || match.explanation !== ai.RELIGIOUS_EXCLUDED_REASON || match.religious_eligibility_text !== phrase;
});
check(
  'matching: every excluded phrasing is Not Eligible (score 0, the religious reason), the words on the match',
  matchE.status === 200 && matchE.data.matches.length === EXCLUDED_PHRASES.length && notEligibleMisses.length === 0,
  { status: matchE.status, misses: notEligibleMisses, first: matchE.data?.matches?.[0] },
);
const callsE = (await mock.requests()).filter((r) => r.prompt_id === 'grant_match_batch_v1');
check('matching: no Claude call at all when every grant is ruled out by its religious words', callsE.length === 0, callsE.length);

// Mixed workbook: the excluded ones never reach Claude; the others do, with their words stored.
const tokenM = await guest();
await saveKey(tokenM);
const userM = await me(tokenM);
await repo.saveProfile(userM.id, texasProfile(userM.id));
const dueSoon = plusDays(40);
const duePast = plusDays(-5);
const at = (iso: string, hour: number, minute = 0) => new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)), hour, minute));
const KEPT_ROWS: Array<[string, unknown, string, string | null, string | null]> = [
  // name, deadline cell, religious words, want religious_eligibility, Deadline Notes cell
  ['Example Mixed Words Grant', plusDays(60), 'Catholic schools eligible; churches excluded', 'unclear', null],
  ['Example No Exclusions Grant', plusDays(60), 'Ineligible: none', 'eligible', null],
  ['Example Secular Purpose Grant', plusDays(60), 'Secular purposes only', 'secular_purpose_only', null],
  ['Example Unreadable Words Grant', plusDays(60), 'Parishes in the [Diocese] only, per the 2026 guidelines', null, null],
  ['Example Timed Deadline Grant', at(dueSoon, 17), 'Catholic schools eligible', 'eligible', 'LOI by email first'],
  ['Example Midnight Date Grant', at(dueSoon, 0), 'Yes', 'eligible', null],
];
const PAST_TIMED = 'Example Past Timed Deadline Grant';
const mixedBook = await workbookBytes((wb) => {
  const sheet = wb.addWorksheet('Catholic School Grants');
  sheet.addRow(['Grant Name', 'Funder', 'Deadline', 'Religious Eligibility', 'Deadline Notes', 'Applicant Type', 'Last Verified', 'Typical Award', 'Amount']);
  for (const [name, deadline, phrase, , notes] of KEPT_ROWS) sheet.addRow([name, `${name} Fund`, deadline, phrase, notes, 'Teachers; schools', usDate(plusDays(-7)), 'N/A', 5000]);
  sheet.addRow([PAST_TIMED, `${PAST_TIMED} Fund`, at(duePast, 17), 'Eligible', null, null, null, null, null]);
  EXCLUDED_PHRASES.slice(0, 3).forEach((phrase, index) => sheet.addRow([excludedName(index), `Example Funder ${index + 1}`, plusDays(90), phrase, null, null, null, null, null]));
});
const upM = await upload(tokenM, mixedBook);
check('mixed upload: every row added', upM.status === 200 && upM.data.added === KEPT_ROWS.length + 4, upM.data);
const grantsM = await grantsOf(tokenM);
const byName = (list: Json[], name: string) => list.find((g) => g.grant_name === name);
const keptMisses = KEPT_ROWS.filter(([name, , phrase, want]) => {
  const grant = byName(grantsM, name);
  return !grant || grant.religious_eligibility !== want || grant.religious_eligibility_text !== phrase;
});
check('mixed upload: mixed -> unclear, "Ineligible: none" -> eligible, secular purposes -> secular, unreadable -> null; words kept for each', keptMisses.length === 0, keptMisses.map((r) => [r[0], byName(grantsM, r[0])?.religious_eligibility, byName(grantsM, r[0])?.religious_eligibility_text]));
const timed = byName(grantsM, 'Example Timed Deadline Grant');
check(
  'date cell with a time: deadline stored as YYYY-MM-DD only; "Due at 17:00" goes into the deadline notes (before the row\'s own notes)',
  timed?.deadline === dueSoon && timed?.deadline_notes === 'Due at 17:00; LOI by email first',
  timed,
);
const midnight = byName(grantsM, 'Example Midnight Date Grant');
check('date cell at midnight: YYYY-MM-DD and no time note', midnight?.deadline === dueSoon && midnight?.deadline_notes === null, midnight);
check(
  'upload: Applicant Type, US-date Last Verified, "N/A" typical award, numeric amount',
  same(midnight?.applicants, ['teacher', 'school']) && midnight?.last_verified === plusDays(-7) && midnight?.typical_award === null && midnight?.amount === '$5,000',
  midnight,
);
const pastTimed = byName(grantsM, PAST_TIMED);
check('a past date cell with a time is stored as its date, so the deadline reads as passed', pastTimed?.deadline === duePast && deadlines.deadlinePassed(pastTimed?.deadline) && pastTimed?.deadline_notes === 'Due at 17:00', pastTimed);

await mock.reset();
const scoreItem = (id: string, score: number) => ({
  grant_id: id,
  score,
  score_breakdown: { eligibility_fit: score, need_alignment: score, capacity_signals: score, timing: score, completeness: score },
  explanation: `Mock score for ${id}`,
  evidence: ['Mock evidence'],
});
await mock.fixtures({ grant_match_batch_v1: JSON.stringify(KEPT_ROWS.map(([name], index) => scoreItem(byName(grantsM, name)?.id, 80 - index))) });
const matchM = await call('POST', '/api/processing/match-grants', { token: tokenM });
const promptsM = (await mock.requests()).filter((r) => r.prompt_id === 'grant_match_batch_v1').map((r) => r.prompt);
check('mixed matching runs', matchM.status === 200 && matchM.data.matches.length === KEPT_ROWS.length + 4, matchM.status);
check(
  'mixed matching: the excluded phrasings are Not Eligible and never in a Claude prompt',
  [0, 1, 2].every((index) => {
    const match = matchById(matchM.data, excludedName(index));
    return match?.score_tier === 'not_eligible' && match?.explanation === ai.RELIGIOUS_EXCLUDED_REASON && promptsM.every((p) => !p.includes(excludedName(index)));
  }),
  [0, 1, 2].map((index) => matchById(matchM.data, excludedName(index))?.explanation),
);
const pastMatch = matchById(matchM.data, PAST_TIMED);
check(
  'mixed matching: the past deadline that had a time is ruled out as passed (no Claude call for it)',
  pastMatch?.score_tier === 'not_eligible' && /^Deadline passed/.test(pastMatch?.explanation ?? '') && promptsM.every((p) => !p.includes(PAST_TIMED)),
  pastMatch,
);
check(
  'mixed matching: the unclear, eligible, secular and unreadable ones went to Claude',
  promptsM.length >= 1 && KEPT_ROWS.every(([name]) => promptsM.some((p) => p.includes(name))),
  promptsM.length,
);
check(
  'a scored match carries the funder\'s words and who applies',
  matchById(matchM.data, 'Example Mixed Words Grant')?.religious_eligibility_text === 'Catholic schools eligible; churches excluded' &&
    same(matchById(matchM.data, 'Example Mixed Words Grant')?.applicants, ['teacher', 'school']),
  matchById(matchM.data, 'Example Mixed Words Grant'),
);

// Re-uploading words replaces the old words, also when the new value is a bare code.
const reBook = await workbookBytes((wb) => {
  const sheet = wb.addWorksheet('Catholic School Grants');
  sheet.addRow(['Grant Name', 'Funder', 'Religious Eligibility']);
  sheet.addRow(['Example Mixed Words Grant', 'Example Mixed Words Grant Fund', 'eligible']);
  sheet.addRow(['Example Unreadable Words Grant', 'Example Unreadable Words Grant Fund', 'Religious organizations may not apply']);
});
const reUp = await upload(tokenM, reBook);
const grantsM2 = await grantsOf(tokenM);
check(
  're-upload: new words replace the old ones (a bare code clears them), value follows; other fields kept',
  reUp.status === 200 && reUp.data.updated === 2 && byName(grantsM2, 'Example Mixed Words Grant')?.religious_eligibility === 'eligible' &&
    (byName(grantsM2, 'Example Mixed Words Grant')?.religious_eligibility_text ?? null) === null &&
    byName(grantsM2, 'Example Unreadable Words Grant')?.religious_eligibility === 'excluded' &&
    byName(grantsM2, 'Example Unreadable Words Grant')?.religious_eligibility_text === 'Religious organizations may not apply' &&
    byName(grantsM2, 'Example Mixed Words Grant')?.deadline === plusDays(60),
  [byName(grantsM2, 'Example Mixed Words Grant'), byName(grantsM2, 'Example Unreadable Words Grant')?.religious_eligibility],
);

// ===========================================================================
// 7. The person's corrections to a starter grant survive "Update my grants"
// ===========================================================================

// --- unit: upsertGrants records what the person changed on starter grants only
const UNIT = 'user_unit_edits';
const seedA = { ...discovery.makeGrant(UNIT, 'seed', { grant_name: 'Example Starter A', funder: 'Fund A', deadline: '2027-01-01', typical_award: '$5,000', category: 'catholic_school' })!, id: 'grant_e1' };
const ownB = { ...discovery.makeGrant(UNIT, 'upload', { grant_name: 'Example Own B', funder: 'Fund B', deadline: '2027-01-01', category: 'catholic_school' })!, id: 'grant_e2' };
const uploaded = (data: Record<string, unknown>, provided: string[]) => ({
  grant: discovery.makeGrant(UNIT, 'upload', { category: 'catholic_school', ...data })!,
  provided: provided as Json,
});
const up1 = excel.upsertGrants([seedA, ownB], [
  uploaded({ grant_name: 'EXAMPLE starter a', funder: 'fund a', deadline: '2027-03-01', typical_award: '$5,000' }, ['grant_name', 'funder', 'category', 'deadline', 'typical_award']),
  uploaded({ grant_name: 'Example Own B', funder: 'Fund B', deadline: '2027-04-01' }, ['grant_name', 'funder', 'category', 'deadline']),
]);
const a1 = up1.merged.find((g) => g.id === 'grant_e1');
const b1 = up1.merged.find((g) => g.id === 'grant_e2');
check(
  'upsertGrants: a starter grant records only the fields whose value changed (not name/funder spelling, not an unchanged award or category)',
  up1.updated === 2 && a1?.deadline === '2027-03-01' && same(a1?.user_edited_fields, ['deadline']) && a1?.grant_name === 'EXAMPLE starter a',
  a1,
);
check("upsertGrants: the person's own grants never get user_edited_fields", b1?.deadline === '2027-04-01' && !('user_edited_fields' in (b1 ?? {})), b1);
const up2 = excel.upsertGrants(up1.merged, [uploaded({ grant_name: 'Example Starter A', funder: 'Fund A', typical_award: '$6,500' }, ['grant_name', 'funder', 'category', 'typical_award'])]);
check(
  'upsertGrants: a later correction adds to the list (union)',
  same(up2.merged.find((g) => g.id === 'grant_e1')?.user_edited_fields, ['deadline', 'typical_award']) && up2.merged.find((g) => g.id === 'grant_e1')?.typical_award === '$6,500',
  up2.merged.find((g) => g.id === 'grant_e1'),
);

// --- unit: refreshSeedGrants keeps those fields
const editedA = up2.merged.find((g) => g.id === 'grant_e1')!;
const incomingA = discovery.makeGrant(UNIT, 'seed', { grant_name: 'Example Starter A', funder: 'Fund A', deadline: '2027-02-01', typical_award: '$5,000', category: 'catholic_school', geography: 'Texas' })!;
const currentBefore = clone([editedA]);
const r1 = discovery.refreshSeedGrants([editedA], [incomingA], new Map(), new Set(), '2026-10-15');
const a2 = r1.merged.find((g) => g.id === 'grant_e1');
check(
  "refreshSeedGrants: the person's deadline and award are kept, the other starter details refresh (same id), the list stays",
  a2?.deadline === '2027-03-01' && a2?.typical_award === '$6,500' && a2?.geography === 'Texas' && a2?.grant_name === 'Example Starter A' &&
    same(a2?.user_edited_fields, ['deadline', 'typical_award']) && r1.outcome.kept_user_changes === 1 && r1.outcome.updated === 1 && same([editedA], currentBefore),
  { a2, outcome: r1.outcome },
);
const r2 = discovery.refreshSeedGrants(r1.merged, [incomingA], new Map(), new Set(), '2026-10-15');
check(
  'refreshSeedGrants: a second refresh changes nothing (duplicate, not "updated") but still keeps and reports the changes',
  r2.outcome.updated === 0 && r2.outcome.duplicates === 1 && r2.outcome.kept_user_changes === 1 && same(r2.merged, r1.merged),
  r2.outcome,
);
const caughtUp = discovery.makeGrant(UNIT, 'seed', { grant_name: 'Example Starter A', funder: 'Fund A', deadline: '2027-03-01', typical_award: '$6,500', category: 'catholic_school', geography: 'Texas' })!;
const r3 = discovery.refreshSeedGrants(r1.merged, [caughtUp], new Map(), new Set(), '2026-10-15');
check('refreshSeedGrants: when the starter database says the same as the person, nothing is reported as kept', r3.outcome.kept_user_changes === 0, r3.outcome);
const r4 = discovery.refreshSeedGrants(r1.merged, [], new Map(), new Set(), '2026-10-15');
const a4 = r4.merged.find((g) => g.id === 'grant_e1');
check(
  "refreshSeedGrants: a retired starter grant the person edited is kept (CLOSED, with the note), not deleted",
  r4.outcome.retired === 1 && a4?.status === 'CLOSED' && a4?.eligibility_notes?.startsWith("No longer in GrantFinder's starter database as of 2026-10-15") &&
    a4?.deadline === '2027-03-01' && r4.outcome.kept_user_changes === 1,
  { a4, outcome: r4.outcome },
);
const r5 = discovery.refreshSeedGrants(r4.merged, [], new Map(), new Set(), '2026-11-01');
check(
  'refreshSeedGrants: ...and a later load leaves it as it is (not retired or counted again)',
  r5.outcome.retired === 0 && r5.outcome.kept_user_changes === 0 && same(r5.merged, r4.merged),
  r5.outcome,
);
const reopened = { ...a4!, status: 'OPEN' as const, user_edited_fields: [...(a4?.user_edited_fields ?? []), 'status'] };
const r6 = discovery.refreshSeedGrants([reopened], [], new Map(), new Set(), '2026-11-01');
check('refreshSeedGrants: a retired grant the person reopened with their spreadsheet stays open (note once)', r6.merged[0]?.status === 'OPEN' && r6.outcome.retired === 0 && (r6.merged[0]?.eligibility_notes?.match(/No longer in GrantFinder/g) ?? []).length === 1, r6.merged[0]);
const plainSeed = { ...discovery.makeGrant(UNIT, 'seed', { grant_name: 'Example Unedited', funder: 'Fund U' })!, id: 'grant_e9' };
const r7 = discovery.refreshSeedGrants([plainSeed], [], new Map(), new Set(), '2026-10-15');
check('refreshSeedGrants: a retired starter grant nobody edited or uses is still removed', r7.merged.length === 0 && r7.outcome.retired === 1 && r7.outcome.kept_user_changes === 0, r7.outcome);

// --- route: load starter database, upload a correction, load again
const tokenO = await guest();
const userO = await me(tokenO);
const seedFoundations = (Array.isArray(seedFile.foundations) ? seedFile.foundations : []).filter((f: Json) => f && f.foundation_name);
const seed1 = await api('POST', '/api/discovery/seed', { token: tokenO });
check(
  'first starter load: notes are full sentences; only the foundations note ("Also added N foundations to monitor.")',
  seed1.status === 200 && same(seed1.data.notes, seedFoundations.length ? [`Also added ${seedFoundations.length} foundation${seedFoundations.length === 1 ? '' : 's'} to monitor.`] : []),
  seed1.data?.notes,
);
const SHEET_FOR: Record<string, string> = {
  church_parish: 'Parish Grants',
  catholic_school: 'Catholic School Grants',
  mixed: 'Mixed Church-School',
  non_catholic: 'Non-Catholic Qualifying',
};
const startersO = await grantsOf(tokenO);
const target = startersO.find((g) => g.grant_name === 'Kenedy Memorial Foundation Grants' && SHEET_FOR[g.category]) ?? startersO.find((g) => SHEET_FOR[g.category]);
const CORRECTED_DEADLINE = plusDays(61);
const CORRECTED_AWARD = '$4,321 (our own notes)';
const CORRECTED_WORDS = 'Catholic schools eligible (we called the funder)';
const correction = await workbookBytes((wb) => {
  const sheet = wb.addWorksheet(SHEET_FOR[target.category]);
  sheet.addRow(['Grant Name', 'Funder', 'Deadline', 'Typical Award', 'Religious Eligibility']);
  sheet.addRow([target.grant_name, target.funder, CORRECTED_DEADLINE, CORRECTED_AWARD, CORRECTED_WORDS]);
});
const upO = await upload(tokenO, correction);
let grantsO = await grantsOf(tokenO);
const correctedO = grantsO.find((g) => g.id === target.id);
check(
  'the correction updates the starter grant in place and records what the person changed',
  upO.status === 200 && upO.data.updated === 1 && upO.data.added === 0 && correctedO?.deadline === CORRECTED_DEADLINE && correctedO?.typical_award === CORRECTED_AWARD &&
    ['deadline', 'typical_award', 'religious_eligibility_text'].every((f) => correctedO?.user_edited_fields?.includes(f)) &&
    !['grant_name', 'funder', 'category', 'amount'].some((f) => correctedO?.user_edited_fields?.includes(f)),
  { data: upO.data, fields: correctedO?.user_edited_fields },
);
const seed2 = await api('POST', '/api/discovery/seed', { token: tokenO });
grantsO = await grantsOf(tokenO);
const afterO = grantsO.find((g) => g.id === target.id);
check(
  '"Update my grants" again: the correction survives (deadline, award, words), same id and created_at',
  seed2.status === 200 && afterO?.deadline === CORRECTED_DEADLINE && afterO?.typical_award === CORRECTED_AWARD && afterO?.religious_eligibility_text === CORRECTED_WORDS &&
    afterO?.created_at === target.created_at && grantsO.filter((g) => g.grant_name === target.grant_name).length === 1,
  afterO,
);
check(
  '...and the notes say so (and nothing is reported as updated, retired or added)',
  same(seed2.data.notes, ['Kept your own changes to 1 starter grant.']) && seed2.data.updated === 0 && seed2.data.retired === 0 && seed2.data.added === 0,
  seed2.data,
);
check(
  "...the starter grant's other details still come from the starter database",
  afterO?.amount === target.amount && afterO?.description === target.description && afterO?.url === target.url && same(afterO?.user_edited_fields, correctedO?.user_edited_fields),
  afterO,
);
// The starter record's other fields drift (as when the research updates them): a reload refreshes those, keeps the person's.
await repo.updateGrants(userO.id, (list) => list.map((g) => (g.id === target.id ? { ...g, amount: 'Example stale amount' } : g)));
const seed3 = await api('POST', '/api/discovery/seed', { token: tokenO });
const after3 = (await grantsOf(tokenO)).find((g) => g.id === target.id);
check(
  'a later reload refreshes the fields the person did not change and still keeps theirs (both notes)',
  after3?.amount === target.amount && after3?.deadline === CORRECTED_DEADLINE &&
    same(seed3.data.notes, ['Updated 1 starter grant with the latest deadlines and details.', 'Kept your own changes to 1 starter grant.']),
  { notes: seed3.data?.notes, amount: after3?.amount },
);

// ===========================================================================
// 8. Notes: seed sentences, web search counts, closed and past-deadline web grants
// ===========================================================================

const notes = discoveryRoutes.seedNotes;
check(
  'seed notes: full sentences ending with a period, singular and plural, never "Starter database"',
  same(notes({ updated: 1, retired: 1, retired_names: ['Example A'], kept_user_changes: 1 }, 1), [
    'Updated 1 starter grant with the latest deadlines and details.',
    'Kept your own changes to 1 starter grant.',
    'Retired 1 grant no longer offered or not open to Catholic schools: Example A.',
    'Also added 1 foundation to monitor.',
  ]) &&
    same(notes({ updated: 2, retired: 0, retired_names: [], kept_user_changes: 3 }, 8), [
      'Updated 2 starter grants with the latest deadlines and details.',
      'Kept your own changes to 3 starter grants.',
      'Also added 8 foundations to monitor.',
    ]),
  notes({ updated: 1, retired: 1, retired_names: ['Example A'], kept_user_changes: 1 }, 1),
);
check('seed notes: nothing happened -> no notes (no "0 foundations")', same(notes({ updated: 0, retired: 0, retired_names: [], kept_user_changes: 0 }, 0), []));
const sevenRetired = Array.from({ length: 7 }, (_, i) => `Example R${i + 1}`);
check(
  'seed notes: more than five retired names -> "and N more." (one sentence, one period)',
  notes({ updated: 0, retired: 7, retired_names: sevenRetired, kept_user_changes: 0 }, 0)[0] ===
    'Retired 7 grants no longer offered or not open to Catholic schools: Example R1; Example R2; Example R3; Example R4; Example R5; and 2 more.',
  notes({ updated: 0, retired: 7, retired_names: sevenRetired, kept_user_changes: 0 }, 0),
);
const tokenN = await guest();
await api('POST', '/api/discovery/seed', { token: tokenN });
const seedAgain = await api('POST', '/api/discovery/seed', { token: tokenN });
check('second starter load of an unchanged database: no notes (no "0 foundations")', seedAgain.status === 200 && same(seedAgain.data.notes, []), seedAgain.data?.notes);

const keep = discoveryJobs.keepOpenEligible;
const g = (data: Record<string, unknown>) => discovery.makeGrant('u', 'web_discovery', { grant_name: `Example ${JSON.stringify(data)}`, ...data })!;
const kept = keep([
  g({ deadline: plusDays(10) }),
  g({ deadline: 'Annual: January 5' }),
  g({ deadline: 'Rolling', status: 'OPEN' }),
  g({ deadline: plusDays(10), status: 'CLOSED' }),
  g({ deadline: plusDays(-1) }),
  g({ deadline: `${plusDays(-1)} 17:00` }),
  g({ deadline: plusDays(10), religious_eligibility: 'excluded' }),
], today);
check('keepOpenEligible: drops excluded, CLOSED and past-deadline grants (an "Annual:" deadline never passes)', kept.grants.length === 3 && kept.excluded === 1 && kept.closed === 3, { kept: kept.grants.length, excluded: kept.excluded, closed: kept.closed });

const tokenW = await guest();
await saveKey(tokenW);
await mock.reset();
await mock.fixtures({
  web_discovery_v1: {
    text: JSON.stringify([
      { grant_name: 'Example Web Open Grant', funder: 'Example Web Fund 1', deadline: plusDays(50), status: 'OPEN', religious_eligibility: 'eligible', url: 'https://example.org/w1' },
      { grant_name: 'Example Web Annual Grant', funder: 'Example Web Fund 2', deadline: 'Annual: January 5', url: 'https://example.org/w2' },
      {
        grant_name: 'Example Web Words Grant', funder: 'Example Web Fund 3', deadline: 'Rolling', religious_eligibility: 'eligible',
        religious_eligibility_text: 'Faith-based schools welcome', applicants: ['school', 'teacher'], amount: 7500, url: 'https://example.org/w3',
      },
      { grant_name: 'Example Web Closed Grant', funder: 'Example Web Fund 4', deadline: plusDays(50), status: 'CLOSED', url: 'https://example.org/w4' },
      { grant_name: 'Example Web Past Grant', funder: 'Example Web Fund 5', deadline: plusDays(-10), url: 'https://example.org/w5' },
      { grant_name: 'Example Web Past Timed Grant', funder: 'Example Web Fund 6', deadline: `${plusDays(-3)}T17:00:00Z`, url: 'https://example.org/w6' },
      { grant_name: 'Example Web Public Only Grant', funder: 'Example Web Fund 7', deadline: plusDays(50), religious_eligibility: 'Public schools only', url: 'https://example.org/w7' },
    ]),
    web_searches: 1,
  },
});
const web1 = await call('POST', '/api/discovery/web-search', { token: tokenW, json: {} });
check(
  'web discovery: closed and past-deadline grants are skipped; the notes count them; "Ran 1 web search"; "AI verified" counts only saved ones',
  web1.status === 200 && web1.data.found === 3 && web1.data.added === 3 &&
    same(web1.data.notes, [
      'Ran 1 web search',
      "Skipped 1 grant that doesn't fund religious organizations",
      'Skipped 3 closed or past-deadline grants',
      'AI verified 3 opportunities',
    ]),
  web1.data,
);
const grantsW = await grantsOf(tokenW);
check(
  'web discovery: only the open grants are saved',
  same(grantsW.map((x) => x.grant_name).sort(), ['Example Web Annual Grant', 'Example Web Open Grant', 'Example Web Words Grant']),
  grantsW.map((x) => x.grant_name),
);
const wordsW = byName(grantsW, 'Example Web Words Grant');
check(
  "web discovery: the funder's words, who applies and the amount as money are saved",
  wordsW?.religious_eligibility === 'eligible' && wordsW?.religious_eligibility_text === 'Faith-based schools welcome' && same(wordsW?.applicants, ['school', 'teacher']) && wordsW?.amount === '$7,500',
  wordsW,
);
const webPrompt = (await mock.requests()).find((r) => r.prompt_id === 'web_discovery_v1')?.prompt ?? '';
check('web discovery prompt asks for the funder\'s own words and who applies', webPrompt.includes('"religious_eligibility_text"') && webPrompt.includes('"applicants": ["who submits the application: school | parish | diocese | teacher | family | nonprofit"]'), webPrompt.slice(-1400));
await mock.fixtures({
  web_discovery_v1: {
    text: JSON.stringify([
      { grant_name: 'Example Web Second Open Grant', funder: 'Example Web Fund 8', deadline: plusDays(20), url: 'https://example.org/w8' },
      { grant_name: 'Example Web Second Closed Grant', funder: 'Example Web Fund 9', status: 'Closed for 2026', url: 'https://example.org/w9' },
    ]),
    web_searches: 2,
  },
});
const web2 = await call('POST', '/api/discovery/web-search', { token: tokenW, json: {} });
check(
  'web discovery: singular notes ("1 closed or past-deadline grant", "1 opportunity"), plural searches',
  web2.status === 200 && same(web2.data.notes, ['Ran 2 web searches', 'Skipped 1 closed or past-deadline grant', 'AI verified 1 opportunity']) && web2.data.found === 1,
  web2.data,
);

mock.stop();
finish();
