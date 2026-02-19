from datetime import datetime
from typing import Optional
from sqlalchemy import String, DateTime, Text, ForeignKey, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))

    # Website URLs
    church_website: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    school_website: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # Extracted data from website
    website_extracted: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Questionnaire answers
    questionnaire_answers: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Free-form notes
    free_form_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Extracted needs from documents
    extracted_needs: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # Full profile JSON
    profile_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="organizations")
    documents = relationship("Document", back_populates="organization", cascade="all, delete-orphan")
    matching_sessions = relationship("MatchingSession", back_populates="organization", cascade="all, delete-orphan")
