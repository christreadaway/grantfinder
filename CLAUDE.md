# Claude Code Instructions - GrantFinder

## About This Project
Grant discovery and tracking tool for Catholic schools. Helps identify, track, and apply for grants relevant to Catholic education institutions. Has product spec v2.6 (Feb 2, 2026).

## About Me (Chris Treadaway)
Product builder, not a coder. I bring requirements and vision — you handle implementation.

**Working with me:**
- Bias toward action — just do it, don't argue
- Make terminal commands dummy-proof (always start with `cd ~/grantfinder`)
- Minimize questions — make judgment calls and tell me what you chose
- I get interrupted frequently — always end sessions with clear handoff

## Tech Stack
- **Category:** School
- **Details:** Check repo for current implementation

## File Paths
- **Always use:** `~/grantfinder/`
- **Always start commands with:** `cd ~/grantfinder`

## PII Rules
❌ NEVER include: real school names → [School Name], staff names → [Staff Name], financial data, grant amounts tied to real institutions, file paths with /Users/christreadaway → use ~/
✅ ALWAYS use placeholders

## Git Branch Strategy
- Claude Code creates new branch per session
- Merge to main when stable
- Delete merged branches immediately

## Session End Routine

At the end of EVERY session — or when I say "end session" — do ALL of the following:

### A. Update SESSION_NOTES.md
Append a detailed entry at the TOP of SESSION_NOTES.md (most recent first) with: What We Built, Technical Details, Current Status (✅/❌/🚧), Branch Info, Decisions Made, Next Steps, Questions/Blockers.

### B. Update PROJECT_STATUS.md
Overwrite PROJECT_STATUS.md with the CURRENT state of the project — progress %, what's working, what's broken, what's in progress, next steps, last session date/summary. This is a snapshot, not a log.

### C. Commit Both Files
```
git add SESSION_NOTES.md PROJECT_STATUS.md
git commit -m "Session end: [brief description of what was done]"
git push
```

### D. Tell the User
- What branch you're on
- Whether it's ready to merge to main (and if not, why)
- Top 3 next steps for the next session

---
Last Updated: February 16, 2026
