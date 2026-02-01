import json
from typing import Optional, List, AsyncGenerator
import anthropic

from app.core.security import decrypt_api_key


class AIService:
    """Service for interacting with Claude API."""

    def __init__(self, encrypted_api_key: str):
        api_key = decrypt_api_key(encrypted_api_key)
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = "claude-sonnet-4-20250514"

    async def generate_questionnaire(self, grants: List[dict]) -> List[dict]:
        """Generate a questionnaire based on grant database."""
        prompt = f"""You are helping generate a questionnaire for Catholic parishes and schools
to determine their eligibility for grants.

Here are all the grants in our database:
{json.dumps(grants, indent=2)}

Based on the eligibility requirements and funding purposes of these grants,
generate a questionnaire that will help us match organizations to the right grants.

Rules:
- Only ask questions that are relevant to 2+ grants
- Group questions by topic (Organization, Location, School, Facilities, Programs, Needs)
- Use simple language (avoid grant jargon)
- Include question type: multiple_choice, yes_no, text, number
- Cap at 20 questions max
- For each question, note which grants it helps filter

Return as a JSON array of question objects with this structure:
{{
  "id": "unique_id",
  "text": "Question text",
  "type": "yes_no" | "multiple_choice" | "text" | "number",
  "options": ["Option 1", "Option 2"] (for multiple_choice only),
  "topic": "Organization" | "Location" | "School" | "Facilities" | "Programs" | "Needs",
  "conditional": {{ "depends_on": "question_id", "show_if": "value" }} (optional),
  "relevant_grants": ["grant_name_1", "grant_name_2"]
}}

Return ONLY the JSON array, no other text."""

        response = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}]
        )

        text = response.content[0].text
        # Parse JSON from response
        try:
            # Try to extract JSON from the response
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]
            return json.loads(text)
        except json.JSONDecodeError:
            return []

    async def extract_from_website(self, url: str, content: str) -> dict:
        """Extract grant-relevant information from website content."""
        prompt = f"""You are analyzing a Catholic parish/school website to extract information
relevant to grant applications.

Website URL: {url}
Website content:
{content[:50000]}

Extract the following if present:
1. Organization basics: name, location, diocese, founding year
2. Leadership: pastor name, principal name, key staff
3. School info: grades served, enrollment, programs offered
4. Ministries and programs: list all mentioned
5. Facilities: building descriptions, age indicators, recent renovations
6. Current needs or initiatives: capital campaigns, wish lists, announcements
7. Community: number of families, demographics mentioned
8. Recent news: anything indicating current projects or priorities

For each item found:
- Note the specific page/section it came from
- Include relevant quotes
- Rate confidence: high, medium, low

Return as JSON with this structure:
{{
  "parish_name": "string",
  "location": "string",
  "diocese": "string",
  "founded_year": number or null,
  "mission_statement": "string or null",
  "leadership": [{{ "name": "string", "role": "string" }}],
  "school_info": {{
    "has_school": boolean,
    "grades": "string",
    "enrollment": number or null,
    "programs": ["string"]
  }},
  "ministries": ["string"],
  "facilities": [{{ "description": "string", "age_indicator": "string or null" }}],
  "needs_identified": [{{
    "need": "string",
    "quote": "string",
    "confidence": "high" | "medium" | "low"
  }}],
  "community_size": {{
    "families": number or null,
    "notes": "string"
  }},
  "recent_news": ["string"]
}}

Return ONLY the JSON, no other text."""

        response = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}]
        )

        text = response.content[0].text
        try:
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]
            return json.loads(text)
        except json.JSONDecodeError:
            return {}

    async def extract_from_document(self, document_text: str, document_type: str, filename: str) -> List[dict]:
        """Extract grant-relevant needs from a document."""
        prompt = f"""You are analyzing documents from a Catholic parish/school to identify
information relevant to grant applications.

Document: {filename}
Document type: {document_type}
Content:
{document_text[:50000]}

Extract:
1. Facility needs (repairs, renovations, equipment)
2. Program needs (curriculum, staffing, expansion)
3. Security concerns
4. Technology needs
5. Community/outreach initiatives
6. Any mention of budgets, timelines, or priorities

For each item found:
- Describe the need in 1-2 sentences
- Include a direct quote from the document
- Rate confidence: high, medium, low
- Note if it seems time-sensitive

Ignore: mass times, prayer intentions, contact info, routine announcements

Return as JSON array:
[{{
  "need": "string describing the need",
  "quote": "direct quote from document",
  "confidence": "high" | "medium" | "low",
  "time_sensitive": boolean,
  "category": "facility" | "program" | "security" | "technology" | "outreach" | "other"
}}]

Return ONLY the JSON array, no other text."""

        response = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}]
        )

        text = response.content[0].text
        try:
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]
            return json.loads(text)
        except json.JSONDecodeError:
            return []

    async def generate_profile(self, organization_data: dict) -> dict:
        """Generate a parish profile from all collected data."""
        prompt = f"""You are synthesizing all collected information about a Catholic parish/school
into a comprehensive profile for grant matching.

Organization data:
{json.dumps(organization_data, indent=2)}

Create a profile that summarizes:
1. Organization Facts (verified information)
2. All identified needs and projects (with sources)
3. Capacity indicators (size, programs, staff)
4. Special characteristics (historic building, mission diocese, etc.)

Return as JSON:
{{
  "organization_facts": {{
    "name": "string",
    "type": "parish" | "parish_with_school" | "school",
    "is_501c3": boolean,
    "in_catholic_directory": boolean,
    "diocese": "string",
    "state": "string",
    "location_type": "urban" | "suburban" | "rural",
    "founded_year": number or null,
    "building_age_years": number or null,
    "parish_families": number or null,
    "student_count": number or null,
    "school_grades": "string or null"
  }},
  "needs_and_projects": [{{
    "need": "string",
    "source": "string",
    "source_type": "document" | "website" | "questionnaire" | "free_form",
    "quote": "string or null",
    "confidence": "high" | "medium" | "low",
    "category": "string"
  }}],
  "capacity_indicators": {{
    "staff_mentioned": ["string"],
    "active_ministries": number,
    "programs": ["string"],
    "volunteer_capacity": "high" | "medium" | "low" | "unknown"
  }},
  "special_characteristics": ["string"]
}}

Return ONLY the JSON, no other text."""

        response = self.client.messages.create(
            model=self.model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}]
        )

        text = response.content[0].text
        try:
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]
            return json.loads(text)
        except json.JSONDecodeError:
            return {}

    async def match_grants(self, profile: dict, grants: List[dict]) -> List[dict]:
        """Match organization profile against grants and score each one."""
        prompt = f"""You are a grant matching expert for Catholic parishes and schools.

ORGANIZATION PROFILE:
{json.dumps(profile, indent=2)}

AVAILABLE GRANTS:
{json.dumps(grants, indent=2)}

SCORING SYSTEM (0-100%):
- Eligibility fit (40%): Does org meet hard requirements? (501c3, geography, Catholic, etc.)
- Need alignment (30%): Does org have a documented need matching grant purpose?
- Capacity signals (15%): Size, staffing, past success indicators
- Timing (10%): Deadline feasibility, project readiness
- Completeness (5%): Do we have enough info to assess?

TASK:
Match this organization to ALL grants. For each grant:

1. Check hard disqualifiers first (if ineligible, score 0-24%)
2. Calculate score based on the weighting above
3. Explain WHY it's a match or not — reference specific details from their profile
4. Note any eligibility questions they should verify
5. Flag deadline urgency (if <30 days)

Return as JSON array (ALL grants, sorted by score descending):
[{{
  "grant_id": "string or number",
  "grant_name": "string",
  "score": number (0-100),
  "score_breakdown": {{
    "eligibility": number (0-40),
    "need_alignment": number (0-30),
    "capacity": number (0-15),
    "timing": number (0-10),
    "completeness": number (0-5)
  }},
  "why_it_fits": "2-3 sentences explaining the match, referencing specific profile details",
  "eligibility_notes": ["any concerns or things they meet"],
  "verify_items": ["things to verify before applying"],
  "deadline_urgent": boolean
}}]

Return ONLY the JSON array, no other text."""

        response = self.client.messages.create(
            model=self.model,
            max_tokens=8192,
            messages=[{"role": "user", "content": prompt}]
        )

        text = response.content[0].text
        try:
            if "```json" in text:
                text = text.split("```json")[1].split("```")[0]
            elif "```" in text:
                text = text.split("```")[1].split("```")[0]
            return json.loads(text)
        except json.JSONDecodeError:
            return []

    def stream_status(self, message: str) -> str:
        """Format a status message for terminal-style display."""
        from datetime import datetime
        timestamp = datetime.now().strftime("%H:%M:%S")
        return f"[{timestamp}] {message}"
