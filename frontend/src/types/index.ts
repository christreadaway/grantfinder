export interface User {
  id: number
  email: string
  name: string
  avatar_url?: string
  has_api_key: boolean
  created_at: string
}

export interface Organization {
  id: number
  name: string
  church_website?: string
  school_website?: string
  website_extracted?: Record<string, any>
  questionnaire_answers?: Record<string, any>
  free_form_notes?: string
  extracted_needs?: ExtractedNeed[]
  profile_json?: OrganizationProfile
  created_at: string
  updated_at: string
}

export interface ExtractedNeed {
  need: string
  source: string
  source_type: 'document' | 'website' | 'questionnaire' | 'free_form'
  quote?: string
  confidence: 'high' | 'medium' | 'low'
  category?: string
}

export interface OrganizationProfile {
  organization_facts: {
    name: string
    type: 'parish' | 'parish_with_school' | 'school'
    is_501c3: boolean
    in_catholic_directory: boolean
    diocese?: string
    state?: string
    location_type?: 'urban' | 'suburban' | 'rural'
    founded_year?: number
    building_age_years?: number
    parish_families?: number
    student_count?: number
    school_grades?: string
  }
  needs_and_projects: ExtractedNeed[]
  capacity_indicators: {
    staff_mentioned: string[]
    active_ministries: number
    programs: string[]
    volunteer_capacity: 'high' | 'medium' | 'low' | 'unknown'
  }
  special_characteristics: string[]
}

export interface GrantDatabase {
  id: number
  name: string
  filename: string
  grant_count: number
  uploaded_at: string
}

export interface Grant {
  id: number
  name: string
  granting_authority?: string
  description?: string
  deadline?: string
  deadline_type?: string
  amount_min?: number
  amount_max?: number
  eligibility?: Record<string, any>
  geographic_restriction?: string
  funds_for?: string[]
  categories?: string[]
  apply_url?: string
  notes?: string
}

export interface GrantMatch {
  grant_id: number
  grant_name: string
  granting_authority?: string
  score: number
  score_label: 'excellent' | 'good' | 'possible' | 'weak' | 'not_eligible'
  amount_display: string
  deadline_display: string
  deadline_urgent: boolean
  why_it_fits: string
  eligibility_notes: string[]
  verify_items: string[]
  apply_url?: string
  eligibility_score: number
  need_alignment_score: number
  capacity_score: number
  timing_score: number
  completeness_score: number
}

export interface MatchResults {
  session_id: number
  grants_evaluated: number
  excellent_matches: GrantMatch[]
  good_matches: GrantMatch[]
  possible_matches: GrantMatch[]
  weak_matches: GrantMatch[]
  not_eligible: GrantMatch[]
  created_at: string
}

export interface Document {
  id: number
  filename: string
  file_type: string
  file_size: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
  extracted_needs?: ExtractedNeed[]
  error_message?: string
  uploaded_at: string
  processed_at?: string
}

export interface Question {
  id: string
  text: string
  type: 'yes_no' | 'multiple_choice' | 'text' | 'number'
  options?: string[]
  topic: string
  conditional?: {
    depends_on: string
    show_if: string
  }
  relevant_grants: string[]
}

export interface TerminalLine {
  timestamp: string
  message: string
  type: 'status' | 'success' | 'warning' | 'error' | 'extracted'
}
