/**
 * Data models for the GrantFinder engine.
 *
 * A TypeScript port of backend/models/schemas.py and writer_schemas.py.
 * Field names stay snake_case so the JSON the website already reads is
 * unchanged. Dates are ISO-8601 strings.
 */

// =============================================================================
// Enums (string unions)
// =============================================================================

/** 5-category grant database structure (spec v2.6). */
export type GrantCategory = 'church_parish' | 'catholic_school' | 'mixed' | 'non_catholic' | 'foundations';
export const GRANT_CATEGORIES: GrantCategory[] = ['church_parish', 'catholic_school', 'mixed', 'non_catholic', 'foundations'];

export type GrantStatus = 'OPEN' | 'Rolling' | 'Check deadline' | 'CLOSED';
export const GRANT_STATUSES: GrantStatus[] = ['OPEN', 'Rolling', 'Check deadline', 'CLOSED'];

export type GeoQualified = 'Yes' | 'No' | 'Yes - TX Only' | 'Check eligibility';
export const GEO_QUALIFIED_VALUES: GeoQualified[] = ['Yes', 'No', 'Yes - TX Only', 'Check eligibility'];

/**
 * Whether a Catholic school or parish may apply. eligible: yes; secular_purpose_only: may apply,
 * but the money can't pay for religious activity; excluded: the funder doesn't fund religious
 * organizations (matching rules it out); unclear: not stated, check before applying.
 */
export type ReligiousEligibility = 'eligible' | 'secular_purpose_only' | 'excluded' | 'unclear';
export const RELIGIOUS_ELIGIBILITY_VALUES: ReligiousEligibility[] = ['eligible', 'secular_purpose_only', 'excluded', 'unclear'];

/** excellent 85-100, good 70-84, possible 50-69, weak 25-49, not_eligible 0-24 */
export type MatchScoreTier = 'excellent' | 'good' | 'possible' | 'weak' | 'not_eligible';

export type DiscoverySource = 'seed' | 'grants_gov' | 'web_discovery';

// =============================================================================
// Users
// =============================================================================

export interface User {
  id: string;
  google_id: string;
  email: string;
  name?: string | null;
  picture?: string | null;
  created_at: string;
  claude_api_key_set: boolean;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'bearer';
  user: User;
}

// =============================================================================
// Grants and foundations
// =============================================================================

export interface GrantBase {
  grant_name: string;
  deadline: string;
  amount: string;
  funder: string;
  description: string;
  contact: string;
  url: string;
  status: GrantStatus;
  geo_qualified: GeoQualified;
  funder_stats?: string | null;
  category: GrantCategory;
  /** upload | seed | grants_gov | web_discovery */
  source: string;
  eligibility_notes?: string | null;
  funds_for: string[];
  /** Every cycle, letter-of-inquiry step or invitation rule behind `deadline`. */
  deadline_notes?: string | null;
  /** Where applicants must be: "National", "Texas", "Central Texas (Travis, Williamson, Hays counties)". */
  geography?: string | null;
  religious_eligibility?: ReligiousEligibility | null;
  /** The funder's current priorities for this program, in its own words where possible. */
  focus_areas?: string[];
  /** Typical or median award, when the funder publishes it. */
  typical_award?: string | null;
  /** YYYY-MM-DD the record was last checked against the funder's own site. */
  last_verified?: string | null;
  /** verified: every field confirmed; partial: some fields could not be confirmed (see the notes). */
  confidence?: 'verified' | 'partial' | null;
  /** Pages the record was checked against. */
  sources?: string[];
  /** What the funder has actually funded, at what levels, and what it has announced (grant research). */
  funder_intel?: FunderIntel | null;
}

/** One real past award, the recipient described by type and city (never by name). */
export interface PastAward {
  year: number | null;
  amount: string;
  recipient: string;
  purpose: string;
}

/** A funder's track record and outlook, gathered by the grant research from its filings, grant lists and announcements. */
export interface FunderIntel {
  /** False for entitlement or formula programs with no discretionary awards (then only `note`). */
  applicable: boolean;
  note?: string | null;
  past_awards: PastAward[];
  /** Typical award levels with the year they describe. */
  award_levels?: string | null;
  /** What it has funded in practice (can differ from its stated priorities). */
  funded_focus: string[];
  catholic_school_track_record?: string | null;
  giving_trend?: string | null;
  /** Announced changes: final round, new focus, bigger or smaller awards. */
  outlook?: string | null;
  as_of?: string | null;
  sources: string[];
}

/** The grant details a match carries so the results can show them (all optional: older results lack them). */
export type GrantDetails = Pick<
  GrantBase,
  | 'eligibility_notes'
  | 'deadline_notes'
  | 'geography'
  | 'religious_eligibility'
  | 'focus_areas'
  | 'typical_award'
  | 'last_verified'
  | 'confidence'
  | 'funder_intel'
>;

export interface Grant extends GrantBase {
  id: string;
  user_id: string;
  created_at: string;
}

export interface FoundationBase {
  foundation_name: string;
  application_cycle: string;
  focus_areas: string;
  location: string;
  contact: string;
  website: string;
  annual_giving: string;
  notes?: string | null;
}

export interface Foundation extends FoundationBase {
  id: string;
  user_id: string;
  created_at: string;
}

export interface GrantDatabaseUpload {
  total_grants: number;
  categories: Record<string, number>;
  foundations_count: number;
  upload_id: string;
}

// =============================================================================
// Organization profile (shared by matching and the writer)
// =============================================================================

export interface OrganizationProfile {
  id?: string | null;
  user_id: string;

  organization_name: string;
  /** "parish" | "school" | "both" */
  organization_type: string;
  diocese?: string | null;
  city: string;
  state: string;
  zip_code?: string | null;

  website_url?: string | null;
  school_website_url?: string | null;
  pastor_name?: string | null;
  principal_name?: string | null;
  staff_count?: number | null;
  student_count?: number | null;
  parish_size?: string | null;

  facility_needs: string[];
  program_needs: string[];
  security_concerns: string[];
  current_initiatives: string[];

  is_501c3: boolean;
  has_school: boolean;
  has_food_pantry: boolean;
  has_outreach_programs: boolean;
  annual_budget?: string | null;
  previous_grants: string[];
  questionnaire_answers: Array<Record<string, unknown>>;

  free_form_notes?: string | null;

  // Writer extension (GrantWriter PRD 4.1): one profile powers matching and drafting.
  voice_profile?: Record<string, unknown> | null;
  evidence: Array<Record<string, unknown>>;
  team_members: Array<Record<string, unknown>>;
  collaborations: Array<Record<string, unknown>>;
  validators: Array<Record<string, unknown>>;
  in_kind_resources: Array<Record<string, unknown>>;
  prior_grants_detail: Array<Record<string, unknown>>;
  financial_capacity?: string | null;

  sources: string[];
  confidence_score: number;
  last_updated?: string | null;
}

/** Fill every list/boolean default the Python model had, so partial objects are safe. */
export function normalizeProfile(input: Partial<OrganizationProfile> & { user_id: string }): OrganizationProfile {
  const list = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
  return {
    id: input.id ?? null,
    user_id: input.user_id,
    organization_name: input.organization_name ?? '',
    organization_type: input.organization_type ?? 'parish',
    diocese: input.diocese ?? null,
    city: input.city ?? '',
    state: input.state ?? '',
    zip_code: input.zip_code ?? null,
    website_url: input.website_url ?? null,
    school_website_url: input.school_website_url ?? null,
    pastor_name: input.pastor_name ?? null,
    principal_name: input.principal_name ?? null,
    staff_count: input.staff_count ?? null,
    student_count: input.student_count ?? null,
    parish_size: input.parish_size ?? null,
    facility_needs: list(input.facility_needs),
    program_needs: list(input.program_needs),
    security_concerns: list(input.security_concerns),
    current_initiatives: list(input.current_initiatives),
    is_501c3: input.is_501c3 ?? true,
    has_school: input.has_school ?? false,
    has_food_pantry: input.has_food_pantry ?? false,
    has_outreach_programs: input.has_outreach_programs ?? false,
    annual_budget: input.annual_budget ?? null,
    previous_grants: list(input.previous_grants),
    questionnaire_answers: list(input.questionnaire_answers),
    free_form_notes: input.free_form_notes ?? null,
    voice_profile: input.voice_profile ?? null,
    evidence: list(input.evidence),
    team_members: list(input.team_members),
    collaborations: list(input.collaborations),
    validators: list(input.validators),
    in_kind_resources: list(input.in_kind_resources),
    prior_grants_detail: list(input.prior_grants_detail),
    financial_capacity: input.financial_capacity ?? null,
    sources: list(input.sources),
    confidence_score: typeof input.confidence_score === 'number' ? input.confidence_score : 0,
    last_updated: input.last_updated ?? null,
  };
}

// =============================================================================
// Matching
// =============================================================================

export interface MatchScoreBreakdown {
  eligibility_fit: number; // 40% weight
  need_alignment: number; // 30%
  capacity_signals: number; // 15%
  timing: number; // 10%
  completeness: number; // 5%
}

export interface GrantMatch extends GrantDetails {
  grant_id: string;
  grant_name: string;
  funder: string;
  amount: string;
  deadline: string;
  url: string;
  contact: string;
  category: GrantCategory;
  geo_qualified: GeoQualified;
  score: number;
  score_tier: MatchScoreTier;
  score_breakdown: MatchScoreBreakdown;
  explanation: string;
  evidence: string[];
  is_shortlisted: boolean;
}

export interface MatchResults {
  session_id: string;
  user_id: string;
  profile_id: string;
  total_grants_evaluated: number;
  matches: GrantMatch[];
  excellent_matches: number;
  good_matches: number;
  possible_matches: number;
  weak_matches: number;
  not_eligible: number;
  created_at: string;
  expires_at: string;
}

// =============================================================================
// AI processing
// =============================================================================

export interface WebsiteScanResult {
  organization_basics: Record<string, unknown>;
  leadership: Record<string, unknown>;
  school_info: Record<string, unknown> | null;
  facilities: string[];
  current_initiatives: string[];
  extracted_text_length: number;
}

export interface QuestionnaireQuestion {
  id: number;
  question: string;
  /** "text" | "boolean" | "select" | "multiselect" */
  question_type: string;
  options?: string[] | null;
  required: boolean;
  grant_relevance: string[];
}

export interface Questionnaire {
  questions: QuestionnaireQuestion[];
  total_questions: number;
}

export interface QuestionnaireAnswer {
  question_id: number;
  answer: unknown;
  /** The question text the person saw, when the website sends it (wins over the id lookup). */
  question?: string | null;
}

export interface DocumentExtractionResult {
  document_id: string;
  filename: string;
  extracted_text_length: number;
  facility_needs: string[];
  program_needs: string[];
  security_concerns: string[];
  other_signals: string[];
  /** Citable facts stated in the document (at most 15); also saved as profile evidence for the writer. */
  key_facts?: string[];
}

export interface DiscoveryResult {
  source: DiscoverySource;
  found: number;
  added: number;
  duplicates: number;
  total_grants: number;
  notes: string[];
  /** Starter database only: records refreshed in place, and records retired (no longer offered). */
  updated?: number;
  retired?: number;
}

// =============================================================================
// GrantWriter
// =============================================================================

export type ApplicationStatus = 'analysis' | 'intake' | 'drafting' | 'review' | 'export';

export interface Application {
  id: string;
  user_id: string;
  grant_id: string;
  grant_name: string;
  funder: string;
  status: ApplicationStatus;
  strategy?: string | null;
  strategy_confirmed: boolean;
  deadline?: string | null;
  urgent: boolean;
  correlation_id: string;
  created_at: string;
  updated_at: string;
}

export interface RubricCriterion {
  id: string;
  name: string;
  description: string;
  weight?: number | null;
}

export interface RequiredSection {
  id: string;
  title: string;
  prompt: string;
  word_limit?: number | null;
  char_limit?: number | null;
  notes: string;
}

export interface GrantSpec {
  grant_id: string;
  required_sections: RequiredSection[];
  format_constraints: string[];
  deliverables: string[];
  rubric: RubricCriterion[];
  /** "explicit" | "inferred" */
  rubric_source: string;
  funder_language_cues: string[];
  funder_priorities: string[];
  guidelines_text?: string | null;
  enriched_at?: string | null;
}

export interface FitEntry {
  criterion_id: string;
  criterion_name: string;
  /** "strong" | "partial" | "weak" | "missing" */
  rating: string;
  evidence: string[];
  missing?: string | null;
}

export type GapStatus = 'open' | 'routed' | 'answered' | 'confirmed_gap' | 'waived';

export interface Gap {
  id: string;
  application_id: string;
  criterion_ref: string;
  description: string;
  /** "high" blocks drafting until resolved or waived */
  severity: string;
  suggested_owner_role: string;
  status: GapStatus;
  answer?: string | null;
}

export interface FitAnalysis {
  application_id: string;
  fit_map: FitEntry[];
  strength_leads: string[];
  honesty_ledger: string[];
  recommended_strategy: string;
  generated_at: string;
}

export interface IntakeRequest {
  id: string;
  application_id: string;
  stakeholder_role: string;
  gap_ids: string[];
  framing: string;
  questions: string[];
  expected_format: string;
  suggested_deadline?: string | null;
  email_packet: string;
  /** draft | sent | answered | confirmed_gap */
  status: string;
  response?: string | null;
}

export interface ClaimFlag {
  claim: string;
  criterion_ref?: string | null;
  evidence_ref?: string | null;
  flagged: boolean;
  reason?: string | null;
}

export interface SectionDraft {
  id: string;
  application_id: string;
  section_id: string;
  title: string;
  current_draft: string;
  versions: string[];
  claims: ClaimFlag[];
  word_count: number;
  char_count: number;
  over_limit: boolean;
  banned_phrase_hits: string[];
  compliance_notes: string[];
}

export interface CriterionScore {
  criterion_id: string;
  criterion_name: string;
  score: number;
  weight?: number | null;
  commentary: string;
}

export interface Scorecard {
  application_id: string;
  per_criterion: CriterionScore[];
  overall_score: number;
  top_fix: string;
  ranked_fixes: string[];
  compliance_results: Array<Record<string, unknown>>;
  generated_at: string;
}

export type WriterExportFormat = 'docx' | 'md' | 'txt' | 'form_map';

// =============================================================================
// Funder history (what a grantor has actually funded; one record per grant)
// =============================================================================

export interface FunderPriority {
  priority: string;
  /** Where the material shows it. */
  evidence: string;
}

export interface FunderGivingPatterns {
  typical_range: string;
  median_award: string | null;
  grants_per_year: string | null;
  geography: string;
  recipient_types: string[];
}

/** A grant the material says this funder made. Never invented: entries without a recipient are dropped. */
export interface ComparableGrant {
  /** As written in the source material. */
  recipient: string;
  year: string | null;
  amount: string | null;
  purpose: string;
  why_comparable: string;
  /** The recipient appears word for word in the material (otherwise shown flagged and left out of drafting). */
  verified: boolean;
}

export interface AskRecommendation {
  range: string;
  /** Cites the comparable grants. */
  rationale: string;
}

/** Built by funder_profile_v1 from pasted notes, uploaded files, web research and the grant record. */
export interface FunderProfile {
  summary: string;
  priorities: FunderPriority[];
  giving_patterns: FunderGivingPatterns;
  comparable_grants: ComparableGrant[];
  exclusions: string[];
  process_requirements: string[];
  ask_recommendation: AskRecommendation | null;
  language_cues: string[];
  /** Concrete recommendations for framing this application to match the funder's history. */
  positioning: string[];
  /** What the material doesn't show. */
  unknowns: string[];
  /** "pasted notes", file names, URLs. */
  sources: string[];
  generated_at: string;
}

export interface FunderSourceFile {
  name: string;
  chars: number;
  /** The file's text (kept for rebuilding; never sent back to the website). */
  text: string;
  added_at: string;
}

/** Stored per user per grant at writer/{user}/funder/{grant_id}, reused by any application to that grant. */
export interface FunderRecord {
  grant_id: string;
  /** What the person pasted (capped). */
  notes_text: string;
  source_files: FunderSourceFile[];
  /** Web research findings with source URLs (funder_research_v1). */
  research_notes: string;
  research_sources: string[];
  researched_at: string | null;
  profile: FunderProfile | null;
  /** When the notes, files or research last changed (a profile built before this is out of date). */
  material_updated_at: string | null;
  updated_at: string;
}

/** What the website gets (GET application state `funder_profile`): the record without the big texts. */
export interface FunderRecordView {
  grant_id: string;
  notes_text: string;
  source_files: Array<{ name: string; chars: number; added_at: string }>;
  /** Length of the saved web research findings. */
  research_chars: number;
  research_sources: string[];
  researched_at: string | null;
  profile: FunderProfile | null;
  /** The notes, files or research changed after the profile was built. */
  profile_outdated: boolean;
  material_updated_at: string | null;
  updated_at: string;
}

/** One logged Claude call (PRD Section 8). */
export interface AICallLog {
  correlation_id: string;
  application_id?: string | null;
  job_id?: string | null;
  /** extract | map | route | draft | score | refine | enforce | scan | questionnaire | documents | match | discovery */
  stage: string;
  prompt_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  web_searches: number;
  latency_ms: number;
  cost_estimate_usd: number;
  /** ok | error */
  status: string;
  stop_reason?: string | null;
  error?: string | null;
  timestamp: string;
}
