from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import encrypt_api_key
from app.api.dependencies.auth import get_current_user
from app.models.user import User
from app.schemas.user import UserResponse, UserUpdate


router = APIRouter()


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    current_user: User = Depends(get_current_user)
):
    """Get current user information."""
    return UserResponse(
        id=current_user.id,
        email=current_user.email,
        name=current_user.name,
        avatar_url=current_user.avatar_url,
        has_api_key=bool(current_user.api_key_encrypted),
        created_at=current_user.created_at,
    )


@router.put("/me", response_model=UserResponse)
async def update_current_user(
    update: UserUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update current user information."""
    if update.name is not None:
        current_user.name = update.name

    if update.api_key is not None:
        # Validate API key format
        if not update.api_key.startswith("sk-ant-"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid API key format. Key should start with 'sk-ant-'"
            )
        current_user.api_key_encrypted = encrypt_api_key(update.api_key)

    await db.flush()
    await db.refresh(current_user)

    return UserResponse(
        id=current_user.id,
        email=current_user.email,
        name=current_user.name,
        avatar_url=current_user.avatar_url,
        has_api_key=bool(current_user.api_key_encrypted),
        created_at=current_user.created_at,
    )


@router.delete("/me/api-key")
async def delete_api_key(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Remove the stored API key."""
    current_user.api_key_encrypted = None
    await db.flush()
    return {"message": "API key removed"}
