# Claude Code Instructions - GrantFinder

## About This Project
Grant discovery and application tracking system. Helps find relevant grants, track application deadlines, and manage the grant application process.

## About Me (Chris Treadaway)
Product builder, not a coder. I bring requirements and vision — you handle implementation.

**Working with me:**
- Bias toward action - just do it, don't argue
- Make terminal commands dummy-proof (always start with `cd ~/grantfinder`)
- Minimize questions - make judgment calls and tell me what you chose
- I get interrupted frequently - always end sessions with a handoff note

## Tech Stack
[To be determined based on codebase]

## File Paths
- **Always use:** `~/grantfinder/path/to/file`
- **Never use:** `/Users/christreadaway/...`
- **Always start commands with:** `cd ~/grantfinder`

## PII Rules (CRITICAL)
❌ NEVER include:
- Real organization names → use [Organization Name]
- Grant amounts → use placeholder numbers
- Applicant names → use [Applicant Name]
- Email addresses → use contact@example.com
- File paths with /Users/christreadaway → use ~/

✅ ALWAYS use placeholders

## Key Features (Expected)
- Grant database/search
- Application deadline tracking
- Eligibility matching
- Application status management
- Document preparation helpers

## Session End Routine
```markdown
## Session Handoff - [Date]

### What We Built
- [Feature 1]: [files modified]

### Current Status
✅ Working: [tested features]
❌ Broken: [known issues]
🚧 In Progress: [incomplete]

### Files Changed
- [file]

### Current Branch
Branch: [branch-name]
Ready to merge: [Yes/No]

### Next Steps
1. [Priority 1]
2. [Priority 2]
```

## Git Branch Strategy
- Claude Code creates new branch per session
- Merge to main when stable
- Delete merged branches immediately

## Current Status
Active project - has product spec v2.6 (Feb 2, 2026).

---
Last Updated: February 16, 2026
