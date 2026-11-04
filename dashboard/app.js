// Semiconductor startups dashboard.
//
// Reads the repository's CSV files at load time, so the page always shows
// what is committed. Every CSV value arrives by pull request and is treated
// as untrusted: text goes into the DOM through textContent (d3's .text()),
// links are only built from validated domains or http(s) URLs, and the CSV
// export neutralises spreadsheet formulas.

"use strict";

(() => {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const DATA_ROOT = "../";

  // Status and exit-type colours are CSS roles (style.css), so a theme switch
  // recolours every chart without a re-render. Both palettes were checked for
  // colour-vision deficiency in light and dark mode.
  const STATUSES = [
    { key: "Active", color: "var(--active)" },
    { key: "Exited", color: "var(--exited)" },
    { key: "Unverified", color: "var(--unverified)" },
  ];
  const STATUS_COLOR = Object.fromEntries(STATUSES.map(s => [s.key, s.color]));

  const EXIT_TYPES = [
    { key: "Acquired", color: "var(--x-acquired)" },
    { key: "IPO", color: "var(--x-ipo)" },
    { key: "SPAC", color: "var(--x-spac)" },
    { key: "Shutdown", color: "var(--x-shutdown)" },
    { key: "Unknown", color: "var(--x-unknown)" },
  ];
  const EXIT_COLOR = Object.fromEntries(EXIT_TYPES.map(s => [s.key, s.color]));

  // ISO 3166-1 alpha-2 -> numeric, which world-atlas uses as feature ids.
  // Checked against world-atlas@2.0.2 country names.
  const ISO_NUM = {
    US: 840, GB: 826, IL: 376, DE: 276, FR: 250, CA: 124, KR: 410, NL: 528,
    IN: 356, CH: 756, NO: 578, ES: 724, DK: 208, BE: 56, SG: 702, PL: 616,
    IT: 380, IE: 372, FI: 246, CN: 156, AU: 36, RO: 642, PT: 620, AT: 40,
    JP: 392, SE: 752, TW: 158, HK: 344, IS: 352, EE: 233, CZ: 203, HU: 348,
    GR: 300, TR: 792, AE: 784, SA: 682, BR: 76, MX: 484, NZ: 554, ZA: 710,
    UA: 804, LT: 440, LV: 428, SI: 705, SK: 703, BG: 100, HR: 191, RS: 688,
    LU: 442, MY: 458, TH: 764, VN: 704, ID: 360, PH: 608, AR: 32, CL: 152,
    EG: 818, NG: 566, KE: 404, PK: 586, BD: 50, RU: 643, BY: 112, IR: 364,
    QA: 634, JO: 400, CY: 196, MT: 470,
  };
  // Too small for the 1:110m map; drawn as points instead. [lon, lat]
  const SMALL_COUNTRIES = { SG: [103.82, 1.35], HK: [114.17, 22.32], MT: [14.44, 35.9] };
  const NUM_TO_ISO = Object.fromEntries(Object.entries(ISO_NUM).map(([a, n]) => [n, a]));

  const WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json";

  const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

  const regionName = (() => {
    try {
      const dn = new Intl.DisplayNames(["en"], { type: "region" });
      return code => {
        if (!code) return "Unknown";
        try { return dn.of(code) || code; } catch (e) { return code; }
      };
    } catch (e) {
      return code => code || "Unknown";
    }
  })();

  const fmtInt = d3.format(",");
  const fmtMoney = v => v >= 1000 ? `$${d3.format(",.1f")(v / 1000)}B` : `$${fmtInt(Math.round(v))}M`;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let companies = [];
  let techInfo = new Map();     // Technology -> description
  let techOrder = [];           // fixed order, by total count across all data
  let world = null;             // topojson features, or null if it failed
  let investors = new Map();    // investor name -> { name, website, companies: [] }
  let investorsLoaded = false;  // investors.csv is optional; the page works without it

  const state = {
    q: "",
    status: new Set(STATUSES.map(s => s.key)),
    tech: new Set(),
    country: new Set(),
    from: null,
    to: null,
    sort: "name",
    dir: 1,
    open: null,
    investor: new Set(),
    invSort: "count",
    invDir: -1,
    netAll: false,
  };
  let hoverTech = null;

  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------------------
  // Loading and normalising
  // ---------------------------------------------------------------------------

  async function fetchText(name) {
    const r = await fetch(DATA_ROOT + name, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.text();
  }

  function clean(v) { return (v == null ? "" : String(v)).trim(); }
  function year(v) { return /^\d{4}$/.test(v) ? +v : null; }

  function normalise(row, status, id) {
    const g = k => clean(row[k]);
    const website = g("Website").toLowerCase().replace(/\/+$/, "");
    const country = /^[A-Z]{2}$/.test(g("Country")) ? g("Country") : "";
    const c = {
      id,
      name: g("Company"),
      website: DOMAIN_RE.test(website) ? website : null,
      tech: g("Technology") || "Unknown",
      country,
      founded: year(g("Founded")),
      desc: g("Description"),
      status,
      exit: null,
      exitType: null,
      acquirer: null,
      exitYear: null,
      value: null,
      link: null,
      linkText: null,
      investors: [],
    };
    if (status === "Exited") {
      const e = g("Exit");
      if (["IPO", "SPAC", "Shutdown"].includes(e)) c.exitType = e;
      else if (!e || e === "NA") c.exitType = "Unknown";
      else { c.exitType = "Acquired"; c.acquirer = e; }
      c.exit = e && e !== "NA" ? e : "Unknown";
      c.exitYear = year(g("Year"));
      const v = g("Value($M)");
      c.value = /^\d+(\.\d+)?$/.test(v) ? +v : null;
      const link = g("Link");
      if (/^https?:\/\/\S+$/i.test(link)) c.link = link;
      else if (link && link !== "NA") c.linkText = link;
    }
    setSearch(c);
    return c;
  }

  function setSearch(c) {
    c.search = [c.name, c.desc, c.tech, c.acquirer || "", regionName(c.country), c.website || "",
      ...c.investors.map(i => i.name)].join(" ").toLowerCase();
  }

  // investors.csv: Company,Investor,Website. Website is a bare domain, or NA
  // for a private individual. Rows naming an unknown company are skipped.
  function attachInvestors(text) {
    const byName = new Map(companies.map(c => [c.name, c]));
    investors = new Map();
    for (const r of d3.csvParse(text)) {
      const c = byName.get(clean(r.Company)), name = clean(r.Investor);
      if (!c || !name) continue;
      const w = clean(r.Website).toLowerCase();
      let inv = investors.get(name);
      if (!inv) {
        inv = { name, website: DOMAIN_RE.test(w) ? w : null, person: w === "na", companies: [] };
        investors.set(name, inv);
      }
      if (inv.companies.includes(c)) continue;
      inv.companies.push(c);
      c.investors.push(inv);
    }
    for (const c of companies) {
      c.investors.sort((a, b) => a.name.localeCompare(b.name));
      setSearch(c);
    }
    investorsLoaded = true;
  }

  async function load() {
    const [s, a, u, t] = await Promise.all(
      ["startups.csv", "alumni.csv", "unverified.csv", "technologies.csv"].map(fetchText));
    let id = 0;
    const rows = [];
    for (const r of d3.csvParse(s)) if (clean(r.Company)) rows.push(normalise(r, "Active", id++));
    for (const r of d3.csvParse(a)) if (clean(r.Company)) rows.push(normalise(r, "Exited", id++));
    for (const r of d3.csvParse(u)) if (clean(r.Company)) rows.push(normalise(r, "Unverified", id++));
    companies = rows;
    techInfo = new Map(d3.csvParse(t).map(r => [clean(r.Technology), clean(r.Description)]));
    try {
      attachInvestors(await fetchText("investors.csv"));
    } catch (e) {
      investorsLoaded = false;
    }
    const counts = d3.rollup(companies, v => v.length, c => c.tech);
    techOrder = [...new Set([...techInfo.keys(), ...counts.keys()])]
      .filter(k => counts.get(k))
      .sort((x, y) => (x === "Unknown") - (y === "Unknown") || counts.get(y) - counts.get(x) || x.localeCompare(y));
  }

  async function loadWorld() {
    try {
      const r = await fetch(WORLD_URL);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const topo = await r.json();
      world = topojson.feature(topo, topo.objects.countries).features;
    } catch (e) {
      world = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Filtering and URL state
  // ---------------------------------------------------------------------------

  // `except` names one dimension to ignore, so a chart that sets a filter can
  // still show the choices it is filtering between.
  function matches(c, except) {
    if (state.q && !c.search.includes(state.q.toLowerCase())) return false;
    if (except !== "status" && !state.status.has(c.status)) return false;
    if (except !== "tech" && state.tech.size && !state.tech.has(c.tech)) return false;
    if (except !== "country" && state.country.size && !state.country.has(c.country)) return false;
    if (except !== "investor" && state.investor.size && !c.investors.some(i => state.investor.has(i.name))) return false;
    if (except !== "founded" && (state.from != null || state.to != null)) {
      if (c.founded == null) return false;
      if (state.from != null && c.founded < state.from) return false;
      if (state.to != null && c.founded > state.to) return false;
    }
    return true;
  }

  function readURL() {
    const p = new URLSearchParams(location.search);
    const list = k => (p.get(k) || "").split(",").map(clean).filter(Boolean);
    state.q = clean(p.get("q"));
    const st = list("status").filter(s => STATUS_COLOR[s]);
    if (st.length) state.status = new Set(st);
    state.tech = new Set(list("tech"));
    state.country = new Set(list("country").map(s => s.toUpperCase()));
    state.from = year(clean(p.get("from")));
    state.to = year(clean(p.get("to")));
    const sort = clean(p.get("sort"));
    if (sort) {
      state.dir = sort.startsWith("-") ? -1 : 1;
      const key = sort.replace(/^-/, "");
      if (COLUMNS.some(col => col.key === key)) state.sort = key;
    }
    state.open = clean(p.get("company")) || null;
    // Investor names can contain commas, so each one is its own parameter.
    state.investor = new Set(p.getAll("investor").map(clean).filter(n => investors.has(n)));
    state.netAll = p.get("net") === "all";
  }

  function writeURL() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.status.size !== STATUSES.length) p.set("status", [...state.status].join(","));
    if (state.tech.size) p.set("tech", [...state.tech].join(","));
    if (state.country.size) p.set("country", [...state.country].join(","));
    if (state.from != null) p.set("from", state.from);
    if (state.to != null) p.set("to", state.to);
    if (state.sort !== "name" || state.dir !== 1) p.set("sort", (state.dir < 0 ? "-" : "") + state.sort);
    if (state.open) p.set("company", state.open);
    for (const n of state.investor) p.append("investor", n);
    if (state.netAll) p.set("net", "all");
    const qs = p.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }

  function toggle(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }

  function update() {
    writeURL();
    render();
  }

  // ---------------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------------

  const tip = $("tooltip");

  // rows: [{ value, label, color }]
  function showTip(evt, title, sub, rows = []) {
    tip.replaceChildren();
    const t = document.createElement("strong");
    t.textContent = title;
    tip.append(t);
    if (sub) {
      const s = document.createElement("div");
      s.className = "sub";
      s.textContent = sub;
      tip.append(s);
    }
    for (const r of rows) {
      const line = document.createElement("div");
      if (r.color) {
        const k = document.createElement("span");
        k.className = "key";
        k.style.background = r.color;
        line.append(k);
      }
      const b = document.createElement("b");
      b.textContent = r.value;
      line.append(b, ` ${r.label}`);
      tip.append(line);
    }
    tip.hidden = false;
    let x, y;
    if (evt.clientX != null && evt.type !== "focus") { x = evt.clientX; y = evt.clientY; }
    else {
      const b = evt.target.getBoundingClientRect();
      x = b.left + b.width / 2; y = b.top;
    }
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > innerWidth - 8) left = x - w - 14;
    if (top + h > innerHeight - 8) top = y - h - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }
  function hideTip() { tip.hidden = true; }

  function companyTip(evt, c) {
    const bits = [c.tech, regionName(c.country), c.founded ? `founded ${c.founded}` : null].filter(Boolean);
    const rows = [{ value: c.status, label: "", color: STATUS_COLOR[c.status] }];
    if (c.status === "Exited") {
      const what = c.exitType === "Acquired" ? `acquired by ${c.acquirer}` : c.exitType;
      rows.push({ value: what, label: c.exitYear ? `in ${c.exitYear}` : "", color: EXIT_COLOR[c.exitType] });
      if (c.value) rows.push({ value: fmtMoney(c.value), label: "value" });
    }
    showTip(evt, c.name, bits.join(", "), rows);
  }

  // ---------------------------------------------------------------------------
  // Shared chart helpers
  // ---------------------------------------------------------------------------

  function width(el) { return Math.max(280, el.clientWidth || 600); }

  function svgIn(el, w, h, label) {
    el.replaceChildren();
    return d3.select(el).append("svg")
      .attr("viewBox", `0 0 ${w} ${h}`)
      .attr("width", w)
      .attr("role", "img")
      .attr("aria-label", label);
  }

  function emptyChart(el, text) {
    el.replaceChildren();
    const p = document.createElement("p");
    p.className = "empty-chart";
    p.textContent = text;
    el.append(p);
  }

  // Horizontal stacked bars. rows: [{ key, label, segs: [{ key, value, color }], selected }]
  function hbars(el, rows, opts) {
    const W = width(el), rowH = 26, labelW = opts.labelW || 96, valueW = 40;
    const H = rows.length * rowH + 4;
    const svg = svgIn(el, W, H, opts.label);
    const max = d3.max(rows, r => d3.sum(r.segs, s => s.value)) || 1;
    const x = d3.scaleLinear().domain([0, max]).range([0, W - labelW - valueW]);
    const anySel = rows.some(r => r.selected);
    const g = svg.selectAll("g.bar-row").data(rows).join("g")
      .attr("class", r => `bar-row${anySel ? (r.selected ? " selected" : " unselected") : ""}`)
      .attr("transform", (r, i) => `translate(0,${i * rowH})`)
      .attr("tabindex", opts.onClick ? 0 : null)
      .attr("role", opts.onClick ? "button" : null)
      .attr("aria-pressed", opts.onClick ? r => String(!!r.selected) : null)
      .attr("aria-label", r => `${r.label}: ${d3.sum(r.segs, s => s.value)}`);
    g.append("rect").attr("class", "bar-hit").attr("width", W).attr("height", rowH).attr("rx", 3);
    g.append("text").attr("class", "label").attr("x", 4).attr("y", rowH / 2).attr("dy", "0.35em")
      .text(r => r.label);
    g.each(function (r) {
      let x0 = labelW;
      const sel = d3.select(this);
      for (const s of r.segs) {
        if (!s.value) continue;
        const w = x(s.value);
        // A 2px surface gap between segments keeps adjacent colours apart.
        sel.append("rect").attr("class", "seg")
          .attr("x", x0).attr("y", 5).attr("height", rowH - 10)
          .attr("width", Math.max(1, w - 2)).attr("rx", 2)
          .style("fill", s.color);
        x0 += w;
      }
      sel.append("text").attr("class", "value").attr("x", x0 + 4).attr("y", rowH / 2).attr("dy", "0.35em")
        .text(fmtInt(d3.sum(r.segs, s => s.value)));
    });
    if (opts.onClick) {
      g.on("click", (e, r) => opts.onClick(r))
        .on("keydown", (e, r) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); opts.onClick(r); } });
    }
    g.on("pointermove focus", (e, r) => opts.tip(e, r))
      .on("pointerleave blur", () => { hideTip(); if (opts.onLeave) opts.onLeave(); });
    if (opts.onHover) g.on("pointerenter.h focus.h", (e, r) => opts.onHover(r));
  }

  // Vertical stacked columns over a run of years.
  // byYear: Map(year -> [{ key, value, color }])
  function columns(el, years, byYear, opts) {
    const W = width(el), H = opts.height || 220;
    const m = { top: 10, right: 8, bottom: 26, left: 32 };
    const svg = svgIn(el, W, H, opts.label);
    const x = d3.scaleBand().domain(years).range([m.left, W - m.right]).paddingInner(0.12);
    const max = d3.max(years, y => d3.sum(byYear.get(y) || [], s => s.value)) || 1;
    const y = d3.scaleLinear().domain([0, max]).nice().range([H - m.bottom, m.top]);
    svg.append("g").attr("class", "grid").attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.left - m.right)).tickFormat(""));
    svg.append("g").attr("class", "axis").attr("transform", `translate(${m.left},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(6)).select(".domain").remove();
    const step = Math.max(1, Math.ceil(years.length / Math.floor((W - m.left) / 44)));
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.bottom})`)
      .call(d3.axisBottom(x).tickValues(years.filter((v, i) => v % step === 0 || (step > 1 && false))).tickSize(0).tickPadding(8));
    const inRange = opts.inRange || (() => true);
    const g = svg.append("g").selectAll("g").data(years).join("g")
      .attr("opacity", yr => inRange(yr) ? 1 : 0.3);
    g.each(function (yr) {
      let y0 = y(0);
      const sel = d3.select(this);
      for (const s of byYear.get(yr) || []) {
        if (!s.value) continue;
        const h = y(0) - y(s.value);
        sel.append("rect").attr("x", x(yr)).attr("width", x.bandwidth())
          .attr("y", y0 - h + 1).attr("height", Math.max(1, h - 2)).attr("rx", Math.min(2, x.bandwidth() / 4))
          .style("fill", s.color);
        y0 -= h;
      }
    });
    // Hit targets span the full column height, so short columns are easy to hover.
    svg.append("g").selectAll("rect").data(years).join("rect")
      .attr("x", yr => x(yr) - x.step() * x.paddingInner() / 2).attr("width", x.step())
      .attr("y", m.top).attr("height", H - m.top - m.bottom)
      .attr("fill", "transparent")
      .on("pointermove", (e, yr) => {
        const segs = (byYear.get(yr) || []).filter(s => s.value);
        showTip(e, String(yr), `${fmtInt(d3.sum(segs, s => s.value))} total`,
          segs.map(s => ({ value: fmtInt(s.value), label: s.key, color: s.color })));
      })
      .on("pointerleave", hideTip);
    return { svg, x, m, W, H };
  }

  function legend(el, items) {
    el.replaceChildren();
    for (const it of items) {
      const s = document.createElement("span");
      const sw = document.createElement("i");
      sw.className = "swatch";
      sw.style.setProperty("--sw", it.color);
      s.append(sw, it.label);
      el.append(s);
    }
  }

  // ---------------------------------------------------------------------------
  // Key figures, filter controls, chips
  // ---------------------------------------------------------------------------

  function renderFigures(list) {
    const ex = list.filter(c => c.status === "Exited");
    const val = d3.sum(ex, c => c.value || 0);
    const founded = list.map(c => c.founded).filter(v => v != null);
    const figs = [
      [fmtInt(list.length), "companies"],
      [fmtInt(list.filter(c => c.status === "Active").length), "active"],
      [fmtInt(ex.length), "exits"],
      [val ? fmtMoney(val) : "–", "disclosed exit value"],
      [fmtInt(new Set(list.map(c => c.country).filter(Boolean)).size), "countries"],
      [founded.length ? String(Math.round(d3.median(founded))) : "–", "median year founded"],
    ];
    const el = $("figures");
    el.replaceChildren();
    for (const [v, l] of figs) {
      const d = document.createElement("div");
      d.className = "figure";
      const b = document.createElement("b");
      b.textContent = v;
      const s = document.createElement("span");
      s.textContent = l;
      d.append(b, s);
      el.append(d);
    }
  }

  function buildControls() {
    const fs = $("status-toggle");
    for (const s of STATUSES) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = s.key;
      input.addEventListener("change", () => {
        if (input.checked) state.status.add(s.key); else state.status.delete(s.key);
        update();
      });
      const sw = document.createElement("i");
      sw.className = "swatch";
      sw.style.setProperty("--sw", s.color);
      const text = document.createElement("span");
      label.append(input, sw, text);
      fs.append(label);
    }

    const techSel = $("tech-select");
    for (const t of [...techOrder].sort()) techSel.append(new Option(t, t));
    techSel.addEventListener("change", () => {
      if (techSel.value) state.tech.add(techSel.value);
      techSel.value = "";
      update();
    });

    const countrySel = $("country-select");
    const codes = [...new Set(companies.map(c => c.country).filter(Boolean))]
      .sort((a, b) => regionName(a).localeCompare(regionName(b)));
    for (const c of codes) countrySel.append(new Option(regionName(c), c));
    countrySel.addEventListener("change", () => {
      if (countrySel.value) state.country.add(countrySel.value);
      countrySel.value = "";
      update();
    });

    const q = $("q");
    let timer = null;
    q.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = clean(q.value); update(); }, 120);
    });

    for (const k of ["from", "to"]) {
      $(k).addEventListener("change", () => {
        state[k] = year(clean($(k).value));
        update();
      });
    }

    $("filters").addEventListener("submit", e => e.preventDefault());
    $("reset").addEventListener("click", () => {
      state.q = "";
      state.status = new Set(STATUSES.map(s => s.key));
      state.tech.clear();
      state.country.clear();
      state.investor.clear();
      state.from = state.to = null;
      update();
    });
    $("share").addEventListener("click", async () => {
      const btn = $("share");
      try {
        await navigator.clipboard.writeText(location.href);
        btn.textContent = "Link copied";
      } catch (e) {
        window.prompt("Copy this link:", location.href);
      }
      setTimeout(() => { btn.textContent = "Copy link"; }, 1800);
    });
    $("export").addEventListener("click", exportCSV);
  }

  function syncControls() {
    $("q").value = state.q;
    $("from").value = state.from ?? "";
    $("to").value = state.to ?? "";
    const counts = d3.rollup(companies.filter(c => matches(c, "status")), v => v.length, c => c.status);
    for (const label of $("status-toggle").querySelectorAll("label")) {
      const input = label.querySelector("input");
      input.checked = state.status.has(input.value);
      label.querySelector("span").textContent = `${input.value} ${fmtInt(counts.get(input.value) || 0)}`;
    }
  }

  function renderChips() {
    const el = $("chips");
    el.replaceChildren();
    const chip = (text, remove) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = text;
      b.setAttribute("aria-label", `Remove filter: ${text}`);
      b.addEventListener("click", () => { remove(); update(); });
      el.append(b);
    };
    if (state.q) chip(`“${state.q}”`, () => { state.q = ""; });
    if (state.status.size !== STATUSES.length) {
      chip(`Status: ${[...state.status].join(", ") || "none"}`,
        () => { state.status = new Set(STATUSES.map(s => s.key)); });
    }
    for (const t of state.tech) chip(t, () => state.tech.delete(t));
    for (const c of state.country) chip(regionName(c), () => state.country.delete(c));
    for (const n of state.investor) chip(`Investor: ${n}`, () => state.investor.delete(n));
    if (state.from != null || state.to != null) {
      chip(`Founded ${state.from ?? "…"}–${state.to ?? "…"}`, () => { state.from = state.to = null; });
    }
  }

  // ---------------------------------------------------------------------------
  // Wafer
  // ---------------------------------------------------------------------------

  let waferDies = null;

  // Lay the companies out as dies on a round wafer: a grid of cells, of which
  // those wholly inside the usable radius hold one company each, filled row
  // by row in technology order. Partial cells at the rim are drawn faintly,
  // as on a real wafer map.
  function layoutWafer() {
    const order = [...companies].sort((a, b) =>
      techOrder.indexOf(a.tech) - techOrder.indexOf(b.tech) ||
      STATUSES.findIndex(s => s.key === a.status) - STATUSES.findIndex(s => s.key === b.status) ||
      a.name.localeCompare(b.name));
    const dw = 10, dh = 8;
    let n = 12, cells;
    for (;;) {
      const D = n * dw, R = D / 2, usable = R - dw * 0.35;
      const rows = Math.ceil(D / dh), cols = n;
      cells = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = c * dw - R, y = r * dh - (rows * dh) / 2;
          const corners = [[x, y], [x + dw, y], [x, y + dh], [x + dw, y + dh]];
          const inside = corners.filter(([px, py]) => Math.hypot(px, py) <= usable).length;
          const touches = corners.some(([px, py]) => Math.hypot(px, py) <= R);
          if (inside === 4) cells.push({ x, y, kind: "full" });
          else if (touches) cells.push({ x, y, kind: "edge" });
        }
      }
      if (cells.filter(c => c.kind === "full").length >= order.length) {
        waferDies = { R, dw, dh, cells };
        break;
      }
      n += 1;
    }
    let i = 0;
    for (const cell of waferDies.cells) {
      if (cell.kind === "full") {
        cell.company = order[i] || null;
        if (!cell.company) cell.kind = "blank";
        i += 1;
      }
    }
  }

  function renderWafer() {
    const svgEl = $("wafer");
    const { R, dw, dh, cells } = waferDies;
    const pad = 6;
    const svg = d3.select(svgEl);
    if (!svgEl.dataset.built) {
      svgEl.dataset.built = "1";
      svg.attr("viewBox", `${-R - pad} ${-R - pad} ${2 * (R + pad)} ${2 * (R + pad)}`);
      const id = "wafer-clip";
      svg.append("clipPath").attr("id", id).append("circle").attr("r", R);
      svg.append("circle").attr("class", "disc").attr("r", R);
      const g = svg.append("g").attr("clip-path", `url(#${id})`);
      g.selectAll("rect").data(cells).join("rect")
        .attr("class", d => `die ${d.kind === "full" ? "hit" : d.kind}`)
        .attr("x", d => d.x + 0.5).attr("y", d => d.y + 0.5)
        .attr("width", dw - 1).attr("height", dh - 1).attr("rx", 0.8)
        .style("fill", d => d.company ? STATUS_COLOR[d.company.status] : null)
        .filter(d => d.company)
        .on("pointermove", (e, d) => companyTip(e, d.company))
        .on("pointerleave", hideTip)
        .on("click", (e, d) => openDrawer(d.company));
      // Outline each technology's region, like reticle boundaries, so the
      // bands read even though the dies are coloured by status.
      const at = new Map(cells.filter(d => d.company).map(d => [`${d.x},${d.y}`, d]));
      const seams = [];
      for (const d of at.values()) {
        const right = at.get(`${d.x + dw},${d.y}`), below = at.get(`${d.x},${d.y + dh}`);
        if (right && right.company.tech !== d.company.tech) seams.push([d.x + dw, d.y, d.x + dw, d.y + dh]);
        if (below && below.company.tech !== d.company.tech) seams.push([d.x, d.y + dh, d.x + dw, d.y + dh]);
      }
      g.append("g").attr("class", "seams").selectAll("line").data(seams).join("line")
        .attr("x1", s => s[0]).attr("y1", s => s[1]).attr("x2", s => s[2]).attr("y2", s => s[3]);
      // Orientation notch at the bottom, as on a 300 mm wafer.
      svg.append("circle").attr("cx", 0).attr("cy", R).attr("r", dw * 0.6)
        .style("fill", "var(--page)");
    }
    const n = companies.filter(c => matches(c)).length;
    svg.attr("aria-label", `Wafer map of ${companies.length} companies, ${n} matching the filters. The table below lists them.`);
    svg.selectAll("rect.hit")
      .classed("off", d => !matches(d.company))
      .classed("dim", d => hoverTech != null && d.company.tech !== hoverTech)
      .classed("selected", d => state.open === d.company.name);
  }

  // ---------------------------------------------------------------------------
  // Technology
  // ---------------------------------------------------------------------------

  function renderTech() {
    const pool = companies.filter(c => matches(c, "tech"));
    const by = d3.rollup(pool, v => d3.rollup(v, w => w.length, c => c.status), c => c.tech);
    const rows = techOrder.map(t => ({
      key: t,
      label: t,
      selected: state.tech.has(t),
      segs: STATUSES.map(s => ({ key: s.key, value: (by.get(t) || new Map()).get(s.key) || 0, color: s.color })),
    }));
    hbars($("tech-chart"), rows, {
      label: "Companies per technology, stacked by status",
      labelW: 108,
      onClick: r => { toggle(state.tech, r.key); update(); },
      onHover: r => { hoverTech = r.key; renderWafer(); },
      onLeave: () => { hoverTech = null; renderWafer(); },
      tip: (e, r) => showTip(e, r.key, techInfo.get(r.key) || "",
        r.segs.filter(s => s.value).map(s => ({ value: fmtInt(s.value), label: s.key.toLowerCase(), color: s.color }))),
    });
  }

  // ---------------------------------------------------------------------------
  // Map and country list
  // ---------------------------------------------------------------------------

  function countryCounts() {
    const pool = companies.filter(c => matches(c, "country") && c.country);
    return d3.rollup(pool, v => d3.rollup(v, w => w.length, c => c.status), c => c.country);
  }

  function countryTip(e, code, by) {
    const m = by.get(code) || new Map();
    const rows = STATUSES.filter(s => m.get(s.key))
      .map(s => ({ value: fmtInt(m.get(s.key)), label: s.key.toLowerCase(), color: s.color }));
    showTip(e, regionName(code), rows.length ? "" : "No companies match", rows);
  }

  function renderMap(by) {
    const el = $("map");
    if (!world) {
      emptyChart(el, "The map could not be loaded. The country list has the same numbers.");
      return;
    }
    const W = width(el), H = Math.round(W * 0.5);
    const total = code => d3.sum((by.get(code) || new Map()).values());
    const max = d3.max([...by.keys()], total) || 1;
    const css = getComputedStyle(document.documentElement);
    const ramp = d3.interpolateRgb(css.getPropertyValue("--seq-0").trim(), css.getPropertyValue("--seq-1").trim());
    // Log scale: the US alone has more companies than the next ten countries.
    const color = n => n ? ramp(Math.log1p(n) / Math.log1p(max)) : null;

    const projection = d3.geoNaturalEarth1().fitSize([W, H], { type: "Sphere" });
    const path = d3.geoPath(projection);
    const svg = svgIn(el, W, H, "Map of companies per country");
    svg.append("path").attr("class", "sphere").attr("d", path({ type: "Sphere" }));
    const features = world.filter(f => f.id !== "010"); // Antarctica
    svg.append("g").selectAll("path").data(features).join("path")
      .attr("d", path)
      .attr("class", f => {
        const code = NUM_TO_ISO[+f.id];
        return `land${code && total(code) ? " has" : ""}${code && state.country.has(code) ? " selected" : ""}`;
      })
      .style("fill", f => color(total(NUM_TO_ISO[+f.id])) || "var(--surface-2)")
      .on("pointermove", (e, f) => {
        const code = NUM_TO_ISO[+f.id];
        if (code) countryTip(e, code, by);
        else showTip(e, f.properties.name, "No companies listed");
      })
      .on("pointerleave", hideTip)
      .on("click", (e, f) => {
        const code = NUM_TO_ISO[+f.id];
        if (code && (total(code) || state.country.has(code))) { toggle(state.country, code); update(); }
      });
    const small = Object.entries(SMALL_COUNTRIES).filter(([code]) => total(code) || state.country.has(code));
    svg.append("g").selectAll("circle").data(small).join("circle")
      .attr("class", "small")
      .attr("transform", ([, ll]) => `translate(${projection(ll)})`)
      .attr("r", 5)
      .style("fill", ([code]) => color(total(code)) || "var(--surface-2)")
      .on("pointermove", (e, [code]) => countryTip(e, code, by))
      .on("pointerleave", hideTip)
      .on("click", (e, [code]) => { toggle(state.country, code); update(); });

    const scale = document.createElement("div");
    scale.className = "map-scale";
    const lo = document.createElement("span");
    lo.textContent = "1";
    const bar = document.createElement("i");
    const hi = document.createElement("span");
    hi.textContent = `${fmtInt(max)} companies (log scale)`;
    scale.append(lo, bar, hi);
    el.append(scale);
  }

  // Stacked bars like the technology chart, in a box that scrolls so the
  // long tail of countries does not push the page down.
  function renderCountryList(by) {
    const el = $("country-chart");
    const scroll = el.scrollTop;
    const total = code => d3.sum((by.get(code) || new Map()).values());
    const codes = [...new Set([...by.keys(), ...state.country])]
      .sort((a, b) => total(b) - total(a) || regionName(a).localeCompare(regionName(b)));
    if (!codes.length) { emptyChart(el, "No companies match the filters."); return; }
    const rows = codes.map(code => ({
      key: code,
      label: regionName(code),
      selected: state.country.has(code),
      segs: STATUSES.map(s => ({ key: s.key, value: (by.get(code) || new Map()).get(s.key) || 0, color: s.color })),
    }));
    hbars(el, rows, {
      label: "Companies per country, stacked by status",
      labelW: 124,
      onClick: r => { toggle(state.country, r.key); update(); },
      tip: (e, r) => countryTip(e, r.key, by),
    });
    el.scrollTop = scroll;
  }

  // ---------------------------------------------------------------------------
  // Founded per year (with a brush)
  // ---------------------------------------------------------------------------

  function renderFounded() {
    const el = $("founded-chart");
    const pool = companies.filter(c => matches(c, "founded") && c.founded != null);
    const all = companies.filter(c => c.founded != null).map(c => c.founded);
    if (!all.length) { emptyChart(el, "No founding years recorded."); return; }
    const lo = Math.max(d3.min(all), 1980), hi = d3.max(all);
    const years = d3.range(lo, hi + 1);
    const by = d3.rollup(pool, v => d3.rollup(v, w => w.length, c => c.status), c => Math.max(lo, c.founded));
    const byYear = new Map(years.map(y => [y, STATUSES.map(s => ({
      key: s.key, value: (by.get(y) || new Map()).get(s.key) || 0, color: s.color,
    }))]));
    const inRange = y => (state.from == null || y >= state.from) && (state.to == null || y <= state.to);
    const { svg, x, m, W, H } = columns(el, years, byYear, {
      label: "Companies founded per year, stacked by status",
      height: 220,
      inRange,
    });
    if (lo === 1980 && d3.min(all) < 1980) {
      svg.append("text").attr("x", x(1980)).attr("y", H - 2).text("≤1980");
    }

    const yearAt = px => {
      const i = Math.floor((px - m.left) / x.step());
      return years[Math.max(0, Math.min(years.length - 1, i))];
    };
    const brush = d3.brushX()
      .extent([[m.left, m.top], [W - m.right, H - m.bottom]])
      .on("end", e => {
        if (!e.sourceEvent) return;
        if (!e.selection) {
          state.from = state.to = null;
        } else {
          state.from = yearAt(e.selection[0] + 1);
          state.to = yearAt(e.selection[1] - 1);
        }
        update();
      });
    const gb = svg.append("g").attr("class", "brush").call(brush);
    gb.select(".selection").style("fill", "var(--ink)").style("fill-opacity", 0.06).style("stroke", "var(--axis)");
    // Let hover tooltips through the brush overlay: the overlay only catches drags.
    gb.select(".overlay").style("fill", "transparent");
    if (state.from != null || state.to != null) {
      const a = x(Math.max(lo, state.from ?? lo)) ?? m.left;
      const b = (x(Math.min(hi, state.to ?? hi)) ?? (W - m.right)) + x.bandwidth();
      gb.call(brush.move, [a, b]);
    }
    // Tooltips on the brush overlay, which sits on top of the columns.
    gb.select(".overlay").on("pointermove.tip", e => {
      const yr = yearAt(d3.pointer(e)[0]);
      const segs = (byYear.get(yr) || []).filter(s => s.value);
      showTip(e, yr === lo && lo === 1980 ? "1980 or earlier" : String(yr),
        `${fmtInt(d3.sum(segs, s => s.value))} founded`,
        segs.map(s => ({ value: fmtInt(s.value), label: s.key.toLowerCase(), color: s.color })));
    }).on("pointerleave.tip", hideTip);
  }

  // ---------------------------------------------------------------------------
  // Exits
  // ---------------------------------------------------------------------------

  function renderExits(list) {
    const ex = list.filter(c => c.status === "Exited");
    const ids = ["exit-year-chart", "exit-value-chart", "acquirer-chart", "age-chart"];
    const types = EXIT_TYPES.filter(t => ex.some(c => c.exitType === t.key));
    legend($("exit-legend"), types.map(t => ({ label: t.key, color: t.color })));
    if (!state.status.has("Exited")) {
      $("exits-note").textContent = "Turn on Exited in the status filter to see exits.";
      for (const id of ids) emptyChart($(id), "No exits in the current view.");
      return;
    }
    if (!ex.length) {
      $("exits-note").textContent = "";
      for (const id of ids) emptyChart($(id), "No exits match the filters.");
      return;
    }
    const withVal = ex.filter(c => c.value > 0);
    $("exits-note").textContent =
      `${fmtInt(ex.length)} exits, ${fmtInt(withVal.length)} with a disclosed value.`;

    // Exits per year by type.
    const yrs = ex.map(c => c.exitYear).filter(v => v != null);
    if (yrs.length) {
      const years = d3.range(d3.min(yrs), d3.max(yrs) + 1);
      const by = d3.rollup(ex, v => d3.rollup(v, w => w.length, c => c.exitType), c => c.exitYear);
      const byYear = new Map(years.map(y => [y, EXIT_TYPES.map(t => ({
        key: t.key, value: (by.get(y) || new Map()).get(t.key) || 0, color: t.color,
      }))]));
      columns($("exit-year-chart"), years, byYear, { label: "Exits per year by type", height: 200 });
    } else {
      emptyChart($("exit-year-chart"), "No exit years recorded.");
    }

    // Value dot plot.
    const vel = $("exit-value-chart");
    const vals = withVal.filter(c => c.exitYear != null);
    if (vals.length) {
      const W = width(vel), H = 200, m = { top: 10, right: 12, bottom: 26, left: 44 };
      const svg = svgIn(vel, W, H, "Disclosed exit values by year, log scale");
      const xs = d3.extent(vals, c => c.exitYear);
      const x = d3.scaleLinear().domain([xs[0] - 0.5, xs[1] + 0.5]).range([m.left, W - m.right]);
      const y = d3.scaleLog().domain([Math.min(1, d3.min(vals, c => c.value)), d3.max(vals, c => c.value) * 1.2])
        .range([H - m.bottom, m.top]).nice();
      const ticks = y.ticks().filter(t => /^1/.test(String(t)));
      svg.append("g").attr("class", "grid").attr("transform", `translate(${m.left},0)`)
        .call(d3.axisLeft(y).tickValues(ticks).tickSize(-(W - m.left - m.right)).tickFormat(""));
      svg.append("g").attr("class", "axis").attr("transform", `translate(${m.left},0)`)
        .call(d3.axisLeft(y).tickValues(ticks).tickSize(0).tickPadding(6).tickFormat(d3.format("~s")))
        .select(".domain").remove();
      svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.bottom})`)
        .call(d3.axisBottom(x).ticks(Math.min(8, xs[1] - xs[0] + 1)).tickFormat(d3.format("d")).tickSize(0).tickPadding(8))
        .select(".domain").attr("stroke", "var(--axis)");
      // Deterministic jitter, so dots in the same year do not stack exactly.
      const jitter = c => ((c.id * 0.6180339) % 1 - 0.5) * 0.6;
      const g = svg.append("g").selectAll("g").data(vals).join("g")
        .attr("transform", c => `translate(${x(c.exitYear + jitter(c))},${y(c.value)})`);
      g.append("circle").attr("r", 11).attr("fill", "transparent").style("cursor", "pointer");
      g.append("circle").attr("class", "dot").attr("r", 4.5).style("fill", c => EXIT_COLOR[c.exitType]);
      g.on("pointermove", (e, c) => companyTip(e, c)).on("pointerleave", hideTip)
        .on("click", (e, c) => openDrawer(c));
      // Label only the largest few, skipping any that would collide with a
      // label already placed; the tooltip and table carry the rest.
      // Boxes are estimated from the name length (about 7px per character)
      // and the side the label is drawn on.
      const placed = [];
      const box = c => {
        const px = x(c.exitYear + jitter(c)), py = y(c.value), w = c.name.length * 7;
        return x(c.exitYear) > W - 120 ? [px - 8 - w, px - 8, py] : [px + 8, px + 8 + w, py];
      };
      const top = [...vals].sort((a, b) => b.value - a.value).slice(0, 6).filter(c => {
        const [x0, x1, py] = box(c);
        if (placed.some(([q0, q1, qy]) => Math.abs(qy - py) < 15 && x0 < q1 + 6 && q0 < x1 + 6)) return false;
        placed.push([x0, x1, py]);
        return true;
      }).slice(0, 4);
      svg.append("g").selectAll("text").data(top).join("text")
        .attr("class", "label")
        .attr("x", c => x(c.exitYear + jitter(c)) + (x(c.exitYear) > W - 120 ? -8 : 8))
        .attr("text-anchor", c => x(c.exitYear) > W - 120 ? "end" : "start")
        .attr("y", c => y(c.value)).attr("dy", "0.35em")
        .text(c => c.name);
    } else {
      emptyChart(vel, "No disclosed values match the filters.");
    }

    // Acquirers.
    const acq = d3.rollups(ex.filter(c => c.acquirer), v => v, c => c.acquirer)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .slice(0, 10);
    if (acq.length) {
      hbars($("acquirer-chart"), acq.map(([name, cs]) => ({
        key: name, label: name, companies: cs,
        segs: [{ key: "Acquired", value: cs.length, color: EXIT_COLOR.Acquired }],
      })), {
        label: "Acquirers by number of companies bought",
        labelW: 120,
        tip: (e, r) => showTip(e, r.key, r.companies.map(c => c.name).join(", ")),
      });
    } else {
      emptyChart($("acquirer-chart"), "No acquisitions match the filters.");
    }

    // Years from founding to exit.
    const aged = ex.filter(c => c.founded != null && c.exitYear != null && c.exitYear >= c.founded);
    if (aged.length) {
      const maxAge = d3.max(aged, c => c.exitYear - c.founded);
      const ages = d3.range(0, maxAge + 1);
      const by = d3.rollup(aged, v => d3.rollup(v, w => w.length, c => c.exitType), c => c.exitYear - c.founded);
      const byAge = new Map(ages.map(a => [a, EXIT_TYPES.map(t => ({
        key: t.key, value: (by.get(a) || new Map()).get(t.key) || 0, color: t.color,
      }))]));
      columns($("age-chart"), ages, byAge, { label: "Exits by years from founding", height: 200 });
      const med = d3.median(aged, c => c.exitYear - c.founded);
      $("exits-note").textContent += ` Median time to exit: ${med} years (${fmtInt(aged.length)} with both years).`;
    } else {
      emptyChart($("age-chart"), "No exits with both a founding and an exit year.");
    }
  }

  // ---------------------------------------------------------------------------
  // Investors list
  // ---------------------------------------------------------------------------

  const INV_COLUMNS = [
    { key: "name", label: "Investor" },
    { key: "website", label: "Website" },
    { key: "count", label: "Companies", num: true },
    { key: "portfolio", label: "Portfolio (click a company for details)", nosort: true },
  ];

  function buildInvestorHead() {
    const tr = $("investors-table").querySelector("thead tr");
    for (const col of INV_COLUMNS) {
      const th = document.createElement("th");
      th.scope = "col";
      if (col.num) th.className = "num";
      if (col.nosort) {
        const span = document.createElement("span");
        span.className = "th-plain";
        span.textContent = col.label;
        th.append(span);
      } else {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = col.label;
        b.addEventListener("click", () => {
          if (state.invSort === col.key) state.invDir = -state.invDir;
          else { state.invSort = col.key; state.invDir = col.num ? -1 : 1; }
          renderInvestors();
        });
        th.append(b);
      }
      tr.append(th);
    }
  }

  // Investors of the companies that pass every filter except the investor
  // filter, each with the companies it backs among them.
  function investorPool() {
    const pool = new Set(companies.filter(c => matches(c, "investor")));
    const rows = [];
    for (const inv of investors.values()) {
      const cos = inv.companies.filter(c => pool.has(c));
      if (cos.length) rows.push({ inv, cos });
    }
    return rows;
  }

  function investorSite(inv) {
    // Built only from a validated bare domain; NA marks a private individual.
    if (inv.website) return externalLink(`https://${inv.website}`, inv.website);
    const s = document.createElement("span");
    s.className = "muted";
    s.textContent = inv.person ? "Private investor" : "";
    return s;
  }

  function renderInvestors() {
    const ths = $("investors-table").querySelectorAll("thead th");
    INV_COLUMNS.forEach((col, i) => {
      ths[i].setAttribute("aria-sort", col.nosort ? "none"
        : col.key === state.invSort ? (state.invDir > 0 ? "ascending" : "descending") : "none");
    });
    const tbody = $("investors-table").querySelector("tbody");
    if (!investorsLoaded) {
      tbody.replaceChildren();
      $("investors-count").textContent = "The investor list (investors.csv) could not be loaded.";
      return;
    }
    const rows = investorPool();
    const key = {
      name: r => r.inv.name.toLowerCase(),
      website: r => r.inv.website || "",
      count: r => r.cos.length,
    }[state.invSort] || (r => r.cos.length);
    rows.sort((a, b) => {
      const va = key(a), vb = key(b);
      const ea = va === "", eb = vb === "";
      if (ea || eb) return ea - eb;
      const r = typeof va === "number" ? va - vb : va.localeCompare(vb);
      return (r * state.invDir) || a.inv.name.localeCompare(b.inv.name);
    });
    const frag = document.createDocumentFragment();
    for (const { inv, cos } of rows) {
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      if (state.investor.has(inv.name)) tr.className = "selected";
      tr.setAttribute("aria-selected", String(state.investor.has(inv.name)));
      const name = document.createElement("td");
      name.className = "co";
      name.textContent = inv.name;
      const site = document.createElement("td");
      site.append(investorSite(inv));
      const n = document.createElement("td");
      n.className = "num";
      n.textContent = fmtInt(cos.length);
      const port = document.createElement("td");
      port.className = "pills";
      for (const c of [...cos].sort((a, b) => a.name.localeCompare(b.name))) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pill";
        b.textContent = c.name;
        b.addEventListener("click", e => { e.stopPropagation(); openDrawer(c); });
        port.append(b);
      }
      tr.append(name, site, n, port);
      const pick = () => { toggle(state.investor, inv.name); update(); };
      tr.addEventListener("click", e => { if (!e.target.closest("a")) pick(); });
      tr.addEventListener("keydown", e => { if (e.key === "Enter" && e.target === tr) pick(); });
      frag.append(tr);
    }
    tbody.replaceChildren(frag);
    const backed = new Set(rows.flatMap(r => r.cos)).size;
    $("investors-count").textContent = rows.length
      ? `${fmtInt(rows.length)} investors in ${fmtInt(backed)} companies. Click an investor to filter by it.`
      : "No investors are recorded for the companies that match the filters.";
  }

  // ---------------------------------------------------------------------------
  // Ecosystem map (force-directed network)
  // ---------------------------------------------------------------------------

  let net = null; // { key, svg, nodes, links, byId }

  // Investors are kept if they back at least `min` companies; companies are
  // those the kept investors back. The layout is computed once per scope and
  // width, in a fixed number of ticks from d3's deterministic starting
  // positions, so it is the same on every load and never animates. Filters
  // only change which nodes are dimmed.
  function buildNetwork(el, W) {
    const min = state.netAll ? 1 : 2;
    const invs = [...investors.values()].filter(i => i.companies.length >= min);
    const nodes = [], links = [], byId = new Map();
    const node = n => { byId.set(n.id, n); nodes.push(n); return n; };
    for (const inv of invs.sort((a, b) => b.companies.length - a.companies.length || a.name.localeCompare(b.name))) {
      node({ id: `i:${inv.name}`, kind: "inv", inv, r: 3 + 2.2 * Math.sqrt(inv.companies.length) });
    }
    for (const inv of invs) {
      for (const c of inv.companies) {
        const id = `c:${c.name}`;
        if (!byId.has(id)) node({ id, kind: "co", c, r: 4 });
        links.push({ source: `i:${inv.name}`, target: id });
      }
    }
    if (!nodes.length) return null;
    const H = Math.round(Math.min(720, Math.max(440, W * 0.62)));
    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id).distance(l => 24 + l.source.r).strength(0.5))
      .force("charge", d3.forceManyBody().strength(d => d.kind === "inv" ? -70 - 8 * d.r : -40))
      .force("collide", d3.forceCollide(d => d.r + 3))
      // Pull harder vertically than horizontally so the cloud fills a wide panel,
      // and strongly enough that small disconnected groups stay close.
      .force("x", d3.forceX(0).strength(0.035))
      .force("y", d3.forceY(0).strength(0.035 * W / H))
      .stop();
    for (let i = 0; i < 400; i++) sim.tick();
    for (const n of nodes) n.adj = new Set();
    for (const l of links) { l.source.adj.add(l.target); l.target.adj.add(l.source); }

    const [x0, x1] = d3.extent(nodes, n => n.x), [y0, y1] = d3.extent(nodes, n => n.y);
    const pad = 70;
    const bw = x1 - x0 + 2 * pad, bh = y1 - y0 + 2 * pad;
    const k = Math.min(W / bw, H / bh);
    el.replaceChildren();
    const svg = d3.select(el).append("svg")
      .attr("viewBox", `0 0 ${W} ${H}`).attr("width", W).attr("role", "img");
    const g = svg.append("g");
    const fit = d3.zoomIdentity.translate(W / 2, H / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    const zoom = d3.zoom().scaleExtent([k * 0.8, k * 8])
      // Plain scrolling keeps scrolling the page; Ctrl/Cmd + scroll zooms.
      .filter(e => e.type === "wheel" ? (e.ctrlKey || e.metaKey) : !e.button)
      .on("zoom", e => g.attr("transform", e.transform));
    svg.call(zoom).call(zoom.transform, fit);

    g.append("g").attr("class", "links").selectAll("line").data(links).join("line")
      .attr("x1", l => l.source.x).attr("y1", l => l.source.y)
      .attr("x2", l => l.target.x).attr("y2", l => l.target.y);
    const nodeSel = g.append("g").attr("class", "nodes").selectAll("g").data(nodes).join("g")
      .attr("class", n => `node ${n.kind}`)
      .attr("transform", n => `translate(${n.x},${n.y})`);
    nodeSel.filter(n => n.kind === "inv").append("circle").attr("r", n => n.r);
    nodeSel.filter(n => n.kind === "co").append("rect")
      .attr("x", -4).attr("y", -3.2).attr("width", 8).attr("height", 6.4).attr("rx", 0.8);
    // Label the largest investors directly, in a layer above every node so no
    // circle covers a label; everything else is in the tooltip.
    // Positions are tried right, left, above, below; a label that fits
    // nowhere is left to the tooltip. Widths are estimated at 11px type.
    const placed = [];
    const top = [];
    const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
    for (const n of nodes.filter(m => m.kind === "inv").slice(0, 15)) {
      const w = n.inv.name.length * 6.3, h = 12, gap = n.r + 3;
      const tries = [
        { x: n.x + gap, y: n.y, anchor: "start" },
        { x: n.x - gap, y: n.y, anchor: "end" },
        { x: n.x, y: n.y - gap - h / 2, anchor: "middle" },
        { x: n.x, y: n.y + gap + h / 2, anchor: "middle" },
      ];
      for (const t of tries) {
        const x0 = t.anchor === "start" ? t.x : t.anchor === "end" ? t.x - w : t.x - w / 2;
        const box = { x0, x1: x0 + w, y0: t.y - h / 2, y1: t.y + h / 2 };
        if (placed.some(b => hit(b, box))) continue;
        placed.push(box);
        top.push({ n, ...t });
        break;
      }
    }
    const labelSel = g.append("g").attr("class", "labels").selectAll("text").data(top).join("text")
      .attr("class", "net-label")
      .attr("x", d => d.x).attr("y", d => d.y).attr("dy", "0.35em").attr("text-anchor", d => d.anchor)
      .text(d => d.n.inv.name);

    const tipFor = (e, n) => {
      if (n.kind === "co") companyTip(e, n.c);
      else showTip(e, n.inv.name, n.inv.website || (n.inv.person ? "Private investor" : ""),
        [{ value: fmtInt(n.inv.companies.length), label: n.inv.companies.length === 1 ? "company" : "companies" }]);
    };
    nodeSel
      .on("pointerenter", (e, n) => {
        svg.classed("tracing", true);
        nodeSel.classed("lit", m => m === n || n.adj.has(m));
        labelSel.classed("lit", d => d.n === n || n.adj.has(d.n));
        g.selectAll(".links line").classed("lit", l => l.source === n || l.target === n);
      })
      .on("pointermove", tipFor)
      .on("pointerleave", () => {
        svg.classed("tracing", false);
        nodeSel.classed("lit", false);
        labelSel.classed("lit", false);
        g.selectAll(".links line").classed("lit", false);
        hideTip();
      })
      .on("click", (e, n) => {
        if (n.kind === "co") openDrawer(n.c);
        else { toggle(state.investor, n.inv.name); update(); }
      });
    const nInv = nodes.filter(n => n.kind === "inv").length;
    svg.attr("aria-label", `Network of ${nInv} investors and ${nodes.length - nInv} companies with ${links.length} investments. The investors table lists the same connections.`);
    return { key: `${min}:${W}`, svg, nodeSel, labelSel, links: g.selectAll(".links line") };
  }

  function renderNetwork() {
    const el = $("network");
    if (!investorsLoaded || !investors.size) {
      net = null;
      emptyChart(el, "No investor data is available.");
      return;
    }
    const W = width(el);
    if (!net || net.key !== `${state.netAll ? 1 : 2}:${W}`) net = buildNetwork(el, W);
    if (!net) { emptyChart(el, "No investors back more than one company."); return; }
    const on = n => n.kind === "co" ? matches(n.c) : n.inv.companies.some(c => matches(c));
    net.nodeSel
      .classed("off", n => !on(n))
      .classed("selected", n => n.kind === "inv" ? state.investor.has(n.inv.name) : state.open === n.c.name);
    net.links.classed("off", l => !on(l.source) || !on(l.target));
    net.labelSel.classed("off", d => !on(d.n));
    const lg = $("network-legend");
    if (!lg.childElementCount) {
      // Shapes, not colours, tell the two node kinds apart.
      const item = (shape, text) => {
        const s = document.createElement("span");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "-7 -7 14 14");
        svg.setAttribute("width", "14");
        svg.setAttribute("height", "14");
        svg.setAttribute("aria-hidden", "true");
        svg.classList.add("net-key");
        const el = document.createElementNS("http://www.w3.org/2000/svg", shape);
        if (shape === "circle") { el.setAttribute("r", "5"); el.setAttribute("class", "inv"); }
        else {
          for (const [k, v] of [["x", -4], ["y", -3.2], ["width", 8], ["height", 6.4], ["rx", 0.8]]) el.setAttribute(k, v);
          el.setAttribute("class", "co");
        }
        svg.append(el);
        s.append(svg, text);
        lg.append(s);
      };
      item("circle", "Investor, sized by number of companies");
      item("rect", "Startup");
    }
  }

  // ---------------------------------------------------------------------------
  // Table
  // ---------------------------------------------------------------------------

  const COLUMNS = [
    { key: "name", label: "Company", get: c => c.name, cls: "co" },
    { key: "status", label: "Status", get: c => c.status },
    { key: "tech", label: "Technology", get: c => c.tech },
    { key: "country", label: "Country", get: c => c.country ? regionName(c.country) : "" },
    { key: "founded", label: "Founded", get: c => c.founded, num: true },
    { key: "exit", label: "Exit", get: c => c.exit || "" },
    { key: "exitYear", label: "Exit year", get: c => c.exitYear, num: true },
    { key: "value", label: "Value $M", get: c => c.value, num: true, fmt: v => fmtInt(v) },
    { key: "desc", label: "Description", get: c => c.desc, cls: "desc" },
  ];

  function buildTableHead() {
    const tr = $("table").querySelector("thead tr");
    for (const col of COLUMNS) {
      const th = document.createElement("th");
      th.scope = "col";
      if (col.num) th.className = "num";
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = col.label;
      b.addEventListener("click", () => {
        if (state.sort === col.key) state.dir = -state.dir;
        else { state.sort = col.key; state.dir = col.num ? -1 : 1; }
        update();
      });
      th.append(b);
      tr.append(th);
    }
  }

  function sorted(list) {
    const col = COLUMNS.find(c => c.key === state.sort) || COLUMNS[0];
    return [...list].sort((a, b) => {
      const va = col.get(a), vb = col.get(b);
      const ea = va == null || va === "", eb = vb == null || vb === "";
      if (ea || eb) return ea - eb; // empty values last, whichever direction
      const r = col.num ? va - vb : String(va).localeCompare(String(vb));
      return (r || a.name.localeCompare(b.name)) * state.dir;
    });
  }

  function renderTable(list) {
    const ths = $("table").querySelectorAll("thead th");
    COLUMNS.forEach((col, i) => {
      ths[i].setAttribute("aria-sort", col.key === state.sort ? (state.dir > 0 ? "ascending" : "descending") : "none");
    });
    const tbody = $("table").querySelector("tbody");
    const frag = document.createDocumentFragment();
    for (const c of sorted(list)) {
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      for (const col of COLUMNS) {
        const td = document.createElement("td");
        if (col.cls) td.className = col.cls;
        if (col.num) td.className = "num";
        const v = col.get(c);
        if (col.key === "status") {
          const s = document.createElement("span");
          s.className = "status-cell";
          const sw = document.createElement("i");
          sw.className = "swatch";
          sw.style.setProperty("--sw", STATUS_COLOR[c.status]);
          s.append(sw, c.status);
          td.append(s);
        } else {
          td.textContent = v == null ? "" : (col.fmt ? col.fmt(v) : String(v));
        }
        tr.append(td);
      }
      tr.addEventListener("click", () => openDrawer(c));
      tr.addEventListener("keydown", e => { if (e.key === "Enter") openDrawer(c); });
      frag.append(tr);
    }
    tbody.replaceChildren(frag);
    $("table-count").textContent = `${fmtInt(list.length)} of ${fmtInt(companies.length)} companies. Click a row for details.`;
  }

  // ---------------------------------------------------------------------------
  // Detail drawer
  // ---------------------------------------------------------------------------

  let lastFocus = null;

  function externalLink(href, text) {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  function openDrawer(c, { focus = true } = {}) {
    if (focus) lastFocus = document.activeElement;
    state.open = c.name;
    const body = $("drawer-body");
    body.replaceChildren();
    const h = document.createElement("h3");
    h.id = "drawer-name";
    h.textContent = c.name;
    const p = document.createElement("p");
    p.className = "desc";
    p.textContent = c.desc || "No description.";
    const dl = document.createElement("dl");
    const add = (k, v) => {
      if (v == null || v === "") return;
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      if (v instanceof Node) dd.append(v); else dd.textContent = v;
      dl.append(dt, dd);
    };
    const st = document.createElement("span");
    st.className = "status-cell";
    const sw = document.createElement("i");
    sw.className = "swatch";
    sw.style.setProperty("--sw", STATUS_COLOR[c.status]);
    st.append(sw, c.status);
    add("Status", st);
    add("Technology", techInfo.get(c.tech) ? `${c.tech} (${techInfo.get(c.tech)})` : c.tech);
    add("Country", c.country ? regionName(c.country) : "Unknown");
    add("Founded", c.founded ?? "Unknown");
    if (c.website) {
      // Built from a validated bare domain, never from free text. Only active
      // companies get a link: the domain of a company that exited or went
      // quiet often lapses and is re-registered by someone else.
      add("Website", c.status === "Active" ? externalLink(`https://${c.website}`, c.website) : c.website);
    }
    if (c.investors.length) {
      const wrap = document.createElement("span");
      wrap.className = "pills";
      for (const inv of c.investors) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "pill";
        b.textContent = inv.name;
        b.title = `Show companies backed by ${inv.name}`;
        b.addEventListener("click", () => { state.investor = new Set([inv.name]); update(); });
        wrap.append(b);
      }
      add("Investors", wrap);
    }
    if (c.status === "Exited") {
      add("Exit", c.exitType === "Acquired" ? `Acquired by ${c.acquirer}` : c.exitType);
      add("Exit year", c.exitYear ?? "Unknown");
      add("Value", c.value != null ? (c.value ? `${fmtMoney(c.value)}` : "$0 (shutdown)") : "Not disclosed");
      if (c.link) add("Source", externalLink(c.link, new URL(c.link).hostname.replace(/^www\./, "")));
      else if (c.linkText) add("Source", c.linkText);
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    const act = (text, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ghost";
      b.textContent = text;
      b.addEventListener("click", () => { fn(); update(); });
      actions.append(b);
    };
    act(`Show all ${c.tech}`, () => { state.tech = new Set([c.tech]); });
    if (c.country) act(`Show all in ${regionName(c.country)}`, () => { state.country = new Set([c.country]); });
    body.append(h, p, dl, actions);
    $("drawer").hidden = false;
    if (focus) $("drawer-close").focus();
    writeURL();
    renderWafer();
    if (net) renderNetwork();
  }

  function closeDrawer() {
    if ($("drawer").hidden) return;
    $("drawer").hidden = true;
    state.open = null;
    writeURL();
    renderWafer();
    if (net) renderNetwork();
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  // ---------------------------------------------------------------------------
  // CSV export
  // ---------------------------------------------------------------------------

  function csvCell(v) {
    let s = v == null ? "" : String(v);
    // A cell starting with one of these runs as a formula in a spreadsheet.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCSV() {
    const head = ["Company", "Status", "Website", "Technology", "Country", "Founded", "Description",
      "Exit", "Year", "Value($M)", "Link", "Investors"];
    const lines = [head.join(",")];
    for (const c of sorted(companies.filter(x => matches(x)))) {
      lines.push([c.name, c.status, c.website, c.tech, c.country, c.founded, c.desc,
        c.exit, c.exitYear, c.value, c.link || c.linkText,
        c.investors.map(i => i.name).join("; ")].map(csvCell).join(","));
    }
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "semiconductor-startups.csv";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------

  function currentTheme() { return document.documentElement.dataset.theme || "system"; }

  function setTheme(t) {
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try {
      if (t === "system") localStorage.removeItem("theme"); else localStorage.setItem("theme", t);
    } catch (e) { /* storage blocked: the choice lasts for this visit */ }
    $("theme-toggle").textContent = `Theme: ${t}`;
    // The map ramp is computed from CSS, so it has to be redrawn.
    render();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function render() {
    const list = companies.filter(c => matches(c));
    syncControls();
    renderChips();
    renderFigures(list);
    renderWafer();
    renderTech();
    const by = countryCounts();
    renderMap(by);
    renderCountryList(by);
    renderFounded();
    renderExits(list);
    renderTable(list);
    renderInvestors();
    renderNetwork();
  }

  async function main() {
    try {
      await Promise.all([load(), loadWorld()]);
    } catch (e) {
      const el = $("load-error");
      el.hidden = false;
      const msg = location.protocol === "file:"
        ? "Browsers do not let a page opened from disk read files next to it. From the repository root, run python3 -m http.server and open http://localhost:8000/dashboard/."
        : `Could not load the data (${e.message}).`;
      el.textContent = msg;
      document.querySelector("main").hidden = true;
      return;
    }
    readURL();
    layoutWafer();
    buildControls();
    buildTableHead();
    buildInvestorHead();
    $("net-all").checked = state.netAll;
    $("net-all").addEventListener("change", e => { state.netAll = e.target.checked; update(); });
    legend($("status-legend"), STATUSES.map(s => ({ label: s.key, color: s.color })));
    $("theme-toggle").textContent = `Theme: ${currentTheme()}`;
    $("theme-toggle").addEventListener("click", () => {
      const order = ["system", "light", "dark"];
      setTheme(order[(order.indexOf(currentTheme()) + 1) % order.length]);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (currentTheme() === "system") render();
    });
    $("drawer-close").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
    let resizeTimer = null;
    addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 150);
    });
    render();
    if (state.open) {
      const c = companies.find(x => x.name === state.open);
      if (c) openDrawer(c, { focus: false }); else { state.open = null; writeURL(); }
    }
  }

  main();
})();
