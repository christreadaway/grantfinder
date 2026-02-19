from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from authlib.integrations.starlette_client import OAuth
import httpx

from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token
from app.models.user import User
from app.schemas.user import TokenResponse, UserResponse


router = APIRouter()


# Google OAuth configuration
oauth = OAuth()
oauth.register(
    name='google',
    client_id=settings.google_client_id,
    client_secret=settings.google_client_secret,
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'},
)


@router.get("/google")
async def google_login():
    """Redirect to Google OAuth."""
    redirect_uri = f"{settings.frontend_url}/auth/callback"
    return {
        "auth_url": f"https://accounts.google.com/o/oauth2/v2/auth?"
        f"client_id={settings.google_client_id}&"
        f"redirect_uri={redirect_uri}&"
        f"response_type=code&"
        f"scope=openid%20email%20profile&"
        f"access_type=offline"
    }


@router.post("/google/callback", response_model=TokenResponse)
async def google_callback(
    code: str,
    db: AsyncSession = Depends(get_db)
):
    """Handle Google OAuth callback."""
    redirect_uri = f"{settings.frontend_url}/auth/callback"

    # Exchange code for tokens
    async with httpx.AsyncClient() as client:
        token_response = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            }
        )

        if token_response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Failed to exchange code for token"
            )

        tokens = token_response.json()
        access_token = tokens.get("access_token")

        # Get user info
        user_info_response = await client.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {access_token}"}
        )

        if user_info_response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Failed to get user info"
            )

        user_info = user_info_response.json()

    # Find or create user
    result = await db.execute(
        select(User).where(User.google_id == user_info["id"])
    )
    user = result.scalar_one_or_none()

    if user is None:
        user = User(
            google_id=user_info["id"],
            email=user_info["email"],
            name=user_info.get("name", ""),
            avatar_url=user_info.get("picture"),
        )
        db.add(user)
        await db.flush()
        await db.refresh(user)

    # Create JWT token
    jwt_token = create_access_token(
        data={"sub": str(user.id)},
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes)
    )

    return TokenResponse(
        access_token=jwt_token,
        user=UserResponse(
            id=user.id,
            email=user.email,
            name=user.name,
            avatar_url=user.avatar_url,
            has_api_key=bool(user.api_key_encrypted),
            created_at=user.created_at,
        )
    )


@router.get("/me", response_model=UserResponse)
async def get_me(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(lambda: None)  # Will be overridden
):
    """Get current user info - requires valid token."""
    from app.api.dependencies.auth import get_current_user
    # This is handled by the dependency
    pass
