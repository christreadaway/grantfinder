"""
Grant Discovery Service for GrantFinder AI.

Three ways grants enter the database beyond a user-uploaded Excel:
1. Seed database  - curated starter set of Catholic/parochial grant opportunities
2. Grants.gov     - live federal opportunity search (free public API, no key needed)
3. Web discovery  - Claude with web search finds grants matching the org profile

All sources merge into the user's grant list with name+funder deduplication,
so re-running discovery is safe and additive.
"""
import json
import logging
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import anthropic
import httpx

from config import settings
from models.schemas import (
    Foundation, Grant, GrantCategory, GrantStatus, GeoQualified,
    OrganizationProfile,
)

logger = logging.getLogger(__name__)

SEED_FILE = Path(__file__).resolve().parent.parent / "data" / "seed_grants.json"

# Default Grants.gov search terms for a Catholic parish/school when the
# profile doesn't give us anything more specific.
DEFAULT_GRANTS_GOV_KEYWORDS = [
    "nonprofit security",
    "private school education",
    "faith-based community",
]


def _dedup_key(grant_name: str, funder: str) -> str:
    """Normalize name+funder into a stable dedup key."""
    combined = f"{grant_name}|{funder}".lower()
    return re.sub(r"[^a-z0-9|]", "", combined)


def existing_keys(grants: List[Grant]) -> set:
    return {_dedup_key(g.grant_name, g.funder) for g in grants}


def merge_grants(
    current: List[Grant],
    incoming: List[Grant],
) -> Tuple[List[Grant], int, int]:
    """
    Merge incoming grants into current list, skipping duplicates.
    Returns (merged_list, added_count, duplicate_count).
    """
    keys = existing_keys(current)
    added = 0
    duplicates = 0
    for grant in incoming:
        key = _dedup_key(grant.grant_name, grant.funder)
        if key in keys:
            duplicates += 1
            continue
        keys.add(key)
        current.append(grant)
        added += 1
    return current, added, duplicates


def _parse_category(value: str) -> GrantCategory:
    try:
        return GrantCategory(value)
    except ValueError:
        return GrantCategory.NON_CATHOLIC_QUALIFYING


def _parse_geo(value: Optional[str]) -> GeoQualified:
    if not value:
        return GeoQualified.CHECK
    try:
        return GeoQualified(value)
    except ValueError:
        upper = str(value).upper()
        if "TX" in upper or "TEXAS" in upper:
            return GeoQualified.TX_ONLY
        if upper in ("YES", "Y", "TRUE"):
            return GeoQualified.YES
        if upper in ("NO", "N", "FALSE"):
            return GeoQualified.NO
        return GeoQualified.CHECK


def _parse_status(value: Optional[str]) -> GrantStatus:
    if not value:
        return GrantStatus.CHECK_DEADLINE
    try:
        return GrantStatus(value)
    except ValueError:
        upper = str(value).upper()
        if "OPEN" in upper or "POSTED" in upper:
            return GrantStatus.OPEN
        if "ROLL" in upper:
            return GrantStatus.ROLLING
        if "CLOSE" in upper:
            return GrantStatus.CLOSED
        return GrantStatus.CHECK_DEADLINE


def _make_grant(
    user_id: str,
    source: str,
    data: Dict[str, Any],
    default_category: GrantCategory = GrantCategory.NON_CATHOLIC_QUALIFYING,
) -> Optional[Grant]:
    """Build a Grant from a loose dict, tolerating missing fields."""
    name = str(data.get("grant_name") or data.get("name") or "").strip()
    if not name:
        return None
    return Grant(
        id=f"grant_{uuid.uuid4().hex[:12]}",
        user_id=user_id,
        grant_name=name,
        deadline=str(data.get("deadline") or "Check website"),
        amount=str(data.get("amount") or "Varies"),
        funder=str(data.get("funder") or "Unknown"),
        description=str(data.get("description") or ""),
        contact=str(data.get("contact") or "See website"),
        url=str(data.get("url") or ""),
        status=_parse_status(data.get("status")),
        geo_qualified=_parse_geo(data.get("geo_qualified")),
        funder_stats=data.get("funder_stats"),
        category=_parse_category(str(data.get("category") or default_category.value)),
        source=source,
        eligibility_notes=data.get("eligibility_notes"),
        funds_for=list(data.get("funds_for") or []),
        created_at=datetime.utcnow(),
    )


# =============================================================================
# Source 1: Seed database
# =============================================================================

def load_seed_grants(user_id: str) -> Tuple[List[Grant], List[Foundation]]:
    """Load the built-in curated grant database."""
    with open(SEED_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    grants = []
    for entry in data.get("grants", []):
        grant = _make_grant(user_id, "seed", entry)
        if grant:
            grants.append(grant)

    foundations = []
    for entry in data.get("foundations", []):
        try:
            foundations.append(Foundation(
                id=f"foundation_{uuid.uuid4().hex[:12]}",
                user_id=user_id,
                foundation_name=entry["foundation_name"],
                application_cycle=entry.get("application_cycle", "Check website"),
                focus_areas=entry.get("focus_areas", ""),
                location=entry.get("location", ""),
                contact=entry.get("contact", "See website"),
                website=entry.get("website", ""),
                annual_giving=entry.get("annual_giving", ""),
                notes=entry.get("notes"),
                created_at=datetime.utcnow(),
            ))
        except Exception as e:
            logger.warning(f"Skipping seed foundation entry: {e}")

    logger.info(f"Loaded {len(grants)} seed grants, {len(foundations)} foundations")
    return grants, foundations


# =============================================================================
# Source 2: Grants.gov federal opportunity search
# =============================================================================

def build_grants_gov_keywords(profile: Optional[OrganizationProfile]) -> List[str]:
    """Derive Grants.gov search keywords from the organization profile."""
    keywords = list(DEFAULT_GRANTS_GOV_KEYWORDS)
    if profile:
        if profile.security_concerns:
            keywords.insert(0, "nonprofit security grant")
        if profile.facility_needs:
            keywords.append("community facilities")
        if profile.has_food_pantry:
            keywords.append("food assistance nonprofit")
        if profile.has_school and profile.program_needs:
            keywords.append("K-12 education program")
    # Dedup while preserving order
    seen = set()
    result = []
    for k in keywords:
        if k not in seen:
            seen.add(k)
            result.append(k)
    return result[:6]


async def search_grants_gov(
    user_id: str,
    keywords: List[str],
    max_results: Optional[int] = None,
) -> Tuple[List[Grant], List[str]]:
    """
    Search the Grants.gov Search2 API (public, no key required) for open and
    forecasted federal opportunities matching the keywords.
    """
    max_results = max_results or settings.GRANTS_GOV_MAX_RESULTS
    per_keyword = max(10, max_results // max(len(keywords), 1))
    grants: List[Grant] = []
    notes: List[str] = []
    seen_ids: set = set()

    async with httpx.AsyncClient(timeout=30.0) as client:
        for keyword in keywords:
            try:
                response = await client.post(
                    settings.GRANTS_GOV_API_URL,
                    json={
                        "keyword": keyword,
                        "oppStatuses": "forecasted|posted",
                        "rows": per_keyword,
                        "startRecordNum": 0,
                    },
                )
                response.raise_for_status()
                payload = response.json()
            except Exception as e:
                logger.warning(f"Grants.gov search failed for '{keyword}': {e}")
                notes.append(f"Search '{keyword}' failed: {e}")
                continue

            hits = (payload.get("data") or {}).get("oppHits") or []
            notes.append(f"Search '{keyword}': {len(hits)} results")

            for hit in hits:
                opp_id = str(hit.get("id") or "")
                if not opp_id or opp_id in seen_ids:
                    continue
                seen_ids.add(opp_id)

                title = str(hit.get("title") or "").strip()
                if not title:
                    continue

                close_date = hit.get("closeDate") or "Check website"
                status = str(hit.get("oppStatus") or "")
                agency = str(hit.get("agencyName") or hit.get("agency") or "Federal Agency")

                grants.append(Grant(
                    id=f"grant_{uuid.uuid4().hex[:12]}",
                    user_id=user_id,
                    grant_name=title,
                    deadline=str(close_date),
                    amount="See listing",
                    funder=agency,
                    description=(
                        f"Federal opportunity {hit.get('number', '')} "
                        f"(matched search: '{keyword}'). See Grants.gov listing for full details."
                    ).strip(),
                    contact="See Grants.gov listing",
                    url=f"https://www.grants.gov/search-results-detail/{opp_id}",
                    status=_parse_status(status),
                    geo_qualified=GeoQualified.CHECK,
                    category=GrantCategory.NON_CATHOLIC_QUALIFYING,
                    source="grants_gov",
                    eligibility_notes="Federal grant - verify nonprofit/faith-based eligibility in the listing.",
                    funds_for=[],
                    created_at=datetime.utcnow(),
                ))

    logger.info(f"Grants.gov discovery found {len(grants)} opportunities")
    return grants, notes


# =============================================================================
# Source 3: AI web discovery (Claude + web search)
# =============================================================================

WEB_DISCOVERY_SCHEMA_HINT = """[
  {
    "grant_name": "Name of the grant program",
    "funder": "Funding organization",
    "category": "church_parish | catholic_school | mixed | non_catholic",
    "deadline": "YYYY-MM-DD, 'Rolling', or 'Check website'",
    "amount": "e.g. 'Up to $15,000' or 'Varies'",
    "description": "1-3 sentences on what it funds and who qualifies",
    "eligibility_notes": "Key requirements/restrictions",
    "url": "Direct link to the grant page",
    "geo_qualified": "Yes | No | Check eligibility",
    "funds_for": ["tags", "like", "facilities"]
  }
]"""


def _extract_json_array(text: str) -> Optional[List[Dict[str, Any]]]:
    """Leniently pull the first JSON array out of a model response."""
    # Strip code fences if present
    fenced = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", text, re.DOTALL)
    candidate = fenced.group(1) if fenced else None
    if candidate is None:
        start = text.find("[")
        end = text.rfind("]")
        if start == -1 or end == -1 or end <= start:
            return None
        candidate = text[start:end + 1]
    try:
        parsed = json.loads(candidate)
        return parsed if isinstance(parsed, list) else None
    except json.JSONDecodeError:
        return None


async def discover_grants_via_web(
    api_key: str,
    user_id: str,
    profile: Optional[OrganizationProfile],
    focus: Optional[str] = None,
) -> Tuple[List[Grant], List[str]]:
    """
    Use Claude with the server-side web search tool to find current grant
    opportunities tailored to this organization's profile.
    """
    client = anthropic.AsyncAnthropic(api_key=api_key)

    profile_lines = []
    if profile:
        profile_lines = [
            f"- Organization: {profile.organization_name or 'Catholic parish/school'}",
            f"- Type: {profile.organization_type}" + (" with school" if profile.has_school else ""),
            f"- Location: {profile.city}, {profile.state}" if profile.state else "- Location: unknown",
            f"- Diocese: {profile.diocese}" if profile.diocese else "",
            f"- Facility needs: {', '.join(profile.facility_needs[:5])}" if profile.facility_needs else "",
            f"- Program needs: {', '.join(profile.program_needs[:5])}" if profile.program_needs else "",
            f"- Security concerns: {', '.join(profile.security_concerns[:3])}" if profile.security_concerns else "",
            f"- Notes: {profile.free_form_notes[:500]}" if profile.free_form_notes else "",
        ]
        profile_lines = [line for line in profile_lines if line]

    profile_text = "\n".join(profile_lines) or "- A Catholic parish and/or Catholic school in the United States"
    focus_text = f"\nEXTRA FOCUS: prioritize opportunities related to: {focus}" if focus else ""

    prompt = f"""You are a grant researcher for Catholic parishes and schools. Search the web to find CURRENT, real grant opportunities this organization could apply for.

ORGANIZATION PROFILE:
{profile_text}
{focus_text}

Search for:
1. National Catholic foundations and grant programs currently accepting applications
2. State/regional foundations in the organization's state
3. Corporate and secular grants that faith-based schools/churches qualify for (education, facilities, security, technology, hunger relief)
4. Government programs the organization is eligible for

Rules:
- Only include grants you found real evidence for on the web (a funder page or credible listing). Never invent grants, amounts, or deadlines.
- If you can't verify a deadline, use "Check website".
- Include the direct URL you found for each grant.
- Aim for 8-15 high-quality opportunities.

After searching, return ONLY a JSON array in exactly this shape (no other text after it):
{WEB_DISCOVERY_SCHEMA_HINT}"""

    notes: List[str] = []
    try:
        response = await client.messages.create(
            model=settings.CLAUDE_MODEL,
            max_tokens=8000,
            tools=[{
                "type": "web_search_20260209",
                "name": "web_search",
                "max_uses": settings.WEB_DISCOVERY_MAX_SEARCHES,
            }],
            messages=[{"role": "user", "content": prompt}],
        )
    except anthropic.BadRequestError as e:
        # Older accounts/models may not support the newest web search variant;
        # retry once with the basic variant before giving up.
        logger.warning(f"Web discovery with web_search_20260209 failed, retrying basic variant: {e}")
        notes.append("Retried with basic web search tool")
        response = await client.messages.create(
            model=settings.CLAUDE_MODEL,
            max_tokens=8000,
            tools=[{
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": settings.WEB_DISCOVERY_MAX_SEARCHES,
            }],
            messages=[{"role": "user", "content": prompt}],
        )

    # Collect all text output (final text block carries the JSON)
    text_parts = [block.text for block in response.content if block.type == "text"]
    full_text = "\n".join(text_parts)
    search_count = sum(1 for block in response.content if block.type == "server_tool_use")
    notes.append(f"Ran {search_count} web searches")

    entries = _extract_json_array(full_text)
    if not entries:
        logger.warning("Web discovery returned no parseable grant list")
        notes.append("No parseable grant list in AI response")
        return [], notes

    grants: List[Grant] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        grant = _make_grant(user_id, "web_discovery", entry)
        if grant:
            grants.append(grant)

    logger.info(f"Web discovery found {len(grants)} grants")
    notes.append(f"AI verified {len(grants)} opportunities")
    return grants, notes
