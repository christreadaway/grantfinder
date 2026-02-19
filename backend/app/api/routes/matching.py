from typing import List, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import json
import io

from app.core.database import get_db
from app.api.dependencies.auth import get_current_user, get_current_user_with_api_key
from app.models.user import User
from app.models.organization import Organization
from app.models.grant import GrantDatabase, Grant
from app.models.session import MatchingSession
from app.schemas.grant import MatchResult, GrantMatch
from app.services.ai_service import AIService
from app.services.matching_service import MatchingService


router = APIRouter()


@router.post("/{org_id}/match")
async def perform_matching(
    org_id: int,
    grant_database_id: int,
    current_user: User = Depends(get_current_user_with_api_key),
    db: AsyncSession = Depends(get_db)
):
    """Perform grant matching for an organization."""
    # Get organization
    result = await db.execute(
        select(Organization).where(
            Organization.id == org_id,
            Organization.user_id == current_user.id
        )
    )
    org = result.scalar_one_or_none()

    if org is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Organization not found"
        )

    if not org.profile_json:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Organization profile not generated. Please generate profile first."
        )

    # Get grant database
    result = await db.execute(
        select(GrantDatabase).where(
            GrantDatabase.id == grant_database_id,
            GrantDatabase.user_id == current_user.id
        )
    )
    grant_db = result.scalar_one_or_none()

    if grant_db is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Grant database not found"
        )

    # Get grants
    result = await db.execute(
        select(Grant).where(Grant.database_id == grant_database_id)
    )
    grants = result.scalars().all()

    if not grants:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No grants in database"
        )

    # Create matching session
    session = MatchingSession(
        organization_id=org_id,
        status="processing",
        inputs_json={
            "grant_database_id": grant_database_id,
            "grant_count": len(grants),
        },
        profile_json=org.profile_json,
    )
    db.add(session)
    await db.flush()

    async def generate_events():
        """Generate Server-Sent Events for matching process."""
        yield f"data: {json.dumps({'type': 'status', 'message': f'Loading parish profile...'})}\n\n"
        yield f"data: {json.dumps({'type': 'status', 'message': f'Loading {len(grants)} grants from database...'})}\n\n"
        yield f"data: {json.dumps({'type': 'status', 'message': 'Analyzing eligibility requirements...'})}\n\n"

        # Convert grants to dicts
        grants_data = []
        for g in grants:
            grants_data.append({
                "id": g.id,
                "name": g.name,
                "granting_authority": g.granting_authority,
                "description": g.description,
                "deadline": str(g.deadline) if g.deadline else None,
                "deadline_type": g.deadline_type,
                "amount_min": g.amount_min,
                "amount_max": g.amount_max,
                "eligibility": g.eligibility,
                "geographic_restriction": g.geographic_restriction,
                "funds_for": g.funds_for,
                "apply_url": g.apply_url,
            })

        # Perform matching
        ai_service = AIService(current_user.api_key_encrypted)
        matching_service = MatchingService(ai_service)

        yield f"data: {json.dumps({'type': 'status', 'message': 'Matching profile against grants...'})}\n\n"

        match_result = await matching_service.perform_matching(
            org.profile_json,
            grants_data,
            session.id
        )

        # Update session
        session.status = "completed"
        session.completed_at = datetime.utcnow()
        session.grants_evaluated = match_result.grants_evaluated
        session.excellent_matches = len(match_result.excellent_matches)
        session.good_matches = len(match_result.good_matches)
        session.possible_matches = len(match_result.possible_matches)
        session.results_json = {
            "excellent_matches": [m.model_dump() for m in match_result.excellent_matches],
            "good_matches": [m.model_dump() for m in match_result.good_matches],
            "possible_matches": [m.model_dump() for m in match_result.possible_matches],
            "weak_matches": [m.model_dump() for m in match_result.weak_matches],
            "not_eligible": [m.model_dump() for m in match_result.not_eligible],
        }
        await db.flush()

        # Stream individual match results
        for match in match_result.excellent_matches:
            yield f"data: {json.dumps({'type': 'match', 'category': 'excellent', 'data': match.model_dump()})}\n\n"

        for match in match_result.good_matches:
            yield f"data: {json.dumps({'type': 'match', 'category': 'good', 'data': match.model_dump()})}\n\n"

        yield f"data: {json.dumps({'type': 'status', 'message': f'Matching complete. {len(match_result.excellent_matches)} excellent, {len(match_result.good_matches)} good matches found.'})}\n\n"

        yield f"data: {json.dumps({'type': 'complete', 'session_id': session.id, 'summary': {'excellent': len(match_result.excellent_matches), 'good': len(match_result.good_matches), 'possible': len(match_result.possible_matches), 'weak': len(match_result.weak_matches), 'not_eligible': len(match_result.not_eligible)}})}\n\n"

    return StreamingResponse(
        generate_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )


@router.get("/sessions/{session_id}")
async def get_matching_session(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get a matching session and its results."""
    result = await db.execute(
        select(MatchingSession)
        .join(Organization)
        .where(
            MatchingSession.id == session_id,
            Organization.user_id == current_user.id
        )
    )
    session = result.scalar_one_or_none()

    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Matching session not found"
        )

    return {
        "id": session.id,
        "status": session.status,
        "grants_evaluated": session.grants_evaluated,
        "excellent_matches": session.excellent_matches,
        "good_matches": session.good_matches,
        "possible_matches": session.possible_matches,
        "results": session.results_json,
        "created_at": session.created_at,
        "completed_at": session.completed_at,
    }


@router.get("/sessions/{session_id}/export/{format}")
async def export_results(
    session_id: int,
    format: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Export matching results in various formats."""
    # Get session
    result = await db.execute(
        select(MatchingSession)
        .join(Organization)
        .where(
            MatchingSession.id == session_id,
            Organization.user_id == current_user.id
        )
    )
    session = result.scalar_one_or_none()

    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Matching session not found"
        )

    if not session.results_json:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No results available"
        )

    # Get organization name
    result = await db.execute(
        select(Organization).where(Organization.id == session.organization_id)
    )
    org = result.scalar_one()

    if format == "markdown":
        content = _generate_markdown_report(org.name, session)
        return Response(
            content=content,
            media_type="text/markdown",
            headers={"Content-Disposition": f"attachment; filename=grant_matches_{session_id}.md"}
        )

    elif format == "csv":
        content = _generate_csv_report(session)
        return Response(
            content=content,
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename=grant_matches_{session_id}.csv"}
        )

    elif format == "json":
        return session.results_json

    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported format. Use: markdown, csv, or json"
        )


def _generate_markdown_report(org_name: str, session: MatchingSession) -> str:
    """Generate a markdown report of match results."""
    results = session.results_json
    lines = [
        f"# Grant Matches for {org_name}",
        f"",
        f"**Generated:** {session.completed_at.strftime('%B %d, %Y') if session.completed_at else 'N/A'}",
        f"**Grants Evaluated:** {session.grants_evaluated}",
        f"",
    ]

    def format_matches(matches: List[dict], emoji: str, title: str):
        if not matches:
            return []

        section = [f"## {emoji} {title}", ""]
        for m in matches:
            section.extend([
                f"### {m['score']}% — {m['grant_name']}",
                f"**{m['amount_display']}** | **{m['deadline_display']}**",
                f"",
                f"{m['why_it_fits']}",
                f"",
            ])
            if m.get('verify_items'):
                section.append("**Verify before applying:**")
                for item in m['verify_items']:
                    section.append(f"- {item}")
                section.append("")
            if m.get('apply_url'):
                section.append(f"[Apply Here]({m['apply_url']})")
                section.append("")
            section.append("---")
            section.append("")
        return section

    lines.extend(format_matches(results.get('excellent_matches', []), "🟢", "Excellent Matches (85-100%)"))
    lines.extend(format_matches(results.get('good_matches', []), "🟡", "Good Matches (70-84%)"))
    lines.extend(format_matches(results.get('possible_matches', []), "🟠", "Possible Matches (50-69%)"))

    return "\n".join(lines)


def _generate_csv_report(session: MatchingSession) -> str:
    """Generate a CSV report of match results."""
    results = session.results_json
    lines = ["Score,Score Label,Grant Name,Authority,Amount,Deadline,Why It Fits,Apply URL"]

    all_matches = (
        results.get('excellent_matches', []) +
        results.get('good_matches', []) +
        results.get('possible_matches', []) +
        results.get('weak_matches', [])
    )

    for m in all_matches:
        # Escape CSV fields
        why = m.get('why_it_fits', '').replace('"', '""')
        lines.append(
            f"{m['score']},{m['score_label']},\"{m['grant_name']}\",\"{m.get('granting_authority', '')}\",\"{m['amount_display']}\",\"{m['deadline_display']}\",\"{why}\",{m.get('apply_url', '')}"
        )

    return "\n".join(lines)
