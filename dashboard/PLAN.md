# Dashboard plan

How the dashboard was scoped: the initial request, the scoping questions
and the answers that shaped it, and the follow-up requests that changed it
afterwards. Built with Claude Code on 2026-11-03.

## Initial prompt

> ok, we are going to create a dashboard for visualizing and sorting the
> data. Ask as many scoping questions as needed to make this awesome

## Scoping questions

Each question is listed with the options offered. The chosen answer is
marked **(chosen)**.

### Round 1: platform and scope

**Where should the dashboard live and be served from?**

- GitHub Pages from the repo **(chosen)**: static files in `dashboard/`,
  served by GitHub Pages and linked from the README. Public, versioned with
  the data, no server.
- Claude artifact: a hosted page shared by link, outside the repo, so it
  is not updated by PRs.
- Local only: a file opened from a checkout.

**What stack should it use?** (The repo is Python standard library only,
with no build system and no CI.)

- Plain HTML + JS with pinned CDN libraries **(chosen)**: one page, a script
  and a stylesheet, with d3 for charts and the map, and no build step.
- Zero dependencies: vanilla JS and hand-drawn SVG only.
- Framework + build: React/Svelte with Vite and a GitHub Action to deploy.

**How should the dashboard get the data?**

- Read the CSVs directly **(chosen)**: the page fetches `startups.csv`,
  `alumni.csv` and `technologies.csv` at load time, so it always matches
  the repo and there is no generated file to keep in sync.
- `update.py` writes a `data.json` for the dashboard.

**Which views do you want?** (multiple choice)

- Searchable, sortable table **(chosen)**: text search, column sorting,
  filters by technology, country, founding year and status.
- Breakdown charts **(chosen)**: counts by technology and country,
  founding-year histogram; clicking a chart filters the table.
- World map **(chosen)**: companies per country, clickable to filter.
- Exits analytics **(chosen)**: exits by type and year, value
  distribution, top acquirers, time from founding to exit.

### Round 2: data gaps, look and extras

Finding that prompted the first question: `alumni.csv` had no Technology,
Country or Founded columns, so exits could not be broken down by
technology or country, and time to exit could not be measured.

**How should the missing alumni data be handled?**

- Add columns to `alumni.csv` **(chosen)**: extend it with the startup
  columns, update the scripts, and backfill every row, human-verified.
- A separate `alumni_meta.csv` keyed by company.
- Exit-only analytics for now.

**What look should it have?**

- Follow the system light/dark theme **(chosen)**, with a manual toggle.
- Dark, technical.
- Light, report-like.

**What should happen to the hand-made static plots in the README?**
(`plot_age.svg`, `plot_type.svg`, `pie_country.png`, last made 02/2025)

- Replace them with a dashboard link **(chosen)**.
- Keep them as they are.
- Have `update.py` generate fresh SVGs too.

**Which extras do you want?** (multiple choice)

- Shareable URLs **(chosen)**: filters, sort and search kept in the URL.
- Export the filtered rows as CSV **(chosen)**.
- Company detail panel **(chosen)**: all fields, links, and the exit.
- Summary key-figures strip **(chosen)**: totals for the current filters.

### Round 3: alumni schema and backfill

**Which columns should `alumni.csv` get, and in what order?**

- Full startup columns plus the exit columns **(chosen)**:
  `Company,Website,Technology,Country,Founded,Description,Exit,Year,Value($M),Link`,
  so moving a startup to alumni means appending the exit fields.
- Only the fields needed for analysis.
- Append the new columns at the end.

**Should the README's Alumni table show the new columns?**

- Add Technology and Country **(chosen)**.
- Keep the README table unchanged.
- Show all columns.

**How should the alumni rows be backfilled?**

- Git history first, then review **(chosen)**: recover each company's last
  `startups.csv` row from history, research only the rest, and produce a
  review list marking where every value came from.
- Research every row from scratch.
- Fill from history only and leave the rest as `NA`.

## Backfill outcome

- 51 of 117 alumni rows came from git history.
- 66 were researched. A Founded or Country value was kept only when the
  cited page, fetched independently, contained the quoted statement.
- SEC Form D filings supplied Tensil.ai, Lucata (as EMU Solutions),
  Genapsys and Axis Semiconductor.
- Some values are from private communication, confirmed by the
  maintainer: Axis Semiconductor 2007, Oculii 2014.
- The maintainer corrected Technology for 17 rows: RFIC folded into RF,
  and Alphawave kept as NETWORKING.
- Founded is still `NA` for Advanced Circuit Pursuit, Agnilux, Kameleon
  and Maxeda.

## Design decisions

These were made during the build rather than asked about:

- **Wafer map:** the central visual. Every company is one die on a round
  wafer, laid out in bands by technology with outlined region boundaries.
  Dies are coloured by status, and dies outside the current filters go
  dark.
- **Colours:** status uses blue/orange/aqua (active/exited/unverified)
  and exit type uses violet/magenta/green/red
  (acquired/IPO/SPAC/shutdown). Both palettes were checked for
  colour-vision deficiency in light and dark mode.
- **Type:** Archivo, with condensed headings in the style of a datasheet.
- **Cross-filtering:** each chart ignores its own filter, so it still
  shows the choices it is filtering between.
- **Untrusted data:** CSV text goes into the page as text only. Links are
  built only from validated domains or http(s) URLs. The CSV export
  defuses spreadsheet formulas.
- **Old domains:** websites of exited and unverified companies are shown
  as text, not links, because lapsed domains are often re-registered by
  someone else.
- **Small countries:** Singapore, Hong Kong and Malta are too small for
  the 1:110m map and are drawn as points.

## Follow-up requests

- **Publishing:** GitHub Pages serves from `main` / root with no workflow
  file. The dashboard is at
  <https://aolofsson.github.io/awesome-semiconductor-startups/dashboard/>.
- **Country chart:** "can the country be made a bar chart like technology
  with a scrollbar so that it doesn't go too deep down the page". The list
  beside the map became stacked status bars in a scrolling box.
- **README collage:** "generate a collage of all the graphics save as a
  picture that goes above the citation section", which "should be
  clickable", with the dashboard description placed under the picture.
  This produced `dashboard/preview.png`, regenerated by
  `dashboard/preview/make.sh`.
- **Order:** "can you reorder the dashboard to start with the Companies".
  The table moved to the top, under the filters; it scrolls inside a box
  at most 72% of the window tall, so the charts follow one screen down.
