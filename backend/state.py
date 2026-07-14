"""
Shared state module for GrantFinder AI.
Centralizes in-memory storage to avoid circular imports.
In production, replace with Supabase database.
"""
from typing import Dict, List, Optional
from models.schemas import OrganizationProfile, MatchResults

# User profiles storage: user_id -> OrganizationProfile
profiles_db: Dict[str, OrganizationProfile] = {}

# Match results storage: session_id -> MatchResults
match_results_db: Dict[str, MatchResults] = {}

# =============================================================================
# GrantWriter module state
# =============================================================================
# application_id -> Application
applications_db: Dict[str, object] = {}
# grant_id -> GrantSpec (enriches, never forks, the grant record)
grant_specs_db: Dict[str, object] = {}
# application_id -> FitAnalysis
fit_analyses_db: Dict[str, object] = {}
# application_id -> {gap_id -> Gap}
gaps_db: Dict[str, Dict[str, object]] = {}
# application_id -> {request_id -> IntakeRequest}
intake_requests_db: Dict[str, Dict[str, object]] = {}
# application_id -> {section_id -> SectionDraft}
section_drafts_db: Dict[str, Dict[str, object]] = {}
# application_id -> Scorecard (latest)
scorecards_db: Dict[str, object] = {}
# AI call logs (bounded ring buffer), newest last
ai_call_logs: List[object] = []
AI_CALL_LOG_LIMIT = 2000


def get_profile(user_id: str) -> Optional[OrganizationProfile]:
    """Get user's organization profile."""
    return profiles_db.get(user_id)


def set_profile(user_id: str, profile: OrganizationProfile) -> None:
    """Store user's organization profile."""
    profiles_db[user_id] = profile


def delete_profile(user_id: str) -> None:
    """Delete user's organization profile."""
    if user_id in profiles_db:
        del profiles_db[user_id]


def get_match_results(session_id: str) -> Optional[MatchResults]:
    """Get match results by session ID."""
    return match_results_db.get(session_id)


def store_match_results(session_id: str, results: MatchResults) -> None:
    """Store match results for later export."""
    match_results_db[session_id] = results


def get_user_match_sessions(user_id: str) -> Dict[str, MatchResults]:
    """Get all match results for a user."""
    return {
        sid: results
        for sid, results in match_results_db.items()
        if results.user_id == user_id
    }
