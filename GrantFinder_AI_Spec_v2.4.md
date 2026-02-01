# GrantFinder AI — Product Specification v2.2

**Document Version:** 2.2  
**Last Updated:** February 1, 2026  
**Status:** Draft for Review

---

## 1. Product Name & Problem Statement

### Product Name
**GrantFinder AI** — An autonomous grant matching and application agent for Catholic parishes and schools

### Problem It Solves
Catholic churches and schools have access to hundreds of potential grant opportunities, but:
- **No one has time** to read through every grant's eligibility criteria and match them to what's happening on campus
- **Important details are buried** in newsletters, meeting minutes, and bulletins — not in tidy project lists
- **Matching is manual** — someone has to remember "oh, that playground mention in the bulletin might fit that KaBOOM! grant"
- **Applications are time-consuming** — even after finding a match, writing applications takes hours
- **Deadlines slip by** because the right person didn't know the right grant existed at the right time

**GrantFinder AI** scans your website, reads your documents, asks smart questions, matches you to grants — and ultimately applies on your behalf with human review before submission.

### Core Value Proposition
> "Upload your documents. Let AI find and apply to grants for you. Review before it clicks submit."

### Product Vision (Phased)
| Phase | Capability |
|-------|------------|
| **v1.0 (MVP)** | Grant discovery + probability scoring — surface all opportunities, rank by fit |
| **v1.5** | Teacher Edition — lighter version for classroom grants (DonorsChoose, supply grants) |
| **v2.0** | AI drafts grant applications for human review |
| **v3.0** | Autonomous application submission with human approval gate |

**v1.0 Focus:** Find the grants. Score the matches. Help the user see what's worth pursuing. No application writing yet.

---

## 2. User Story

### Primary User
**Parish Administrator, School Principal, Development Director, or Pastor** at a Catholic church (with or without a school)

### What They're Trying to Accomplish
> "I have bulletins, meeting minutes, and newsletters full of things happening at our parish. I have a list of grants somewhere. I want to know: **which grants should we actually pursue**, based on what's really going on here — without me having to cross-reference everything manually."

### User Journey (Current State — Pain)
1. Receive grant spreadsheet or list of opportunities
2. Read through each grant's requirements
3. Try to remember what's happening at the parish that might qualify
4. Dig through old bulletins/minutes to find details
5. Miss connections because it's too time-consuming
6. Deadlines pass, opportunities lost

### User Journey (Future State — With GrantFinder AI)
1. Open GrantFinder AI (web app)
2. Enter API key (one-time setup)
3. Upload grant database (or use pre-loaded)
4. Upload parish documents (bulletins, minutes, newsletters)
5. Add any free-form context ("We're really hoping to fix the playground...")
6. Answer AI-generated questionnaire (based on what grants actually require)
7. Review AI's understanding: "Here's what I learned about your parish..."
8. Click "Find Matches"
9. Get ranked recommendations with explanations
10. Export and share with pastor, finance council, school board
11. Decide which grants to pursue

---

## 3. Core Functionality

### 3.1 Setup & Configuration
- User enters Claude API key via web interface (stored securely)
- User uploads grant database (Excel) OR uses pre-loaded Catholic grant database
- User provides church/school website URL(s) for scanning
- Settings persist across sessions (cloud) or can be exported (local)

### 3.1.1 Settings & Preferences

**Appearance:**
- Light mode / Dark mode toggle
- **Default: Dark mode**

**Notifications:**
- Email when new grants match profile (future)
- Deadline reminders (future)

### 3.1.2 Terminal UI — Processing States

When the app is doing work, display a **terminal-style interface** showing real-time activity. This gives users transparency into what the AI is doing and creates a "the machine is working" feel.

**Visual Design:**
- Dark background (near-black: #0d1117 or similar)
- Monospace font (JetBrains Mono, Fira Code, or SF Mono)
- Green/cyan text for activity (#00ff00, #00ffff)
- Dim gray for timestamps
- Animated cursor or blinking indicator

**Example: Website Scanning**
```
┌─────────────────────────────────────────────────────────────┐
│ GrantFinder AI — Scanning Website                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ [14:32:01] Connecting to https://sttheresa.org...          │
│ [14:32:02] ✓ Found homepage                                │
│ [14:32:03] Scanning /about...                              │
│ [14:32:04] ✓ Extracted: Parish founded 1978                │
│ [14:32:04] ✓ Extracted: ~1,200 registered families         │
│ [14:32:05] Scanning /school...                             │
│ [14:32:06] ✓ Extracted: PreK-8, 250 students               │
│ [14:32:07] ✓ Extracted: STEM program mentioned             │
│ [14:32:08] Scanning /ministries...                         │
│ [14:32:09] ✓ Found 12 active ministries                    │
│ [14:32:10] Scanning /news...                               │
│ [14:32:11] ✓ Found 8 recent announcements                  │
│ [14:32:12] Crawl complete. 24 pages scanned.               │
│                                                             │
│ [Press any key to continue]                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Example: Document Processing**
```
┌─────────────────────────────────────────────────────────────┐
│ GrantFinder AI — Processing Documents                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ [14:35:01] Reading bulletin_2026-03-15.pdf...              │
│ [14:35:03] ✓ Extracted 2 grant-relevant items              │
│            → Playground equipment aging                     │
│            → Youth ministry expansion                       │
│ [14:35:04] Reading finance_council_jan2026.docx...         │
│ [14:35:06] ✓ Extracted 1 grant-relevant item               │
│            → Security camera discussion                     │
│ [14:35:07] Reading school_newsletter_feb.pdf...            │
│ [14:35:09] ✓ Extracted 3 grant-relevant items              │
│            → STEM curriculum interest                       │
│            → Technology needs                               │
│            → Enrollment growth                              │
│ [14:35:10] Document processing complete.                   │
│            6 needs identified across 3 documents.          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Example: Grant Matching**
```
┌─────────────────────────────────────────────────────────────┐
│ GrantFinder AI — Finding Matches                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ [14:40:01] Loading parish profile...                       │
│ [14:40:02] Loading 52 grants from database...              │
│ [14:40:03] Analyzing eligibility requirements...           │
│ [14:40:05] ┌─ Checking: Koch Foundation                    │
│ [14:40:05] │  ✓ 501(c)(3): Yes                             │
│ [14:40:05] │  ✓ Catholic Directory: Yes                    │
│ [14:40:05] │  ✓ Geographic: No restriction                 │
│ [14:40:05] │  → ELIGIBLE                                   │
│ [14:40:06] ├─ Checking: KaBOOM! Playground                 │
│ [14:40:06] │  ✓ Nonprofit: Yes                             │
│ [14:40:06] │  ✓ Community org: Yes                         │
│ [14:40:06] │  ✓ Need identified: Playground aging          │
│ [14:40:06] │  → HIGH MATCH                                 │
│ [14:40:07] ├─ Checking: Hilton Fund for Sisters            │
│ [14:40:07] │  ✗ Requires: Women religious community        │
│ [14:40:07] │  → NOT ELIGIBLE                               │
│ [14:40:08] └─ ...analyzing 49 more grants...               │
│                                                             │
│ [14:40:25] Matching complete.                              │
│            4 high matches, 7 medium matches found.         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Implementation Notes:**
- Use WebSocket or Server-Sent Events (SSE) for real-time streaming
- Log entries appear one at a time with slight delay for readability
- User can scroll up to see history
- "Skip" button to jump to results (processing continues in background)

### 3.2 Context Gathering — Four Input Sources

#### Source 1: Website Scanning
AI automatically crawls the church/school website to extract relevant information.

**What it looks for:**
- About page (history, mission, size, location)
- Staff/leadership pages (pastor, principal, key contacts)
- School information (grades, enrollment, programs)
- Ministries and programs
- News/announcements
- Capital campaigns or wish lists
- Photos (building age indicators, facilities)

**User provides:**
- Church website URL
- School website URL (if separate)

**Why this matters:** Most parishes already have information online they'd have to re-enter. AI grabs it automatically.

#### Source 2: AI-Generated Questionnaire
The AI reads all grants in the database and generates a smart questionnaire based on actual eligibility requirements and funding purposes.

**Example questions generated:**
- Are you a registered 501(c)(3) organization?
- Are you listed in the Official Catholic Directory?
- What state is your parish located in?
- Do you have a school? If yes, what grades?
- How old is your main building? (Relevant for historic preservation grants)
- Are you in a rural or urban area?
- Is your parish considered low-income or in a mission diocese?

**Why this matters:** The AI asks what it needs to know — no more, no less. If no grants in the database care about building age, it won't ask.

#### Source 3: Free-Form Text
User can write anything relevant about what's happening at the parish or school:

> "We're hoping to renovate the gym next year. The AC in the school has been failing. Father wants to explore security cameras after some incidents in the parking lot. Our youth group is really active and we'd love to expand programming."

**Why this matters:** Captures soft signals, aspirations, and context that don't fit in checkboxes.

#### Source 4: Document Uploads
User uploads actual parish/school documents. AI extracts grant-relevant information.

**Supported document types:**

| Church Side | School Side | Both |
|-------------|-------------|------|
| Weekly bulletins | School newsletters | Meeting minutes |
| E-bulletins | Principal updates | Strategic plans |
| Pastor's letters | Enrollment reports | Capital campaign materials |
| Parish annual reports | Accreditation docs | Budget documents |
| Ministry updates | Curriculum plans | Bishop's pastoral visit notes |

**Why this matters:** A bulletin might mention "playground equipment is 30 years old" — the user might not think to mention that, but AI catches it and matches to playground grants.

### 3.3 AI Processing & Parish Profile

After gathering all inputs, AI synthesizes a **Parish Profile** and shows it to the user for review:

```
PARISH PROFILE — St. Theresa Catholic Church & School

ORGANIZATION FACTS:
✓ 501(c)(3) Catholic parish with K-8 school
✓ Diocese of Austin, Texas
✓ Listed in Official Catholic Directory
✓ 250 students, ~1,200 families
✓ Campus is 45 years old (eligible for historic preservation grants)
✓ Urban location

CURRENT NEEDS & PROJECTS IDENTIFIED:

From your documents:
• Playground equipment replacement (bulletin: "equipment is showing its age")
• Security concerns (minutes: "discussed camera system after break-in")
• Youth ministry expansion (bulletin: "youth group growing rapidly")

From your free-form notes:
• HVAC/AC system failing in school building
• Gym renovation interest for next year

From questionnaire:
• Interested in STEM curriculum development
• No current technology grants in place

[Looks Good — Find Matches]  [Edit / Correct Something]
```

**Why this matters:** User can catch errors before matching. ("Actually, we already got funding for the AC — remove that.")

### 3.4 Grant Matching

AI cross-references the Parish Profile against all grants in the database:

**Matching criteria:**
- Eligibility alignment (501c3, Catholic Directory, geographic, etc.)
- Funding purpose match (what grant funds vs. what parish needs)
- Amount appropriateness (grant size vs. estimated project scope)
- Deadline feasibility (enough time to apply?)
- Special fit factors (historic building, mission diocese, school grades, etc.)

**Match output for each grant:**
- Match quality: **High** / **Medium** / **Low**
- Why it's a good fit (2-3 sentences referencing specific parish details)
- Any eligibility concerns or questions to verify
- Deadline and urgency flag
- Link to apply

### 3.5 Results Review & Export

User sees ranked recommendations grouped by match quality.

**Example result:**

```
🟢 HIGH MATCH

KaBOOM! Build It Yourself Grant
Amount: Up to $15,000 | Deadline: Rolling (Open)

WHY IT FITS:
Your March 15 bulletin mentioned "playground equipment is 30 years old 
and showing its age." KaBOOM! specifically funds playground equipment 
replacement for community organizations including churches and schools. 
Your parish's active family ministry suggests strong volunteer capacity 
for a community build.

VERIFY BEFORE APPLYING:
• Confirm you can organize 50+ volunteers for build day

[View Grant Details]  [Add to Shortlist]
```

**Export options:**
- PDF report (shareable with pastor, finance council)
- Markdown file
- CSV of shortlisted grants

---

## 4. Inputs and Outputs

### Inputs

| Input | Format | Required? | Notes |
|-------|--------|-----------|-------|
| Claude API Key | String | Yes | Entered in web UI, stored encrypted |
| Grant Database | Excel (.xlsx) | Yes | User uploads their grants |
| Church Website URL | URL | No | AI scans for org info |
| School Website URL | URL | No | AI scans if separate from church |
| Questionnaire Answers | Form responses | Yes | AI-generated questions |
| Free-Form Context | Text | No | Optional but helpful |
| Document Uploads | PDF, DOCX, TXT | No | Multiple files supported |

### Outputs

| Output | Format | Description |
|--------|--------|-------------|
| Parish Profile | On-screen | AI's understanding of the org (reviewable/editable) |
| Match Results | On-screen | All grants scored and ranked by probability of fit |
| Match Score | 0-100% | Probability score for each grant |
| **Grant Amount** | Currency | Min/max or "up to" amount displayed prominently |
| **Due Date** | Date | Deadline displayed prominently; "Rolling" if ongoing |
| Match Explanations | Text | AI reasoning referencing specific inputs |
| Export Report | PDF / MD / CSV | Shareable summary |

### Match Card Display (Required Fields)

Every grant match MUST display these fields prominently:

```
┌─────────────────────────────────────────────────────────┐
│ 92%  Grant Name                                         │
│      $5,000 - $15,000  |  Due: March 15, 2026          │
│      ─────────────────────────────────────────────────  │
│      Why it fits: [explanation]                         │
└─────────────────────────────────────────────────────────┘
```

**Amount formatting:**
- Range: "$5,000 - $25,000"
- Maximum: "Up to $15,000"
- Fixed: "$10,000"
- Variable: "Varies" (with note if available)

**Due date formatting:**
- Specific: "Due: March 15, 2026"
- Rolling: "Rolling deadline"
- Urgent: "⚠️ Due: Feb 15, 2026 (14 days)"
- Expired: "❌ Closed: Jan 1, 2026"
- TBD: "Due: TBD — check website"

### Probability Scoring System

Every grant gets a **match score from 0-100%** based on:

| Factor | Weight | Description |
|--------|--------|-------------|
| **Eligibility fit** | 40% | Does org meet hard requirements? (501c3, geography, Catholic, etc.) |
| **Need alignment** | 30% | Does org have a documented need matching grant purpose? |
| **Capacity signals** | 15% | Size, staffing, past success indicators |
| **Timing** | 10% | Deadline feasibility, project readiness |
| **Completeness** | 5% | Do we have enough info to assess? |

**Score interpretation:**
| Score | Label | Meaning |
|-------|-------|---------|
| 85-100% | 🟢 Excellent Match | Strong fit, worth prioritizing |
| 70-84% | 🟡 Good Match | Likely eligible, worth exploring |
| 50-69% | 🟠 Possible Match | Some fit, verify requirements |
| 25-49% | 🔴 Weak Match | Unlikely but not impossible |
| 0-24% | ⚫ Not Eligible | Hard disqualifier or poor fit |

**Sorting options:**
- By score (default) — highest probability first
- By deadline — most urgent first
- By amount — largest grants first
- By category — grouped by grant type

---

## 5. Business Rules and Logic

### Questionnaire Generation Rules
1. AI reads ALL grants in database before generating questions
2. Questions should cover eligibility requirements that appear in 2+ grants
3. Group questions by topic (Organization, Location, School, Facilities, Programs)
4. Cap at ~20 questions max (prioritize most impactful)
5. Use conditional logic: if "No school" → skip school questions

### Document Processing Rules
1. Extract text from PDFs and Word docs
2. Identify grant-relevant signals: needs, projects, concerns, plans, timelines
3. Note the source document for each extracted item
4. Ignore clearly irrelevant content (mass times, prayer intentions, etc.)
5. Flag potentially sensitive content (don't include in profile without review)

### Matching Rules
1. **Hard disqualifiers first** — If grant requires Texas and org is in Ohio, mark "Not Eligible"
2. **Deadline awareness** — If deadline passed, move to "Expired." If <30 days, flag "Urgent"
3. **Source attribution** — Every match explanation should reference WHERE the need was identified
4. **Conservative on eligibility** — If uncertain, say "Verify this requirement" rather than assuming

### Edge Cases
| Scenario | Behavior |
|----------|----------|
| No documents uploaded | Proceed with questionnaire + free-form only |
| No free-form text entered | Proceed with questionnaire + documents only |
| Grant database empty | Prompt to upload or load default |
| API key invalid | Show clear error, don't proceed |
| Document too large (>50 pages) | Warn user, process first 50 pages |
| Document parsing fails | Skip file, notify user, continue with others |
| No matches found | Explain why (eligibility gaps) and suggest what would unlock more matches |

---

## 6. Data Requirements

### Data Storage

**Cloud Mode (Primary):**
```
PostgreSQL Database
├── users (id, google_id, email, name, avatar_url, api_key_encrypted, created_at)
├── organizations (id, user_id, name, profile_json, created_at)
├── grant_databases (id, user_id, name, grants_json, uploaded_at)
├── matching_sessions (id, org_id, inputs_json, results_json, created_at)
└── documents (id, org_id, filename, extracted_text, uploaded_at)
```

**Note:** No passwords stored. Authentication handled entirely by Google OAuth.

**Local Mode (Optional):**
```
/data
├── config.json         # API key (encrypted), settings
├── grants.json         # Grant database
├── organization.json   # Parish profile
├── documents/          # Uploaded files
└── sessions/           # Match history (optional)
```

### Grant Record Schema
```json
{
  "id": "uuid",
  "name": "Koch Foundation Grant",
  "authority": "Koch Foundation",
  "deadline": "2026-05-01",
  "deadline_type": "annual",
  "amount_min": 1500,
  "amount_max": 100000,
  "description": "Supports evangelization, catechesis, Catholic schools...",
  "eligibility": {
    "requires_501c3": true,
    "requires_catholic_directory": true,
    "geographic_restriction": null,
    "school_required": false,
    "other": ["Must be recognized by Catholic hierarchy of Rome"]
  },
  "funds_for": ["evangelization", "catechesis", "catholic_schools", "media", "capital_us_only"],
  "apply_url": "https://thekochfoundation.org",
  "notes": "Max 3 grants per org in 5-year period",
  "source": "GrantFinder v3.0 spreadsheet"
}
```

### Organization Profile Schema
```json
{
  "id": "uuid",
  "name": "St. Theresa Catholic Church & School",
  "websites": {
    "church": "https://sttheresa.org",
    "school": "https://sttheresaschool.org"
  },
  "website_extracted": {
    "founded_year": 1978,
    "mission_statement": "...",
    "staff": ["Fr. John Smith, Pastor", "Jane Doe, Principal"],
    "ministries": ["Youth Ministry", "RCIA", "Knights of Columbus", ...],
    "programs": ["STEM Lab", "After School Care", ...],
    "recent_news": ["Playground fundraiser announced", ...]
  },
  "questionnaire_answers": {
    "is_501c3": true,
    "in_catholic_directory": true,
    "state": "Texas",
    "diocese": "Diocese of Austin",
    "has_school": true,
    "school_grades": "PreK-8",
    "student_count": 250,
    "parish_families": 1200,
    "building_age_years": 45,
    "location_type": "urban"
  },
  "free_form_notes": "We're hoping to renovate the gym next year...",
  "extracted_needs": [
    {
      "need": "Playground equipment replacement",
      "source": "bulletin_2026-03-15.pdf",
      "source_type": "document",
      "quote": "playground equipment is 30 years old and showing its age",
      "confidence": "high"
    },
    {
      "need": "STEM program expansion",
      "source": "https://sttheresaschool.org/academics",
      "source_type": "website",
      "quote": "Looking to expand our STEM lab in 2026",
      "confidence": "medium"
    }
  ],
  "created_at": "2026-02-01",
  "updated_at": "2026-02-01"
}
```

---

## 7. Integrations & Dependencies

### Required

| Dependency | Purpose | Notes |
|------------|---------|-------|
| **Claude API** | AI processing (questionnaire gen, doc extraction, matching) | User provides API key |
| **Python 3.10+ / FastAPI** | Backend | Handles API, document processing |
| **Next.js or SvelteKit** | Frontend | Modern, deployable to Vercel |
| **PostgreSQL** | Cloud database | Supabase or Railway |
| **pypdf / python-docx** | Document parsing | Extract text from uploads |

### Hosting

| Component | Recommended | Alternative |
|-----------|-------------|-------------|
| Frontend | Vercel | Netlify, Cloudflare Pages |
| Backend | Railway | Render, Fly.io |
| Database | Supabase Postgres | Railway Postgres, PlanetScale |
| File Storage | Supabase Storage | S3, Cloudflare R2 |

### Optional / Future

| Dependency | Purpose | Phase |
|------------|---------|-------|
| **Google OAuth** | User authentication | v1.0 (required) |
| Stripe | Paid tiers (if needed) | v2.0 |
| SendGrid / Resend | Email notifications | v2.0 |

---

## 8. Out of Scope (v1.0)

### Explicitly NOT Building in v1.0
1. **Application drafting** — We recommend grants, we don't write applications (v2.0)
2. **Automated submission** — No clicking "submit" for the user (v3.0)
3. **Grant database auto-updates** — User uploads; no scraping external sources
4. **Calendar integration** — No syncing deadlines to Google Calendar
5. **Email reminders** — No automated notifications
6. **Multi-organization dashboard** — One org per account for now
7. **Mobile app** — Web responsive only
8. **Real-time collaboration** — Single user per session
9. **Payment / premium tiers** — Free for v1.0

### Roadmap: Future Versions

#### v1.5 — Teacher Edition (Classroom Grants)
A lighter version for individual teachers to find and apply to classroom grants.

| Feature | Description |
|---------|-------------|
| Simplified onboarding | Teacher enters school, grade, subject — no org setup |
| Classroom focus | Pre-loaded grant database: DonorsChoose, AdoptAClassroom, supply grants |
| Project-based | "I need _____ for my classroom" → matches |
| Lower stakes | Smaller grants, simpler applications |
| Quick wins | Surface grants teacher can apply to in one session |

**Target grants:**
- DonorsChoose projects
- AdoptAClassroom
- Walmart Community Grants (teacher-initiated)
- Office Depot/Staples teacher grants
- State teacher innovation grants
- Subject-specific grants (STEM, literacy, arts)

**Why separate product?**
- Different user (teacher vs. administrator)
- Different grant pool (classroom vs. institutional)
- Simpler context needed (no parish profile, just classroom)
- Faster time-to-value

#### v2.0 — AI Application Drafting
| Feature | Description |
|---------|-------------|
| Application reader | AI reads grant application forms/requirements |
| Answer generation | AI drafts answers based on parish profile |
| Human review UI | Side-by-side view: AI draft ↔ editable field |
| Answer memory | Save approved answers for reuse across applications |
| Document assembly | Generate supporting docs (budgets, narratives) |

**User flow:**
1. User selects a matched grant → "Start Application"
2. AI fetches application form (or user uploads PDF)
3. AI generates draft answers for each question
4. User reviews, edits, approves each answer
5. User downloads completed application OR...

#### v3.0 — Autonomous Application Agent
| Feature | Description |
|---------|-------------|
| Form automation | AI fills web forms directly (browser automation) |
| Submission queue | Queue applications for human approval |
| Approval gate | Human reviews full application before submit |
| One-click approve | "Looks good — Submit" button |
| Submission tracking | Track what was submitted, when, status |
| Follow-up handling | AI responds to grantor questions/requests |

**User flow:**
1. AI identifies matching grant with open application
2. AI prepares complete application
3. User receives notification: "Application ready for review"
4. User opens review screen, sees all answers
5. User approves or edits
6. User clicks "Submit" → AI submits via web form
7. AI monitors email for confirmation/follow-up

**Safety rails for v3.0:**
- **Never auto-submit** — Human must explicitly approve
- **Audit trail** — Full log of what was submitted
- **Undo window** — Some applications allow withdrawal
- **Confidence scoring** — AI flags low-confidence answers for extra review
- **Dollar threshold** — Extra confirmation for grants over $X

### Parking Lot (Even Further Future)
- Deadline reminder emails
- Diocese-wide deployment (multiple parishes, one admin)
- Integration with Catholic Funding Guide API
- Chrome extension to clip grants while browsing
- Grant writing consultant marketplace
- Success rate analytics

---

## 9. Open Design Questions

| # | Question | Options | Decision |
|---|----------|---------|----------|
| 1 | **Auth required?** | Anonymous sessions vs. accounts | **Google OAuth only** — no username/password storage |
| 2 | **Pre-loaded grant database?** | Ship with default Catholic grants vs. blank | **Start blank** — user uploads their own grant database |
| 3 | **Document size limits?** | Per-file and total limits | 50 pages per doc, 20 docs max, 500 pages total |
| 4 | **How to handle sensitive content in docs?** | Auto-redact? Warn user? Local-only mode? | Warn user; they control what they upload |
| 5 | **Can user edit Parish Profile after generation?** | Full edit vs. regenerate only | Allow inline edits before matching |
| 6 | **Session persistence?** | Save match history vs. ephemeral | Save last session; export for long-term |
| 7 | **Questionnaire: static or dynamic?** | Same questions always vs. conditional | Dynamic (skip irrelevant questions) |
| 8 | **Token/cost management?** | Show estimated cost? Cap usage? | Show estimate before processing; warn if high |

### Technical Questions to Resolve During Build
- Optimal prompt structure for document extraction vs. matching (may need separate prompts)
- How to chunk large documents for Claude's context window
- Whether to use Claude's tool use or pure prompt-based approach

---

## 10. Success Criteria

### Definition of Done (v1.0 MVP)

**Setup:**
- [ ] User can access app via public URL
- [ ] User can enter Claude API key in web UI
- [ ] User can upload grant database (Excel) or use pre-loaded default

**Context Gathering:**
- [ ] AI generates questionnaire based on grant database
- [ ] User can answer questionnaire
- [ ] User can enter free-form text
- [ ] User can upload documents (PDF, DOCX, TXT)
- [ ] AI extracts relevant information from documents

**Matching:**
- [ ] AI generates Parish Profile for user review
- [ ] User can edit/correct Parish Profile before matching
- [ ] AI matches profile against grants and ranks by fit
- [ ] Each match includes explanation with source attribution

**Output:**
- [ ] User can view results on screen
- [ ] User can export to PDF or Markdown
- [ ] User can shortlist grants for follow-up

**Technical:**
- [ ] Works on desktop and mobile browsers
- [ ] Handles errors gracefully (bad API key, failed upload, etc.)
- [ ] README with setup instructions for self-hosting
- [ ] Deployable to Vercel + Railway with one-click (or near it)
- [ ] Code ready for GitHub public release

### Quantitative Success Metrics

| Metric | Target |
|--------|--------|
| Time from first visit to first match results | < 15 minutes |
| Match relevance (user agrees top 3 are worth exploring) | 80%+ |
| API cost per full matching session | < $2.00 |
| Document processing success rate | 95%+ |

### Qualitative Success
- User says: "It found a grant I didn't know we qualified for"
- User says: "It caught something in our bulletin I forgot about"
- User shares the tool with another parish
- User actually applies to a recommended grant

---

## 11. Sample AI Prompts (Draft)

### Prompt 0: Website Scanning
```
You are analyzing a Catholic parish/school website to extract information 
relevant to grant applications.

Website content from {url}:
{page_content}

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

Return as structured JSON.
```

### Prompt 1: Questionnaire Generation
```
You are helping generate a questionnaire for Catholic parishes and schools 
to determine their eligibility for grants.

Here are all the grants in our database:
{grants_json}

Based on the eligibility requirements and funding purposes of these grants, 
generate a questionnaire that will help us match organizations to the right grants.

Rules:
- Only ask questions that are relevant to 2+ grants
- Group questions by topic (Organization, Location, School, Facilities, Programs, Needs)
- Use simple language (avoid grant jargon)
- Include question type: multiple_choice, yes_no, text, number
- Cap at 20 questions max
- For each question, note which grants it helps filter

Return as JSON array of question objects.
```

### Prompt 2: Document Extraction
```
You are analyzing documents from a Catholic parish/school to identify 
information relevant to grant applications.

Document: {document_text}
Document type: {document_type} (e.g., "weekly bulletin", "meeting minutes")

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

Return as JSON array.
```

### Prompt 3: Grant Matching
```
You are a grant matching expert for Catholic parishes and schools.

ORGANIZATION PROFILE:
{organization_profile_json}

AVAILABLE GRANTS:
{grants_json}

TASK:
Match this organization to the most relevant grants. For each potential match:

1. Determine eligibility (is org eligible based on hard requirements?)
2. Assess fit (does what they need match what grant funds?)
3. Rate match quality: High, Medium, Low, or Not Eligible
4. Explain WHY it's a good fit — reference specific details from their profile
5. Note any eligibility questions they should verify
6. Flag deadline urgency

Return top 10 matches as JSON, ranked by fit quality.
Include "not_eligible" array for grants they definitely don't qualify for (with reason).
```

---

## 12. UI Wireframes (Text Description)

### Screen 1: Login & Setup
```
+----------------------------------------------------------+
|  GrantFinder AI                                          |
+----------------------------------------------------------+
|                                                          |
|  Match your parish to the right grants — powered by AI   |
|                                                          |
|  +----------------------------------------------------+  |
|  |          [ Sign in with Google ]                   |  |
|  +----------------------------------------------------+  |
|                                                          |
|  Free and open source. Your data stays yours.            |
|                                                          |
+----------------------------------------------------------+

(After Google sign-in)

+----------------------------------------------------------+
|  GrantFinder AI                    Welcome, Chris! [⚙️]  |
+----------------------------------------------------------+
|                                                          |
|  Let's get you set up.                                   |
|                                                          |
|  Step 1: Enter your Claude API Key                       |
|  +----------------------------------------------------+  |
|  | sk-ant-api03-...                                   |  |
|  +----------------------------------------------------+  |
|  Your key is stored securely and never shared.           |
|  [Get an API key from Anthropic →]                       |
|                                                          |
|  Step 2: Upload Your Grant Database                      |
|  Upload an Excel file with grant opportunities.          |
|  +----------------------------------------------------+  |
|  |  [Choose File]  or drag and drop .xlsx             |  |
|  +----------------------------------------------------+  |
|  Need a template? [Download sample format]               |
|                                                          |
|  +----------------------------------------------------+  |
|  |              [ Continue → ]                        |  |
|  +----------------------------------------------------+  |
|                                                          |
+----------------------------------------------------------+
```

### Screen 2: Context Gathering
```
+----------------------------------------------------------+
|  GrantFinder AI                          [Settings]       |
+----------------------------------------------------------+
|                                                          |
|  Tell us about your parish                               |
|                                                          |
|  ┌─ QUESTIONNAIRE ─────────────────────────────────────┐ |
|  │ Based on our grant database, we need to know:       │ |
|  │                                                     │ |
|  │ 1. Are you a registered 501(c)(3)?  ○ Yes  ○ No    │ |
|  │ 2. Are you in the Official Catholic Directory?      │ |
|  │    ○ Yes  ○ No  ○ Not sure                         │ |
|  │ 3. What state? [Texas ▼]                           │ |
|  │ 4. Do you have a school? ○ Yes  ○ No               │ |
|  │    → What grades? [PreK-8 ▼]                       │ |
|  │ ...                                                 │ |
|  └─────────────────────────────────────────────────────┘ |
|                                                          |
|  ┌─ TELL US MORE (optional) ───────────────────────────┐ |
|  │ What's happening at your parish? Any projects,      │ |
|  │ needs, or plans you're thinking about?              │ |
|  │ ┌─────────────────────────────────────────────────┐ │ |
|  │ │ We're hoping to renovate the gym next year.     │ │ |
|  │ │ The AC in the school has been failing...        │ │ |
|  │ └─────────────────────────────────────────────────┘ │ |
|  └─────────────────────────────────────────────────────┘ |
|                                                          |
|  ┌─ UPLOAD DOCUMENTS (optional) ───────────────────────┐ |
|  │ Bulletins, meeting minutes, newsletters, etc.       │ |
|  │                                                     │ |
|  │  📄 bulletin_2026-03-15.pdf              [Remove]  │ |
|  │  📄 finance_council_jan2026.docx         [Remove]  │ |
|  │  📄 school_newsletter_feb.pdf            [Remove]  │ |
|  │                                                     │ |
|  │  [+ Add More Documents]                             │ |
|  └─────────────────────────────────────────────────────┘ |
|                                                          |
|  +----------------------------------------------------+  |
|  |           [ Process & Review Profile → ]           |  |
|  +----------------------------------------------------+  |
|                                                          |
+----------------------------------------------------------+
```

### Screen 3: Profile Review
```
+----------------------------------------------------------+
|  GrantFinder AI                            [← Back]       |
+----------------------------------------------------------+
|                                                          |
|  Here's what we learned about your parish                |
|  Review and edit before we find matching grants.         |
|                                                          |
|  ┌─ ORGANIZATION FACTS ────────────────────────────────┐ |
|  │ ✓ 501(c)(3) Catholic parish with K-8 school        │ |
|  │ ✓ Diocese of Austin, Texas                         │ |
|  │ ✓ Listed in Official Catholic Directory            │ |
|  │ ✓ 250 students, ~1,200 families                    │ |
|  │ ✓ Campus is 45 years old                           │ |
|  │                                           [Edit]    │ |
|  └─────────────────────────────────────────────────────┘ |
|                                                          |
|  ┌─ NEEDS & PROJECTS IDENTIFIED ───────────────────────┐ |
|  │                                                     │ |
|  │ From your documents:                                │ |
|  │ • Playground equipment replacement         [Remove] │ |
|  │   "equipment is 30 years old and showing its age"   │ |
|  │   — bulletin_2026-03-15.pdf                        │ |
|  │                                                     │ |
|  │ • Security camera system                   [Remove] │ |
|  │   "discussed security concerns after break-in"      │ |
|  │   — finance_council_jan2026.docx                   │ |
|  │                                                     │ |
|  │ From your notes:                                    │ |
|  │ • HVAC/AC system failing                   [Remove] │ |
|  │ • Gym renovation interest                  [Remove] │ |
|  │                                                     │ |
|  │ [+ Add Another Need]                                │ |
|  └─────────────────────────────────────────────────────┘ |
|                                                          |
|  +----------------------------------------------------+  |
|  |              [ Find Matching Grants → ]            |  |
|  +----------------------------------------------------+  |
|                                                          |
+----------------------------------------------------------+
```

### Screen 4: Match Results
```
+----------------------------------------------------------+
|  GrantFinder AI                            [← Back]       |
+----------------------------------------------------------+
|                                                          |
|  Grant Matches for St. Theresa                           |
|  Scored 52 grants • 12 matches above 50%                 |
|                                                          |
|  Sort by: [Score ▼] [Deadline] [Amount] [Category]       |
|                                                          |
|  [Export PDF]  [Export CSV]  [Start Over]                |
|                                                          |
|  ━━━ 🟢 EXCELLENT MATCHES (85-100%) ━━━━━━━━━━━━━━━━━━━  |
|                                                          |
|  ┌─────────────────────────────────────────────────────┐ |
|  │ 92% KaBOOM! Build It Yourself Grant                 │ |
|  │     Up to $15,000  |  Deadline: Rolling             │ |
|  │                                                     │ |
|  │ WHY THIS SCORE:                                     │ |
|  │ ✓ Eligibility: 501(c)(3) faith-based ✓             │ |
|  │ ✓ Need match: Bulletin says "playground equipment   │ |
|  │   is 30 years old" — direct fit                     │ |
|  │ ✓ Capacity: Active family ministry = volunteers     │ |
|  │ ? Verify: Can you get 50+ build day volunteers?     │ |
|  │                                                     │ |
|  │ [View Grant ↗]  [Add to Shortlist ☆]               │ |
|  └─────────────────────────────────────────────────────┘ |
|                                                          |
|  ┌─────────────────────────────────────────────────────┐ |
|  │ 88% FEMA Nonprofit Security Grant (NSGP)            │ |
|  │     Up to $200,000  |  ⚠️ Check TX deadline         │ |
|  │                                                     │ |
|  │ WHY THIS SCORE:                                     │ |
|  │ ✓ Eligibility: Faith-based 501(c)(3) ✓             │ |
|  │ ✓ Need match: Finance minutes mention "security     │ |
|  │   concerns after break-in"                          │ |
|  │ ✓ Amount: Large grant, high impact                  │ |
|  │ ? Verify: Requires threat assessment first          │ |
|  │                                                     │ |
|  │ [View Grant ↗]  [Add to Shortlist ☆]               │ |
|  └─────────────────────────────────────────────────────┘ |
|                                                          |
|  ━━━ 🟡 GOOD MATCHES (70-84%) ━━━━━━━━━━━━━━━━━━━━━━━━━  |
|                                                          |
|  ┌─────────────────────────────────────────────────────┐ |
|  │ 76% Koch Foundation                                 │ |
|  │     Up to $25,000  |  Deadline: May 1, 2026         │ |
|  │                                                     │ |
|  │ ✓ Catholic school ✓ | ✓ In Catholic Directory      │ |
|  │ ~ General eligibility, no specific need matched     │ |
|  │                                                     │ |
|  │ [View Grant ↗]  [Add to Shortlist ☆]               │ |
|  └─────────────────────────────────────────────────────┘ |
|                                                          |
|  ━━━ 🟠 POSSIBLE MATCHES (50-69%) ━━━━━━━━━━━━━━━━━━━━━  |
|  │ 58% Raskob Foundation — General Catholic ed         │ |
|  │ 52% E-Rate Program — Technology, verify eligibility │ |
|  ...                                                     |
|                                                          |
|  ━━━ ⚫ NOT ELIGIBLE (<25%) ━━━━━━━━━━━━━━━━━━━━━━━━━━━  |
|  │  0% Hilton Fund for Sisters — Requires women religious │
|  │  0% Big Shoulders (Chicago only) — Wrong state      │ |
|  │ 12% Conrad Hilton — Org type doesn't match          │ |
|  [Show 35 more not-eligible grants...]                   |
|                                                          |
+----------------------------------------------------------+
```

---

## 13. Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | Feb 1, 2026 | Claude + Chris | Initial spec |
| 2.0 | Feb 1, 2026 | Claude + Chris | Added: cloud deployment, three-input model, AI questionnaire, parish profile review |
| 2.1 | Feb 1, 2026 | Claude + Chris | Finalized: Google OAuth only, no pre-loaded grants, public repo, Patreon link |
| 2.2 | Feb 1, 2026 | Claude + Chris | Added: Website scanning (4 inputs), terminal UI, dark mode default, v2/v3 roadmap |
| 2.3 | Feb 1, 2026 | Claude + Chris | Added: Probability scoring system (0-100%), Teacher Edition roadmap (v1.5), refined v1.0 focus on discovery + scoring |
| 2.4 | Feb 1, 2026 | Claude + Chris | Added: Explicit requirement to display grant amount and due date prominently on all match cards |

---

## 14. Repository & Distribution

### GitHub Repository
- **Visibility:** Public
- **License:** MIT (or similar permissive license)
- **Repository name:** `grantfinder-ai` (suggested)

### README Requirements
- Clear setup instructions (local + cloud deploy)
- Screenshots/GIFs of the interface
- How to get a Claude API key
- How to format grant database Excel
- Link to Patreon for support: **patreon.com/christreadaway**
- Contributing guidelines
- License

---

## 15. Next Steps

1. **Review this spec** — Any final gaps or changes?
2. **Hand to Claude Code** — Build MVP
3. **Test with real parish documents** — Validate extraction quality
4. **Deploy to staging** — Test full flow
5. **Release to GitHub** — Public repo
6. **Share with test parishes** — Get real-world feedback

---

**Ready for Claude Code when you are.**
