from datetime import datetime
from typing import Optional
from sqlalchemy import String, DateTime, Text, ForeignKey, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class MatchingSession(Base):
    """A grant matching session with inputs and results."""
    __tablename__ = "matching_sessions"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    organization_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)

    # Inputs used for this session
    inputs_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Profile generated for matching
    profile_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Match results
    results_json: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Statistics
    grants_evaluated: Mapped[Optional[int]] = mapped_column(default=0)
    excellent_matches: Mapped[Optional[int]] = mapped_column(default=0)
    good_matches: Mapped[Optional[int]] = mapped_column(default=0)
    possible_matches: Mapped[Optional[int]] = mapped_column(default=0)

    # Processing status
    status: Mapped[str] = mapped_column(String(50), default="pending")  # "pending", "processing", "completed", "failed"

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    organization = relationship("Organization", back_populates="matching_sessions")
