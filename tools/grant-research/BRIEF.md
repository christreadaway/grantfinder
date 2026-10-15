# Grant research brief

Every research agent reads this first and follows it exactly. It is used by the
`grant-research` skill (`.claude/skills/grant-research/SKILL.md`), which runs monthly.

Today's date is given in your task. You are researching real grant programs for GrantFinder, a
tool that helps a Catholic parish and its parish school (elementary and middle grades) in the
Austin, Texas area (Diocese of Austin) find grants. The records you produce go into the app's
starter database, which every user sees, so ACCURACY IS THE WHOLE JOB. A wrong deadline or a dead
link wastes a school's time; a fabricated grant is worse than none.

## Hard rules
1. Verify every fact in THIS session with WebFetch/WebSearch, preferably on the funder's own website.
   Never write a deadline, amount, URL or eligibility rule from memory or from the existing record.
2. `url` must be a page you fetched successfully in this session that describes the program (not a
   homepage if a program page exists). If the official site blocks fetching, you may use a reputable
   secondary source (Candid/GuideStar, the funder's IRS 990 summary, a diocese or state agency page),
   set confidence "partial", and say what is unconfirmed.
3. Only include programs a private Catholic K-12 school or a Catholic parish in Texas can actually
   apply to (or receive through a standard channel such as its diocese or school district). Programs
   that exclude religious organizations, private schools, or Texas go in `excluded` with the reason;
   they never go in `grants`.
4. No names of individual people, no personal emails or phone numbers. `contact` is always "Via website".
5. Do not mention any specific school or parish name.

## Record format (one JSON object per program)
```
{
  "grant_name": "Program name as the funder calls it",
  "funder": "Organization name",
  "category": "catholic_school | church_parish | mixed | non_catholic",
      // catholic_school = Catholic funder focused on schools; church_parish = Catholic funder for parishes;
      // mixed = Catholic funder for both; non_catholic = secular, corporate or government
  "deadline": "YYYY-MM-DD | Annual: Month D | Rolling | Check website",
      // YYYY-MM-DD only for a specific upcoming date (on or after today) posted for the next cycle.
      // "Annual: October 15" only when the funder states the same date every year.
      // If there are several cycles or an LOI step, put the NEXT applicable date here and all of it in deadline_notes.
  "deadline_notes": "Every cycle / LOI / invitation detail, in one or two sentences",
  "amount": "e.g. $5,000 - $25,000 | Up to $10,000 | Varies",
  "typical_award": "Typical or median award if the funder or its 990/annual report states it, else Not published",
  "description": "2-3 sentences: what it funds and who it is for",
  "focus_areas": ["the funder's CURRENT priorities for this program, in its words where possible (2-6 items)"],
  "contact": "Via website",
  "url": "https://... program page you fetched",
  "status": "OPEN | Rolling | Check deadline",
      // OPEN = accepting applications now; Rolling = any time; Check deadline = cycle not open yet or by invitation.
      // A paused or discontinued program goes in excluded, not here.
  "geo_qualified": "Yes | Yes - TX Only | Check eligibility",
      // From the point of view of a Texas organization: Yes = national or all of Texas;
      // Yes - TX Only = only Texas organizations may apply; Check eligibility = limited to some
      // regions, cities, counties or dioceses (say which in geography)
  "geography": "National | Texas | Central Texas (Travis, Williamson, Hays counties) | Mission dioceses only | ...",
  "religious_eligibility": "eligible | secular_purpose_only | unclear",
      // eligible = religious schools/parishes may apply for this purpose;
      // secular_purpose_only = they may apply but money cannot support religious activity
  "eligibility_notes": "Who may apply, key restrictions (501(c)(3), OCD listing, Title I %, etc.)",
  "funds_for": ["tags from the list below"],
  "last_verified": "today's date, YYYY-MM-DD",
  "confidence": "verified | partial",
  "sources": ["every URL you fetched to confirm this record"]
}
```

When you are VERIFYING an existing record, also include `"action": "keep" | "update" | "remove"` and
`"action_reason"` for update/remove, and keep `grant_name` identical unless the funder renamed the
program (then use the new name and add `"renamed_from": "<old name>"`).

funds_for tags (use only these): academics, ai, arts, athletics, capital, catechesis, catholic_schools,
classroom, community, education, emergency_relief, energy, environment, evangelization, facilities,
faith_formation, gardens, health, human_services, hunger_relief, innovation, internet, library,
literacy, mental_health, ministry, nutrition, operations, playground, programs, scholarships,
security, social_justice, social_services, special_education, stem, teacher_development,
technology, transportation, tuition_assistance, youth

## Output
Write ONE file (path given in your task) containing:
```
{ "grants": [ ...records... ],
  "excluded": [ { "grant_name": "...", "funder": "...", "url": "...", "reason": "why a Catholic school in Texas can't use it" } ],
  "foundations": [ ...only if your task asks for them... ],
  "summary": "what you covered, what you could not verify" }
```
Validate it before you finish:
`python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d['grants']), 'grants', len(d['excluded']), 'excluded')" <file>`

Your final message: counts plus anything surprising (discontinued programs, changed deadlines).
Do not paste the records.
