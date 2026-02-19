from datetime import datetime
from typing import Optional, List, Any
from pydantic import BaseModel, HttpUrl


class ExtractedNeed(BaseModel):
    need: str
    source: str
    source_type: str  # "document", "website", "free_form"
    quote: Optional[str] = None
    confidence: str = "medium"  # "high", "medium", "low"


class QuestionnaireAnswers(BaseModel):
    is_501c3: Optional[bool] = None
    in_catholic_directory: Optional[bool] = None
    state: Optional[str] = None
    diocese: Optional[str] = None
    has_school: Optional[bool] = None
    school_grades: Optional[str] = None
    student_count: Optional[int] = None
    parish_families: Optional[int] = None
    building_age_years: Optional[int] = None
    location_type: Optional[str] = None  # "urban", "suburban", "rural"
    # Additional dynamic answers stored as extra fields
    additional: Optional[dict] = None


class OrganizationCreate(BaseModel):
    name: str
    church_website: Optional[str] = None
    school_website: Optional[str] = None


class OrganizationUpdate(BaseModel):
    name: Optional[str] = None
    church_website: Optional[str] = None
    school_website: Optional[str] = None
    questionnaire_answers: Optional[QuestionnaireAnswers] = None
    free_form_notes: Optional[str] = None


class OrganizationResponse(BaseModel):
    id: int
    name: str
    church_website: Optional[str] = None
    school_website: Optional[str] = None
    website_extracted: Optional[dict] = None
    questionnaire_answers: Optional[dict] = None
    free_form_notes: Optional[str] = None
    extracted_needs: Optional[List[dict]] = None
    profile_json: Optional[dict] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class WebsiteExtraction(BaseModel):
    founded_year: Optional[int] = None
    mission_statement: Optional[str] = None
    staff: Optional[List[str]] = None
    ministries: Optional[List[str]] = None
    programs: Optional[List[str]] = None
    recent_news: Optional[List[str]] = None
    parish_name: Optional[str] = None
    location: Optional[str] = None
    diocese: Optional[str] = None
    school_info: Optional[dict] = None


class ProfileResponse(BaseModel):
    organization_facts: dict
    needs_and_projects: List[ExtractedNeed]
    from_documents: List[ExtractedNeed]
    from_website: List[ExtractedNeed]
    from_notes: List[ExtractedNeed]
    from_questionnaire: List[ExtractedNeed]
