#!/usr/bin/env python3
"""Validate the CSV databases and check that every startup website is reachable.

Usage:  python check_and_validate.py [workers] [--timeout N] [--skip-urls]

Exits non-zero if any ERROR-level issue or unreachable URL is found, so it can
gate a pull request in CI.
"""

import argparse
import concurrent.futures
import csv
import ipaddress
import re
import socket
import ssl
import sys
import time
from datetime import date
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener

TIMEOUT = 10
MAX_REDIRECTS = 5
MAX_WORKERS = 64
MIN_YEAR = 1980
MAX_YEAR = date.today().year + 1

# A server that answers with one of these is up, it just refuses automated
# clients (Cloudflare and friends). A dead domain does not run a WAF, so these
# count as reachable. 404/410 and the remaining 5xx do not: a root URL that is
# gone or broken is exactly the stale listing this script looks for.
BLOCKED_CODES = {401, 403, 405, 406, 409, 429, 503}

STARTUP_FIELDS = ["Company", "Website", "Technology", "Country", "Founded", "Description"]
ALUMNI_FIELDS = ["Company", "Exit", "Year", "Value($M)", "Link"]
TECH_FIELDS = ["Technology", "Description"]

COUNTRY_RE = re.compile(r"[A-Z]{2}")
# Exit is either an exit type or an acquirer name, which may be multi-word
# ("Analog Devices", "Ramon Space").
EXIT_RE = re.compile(r"[A-Z][A-Za-z0-9.&'-]*(?: [A-Z0-9][A-Za-z0-9.&'-]*)*")
DOMAIN_RE = re.compile(r"(?=.{1,253}\Z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                       r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+")
YEAR_RE = re.compile(r"\d{4}")
VALUE_RE = re.compile(r"\d+(?:\.\d+)?")
LINK_RE = re.compile(r"https?://\S+")

# Deliberately a browser User-Agent: a number of listed sites reject unknown
# clients outright, which would produce false failures.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}


###############################################################################
# URL checking
###############################################################################

def _is_public(host):
    """Return (ok, reason). Refuse hosts that do not resolve to a public IP.

    The Website column arrives via pull request, so it is untrusted input.
    Without this check an entry such as "localhost:8080" or "169.254.169.254"
    would make the checker probe whatever machine it runs on (SSRF).
    """
    for attempt in range(2):
        try:
            infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
            break
        except socket.gaierror:
            if attempt:
                return False, "DNS lookup failed"
            time.sleep(0.5)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            return False, f"resolves to non-public address {ip}"
    return True, ""


class _SafeRedirectHandler(HTTPRedirectHandler):
    """Follow redirects, but never off http(s) and never to a private address."""

    max_redirections = MAX_REDIRECTS

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urlsplit(newurl)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return None
        if not _is_public(parts.hostname)[0]:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


# Certificates are verified: an expired or mismatched certificate means the
# listing is stale, which is exactly what this script exists to find.
_OPENER = build_opener(HTTPSHandler(context=ssl.create_default_context()),
                       _SafeRedirectHandler)


def _reason(err):
    r = getattr(err, "reason", err)
    if isinstance(r, ssl.SSLCertVerificationError):
        return f"TLS certificate invalid ({r.verify_message or r.reason})"
    if isinstance(r, ssl.SSLError):
        return f"TLS error ({r.reason or r})"
    if isinstance(r, socket.gaierror):
        return "DNS lookup failed"
    if isinstance(r, TimeoutError):
        return f"timeout after {TIMEOUT}s"
    if isinstance(r, ConnectionRefusedError):
        return "connection refused"
    if isinstance(r, ConnectionResetError):
        return "connection reset"
    return str(r) or type(r).__name__


def _fetch(url):
    """Return (status, detail) where status is "ok", "blocked" or "fail"."""
    detail = "no response"
    blocked = None
    for method in ("HEAD", "GET"):
        req = Request(url, method=method, headers=HEADERS)
        try:
            with _OPENER.open(req, timeout=TIMEOUT) as resp:
                if 200 <= resp.status < 400:
                    return "ok", ""
                detail = f"HTTP {resp.status}"
        except HTTPError as e:
            e.close()
            if 300 <= e.code < 400:
                detail = f"HTTP {e.code} (redirect blocked or too many hops)"
            elif e.code in BLOCKED_CODES:
                # Up, but refusing this client. Retry with GET in case only
                # HEAD is rejected, and fall back to this if GET fares no better.
                blocked = f"HTTP {e.code}"
                detail = blocked
            else:
                detail = f"HTTP {e.code}"
        except URLError as e:
            detail = _reason(e)
            if isinstance(getattr(e, "reason", None), ssl.SSLError):
                return "fail", detail  # a certificate problem will not change on GET
        except TimeoutError:
            detail = f"timeout after {TIMEOUT}s"
        except ValueError as e:
            return "fail", f"malformed URL ({e})"
        except Exception as e:
            detail = f"{type(e).__name__}: {e}"
    if blocked:
        return "blocked", blocked
    return "fail", detail


# Failure reasons that say more about the moment than about the listing.
TRANSIENT = ("timeout after", "connection reset", "Remote end closed",
             "RemoteDisconnected", "IncompleteRead")


def check_url(domain):
    """Return (status, detail) where status is "ok", "blocked" or "fail"."""
    ok, why = _is_public(domain)
    if not ok:
        return "fail", why
    hosts = [domain] if domain.startswith("www.") else [domain, f"www.{domain}"]
    status, detail = _scan(domain, hosts)
    if status == "fail" and any(t in detail for t in TRANSIENT):
        # A slow or briefly overloaded server should not fail a build on one
        # bad sample; take a second look before calling the listing dead.
        time.sleep(2)
        status, detail = _scan(domain, hosts)
    return status, detail


def _scan(domain, hosts):
    """One pass over the https/http and apex/www combinations for a domain."""
    tried = {}
    blocked = None
    for scheme in ("https", "http"):
        for host in hosts:
            if host != domain and not _is_public(host)[0]:
                continue
            status, why = _fetch(f"{scheme}://{host}")
            if status == "ok":
                if scheme == "http":
                    return "ok", "reachable over http only (no valid HTTPS)"
                return "ok", ""
            if status == "blocked" and blocked is None:
                blocked = f"{scheme}://{host}: {why}"
            # Keyed by reason so four variants of the same failure report once.
            tried.setdefault(why, f"{scheme}://{host}")
    if blocked:
        return "blocked", blocked
    return "fail", "; ".join(f"{url}: {why}" for why, url in tried.items())


###############################################################################
# CSV loading and validation
###############################################################################

def read_rows(path, expected, issues):
    """Return [(line_num, row)] with every field a stripped string.

    Records an ERROR and returns [] on a missing file, bad headers or bad
    encoding, instead of aborting the whole run with a traceback.
    """
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f, restval="")
            if reader.fieldnames != expected:
                issues.append(("ERROR", path, 1, f"Bad headers: expected {expected}, "
                                                 f"got {reader.fieldnames}"))
                return []
            rows = []
            for row in reader:
                n = reader.line_num
                if None in row:
                    issues.append(("ERROR", path, n, "Too many columns "
                                                     f"(expected {len(expected)})"))
                    continue
                rows.append((n, {k: (v or "").strip() for k, v in row.items()}))
            return rows
    except OSError as e:
        issues.append(("ERROR", path, 0, f"Cannot read file: {e.strerror}"))
    except UnicodeDecodeError as e:
        issues.append(("ERROR", path, 0, f"File is not valid UTF-8 (byte {e.start})"))
    except csv.Error as e:
        issues.append(("ERROR", path, 0, f"Malformed CSV: {e}"))
    return []


def check_year(v):
    """Return (well_formed, in_range)."""
    if YEAR_RE.fullmatch(v) is None:
        return False, False
    return True, MIN_YEAR <= int(v) <= MAX_YEAR


def check_domain(w):
    """Return (domain, error) for a Website value, which must be a bare domain."""
    d = w.lower()
    if "://" in d or d.startswith("//"):
        return None, "must be a bare domain, not a URL"
    d = d.rstrip("/")
    if not DOMAIN_RE.fullmatch(d):
        return None, "not a valid domain name"
    if d.rsplit(".", 1)[-1].isdigit():
        return None, "must be a domain name, not an IP address"
    return d, None


def load_technologies(path, issues):
    return {row["Technology"] for _, row in read_rows(path, TECH_FIELDS, issues)}


def validate_startups(path, valid_tech, issues):
    entries = []
    seen_company = {}
    seen_domain = {}
    for n, row in read_rows(path, STARTUP_FIELDS, issues):
        c, w, t = row["Company"], row["Website"], row["Technology"]
        co, y, d = row["Country"], row["Founded"], row["Description"]
        if not c:
            issues.append(("ERROR", path, n, "Empty Company"))
            continue
        if not w:
            issues.append(("ERROR", path, n, f"Empty Website (Company: {c})"))
            continue
        if c.lower() in seen_company:
            issues.append(("ERROR", path, n, f"Duplicate Company: {c} "
                                             f"(first seen on line {seen_company[c.lower()]})"))
            continue
        seen_company[c.lower()] = n
        domain, err = check_domain(w)
        if domain is None:
            issues.append(("ERROR", path, n, f"Invalid Website: {w} - {err} (Company: {c})"))
            continue
        key = domain[4:] if domain.startswith("www.") else domain
        if key in seen_domain:
            issues.append(("ERROR", path, n, f"Duplicate Website: {w} "
                                             f"(first seen on line {seen_domain[key]})"))
            continue
        seen_domain[key] = n
        if t not in valid_tech:
            issues.append(("ERROR", path, n, f"Unknown Technology: {t} (Company: {c})"))
        well_formed, in_range = check_year(y)
        if not well_formed:
            issues.append(("ERROR", path, n, f"Invalid Founded year: {y} (Company: {c})"))
        elif not in_range:
            issues.append(("WARNING", path, n, f"Founded year out of range "
                                               f"({MIN_YEAR}-{MAX_YEAR}): {y} (Company: {c})"))
        if not COUNTRY_RE.fullmatch(co):
            issues.append(("WARNING", path, n, f"Non-standard Country: {co} (Company: {c})"))
        if not d:
            issues.append(("WARNING", path, n, f"Empty Description (Company: {c})"))
        entries.append({"domain": domain, "company": c, "founded": y,
                        "desc": d, "line": n})
    return entries


def validate_alumni(path, issues):
    seen_company = {}
    seen_link = {}
    for n, row in read_rows(path, ALUMNI_FIELDS, issues):
        c, e, y = row["Company"], row["Exit"], row["Year"]
        v, link = row["Value($M)"], row["Link"]
        if not c:
            issues.append(("ERROR", path, n, "Empty Company"))
            continue
        if c.lower() in seen_company:
            issues.append(("ERROR", path, n, f"Duplicate Company: {c} "
                                             f"(first seen on line {seen_company[c.lower()]})"))
            continue
        seen_company[c.lower()] = n
        if not e:
            issues.append(("ERROR", path, n, f"Empty Exit (Company: {c})"))
        elif not EXIT_RE.fullmatch(e):
            issues.append(("WARNING", path, n, f"Unusual Exit type: {e} (Company: {c})"))
        if y != "NA":
            well_formed, in_range = check_year(y)
            if not well_formed:
                issues.append(("ERROR", path, n, f"Invalid Year: {y} (Company: {c})"))
            elif not in_range:
                issues.append(("WARNING", path, n, f"Year out of range "
                                                   f"({MIN_YEAR}-{MAX_YEAR}): {y} (Company: {c})"))
        if v != "NA" and not VALUE_RE.fullmatch(v):
            issues.append(("ERROR", path, n, f"Invalid Value: {v} (Company: {c})"))
        if link != "NA":
            if not LINK_RE.fullmatch(link):
                issues.append(("ERROR", path, n, f"Invalid Link: {link} (Company: {c})"))
            elif link in seen_link:
                issues.append(("WARNING", path, n, f"Duplicate Link (Company: {c}, "
                                                   f"first seen on line {seen_link[link]})"))
            else:
                seen_link[link] = n


###############################################################################
# Parallel URL check
###############################################################################

def check_urls_parallel(entries, workers, issues, path):
    failures = []
    passed = failed = blocked = 0
    total = len(entries)
    if not total:
        return passed, failed, blocked, failures
    show_progress = sys.stderr.isatty()
    width = 0
    start = time.time()
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(check_url, e["domain"]): e for e in entries}
        for fut in concurrent.futures.as_completed(futures):
            entry = futures[fut]
            try:
                status, detail = fut.result()
            except Exception as exc:  # a bug in check_url must not lose the run
                status, detail = "fail", f"checker error: {type(exc).__name__}: {exc}"
            done += 1
            if status == "ok":
                passed += 1
                if detail:
                    issues.append(("WARNING", path, entry["line"],
                                   f"{detail} (Company: {entry['company']})"))
            elif status == "blocked":
                # Counted as reachable and deliberately not warned about: these
                # are not actionable, and 30-odd of them would drown the report.
                passed += 1
                blocked += 1
            else:
                failed += 1
                failures.append(f"  FAIL  {entry['domain']}  |  {entry['company']}  |  "
                                f"{entry['founded']}\n          {detail}")
            if show_progress:
                elapsed = time.time() - start
                pct = done / total * 100
                eta = elapsed / done * (total - done)
                bar = "#" * int(pct / 5) + "-" * (20 - int(pct / 5))
                line = (f"  [{bar}] {pct:5.1f}%  {done}/{total}  "
                        f"{elapsed:.0f}s elapsed  ETA {eta:.0f}s")
                width = max(width, len(line))
                sys.stderr.write("\r" + line.ljust(width))
                sys.stderr.flush()
    if show_progress and width:
        sys.stderr.write("\r" + " " * width + "\r")
        sys.stderr.flush()
    return passed, failed, blocked, failures


###############################################################################
# Main
###############################################################################

def positive_int(v):
    n = int(v)
    if n < 1:
        raise argparse.ArgumentTypeError("must be 1 or greater")
    return n


def main():
    global TIMEOUT

    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("workers", nargs="?", type=positive_int, default=8,
                   help="parallel URL checks (default: 8)")
    p.add_argument("--timeout", type=positive_int, default=TIMEOUT,
                   help=f"per-request timeout in seconds (default: {TIMEOUT})")
    p.add_argument("--skip-urls", action="store_true",
                   help="validate the CSV files only, without network access")
    args = p.parse_args()

    TIMEOUT = args.timeout
    workers = min(args.workers, MAX_WORKERS)
    if workers != args.workers:
        print(f"    (clamping workers to {MAX_WORKERS})")

    issues = []

    print("=" * 60)
    print(" 1. Loading technologies ...")
    print("=" * 60)
    valid_tech = load_technologies("technologies.csv", issues)
    print(f"    {len(valid_tech)} technologies loaded\n")

    print("=" * 60)
    print(" 2. Validating startups.csv ...")
    print("=" * 60)
    entries = validate_startups("startups.csv", valid_tech, issues)
    print(f"    {len(entries)} valid rows\n")

    print("=" * 60)
    print(" 3. Validating alumni.csv ...")
    print("=" * 60)
    validate_alumni("alumni.csv", issues)
    print("    done\n")

    print("=" * 60)
    if args.skip_urls:
        print(" 4. Checking URLs ... skipped (--skip-urls)")
        print("=" * 60)
        passed = failed = blocked = 0
        url_failures = []
    else:
        print(f" 4. Checking URLs (workers={workers}) ...")
        print("=" * 60)
        passed, failed, blocked, url_failures = check_urls_parallel(
            entries, workers, issues, "startups.csv")

    errs = [i for i in issues if i[0] == "ERROR"]
    warns = [i for i in issues if i[0] == "WARNING"]

    print(f"\n{'=' * 60}")
    print(" RESULTS")
    print(f"{'=' * 60}")

    if url_failures:
        print(f"\n  Failed URLs ({failed}):")
        for r in sorted(url_failures):
            print(r)
    if errs:
        print(f"\n  Validation Errors ({len(errs)}):")
        for _, path, n, m in errs:
            print(f"  ERROR   {path}:{n}  {m}")
    if warns:
        print(f"\n  Warnings ({len(warns)}):")
        for _, path, n, m in warns:
            print(f"  WARNING {path}:{n}  {m}")

    total = passed + failed
    rate = f"{passed / total * 100:.1f}% success" if total else "none checked"
    print(f"\n  URLs:     {passed} passed, {failed} failed ({rate})")
    if blocked:
        print(f"            {blocked} of those answered but block automated "
              f"checks (403/429/503); counted as reachable")
    print(f"  Errors:   {len(errs)}")
    print(f"  Warnings: {len(warns)}")

    if failed or errs:
        sys.exit(1)


if __name__ == "__main__":
    main()
