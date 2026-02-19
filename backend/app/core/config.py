from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # Database - defaults to SQLite for local development
    database_url: str = "sqlite+aiosqlite:///./grantfinder.db"

    # Google OAuth
    google_client_id: str = ""
    google_client_secret: str = ""

    # Security
    secret_key: str = "change-this-in-production-to-a-secure-key"
    encryption_key: str = "change-this-32-byte-encryption-key"  # Must be 32 bytes for Fernet
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 7  # 7 days

    # Frontend
    frontend_url: str = "http://localhost:3000"

    # Environment
    environment: str = "development"

    class Config:
        env_file = ".env"
        extra = "allow"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
