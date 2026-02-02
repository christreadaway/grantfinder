"""
Grants router for GrantFinder AI.
Handles grant database upload ("Excel with 5 categories) and management.
"""
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from typing import List, Dict
import logging
import io

from models.schemas import (
    Grant, GrantBase, GrantCategory, GrantStatus, GeoQualified,
    Foundation, FoundationBase, GrantDatabaseUpload
)
from routers.auth import get_current_user, User
from services.excel_parser import parse_grant_database

router = APIRouter()
logger = logging.getLogger(__name__)

# In-memory storage (replace with Supabase in production)
grants_db: Dict[str, List[Grant]] = {}  # user_id -> list of grants
foundations_db: Dict[str, List[Foundation]] = {}  # user_id -> list of foundations


@router.post("/upload", response_model=GrantDatabaseUpload)
async def upload_grant_database(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user)
):
    """
    Upload grant database Excel file with 5 categories.

    Expected sheets:
    - Category 1: Church/Parish Grants
    - Category 2: Catholic School Grants
    - Category 3: Mixed Church-School
    - Category 4: Non-Catholic Qualifying
    - Category 5: Catholic Foundations
    """
    # Validate file type
    if not file.filename.endswith(('.xlsx', '.xls')):
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Please upload an Excel file (.xlsx)"
        )

    try:
        # Read file content
        content = await file.read()

        # Parse the Excel file
        result = await parse_grant_database(content, current_user.id)

        # Store grants and foundations
        grants_db[current_user.id] = result["grants"]
        foundations_db[current_user.id] = result["foundations"]

        logger.info(
            f"Grant database uploaded for {current_user.email}: "
            f"{len(result['grants'])} grants, {len(result['foundations'])} foundations"
        )

        return GrantDatabaseUpload(
            total_grants=len(result["grants"]),
            categories=result["category_counts"],
            foundations_count=len(result["foundations"]),
            upload_id=result["upload_id"],
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Grant database upload error: {e}")
        raise HTTPException(status_code=500, detail="Failed to process grant database")


@router.get("/", response_model=List[Grant])
async def get_grants(
    category: GrantCategory = None,
    current_user: User = Depends(get_current_user)
):
    """Get all grants, optionally filtered by category."""
    user_grants = grants_db.get(current_user.id, [])

    if category:
        return [g for g in user_grants if g.category == category]

    return user_grants


@router.get("/foundations", response_model=List[Foundation])
async def get_foundations(current_user: User = Depends(get_current_user)):
    """Get Catholic foundations (Category 5)."""
    return foundations_db.get(current_user.id, [])


@router.get("/stats")
async def get_grant_stats(current_user: User = Depends(get_current_user)):
    """Get grant database statistics."""
    user_grants = grants_db.get(current_user.id, [])
    user_foundations = foundations_db.get(current_user.id, [])

    # Count by category
    category_counts = {}
    for category in GrantCategory:
        count = len([g for g in user_grants if g.category == category])
        category_counts[category.value] = count

    # Count by status
    status_counts = {}
    for status in GrantStatus:
        count = len([g for g in user_grants if g.status == status])
        status_counts[status.value] = count

    # Count by geo qualification
    geo_counts = {}
    for geo in GeoQualified:
        count = len([g for g in user_grants if g.geo_qualified == geo])
        geo_counts[geo.value] = count

    return {
        "total_grants": len(user_grants),
        "total_foundations": len(user_foundations),
        "by_category": category_counts,
        "by_status": status_counts,
        "by_geo_qualified": geo_counts,
    }


@router.get("/{grant_id}", response_model=Grant)
async def get_grant(
    grant_id: str,
    current_user: User = Depends(get_current_user)
):
    """Get a specific grant by ID."""
    user_grants = grants_db.get(current_user.id, [])

    for grant in user_grants:
        if grant.id == grant_id:
            return grant

    raise HTTPException(status_code=404, detail="Grant not found")


@router.delete("/")
async def clear_grants(current_user: User = Depends(get_current_user)):
    """Clear all grants for re-upload."""
    if current_user.id in grants_db:
        del grants_db[current_user.id]
    if current_user.id in foundations_db:
        del foundations_db[current_user.id]

    return {"message": "Grant database cleared"}


def get_user_grants(user_id: str) -> List[Grant]:
    """Get user's grants (for internal use)."""
    return grants_db.get(user_id, [])


def get_user_foundations(user_id: str) -> List[Foundation]:
    """Get user's foundations (for internal use)."""
    return foundations_db.get(user_id, [])
