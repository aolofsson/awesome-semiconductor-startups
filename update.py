#1. Read startups and alumni csv into lists
#2. Read in README line by line and
#3. Insert formatted tables after reference to csv

import csv
import re
import sys
from urllib.parse import quote

STARTUP_FIELDS = ["Company", "Website", "Technology", "Country", "Founded", "Description"]
ALUMNI_FIELDS = ["Company", "Exit", "Year", "Value($M)", "Link"]
TECH_FIELDS = ["Technology", "Description"]


def read_csv(path, expected):
    """Read a CSV, checking the header row so a bad file fails with a clear message."""
    try:
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f, restval="")
            if reader.fieldnames != expected:
                sys.exit(f"Error: {path} has headers {reader.fieldnames}, expected {expected}")
            return [{k: (v or "").strip() for k, v in row.items() if k is not None}
                    for row in reader]
    except OSError as e:
        sys.exit(f"Error: cannot read {path}: {e.strerror}")
    except UnicodeDecodeError:
        sys.exit(f"Error: {path} is not valid UTF-8")


def cell(text):
    """Escape a CSV value for use inside a Markdown table cell.

    Entries arrive by pull request, so an unescaped '|' would silently break
    the table and an unescaped ']' could retarget the neighbouring link.
    """
    return (text.replace("\\", "\\\\")
                .replace("|", "\\|")
                .replace("[", "\\[")
                .replace("]", "\\]")
                .replace("\r", " ")
                .replace("\n", " ")
                .strip())


def website_url(website):
    """Build an https:// URL from the bare domain in the CSV.

    Percent-encoding keeps '(' , ')' and whitespace from breaking out of the
    Markdown link, and encoding '@' and ':' stops a value like
    "example.com@evil.com" from pointing the link somewhere else.
    """
    domain = re.sub(r"^[a-z][a-z0-9+.-]*://", "", website.strip().lower())
    domain = domain.strip("/")
    return "https://" + quote(domain, safe="/.-_~")


def source_link(link):
    """Render the alumni Link column, or 'NA' if it is not a usable http(s) URL."""
    url = link.strip()
    if not re.match(r"https?://\S+$", url, re.IGNORECASE):
        return "NA"
    # '%' stays safe so links that are already percent-encoded are not
    # double-encoded; '(' and ')' are not, so they cannot end the Markdown link.
    return f"[Source]({quote(url, safe='%:/?#@!$&*+,;=~._-')})"


def main():

    # Read in CSV files
    technologies = read_csv("technologies.csv", TECH_FIELDS)
    startups = read_csv("startups.csv", STARTUP_FIELDS)
    alumni = read_csv("alumni.csv", ALUMNI_FIELDS)

    known_tech = {t["Technology"] for t in technologies}

    # Read in README
    try:
        with open("header.md", encoding="utf-8") as f:
            header = f.read().splitlines()
    except OSError as e:
        sys.exit(f"Error: cannot read header.md: {e.strerror}")

    # Build the whole document before touching README.md, so a bad row cannot
    # leave a half-written file behind.
    out = []

    ################################
    # Printing out old README header
    ################################
    out.extend(header)

    ################################
    # Printing out technologies
    ################################
    out.append("\n| Technology| Description                                      |")
    out.append(  "|-----------|--------------------------------------------------|")
    for x in technologies:
        out.append(f"|{cell(x['Technology'])} | {cell(x['Description'])} |")

    ################################
    # Printing out all startups
    ################################
    out.append("\n## Startups")
    out.append("\n| Company | Technology | Founded | Country | Description |")
    out.append("|---------|------------|---------|---------|-------------|")
    for x in startups:
        out.append(f"|[{cell(x['Company'])}]({website_url(x['Website'])}) | "
                   f"{cell(x['Technology'])} | {cell(x['Founded'])} | "
                   f"{cell(x['Country'])} |{cell(x['Description'])} |")
        if x["Technology"] not in known_tech:
            print(f"Warning: {x['Company']} uses undefined technology {x['Technology']}. "
                   "Please spell-check or add to technologies.csv.", file=sys.stderr)

    ################################
    # Printing out exits
    ################################
    out.append("\n## Alumni")
    out.append("\n| Company |  Exit   | Year   | Value($M) | Link |")
    out.append("|---------| ------- | ------ | ------|------|")
    for x in alumni:
        out.append(f"|{cell(x['Company'])} | {cell(x['Exit'])} | {cell(x['Year'])} | "
                   f"{cell(x['Value($M)'])} | {source_link(x['Link'])} |")

    with open("README.md", "w", encoding="utf-8") as f:
        for line in out:
            print(line, file=f)


if __name__ == '__main__':
    main()
