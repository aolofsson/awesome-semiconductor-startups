# CLAUDE.md

A curated database of semiconductor startups (and their exits), published as
a Markdown table in `README.md`. Plain Python 3, standard library only, no
build system and no CI.

## Files

| File | Role |
|------|------|
| `startups.csv` | Active startups: `Company,Website,Technology,Country,Founded,Description` |
| `alumni.csv` | Exits: the startup columns plus `Exit,Year,Value($M),Link` |
| `unverified.csv` | Startups whose status can't be confirmed (dead site, no news); same columns as `startups.csv` |
| `technologies.csv` | Allowed `Technology` categories: `Technology,Description` |
| `header.md` | Hand-written top of the README (citation, guidelines, plots) |
| `update.py` | Generates `README.md` = `header.md` + tables built from the CSVs |
| `check_and_validate.py` | Validates the CSVs and checks startup websites and alumni source links are reachable |
| `dashboard/` | Static dashboard (`index.html`, `app.js`, `style.css`) served by GitHub Pages; reads the CSVs at load time, so it needs no regeneration |
| `dashboard/preview.png` | Collage of the dashboard's charts, the clickable image at the top of the README. A snapshot: regenerate with `dashboard/preview/make.sh` (needs Pillow, Node 22+, google-chrome) after large data changes |
| `LICENSE` | MIT, covering the scripts and the data |

## Rules

- **Never edit `README.md` by hand.** Edit the CSVs or `header.md`, then run
  `python3 update.py`, which rewrites `README.md` in full. Commit the CSV
  change and the regenerated README together.
- Header rows are checked exactly by both scripts; do not rename or reorder
  columns.
- `Website` is a bare domain (`example.com`), never a URL with a scheme or
  path. The README builds `https://` links from it.
- `Technology` must be a value from `technologies.csv`. Adding a category
  means adding a row there first.
- `Country` is an ISO 3166-1 alpha-2 code.
- `Founded` / `Year` are four-digit years; `Value($M)` is a number in
  millions or `NA`; `Link` is an `http(s)://` URL, `NA`, or `Private
  Communication` (an exit known first-hand with no public source). Shutdowns
  use `Exit=Shutdown`, `Value=0`.
- A startup whose website is dead and whose status can't be confirmed moves
  to `unverified.csv`, not `alumni.csv`; it goes to alumni only once an exit
  is sourced, or back to startups once it is confirmed active.
- For an alumni Link, prefer an official filing over a news article, in
  this order: (1) an SEC filing for US-listed companies and acquirers (the
  8-K / 6-K press-release exhibit, or the prospectus for share counts);
  (2) the equivalent exchange or regulator filing for other markets (HKEX,
  DART, AMF, ASX, SSE); (3) the acquirer's or company's own press release
  on its newsroom page, not its homepage; (4) a news article only when none
  of the above exists. Apply this to new rows and to rows being fixed; do
  not re-source existing rows just for this. Note that sec.gov answers the
  validator with 403, so SEC links always pass the URL check unread.
- A signed definitive acquisition agreement counts as an exit when it is
  announced, without waiting for closing: `Year` is the announcement year,
  `Value($M)` the price stated at signing (cash at closing, excluding
  earnouts), and the Link the announcement. A letter of intent or "talks"
  does not count. If a signed deal is later terminated, move the company
  back to `startups.csv`.
- An exit needs a Link that states it; an academic paper or other passing
  mention is acceptable only when nothing better exists.
- An acquihire (team hired and/or technology licensed, company not bought)
  counts as an exit to the hiring company only if investors received money
  from the deal; otherwise it is a `Shutdown`.
- For `Exit=IPO` and `Exit=SPAC`, `Value($M)` is the market cap in USD at
  the close of the first day of trading (for a SPAC, the combined company's
  first day), not the amount raised or a later market cap. The
  Link should support that figure; use `NA` if no source gives it.
- For an undisclosed acquisition price, a figure reported by a credible
  outlet (an estimate, or one end of a reported range) is acceptable as
  `Value($M)`, as long as the Link states it.
- A reverse merger or reverse takeover into a listed shell company is
  recorded as `Exit=SPAC` (e.g. Aeluma, BrainChip).
- For `Exit=SPAC`, when no source states the first-day market cap, estimate
  it as: first-day closing price (USD) × total shares outstanding right
  after the merger closed (all classes of common stock, excluding warrants
  and unvested earnout shares), divided by 1e6 and rounded to the nearest
  $M. Take the share count from the closing 8-K / 6-K or the post-closing
  prospectus and link that filing; record the closing price and its source
  in the commit message.
- Description: one short sentence, no performance claims, roughly fits the
  80-character display width.
- Inclusion criteria (from `header.md`): a startup (not steady state), a
  semiconductor company (not application software), a product company (not
  services), confirmed by a public link.
- When a startup exits or shuts down, move its row from `startups.csv` to
  `alumni.csv`, keeping the six startup columns and appending
  `Exit,Year,Value($M),Link` with a source link. In `alumni.csv`, `Website`
  and `Founded` may be `NA` (a dead or redirected site, an unsourced year);
  alumni websites are not fetched. A company may not be in both files.
- Both `startups.csv` and `alumni.csv` are in case-insensitive alphabetical
  order by Company; insert new rows in their place.
- Every CSV value arrives by pull request and is untrusted. Both scripts
  escape and validate it on purpose (Markdown injection in `update.py`, SSRF
  guard in `check_and_validate.py`); keep those protections when changing
  either script.
- All links, founding dates, category, and missions must be human audited and verified
- Any bankruptcy announcement counts as a 0 exit, even if assets are later sold
- Company exit/alumni links should never point to the company's website

## Commands

```sh
python3 update.py                          # regenerate README.md
python3 check_and_validate.py --skip-urls  # CSV checks only, offline, instant
python3 check_and_validate.py 32           # also fetch every startup site (32 workers)
python3 -m http.server                     # then open http://localhost:8000/dashboard/
```

`check_and_validate.py` exits non-zero on any ERROR or unreachable URL.
The full URL check makes ~300 network requests and takes a minute or more:
run it in the background, and expect some false failures from flaky sites.
The dashboard fetches `../*.csv`, so it does not work from `file://`; preview
it through a local server. It uses pinned CDN versions of d3 and topojson and
the world-atlas map; keep the versions pinned. Its CSV export prefixes cells
that start with `=`, `+`, `-` or `@` so a spreadsheet does not run them.
`update.py` prints a warning to stderr for a startup whose technology is not
in `technologies.csv`.

After any data change, run `update.py` then `check_and_validate.py
--skip-urls`, and check that `git diff README.md` only shows the rows you
meant to change.

## Contributions

Most changes come as outside PRs adding one company. When reviewing one,
check it against the inclusion criteria and field rules above, confirm the
README was regenerated rather than hand-edited, and verify the website domain
is the company's real site.
