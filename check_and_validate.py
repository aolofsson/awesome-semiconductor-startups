#!/bin/env python3

import csv
import re
import sys
import ssl
import time
import concurrent.futures
from urllib.request import Request, urlopen
from urllib.error import HTTPError

TIMEOUT = 15
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

def _fetch(url, use_ssl=True):
    ctx = None
    if use_ssl:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    for method in ("HEAD", "GET"):
        req = Request(url, method=method, headers=HEADERS)
        try:
            urlopen(req, timeout=TIMEOUT, context=ctx)
            return True
        except HTTPError as e:
            if e.code < 500:
                return True
        except Exception:
            pass
    return False

def check_url(domain):
    candidates = [f"https://{domain}"]
    if not domain.startswith("www."):
        candidates.append(f"https://www.{domain}")
    for url in candidates:
        if _fetch(url, use_ssl=True):
            return True
    for prefix in ("", "www."):
        url = f"http://{prefix}{domain}"
        if _fetch(url, use_ssl=False):
            return True
    return False

def check_year(v):
    return re.fullmatch(r"\d{4}", v) is not None

def load_technologies():
    techs = {}
    with open("technologies.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            techs[r["Technology"]] = r["Description"]
    return techs

def validate_startups(valid_tech):
    issues = []
    rows = []
    seen_company = set()
    seen_website = set()
    with open("startups.csv", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != ["Company","Website","Technology","Country","Founded","Description"]:
            issues.append(("ERROR", "startups.csv", 1, f"Bad headers: {reader.fieldnames}"))
        for row in reader:
            n = reader.line_num
            c = row["Company"].strip()
            w = row["Website"].strip()
            t = row["Technology"].strip()
            co = row["Country"].strip()
            y = row["Founded"].strip()
            d = row["Description"].strip()
            if not c:
                issues.append(("ERROR", "startups.csv", n, "Empty Company"))
                continue
            if not w:
                issues.append(("ERROR", "startups.csv", n, f"Empty Website (Company: {c})"))
                continue
            if c in seen_company:
                issues.append(("ERROR", "startups.csv", n, f"Duplicate Company: {c}"))
                continue
            if w.lower() in seen_website:
                issues.append(("ERROR", "startups.csv", n, f"Duplicate Website: {w}"))
                continue
            seen_company.add(c)
            seen_website.add(w.lower())
            if t not in valid_tech:
                issues.append(("ERROR", "startups.csv", n, f"Unknown Technology: {t} (Company: {c})"))
            if not check_year(y):
                issues.append(("ERROR", "startups.csv", n, f"Invalid Founded year: {y} (Company: {c})"))
            if re.fullmatch(r"[A-Z]{2}", co) is None:
                issues.append(("WARNING", "startups.csv", n, f"Non-standard Country: {co} (Company: {c})"))
            if not d:
                issues.append(("WARNING", "startups.csv", n, f"Empty Description (Company: {c})"))
            rows.append({**row, "_domain": w, "_company": c, "_founded": y, "_desc": d})
    return rows, issues

COUNTRY_RE = re.compile(r"[A-Z]{2}")
EXIT_RE = re.compile(r"[A-Z][a-zA-Z.&]+")

def validate_alumni():
    issues = []
    seen_company = set()
    seen_link = set()
    known_exits = {"IPO","SPAC","Shutdown","Sold"}
    with open("alumni.csv", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != ["Company","Exit","Year","Value($M)","Link"]:
            issues.append(("ERROR", "alumni.csv", 1, f"Bad headers: {reader.fieldnames}"))
        for row in reader:
            n = reader.line_num
            c = row["Company"].strip()
            e = row["Exit"].strip()
            y = row["Year"].strip()
            v = row["Value($M)"].strip()
            l = row["Link"].strip()
            if not c:
                issues.append(("ERROR", "alumni.csv", n, "Empty Company"))
                continue
            if c in seen_company:
                issues.append(("ERROR", "alumni.csv", n, f"Duplicate Company: {c}"))
                continue
            seen_company.add(c)
            if not e:
                issues.append(("ERROR", "alumni.csv", n, f"Empty Exit (Company: {c})"))
            elif e not in known_exits and not EXIT_RE.fullmatch(e):
                issues.append(("WARNING", "alumni.csv", n, f"Unusual Exit type: {e} (Company: {c})"))
            if y != "NA":
                if not check_year(y):
                    issues.append(("ERROR", "alumni.csv", n, f"Invalid Year: {y} (Company: {c})"))
                elif not (2000 <= int(y) <= 2026):
                    issues.append(("WARNING", "alumni.csv", n, f"Year out of range: {y} (Company: {c})"))
            if v != "NA" and not re.fullmatch(r"\d+(\.\d+)?", v):
                issues.append(("ERROR", "alumni.csv", n, f"Invalid Value: {v} (Company: {c})"))
            if l != "NA":
                if not re.fullmatch(r"https?://.+", l):
                    issues.append(("ERROR", "alumni.csv", n, f"Invalid Link: {l} (Company: {c})"))
                elif l in seen_link:
                    issues.append(("WARNING", "alumni.csv", n, f"Duplicate Link (Company: {c})"))
                seen_link.add(l)
    return issues

def check_urls_parallel(rows, workers):
    url_results = []
    passed = failed = 0
    total = len(rows)
    done = 0
    start = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        fut_to_row = {pool.submit(check_url, r["_domain"]): r for r in rows}
        for fut in concurrent.futures.as_completed(fut_to_row):
            row = fut_to_row[fut]
            alive = fut.result()
            done += 1
            elapsed = time.time() - start
            pct = done / total * 100
            eta = elapsed / done * (total - done) if done else 0
            bar = "#" * int(pct / 5) + "-" * (20 - int(pct / 5))
            sys.stderr.write(f"\r  [{bar}] {pct:5.1f}%  {done}/{total}  {elapsed:.0f}s elapsed  ETA {eta:.0f}s")
            sys.stderr.flush()
            if alive:
                passed += 1
            else:
                failed += 1
                url_results.append(f"  FAIL  {row['_domain']}  |  {row['_company']}  |  {row['_founded']}  |  {row['_desc']}")
    sys.stderr.write(f"\r{' ' * 80}\r")
    return passed, failed, url_results

def main():
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 8

    print("=" * 60)
    print(" 1. Loading technologies ...")
    print("=" * 60)
    valid_tech = load_technologies()
    print(f"    {len(valid_tech)} technologies loaded\n")

    print("=" * 60)
    print(" 2. Validating startups.csv ...")
    print("=" * 60)
    rows, issues = validate_startups(valid_tech)
    print(f"    {len(rows)} valid rows\n")

    print("=" * 60)
    print(" 3. Validating alumni.csv ...")
    print("=" * 60)
    issues += validate_alumni()
    print()

    print("=" * 60)
    print(f" 4. Checking URLs (workers={workers}) ...")
    print("=" * 60)
    passed, failed, url_results = check_urls_parallel(rows, workers)

    errs = [i for i in issues if i[0] == "ERROR"]
    warns = [i for i in issues if i[0] == "WARNING"]

    print(f"\n{'=' * 60}")
    print(" RESULTS")
    print(f"{'=' * 60}")

    if url_results:
        print(f"\n  Failed URLs ({failed}):")
        for r in url_results:
            print(r)

    if errs:
        print(f"\n  Validation Errors ({len(errs)}):")
        for _, f, n, m in errs:
            print(f"  ERROR   {f}:{n}  {m}")
    if warns:
        print(f"\n  Warnings ({len(warns)}):")
        for _, f, n, m in warns:
            print(f"  WARNING {f}:{n}  {m}")

    total = passed + failed
    print(f"\n  URLs:    {passed} passed, {failed} failed ({passed/total*100:.1f}% success)")
    print(f"  Errors:   {len(errs)}")
    print(f"  Warnings: {len(warns)}")

    if failed or errs:
        sys.exit(1)

if __name__ == "__main__":
    main()
