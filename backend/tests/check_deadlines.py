"""Deadline parsing, Kenedy seed record, prefilter, and writer urgency checks.

Run from backend/ with the backend virtualenv active:
    cd ~/grantfinder/backend && source .venv/bin/activate && SECRET_KEY=local-check-0123456789abcdef0123456789abcdef python tests/check_deadlines.py
Exits non-zero if any check fails.
"""
import json
import sys
from datetime import datetime as real_datetime, date
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
import services.ai_service as ai_mod
from services.ai_service import AIService
from services.discovery_service import load_seed_grants
from routers.writer import _compute_urgency

failures = 0
def check(label, got, want):
    global failures
    ok = got == want
    failures += 0 if ok else 1
    print(("PASS " if ok else "FAIL ") + label + f" -> {got!r}" + ("" if ok else f" (want {want!r})"))

def at(day):
    """Freeze ai_service's notion of 'today'."""
    class Frozen(real_datetime):
        @classmethod
        def utcnow(cls):
            return real_datetime(day.year, day.month, day.day, 12, 0)
    ai_mod.datetime = Frozen

json.load(open(BACKEND / "data" / "seed_grants.json"))
print("PASS seed_grants.json is valid JSON")

p = AIService._parse_deadline
at(date(2026, 10, 14))
check("annual, day before", p("Annual: October 15"), date(2026, 10, 15))
check("annual, comma + abbrev", p("Annually, Oct. 15"), date(2026, 10, 15))
check("annual, dash + lowercase", p("annual - oct 15"), date(2026, 10, 15))
at(date(2026, 10, 15))
check("annual, on the day", p("Annual: October 15"), date(2026, 10, 15))
at(date(2026, 10, 16))
check("annual, day after rolls to next year", p("Annual: October 15"), date(2027, 10, 15))
at(date(2026, 12, 31))
check("annual Jan 5 across year end", p("Annual: January 5"), date(2027, 1, 5))
at(date(2026, 3, 1))
check("annual Feb 29, next leap year not within 1 yr -> None", p("Annual: February 29"), None)
at(date(2027, 3, 1))
check("annual Feb 29 in 2028", p("Annual: February 29"), date(2028, 2, 29))
check("fixed ISO date unchanged", p("2026-10-15"), date(2026, 10, 15))
check("'Check website' -> None", p("Check website"), None)
check("'Rolling' -> None", p("Rolling"), None)
check("bogus month -> None", p("Annual: Smarch 15"), None)
check("empty -> None", p(""), None)

ai_mod.datetime = real_datetime
grants, foundations = load_seed_grants("verify-user")
k = [g for g in grants if g.grant_name.startswith("Kenedy")]
check("Kenedy record loads once", len(k), 1)
k = k[0]
check("Kenedy deadline", k.deadline, "Annual: October 15")
check("Kenedy status", k.status.value, "OPEN")
check("Kenedy geo", k.geo_qualified.value, "Yes - TX Only")
check("Kenedy url", k.url, "https://kenedy.org/grants/application-process/")
print("INFO total seed grants:", len(grants), "foundations:", len(foundations))

from models.schemas import OrganizationProfile
svc = AIService.__new__(AIService)  # skip __init__ (no API key needed for the prefilter)
def profile(state):
    return OrganizationProfile(id="p1", user_id="verify-user", organization_name="[School Name]",
                               organization_type="both", city="[City]", state=state)
check("TX parish school passes the Kenedy prefilter", svc._deterministic_prefilter(k, profile("TX")), None)
res = svc._deterministic_prefilter(k, profile("OK"))
check("non-Texas org is disqualified", res is not None, True)
at(date(2026, 10, 16))
check("after Oct 15 the grant is NOT treated as expired", svc._deterministic_prefilter(k, profile("TX")), None)
ai_mod.datetime = real_datetime
check("writer urgency flag on Oct 14 (deadline tomorrow)", _compute_urgency(k.deadline), True)
print("FAILURES:", failures)
sys.exit(1 if failures else 0)
