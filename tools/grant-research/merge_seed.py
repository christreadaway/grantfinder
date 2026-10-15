#!/usr/bin/env python3
"""
Merge grant research into GrantFinder's starter database, validating every record.

    python3 -I tools/grant-research/merge_seed.py RESEARCH_DIR \
        [--seed frontend/src/server/data/seed_grants.json] [--today YYYY-MM-DD] \
        [--changelog docs/grant-research-log.md] [--dry-run]

RESEARCH_DIR holds the agents' JSON files (format: tools/grant-research/BRIEF.md):
  verify*.json  checked versions of grants already in the database ("action": keep/update/remove,
                "renamed_from" for a renamed program; may also carry "foundations")
  intel*.json   {"intel": [{"grant_name", "funder", "funder_intel"}]}: a funder track record for
                grants already listed (replaces the one they had)
  *.json        anything else: new grants
The current database is the starting point, so a grant no agent re-checked is kept as it was and
reported as NOT RE-VERIFIED (never silently dropped). Records that are marked remove, closed, or
not open to religious organizations are left out. Exit code 1 when a file is missing or unreadable,
or a record can't be used; the report says why.
"""
import argparse
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

TAGS = set("""academics ai arts athletics capital catechesis catholic_schools classroom community education
emergency_relief energy environment evangelization facilities faith_formation gardens health human_services
hunger_relief innovation internet library literacy mental_health ministry nutrition operations playground
programs scholarships security social_justice social_services special_education stem teacher_development
technology transportation tuition_assistance youth""".split())
CATEGORIES = {"catholic_school", "church_parish", "mixed", "non_catholic"}
STATUSES = {"OPEN", "Rolling", "Check deadline"}
GEO = {"Yes", "Yes - TX Only", "Check eligibility"}
RELIGIOUS = {"eligible", "secular_purpose_only", "unclear"}
MONTHS = "january february march april may june july august september october november december".split()
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
PHONE = re.compile(r"\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b")
CATEGORY_ORDER = {"catholic_school": 0, "mixed": 1, "church_parish": 2, "non_catholic": 3}
APPLICANTS = {"school", "parish", "diocese", "teacher", "family", "nonprofit"}
RELATIVE_TIME = re.compile(r"\b(today|tomorrow|yesterday|just (?:passed|closed|opened)|recently|this (?:fall|spring|summer|winter|month|week|year)|next (?:week|month)|upcoming|soon|currently|now (?:closed|open))\b", re.I)
TEXAS_PLACE = re.compile(r"^(?:Texas|Central Texas|South Texas|North Texas)\b|\b(?:Diocese of (?:Austin|Dallas|Fort Worth|San Antonio|Houston|Galveston-Houston|El Paso|Lubbock|Amarillo|Beaumont|Brownsville|Corpus Christi|Laredo|San Angelo|Tyler|Victoria)|City of Austin|Travis|Williamson|Hays) (?:only|count(?:y|ies))", re.I)


def norm(text):
    return re.sub(r"[^a-z0-9]", "", str(text or "").lower())


NOT_FOUND = re.compile(r"^(?:not found|none found|n/?a|unknown|not published)\.?$", re.I)


def clean_intel(value, where, merger):
    """A funder track record (BRIEF.md "Funder intelligence"), or None when there is nothing usable."""
    if not isinstance(value, dict):
        return None
    def text(v, limit=600):
        t = str(v or "").strip()
        return None if not t or NOT_FOUND.match(t) else t[:limit]
    awards = []
    for a in value.get("past_awards") or []:
        if not isinstance(a, dict):
            continue
        recipient, amount = text(a.get("recipient"), 160), text(a.get("amount"), 80)
        if not recipient and not amount:
            continue
        try:
            year = int(a.get("year"))
        except (TypeError, ValueError):
            year = None
        awards.append({"year": year if year and 1990 <= year <= 2100 else None, "amount": amount or "",
                       "recipient": recipient or "", "purpose": text(a.get("purpose"), 200) or ""})
    outlook = text(value.get("outlook"))
    if outlook and re.match(r"^no announced changes found\.?$", outlook, re.I):
        outlook = None
    intel = {
        "applicable": value.get("applicable") is not False,
        "note": text(value.get("note"), 400),
        "past_awards": awards[:8],
        "award_levels": text(value.get("award_levels")),
        "funded_focus": [t for t in (text(x, 160) for x in (value.get("funded_focus") or [])) if t][:6],
        "catholic_school_track_record": text(value.get("catholic_school_track_record")),
        "giving_trend": text(value.get("giving_trend")),
        "outlook": outlook,
        "as_of": str(value.get("as_of") or "")[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", str(value.get("as_of") or "")) else None,
        "sources": [s for s in (value.get("sources") or []) if isinstance(s, str) and re.match(r"^https?://\S+$", s)][:8],
    }
    intel = {k: v for k, v in intel.items() if v not in (None, "")}
    intel.setdefault("past_awards", [])
    intel.setdefault("funded_focus", [])
    intel.setdefault("sources", [])
    blob = json.dumps(intel)
    if EMAIL.search(blob) or PHONE.search(blob):
        merger.note(f"fix {where}: removed an email address or phone number from the funder track record")
        intel = json.loads(PHONE.sub("[phone on website]", EMAIL.sub("[email on website]", blob)))
    if intel["applicable"] and not (awards or intel.get("award_levels") or intel.get("catholic_school_track_record") or intel.get("outlook") or intel.get("giving_trend")):
        merger.note(f"warn {where}: funder track record has no usable facts (dropped)")
        return None
    if intel["applicable"] and not intel["sources"]:
        merger.note(f"warn {where}: funder track record lists no sources")
    return intel


class Merger:
    def __init__(self, today):
        self.today = today
        self.problems = []

    def note(self, text):
        self.problems.append(text)

    def valid_deadline(self, value):
        if value in ("Rolling", "Check website"):
            return True
        m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", value or "")
        if m:
            try:
                return date(int(m[1]), int(m[2]), int(m[3])) >= self.today
            except ValueError:
                return False
        m = re.fullmatch(r"Annual: ([A-Za-z]+) (\d{1,2})", value or "")
        if m and m[1].lower() in MONTHS:
            try:
                date(2028, MONTHS.index(m[1].lower()) + 1, int(m[2]))  # a leap year, so Feb 29 is allowed
                return True
            except ValueError:
                return False
        return False

    def clean(self, record, origin):
        """A validated starter record, or None when it can't (or mustn't) be used."""
        name = str(record.get("grant_name") or "").strip()
        where = f"{origin}: {name or '(no name)'}"
        funder = str(record.get("funder") or "").strip()
        if not name or not funder:
            self.note(f"UNUSABLE {where}: missing grant_name or funder")
            return None
        url = str(record.get("url") or "").strip()
        if not re.match(r"^https?://\S+$", url):
            self.note(f"UNUSABLE {where}: bad url {url!r}")
            return None
        if str(record.get("status") or "") == "CLOSED":
            self.note(f"SKIP {where}: status CLOSED")
            return None
        rel = str(record.get("religious_eligibility") or "").strip()
        if rel == "excluded":
            self.note(f"SKIP {where}: does not fund religious organizations")
            return None
        if rel not in RELIGIOUS:
            self.note(f"fix {where}: religious_eligibility {rel!r} -> unclear")
            rel = "unclear"

        out = {"grant_name": name, "funder": funder}
        cat = record.get("category")
        if cat not in CATEGORIES:
            self.note(f"fix {where}: category {cat!r} -> non_catholic")
            cat = "non_catholic"
        out["category"] = cat
        deadline = str(record.get("deadline") or "Check website").strip()
        notes = str(record.get("deadline_notes") or "").strip()
        if not self.valid_deadline(deadline):
            self.note(f"fix {where}: deadline {deadline!r} is past or unreadable -> 'Check website' (kept in deadline_notes)")
            notes = f"Listed deadline: {deadline}. {notes}".strip()
            deadline = "Check website"
        out["deadline"] = deadline
        out["deadline_notes"] = notes
        out["amount"] = str(record.get("amount") or "Varies").strip()
        typical = str(record.get("typical_award") or "").strip()
        if typical and not re.match(r"not published\b", typical, re.I):
            out["typical_award"] = typical
        out["description"] = str(record.get("description") or "").strip()
        out["contact"] = "Via website"
        out["url"] = url
        status = record.get("status")
        if status not in STATUSES:
            self.note(f"fix {where}: status {status!r} -> 'Check deadline'")
            status = "Check deadline"
        out["status"] = status
        geo = record.get("geo_qualified")
        if geo not in GEO:
            self.note(f"fix {where}: geo_qualified {geo!r} -> 'Check eligibility'")
            geo = "Check eligibility"
        out["geo_qualified"] = geo
        out["geography"] = str(record.get("geography") or "").strip()
        out["religious_eligibility"] = rel
        out["eligibility_notes"] = str(record.get("eligibility_notes") or "").strip()
        focus = record.get("focus_areas") or []
        if isinstance(focus, str):
            focus = [part for part in re.split(r"[;\n]", focus)]
        out["focus_areas"] = [str(x).strip() for x in focus if str(x).strip()][:8]
        tags = []
        for tag in record.get("funds_for") or []:
            t = str(tag).strip().lower().replace(" ", "_")
            if t in TAGS and t not in tags:
                tags.append(t)
            elif t not in TAGS:
                self.note(f"fix {where}: dropped unknown funds_for tag {tag!r}")
        out["funds_for"] = tags
        verified = str(record.get("last_verified") or "").strip()
        out["last_verified"] = verified if re.fullmatch(r"\d{4}-\d{2}-\d{2}", verified) else self.today.isoformat()
        conf = record.get("confidence")
        out["confidence"] = conf if conf in ("verified", "partial") else "partial"
        sources = [s for s in (record.get("sources") or []) if isinstance(s, str) and re.match(r"^https?://\S+$", s)]
        if not sources:
            self.note(f"fix {where}: no sources listed; using the url")
            sources = [url]
        out["sources"] = sources[:6]
        if record.get("renamed_from"):
            out["renamed_from"] = record["renamed_from"]
        intel = clean_intel(record.get("funder_intel"), where, self)
        if intel:
            out["funder_intel"] = intel
        if EMAIL.search(json.dumps(out)) or PHONE.search(json.dumps(out)):
            self.note(f"fix {where}: removed an email address or phone number")
            for key, value in list(out.items()):
                if isinstance(value, str) and key != "url":
                    out[key] = PHONE.sub("[phone on website]", EMAIL.sub("[email on website]", value))
        for key in ("description", "eligibility_notes"):
            if not out[key]:
                self.note(f"warn {where}: empty {key}")
        applicants = [a for a in (record.get("applicants") or []) if a in APPLICANTS]
        if applicants:
            out["applicants"] = list(dict.fromkeys(applicants))
        else:
            self.note(f"warn {where}: no applicants (who submits: school, parish, diocese, teacher, family, nonprofit)")
        stale_words = RELATIVE_TIME.findall(" ".join(str(out.get(k) or "") for k in ("deadline_notes", "description", "eligibility_notes", "amount")))
        if stale_words:
            self.note(f"warn {where}: relative time words go stale ({', '.join(sorted(set(w.lower() for w in stale_words)))}): write explicit dates")
        if out["geo_qualified"] == "Yes" and TEXAS_PLACE.search(out.get("geography") or ""):
            self.note(f"warn {where}: geography {out['geography']!r} looks limited to Texas but geo_qualified is 'Yes' (use 'Yes - TX Only')")
        return out


def load(path, merger):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as error:
        merger.note(f"MISSING {path.name}: {error}")
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("research_dir")
    parser.add_argument("--seed", default="frontend/src/server/data/seed_grants.json")
    parser.add_argument("--today", default=date.today().isoformat())
    parser.add_argument("--changelog", help="markdown file to prepend this run's changes to")
    parser.add_argument("--excluded", help="JSON list of programs found not open to Catholic schools, kept across runs")
    parser.add_argument("--dry-run", action="store_true", help="report only; write nothing")
    args = parser.parse_args()

    today = date.fromisoformat(args.today)
    merger = Merger(today)
    research = Path(args.research_dir)
    seed_path = Path(args.seed)
    seed = json.loads(seed_path.read_text())
    before = {norm(g["grant_name"]): g for g in seed.get("grants", [])}

    files = sorted(research.glob("*.json"), key=lambda p: (not p.name.startswith(("verify", "existing")), p.name))
    files = [p for p in files if p.name not in ("excluded_all.json",)]
    intel_files = [p for p in files if p.name.startswith("intel")]
    files = [p for p in files if not p.name.startswith("intel")]
    if not files and not intel_files:
        print(f"No research files in {research}", file=sys.stderr)
        sys.exit(1)

    current = dict(before)  # normalized name -> record (old ones until a verify file replaces them)
    reverified, removed, added, excluded = set(), {}, [], []
    foundations = None
    for path in files:
        data = load(path, merger)
        if data is None:
            continue
        excluded.extend(data.get("excluded", []))
        if data.get("foundations"):
            foundations = data["foundations"]
        is_verify = path.name.startswith(("verify", "existing"))
        if is_verify:
            # A listed grant the verifier put only under "excluded" (not open to Catholic schools) comes out too.
            for entry in data.get("excluded", []):
                key = norm(entry.get("grant_name") if isinstance(entry, dict) else "")
                if key in before and key in current:
                    current.pop(key)
                    reverified.add(key)
                    removed[before[key]["grant_name"]] = str(entry.get("reason") or "not open to Catholic schools").strip()
        for record in data.get("grants", []):
            name = str(record.get("grant_name") or "")
            old_names = [norm(name)] + [norm(n) for n in ([record["renamed_from"]] if isinstance(record.get("renamed_from"), str) else record.get("renamed_from") or [])]
            old = next((n for n in old_names if n in before), None)
            if not is_verify and (old or norm(name) in current):
                # A discovery agent re-found a grant that is already listed: the verified record stands.
                merger.note(f"DUP {path.name}: {name} is already in the database (kept the existing record)")
                continue
            if is_verify and not old:
                merger.note(f"warn {path.name}: {name} matches no existing grant (missing renamed_from?); added as new")
            if record.get("action") == "remove":
                if old:
                    current.pop(old, None)
                    removed[before[old]["grant_name"]] = record.get("action_reason") or "removed by research"
                    reverified.add(old)
                merger.note(f"SKIP {path.name}: {name} (remove: {record.get('action_reason')})")
                continue
            cleaned = merger.clean(record, path.name)
            if cleaned is None:
                if old:
                    current.pop(old, None)
                    removed[before[old]["grant_name"]] = "failed validation (closed, excluded or unusable): see the report"
                    reverified.add(old)
                continue
            if old:
                current.pop(old, None)
                reverified.add(old)
            key = norm(cleaned["grant_name"])
            if key in current and key not in before:
                merger.note(f"DUP {path.name}: {cleaned['grant_name']} found twice this run (kept the first)")
                continue
            current[key] = cleaned
            if not old:
                added.append(cleaned["grant_name"])

    # Funder track records for grants already listed (a separate research pass).
    intel_added = 0
    for path in intel_files:
        data = load(path, merger)
        if data is None:
            continue
        for entry in data.get("intel", []):
            name = str(entry.get("grant_name") or "") if isinstance(entry, dict) else ""
            key = norm(name)
            if key not in current:
                merger.note(f"warn {path.name}: track record for {name or '(no name)'} matches no grant in the database (skipped)")
                continue
            intel = clean_intel(entry.get("funder_intel"), f"{path.name}: {name}", merger)
            if intel:
                current[key] = {**current[key], "funder_intel": intel}
                intel_added += 1
    if intel_files:
        print(f"funder track records attached: {intel_added}")

    not_reverified = [g["grant_name"] for k, g in before.items() if k not in reverified and k in current]
    for name in not_reverified:
        merger.note(f"NOT RE-VERIFIED this run (kept as it was): {name}")

    grants = sorted(current.values(), key=lambda g: (CATEGORY_ORDER.get(g.get("category"), 9), g["grant_name"].lower()))
    # Two agents can find one program under two names: same funder and same page is worth a look.
    def page(url):
        return re.sub(r"^https?://(www\.)?", "", str(url or "")).rstrip("/").lower()
    seen_pages = {}
    for g in grants:
        key = (norm(re.sub(r"\(.*?\)", "", g.get("funder", ""))), page(g.get("url")))
        if key in seen_pages:
            merger.note(f"warn possible duplicate: {g['grant_name']} and {seen_pages[key]} (same funder and page); keep both only if they are different programs")
        else:
            seen_pages[key] = g["grant_name"]
    stale = [g["grant_name"] for g in grants if g.get("last_verified", "0000") < (today - timedelta(days=62)).isoformat()]
    changes = []
    for g in grants:
        old = before.get(norm(g["grant_name"])) or next((before[norm(n)] for n in ([g["renamed_from"]] if isinstance(g.get("renamed_from"), str) else g.get("renamed_from") or []) if norm(n) in before), None)
        if not old:
            continue
        for field in ("deadline", "amount", "url", "religious_eligibility", "geography", "status"):
            if (old.get(field) or "") != (g.get(field) or ""):
                changes.append(f"{g['grant_name']}: {field} {old.get(field) or '(none)'} -> {g.get(field) or '(none)'}")

    if foundations is not None:
        kept = []
        for f in foundations:
            if f.get("action") == "remove":
                merger.note(f"SKIP foundation {f.get('foundation_name')} ({f.get('action_reason')})")
                continue
            focus = f.get("focus_areas")
            kept.append({
                "foundation_name": str(f.get("foundation_name") or "").strip(),
                "application_cycle": str(f.get("application_cycle") or "Check website").strip(),
                "focus_areas": (focus if isinstance(focus, str) else "; ".join(focus or [])).strip(),
                "location": str(f.get("location") or "").strip(),
                "contact": "Via website",
                "website": str(f.get("website") or "").strip(),
                "annual_giving": str(f.get("annual_giving") or "Check website").strip(),
                "notes": str(f.get("notes") or "").strip(),
            })
        seed["foundations"] = [f for f in kept if f["foundation_name"] and f["website"].startswith("http")]

    seed["grants"] = grants
    seed["version"] = today.isoformat()
    seed["updated"] = today.isoformat()
    seed["description"] = (
        "GrantFinder starter grant database: national, Catholic and Texas grant programs that a Catholic "
        "school or parish can apply to, each checked against the funder's own site on its last_verified date "
        "(deadlines, amounts, eligibility, whether religious organizations may apply). Refreshed monthly by the "
        "grant-research skill. Deadlines and amounts change: always confirm on the funder's website before applying."
    )

    by_cat = {}
    for g in grants:
        by_cat[g["category"]] = by_cat.get(g["category"], 0) + 1
    print(f"grants: {len(grants)} (was {len(before)}) {by_cat}; foundations: {len(seed.get('foundations', []))}")
    print(f"added {len(added)}, removed {len(removed)}, re-verified {len(reverified)}, not re-verified {len(not_reverified)}, field changes {len(changes)}, stale (>62 days) {len(stale)}")
    print("deadlines:", {k: sum(1 for g in grants if (g['deadline'][:4].isdigit() if k == 'date' else g['deadline'].startswith('Annual') if k == 'annual' else g['deadline'] == k)) for k in ('date', 'annual', 'Rolling', 'Check website')})
    print("religious:", {k: sum(1 for g in grants if g.get('religious_eligibility') == k) for k in sorted(RELIGIOUS)})
    print("confidence:", {k: sum(1 for g in grants if g.get('confidence') == k) for k in ('verified', 'partial')})
    for p in merger.problems:
        print(" -", p)

    if not args.dry_run:
        seed_path.write_text(json.dumps(seed, indent=2, ensure_ascii=False) + "\n")
        (research / "excluded_all.json").write_text(json.dumps(excluded, indent=2, ensure_ascii=False))
        if args.excluded:
            known_path = Path(args.excluded)
            known = json.loads(known_path.read_text()) if known_path.exists() else []
            by_name = {norm(e.get("grant_name")) + "|" + norm(e.get("funder")): e for e in known if isinstance(e, dict)}
            for e in excluded:
                if not isinstance(e, dict) or not e.get("grant_name"):
                    continue
                by_name[norm(e.get("grant_name")) + "|" + norm(e.get("funder"))] = {
                    "grant_name": str(e.get("grant_name")).strip(),
                    "funder": str(e.get("funder") or "").strip(),
                    "url": str(e.get("url") or "").strip(),
                    "reason": str(e.get("reason") or "").strip(),
                    "checked": today.isoformat(),
                }
            # Removed grants are remembered too, so discovery doesn't re-add them next month.
            for name, why in removed.items():
                old = before[norm(name)]
                by_name[norm(name) + "|" + norm(old.get("funder"))] = {
                    "grant_name": name, "funder": old.get("funder", ""), "url": old.get("url", ""), "reason": why, "checked": today.isoformat(),
                }
            known_path.write_text(json.dumps(sorted(by_name.values(), key=lambda e: e["grant_name"].lower()), indent=2, ensure_ascii=False) + "\n")
        if args.changelog:
            log = Path(args.changelog)
            entry = [f"## {today.isoformat()}", "", f"{len(grants)} grants (was {len(before)}).", ""]
            if added:
                entry += ["**Added:**", *[f"- {n}" for n in sorted(added)], ""]
            if removed:
                entry += ["**Removed:**", *[f"- {n}: {why}" for n, why in sorted(removed.items())], ""]
            if changes:
                entry += ["**Changed:**", *[f"- {c}" for c in changes], ""]
            if not_reverified:
                entry += ["**Not re-verified this run (kept as they were):**", *[f"- {n}" for n in not_reverified], ""]
            if stale:
                entry += ["**Last verified more than two months ago:**", *[f"- {n}" for n in stale], ""]
            header = "# Grant research log\n\nWhat each monthly run of the grant-research skill changed in the starter database (newest first).\n\n"
            old = log.read_text() if log.exists() else header
            body = old[len(header):] if old.startswith(header) else old
            log.write_text(header + "\n".join(entry) + "\n" + body)
    sys.exit(1 if any(p.startswith(("UNUSABLE", "MISSING")) for p in merger.problems) else 0)


if __name__ == "__main__":
    main()
