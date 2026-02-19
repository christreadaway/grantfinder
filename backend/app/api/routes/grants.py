from typing import List
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.core.database import get_db
from app.api.dependencies.auth import get_current_user, get_current_user_with_api_key
from app.models.user import User
from app.models.grant import GrantDatabase, Grant
from app.schemas.grant import GrantDatabaseResponse, GrantResponse
from app.services.grant_service import GrantService
from app.services.ai_service import AIService


router = APIRouter()


@router.get("/databases", response_model=List[GrantDatabaseResponse])
async def list_grant_databases(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all grant databases for current user."""
    result = await db.execute(
        select(GrantDatabase).where(GrantDatabase.user_id == current_user.id)
    )
    databases = result.scalars().all()

    response = []
    for database in databases:
        grant_count_result = await db.execute(
            select(Grant).where(Grant.database_id == database.id)
        )
        grant_count = len(grant_count_result.scalars().all())

        response.append(GrantDatabaseResponse(
            id=database.id,
            name=database.name,
            filename=database.filename,
            grant_count=grant_count,
            uploaded_at=database.uploaded_at,
        ))

    return response


@router.post("/databases/upload", response_model=GrantDatabaseResponse)
async def upload_grant_database(
    file: UploadFile = File(...),
    name: str = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload a new grant database (Excel file)."""
    # Validate file type
    if not file.filename.endswith('.xlsx'):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only .xlsx files are supported"
        )

    # Read file content
    content = await file.read()

    # Parse Excel file
    try:
        grants_data = await GrantService.parse_excel(content, file.filename)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )

    if not grants_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid grants found in the file"
        )

    # Create database record
    database = GrantDatabase(
        user_id=current_user.id,
        name=name or file.filename.replace('.xlsx', ''),
        filename=file.filename,
    )
    db.add(database)
    await db.flush()

    # Create grant records
    for grant_data in grants_data:
        grant = Grant(
            database_id=database.id,
            name=grant_data.get("name", "Unnamed Grant"),
            granting_authority=grant_data.get("granting_authority"),
            description=grant_data.get("description"),
            deadline=grant_data.get("deadline"),
            deadline_type=grant_data.get("deadline_type"),
            amount_min=grant_data.get("amount_min"),
            amount_max=grant_data.get("amount_max"),
            eligibility=grant_data.get("eligibility"),
            geographic_restriction=grant_data.get("geographic_restriction"),
            funds_for=grant_data.get("funds_for"),
            categories=grant_data.get("categories"),
            apply_url=grant_data.get("apply_url"),
            notes=grant_data.get("notes"),
            raw_data=grant_data.get("raw_data"),
        )
        db.add(grant)

    await db.flush()
    await db.refresh(database)

    return GrantDatabaseResponse(
        id=database.id,
        name=database.name,
        filename=database.filename,
        grant_count=len(grants_data),
        uploaded_at=database.uploaded_at,
    )


@router.get("/databases/{db_id}", response_model=List[GrantResponse])
async def get_grants_in_database(
    db_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get all grants in a database."""
    # Verify ownership
    result = await db.execute(
        select(GrantDatabase).where(
            GrantDatabase.id == db_id,
            GrantDatabase.user_id == current_user.id
        )
    )
    database = result.scalar_one_or_none()

    if database is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grant database not found"
        )

    result = await db.execute(
        select(Grant).where(Grant.database_id == db_id)
    )
    return result.scalars().all()


@router.delete("/databases/{db_id}")
async def delete_grant_database(
    db_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a grant database."""
    result = await db.execute(
        select(GrantDatabase).where(
            GrantDatabase.id == db_id,
            GrantDatabase.user_id == current_user.id
        )
    )
    database = result.scalar_one_or_none()

    if database is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grant database not found"
        )

    await db.delete(database)
    return {"message": "Grant database deleted"}


@router.post("/databases/{db_id}/generate-questionnaire")
async def generate_questionnaire(
    db_id: int,
    current_user: User = Depends(get_current_user_with_api_key),
    db: AsyncSession = Depends(get_db)
):
    """Generate a questionnaire based on the grants in the database."""
    # Get grants
    result = await db.execute(
        select(GrantDatabase).where(
            GrantDatabase.id == db_id,
            GrantDatabase.user_id == current_user.id
        )
    )
    database = result.scalar_one_or_none()

    if database is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grant database not found"
        )

    result = await db.execute(
        select(Grant).where(Grant.database_id == db_id)
    )
    grants = result.scalars().all()

    if not grants:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No grants in database"
        )

    # Convert to dicts for AI
    grants_data = [
        {
            "name": g.name,
            "description": g.description,
            "eligibility": g.eligibility,
            "funds_for": g.funds_for,
            "geographic_restriction": g.geographic_restriction,
        }
        for g in grants
    ]

    ai_service = AIService(current_user.api_key_encrypted)
    questionnaire = await ai_service.generate_questionnaire(grants_data)

    return {"questions": questionnaire}
