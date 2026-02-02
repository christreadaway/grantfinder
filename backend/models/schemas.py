"""
Pydantic schemas for GrantFinder AI.
Based on Spec v2.6 - 5 Category Grant Structure
"""
from pydantic import BaseModel, Field, HttpUrl
from typing import Optional, List, Dict, Any
from datetime import datetime
from enum import Enum


# =============================================================================
# Enums
# =============================================================================

class GrantCategory(str, Enum):
    """5-category grant database structure."""
    CHURCH_PARISH = "church_parish"          # Category 1
    CATHOLIC_SCHOOL = "catholic_school"      # Category 2
    MIXED_CHURCH_SCHOOL = "mixed"            # Category 3
    NON_CATHOLIC_QUALIFYING = "non_catholic" # Category 4
    CATHOLIC_FOUNDATIONS = "foundations"     # Category 5


class GrantStatus(str, Enum):
    """Grant application status."""
    OPEN = "OPEN"
    ROLLING = "Rolling"
    CHECK_DEADLINE = "Check deadline"
    CLOSED = "CLOSED"


class GeoQualified(str, Enum):
    """Geographic qualification status."""
    YES = "Yes"
    NO = "No"
    TX_ONLY = "Yes - TX Only"
    CHECK = "Check eligibility"


class MatchScoreTier(str, Enum):
    """Match score interpretation tiers."""
    EXCELLENT = "excellent"      # 85-100%
    GOOD = "good"               # 70-84%
    POSSIBLE = "possible"       # 50-69%
    WEAK = "weak"               # 25-49%
    NOT_ELIGIBLE = "not_eligible"  # 0-24%


# =============================================================================
# User Models
# =============================================================================

class UserBase(BaseModel):
    """Base user model."""
    email: str
    name: Optional[str] = None
    picture: Optional[str] = None


class UserCreate(UserBase):
    """User creation model."""
    google_id: str


class User(UserBase):
    """Full user model."""
    id: str
    google_id: str
    created_at: datetime
    claude_api_key_set: bool = False

    class Config:
        from_attributes = True


class TokenResponse(BaseModel):
    """OAuth token response."""
    access_token: str
    token_type: str = "bearer"
    user: User


# =============================================================================
# Grant Models (v2.6 - 5 Categories)
# =============================================================================

class GrantBase(BaseModel):
    """Base grant model with required columns per v2.6 spec."""
    grant_name: str = Field(..., description="Name of the grant")
    deadline: str = Field(..., description="Deadline date or 'Rolling'")
    amount: str = Field(..., description="Grant amount, e.g., 'Up to $15,000'")
    funder: str = Field(..., description="Name of the funding organization")
    description: str = Field(..., description="Grant description")
    contact: str = Field(..., description="Contact info (email/phone)")
    url: str = Field(..., description="Grant application URL")
    status: GrantStatus = Field(..., description="OPEN, Rolling, Check deadline")
    geo_qualified: GeoQualified = Field(..., description="Geographic qualification")
    funder_stats: Optional[str] = Field(None, description="Optional: Annual giving, avg grant size")
    category: GrantCategory = Field(..., description="Grant category (1-5)")


class Grant(GrantBase):
    """Full grant model with database ID."""
    id: str
    user_id: str
    created_at: datetime

    class Config:
        from_attributes = True


class FoundationBase(BaseModel):
    """Category 5: Catholic Foundations model per v2.6 spec."""
    foundation_name: str
    application_cycle: str
    focus_areas: str
    location: str
    contact: str
    website: str
    annual_giving: str
    notes: Optional[str] = None


class Foundation(FoundationBase):
    """Full foundation model."""
    id: str
    user_id: str
    created_at: datetime

    class Config:
        from_attributes = True


class GrantDatabaseUpload(BaseModel):
    """Response after grant database upload."""
    total_grants: int
    categories: Dict[str, int]
    foundations_count: int
    upload_id: str


# =============================================================================
# Organization Profile Models
# =============================================================================

class OrganizationProfile(BaseModel):
    """AI-synthesized organization profile."""
    id: Optional[str] = None
    user_id: str

    # Basic Info
    organization_name: str
    organization_type: str  # "parish", "school", "both"
    diocese: Optional[str] = None
    city: str
    state: str
    zip_code: Optional[str] = None

    # From Website Scanning
    website_url: Optional[str] = None
    school_website_url: Optional[str] = None
    pastor_name: Optional[str] = None
    principal_name: Optional[str] = None
    staff_count: Optional[int] = None
    student_count: Optional[int] = None
    parish_size: Optional[str] = None  # "small", "medium", "large"

    # Extracted Needs & Signals
    facility_needs: List[str] = []
    program_needs: List[str] = []
    security_concerns: List[str] = []
    current_initiatives: List[str] = []

    # From Questionnaire
    is_501c3: bool = True
    has_school: bool = False
    has_food_pantry: bool = False
    has_outreach_programs: bool = False
    annual_budget: Optional[str] = None
    previous_grants: List[str] = []

    # Metadata
    sources: List[str] = []  # Document/URL sources for each extraction
    confidence_score: float = 0.0
    last_updated: Optional[datetime] = None

    class Config:
        from_attributes = True


# =============================================================================
# Grant Matching Models
# =============================================================================

class MatchScoreBreakdown(BaseModel):
    """Probability scoring breakdown per v2.6 spec."""
    eligibility_fit: float = Field(..., ge=0, le=100, description="40% weight")
    need_alignment: float = Field(..., ge=0, le=100, description="30% weight")
    capacity_signals: float = Field(..., ge=0, le=100, description="15% weight")
    timing: float = Field(..., ge=0, le=100, description="10% weight")
    completeness: float = Field(..., ge=0, le=100, description="5% weight")


class GrantMatch(BaseModel):
    """Individual grant match result."""
    grant_id: str
    grant_name: str
    funder: str
    amount: str
    deadline: str
    url: str
    contact: str
    category: GrantCategory
    geo_qualified: GeoQualified

    # Scoring
    score: int = Field(..., ge=0, le=100, description="Overall probability score 0-100%")
    score_tier: MatchScoreTier
    score_breakdown: MatchScoreBreakdown

    # Explanation
    explanation: str = Field(..., description="Why this grant matches")
    evidence: List[str] = Field(default=[], description="Source citations from documents")

    # Flags
    is_shortlisted: bool = False


class MatchResults(BaseModel):
    """Complete match results for a session."""
    session_id: str
    user_id: str
    profile_id: str

    total_grants_evaluated: int
    matches: List[GrantMatch]

    # Summary stats
    excellent_matches: int  # 85-100%
    good_matches: int       # 70-84%
    possible_matches: int   # 50-69%
    weak_matches: int       # 25-49%
    not_eligible: int       # 0-24%

    created_at: datetime
    expires_at: datetime  # 90 days per spec


# =============================================================================
# AI Processing Models
# =============================================================================

class WebsiteScanRequest(BaseModel):
    """Request to scan organization websites."""
    church_url: Optional[str] = None
    school_url: Optional[str] = None


class WebsiteScanResult(BaseModel):
    """Result from website scanning."""
    organization_basics: Dict[str, Any]
    leadership: Dict[str, Any]
    school_info: Optional[Dict[str, Any]]
    facilities: List[str]
    current_initiatives: List[str]
    extracted_text_length: int


class QuestionnaireQuestion(BaseModel):
    """AI-generated questionnaire question."""
    id: int
    question: str
    question_type: str  # "text", "boolean", "select", "multiselect"
    options: Optional[List[str]] = None
    required: bool = True
    grant_relevance: List[str] = []  # Which grants this helps evaluate


class Questionnaire(BaseModel):
    """AI-generated questionnaire (max 20 questions per spec)."""
    questions: List[QuestionnaireQuestion]
    total_questions: int = Field(..., le=20)


class QuestionnaireAnswer(BaseModel):
    """User's answer to a questionnaire question."""
    question_id: int
    answer: Any


class QuestionnaireSubmission(BaseModel):
    """Submitted questionnaire answers."""
    answers: List[QuestionnaireAnswer]
    free_form_text: Optional[str] = None


class DocumentUpload(BaseModel):
    """Uploaded document metadata."""
    filename: str
    file_type: str  # "pdf", "docx", "txt"
    file_size: int
    upload_id: str


class DocumentExtractionResult(BaseModel):
    """Extracted content from documents."""
    document_id: str
    filename: str
    extracted_text_length: int
    facility_needs: List[str]
    program_needs: List[str]
    security_concerns: List[str]
    other_signals: List[str]


class ProcessingStatus(BaseModel):
    """Real-time processing status for terminal UI."""
    step: str
    message: str
    progress: int  # 0-100
    timestamp: datetime
    details: Optional[str] = None


# =============================================================================
# Export Models
# =============================================================================

class ExportFormat(str, Enum):
    """Supported export formats."""
    PDF = "pdf"
    CSV = "csv"
    MARKDOWN = "md"


class ExportRequest(BaseModel):
    """Export request."""
    session_id: str
    format: ExportFormat
    include_profile: bool = True
    include_all_matches: bool = False  # False = only shortlisted


class ExportResponse(BaseModel):
    """Export response with download URL."""
    download_url: str
    filename: str
    format: ExportFormat
    expires_at: datetime
