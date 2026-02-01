from datetime import datetime, date
from typing import Optional, List
from pydantic import BaseModel


class GrantDatabaseCreate(BaseModel):
    name: str


class GrantResponse(BaseModel):
    id: int
    name: str
    granting_authority: Optional[str] = None
    description: Optional[str] = None
    deadline: Optional[date] = None
    deadline_type: Optional[str] = None
    amount_min: Optional[float] = None
    amount_max: Optional[float] = None
    eligibility: Optional[dict] = None
    geographic_restriction: Optional[str] = None
    funds_for: Optional[List[str]] = None
    categories: Optional[List[str]] = None
    apply_url: Optional[str] = None
    notes: Optional[str] = None

    class Config:
        from_attributes = True


class GrantDatabaseResponse(BaseModel):
    id: int
    name: str
    filename: str
    grant_count: int
    uploaded_at: datetime

    class Config:
        from_attributes = True


class GrantMatch(BaseModel):
    grant_id: int
    grant_name: str
    granting_authority: Optional[str] = None
    score: int  # 0-100
    score_label: str  # "excellent", "good", "possible", "weak", "not_eligible"
    amount_display: str  # Formatted amount string
    deadline_display: str  # Formatted deadline string
    deadline_urgent: bool = False
    why_it_fits: str
    eligibility_notes: List[str] = []
    verify_items: List[str] = []
    apply_url: Optional[str] = None

    # Score breakdown
    eligibility_score: int
    need_alignment_score: int
    capacity_score: int
    timing_score: int
    completeness_score: int


class MatchResult(BaseModel):
    session_id: int
    grants_evaluated: int
    excellent_matches: List[GrantMatch]  # 85-100%
    good_matches: List[GrantMatch]  # 70-84%
    possible_matches: List[GrantMatch]  # 50-69%
    weak_matches: List[GrantMatch]  # 25-49%
    not_eligible: List[GrantMatch]  # 0-24%
    created_at: datetime
