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
Before ending EVERY session, Claude will automatically create/update SESSION_NOTES.md:

```markdown
## [Date] [Time] - [Brief Description]

### What We Built
- [Feature 1]: [files modified]
- [Feature 2]: [what was implemented]

### Technical Details
Files changed:
- path/to/file.ext (what changed)
- path/to/file2.ext (what changed)

Code patterns used:
- [Pattern or approach used]
- [Libraries or techniques applied]

### Current Status
✅ Working: [what's tested and works]
❌ Broken: [known issues]
🚧 In Progress: [incomplete features]

### Branch Info
Branch: [branch-name]
Commits: [X files changed, Y insertions, Z deletions]
Ready to merge: [Yes/No - why or why not]

### Decisions Made
- [Decision 1 and rationale]
- [Decision 2 and rationale]

### Next Steps
1. [Priority 1 with specific action]
2. [Priority 2 with specific action]
3. [Priority 3 with specific action]

### Questions/Blockers
- [Open question or blocker]
- [Uncertainty that needs resolution]
```

**To execute:** Say "Append session notes to SESSION_NOTES.md" and Claude will:
1. Create/update SESSION_NOTES.md in repo root
2. Add new session at the TOP (most recent first)
3. Commit the file to current branch
4. Confirm completion

SESSION_NOTES.md is committed to the repo and tracks all session progress over time.

## Git Branch Strategy
- Claude Code creates new branch per session
- Merge to main when stable
- Delete merged branches immediately

## Current Status
Active project - has product spec v2.6 (Feb 2, 2026).

---
Last Updated: February 16, 2026
