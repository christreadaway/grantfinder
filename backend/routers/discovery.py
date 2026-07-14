"""
Grant Discovery router for GrantFinder AI.

Endpoints that make the grant database comprehensive without requiring the
user to build a spreadsheet by hand:
- POST /api/discovery/seed        -> load the built-in curated grant database
- POST /api/discovery/grants-gov  -> pull matching federal opportunities from Grants.gov
- POST /api/discovery/web-search  -> AI web discovery tailored to the org profile
- GET  /api/discovery/sources     -> what each source contributed
"""
from fastapi import APIRouter, HTTPException, Depends
import logging

from models.schemas import (
    DiscoveryResult, DiscoverySource,
    GrantsGovSearchRequest, WebDiscoveryRequest,
)
from routers.auth import get_current_user, get_user_api_key, User
from routers.grants import grants_db, foundations_db
from services import discovery_service
from state import get_profile

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/seed", response_model=DiscoveryResult)
async def load_starter_database(current_user: User = Depends(get_current_user)):
    """
    Load the built-in curated grant database (national Catholic funders,
    secular grants faith-based orgs qualify for, and TX-focused foundations).
    Merges with any grants already uploaded - safe to run more than once.
    """
    try:
        seed_grants, seed_foundations = discovery_service.load_seed_grants(current_user.id)
    except Exception as e:
        logger.error(f"Failed to load seed grants: {e}")
        raise HTTPException(status_code=500, detail="Failed to load starter database")

    current = grants_db.setdefault(current_user.id, [])
    _, added, duplicates = discovery_service.merge_grants(current, seed_grants)

    # Merge foundations by name
    existing_foundations = foundations_db.setdefault(current_user.id, [])
    existing_names = {f.foundation_name.lower() for f in existing_foundations}
    for foundation in seed_foundations:
        if foundation.foundation_name.lower() not in existing_names:
            existing_foundations.append(foundation)
            existing_names.add(foundation.foundation_name.lower())

    return DiscoveryResult(
        source=DiscoverySource.SEED,
        found=len(seed_grants),
        added=added,
        duplicates=duplicates,
        total_grants=len(current),
        notes=[f"Starter database also added {len(seed_foundations)} foundations to monitor"],
    )


@router.post("/grants-gov", response_model=DiscoveryResult)
async def search_grants_gov(
    request: GrantsGovSearchRequest = GrantsGovSearchRequest(),
    current_user: User = Depends(get_current_user),
):
    """
    Search Grants.gov (free federal API) for open and forecasted opportunities.
    Keywords are derived from the organization profile unless provided.
    """
    profile = get_profile(current_user.id)
    keywords = request.keywords or discovery_service.build_grants_gov_keywords(profile)

    try:
        found_grants, notes = await discovery_service.search_grants_gov(
            user_id=current_user.id,
            keywords=keywords,
            max_results=request.max_results,
        )
    except Exception as e:
        logger.error(f"Grants.gov discovery error: {e}")
        raise HTTPException(status_code=502, detail=f"Grants.gov search failed: {e}")

    current = grants_db.setdefault(current_user.id, [])
    _, added, duplicates = discovery_service.merge_grants(current, found_grants)

    return DiscoveryResult(
        source=DiscoverySource.GRANTS_GOV,
        found=len(found_grants),
        added=added,
        duplicates=duplicates,
        total_grants=len(current),
        notes=notes,
    )


@router.post("/web-search", response_model=DiscoveryResult)
async def web_discovery(
    request: WebDiscoveryRequest = WebDiscoveryRequest(),
    current_user: User = Depends(get_current_user),
):
    """
    AI web discovery: Claude searches the web for current grant opportunities
    tailored to the organization profile. Requires the user's Claude API key.
    """
    api_key = get_user_api_key(current_user.id)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Claude API key not set. Please add your API key first.",
        )

    profile = get_profile(current_user.id)

    try:
        found_grants, notes = await discovery_service.discover_grants_via_web(
            api_key=api_key,
            user_id=current_user.id,
            profile=profile,
            focus=request.focus,
        )
    except Exception as e:
        logger.error(f"Web discovery error: {e}")
        raise HTTPException(status_code=502, detail=f"Web discovery failed: {e}")

    current = grants_db.setdefault(current_user.id, [])
    _, added, duplicates = discovery_service.merge_grants(current, found_grants)

    return DiscoveryResult(
        source=DiscoverySource.WEB_DISCOVERY,
        found=len(found_grants),
        added=added,
        duplicates=duplicates,
        total_grants=len(current),
        notes=notes,
    )


@router.get("/sources")
async def get_discovery_sources(current_user: User = Depends(get_current_user)):
    """Summarize where the user's grants came from."""
    user_grants = grants_db.get(current_user.id, [])
    by_source: dict = {}
    for grant in user_grants:
        source = getattr(grant, "source", "upload") or "upload"
        by_source[source] = by_source.get(source, 0) + 1

    return {
        "total_grants": len(user_grants),
        "by_source": by_source,
        "available_sources": [
            {
                "id": "seed",
                "name": "Starter Database",
                "description": "Curated Catholic and faith-eligible grants built into GrantFinder",
                "requires_api_key": False,
            },
            {
                "id": "grants_gov",
                "name": "Grants.gov Federal Search",
                "description": "Live search of open and forecasted federal opportunities",
                "requires_api_key": False,
            },
            {
                "id": "web_discovery",
                "name": "AI Web Discovery",
                "description": "Claude searches the web for grants matching your profile",
                "requires_api_key": True,
            },
        ],
    }
