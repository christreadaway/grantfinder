# GrantFinder — CLAUDE.md

> **Repository:** `github.com/christreadaway/grantfinder`
> **Category:** Church
> **Stack:** Firebase, Google Auth, HTML/JS
> **Localhost Port:** 3007

## What This Project Is
Grant discovery and application tracking tool

## Session Start Protocol
Before starting ANY work:

1. Run `git fetch origin` to get latest remote state
2. If creating a new branch, ALWAYS branch from latest `origin/main`:
   ```
   git fetch origin
   git checkout -b <branch-name> origin/main
   ```
3. If PROJECT_STATUS.md or SESSION_NOTES.md are missing on the current branch, recover them:
   ```
   git checkout origin/main -- PROJECT_STATUS.md SESSION_NOTES.md 2>/dev/null || true
   ```
4. Read CLAUDE.md (this file) fully before starting work
5. Read SESSION_NOTES.md if it exists — check for prior session context, blockers, and next steps
6. Confirm the current branch and its relationship to main before making changes

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

## Project-Specific Notes
- Grant opportunity discovery
- Application tracking and management
- Google authentication, Firebase backend

## Security Requirements
- Proactively self-evaluate for SQL injection, XSS, CSRF, auth bypasses, and other common vulnerabilities
- Flag security issues before completing builds — do not wait to be asked
- NEVER expose API keys, tokens, or credentials in code or committed files
- Use .env files with .gitignore for local secrets
- Use secrets managers or environment variables for production

## PII Rules
- No real institution names, people, addresses, phones, or emails in code — use [Parish Name], [Staff Name], etc.
- No local file paths in committed code — use ~/ or environment variables
- No API keys, tokens, or credentials in any committed files
- These rules apply to ALL code, artifacts, files, or snippets generated

## User Context
- Chris is a product builder, NOT a developer — provide detailed, dummy-proof instructions
- When giving terminal commands, ALWAYS start with `cd` to the correct directory
- Default to Windows paths (C:\Users\chris-treadaway\) — Chris works primarily on Windows
- Minimize questions — make reasonable judgment calls and explain what you chose
- Auth preference: Google Sign-In via Firebase (never username/password)

