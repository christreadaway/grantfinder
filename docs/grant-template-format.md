# Grant Database Template Format

Upload an Excel workbook (.xlsx, up to 4 MB) on the dashboard's **Grant Database** step. The
upload merges into your database: a row whose grant name and funder match a saved grant updates the
cells you filled in, other rows are added, and nothing is deleted. A starter grant you correct this
way remembers which cells you changed, so loading the starter database again keeps your values.

## Sheets (one per category)

Name each sheet after its category. Sheets with other names are skipped.

| Category | Sheet name (any of these) |
|---|---|
| 1. Church/Parish | "Parish Grants", "Church-Parish Grants", "Category 1" |
| 2. Catholic School | "Catholic School Grants", "School Grants", "Category 2" |
| 3. Mixed Church-School | "Mixed Church-School", "Mixed", "Category 3" |
| 4. Non-Catholic Qualifying | "Non-Catholic Qualifying", "Non-Catholic", "Secular Grants", "Category 4" |
| 5. Catholic Foundations | "Catholic Foundations", "Foundations", "Category 5" |

Excel doesn't allow "/" in sheet names, so write "Church-Parish" (a dash or underscore works).
Put the column names in row 1 of each sheet and one grant per row below them. The foundations
sheet uses "Foundation Name" (or "Name") instead of "Grant Name".

## Columns

Each grant sheet should have the following columns:

## Required Column

| Column Name | Description | Example |
|------------|-------------|---------|
| Grant Name | Name of the grant ("Foundation Name" on the foundations sheet) | "KaBOOM! Build It Yourself Grant" |

A row without a grant name is skipped. Everything else is optional, but matching works far
better with a description.

## Optional Columns

| Column Name | Description | Example |
|------------|-------------|---------|
| Description | What the grant funds (strongly recommended) | "Funds playground equipment for community organizations" |
| Granting Authority | Foundation or organization (shown as "Unknown" when missing) | "KaBOOM!" |
| Deadline | Due date (YYYY-MM-DD or a date cell) or "Rolling". A time of day in a date cell goes into the deadline notes ("Due at 17:00") | "2026-05-01" or "Rolling" |
| Amount Min | Minimum grant amount | 5000 |
| Amount Max | Maximum grant amount | 15000 |
| Eligibility | Requirements to apply | "501(c)(3), community organization" |
| Apply URL | Link to application | "https://kaboom.org/apply" |
| Geographic Restriction | State or region limits | "Texas" or "Nationwide" |
| Region | Where applicants must be, in the funder's words (shown on the results) | "Central Texas (Travis, Williamson, Hays counties)" |
| Religious Eligibility | Whether a Catholic school or parish may apply (see below). A grant read as excluded is Not Eligible in matching, without an AI call | "Religious organizations eligible" |
| Applicants | Who submits the application: schools, parishes, dioceses, teachers, families or nonprofits, in plain words (see below) | "Teachers" or "Diocese" |
| Deadline Notes | Cycles, letter-of-inquiry steps, invitation-only rules | "Letter of inquiry by March 1; full proposal by invitation" |
| Typical Award | Typical or median award, when the funder publishes it | "$5,000" |
| Funding Priorities | The funder's current priorities, separated by semicolons or commas | "Facility repairs; Safety upgrades" |
| Last Verified | When you last checked the grant on the funder's site (YYYY-MM-DD or a date cell) | "2026-10-15" |
| Categories | Tags (comma-separated) | "playground, youth, facilities" |
| Notes | Additional information | "Requires 50+ volunteers for build day" |

## Tips

1. **Column names are flexible** - The system recognizes variations like:
   - "Grant Name", "Name", "Grant", "Title"
   - "Amount Max", "Max Amount", "Maximum", "Up To"
   - "Due Date", "Deadline", "Application Deadline"
   - "Funding Priorities", "Focus Areas", "Priorities"
   - "Region", "Service Area"
   - "Religious Eligibility", "Faith-Based Eligibility", "Religious Orgs Eligible"
   - "Applicants", "Applicant", "Applicant Type", "Who Applies"
   - "Deadline Notes", "Cycle Notes"; "Typical Award", "Average Award"; "Last Verified", "Verified"

2. **Religious Eligibility** - Write `eligible`, `secular_purpose_only`, `excluded` or `unclear`,
   or plain words: "Yes", "No restrictions" and "Faith-based schools welcome" read as eligible;
   "Secular programs only" as non-religious uses only; "No" and "Religious organizations are not
   eligible" as excluded; "Unclear" or "Not stated" as unclear. Each clause is read on its own, so
   "All nonprofits eligible except religious organizations" is excluded, while a sentence that both
   welcomes and excludes religious applicants is unclear. Your plain words are kept as the funder's
   words: the results show them ("Funder's words") and matching reads them too. Words it can't read
   show as "Religious eligibility not stated".

3. **Applicants** - Who submits the application. "Schools", "parishes" or "churches", "dioceses" or
   "bishops", "teachers" or "educators", "families", "students" or "parents", and "nonprofits" or
   "501(c)(3)" are recognized; separate several with commas, semicolons or "and"/"or". Negated
   phrases ("not individuals") are skipped. When the list names no school or parish, the results say
   who applies instead ("Teachers apply", "Applies: diocese") and matching lowers the fit unless your
   profile shows you'd go through that channel.

4. **Geography** - "Geographic Restriction" (or "Geography", "Geo Qualified") decides whether the
   grant is Texas-only, open to all, or one to check. Any value other than a plain yes or no (or
   "Check eligibility") is also kept, as written, as where applicants must be. A "Region" column,
   when present, is used for that instead. A grant whose region names only Texas or a Texas place
   (a county, a diocese, a city other than yours) is not eligible for an organization outside Texas,
   before any AI call.

5. **Dates** - Use YYYY-MM-DD format, an Excel date cell, "Rolling" for ongoing opportunities,
   or "Annual: October 15" for a deadline that repeats every year. A date cell is stored as its
   date only; its time of day, if any, goes into the deadline notes. Written dates such as
   "May 1st, 2026", "1 September 2026" or "5/1/2026 5:00 PM" are read for the countdown and calendar.

6. **Amounts** - Can include $ and commas (e.g., "$15,000" or just "15000"). A Typical Award that
   starts with "Not published" is treated as blank.

7. **Categories** - Separate multiple categories with commas

## Sample Row

| Grant Name | Granting Authority | Deadline | Amount Max | Description | Eligibility | Apply URL |
|------------|-------------------|----------|------------|-------------|-------------|-----------|
| Koch Foundation Grant | Koch Foundation | 2026-05-01 | 100000 | Supports evangelization, catechesis, Catholic schools | 501(c)(3), Listed in Catholic Directory | https://thekochfoundation.org |

With the optional grant facts (a made-up funder, for illustration):

| Grant Name | Region | Religious Eligibility | Applicants | Deadline Notes | Typical Award | Funding Priorities | Last Verified |
|------------|--------|-----------------------|------------|----------------|---------------|--------------------|---------------|
| School Facility Repair Grant | Example County, Texas | Faith-based schools welcome | Schools; parishes | Applications open each January | $5,000 | Facility repairs; Safety upgrades | 2026-10-15 |
