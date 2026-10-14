# GrantFinder AI — Business Product Spec
**Version:** 2.6 | **Date:** 2026-02-16 | **Repo:** github.com/christreadaway/grantfinder

---

## 1. Problem Statement
Catholic schools and parishes leave millions in grant funding on the table because they lack the staff, expertise, and time to research which grants they qualify for. Grant databases are overwhelming — thousands of opportunities with different eligibility criteria, deadlines, and application requirements. A typical parish secretary or school principal doesn't know where to start, and hiring a grant writer is prohibitively expensive for a K-8 school with a $2M annual budget.

## 2. Solution
An AI-powered grant matching platform that builds a comprehensive profile of a Catholic school or parish by scanning its website, asking targeted questions, and analyzing uploaded documents. It then matches the organization's profile against a categorized grant database and scores each opportunity on a 0-100% probability scale, showing exactly why each grant is or isn't a good fit.

## 3. Target Users
- **Catholic School Principals** — Finding funding for technology, facilities, programs
- **Parish Business Managers** — Grant opportunities for church operations, outreach, capital campaigns
- **Diocesan Development Officers** — Matching grants across multiple schools/parishes in their diocese
- **Grant Writers** — Using the tool to quickly identify best-fit opportunities for their clients

## 4. Core Features

### Organization Profile Building (4 Input Sources)
1. **Website Scanning** — Async crawler extracts org info, programs, demographics from the school/parish website
2. **AI Questionnaire** — Claude generates targeted questions based on grant categories; dynamic follow-ups based on answers
3. **Free-Form Notes** — Open text area for additional context, unique programs, special circumstances
4. **Document Upload** — PDF, DOCX, TXT extraction for annual reports, budgets, accreditation documents

### Grant Database (5 Categories)
1. **Church/Parish** — Religious organization-specific grants
2. **Catholic School** — Education grants for Catholic institutions
3. **Mixed** — Grants available to either churches or schools
4. **Non-Catholic Qualifying** — Secular grants Catholic orgs can apply for
5. **Catholic Foundations** — Grants from Catholic philanthropic organizations

### Grant Data Structure
- **Required Fields:** Grant Name, Deadline, Amount, Funder, Description, Contact, URL, Status, Geo Qualified
- **Optional:** Funder Stats (historical giving data)
- **Upload:** Excel/CSV with flexible column mapping

### AI Matching Engine
- **Probability Scoring (0-100%)** with weighted factors:
  - Eligibility (40%) — Does the org meet basic requirements?
  - Need Alignment (30%) — Does the grant's purpose match the org's needs?
  - Capacity (15%) — Can the org handle the application and reporting?
  - Timing (10%) — Is the deadline realistic?
  - Completeness (5%) — How much profile data is available for matching?

### Terminal-Style Processing UI
- Real-time processing status with SSE streaming
- Stage-by-stage progress updates
- Professional dark mode aesthetic

### Export Options
- **Markdown** — Formatted report with match details
- **CSV** — Spreadsheet-ready data
- **JSON** — Machine-readable format for integrations

## 5. Tech Stack
- **Engine:** TypeScript API routes inside the Next.js app (`frontend/src/server`) plus a Netlify background function for long AI work (the original Python FastAPI engine in `backend/` is reference only)
- **Frontend:** Next.js 16 with TypeScript
- **Hosting & storage:** Netlify (website, API, background jobs) and Netlify Blobs (data)
- **AI:** Claude API (Anthropic) for questionnaire generation, document extraction, profile generation, and grant matching
- **Auth:** Google OAuth (or temporary guest sign-in) with signed session tokens
- **Security:** AES-256-GCM encryption for API keys
- **Document Processing:** PDF (unpdf), DOCX (mammoth), TXT
- **Excel Parsing:** 5-category parser with flexible column mapping
- **State:** Zustand (frontend)

## 6. Data & Privacy
- API keys encrypted with AES-256-GCM (key derived from the site's SECRET_KEY)
- Organization profiles stored server-side with user auth
- Grant databases are non-sensitive public/semi-public information
- Document uploads processed and text extracted — the files themselves are not stored
- Google OAuth — no password storage

## 7. Current Status
- **Built:** Complete engine in TypeScript (ported from the original FastAPI backend) with all routes and services
- **Built:** Complete frontend (Next.js) with setup wizard, profile builder, matching results, and the GrantWriter
- **Built:** AI service integration with Claude API (background jobs, cost and token logging)
- **Built:** 5-category Excel parser, starter database, Grants.gov search, AI web discovery
- **Tested:** 406 automated engine checks with a mock Claude, a browser test of the whole journey, and a local run on the Netlify runtime
- **Deploy:** Netlify only (`docs/deployment.md`); a live-key run with real data is the next milestone

## 8. Business Model
- **Free Tier:** Manual grant database, basic profile, limited matches
- **Premium:** AI-powered matching, automated website scanning, document analysis, unlimited matches
- **Diocese License:** Bulk access for all schools in a diocese (paired with catholicevents parish data)

## 9. Success Metrics
- Grants successfully applied for after platform recommendation
- Grant funding secured by platform users
- Time saved vs. manual grant research (target: 80% reduction)
- Profile completeness score across users
- Match accuracy (grants recommended that users actually qualify for)

## 10. Open Questions / Next Steps
- Integration with catholicevents data for automatic org profile enrichment
- Grant deadline notification system
- Application tracking (applied, pending, awarded, rejected)
- Grant writer marketplace (connect schools with grant writers)
- Historical success rate tracking per grant funder
- Diocesan rollout strategy
