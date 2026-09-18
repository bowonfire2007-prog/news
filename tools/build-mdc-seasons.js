#!/usr/bin/env node
// Scrapes MDC's "Seasons at a glance" tables into data/mdc-seasons.json for
// the Season Countdown card. Run once a year (MDC posts next year's deer/turkey
// dates in December, migratory birds in March, fishing in January):
//     node tools/build-mdc-seasons.js
// then push.bat.
//
// Each season → { name, periods: [["YYYY-MM-DD","YYYY-MM-DD"], ...] }. The
// page decides "open now / opens in N days / closed", so nothing here depends
// on today's date. Rows whose dates fail to parse are kept with periods: []
// and listed in the console so a format change on MDC's side is visible.

const fs = require("fs");
const path = require("path");
const OUT = path.join(__dirname, "..", "data", "mdc-seasons.json");
const UA = { "User-Agent": "Mozilla/5.0 (compatible; MattsDailyRead/1.0)" };

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function parseDate(s) {
  // "Nov 15, 2026" | "November 15, 2026"
  const m = String(s).trim().match(/^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
}
function parsePeriods(text) {
  // "Nov 15, 2025 - Mar 31, 2026 Nov 15, 2026 - Mar 31, 2027" or "March 1, 2026 to October 31, 2026"
  const re = /([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})\s*(?:-|–|to)\s*([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})/g;
  const out = []; let m;
  while ((m = re.exec(text))) { const a = parseDate(m[1]), b = parseDate(m[2]); if (a && b) out.push([a, b]); }
  return out;
}
function stripTags(h) { return h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#039;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(); }

async function scrape(base, pages) {
  const rows = [];
  for (let p = 0; p < pages; p++) {
    const r = await fetch(base + (p ? "?page=" + p : ""), { headers: UA });
    if (!r.ok) throw new Error(base + " HTTP " + r.status);
    const html = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "");
    for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
      const tds = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(stripTags);
      if (tds.length < 2) continue;
      const name = tds[0], periods = parsePeriods(tds[1]);
      if (!periods.length) console.log("  (no dates parsed) " + name + " | " + tds[1].slice(0, 80));
      rows.push({ name, periods, limits: (tds[3] || "").slice(0, 160) });
    }
  }
  return rows;
}

(async () => {
  const out = { built: new Date().toISOString(), source: "mdc.mo.gov seasons tables (not a legal document — check the Wildlife Code)" };
  process.stdout.write("hunting… "); out.hunting = await scrape("https://mdc.mo.gov/hunting-trapping/seasons", 3); console.log(out.hunting.length + " rows");
  process.stdout.write("fishing… "); out.fishing = await scrape("https://mdc.mo.gov/fishing/seasons", 2); console.log(out.fishing.length + " rows");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log("wrote " + OUT + " (" + Math.round(fs.statSync(OUT).size / 1024) + " KB)");
})();
