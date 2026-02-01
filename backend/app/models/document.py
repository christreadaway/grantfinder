from datetime import datetime
from typing import Optional
from sqlalchemy import String, DateTime, Text, ForeignKey, JSON, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Document(Base):
    """Uploaded document for context extraction."""
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)

    filename: Mapped[str] = mapped_column(String(255))
    file_type: Mapped[str] = mapped_column(String(50))  # "pdf", "docx", "txt"
    file_size: Mapped[int] = mapped_column(Integer)

    # Extracted content
    extracted_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    extracted_needs: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # Processing status
    status: Mapped[str] = mapped_column(String(50), default="pending")  # "pending", "processing", "completed", "failed"
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    processed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    organization = relationship("Organization", back_populates="documents")
