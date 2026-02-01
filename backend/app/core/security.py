from datetime import datetime, timedelta
from typing import Optional
import base64
import hashlib

from jose import jwt, JWTError
from cryptography.fernet import Fernet

from app.core.config import settings


def get_fernet() -> Fernet:
    """Get Fernet instance for encryption/decryption."""
    # Ensure key is exactly 32 bytes, then base64 encode
    key = settings.encryption_key.encode()[:32].ljust(32, b'\0')
    key_b64 = base64.urlsafe_b64encode(key)
    return Fernet(key_b64)


def encrypt_api_key(api_key: str) -> str:
    """Encrypt an API key for storage."""
    f = get_fernet()
    return f.encrypt(api_key.encode()).decode()


def decrypt_api_key(encrypted_key: str) -> str:
    """Decrypt a stored API key."""
    f = get_fernet()
    return f.decrypt(encrypted_key.encode()).decode()


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create a JWT access token."""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.access_token_expire_minutes)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)
    return encoded_jwt


def verify_token(token: str) -> Optional[dict]:
    """Verify and decode a JWT token."""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        return payload
    except JWTError:
        return None
