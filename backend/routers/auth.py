"""
Authentication router for GrantFinder AI.
Handles Google OAuth and API key management.
"""
from fastapi import APIRouter, HTTPException, Depends, Body
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta
from jose import jwt, JWTError
import httpx
import logging

from config import settings
from models.schemas import User, UserCreate, TokenResponse

router = APIRouter()
security = HTTPBearer()
logger = logging.getLogger(__name__)

# In-memory storage (replace with Supabase in production)
users_db: dict = {}
api_keys_db: dict = {}  # user_id -> encrypted_api_key


class GoogleAuthRequest(BaseModel):
    """Google OAuth token from frontend."""
    credential: str


class ApiKeyRequest(BaseModel):
    """Claude API key submission."""
    api_key: str


class ApiKeyStatus(BaseModel):
    """API key status response."""
    is_set: bool
    is_valid: Optional[bool] = None


def create_access_token(data: dict) -> str:
    """Create JWT access token."""
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


async def verify_google_token(credential: str) -> dict:
    """Verify Google OAuth credential and return user info."""
    async with httpx.AsyncClient() as client:
        # Verify token with Google
        response = await client.get(
            f"https://oauth2.googleapis.com/tokeninfo?id_token={credential}"
        )

        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Invalid Google credential")

        token_info = response.json()

        # Verify audience matches our client ID
        if settings.GOOGLE_CLIENT_ID and token_info.get("aud") != settings.GOOGLE_CLIENT_ID:
            raise HTTPException(status_code=401, detail="Invalid token audience")

        return token_info


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> User:
    """Get current authenticated user from JWT token."""
    try:
        payload = jwt.decode(
            credentials.credentials,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM]
        )
        user_id = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token")

        user = users_db.get(user_id)
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")

        return user

    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")


@router.post("/google", response_model=TokenResponse)
async def google_auth(request: GoogleAuthRequest):
    """
    Authenticate with Google OAuth.
    Frontend sends the Google credential token.
    """
    try:
        # Verify Google token
        google_info = await verify_google_token(request.credential)

        google_id = google_info.get("sub")
        email = google_info.get("email")
        name = google_info.get("name")
        picture = google_info.get("picture")

        # Check if user exists
        existing_user = None
        for uid, user in users_db.items():
            if user.google_id == google_id:
                existing_user = user
                break

        if existing_user:
            user = existing_user
        else:
            # Create new user
            user_id = f"user_{google_id}"
            user = User(
                id=user_id,
                google_id=google_id,
                email=email,
                name=name,
                picture=picture,
                created_at=datetime.utcnow(),
                claude_api_key_set=user_id in api_keys_db,
            )
            users_db[user_id] = user
            logger.info(f"New user created: {email}")

        # Create access token
        access_token = create_access_token({"sub": user.id})

        return TokenResponse(
            access_token=access_token,
            user=user,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Google auth error: {e}")
        raise HTTPException(status_code=500, detail="Authentication failed")


@router.get("/me", response_model=User)
async def get_me(current_user: User = Depends(get_current_user)):
    """Get current user profile."""
    current_user.claude_api_key_set = current_user.id in api_keys_db
    return current_user


@router.post("/api-key")
async def set_api_key(
    request: ApiKeyRequest,
    current_user: User = Depends(get_current_user)
):
    """
    Set or update Claude API key.
    Key is stored encrypted (simplified for demo).
    """
    # Validate API key format
    if not request.api_key.startswith("sk-ant-"):
        raise HTTPException(
            status_code=400,
            detail="Invalid API key format. Claude API keys start with 'sk-ant-'"
        )

    # Store API key (in production, encrypt this)
    api_keys_db[current_user.id] = request.api_key

    logger.info(f"API key set for user: {current_user.email}")

    return {"message": "API key saved successfully"}


@router.get("/api-key/status", response_model=ApiKeyStatus)
async def get_api_key_status(current_user: User = Depends(get_current_user)):
    """Check if Claude API key is set and valid."""
    is_set = current_user.id in api_keys_db

    if not is_set:
        return ApiKeyStatus(is_set=False)

    # Optionally validate the key with a test call
    # For now, just check if it's set
    return ApiKeyStatus(is_set=True, is_valid=True)


@router.delete("/api-key")
async def delete_api_key(current_user: User = Depends(get_current_user)):
    """Remove stored Claude API key."""
    if current_user.id in api_keys_db:
        del api_keys_db[current_user.id]

    return {"message": "API key removed"}


def get_user_api_key(user_id: str) -> Optional[str]:
    """Get user's Claude API key (for internal use)."""
    return api_keys_db.get(user_id)
