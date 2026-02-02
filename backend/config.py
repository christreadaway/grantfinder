"""
Configuration settings for GrantFinder AI Backend.
"""
from pydantic_settings import BaseSettings
from pydantic import field_validator
from typing import List
import os
import secrets
import hashlib
import base64


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Application
    APP_NAME: str = "GrantFinder AI"
    APP_VERSION: str = "2.6.0"
    DEBUG: bool = False

    # Security - SECRET_KEY is required, no insecure default
    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days

    # CORS
    CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    # Supabase
    SUPABASE_URL: str = ""
    SUPABASE_KEY: str = ""

    # Google OAuth - Required for production
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""

    # File Upload
    MAX_UPLOAD_SIZE: int = 10 * 1024 * 1024  # 10 MB
    ALLOWED_EXTENSIONS: List[str] = [".pdf", ".docx", ".txt", ".xlsx"]

    # AI Processing
    MAX_QUESTIONNAIRE_QUESTIONS: int = 20

    # Rate Limiting
    RATE_LIMIT_REQUESTS: int = 100  # requests per window
    RATE_LIMIT_WINDOW: int = 60  # seconds

    @field_validator("SECRET_KEY", mode="before")
    @classmethod
    def validate_secret_key(cls, v: str) -> str:
        """Ensure SECRET_KEY is set and secure."""
        if not v or v == "your-secret-key-change-in-production":
            # Generate a secure random key for development only
            import warnings
            warnings.warn(
                "SECRET_KEY not set! Generating random key. "
                "Set SECRET_KEY environment variable for production.",
                RuntimeWarning
            )
            return secrets.token_urlsafe(32)
        if len(v) < 32:
            raise ValueError("SECRET_KEY must be at least 32 characters")
        return v

    def get_encryption_key(self) -> bytes:
        """Derive a Fernet-compatible encryption key from SECRET_KEY."""
        # Create a 32-byte key for Fernet
        key = hashlib.sha256(self.SECRET_KEY.encode()).digest()
        return base64.urlsafe_b64encode(key)

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
