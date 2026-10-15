/**
 * Mock Claude answers for the browser journey (fictional organization only).
 *
 * They are sent to the mock at runtime (POST /__fixtures) instead of living in
 * tests/mock-claude/fixtures/, so they never change what the engine tests see.
 * Answers that depend on ids the engine generates (grant ids for scoring, gap
 * ids for stakeholder routing) are built from the live data, the way real
 * Claude would echo the ids it was given.
 */

const ORG = {
  name: 'St. Testwell Catholic Parish and School',
  city: 'Exampleville',
  state: 'TX',
  diocese: 'Diocese of Example',
};

const MARKERS = {
  strategy: 'RECOMMENDED-STRATEGY-MARKER',
  draft: 'DRAFT-MARKER',
  enforced: 'ENFORCED-MARKER',
  refined: 'REFINED-MARKER',
  topFix: 'TOP-FIX-MARKER',
  voice: 'VOICE-MARKER',
  emailFinance: 'EMAIL-PACKET-FINANCE',
  emailPrincipal: 'EMAIL-PACKET-PRINCIPAL',
};

const QUESTIONS = [
  { id: 1, question: 'Is your organization a registered 501(c)(3) nonprofit or listed in the Official Catholic Directory?', question_type: 'boolean', required: true, grant_relevance: ['All grants'] },
  { id: 2, question: 'What type of organization are you?', question_type: 'select', options: ['Parish only', 'School only', 'Parish with school'], required: true, grant_relevance: ['All grants'] },
  { id: 3, question: 'Which needs are most urgent for you right now?', question_type: 'multiselect', options: ['Facility repairs', 'Security', 'Technology', 'Tuition assistance', 'Food pantry'], required: false, grant_relevance: ['Facility grants', 'Security grants'] },
  { id: 4, question: 'Do you operate a food pantry or food assistance program?', question_type: 'boolean', required: true, grant_relevance: ['Hunger relief grants'] },
  { id: 5, question: 'Which grants has your organization received in the past 3 years?', question_type: 'text', required: false, grant_relevance: ['All grants'] },
  { id: 6, question: 'What is your approximate annual operating budget?', question_type: 'select', options: ['Under $250,000', '$250,000-$500,000', '$500,000-$1M', 'Over $1M'], required: true, grant_relevance: ['Capacity-based grants'] },
];

const SECTIONS = [
  { id: 's1', title: 'Organization Background', prompt: 'Describe your organization, its history, and the community it serves.', word_limit: 300, char_limit: null, notes: '' },
  { id: 's2', title: 'Statement of Need', prompt: 'What need will this grant address? Use specific facts.', word_limit: 400, char_limit: null, notes: '' },
  { id: 's3', title: 'Project Description', prompt: 'Describe the project, the timeline, and who will lead it.', word_limit: 500, char_limit: null, notes: '' },
  { id: 's4', title: 'Portal Summary', prompt: 'A short summary for the online application portal.', word_limit: null, char_limit: 1000, notes: '' },
];

const RUBRIC = [
  { id: 'c1', name: 'Alignment with Catholic mission in Texas', description: 'Catholic identity and service in Texas', weight: 30 },
  { id: 'c2', name: 'Demonstrated need', description: 'Specific, documented need', weight: 30 },
  { id: 'c3', name: 'Project feasibility', description: 'A clear plan and a named lead', weight: 25 },
  { id: 'c4', name: 'Sustainability', description: 'How the work continues after the grant', weight: 15 },
];

const GAPS = [
  { key: 'letters', criterion_ref: 'c3', description: 'Letters of support from community partners', severity: 'high', suggested_owner_role: 'Development' },
  { key: 'budget', criterion_ref: 'c3', description: 'Current-year operating budget and most recent financial statements', severity: 'high', suggested_owner_role: 'Finance' },
  { key: 'lead', criterion_ref: 'c3', description: 'Name and qualifications of the project lead', severity: 'high', suggested_owner_role: 'Principal' },
  { key: 'assistance', criterion_ref: 'c2', description: 'Number of students receiving tuition assistance this year', severity: 'medium', suggested_owner_role: 'Finance' },
];

const DRAFT_TEXT = `${MARKERS.draft} ${ORG.name} has served families on the east side of ${ORG.city}, Texas since 1952. `
  + 'Our school serves 240 students in grades PK-8, and our food pantry serves 300 families a month. '
  + 'We are thrilled to share how this project would let us repair the gym roof and replace playground equipment that is 30 years old.';

const ENFORCED_TEXT = `${MARKERS.enforced} ${ORG.name} has served families on the east side of ${ORG.city}, Texas since 1952. `
  + 'Our school serves 240 students in grades PK-8, and our food pantry serves 300 families a month. '
  + 'This project would let us repair the gym roof and replace playground equipment that is 30 years old.';

const REFINED_TEXT = `${MARKERS.refined} Since 1952, ${ORG.name} has served the east side of ${ORG.city}, Texas. `
  + 'Today 240 students in grades PK-8 learn here and 300 families a month rely on our food pantry. '
  + 'A new gym roof and safe playground equipment would protect both.';

/** Static answers for every prompt the browser journey triggers. */
function journeyFixtures() {
  return {
    website_scan_v1: JSON.stringify({
      organization_basics: { name: ORG.name, city: ORG.city, state: ORG.state, diocese: ORG.diocese, address: '100 Example Avenue, Exampleville, TX' },
      leadership: { pastor: '[Pastor Name]', principal: '[Principal Name]', staff: [] },
      school_info: { name: 'St. Testwell Catholic School', grades: 'PK-8', student_count: 240, accreditation: 'Regional Catholic accreditation' },
      facilities: ['Parish hall (built 1961)', 'School building', 'Gym', 'Playground'],
      current_initiatives: ['Food pantry serving 300 families a month', 'Capital campaign for the school roof and playground'],
    }),
    questionnaire_v1: JSON.stringify(QUESTIONS),
    document_signals_v1: JSON.stringify({
      facility_needs: ['Gym roof leaks over the bleachers', 'Parish hall HVAC failed twice this fall'],
      program_needs: ['Tuition assistance for families who cannot afford Catholic school'],
      security_concerns: ['Two break-ins at the school; parish council approved a security review'],
      other_signals: ['Capital campaign underway for roof and playground'],
    }),
    // Real scores need real grant ids; matchFixture() replaces this once the grants exist.
    grant_match_batch_v1: '[]',
    grant_spec_v1: JSON.stringify({
      required_sections: SECTIONS,
      format_constraints: ['Submit through the online grant portal', 'Attach proof of Catholic affiliation'],
      deliverables: ['Project budget', 'Most recent financial statements', 'Letter from the pastor'],
      rubric: RUBRIC,
      rubric_source: 'explicit',
      funder_language_cues: ['Catholic mission', 'the poor and vulnerable', 'Texas communities'],
      funder_priorities: ['Catholic education in Texas', 'Serving the poor'],
    }),
    fit_gap_v1: JSON.stringify({
      fit_map: [
        { criterion_id: 'c1', criterion_name: RUBRIC[0].name, rating: 'strong', evidence: ['Parish and school in Exampleville, TX (Diocese of Example)'], missing: null },
        { criterion_id: 'c2', criterion_name: RUBRIC[1].name, rating: 'partial', evidence: ['Playground equipment is 30 years old', 'Gym roof leaks over the bleachers'], missing: 'Enrollment and tuition assistance numbers' },
        { criterion_id: 'c3', criterion_name: RUBRIC[2].name, rating: 'weak', evidence: [], missing: 'A project budget and a named project lead' },
        { criterion_id: 'c4', criterion_name: RUBRIC[3].name, rating: 'missing', evidence: [], missing: 'A plan for ongoing maintenance' },
      ],
      strength_leads: [RUBRIC[0].name, RUBRIC[1].name],
      honesty_ledger: ['No audited financial statements yet', 'No dedicated development staff'],
      recommended_strategy: `${MARKERS.strategy} Lead with 70 years of Catholic service in Exampleville and the documented facility needs. Name the missing audit honestly and show the plan to get one.`,
      gaps: GAPS.map(({ key, ...gap }) => gap),
    }),
    // Real routing needs real gap ids; intakeFixture() replaces this once the gaps exist.
    intake_packets_v1: JSON.stringify([
      { stakeholder_role: 'Finance', gap_ids: [], framing: 'We need budget numbers for the application.', questions: ['What is this year\'s operating budget?'], expected_format: 'A number and a date', suggested_deadline: null, email_packet: `${MARKERS.emailFinance} Hi, could you send this year's operating budget? If we don't have this, just say so - that's a useful answer too.` },
    ]),
    voice_profile_v1: JSON.stringify({
      style_guidelines: `${MARKERS.voice} Warm, plain, and specific. Short sentences. Names the families and children served instead of abstractions.`,
      banned_phrases: ['synergy', 'impactful'],
      signature_moves: ['Opens with a concrete scene', 'Ends with a simple invitation'],
    }),
    // The draft contains "We are thrilled" (a banned AI tell) so the Enforce stage runs.
    section_draft_v1: JSON.stringify({
      draft: DRAFT_TEXT,
      claims: [
        { claim: 'Serves 240 students in grades PK-8', criterion_ref: 'c2', evidence_ref: 'School website: 240 students' },
        { claim: 'Food pantry serves 300 families a month', criterion_ref: 'c1', evidence_ref: 'Ministries page' },
        { claim: 'Enrollment grew 12 percent in three years', criterion_ref: 'c2', evidence_ref: null },
      ],
    }),
    voice_enforce_v1: JSON.stringify({ draft: ENFORCED_TEXT }),
    section_refine_v1: JSON.stringify({ draft: REFINED_TEXT }),
    self_score_v1: JSON.stringify({
      per_criterion: RUBRIC.map((c, i) => ({ criterion_id: c.id, criterion_name: c.name, score: [88, 74, 61, 55][i], weight: c.weight, commentary: `Commentary for ${c.name}.` })),
      overall_score: 72,
      top_fix: `${MARKERS.topFix} Add a named project lead and a simple budget table to the Project Description.`,
      ranked_fixes: ['Name the project lead', 'Add the budget table', 'Quote one family'],
    }),
  };
}

/** Score answers keyed by the real grant ids (unknown ids are ignored by the engine). */
const SCORES = [
  { match: /^Kenedy Memorial Foundation/i, score: 92 },
  { match: /^FEMA Nonprofit Security/i, score: 81 },
  { match: /^KABOOM/i, score: 76 },
  { match: /^Catholic Extension/i, score: 64 },
  { match: /^Meadows Foundation/i, score: 58 },
];

function scoreFor(grantName) {
  const hit = SCORES.find((s) => s.match.test(grantName || ''));
  return hit ? hit.score : 35;
}

/**
 * One score per grant, keyed by the real grant id. Foundations join matching
 * as "<name> (Foundation)" pseudo-grants whose ids the test can't know, so
 * those are keyed by name (the engine matches by id, then by name).
 */
function matchFixture(grants, foundations = []) {
  const entry = (key, name) => {
    const score = scoreFor(name);
    return {
      grant_id: key,
      grant_name: name,
      score,
      score_breakdown: { eligibility_fit: score, need_alignment: score, capacity_signals: 70, timing: 80, completeness: 60 },
      explanation: `E2E score for ${name}.`,
      evidence: ['Parish and school in Exampleville, TX'],
    };
  };
  return JSON.stringify([
    ...grants.map((grant) => entry(grant.id, grant.grant_name)),
    ...foundations.map((f) => entry(`${f.foundation_name} (Foundation)`, `${f.foundation_name} (Foundation)`)),
  ]);
}

/**
 * Route open gaps: Finance gets the budget + tuition-assistance gaps, the
 * Principal gets the project-lead gap. Gaps are recognized by description.
 */
function intakeFixture(gaps) {
  const idsFor = (...keys) => gaps
    .filter((gap) => keys.some((key) => GAPS.find((g) => g.key === key && g.description === gap.description)))
    .map((gap) => gap.id);
  return JSON.stringify([
    {
      stakeholder_role: 'Finance',
      gap_ids: idsFor('budget', 'assistance'),
      framing: 'The funder asks for current budget numbers and how many families get tuition help.',
      questions: ["What is this year's operating budget?", 'How many students receive tuition assistance this year?'],
      expected_format: 'Two numbers and the date of the latest financial statements',
      suggested_deadline: null,
      email_packet: `${MARKERS.emailFinance} Hi, for our grant application could you send this year's operating budget and the number of students on tuition assistance? If we don't have this, just say so - that's a useful answer too.`,
    },
    {
      stakeholder_role: 'Principal',
      gap_ids: idsFor('lead'),
      framing: 'The funder wants to know who will lead the project.',
      questions: ['Who will lead the playground and roof project, and what is their experience?'],
      expected_format: 'A few sentences is fine',
      suggested_deadline: null,
      email_packet: `${MARKERS.emailPrincipal} Hi, who would lead this project? A few sentences is fine. If we don't have this, just say so - that's a useful answer too.`,
    },
  ]);
}

module.exports = {
  ORG, MARKERS, QUESTIONS, SECTIONS, RUBRIC, GAPS,
  DRAFT_TEXT, ENFORCED_TEXT, REFINED_TEXT,
  journeyFixtures, matchFixture, intakeFixture, scoreFor,
};
