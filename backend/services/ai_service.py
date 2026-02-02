"""
AI Service for GrantFinder AI.
Handles all Claude API interactions for website scanning, questionnaire generation,
document extraction, and grant matching.
"""
import anthropic
import httpx
from bs4 import BeautifulSoup
import logging
import json
import uuid
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional

from models.schemas import (
    WebsiteScanResult, Questionnaire, QuestionnaireQuestion,
    DocumentExtractionResult, MatchResults, GrantMatch,
    MatchScoreBreakdown, MatchScoreTier, Grant, OrganizationProfile,
    GrantCategory, GeoQualified
)

logger = logging.getLogger(__name__)


class AIService:
    """Service for AI-powered analysis using Claude."""

    def __init__(self, api_key: str):
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = "claude-sonnet-4-20250514"

    async def _fetch_webpage(self, url: str) -> str:
        """Fetch and extract text from a webpage."""
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(url, follow_redirects=True)
                response.raise_for_status()

                soup = BeautifulSoup(response.text, 'html.parser')

                # Remove script and style elements
                for script in soup(["script", "style", "nav", "footer", "header"]):
                    script.decompose()

                text = soup.get_text(separator='\n', strip=True)

                # Limit text length
                return text[:50000]

        except Exception as e:
            logger.error(f"Failed to fetch {url}: {e}")
            return ""

    async def scan_websites(
        self,
        church_url: Optional[str] = None,
        school_url: Optional[str] = None
    ) -> WebsiteScanResult:
        """
        Scan church and/or school websites to extract organization information.
        Prompt 1 from spec: Website Scanning
        """
        website_content = ""

        if church_url:
            church_text = await self._fetch_webpage(church_url)
            website_content += f"\n\n=== CHURCH WEBSITE ({church_url}) ===\n{church_text}"

        if school_url:
            school_text = await self._fetch_webpage(school_url)
            website_content += f"\n\n=== SCHOOL WEBSITE ({school_url}) ===\n{school_text}"

        if not website_content.strip():
            return WebsiteScanResult(
                organization_basics={},
                leadership={},
                school_info=None,
                facilities=[],
                current_initiatives=[],
                extracted_text_length=0,
            )

        prompt = f"""Analyze these Catholic parish/school website(s) and extract structured information.

{website_content}

Extract and return a JSON object with:
{{
    "organization_basics": {{
        "name": "Parish/School name",
        "city": "City",
        "state": "State (2-letter code)",
        "diocese": "Diocese name if mentioned",
        "address": "Full address if found"
    }},
    "leadership": {{
        "pastor": "Pastor name if found",
        "principal": "Principal name if found",
        "staff": ["Other key staff mentioned"]
    }},
    "school_info": {{
        "name": "School name",
        "grades": "Grade levels served",
        "student_count": number or null,
        "accreditation": "Accreditation info if mentioned"
    }},
    "facilities": ["List of facilities/buildings mentioned"],
    "current_initiatives": ["List of programs, projects, or initiatives mentioned"]
}}

If school website is not provided or no school info found, set school_info to null.
Return ONLY the JSON object, no other text."""

        try:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=2000,
                messages=[{"role": "user", "content": prompt}]
            )

            # Parse response
            response_text = response.content[0].text
            # Clean up potential markdown code blocks
            if response_text.startswith("```"):
                response_text = response_text.split("```")[1]
                if response_text.startswith("json"):
                    response_text = response_text[4:]

            data = json.loads(response_text.strip())

            return WebsiteScanResult(
                organization_basics=data.get("organization_basics", {}),
                leadership=data.get("leadership", {}),
                school_info=data.get("school_info"),
                facilities=data.get("facilities", []),
                current_initiatives=data.get("current_initiatives", []),
                extracted_text_length=len(website_content),
            )

        except Exception as e:
            logger.error(f"Website scan AI error: {e}")
            return WebsiteScanResult(
                organization_basics={},
                leadership={},
                school_info=None,
                facilities=[],
                current_initiatives=[],
                extracted_text_length=len(website_content),
            )

    async def generate_questionnaire(self, grants: List[Grant]) -> Questionnaire:
        """
        Generate smart questionnaire based on grant eligibility requirements.
        Prompt 2 from spec: Questionnaire Generation
        Max 20 questions per spec.
        """
        # Summarize grants for the prompt
        grant_summary = []
        for g in grants[:50]:  # Limit to avoid token limits
            grant_summary.append({
                "name": g.grant_name,
                "funder": g.funder,
                "description": g.description[:200],
                "geo_qualified": g.geo_qualified.value,
            })

        prompt = f"""You are helping a Catholic parish or school find grant opportunities.

Based on these grants, generate a smart questionnaire to gather information needed to match organizations with appropriate grants. The questionnaire should focus on eligibility criteria commonly found in these grants.

GRANTS DATABASE (sample):
{json.dumps(grant_summary, indent=2)}

Generate a questionnaire with EXACTLY 20 or fewer questions that will help determine:
1. Basic eligibility (501c3 status, Catholic affiliation, location)
2. Organization type and size
3. Current programs and services
4. Facility needs and conditions
5. Security concerns
6. Financial capacity
7. Past grant experience

Return a JSON array of questions:
[
    {{
        "id": 1,
        "question": "Question text",
        "question_type": "boolean|text|select|multiselect",
        "options": ["option1", "option2"] (for select/multiselect only),
        "required": true/false,
        "grant_relevance": ["Grant names this question helps evaluate"]
    }}
]

Make questions clear, specific, and relevant to Catholic parish/school contexts.
Return ONLY the JSON array, no other text."""

        try:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=3000,
                messages=[{"role": "user", "content": prompt}]
            )

            response_text = response.content[0].text
            if response_text.startswith("```"):
                response_text = response_text.split("```")[1]
                if response_text.startswith("json"):
                    response_text = response_text[4:]

            questions_data = json.loads(response_text.strip())

            questions = [
                QuestionnaireQuestion(**q)
                for q in questions_data[:20]  # Enforce max 20
            ]

            return Questionnaire(
                questions=questions,
                total_questions=len(questions)
            )

        except Exception as e:
            logger.error(f"Questionnaire generation error: {e}")
            # Return default questions on error
            return self._get_default_questionnaire()

    def _get_default_questionnaire(self) -> Questionnaire:
        """Return default questionnaire if AI generation fails."""
        questions = [
            QuestionnaireQuestion(
                id=1, question="Is your organization a registered 501(c)(3) nonprofit?",
                question_type="boolean", required=True, grant_relevance=["All grants"]
            ),
            QuestionnaireQuestion(
                id=2, question="What type of organization are you?",
                question_type="select", options=["Parish only", "School only", "Parish with school"],
                required=True, grant_relevance=["All grants"]
            ),
            QuestionnaireQuestion(
                id=3, question="In which state is your organization located?",
                question_type="text", required=True, grant_relevance=["Geographic grants"]
            ),
            QuestionnaireQuestion(
                id=4, question="What is your approximate annual operating budget?",
                question_type="select",
                options=["Under $250,000", "$250,000-$500,000", "$500,000-$1M", "Over $1M"],
                required=True, grant_relevance=["Capacity-based grants"]
            ),
            QuestionnaireQuestion(
                id=5, question="Do you have any current facility repair or renovation needs?",
                question_type="boolean", required=True, grant_relevance=["Facility grants"]
            ),
            QuestionnaireQuestion(
                id=6, question="Do you operate a food pantry or food assistance program?",
                question_type="boolean", required=True, grant_relevance=["Hunger relief grants"]
            ),
            QuestionnaireQuestion(
                id=7, question="Have you received grant funding in the past 3 years?",
                question_type="boolean", required=True, grant_relevance=["All grants"]
            ),
            QuestionnaireQuestion(
                id=8, question="Do you have security concerns or need security improvements?",
                question_type="boolean", required=True, grant_relevance=["Security grants"]
            ),
        ]

        return Questionnaire(questions=questions, total_questions=len(questions))

    async def extract_document_signals(
        self,
        text: str,
        filename: str
    ) -> DocumentExtractionResult:
        """
        Extract grant-relevant signals from document text.
        Prompt 3 from spec: Document Extraction
        """
        prompt = f"""Analyze this document from a Catholic parish or school and extract information relevant to grant applications.

DOCUMENT: {filename}
CONTENT:
{text[:30000]}

Extract and categorize any mentions of:
1. Facility needs (repairs, renovations, equipment)
2. Program needs (new programs, program expansions, staffing)
3. Security concerns (safety issues, security equipment needs)
4. Other grant-relevant signals (financial challenges, growth opportunities, community needs)

IMPORTANT: Ignore irrelevant content like mass times, prayer intentions, event announcements.
Focus on actionable needs that could be addressed with grant funding.

Return a JSON object:
{{
    "facility_needs": ["List of specific facility needs mentioned"],
    "program_needs": ["List of specific program needs mentioned"],
    "security_concerns": ["List of specific security concerns mentioned"],
    "other_signals": ["Other relevant information for grant matching"]
}}

Return ONLY the JSON object, no other text."""

        try:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=2000,
                messages=[{"role": "user", "content": prompt}]
            )

            response_text = response.content[0].text
            if response_text.startswith("```"):
                response_text = response_text.split("```")[1]
                if response_text.startswith("json"):
                    response_text = response_text[4:]

            data = json.loads(response_text.strip())

            return DocumentExtractionResult(
                document_id=str(uuid.uuid4()),
                filename=filename,
                extracted_text_length=len(text),
                facility_needs=data.get("facility_needs", []),
                program_needs=data.get("program_needs", []),
                security_concerns=data.get("security_concerns", []),
                other_signals=data.get("other_signals", []),
            )

        except Exception as e:
            logger.error(f"Document extraction error: {e}")
            return DocumentExtractionResult(
                document_id=str(uuid.uuid4()),
                filename=filename,
                extracted_text_length=len(text),
                facility_needs=[],
                program_needs=[],
                security_concerns=[],
                other_signals=[],
            )

    async def match_grants(
        self,
        grants: List[Grant],
        profile: OrganizationProfile,
        user_id: str
    ) -> MatchResults:
        """
        Match grants to organization profile with probability scoring.
        Prompt 4 from spec: Grant Matching

        Scoring weights per v2.6 spec:
        - Eligibility fit (40%)
        - Need alignment (30%)
        - Capacity signals (15%)
        - Timing (10%)
        - Completeness (5%)
        """
        session_id = str(uuid.uuid4())
        matches: List[GrantMatch] = []

        # Process in batches to manage token limits
        batch_size = 10
        for i in range(0, len(grants), batch_size):
            batch = grants[i:i + batch_size]
            batch_matches = await self._score_grant_batch(batch, profile)
            matches.extend(batch_matches)

        # Sort by score descending
        matches.sort(key=lambda x: x.score, reverse=True)

        # Count by tier
        excellent = len([m for m in matches if m.score >= 85])
        good = len([m for m in matches if 70 <= m.score < 85])
        possible = len([m for m in matches if 50 <= m.score < 70])
        weak = len([m for m in matches if 25 <= m.score < 50])
        not_eligible = len([m for m in matches if m.score < 25])

        return MatchResults(
            session_id=session_id,
            user_id=user_id,
            profile_id=profile.id or user_id,
            total_grants_evaluated=len(grants),
            matches=matches,
            excellent_matches=excellent,
            good_matches=good,
            possible_matches=possible,
            weak_matches=weak,
            not_eligible=not_eligible,
            created_at=datetime.utcnow(),
            expires_at=datetime.utcnow() + timedelta(days=90),
        )

    async def _score_grant_batch(
        self,
        grants: List[Grant],
        profile: OrganizationProfile
    ) -> List[GrantMatch]:
        """Score a batch of grants against the profile."""

        profile_summary = {
            "name": profile.organization_name,
            "type": profile.organization_type,
            "city": profile.city,
            "state": profile.state,
            "has_school": profile.has_school,
            "is_501c3": profile.is_501c3,
            "facility_needs": profile.facility_needs,
            "program_needs": profile.program_needs,
            "security_concerns": profile.security_concerns,
            "current_initiatives": profile.current_initiatives,
            "annual_budget": profile.annual_budget,
        }

        grants_data = [
            {
                "id": g.id,
                "name": g.grant_name,
                "funder": g.funder,
                "amount": g.amount,
                "deadline": g.deadline,
                "description": g.description,
                "geo_qualified": g.geo_qualified.value,
                "category": g.category.value,
                "url": g.url,
                "contact": g.contact,
            }
            for g in grants
        ]

        prompt = f"""Score each grant for this Catholic organization.

ORGANIZATION PROFILE:
{json.dumps(profile_summary, indent=2)}

GRANTS TO EVALUATE:
{json.dumps(grants_data, indent=2)}

For EACH grant, calculate a probability score (0-100%) using these weights:
- Eligibility fit (40%): Does org meet hard requirements? (501c3, geography, Catholic status)
- Need alignment (30%): Does org have documented need matching grant purpose?
- Capacity signals (15%): Size, staffing, volunteer base indicate ability to use grant
- Timing (10%): Deadline is feasible, project readiness
- Completeness (5%): Do we have enough info to assess accurately?

Score interpretation:
- 85-100%: Excellent Match
- 70-84%: Good Match
- 50-69%: Possible Match
- 25-49%: Weak Match
- 0-24%: Not Eligible

Return a JSON array with one object per grant:
[
    {{
        "grant_id": "id from input",
        "score": 75,
        "score_breakdown": {{
            "eligibility_fit": 80,
            "need_alignment": 70,
            "capacity_signals": 75,
            "timing": 80,
            "completeness": 60
        }},
        "explanation": "Brief explanation of why this score",
        "evidence": ["Specific evidence from profile that influenced score"]
    }}
]

Be conservative - if information is missing, lower the completeness score.
Return ONLY the JSON array."""

        try:
            response = self.client.messages.create(
                model=self.model,
                max_tokens=4000,
                messages=[{"role": "user", "content": prompt}]
            )

            response_text = response.content[0].text
            if response_text.startswith("```"):
                response_text = response_text.split("```")[1]
                if response_text.startswith("json"):
                    response_text = response_text[4:]

            scores_data = json.loads(response_text.strip())

            # Map scores back to grants
            grant_map = {g.id: g for g in grants}
            matches = []

            for score_data in scores_data:
                grant_id = score_data.get("grant_id")
                grant = grant_map.get(grant_id)

                if not grant:
                    continue

                score = score_data.get("score", 0)
                breakdown_data = score_data.get("score_breakdown", {})

                breakdown = MatchScoreBreakdown(
                    eligibility_fit=breakdown_data.get("eligibility_fit", 0),
                    need_alignment=breakdown_data.get("need_alignment", 0),
                    capacity_signals=breakdown_data.get("capacity_signals", 0),
                    timing=breakdown_data.get("timing", 0),
                    completeness=breakdown_data.get("completeness", 0),
                )

                # Determine tier
                if score >= 85:
                    tier = MatchScoreTier.EXCELLENT
                elif score >= 70:
                    tier = MatchScoreTier.GOOD
                elif score >= 50:
                    tier = MatchScoreTier.POSSIBLE
                elif score >= 25:
                    tier = MatchScoreTier.WEAK
                else:
                    tier = MatchScoreTier.NOT_ELIGIBLE

                match = GrantMatch(
                    grant_id=grant_id,
                    grant_name=grant.grant_name,
                    funder=grant.funder,
                    amount=grant.amount,
                    deadline=grant.deadline,
                    url=grant.url,
                    contact=grant.contact,
                    category=grant.category,
                    geo_qualified=grant.geo_qualified,
                    score=score,
                    score_tier=tier,
                    score_breakdown=breakdown,
                    explanation=score_data.get("explanation", ""),
                    evidence=score_data.get("evidence", []),
                )

                matches.append(match)

            return matches

        except Exception as e:
            logger.error(f"Grant scoring error: {e}")
            # Return default scores on error
            return [
                GrantMatch(
                    grant_id=g.id,
                    grant_name=g.grant_name,
                    funder=g.funder,
                    amount=g.amount,
                    deadline=g.deadline,
                    url=g.url,
                    contact=g.contact,
                    category=g.category,
                    geo_qualified=g.geo_qualified,
                    score=50,
                    score_tier=MatchScoreTier.POSSIBLE,
                    score_breakdown=MatchScoreBreakdown(
                        eligibility_fit=50,
                        need_alignment=50,
                        capacity_signals=50,
                        timing=50,
                        completeness=50,
                    ),
                    explanation="Unable to fully evaluate - please review manually",
                    evidence=[],
                )
                for g in grants
            ]
