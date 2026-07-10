"""
GrantWriter module router (Application Writer PRD).

The linear pipeline with human approval gates:
  handoff -> grant spec -> fit/gap analysis -> [GATE: confirm strategy]
  -> stakeholder intake -> drafting -> self-scoring -> refinement
  -> [GATE: export]

Single source of truth: the writer reads grantfinder's grant records and org
profile and extends them. It never duplicates them - an Application is just
{user, grant_id} plus writer artifacts.
"""
import logging
import uuid
from datetime import datetime, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from models.writer_schemas import (
    AICallLog, Application, ApplicationStatus, ConfirmStrategyRequest,
    CreateApplicationRequest, DraftRequest, EnrichSpecRequest, ExportRequest,
    Gap, GapStatus, IntakeAnswer, RefineRequest, VoiceAnalyzeRequest,
    WaiveGapRequest,
)
from routers.auth import get_current_user, get_user_api_key, User
from routers.grants import get_user_grants
from services.ai_service import is_safe_url
from services.writer_service import WriterAI
from services import writer_export
from state import (
    ai_call_logs, applications_db, fit_analyses_db, gaps_db, grant_specs_db,
    intake_requests_db, profiles_db, scorecards_db, section_drafts_db,
)

router = APIRouter()
logger = logging.getLogger("grantfinder.writer")

URGENCY_WINDOW_DAYS = 10  # PRD 5.2: deadline within N days -> surface urgency


def _get_writer_ai(user_id: str) -> WriterAI:
    api_key = get_user_api_key(user_id)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="Claude API key not set. Please add your API key first.",
        )
    return WriterAI(api_key)


def _get_application(app_id: str, user_id: str) -> Application:
    app = applications_db.get(app_id)
    if not app or app.user_id != user_id:
        raise HTTPException(status_code=404, detail="Application not found")
    return app


def _get_profile(user_id: str):
    profile = profiles_db.get(user_id)
    if not profile:
        raise HTTPException(
            status_code=400,
            detail="No organization profile. Complete grantfinder setup first - "
                   "the writer reuses that profile.",
        )
    return profile


def _touch(app: Application):
    app.updated_at = datetime.utcnow()


def _compute_urgency(deadline: Optional[str]) -> bool:
    if not deadline:
        return False
    from services.ai_service import AIService
    parsed = AIService._parse_deadline(deadline)
    if not parsed:
        return False
    return parsed <= (datetime.utcnow() + timedelta(days=URGENCY_WINDOW_DAYS)).date()


# =============================================================================
# 4.0 Handoff: "Write Application"
# =============================================================================

@router.post("/applications")
async def create_application(
    request: CreateApplicationRequest,
    current_user: User = Depends(get_current_user),
):
    """Entry point from grantfinder: reuse the grant record and org profile,
    create only a new application record."""
    grants = get_user_grants(current_user.id)
    grant = next((g for g in grants if g.id == request.grant_id), None)
    if not grant:
        raise HTTPException(status_code=404, detail="Grant not found in your database")

    _get_profile(current_user.id)  # must exist; the writer never creates a parallel one

    # One application per grant per user - reopen if it exists
    for app in applications_db.values():
        if app.user_id == current_user.id and app.grant_id == request.grant_id:
            return app

    app = Application(
        id=f"app_{uuid.uuid4().hex[:12]}",
        user_id=current_user.id,
        grant_id=grant.id,
        grant_name=grant.grant_name,
        funder=grant.funder,
        deadline=grant.deadline,
        urgent=_compute_urgency(grant.deadline),
        correlation_id=f"corr_{uuid.uuid4().hex[:12]}",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    applications_db[app.id] = app
    logger.info(
        "application_created correlation_id=%s app_id=%s grant=%s urgent=%s",
        app.correlation_id, app.id, grant.grant_name, app.urgent,
    )
    return app


@router.get("/applications")
async def list_applications(current_user: User = Depends(get_current_user)):
    return [a for a in applications_db.values() if a.user_id == current_user.id]


@router.get("/applications/{app_id}")
async def get_application(app_id: str, current_user: User = Depends(get_current_user)):
    """Full application state: everything the writer UI needs in one call."""
    app = _get_application(app_id, current_user.id)
    gaps = list(gaps_db.get(app_id, {}).values())
    return {
        "application": app,
        "grant_spec": grant_specs_db.get(app.grant_id),
        "fit_analysis": fit_analyses_db.get(app_id),
        "gaps": gaps,
        "open_blocking_gaps": [
            g for g in gaps
            if g.severity == "high" and g.status in (GapStatus.OPEN, GapStatus.ROUTED)
        ],
        "intake_requests": list(intake_requests_db.get(app_id, {}).values()),
        "sections": list(section_drafts_db.get(app_id, {}).values()),
        "scorecard": scorecards_db.get(app_id),
    }


# =============================================================================
# 4.1 Voice profile (writer extension of the shared org profile)
# =============================================================================

@router.post("/voice/analyze")
async def analyze_voice(
    request: VoiceAnalyzeRequest,
    current_user: User = Depends(get_current_user),
):
    """Extract a voice profile from writing samples; saves onto the shared profile."""
    if not request.samples or not any(s.strip() for s in request.samples):
        raise HTTPException(status_code=400, detail="Provide at least one writing sample")
    profile = _get_profile(current_user.id)
    ai = _get_writer_ai(current_user.id)
    voice = await ai.analyze_voice(request.samples, f"voice_{current_user.id[:8]}")
    profile.voice_profile = voice
    profile.sources.append("Voice samples analyzed")
    return {"voice_profile": voice}


# =============================================================================
# 4.2 Grant Spec enrichment
# =============================================================================

@router.post("/applications/{app_id}/grant-spec")
async def enrich_grant_spec(
    app_id: str,
    request: EnrichSpecRequest,
    current_user: User = Depends(get_current_user),
):
    """Enrich grantfinder's grant record into a full Grant Spec."""
    app = _get_application(app_id, current_user.id)
    grants = get_user_grants(current_user.id)
    grant = next((g for g in grants if g.id == app.grant_id), None)
    if not grant:
        raise HTTPException(status_code=404, detail="Underlying grant record not found")

    guidelines = request.guidelines_text
    fetched_note = None
    if not guidelines and grant.url and is_safe_url(grant.url):
        # Fall back to the source grantfinder already has
        try:
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                resp = await client.get(grant.url)
                resp.raise_for_status()
                from bs4 import BeautifulSoup
                soup = BeautifulSoup(resp.text, "html.parser")
                for tag in soup(["script", "style", "nav", "footer", "header"]):
                    tag.decompose()
                guidelines = soup.get_text(separator="\n", strip=True)[:60000]
                fetched_note = f"Guidelines fetched from {grant.url}"
        except Exception as e:
            logger.warning(f"Could not fetch guidelines from {grant.url}: {e}")

    ai = _get_writer_ai(current_user.id)
    spec = await ai.enrich_grant_spec(grant, guidelines, app.correlation_id, app.id)
    grant_specs_db[grant.id] = spec
    _touch(app)
    return {"grant_spec": spec, "note": fetched_note}


# =============================================================================
# 4.3 Fit / Gap analysis
# =============================================================================

@router.post("/applications/{app_id}/analyze")
async def analyze_fit(app_id: str, current_user: User = Depends(get_current_user)):
    app = _get_application(app_id, current_user.id)
    profile = _get_profile(current_user.id)
    spec = grant_specs_db.get(app.grant_id)
    if not spec:
        raise HTTPException(status_code=400, detail="Run grant-spec enrichment first")

    ai = _get_writer_ai(current_user.id)
    analysis, gaps = await ai.analyze_fit(profile, spec, app.correlation_id, app.id)
    fit_analyses_db[app_id] = analysis
    gaps_db[app_id] = {g.id: g for g in gaps}
    app.status = ApplicationStatus.ANALYSIS
    _touch(app)
    return {"fit_analysis": analysis, "gaps": gaps}


@router.post("/applications/{app_id}/confirm-strategy")
async def confirm_strategy(
    app_id: str,
    request: ConfirmStrategyRequest,
    current_user: User = Depends(get_current_user),
):
    """GATE 1 (mandatory): the Grant Lead confirms the narrative strategy."""
    app = _get_application(app_id, current_user.id)
    analysis = fit_analyses_db.get(app_id)
    if not analysis:
        raise HTTPException(status_code=400, detail="Run fit analysis first")
    app.strategy = request.strategy or analysis.recommended_strategy
    app.strategy_confirmed = True
    app.status = ApplicationStatus.INTAKE
    _touch(app)
    logger.info("strategy_confirmed correlation_id=%s app_id=%s", app.correlation_id, app_id)
    return app


# =============================================================================
# 4.4 Stakeholder intake
# =============================================================================

@router.post("/applications/{app_id}/intake/generate")
async def generate_intake(app_id: str, current_user: User = Depends(get_current_user)):
    """Generate per-stakeholder request packets for all open gaps.
    Sending is human work (v1): packets are copy-paste-ready emails."""
    app = _get_application(app_id, current_user.id)
    profile = _get_profile(current_user.id)
    gaps = list(gaps_db.get(app_id, {}).values())
    if not gaps:
        return {"intake_requests": [], "note": "No gaps to route"}

    ai = _get_writer_ai(current_user.id)
    requests = await ai.generate_intake_packets(app, gaps, profile, app.correlation_id)

    store = intake_requests_db.setdefault(app_id, {})
    gap_store = gaps_db.get(app_id, {})
    for req in requests:
        store[req.id] = req
        for gap_id in req.gap_ids:
            if gap_id in gap_store:
                gap_store[gap_id].status = GapStatus.ROUTED
    _touch(app)
    return {"intake_requests": requests}


@router.put("/applications/{app_id}/intake/{request_id}/answer")
async def record_intake_answer(
    app_id: str,
    request_id: str,
    answer: IntakeAnswer,
    current_user: User = Depends(get_current_user),
):
    """Record a stakeholder's answer. Flows back into the SHARED org profile
    (reusable next time, and by grantfinder matching)."""
    app = _get_application(app_id, current_user.id)
    profile = _get_profile(current_user.id)
    req = intake_requests_db.get(app_id, {}).get(request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Intake request not found")

    req.response = answer.response
    gap_store = gaps_db.get(app_id, {})

    if answer.is_confirmed_gap:
        # "We don't have that" is a valid, useful outcome -> honest framing path
        req.status = "confirmed_gap"
        for gap_id in req.gap_ids:
            if gap_id in gap_store:
                gap_store[gap_id].status = GapStatus.CONFIRMED_GAP
                gap_store[gap_id].answer = answer.response
    else:
        req.status = "answered"
        for gap_id in req.gap_ids:
            if gap_id in gap_store:
                gap_store[gap_id].status = GapStatus.ANSWERED
                gap_store[gap_id].answer = answer.response
        # Compounding asset: the answer enriches the shared profile
        profile.evidence.append({
            "id": f"ev_{uuid.uuid4().hex[:10]}",
            "type": "stakeholder_answer",
            "summary": answer.response,
            "source_ref": f"{req.stakeholder_role} via intake for {app.grant_name}",
            "linked_programs": [],
        })
        profile.sources.append(f"Stakeholder answer: {req.stakeholder_role}")

    _touch(app)
    return {"intake_request": req, "gaps": list(gap_store.values())}


@router.put("/applications/{app_id}/gaps/{gap_id}/waive")
async def waive_gap(
    app_id: str,
    gap_id: str,
    request: WaiveGapRequest,
    current_user: User = Depends(get_current_user),
):
    """Explicitly waive a gap (unblocks drafting for high-severity gaps)."""
    app = _get_application(app_id, current_user.id)
    gap = gaps_db.get(app_id, {}).get(gap_id)
    if not gap:
        raise HTTPException(status_code=404, detail="Gap not found")
    gap.status = GapStatus.WAIVED
    gap.answer = f"Waived by Grant Lead: {request.reason or 'no reason given'}"
    _touch(app)
    return gap


# =============================================================================
# 4.5 Drafting
# =============================================================================

@router.post("/applications/{app_id}/draft")
async def draft_sections(
    app_id: str,
    request: DraftRequest,
    current_user: User = Depends(get_current_user),
):
    """Draft all sections (or one). Blocked until strategy is confirmed and
    every high-severity gap is resolved, confirmed, or waived (PRD 5.2)."""
    app = _get_application(app_id, current_user.id)
    profile = _get_profile(current_user.id)
    spec = grant_specs_db.get(app.grant_id)
    if not spec:
        raise HTTPException(status_code=400, detail="Run grant-spec enrichment first")
    if not app.strategy_confirmed:
        raise HTTPException(
            status_code=409,
            detail="Strategy not confirmed. Review the fit map and confirm the "
                   "strategy before drafting (human approval gate).",
        )

    blocking = [
        g for g in gaps_db.get(app_id, {}).values()
        if g.severity == "high" and g.status in (GapStatus.OPEN, GapStatus.ROUTED)
    ]
    if blocking:
        raise HTTPException(
            status_code=409,
            detail=f"{len(blocking)} high-severity gap(s) unresolved. Resolve, "
                   f"record 'we don't have that', or explicitly waive them: "
                   + "; ".join(g.description[:80] for g in blocking[:5]),
        )

    sections_to_draft = spec.required_sections
    if request.section_id:
        sections_to_draft = [s for s in spec.required_sections if s.id == request.section_id]
        if not sections_to_draft:
            raise HTTPException(status_code=404, detail="Section not found in grant spec")

    analysis = fit_analyses_db.get(app_id)
    confirmed_gaps = [
        g for g in gaps_db.get(app_id, {}).values()
        if g.status == GapStatus.CONFIRMED_GAP
    ]

    ai = _get_writer_ai(current_user.id)
    store = section_drafts_db.setdefault(app_id, {})
    drafted = []
    for section in sections_to_draft:
        draft = await ai.draft_section(
            app, section, spec, profile, analysis, confirmed_gaps, app.correlation_id
        )
        store[section.id] = draft
        drafted.append(draft)

    app.status = ApplicationStatus.DRAFTING
    _touch(app)
    return {"sections": drafted}


# =============================================================================
# 4.6 Self-scoring
# =============================================================================

@router.post("/applications/{app_id}/score")
async def score_application(app_id: str, current_user: User = Depends(get_current_user)):
    app = _get_application(app_id, current_user.id)
    spec = grant_specs_db.get(app.grant_id)
    drafts = list(section_drafts_db.get(app_id, {}).values())
    if not spec or not drafts:
        raise HTTPException(status_code=400, detail="Draft the application first")

    ai = _get_writer_ai(current_user.id)
    scorecard = await ai.score_draft(app, spec, drafts, app.correlation_id)
    scorecards_db[app_id] = scorecard
    app.status = ApplicationStatus.REVIEW
    _touch(app)
    return scorecard


# =============================================================================
# 4.7 Refinement
# =============================================================================

@router.post("/applications/{app_id}/sections/{section_id}/refine")
async def refine_section(
    app_id: str,
    section_id: str,
    request: RefineRequest,
    current_user: User = Depends(get_current_user),
):
    app = _get_application(app_id, current_user.id)
    profile = _get_profile(current_user.id)
    spec = grant_specs_db.get(app.grant_id)
    draft = section_drafts_db.get(app_id, {}).get(section_id)
    if not spec or not draft:
        raise HTTPException(status_code=404, detail="Section draft not found")
    section = next((s for s in spec.required_sections if s.id == section_id), None)
    if not section:
        raise HTTPException(status_code=404, detail="Section not in grant spec")

    ai = _get_writer_ai(current_user.id)
    revised = await ai.refine_section(
        app, draft, section, profile, request.instruction, app.correlation_id
    )
    section_drafts_db[app_id][section_id] = revised
    _touch(app)
    return revised


# =============================================================================
# 4.8 Export (GATE 2: explicit human action; nothing auto-submitted)
# =============================================================================

@router.post("/applications/{app_id}/export")
async def export_application(
    app_id: str,
    request: ExportRequest,
    current_user: User = Depends(get_current_user),
):
    app = _get_application(app_id, current_user.id)
    spec = grant_specs_db.get(app.grant_id)
    drafts = list(section_drafts_db.get(app_id, {}).values())
    if not spec or not drafts:
        raise HTTPException(status_code=400, detail="Nothing to export - draft the application first")

    # Hard rule: never export over-limit content
    over_limit = [d.title for d in drafts if d.over_limit]
    if over_limit:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot export: section(s) over their hard limit: {', '.join(over_limit)}. "
                   f"Refine them (e.g. 'tighten to the limit') first.",
        )
    dirty = [d.title for d in drafts if d.banned_phrase_hits]
    if dirty:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot export: banned phrases remain in: {', '.join(dirty)}. Refine first.",
        )

    content, filename, media_type = writer_export.build_export(
        request.format.value, app, spec, drafts
    )
    app.status = ApplicationStatus.EXPORT
    _touch(app)
    logger.info(
        "application_exported correlation_id=%s app_id=%s format=%s file=%s",
        app.correlation_id, app_id, request.format.value, filename,
    )
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# =============================================================================
# Section 8: Debug bundle
# =============================================================================

@router.get("/applications/{app_id}/debug-bundle")
async def debug_bundle(app_id: str, current_user: User = Depends(get_current_user)):
    """One clean markdown bundle: correlation id, event timeline, AI calls,
    errors - formatted for pasting into Claude Code."""
    app = _get_application(app_id, current_user.id)
    calls = [c for c in ai_call_logs if c.application_id == app_id]
    gaps = list(gaps_db.get(app_id, {}).values())
    drafts = list(section_drafts_db.get(app_id, {}).values())

    lines = [
        "# GrantFinder Debug Bundle",
        f"- **Correlation ID:** {app.correlation_id}",
        f"- **Application:** {app.id} - {app.grant_name} ({app.funder})",
        f"- **Status:** {app.status.value} | strategy_confirmed={app.strategy_confirmed} | urgent={app.urgent}",
        f"- **Created:** {app.created_at.isoformat()} | Updated: {app.updated_at.isoformat()}",
        f"- **Model:** {calls[-1].model if calls else 'n/a'}",
        "",
        f"## State summary",
        f"- Grant spec: {'yes' if grant_specs_db.get(app.grant_id) else 'MISSING'}",
        f"- Fit analysis: {'yes' if fit_analyses_db.get(app_id) else 'MISSING'}",
        f"- Gaps: {len(gaps)} ({sum(1 for g in gaps if g.severity == 'high')} high)",
        f"- Sections drafted: {len(drafts)} "
        f"({sum(1 for d in drafts if d.over_limit)} over limit, "
        f"{sum(1 for d in drafts if d.banned_phrase_hits)} with banned phrases)",
        f"- Scorecard: {'yes' if scorecards_db.get(app_id) else 'no'}",
        "",
        "## AI call timeline",
        "| time | stage | prompt | in_tok | out_tok | ms | $est | status |",
        "|---|---|---|---|---|---|---|---|",
    ]
    total_cost = 0.0
    for c in calls:
        total_cost += c.cost_estimate_usd
        lines.append(
            f"| {c.timestamp.strftime('%H:%M:%S')} | {c.stage} | {c.prompt_id} "
            f"| {c.input_tokens} | {c.output_tokens} | {c.latency_ms} "
            f"| {c.cost_estimate_usd:.4f} | {c.status}{' - ' + (c.error or '')[:80] if c.error else ''} |"
        )
    lines.append("")
    lines.append(f"**Total estimated AI cost for this application: ${total_cost:.4f}**")

    errors = [c for c in calls if c.status == "error"]
    if errors:
        lines.append("")
        lines.append("## Errors")
        for c in errors:
            lines.append(f"- [{c.timestamp.isoformat()}] {c.stage}/{c.prompt_id}: {c.error}")

    return {"bundle_markdown": "\n".join(lines)}


@router.get("/logs/recent")
async def recent_ai_logs(
    limit: int = 50,
    current_user: User = Depends(get_current_user),
):
    """In-app log surface: recent AI calls (newest first)."""
    user_app_ids = {a.id for a in applications_db.values() if a.user_id == current_user.id}
    relevant = [
        c for c in ai_call_logs
        if c.application_id in user_app_ids or c.application_id is None
    ]
    return relevant[-limit:][::-1]
