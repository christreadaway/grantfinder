"""
Profile router for GrantFinder AI.
Handles organization profile management.
"""
from fastapi import APIRouter, HTTPException, Depends
from typing import Optional
from datetime import datetime
import logging

from models.schemas import OrganizationProfile
from routers.auth import get_current_user, User

router = APIRouter()
logger = logging.getLogger(__name__)

# Re-use the profiles_db from processing router
# In production, this would be Supabase
from routers.processing import profiles_db


@router.get("/", response_model=OrganizationProfile)
async def get_profile(current_user: User = Depends(get_current_user)):
    """Get the current organization profile."""
    profile = profiles_db.get(current_user.id)

    if not profile:
        # Return empty profile template
        return OrganizationProfile(
            user_id=current_user.id,
            organization_name="",
            organization_type="parish",
            city="",
            state="",
            sources=[],
        )

    return profile


@router.put("/", response_model=OrganizationProfile)
async def update_profile(
    profile_update: OrganizationProfile,
    current_user: User = Depends(get_current_user)
):
    """
    Update organization profile.
    Users can edit the AI-synthesized profile.
    """
    profile_update.user_id = current_user.id
    profile_update.last_updated = datetime.utcnow()

    # Merge with existing profile if present
    existing = profiles_db.get(current_user.id)
    if existing:
        # Preserve sources from AI processing
        if not profile_update.sources:
            profile_update.sources = existing.sources
        profile_update.sources.append("User edit")

    profiles_db[current_user.id] = profile_update
    logger.info(f"Profile updated for user: {current_user.email}")

    return profile_update


@router.delete("/")
async def delete_profile(current_user: User = Depends(get_current_user)):
    """Delete organization profile to start fresh."""
    if current_user.id in profiles_db:
        del profiles_db[current_user.id]
        logger.info(f"Profile deleted for user: {current_user.email}")

    return {"message": "Profile deleted"}


@router.post("/reset")
async def reset_profile(current_user: User = Depends(get_current_user)):
    """Reset profile to empty state."""
    profiles_db[current_user.id] = OrganizationProfile(
        user_id=current_user.id,
        organization_name="",
        organization_type="parish",
        city="",
        state="",
        sources=[],
    )

    return {"message": "Profile reset"}
