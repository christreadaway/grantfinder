from typing import List, Optional
from datetime import datetime

from app.services.ai_service import AIService
from app.services.grant_service import GrantService
from app.schemas.grant import GrantMatch, MatchResult


class MatchingService:
    """Service for matching organizations to grants."""

    def __init__(self, ai_service: AIService):
        self.ai_service = ai_service

    async def perform_matching(
        self,
        profile: dict,
        grants: List[dict],
        session_id: int
    ) -> MatchResult:
        """
        Perform grant matching and return categorized results.
        """
        # Get AI-generated matches
        raw_matches = await self.ai_service.match_grants(profile, grants)

        # Process and categorize matches
        excellent_matches = []
        good_matches = []
        possible_matches = []
        weak_matches = []
        not_eligible = []

        for match in raw_matches:
            grant_match = self._process_match(match, grants)

            if grant_match.score >= 85:
                excellent_matches.append(grant_match)
            elif grant_match.score >= 70:
                good_matches.append(grant_match)
            elif grant_match.score >= 50:
                possible_matches.append(grant_match)
            elif grant_match.score >= 25:
                weak_matches.append(grant_match)
            else:
                not_eligible.append(grant_match)

        return MatchResult(
            session_id=session_id,
            grants_evaluated=len(grants),
            excellent_matches=excellent_matches,
            good_matches=good_matches,
            possible_matches=possible_matches,
            weak_matches=weak_matches,
            not_eligible=not_eligible,
            created_at=datetime.utcnow()
        )

    def _process_match(self, raw_match: dict, grants: List[dict]) -> GrantMatch:
        """Process a raw match into a GrantMatch object."""
        # Find the original grant for additional info
        grant_id = raw_match.get("grant_id")
        original_grant = None

        for g in grants:
            if str(g.get("id")) == str(grant_id) or g.get("name") == raw_match.get("grant_name"):
                original_grant = g
                break

        # Get score breakdown
        breakdown = raw_match.get("score_breakdown", {})

        # Format amount and deadline
        amount_display = "Varies"
        deadline_display = "TBD"
        deadline_urgent = raw_match.get("deadline_urgent", False)

        if original_grant:
            amount_display = GrantService.format_amount_display(
                original_grant.get("amount_min"),
                original_grant.get("amount_max")
            )
            deadline_display, deadline_urgent = GrantService.format_deadline_display(
                original_grant.get("deadline"),
                original_grant.get("deadline_type")
            )

        # Determine score label
        score = raw_match.get("score", 0)
        if score >= 85:
            score_label = "excellent"
        elif score >= 70:
            score_label = "good"
        elif score >= 50:
            score_label = "possible"
        elif score >= 25:
            score_label = "weak"
        else:
            score_label = "not_eligible"

        return GrantMatch(
            grant_id=grant_id if isinstance(grant_id, int) else 0,
            grant_name=raw_match.get("grant_name", "Unknown Grant"),
            granting_authority=original_grant.get("granting_authority") if original_grant else None,
            score=score,
            score_label=score_label,
            amount_display=amount_display,
            deadline_display=deadline_display,
            deadline_urgent=deadline_urgent,
            why_it_fits=raw_match.get("why_it_fits", ""),
            eligibility_notes=raw_match.get("eligibility_notes", []),
            verify_items=raw_match.get("verify_items", []),
            apply_url=original_grant.get("apply_url") if original_grant else None,
            eligibility_score=breakdown.get("eligibility", 0),
            need_alignment_score=breakdown.get("need_alignment", 0),
            capacity_score=breakdown.get("capacity", 0),
            timing_score=breakdown.get("timing", 0),
            completeness_score=breakdown.get("completeness", 0)
        )

    @staticmethod
    def get_score_emoji(score: int) -> str:
        """Get emoji for score display."""
        if score >= 85:
            return "🟢"
        elif score >= 70:
            return "🟡"
        elif score >= 50:
            return "🟠"
        elif score >= 25:
            return "🔴"
        else:
            return "⚫"

    @staticmethod
    def get_score_category(score: int) -> str:
        """Get category name for score."""
        if score >= 85:
            return "Excellent Match"
        elif score >= 70:
            return "Good Match"
        elif score >= 50:
            return "Possible Match"
        elif score >= 25:
            return "Weak Match"
        else:
            return "Not Eligible"
