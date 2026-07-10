"""
GrantWriter AI orchestration (Application Writer PRD 4.9).

Each stage is a distinct, purpose-built AI task with its own prompt:
  Extract -> grant spec enrichment, voice profile from samples
  Map     -> fit/gap analysis of Org Profile vs Grant Spec
  Route   -> framed stakeholder question packets per gap
  Draft   -> grounded, voice-conditioned section generation
  Score   -> rubric scorecard with ranked fixes
  Refine  -> constrained rewrite honoring one instruction
  Enforce -> banned-phrase / AI-tell rewrite (deterministic detect + AI fix)

Every AI call is logged: prompt id, model, tokens, latency, cost estimate,
status, correlation id (PRD Section 8).

Hard rules enforced in code, not just prompts:
- Never fabricate: prompts require evidence refs; claims without evidence are flagged.
- Format is pass/fail: word/char limits checked deterministically after every
  generation and refinement; export refuses over-limit content.
- Banned phrases detected deterministically and rewritten before reaching the user.
"""
import json
import logging
import re
import time
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import anthropic

from config import settings
from models.schemas import Grant, OrganizationProfile
from models.writer_schemas import (
    AICallLog, Application, ClaimFlag, CriterionScore, FitAnalysis, FitEntry,
    Gap, GapStatus, GrantSpec, IntakeRequest, RequiredSection, RubricCriterion,
    Scorecard, SectionDraft,
)
from state import ai_call_logs, AI_CALL_LOG_LIMIT

logger = logging.getLogger("grantfinder.writer")

# $/MTok (input, output) for cost estimates in AI call logs
MODEL_PRICES = {
    "claude-sonnet-5": (3.0, 15.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

# AI tells banned by default, merged with the org's own banned-phrase list
DEFAULT_BANNED_PHRASES = [
    "honored to be considered",
    "we are thrilled",
    "in today's fast-paced world",
    "in an ever-changing world",
    "unwavering commitment",
    "passionate about",
    "cutting-edge",
    "state-of-the-art",
    "world-class",
    "game-changer",
    "at the end of the day",
    "leverage synergies",
    "delve into",
    "it is important to note that",
    "furthermore, ",
    "moreover, ",
]


# =============================================================================
# Utilities
# =============================================================================

def count_words(text: str) -> int:
    return len(text.split())


def find_banned_phrases(text: str, extra_banned: Optional[List[str]] = None) -> List[str]:
    """Deterministic banned-phrase scan (case-insensitive substring match)."""
    banned = DEFAULT_BANNED_PHRASES + [p for p in (extra_banned or []) if p]
    lower = text.lower()
    return [phrase for phrase in banned if phrase.lower() in lower]


def _extract_json(text: str) -> Optional[Any]:
    """Leniently pull the first JSON object or array out of a model response."""
    fenced = re.search(r"```(?:json)?\s*([\[{].*?[\]}])\s*```", text, re.DOTALL)
    candidates = []
    if fenced:
        candidates.append(fenced.group(1))
    # Try whichever container opens FIRST in the text, so a top-level array
    # isn't mistaken for its first inner object.
    pairs = [("{", "}"), ("[", "]")]
    brace_pos = text.find("{")
    bracket_pos = text.find("[")
    if bracket_pos != -1 and (brace_pos == -1 or bracket_pos < brace_pos):
        pairs.reverse()
    for open_ch, close_ch in pairs:
        start = text.find(open_ch)
        end = text.rfind(close_ch)
        if start != -1 and end > start:
            candidates.append(text[start:end + 1])
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def profile_slice(profile: OrganizationProfile) -> Dict[str, Any]:
    """The structured profile slice that grounds writer prompts (PRD 4.9)."""
    return {
        "organization_name": profile.organization_name,
        "organization_type": profile.organization_type,
        "city": profile.city,
        "state": profile.state,
        "diocese": profile.diocese,
        "has_school": profile.has_school,
        "student_count": profile.student_count,
        "is_501c3": profile.is_501c3,
        "annual_budget": profile.annual_budget,
        "facility_needs": profile.facility_needs,
        "program_needs": profile.program_needs,
        "security_concerns": profile.security_concerns,
        "current_initiatives": profile.current_initiatives,
        "free_form_notes": profile.free_form_notes,
        "questionnaire_answers": profile.questionnaire_answers,
        "evidence": profile.evidence,
        "team_members": profile.team_members,
        "collaborations": profile.collaborations,
        "validators": profile.validators,
        "in_kind_resources": profile.in_kind_resources,
        "prior_grants_detail": profile.prior_grants_detail,
        "previous_grants": profile.previous_grants,
        "financial_capacity": profile.financial_capacity,
    }


def _voice_block(profile: OrganizationProfile) -> str:
    """Voice conditioning block for Draft/Refine prompts."""
    vp = profile.voice_profile or {}
    guidelines = vp.get("style_guidelines") or "Plain, direct, warm. Concrete over abstract. No corporate jargon."
    samples = vp.get("samples") or []
    banned = (vp.get("banned_phrases") or []) + DEFAULT_BANNED_PHRASES
    block = f"VOICE GUIDELINES:\n{guidelines}\n\nBANNED PHRASES (never use any of these):\n"
    block += "\n".join(f"- {p}" for p in banned[:40])
    if samples:
        joined = "\n---\n".join(s[:1500] for s in samples[:3])
        block += f"\n\nWRITING SAMPLES IN THE ORGANIZATION'S REAL VOICE:\n{joined}"
    return block


# =============================================================================
# AI client with call logging
# =============================================================================

class WriterAI:
    def __init__(self, api_key: str):
        self.client = anthropic.AsyncAnthropic(api_key=api_key)
        self.model = settings.CLAUDE_MODEL

    async def _call(
        self,
        stage: str,
        prompt_id: str,
        prompt: str,
        correlation_id: str,
        application_id: Optional[str] = None,
        max_tokens: int = 4000,
    ) -> str:
        """One logged Claude call. Returns response text; raises on API error."""
        start = time.monotonic()
        status, error, in_tok, out_tok, text = "ok", None, 0, 0, ""
        try:
            response = await self.client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                messages=[{"role": "user", "content": prompt}],
            )
            in_tok = response.usage.input_tokens
            out_tok = response.usage.output_tokens
            text = "\n".join(b.text for b in response.content if b.type == "text")
            return text
        except Exception as e:
            status, error = "error", str(e)[:500]
            raise
        finally:
            latency_ms = int((time.monotonic() - start) * 1000)
            in_price, out_price = MODEL_PRICES.get(self.model, (3.0, 15.0))
            cost = (in_tok * in_price + out_tok * out_price) / 1_000_000
            entry = AICallLog(
                correlation_id=correlation_id,
                application_id=application_id,
                stage=stage,
                prompt_id=prompt_id,
                model=self.model,
                input_tokens=in_tok,
                output_tokens=out_tok,
                latency_ms=latency_ms,
                cost_estimate_usd=round(cost, 6),
                status=status,
                error=error,
                timestamp=datetime.utcnow(),
            )
            ai_call_logs.append(entry)
            del ai_call_logs[:-AI_CALL_LOG_LIMIT]
            logger.info(
                "ai_call correlation_id=%s stage=%s prompt_id=%s model=%s "
                "in_tokens=%s out_tokens=%s latency_ms=%s cost_usd=%.6f status=%s%s",
                correlation_id, stage, prompt_id, self.model,
                in_tok, out_tok, latency_ms, cost, status,
                f" error={error}" if error else "",
            )

    # =========================================================================
    # Stage: Extract - voice profile from samples
    # =========================================================================

    async def analyze_voice(self, samples: List[str], correlation_id: str) -> Dict[str, Any]:
        joined = "\n\n=== SAMPLE ===\n".join(s[:3000] for s in samples[:5])
        prompt = f"""Analyze these writing samples from one organization and extract a reusable voice profile.

SAMPLES:
{joined}

Return ONLY a JSON object:
{{
  "style_guidelines": "3-6 sentences describing tone, sentence rhythm, vocabulary level, and habits to imitate",
  "banned_phrases": ["phrases and cliches this organization would never use"],
  "signature_moves": ["specific stylistic habits worth reproducing"]
}}"""
        text = await self._call("extract", "voice_profile_v1", prompt, correlation_id)
        data = _extract_json(text) or {}
        return {
            "style_guidelines": data.get("style_guidelines", ""),
            "banned_phrases": data.get("banned_phrases", []),
            "signature_moves": data.get("signature_moves", []),
            "samples": samples[:5],
        }

    # =========================================================================
    # Stage: Extract - grant spec enrichment (PRD 4.2)
    # =========================================================================

    async def enrich_grant_spec(
        self,
        grant: Grant,
        guidelines_text: Optional[str],
        correlation_id: str,
        application_id: str,
    ) -> GrantSpec:
        grant_record = {
            "grant_name": grant.grant_name,
            "funder": grant.funder,
            "deadline": grant.deadline,
            "amount": grant.amount,
            "description": grant.description,
            "eligibility_notes": grant.eligibility_notes,
            "url": grant.url,
        }
        guidelines_block = (
            f"FULL GUIDELINES TEXT:\n{guidelines_text[:60000]}"
            if guidelines_text
            else "No full guidelines provided - infer conservatively from the grant record and say so in notes."
        )

        prompt = f"""You are preparing a Grant Spec: the complete application requirements for one grant.

EXISTING GRANT RECORD (from grantfinder discovery - do not contradict it):
{json.dumps(grant_record, indent=2)}

{guidelines_block}

Extract and return ONLY a JSON object:
{{
  "required_sections": [
    {{"id": "s1", "title": "Section title", "prompt": "the funder's actual question/prompt", "word_limit": null, "char_limit": null, "notes": ""}}
  ],
  "format_constraints": ["hard constraints: page limits, fonts, portal type, attachment rules"],
  "deliverables": ["required extras beyond narrative: budget, letters of support, video, one-pager"],
  "rubric": [
    {{"id": "c1", "name": "criterion", "description": "what the funder scores here", "weight": null}}
  ],
  "rubric_source": "explicit or inferred",
  "funder_language_cues": ["vocabulary the funder uses that the application should mirror"],
  "funder_priorities": ["what this funder demonstrably cares about"]
}}

Rules:
- If the guidelines publish explicit scoring criteria/weights, use them verbatim and set rubric_source to "explicit".
- Otherwise infer a rubric from stated priorities and set rubric_source to "inferred".
- If no guidelines text was provided, produce a typical section set for this kind of grant and mark every section's notes with "INFERRED - verify against actual guidelines".
- Never invent word limits: use null when unknown."""

        text = await self._call(
            "extract", "grant_spec_v1", prompt, correlation_id,
            application_id, max_tokens=6000,
        )
        data = _extract_json(text) or {}

        sections = []
        for i, s in enumerate(data.get("required_sections", []) or []):
            if isinstance(s, dict) and s.get("title"):
                sections.append(RequiredSection(
                    id=str(s.get("id") or f"s{i+1}"),
                    title=str(s["title"]),
                    prompt=str(s.get("prompt") or ""),
                    word_limit=s.get("word_limit"),
                    char_limit=s.get("char_limit"),
                    notes=str(s.get("notes") or ""),
                ))

        rubric = []
        for i, c in enumerate(data.get("rubric", []) or []):
            if isinstance(c, dict) and c.get("name"):
                rubric.append(RubricCriterion(
                    id=str(c.get("id") or f"c{i+1}"),
                    name=str(c["name"]),
                    description=str(c.get("description") or ""),
                    weight=c.get("weight"),
                ))

        rubric_source = str(data.get("rubric_source") or "inferred")
        if rubric_source not in ("explicit", "inferred"):
            rubric_source = "inferred"

        return GrantSpec(
            grant_id=grant.id,
            required_sections=sections,
            format_constraints=[str(x) for x in data.get("format_constraints", []) or []],
            deliverables=[str(x) for x in data.get("deliverables", []) or []],
            rubric=rubric,
            rubric_source=rubric_source,
            funder_language_cues=[str(x) for x in data.get("funder_language_cues", []) or []],
            funder_priorities=[str(x) for x in data.get("funder_priorities", []) or []],
            guidelines_text=guidelines_text,
            enriched_at=datetime.utcnow(),
        )

    # =========================================================================
    # Stage: Map - fit/gap analysis (PRD 4.3, the core value)
    # =========================================================================

    async def analyze_fit(
        self,
        profile: OrganizationProfile,
        spec: GrantSpec,
        correlation_id: str,
        application_id: str,
    ) -> Tuple[FitAnalysis, List[Gap]]:
        rubric_json = [c.model_dump() for c in spec.rubric]
        sections_json = [s.model_dump() for s in spec.required_sections]

        prompt = f"""You are a seasoned grant strategist. Cross-reference this organization against this grant's rubric and requirements.

ORGANIZATION PROFILE:
{json.dumps(profile_slice(profile), indent=2, default=str)}

GRANT RUBRIC (source: {spec.rubric_source}):
{json.dumps(rubric_json, indent=2)}

REQUIRED SECTIONS:
{json.dumps(sections_json, indent=2)}

FUNDER PRIORITIES: {json.dumps(spec.funder_priorities)}

Return ONLY a JSON object:
{{
  "fit_map": [
    {{"criterion_id": "c1", "criterion_name": "...", "rating": "strong|partial|weak|missing",
      "evidence": ["specific facts from the profile that support this criterion"],
      "missing": "what's absent, or null"}}
  ],
  "strength_leads": ["the 2-4 criteria to open with and emphasize"],
  "honesty_ledger": ["weaknesses that should be NAMED AND FRAMED honestly rather than hidden"],
  "recommended_strategy": "3-6 sentences: the narrative strategy - what to lead with, how to frame weaknesses, which evidence carries the application",
  "gaps": [
    {{"criterion_ref": "c1 or section id", "description": "the specific missing information",
      "severity": "high|medium|low",
      "suggested_owner_role": "who in a parish/school likely holds this: Finance, Principal, Pastor, Program Lead, Development"}}
  ]
}}

Rules:
- Evidence must be REAL facts present in the profile. Never invent evidence.
- severity "high" = the application cannot honestly be drafted without it (required field/criterion with nothing to support it).
- Include the "you never named the lead" class of gaps: people, letters, data points quietly required."""

        text = await self._call(
            "map", "fit_gap_v1", prompt, correlation_id,
            application_id, max_tokens=6000,
        )
        data = _extract_json(text) or {}

        fit_map = []
        for entry in data.get("fit_map", []) or []:
            if isinstance(entry, dict) and entry.get("criterion_name"):
                rating = str(entry.get("rating") or "weak").lower()
                if rating not in ("strong", "partial", "weak", "missing"):
                    rating = "weak"
                fit_map.append(FitEntry(
                    criterion_id=str(entry.get("criterion_id") or ""),
                    criterion_name=str(entry["criterion_name"]),
                    rating=rating,
                    evidence=[str(e) for e in entry.get("evidence", []) or []],
                    missing=entry.get("missing"),
                ))

        gaps = []
        for g in data.get("gaps", []) or []:
            if isinstance(g, dict) and g.get("description"):
                severity = str(g.get("severity") or "medium").lower()
                if severity not in ("high", "medium", "low"):
                    severity = "medium"
                gaps.append(Gap(
                    id=f"gap_{uuid.uuid4().hex[:10]}",
                    application_id=application_id,
                    criterion_ref=str(g.get("criterion_ref") or ""),
                    description=str(g["description"]),
                    severity=severity,
                    suggested_owner_role=str(g.get("suggested_owner_role") or ""),
                ))

        analysis = FitAnalysis(
            application_id=application_id,
            fit_map=fit_map,
            strength_leads=[str(x) for x in data.get("strength_leads", []) or []],
            honesty_ledger=[str(x) for x in data.get("honesty_ledger", []) or []],
            recommended_strategy=str(data.get("recommended_strategy") or ""),
            generated_at=datetime.utcnow(),
        )
        return analysis, gaps

    # =========================================================================
    # Stage: Route - stakeholder intake packets (PRD 4.4)
    # =========================================================================

    async def generate_intake_packets(
        self,
        application: Application,
        gaps: List[Gap],
        profile: OrganizationProfile,
        correlation_id: str,
    ) -> List[IntakeRequest]:
        open_gaps = [g for g in gaps if g.status == GapStatus.OPEN]
        if not open_gaps:
            return []

        gaps_json = [
            {"id": g.id, "description": g.description, "severity": g.severity,
             "suggested_owner_role": g.suggested_owner_role}
            for g in open_gaps
        ]
        team_json = profile.team_members or []

        prompt = f"""You are helping a Grant Lead collect missing information for a grant application to {application.funder} ({application.grant_name}), deadline {application.deadline or 'unknown'}.

INFORMATION GAPS:
{json.dumps(gaps_json, indent=2)}

KNOWN TEAM/STAKEHOLDERS (may be empty):
{json.dumps(team_json, indent=2)}

Group the gaps by the single stakeholder role most likely to hold each answer (one owner per gap - never assign a gap to two people). For each stakeholder, produce a request packet.

Return ONLY a JSON array:
[
  {{
    "stakeholder_role": "Finance / Principal / Pastor / Program Lead / Development / ...",
    "gap_ids": ["gap ids assigned to this person"],
    "framing": "one line: why we need this, in plain language",
    "questions": ["specific, answerable questions - each should take a few sentences to answer"],
    "expected_format": "e.g. 'A few sentences is fine' or 'A number and a date'",
    "suggested_deadline": "a reasonable date given the grant deadline, or null",
    "email_packet": "A complete, copy-paste-ready email: warm, brief, explains why, lists the questions, says how much detail is expected, explicitly says 'if we don't have this, just say so - that's a useful answer too'."
  }}
]"""

        text = await self._call(
            "route", "intake_packets_v1", prompt, correlation_id,
            application.id, max_tokens=5000,
        )
        data = _extract_json(text) or []

        valid_gap_ids = {g.id for g in open_gaps}
        assigned: set = set()
        requests = []
        for item in data if isinstance(data, list) else []:
            if not isinstance(item, dict):
                continue
            gap_ids = [gid for gid in (item.get("gap_ids") or []) if gid in valid_gap_ids and gid not in assigned]
            assigned.update(gap_ids)
            requests.append(IntakeRequest(
                id=f"intake_{uuid.uuid4().hex[:10]}",
                application_id=application.id,
                stakeholder_role=str(item.get("stakeholder_role") or "Unassigned"),
                gap_ids=gap_ids,
                framing=str(item.get("framing") or ""),
                questions=[str(q) for q in item.get("questions", []) or []],
                expected_format=str(item.get("expected_format") or "A few sentences is fine."),
                suggested_deadline=item.get("suggested_deadline"),
                email_packet=str(item.get("email_packet") or ""),
            ))
        return requests

    # =========================================================================
    # Stage: Draft - section generation (PRD 4.5)
    # =========================================================================

    async def draft_section(
        self,
        application: Application,
        section: RequiredSection,
        spec: GrantSpec,
        profile: OrganizationProfile,
        analysis: Optional[FitAnalysis],
        confirmed_gaps: List[Gap],
        correlation_id: str,
    ) -> SectionDraft:
        limit_text = ""
        if section.word_limit:
            limit_text = f"HARD LIMIT: {section.word_limit} words maximum. Target {int(section.word_limit * 0.92)} words."
        elif section.char_limit:
            limit_text = f"HARD LIMIT: {section.char_limit} characters maximum. Target {int(section.char_limit * 0.9)} characters."

        strategy_block = ""
        if analysis:
            strategy_block = f"""CONFIRMED STRATEGY:
{application.strategy or analysis.recommended_strategy}

FIT MAP (lead with strengths, address weaknesses on purpose):
{json.dumps([f.model_dump() for f in analysis.fit_map], indent=2)}

HONESTY LEDGER (name and frame these truthfully if relevant to this section):
{json.dumps(analysis.honesty_ledger)}"""

        confirmed_block = ""
        if confirmed_gaps:
            confirmed_block = (
                "CONFIRMED GAPS (the organization does NOT have these - if relevant, "
                "frame honestly as documented learning or planned growth; NEVER claim them):\n"
                + json.dumps([g.description for g in confirmed_gaps])
            )

        prompt = f"""Write one section of a grant application to {application.funder} for "{application.grant_name}".

SECTION: {section.title}
FUNDER'S PROMPT: {section.prompt or '(none provided - write what this section conventionally covers)'}
{limit_text}

ORGANIZATION PROFILE (the only source of facts you may use):
{json.dumps(profile_slice(profile), indent=2, default=str)}

{strategy_block}

{confirmed_block}

FUNDER LANGUAGE CUES (mirror naturally, no keyword stuffing): {json.dumps(spec.funder_language_cues)}

{_voice_block(profile)}

ABSOLUTE RULES:
- Never fabricate facts, numbers, partnerships, names, or credentials. Every factual claim must come from the profile.
- Where the profile lacks something this section needs, write [NEEDS INPUT: what's missing] inline rather than inventing.
- Every major claim should serve a rubric criterion.

Return ONLY a JSON object:
{{
  "draft": "the full section text",
  "claims": [
    {{"claim": "each major factual claim made", "criterion_ref": "rubric criterion it serves or null",
      "evidence_ref": "the profile fact backing it, or null if unsupported"}}
  ]
}}"""

        text = await self._call(
            "draft", "section_draft_v1", prompt, correlation_id,
            application.id, max_tokens=6000,
        )
        data = _extract_json(text) or {}
        draft_text = str(data.get("draft") or text)

        claims = []
        for c in data.get("claims", []) or []:
            if isinstance(c, dict) and c.get("claim"):
                evidence_ref = c.get("evidence_ref")
                claims.append(ClaimFlag(
                    claim=str(c["claim"]),
                    criterion_ref=c.get("criterion_ref"),
                    evidence_ref=evidence_ref,
                    flagged=not evidence_ref,
                    reason=None if evidence_ref else "No supporting evidence in profile",
                ))

        section_draft = SectionDraft(
            id=f"sec_{uuid.uuid4().hex[:10]}",
            application_id=application.id,
            section_id=section.id,
            title=section.title,
            current_draft=draft_text,
            claims=claims,
        )
        self._apply_compliance(section_draft, section, profile)

        # Enforce voice: deterministic detect, AI rewrite if violated
        if section_draft.banned_phrase_hits:
            section_draft = await self._enforce_voice(
                section_draft, section, profile, correlation_id
            )
        return section_draft

    # =========================================================================
    # Stage: Refine (PRD 4.7)
    # =========================================================================

    async def refine_section(
        self,
        application: Application,
        section_draft: SectionDraft,
        section: RequiredSection,
        profile: OrganizationProfile,
        instruction: str,
        correlation_id: str,
        _allow_auto_tighten: bool = True,
    ) -> SectionDraft:
        limit_text = ""
        if section.word_limit:
            limit_text = f"HARD LIMIT: {section.word_limit} words maximum."
        elif section.char_limit:
            limit_text = f"HARD LIMIT: {section.char_limit} characters maximum."

        prompt = f"""Revise this grant application section according to one instruction. Change nothing else about its meaning; never introduce new facts.

SECTION: {section_draft.title}
{limit_text}

CURRENT DRAFT:
{section_draft.current_draft}

INSTRUCTION: {instruction}

{_voice_block(profile)}

Return ONLY a JSON object: {{"draft": "the revised section text"}}"""

        text = await self._call(
            "refine", "section_refine_v1", prompt, correlation_id,
            application.id, max_tokens=6000,
        )
        data = _extract_json(text) or {}
        revised = str(data.get("draft") or text)

        section_draft.versions.append(section_draft.current_draft)
        section_draft.current_draft = revised
        self._apply_compliance(section_draft, section, profile)

        if section_draft.banned_phrase_hits:
            section_draft = await self._enforce_voice(
                section_draft, section, profile, correlation_id
            )

        # Rule: if a revision pushes over the limit, produce a tightened version
        # (one automatic attempt; if still over, it stays flagged for the user)
        if section_draft.over_limit and _allow_auto_tighten:
            tighten = (
                f"Tighten to at most {section.word_limit} words"
                if section.word_limit
                else f"Tighten to at most {section.char_limit} characters"
            )
            section_draft.compliance_notes.append(
                f"Revision exceeded the limit; auto-tightening ({tighten})."
            )
            return await self.refine_section(
                application, section_draft, section, profile, tighten,
                correlation_id, _allow_auto_tighten=False,
            )

        return section_draft

    # =========================================================================
    # Stage: Enforce - voice check (PRD 4.9)
    # =========================================================================

    async def _enforce_voice(
        self,
        section_draft: SectionDraft,
        section: RequiredSection,
        profile: OrganizationProfile,
        correlation_id: str,
    ) -> SectionDraft:
        hits = section_draft.banned_phrase_hits
        prompt = f"""This text contains banned phrases / AI tells. Rewrite ONLY the offending sentences to remove them, preserving all facts and the overall length.

BANNED PHRASES FOUND: {json.dumps(hits)}

TEXT:
{section_draft.current_draft}

{_voice_block(profile)}

Return ONLY a JSON object: {{"draft": "the corrected full text"}}"""
        try:
            text = await self._call(
                "enforce", "voice_enforce_v1", prompt, correlation_id,
                section_draft.application_id, max_tokens=6000,
            )
            data = _extract_json(text) or {}
            corrected = str(data.get("draft") or "")
            if corrected:
                section_draft.versions.append(section_draft.current_draft)
                section_draft.current_draft = corrected
                section_draft.compliance_notes.append(
                    f"Voice enforcement rewrote banned phrases: {', '.join(hits[:5])}"
                )
                self._apply_compliance(section_draft, section, profile)
        except Exception as e:
            logger.warning(f"Voice enforcement failed, flagging instead: {e}")
            section_draft.compliance_notes.append(
                f"Banned phrases present (auto-rewrite failed): {', '.join(hits[:5])}"
            )
        return section_draft

    def _apply_compliance(
        self,
        section_draft: SectionDraft,
        section: RequiredSection,
        profile: OrganizationProfile,
    ) -> None:
        """Deterministic format + voice compliance (format is pass/fail)."""
        text = section_draft.current_draft
        section_draft.word_count = count_words(text)
        section_draft.char_count = len(text)
        over = False
        if section.word_limit and section_draft.word_count > section.word_limit:
            over = True
        if section.char_limit and section_draft.char_count > section.char_limit:
            over = True
        section_draft.over_limit = over
        extra_banned = (profile.voice_profile or {}).get("banned_phrases") if profile.voice_profile else []
        section_draft.banned_phrase_hits = find_banned_phrases(text, extra_banned)

    # =========================================================================
    # Stage: Score - self-critique (PRD 4.6)
    # =========================================================================

    async def score_draft(
        self,
        application: Application,
        spec: GrantSpec,
        drafts: List[SectionDraft],
        correlation_id: str,
    ) -> Scorecard:
        sections_text = "\n\n".join(
            f"=== {d.title} ({d.word_count} words) ===\n{d.current_draft}"
            for d in drafts
        )
        rubric_json = [c.model_dump() for c in spec.rubric]

        prompt = f"""You are a skeptical grant reviewer for {application.funder}. Score this draft application against the rubric. Be honest - your job is to find what costs points BEFORE the funder does.

RUBRIC (source: {spec.rubric_source}):
{json.dumps(rubric_json, indent=2)}

DRAFT APPLICATION:
{sections_text[:60000]}

Return ONLY a JSON object:
{{
  "per_criterion": [
    {{"criterion_id": "c1", "criterion_name": "...", "score": 0-100, "weight": null,
      "commentary": "what earns and what costs points here, citing the draft"}}
  ],
  "overall_score": 0-100,
  "top_fix": "THE single highest-leverage weakness - the 'missing 5 points' problem - stated specifically",
  "ranked_fixes": ["fixes ordered by score impact, most impactful first"]
}}"""

        text = await self._call(
            "score", "self_score_v1", prompt, correlation_id,
            application.id, max_tokens=5000,
        )
        data = _extract_json(text) or {}

        per_criterion = []
        for c in data.get("per_criterion", []) or []:
            if isinstance(c, dict) and c.get("criterion_name"):
                try:
                    score = float(c.get("score") or 0)
                except (TypeError, ValueError):
                    score = 0
                per_criterion.append(CriterionScore(
                    criterion_id=str(c.get("criterion_id") or ""),
                    criterion_name=str(c["criterion_name"]),
                    score=max(0, min(100, score)),
                    weight=c.get("weight"),
                    commentary=str(c.get("commentary") or ""),
                ))

        # Deterministic compliance results per hard constraint
        compliance = []
        for d in drafts:
            compliance.append({
                "section": d.title,
                "check": "word/char limit",
                "passed": not d.over_limit,
                "detail": f"{d.word_count} words / {d.char_count} chars",
            })
            compliance.append({
                "section": d.title,
                "check": "banned phrases",
                "passed": not d.banned_phrase_hits,
                "detail": ", ".join(d.banned_phrase_hits) or "clean",
            })
            unsupported = [c.claim for c in d.claims if c.flagged]
            compliance.append({
                "section": d.title,
                "check": "evidence-backed claims",
                "passed": not unsupported,
                "detail": f"{len(unsupported)} unsupported claim(s)" if unsupported else "all claims backed",
            })

        try:
            overall = float(data.get("overall_score") or 0)
        except (TypeError, ValueError):
            overall = 0

        return Scorecard(
            application_id=application.id,
            per_criterion=per_criterion,
            overall_score=max(0, min(100, overall)),
            top_fix=str(data.get("top_fix") or ""),
            ranked_fixes=[str(x) for x in data.get("ranked_fixes", []) or []],
            compliance_results=compliance,
            generated_at=datetime.utcnow(),
        )
