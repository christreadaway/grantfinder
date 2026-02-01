from datetime import datetime
from typing import Optional
from pydantic import BaseModel, EmailStr


class UserCreate(BaseModel):
    google_id: str
    email: EmailStr
    name: str
    avatar_url: Optional[str] = None


class UserUpdate(BaseModel):
    name: Optional[str] = None
    api_key: Optional[str] = None


class UserResponse(BaseModel):
    id: int
    email: str
    name: str
    avatar_url: Optional[str] = None
    has_api_key: bool
    created_at: datetime

    class Config:
        from_attributes = True


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
