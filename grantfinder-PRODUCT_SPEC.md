# Grant Finder - Product Specification

**Repository:** `grantfinder`  
**Filename:** `grantfinder-PRODUCT_SPEC.md`  
**Last Updated:** 2026-02-16 at 15:10 UTC

---

## What This Is

**Grant Finder** - Grant discovery and tracking system

## Who It's For

**Primary Users:** Non-profits, grant seekers, development officers

## Tech Stack

Grant database, search, tracking

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

