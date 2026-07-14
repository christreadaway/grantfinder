"""
Pydantic schemas for the GrantWriter module (Application Writer PRD v2.0).

The writer extends grantfinder's existing records - it never duplicates them.
An Application links an org profile to a grant record by ID; the GrantSpec
enriches (not forks) the grant; every stakeholder answer flows back into the
shared OrganizationProfile.
"""
from pydantic import BaseModel, Field
from typing import Any, Dict, List, Optional
from datetime import datetime
from enum import Enum


# =============================================================================
# Application lifecycle
# =============================================================================

class ApplicationStatus(str, Enum):
    ANALYSIS = "analysis"
    INTAKE = "intake"
    DRAFTING = "drafting"
    REVIEW = "review"
    EXPORT = "export"


class Application(BaseModel):
    """One org pursuing one grant. Links to existing records by ID."""
    id: str
    user_id: str
    grant_id: str
    grant_name: str
    funder: str
    status: ApplicationStatus = ApplicationStatus.ANALYSIS
    strategy: Optional[str] = None            # Confirmed narrative strategy (gate 1)
    strategy_confirmed: bool = False
    deadline: Optional[str] = None
    urgent: bool = False                      # Deadline within N days (default 10)
    correlation_id: str = ""                  # Traces every AI call for this app
    created_at: datetime
    updated_at: datetime


# =============================================================================
# Grant Spec (enrichment of grantfinder's grant record - PRD 4.2)
# =============================================================================

class RubricCriterion(BaseModel):
    id: str
    name: str
    description: str = ""
    weight: Optional[float] = None            # Percent if published/inferred


class RequiredSection(BaseModel):
    id: str
    title: str
    prompt: str = ""                          # The funder's question/prompt
    word_limit: Optional[int] = None
    char_limit: Optional[int] = None
    notes: str = ""


class GrantSpec(BaseModel):
    """Full application requirements for one grant. Keyed by grant_id."""
    grant_id: str
    required_sections: List[RequiredSection] = []
    format_constraints: List[str] = []        # Page limits, fonts, portal type...
    deliverables: List[str] = []              # Video, one-pager, letters...
    rubric: List[RubricCriterion] = []
    rubric_source: str = "inferred"           # "explicit" | "inferred"
    funder_language_cues: List[str] = []      # Funder vocabulary to mirror
    funder_priorities: List[str] = []
    guidelines_text: Optional[str] = None     # Raw guidelines used for enrichment
    enriched_at: Optional[datetime] = None


# =============================================================================
# Fit / Gap analysis (PRD 4.3 - the core value)
# =============================================================================

class FitEntry(BaseModel):
    criterion_id: str
    criterion_name: str
    rating: str                               # "strong" | "partial" | "weak" | "missing"
    evidence: List[str] = []                  # Profile evidence supporting it
    missing: Optional[str] = None             # What's absent if weak/missing


class GapStatus(str, Enum):
    OPEN = "open"
    ROUTED = "routed"
    ANSWERED = "answered"
    CONFIRMED_GAP = "confirmed_gap"           # Stakeholder said "we don't have that"
    WAIVED = "waived"


class Gap(BaseModel):
    id: str
    application_id: str
    criterion_ref: str                        # Criterion or required field it blocks
    description: str
    severity: str = "medium"                  # "high" blocks drafting until resolved/waived
    suggested_owner_role: str = ""            # e.g. "Finance", "Principal", "Pastor"
    status: GapStatus = GapStatus.OPEN
    answer: Optional[str] = None


class FitAnalysis(BaseModel):
    application_id: str
    fit_map: List[FitEntry] = []
    strength_leads: List[str] = []            # Criteria to open with
    honesty_ledger: List[str] = []            # Weaknesses to name and frame, not hide
    recommended_strategy: str = ""
    generated_at: datetime


# =============================================================================
# Stakeholder intake (PRD 4.4)
# =============================================================================

class IntakeRequest(BaseModel):
    id: str
    application_id: str
    stakeholder_role: str                     # Single owner per gap
    gap_ids: List[str] = []
    framing: str = ""                         # One-line "why we need this"
    questions: List[str] = []
    expected_format: str = "A few sentences is fine."
    suggested_deadline: Optional[str] = None
    email_packet: str = ""                    # Copy-paste-ready email (v1)
    status: str = "draft"                     # draft | sent | answered | confirmed_gap
    response: Optional[str] = None


class IntakeAnswer(BaseModel):
    """Grant Lead records what the stakeholder said."""
    response: str
    is_confirmed_gap: bool = False            # True = "we don't have that"


# =============================================================================
# Drafting / scoring / refinement (PRD 4.5-4.7)
# =============================================================================

class ClaimFlag(BaseModel):
    claim: str
    criterion_ref: Optional[str] = None
    evidence_ref: Optional[str] = None
    flagged: bool = False                     # True = no supporting evidence
    reason: Optional[str] = None


class SectionDraft(BaseModel):
    id: str
    application_id: str
    section_id: str                           # RequiredSection.id
    title: str
    current_draft: str = ""
    versions: List[str] = []                  # Prior drafts (most recent last)
    claims: List[ClaimFlag] = []
    word_count: int = 0
    char_count: int = 0
    over_limit: bool = False
    banned_phrase_hits: List[str] = []
    compliance_notes: List[str] = []


class RefineRequest(BaseModel):
    instruction: str                          # "tighten by 40 words", "warm this up"...


class CriterionScore(BaseModel):
    criterion_id: str
    criterion_name: str
    score: float                              # 0-100 against this criterion
    weight: Optional[float] = None
    commentary: str = ""


class Scorecard(BaseModel):
    application_id: str
    per_criterion: List[CriterionScore] = []
    overall_score: float = 0
    top_fix: str = ""                         # The single highest-leverage weakness
    ranked_fixes: List[str] = []
    compliance_results: List[Dict[str, Any]] = []  # Per hard constraint: pass/fail
    generated_at: datetime


# =============================================================================
# Export (PRD 4.8)
# =============================================================================

class ExportFormat(str, Enum):
    DOCX = "docx"
    MARKDOWN = "md"
    PLAIN_TEXT = "txt"
    FORM_MAP = "form_map"                     # Field-by-field map for portals


class ExportRequest(BaseModel):
    format: ExportFormat


# =============================================================================
# AI call logging (PRD Section 8)
# =============================================================================

class AICallLog(BaseModel):
    correlation_id: str
    application_id: Optional[str] = None
    stage: str                                # extract | map | route | draft | score | refine | enforce
    prompt_id: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    latency_ms: int = 0
    cost_estimate_usd: float = 0
    status: str = "ok"                        # ok | error
    error: Optional[str] = None
    timestamp: datetime


# =============================================================================
# Requests
# =============================================================================

class CreateApplicationRequest(BaseModel):
    grant_id: str


class EnrichSpecRequest(BaseModel):
    guidelines_text: Optional[str] = None     # Pasted guidelines; falls back to grant URL fetch


class ConfirmStrategyRequest(BaseModel):
    strategy: Optional[str] = None            # Override the recommended strategy if edited


class VoiceAnalyzeRequest(BaseModel):
    samples: List[str]                        # Writing samples in the org's real voice


class DraftRequest(BaseModel):
    section_id: Optional[str] = None          # Omit to draft all sections


class WaiveGapRequest(BaseModel):
    reason: Optional[str] = None
