"""
Export router for GrantFinder AI.
Handles PDF, CSV, and Markdown export of match results.
"""
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from typing import List
import io
import csv
import logging
from datetime import datetime, timedelta

from models.schemas import (
    ExportFormat, ExportRequest, ExportResponse,
    MatchResults, GrantMatch, OrganizationProfile
)
from routers.auth import get_current_user, User

router = APIRouter()
logger = logging.getLogger(__name__)

# In-memory storage for match results (replace with Supabase)
match_results_db: dict = {}


def store_match_results(user_id: str, results: MatchResults):
    """Store match results for later export."""
    match_results_db[results.session_id] = results


@router.post("/")
async def export_results(
    request: ExportRequest,
    current_user: User = Depends(get_current_user)
):
    """
    Export match results in specified format.
    Supported formats: PDF, CSV, Markdown
    """
    # Get match results
    results = match_results_db.get(request.session_id)

    if not results:
        raise HTTPException(status_code=404, detail="Match results not found")

    if results.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")

    # Filter matches if needed
    matches = results.matches
    if not request.include_all_matches:
        matches = [m for m in matches if m.is_shortlisted]

    try:
        if request.format == ExportFormat.CSV:
            return await export_csv(matches, results)
        elif request.format == ExportFormat.MARKDOWN:
            return await export_markdown(matches, results)
        elif request.format == ExportFormat.PDF:
            return await export_markdown(matches, results)  # PDF generation would need additional library
        else:
            raise HTTPException(status_code=400, detail="Unsupported export format")

    except Exception as e:
        logger.error(f"Export error: {e}")
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


async def export_csv(matches: List[GrantMatch], results: MatchResults) -> StreamingResponse:
    """Export matches to CSV format."""
    output = io.StringIO()
    writer = csv.writer(output)

    # Header row
    writer.writerow([
        "Rank", "Grant Name", "Funder", "Amount", "Deadline",
        "Score (%)", "Tier", "Category", "Geo Qualified",
        "Contact", "URL", "Explanation"
    ])

    # Data rows
    for idx, match in enumerate(matches, 1):
        writer.writerow([
            idx,
            match.grant_name,
            match.funder,
            match.amount,
            match.deadline,
            match.score,
            match.score_tier.value,
            match.category.value,
            match.geo_qualified.value,
            match.contact,
            match.url,
            match.explanation,
        ])

    output.seek(0)

    filename = f"grantfinder_matches_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


async def export_markdown(matches: List[GrantMatch], results: MatchResults) -> StreamingResponse:
    """Export matches to Markdown format."""
    lines = [
        "# GrantFinder AI - Match Results",
        "",
        f"**Generated:** {datetime.now().strftime('%B %d, %Y at %I:%M %p')}",
        f"**Total Grants Evaluated:** {results.total_grants_evaluated}",
        "",
        "## Summary",
        "",
        f"- Excellent Matches (85-100%): {results.excellent_matches}",
        f"- Good Matches (70-84%): {results.good_matches}",
        f"- Possible Matches (50-69%): {results.possible_matches}",
        f"- Weak Matches (25-49%): {results.weak_matches}",
        f"- Not Eligible (0-24%): {results.not_eligible}",
        "",
        "---",
        "",
        "## Match Details",
        "",
    ]

    for idx, match in enumerate(matches, 1):
        tier_emoji = {
            "excellent": "🟢",
            "good": "🟡",
            "possible": "🟠",
            "weak": "🔴",
            "not_eligible": "⚫",
        }.get(match.score_tier.value, "⚪")

        lines.extend([
            f"### {idx}. {match.grant_name}",
            "",
            f"**Score:** {tier_emoji} {match.score}% ({match.score_tier.value.replace('_', ' ').title()})",
            "",
            f"| Field | Value |",
            f"|-------|-------|",
            f"| Funder | {match.funder} |",
            f"| Amount | {match.amount} |",
            f"| Deadline | {match.deadline} |",
            f"| Category | {match.category.value.replace('_', ' ').title()} |",
            f"| Geographic | {match.geo_qualified.value} |",
            f"| Contact | {match.contact} |",
            f"| URL | {match.url} |",
            "",
            "**Score Breakdown:**",
            f"- Eligibility Fit (40%): {match.score_breakdown.eligibility_fit}%",
            f"- Need Alignment (30%): {match.score_breakdown.need_alignment}%",
            f"- Capacity Signals (15%): {match.score_breakdown.capacity_signals}%",
            f"- Timing (10%): {match.score_breakdown.timing}%",
            f"- Completeness (5%): {match.score_breakdown.completeness}%",
            "",
            f"**Why this match:** {match.explanation}",
            "",
        ])

        if match.evidence:
            lines.append("**Evidence:**")
            for evidence in match.evidence:
                lines.append(f"- {evidence}")
            lines.append("")

        lines.extend(["---", ""])

    lines.extend([
        "",
        "---",
        "",
        "*Generated by GrantFinder AI v2.6*",
        "*https://github.com/[username]/grantfinder-ai*",
    ])

    content = "\n".join(lines)
    output = io.BytesIO(content.encode('utf-8'))

    filename = f"grantfinder_matches_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"

    return StreamingResponse(
        output,
        media_type="text/markdown",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )


@router.get("/formats")
async def get_export_formats():
    """Get available export formats."""
    return {
        "formats": [
            {"id": "csv", "name": "CSV", "description": "Spreadsheet format"},
            {"id": "md", "name": "Markdown", "description": "Formatted text"},
            {"id": "pdf", "name": "PDF", "description": "Print-ready document"},
        ]
    }
