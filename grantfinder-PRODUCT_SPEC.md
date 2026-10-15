# Grant Finder - Product Specification

**Repository:** `grantfinder`  
**Filename:** `grantfinder-PRODUCT_SPEC.md`  
**Last Updated:** 2026-10-15

---

## What This Is

**Grant Finder** - Grant discovery and tracking system

## Who It's For

**Primary Users:** Non-profits, grant seekers, development officers

## Tech Stack

Grant database, search, tracking. One Next.js 16 + TypeScript app deployed entirely on Netlify, on
any Netlify plan: website, engine API at `/api/*` (`frontend/src/server`, which also runs each AI
step inside a normal request; an optional background function gives each step up to 15 minutes on
plans that include them), and Netlify Blobs storage. The `backend/` items in the history below describe the original Python
engine, which is now reference only. Current architecture: `docs/engine.md`.

---

## Core Features

The following features have been implemented based on development sessions:

1. - Created backend/state.py - New shared state module to eliminate circular imports between profile.py and processing.py
2. - backend/routers/__init__.py - Added proper router exports
3. - backend/routers/auth.py - Added Fernet encryption for API key storage instead of plain text
4. - backend/routers/auth.py - Added sliding-window rate limiting (100 requests per 60 seconds per IP)
5. - backend/services/ai_service.py - Added SSRF protection with IP range blocking (private ranges, localhost, etc.) and switched to AsyncAnthropic client
6. Built Next.js frontend successfully without errors
7. Created AI service module for Claude API integrations
8. Created FastAPI backend API structure with authentication, user, organization, grant, document, and matching endpoints
9. Created FastAPI backend main.py entry point and updated project progress tracking
10. Created FileUpload and Questionnaire form components
11. Created backend and frontend directory structure
12. Created five Pydantic schema modules for backend models
13. Created grant template format documentation and updated project progress tracking
14. Fixed API key encryption and JWT secret vulnerabilities, added SSRF protection, updated profile router imports
15. I've built out the complete GrantFinder AI application based on your specifications. Here's what was created:
16. I've reviewed the v2.6 spec and built a complete MVP implementation. Here's what was created:
17. Marked security fixes completed and created state management module
18. Successfully built Next.js frontend production application
19. [Checked git status and found recently created markdown file]
20. âœ“ Built complete MVP - FastAPI backend with auth, grants, processing, profile, and export routers; Next.js frontend with dark mode, setup wizard, and terminal UI
21. Grant discovery: curated starter database, live Grants.gov search, and AI web discovery, merged with deduplication (`docs/grant-discovery.md`)
22. GrantWriter (v2.0 application writer): requirements, fit/gap analysis, stakeholder intake, voice-conditioned drafting, rubric self-scoring, refinement, and Word/Markdown/portal exports with human approval gates (`docs/grant-writer.md`)
23. Recurring "Annual: October 15" deadlines and the Kenedy Memorial Foundation record in the starter database
24. October 2026: moved everything onto Netlify. The engine was ported to TypeScript (`frontend/src/server`), AI steps run as background jobs, data and sign-ins persist in Netlify Blobs, and the dashboard resumes saved work (`docs/engine.md`, `docs/deployment.md`)
25. October 2026: GrantWriter hand edits with earlier versions and "Restore this version", live limit and banned-phrase checks at export, `[NEEDS INPUT]` placeholders listed per section, and "Draft missing sections" after a partial run (`docs/grant-writer.md`). Questionnaire answers are kept across new question sets, documents add key facts the writer drafts from, and sign-ins survive network blips (`docs/grant-discovery.md`, `docs/deployment.md`)
26. October 2026: runs on any Netlify plan, including legacy Starter. Each AI step runs inside a normal request (about a minute); long steps continue in parts on their own (drafting a few sections per part, matching the grants that didn't fit). The 15-minute background function is optional (`GRANTFINDER_BACKGROUND_JOBS=true`, only for plans that include background functions), and `/api/health` shows which way AI steps run (`docs/engine.md`, `docs/deployment.md`)
27. October 2026: Results page **Top picks** (up to 5 strong matches with open deadlines, soonest first), a days-left badge on every match, "Deadline soonest" sort and "Hide not eligible"; the deadline fields are worked out each time results are read (`docs/grant-discovery.md`). GrantWriter step **1b · Funder History**: paste notes, add up to 6 files, or let Claude research the web, and get a funder profile (typical award, comparable grants they made, a suggested ask, what they don't fund) that the fit analysis, drafting and scoring use. An **Application Checklist** at the top of the writer (due date and days left, next step, section status, attachments and requirements to tick off, open gaps, approvals), grant guidelines added as a file, and an **Add Materials** card for adding a document from the writer (`docs/grant-writer.md`)

---

## Technical Implementation

Key technical details from implementation:

- Created backend and frontend directory structure
- Now let me create the backend FastAPI application.
- Created five Pydantic schema modules for backend models
- Created FastAPI backend API structure with authentication, user, organization, grant, document, and matching endpoints
- Created FastAPI backend main.py entry point and updated project progress tracking
- Now let me create the Next.js frontend. I'll set up the full frontend application.
- Set up Next.js frontend with global styles, layout, providers, types, API client, state management, and authentication hooks
- - backend/main.py - FastAPI application entry point
- - backend/app/core/ - Configuration, security, and database setup
- - backend/app/models/ - SQLAlchemy models for Users, Organizations, Grants, Documents, and Matching Sessions
- - backend/app/schemas/ - Pydantic schemas for API validation
- - backend/app/api/routes/ - REST API endpoints
- Claude: No, I haven't tested it yet. Let me run both the backend and frontend to check for bugs.
- Installed backend Python dependencies and frontend npm packages
- I found a dependency conflict in the backend. Let me fix that.
- Let me start by creating the project structure with both frontend and backend.
- Initialized Next.js frontend project with TypeScript and Tailwind CSS
- Set up Python virtual environment and installed backend dependencies
- Now let me create the backend application structure.
- Now let me set up the Next.js frontend with dark mode and core components. First, let me check the current frontend structure.

---

## Architecture & Design Decisions

Design decisions to be documented as they are made.


---

## Development History

Full session-by-session development history is maintained in `SESSION_NOTES.md`.

This specification is automatically updated alongside session notes to reflect:
- New features implemented
- Technical decisions made
- Architecture changes
- Integration updates

---

## Updating This Spec

At the end of each Claude Code session, this spec is updated automatically when you say:
> "Append session notes to SESSION_NOTES.md"

Claude will:
1. Update `SESSION_NOTES.md` with detailed session history
2. Update `grantfinder-PRODUCT_SPEC.md` with new features/decisions
3. Commit both files together

**Never manually edit this file** - it's maintained automatically from session notes.

