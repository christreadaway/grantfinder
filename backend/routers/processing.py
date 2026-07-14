"""
AI Processing router for GrantFinder AI.
Handles website scanning, questionnaire generation, document extraction, and grant matching.
"""
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, BackgroundTasks
from fastapi.responses import StreamingResponse
from typing import List, Optional
import logging
import json
import asyncio
from datetime import datetime

from models.schemas import (
    WebsiteScanRequest, WebsiteScanResult,
    Questionnaire, QuestionnaireSubmission,
    DocumentExtractionResult, ProcessingStatus,
    MatchResults, GrantMatch, MatchScoreBreakdown, MatchScoreTier,
    OrganizationProfile
)
from routers.auth import get_current_user, get_user_api_key, User
from routers.grants import get_user_grants, get_user_foundations
from services.ai_service import AIService
from services.document_processor import process_document
from state import profiles_db, store_match_results, get_match_results as get_stored_results

router = APIRouter()
logger = logging.getLogger(__name__)

# In-memory storage for processing state
processing_sessions: dict = {}

# Last generated questionnaire per user (so submitted answers can be mapped
# back to their question text): user_id -> Questionnaire
questionnaires_db: dict = {}


async def get_ai_service(current_user: User = Depends(get_current_user)) -> AIService:
    """Get AI service with user's API key."""
    api_key = get_user_api_key(current_user.id)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Claude API key not set. Please add your API key first."
        )
    return AIService(api_key)


@router.post("/scan-website", response_model=WebsiteScanResult)
async def scan_website(
    request: WebsiteScanRequest,
    current_user: User = Depends(get_current_user),
    ai_service: AIService = Depends(get_ai_service)
):
    """
    Scan church and/or school websites to extract organization information.
    """
    if not request.church_url and not request.school_url:
        raise HTTPException(
            status_code=400,
            detail="At least one website URL is required"
        )

    try:
        result = await ai_service.scan_websites(
            church_url=request.church_url,
            school_url=request.school_url
        )

        # Store partial profile
        if current_user.id not in profiles_db:
            profiles_db[current_user.id] = OrganizationProfile(
                user_id=current_user.id,
                organization_name="",
                organization_type="parish",
                city="",
                state="",
                sources=[],
            )

        profile = profiles_db[current_user.id]
        profile.website_url = request.church_url
        profile.school_website_url = request.school_url

        # Update profile with scanned data
        if result.organization_basics:
            profile.organization_name = result.organization_basics.get("name", "")
            profile.city = result.organization_basics.get("city", "")
            profile.state = result.organization_basics.get("state", "")
            profile.diocese = result.organization_basics.get("diocese")

        if result.leadership:
            profile.pastor_name = result.leadership.get("pastor")
            profile.principal_name = result.leadership.get("principal")

        if result.school_info:
            profile.has_school = True
            profile.student_count = result.school_info.get("student_count")

        profile.current_initiatives = result.current_initiatives
        profile.sources.append(f"Website scan: {request.church_url or request.school_url}")

        return result

    except Exception as e:
        logger.error(f"Website scan error: {e}")
        raise HTTPException(status_code=500, detail=f"Website scan failed: {str(e)}")


@router.post("/generate-questionnaire", response_model=Questionnaire)
async def generate_questionnaire(
    current_user: User = Depends(get_current_user),
    ai_service: AIService = Depends(get_ai_service)
):
    """
    Generate AI questionnaire based on grant database.
    Max 20 questions per spec.
    """
    grants = get_user_grants(current_user.id)

    if not grants:
        raise HTTPException(
            status_code=400,
            detail="No grants uploaded. Please upload grant database first."
        )

    try:
        questionnaire = await ai_service.generate_questionnaire(grants)
        questionnaires_db[current_user.id] = questionnaire
        return questionnaire

    except Exception as e:
        logger.error(f"Questionnaire generation error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate questionnaire: {str(e)}")


@router.post("/submit-questionnaire")
async def submit_questionnaire(
    submission: QuestionnaireSubmission,
    current_user: User = Depends(get_current_user)
):
    """
    Submit questionnaire answers.
    Updates organization profile with responses.
    """
    if current_user.id not in profiles_db:
        profiles_db[current_user.id] = OrganizationProfile(
            user_id=current_user.id,
            organization_name="",
            organization_type="parish",
            city="",
            state="",
            sources=[],
        )

    profile = profiles_db[current_user.id]

    # Map answers back to their question text via the stored questionnaire
    questionnaire = questionnaires_db.get(current_user.id)
    questions_by_id = (
        {q.id: q.question for q in questionnaire.questions} if questionnaire else {}
    )

    qa_pairs = []
    for answer in submission.answers:
        question_text = questions_by_id.get(answer.question_id, f"Question {answer.question_id}")
        qa_pairs.append({"question": question_text, "answer": answer.answer})

        # Map well-known questions onto structured profile fields
        q_lower = question_text.lower()
        answer_str = str(answer.answer).strip()
        is_yes = answer_str.lower() in ("true", "yes", "y", "1")

        if "501" in q_lower:
            profile.is_501c3 = is_yes
        elif "food pantry" in q_lower or "food assistance" in q_lower:
            profile.has_food_pantry = is_yes
        elif "school" in q_lower and "grade" not in q_lower:
            if isinstance(answer.answer, bool) or answer_str.lower() in ("true", "false", "yes", "no"):
                profile.has_school = is_yes
            elif "school" in answer_str.lower():
                profile.has_school = "only" not in answer_str.lower() or "school" in answer_str.lower()
        elif "state" in q_lower and answer_str and len(answer_str) <= 30:
            if not profile.state:
                profile.state = answer_str
        elif "budget" in q_lower and answer_str:
            profile.annual_budget = answer_str
        elif ("grant" in q_lower and ("past" in q_lower or "previous" in q_lower or "received" in q_lower)):
            if answer_str and not isinstance(answer.answer, bool) and answer_str.lower() not in ("true", "false", "yes", "no"):
                profile.previous_grants.append(answer_str)

    # Every answer is kept verbatim so matching (and the future grant writer)
    # can use the full context, not just the mapped fields.
    profile.questionnaire_answers = qa_pairs

    if submission.free_form_text:
        profile.free_form_notes = submission.free_form_text
        profile.sources.append("User free-form text")

    profile.sources.append("Questionnaire responses")
    profile.last_updated = datetime.utcnow()

    return {"message": "Questionnaire submitted successfully", "answers_recorded": len(qa_pairs)}


@router.post("/upload-document", response_model=DocumentExtractionResult)
async def upload_document(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    ai_service: AIService = Depends(get_ai_service)
):
    """
    Upload and process a document (PDF, DOCX, TXT).
    Extracts text and identifies grant-relevant information.
    """
    # Validate file type
    allowed_types = ['.pdf', '.docx', '.txt']
    file_ext = '.' + file.filename.split('.')[-1].lower()

    if file_ext not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type. Allowed: {', '.join(allowed_types)}"
        )

    try:
        content = await file.read()

        # Extract text from document
        extracted_text = await process_document(content, file_ext)

        # Use AI to analyze the text
        extraction_result = await ai_service.extract_document_signals(
            text=extracted_text,
            filename=file.filename
        )

        # Update profile with extracted data
        if current_user.id in profiles_db:
            profile = profiles_db[current_user.id]
            profile.facility_needs.extend(extraction_result.facility_needs)
            profile.program_needs.extend(extraction_result.program_needs)
            profile.security_concerns.extend(extraction_result.security_concerns)
            profile.sources.append(f"Document: {file.filename}")

        return extraction_result

    except Exception as e:
        logger.error(f"Document processing error: {e}")
        raise HTTPException(status_code=500, detail=f"Document processing failed: {str(e)}")


@router.get("/profile", response_model=OrganizationProfile)
async def get_profile(current_user: User = Depends(get_current_user)):
    """Get the current organization profile."""
    profile = profiles_db.get(current_user.id)

    if not profile:
        raise HTTPException(
            status_code=404,
            detail="No profile found. Please complete the setup process."
        )

    return profile


@router.put("/profile", response_model=OrganizationProfile)
async def update_profile(
    profile: OrganizationProfile,
    current_user: User = Depends(get_current_user)
):
    """Update organization profile (user edits)."""
    profile.user_id = current_user.id
    profile.last_updated = datetime.utcnow()
    profiles_db[current_user.id] = profile
    return profile


@router.post("/match-grants", response_model=MatchResults)
async def match_grants(
    current_user: User = Depends(get_current_user),
    ai_service: AIService = Depends(get_ai_service)
):
    """
    Run grant matching algorithm.
    Scores all grants 0-100% based on weighted factors per v2.6 spec:
    - Eligibility fit (40%)
    - Need alignment (30%)
    - Capacity signals (15%)
    - Timing (10%)
    - Completeness (5%)
    """
    import uuid as _uuid
    from models.schemas import Grant, GrantCategory, GrantStatus, GeoQualified

    grants = get_user_grants(current_user.id)
    profile = profiles_db.get(current_user.id)

    if not grants:
        raise HTTPException(
            status_code=400,
            detail="No grants in database. Upload a grant database or run discovery first."
        )

    if not profile:
        raise HTTPException(
            status_code=400,
            detail="No organization profile. Please complete the setup process."
        )

    # Include Category 5 foundations in matching as monitorable opportunities,
    # so they are scored and surfaced instead of sitting unused.
    all_grants = list(grants)
    existing_names = {g.grant_name.lower() for g in all_grants}
    for foundation in get_user_foundations(current_user.id):
        pseudo_name = f"{foundation.foundation_name} (Foundation)"
        if pseudo_name.lower() in existing_names:
            continue
        all_grants.append(Grant(
            id=f"grant_{_uuid.uuid4().hex[:12]}",
            user_id=current_user.id,
            grant_name=pseudo_name,
            deadline=foundation.application_cycle or "Check website",
            amount=foundation.annual_giving or "Varies",
            funder=foundation.foundation_name,
            description=(
                f"Catholic grant-making foundation to monitor. Focus areas: "
                f"{foundation.focus_areas}. {foundation.notes or ''}"
            ).strip(),
            contact=foundation.contact,
            url=foundation.website,
            status=GrantStatus.CHECK_DEADLINE,
            geo_qualified=GeoQualified.CHECK,
            category=GrantCategory.CATHOLIC_FOUNDATIONS,
            source="upload",
            created_at=datetime.utcnow(),
        ))

    try:
        results = await ai_service.match_grants(
            grants=all_grants,
            profile=profile,
            user_id=current_user.id
        )

        # Store results for later export
        store_match_results(results.session_id, results)

        return results

    except Exception as e:
        logger.error(f"Grant matching error: {e}")
        raise HTTPException(status_code=500, detail=f"Grant matching failed: {str(e)}")


@router.get("/match-results/{session_id}", response_model=MatchResults)
async def get_match_results(
    session_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get match results for a specific session."""
    results = get_stored_results(session_id)

    if not results:
        raise HTTPException(status_code=404, detail="Session not found")

    # Verify user owns these results
    if results.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")

    return results


@router.post("/shortlist/{grant_id}")
async def toggle_shortlist(
    grant_id: str,
    shortlist: bool = True,
    current_user: User = Depends(get_current_user)
):
    """Add or remove a grant from the shortlist."""
    # In production, persist to database
    return {"grant_id": grant_id, "shortlisted": shortlist}


def get_user_profile(user_id: str) -> Optional[OrganizationProfile]:
    """Get user's profile (for internal use)."""
    from state import get_profile
    return get_profile(user_id)
