# Grant Database Template Format

Upload an Excel workbook (.xlsx, up to 4 MB) on the dashboard's **Grant Database** step. The
upload merges into your database: a row whose grant name and funder match a saved grant updates the
cells you filled in, other rows are added, and nothing is deleted.

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

## Required Columns

| Column Name | Description | Example |
|------------|-------------|---------|
| Grant Name | Name of the grant | "KaBOOM! Build It Yourself Grant" |
| Description | What the grant funds | "Funds playground equipment for community organizations" |

## Optional Columns

| Column Name | Description | Example |
|------------|-------------|---------|
| Granting Authority | Foundation or organization | "KaBOOM!" |
| Deadline | Due date (YYYY-MM-DD) or "Rolling" | "2026-05-01" or "Rolling" |
| Amount Min | Minimum grant amount | 5000 |
| Amount Max | Maximum grant amount | 15000 |
| Eligibility | Requirements to apply | "501(c)(3), community organization" |
| Apply URL | Link to application | "https://kaboom.org/apply" |
| Geographic Restriction | State or region limits | "Texas" or "Nationwide" |
| Categories | Tags (comma-separated) | "playground, youth, facilities" |
| Notes | Additional information | "Requires 50+ volunteers for build day" |

## Tips

1. **Column names are flexible** - The system recognizes variations like:
   - "Grant Name", "Name", "Grant", "Title"
   - "Amount Max", "Max Amount", "Maximum", "Up To"
   - "Due Date", "Deadline", "Application Deadline"

2. **Dates** - Use YYYY-MM-DD format, an Excel date cell, "Rolling" for ongoing opportunities,
   or "Annual: October 15" for a deadline that repeats every year

3. **Amounts** - Can include $ and commas (e.g., "$15,000" or just "15000")

4. **Categories** - Separate multiple categories with commas

## Sample Row

| Grant Name | Granting Authority | Deadline | Amount Max | Description | Eligibility | Apply URL |
|------------|-------------------|----------|------------|-------------|-------------|-----------|
| Koch Foundation Grant | Koch Foundation | 2026-05-01 | 100000 | Supports evangelization, catechesis, Catholic schools | 501(c)(3), Listed in Catholic Directory | https://thekochfoundation.org |
