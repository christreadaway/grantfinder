from datetime import datetime, date
from typing import Optional
from sqlalchemy import String, DateTime, Date, Text, ForeignKey, JSON, Integer, Float
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class GrantDatabase(Base):
    """User's uploaded grant database."""
    __tablename__ = "grant_databases"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    filename: Mapped[str] = mapped_column(String(255))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    user = relationship("User", back_populates="grant_databases")
    grants = relationship("Grant", back_populates="database", cascade="all, delete-orphan")


class Grant(Base):
    """Individual grant within a database."""
    __tablename__ = "grants"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    database_id: Mapped[int] = mapped_column(ForeignKey("grant_databases.id"), index=True)

    # Core fields
    name: Mapped[str] = mapped_column(String(500))
    granting_authority: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Deadline
    deadline: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    deadline_type: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)  # "annual", "rolling", "one-time"

    # Amount
    amount_min: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    amount_max: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # Eligibility
    eligibility: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    geographic_restriction: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    # Categories and purposes
    funds_for: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    categories: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # Links
    apply_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)

    # Notes
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Full raw data from Excel
    raw_data: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # Relationships
    database = relationship("GrantDatabase", back_populates="grants")
