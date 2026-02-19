from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import json
import asyncio

from app.core.database import get_db
from app.api.dependencies.auth import get_current_user, get_current_user_with_api_key
from app.models.user import User
from app.models.organization import Organization
from app.schemas.organization import (
    OrganizationCreate, OrganizationResponse, OrganizationUpdate,
    ProfileResponse
)
from app.services.ai_service import AIService
from app.services.website_service import WebsiteService


router = APIRouter()


@router.get("/", response_model=List[OrganizationResponse])
async def list_organizations(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all organizations for current user."""
    result = await db.execute(
        select(Organization).where(Organization.user_id == current_user.id)
    )
    return result.scalars().all()


@router.post("/", response_model=OrganizationResponse)
async def create_organization(
    org: OrganizationCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new organization."""
    organization = Organization(
        user_id=current_user.id,
        name=org.name,
        church_website=org.church_website,
        school_website=org.school_website,
    )
    db.add(organization)
    await db.flush()
    await db.refresh(organization)
    return organization


@router.get("/{org_id}", response_model=OrganizationResponse)
async def get_organization(
    org_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get a specific organization."""
    result = await db.execute(
        select(Organization).where(
            Organization.id == org_id,
            Organization.user_id == current_user.id
        )
    )
    org = result.scalar_one_or_none()

    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )

    return org


@router.put("/{org_id}", response_model=OrganizationResponse)
async def update_organization(
    org_id: int,
    update: OrganizationUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update an organization."""
    result = await db.execute(
        select(Organization).where(
            Organization.id == org_id,
            Organization.user_id == current_user.id
        )
    )
    org = result.scalar_one_or_none()

    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )

    if update.name is not None:
        org.name = update.name
    if update.church_website is not None:
        org.church_website = update.church_website
    if update.school_website is not None:
        org.school_website = update.school_website
    if update.questionnaire_answers is not None:
        org.questionnaire_answers = update.questionnaire_answers.model_dump()
    if update.free_form_notes is not None:
        org.free_form_notes = update.free_form_notes

    await db.flush()
    await db.refresh(org)
    return org


@router.delete("/{org_id}")
async def delete_organization(
    org_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete an organization."""
    result = await db.execute(
        select(Organization).where(
            Organization.id == org_id,
            Organization.user_id == current_user.id
        )
    )
    org = result.scalar_one_or_none()

    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )

    await db.delete(org)
    return {"message": "Organization deleted"}


@router.post("/{org_id}/scan-website")
async def scan_website(
    org_id: int,
    current_user: User = Depends(get_current_user_with_api_key),
    db: AsyncSession = Depends(get_db)
):
    """Scan organization website(s) and extract information."""
    result = await db.execute(
        select(Organization).where(
            Organization.id == org_id,
            Organization.user_id == current_user.id
        )
    )
    org = result.scalar_one_or_none()

    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )

    if not org.church_website and not org.school_website:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No website URLs configured"
        )

    async def generate_events():
        """Generate Server-Sent Events for website scanning."""
        all_content = []

        # Scan church website
        if org.church_website:
            yield f"data: {json.dumps({'type': 'status', 'message': f'Starting scan of church website...'})}\n\n"
            async for event in WebsiteService.crawl_website(org.church_website):
                if event["type"] == "status":
                    yield f"data: {json.dumps(event)}\n\n"
                elif event["type"] == "extracted":
                    yield f"data: {json.dumps({'type': 'extracted', 'item': event['item']})}\n\n"
                elif event["type"] == "complete":
                    all_content.extend(event.get("content", []))
                    pages = event["pages_crawled"]
                    yield f"data: {json.dumps({'type': 'status', 'message': f'Church website scan complete. {pages} pages scanned.'})}\n\n"

        # Scan school website if different
        if org.school_website and org.school_website != org.church_website:
            yield f"data: {json.dumps({'type': 'status', 'message': 'Starting scan of school website...'})}\n\n"
            async for event in WebsiteService.crawl_website(org.school_website):
                if event["type"] == "status":
                    yield f"data: {json.dumps(event)}\n\n"
                elif event["type"] == "extracted":
                    yield f"data: {json.dumps({'type': 'extracted', 'item': event['item']})}\n\n"
                elif event["type"] == "complete":
                    all_content.extend(event.get("content", []))
                    pages = event["pages_crawled"]
                    yield f"data: {json.dumps({'type': 'status', 'message': f'School website scan complete. {pages} pages scanned.'})}\n\n"

        # Use AI to extract structured information
        if all_content:
            yield f"data: {json.dumps({'type': 'status', 'message': 'Analyzing content with AI...'})}\n\n"

            combined_text = "\n\n".join([c.get("text", "") for c in all_content])
            ai_service = AIService(current_user.api_key_encrypted)
            extracted = await ai_service.extract_from_website(
                org.church_website or org.school_website,
                combined_text
            )

            # Save to database
            org.website_extracted = extracted
            await db.flush()

            yield f"data: {json.dumps({'type': 'complete', 'data': extracted})}\n\n"
        else:
            yield f"data: {json.dumps({'type': 'complete', 'data': {}})}\n\n"

    return StreamingResponse(
        generate_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


@router.post("/{org_id}/generate-profile", response_model=dict)
async def generate_profile(
    org_id: int,
    current_user: User = Depends(get_current_user_with_api_key),
    db: AsyncSession = Depends(get_db)
):
    """Generate a parish profile from all collected data."""
    result = await db.execute(
        select(Organization).where(
            Organization.id == org_id,
            Organization.user_id == current_user.id
        )
    )
    org = result.scalar_one_or_none()

    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )

    # Collect all data for profile generation
    org_data = {
        "name": org.name,
        "website_extracted": org.website_extracted,
        "questionnaire_answers": org.questionnaire_answers,
        "free_form_notes": org.free_form_notes,
        "extracted_needs": org.extracted_needs or [],
    }

    ai_service = AIService(current_user.api_key_encrypted)
    profile = await ai_service.generate_profile(org_data)

    # Save profile
    org.profile_json = profile
    await db.flush()

    return profile
