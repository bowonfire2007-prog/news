#!/usr/bin/env node
// Builds data/records.json — Missouri state record fish (every species, both
// "Pole and line" and "Alternative method" categories) scraped from MDC's
// State Record Fish pages, plus a small hand-kept list of Missouri big-game
// records that have no scrapeable public source.
//
//     node tools/build-records.js      (then push.bat)
//
// Re-run when MDC announces a new record (they post a news release; a few a
// year). Each fish → { species, method, lbs, oz, weightLb, water, date, angler,
// hometown }. Parsing is per-<article>; a field that fails to parse is null,
// never a guess, and the console lists any article that lost a field.

const fs = require("fs");
const path = require("path");
const OUT = path.join(__dirname, "..", "data", "records.json");
const BASE = "https://mdc.mo.gov/fishing/trophies-certificates/state-record-fish";
const UA = { "User-Agent": "Mozilla/5.0 (compatible; MattsDailyRead/1.0)" };

const strip = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#039;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const field = (art, name) => {
  const m = art.match(new RegExp('field--field-' + name + '[\\s\\S]*?field__item">([\\s\\S]*?)</div>', "i"));
  return m ? strip(m[1]) : null;
};

async function scrapeFish() {
  const out = [];
  for (let p = 0; p < 30; p++) {
    const r = await fetch(BASE + (p ? "?page=" + p : ""), { headers: UA });
    if (!r.ok) throw new Error("MDC HTTP " + r.status + " on page " + p);
    const html = await r.text();
    // One record per views-row; the record <article> nests a media <article>
    // for the photo, so a non-greedy article match would stop early.
    const arts = html.split(/<div class="views-row">/).slice(1).map(x => x.split(/<\/article>\s*<\/div>\s*(?=<div class="views-row">|$)/)[0]);
    if (!arts.length) break;
    for (const a of arts) {
      const title = strip((a.match(/<h4>[\s\S]*?<\/h4>/) || [""])[0]);
      const tm = title.match(/^(.*?)\s+-\s+(Pole and line|Alternative Method:?\s*(.*))$/i);
      const species = tm ? tm[1].trim() : title;
      const method = tm ? (/^pole/i.test(tm[2]) ? "Pole and line" : "Alt: " + (tm[3] || "").trim()) : null;
      const lbs = parseInt(field(a, "lbs") || (a.match(/(\d+)\s*lbs\./) || [])[1], 10);
      const oz  = parseInt(field(a, "oz")  || (a.match(/(\d+)\s*oz\./) || [])[1], 10);
      const rec = {
        species, method,
        lbs: Number.isFinite(lbs) ? lbs : null, oz: Number.isFinite(oz) ? oz : null,
        weightLb: Number.isFinite(lbs) ? +(lbs + (Number.isFinite(oz) ? oz / 16 : 0)).toFixed(3) : null,
        water: field(a, "lake-or-stream"), date: null, angler: field(a, "angler"), hometown: field(a, "hometown"),
        note: (a.match(/Recognized before the requirement[^<]*/) || [""])[0].trim() || null,
        // "Classifications: Open" = no record holder yet (MDC lists the species so someone can claim it).
        open: /Classifications[\s\S]{0,400}?>\s*Open\s*</.test(a) || null
      };
      const dm = (field(a, "date") || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
      if (dm) rec.date = dm[3] + "-" + dm[1] + "-" + dm[2];
      if (!rec.open && (!rec.weightLb || !rec.water || !rec.date)) console.log("  (partial) " + title + " → " + JSON.stringify(rec));
      out.push(rec);
    }
  }
  return out;
}

// Big-game records: no public machine-readable source (Boone & Crockett's state
// list is behind a login; the Show-Me Big Bucks Club publishes a book). These
// two are the widely reported Missouri whitetail benchmarks. Edit by hand.
const HUNTING = [
  { species: "Whitetail deer · non-typical", score: "333 7/8 B&C", holder: "\"Missouri Monarch\" (found dead)", where: "St. Louis County", year: 1981,
    note: "Also the Boone & Crockett World's Record non-typical whitetail.", source: "Boone and Crockett Club" },
  { species: "Whitetail deer · typical", score: "205 B&C", holder: "Larry W. Gibson", where: "Randolph County", year: 1971,
    note: "Rifle, 10 yards; the rack is displayed by Bass Pro Shops.", source: "Show-Me Big Bucks Club / B&C" }
];

(async () => {
  process.stdout.write("fish… ");
  const fish = await scrapeFish();
  console.log(fish.length + " records");
  const out = { built: new Date().toISOString(), source: "MDC State Record Fish Program (mdc.mo.gov) · big-game entries hand-kept",
                fish, hunting: HUNTING };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const truman = fish.filter(f => /truman/i.test(f.water || ""));
  console.log("wrote " + OUT + " (" + Math.round(fs.statSync(OUT).size / 1024) + " KB) · Truman Lake records: " + truman.map(f => f.species + " " + f.weightLb + " lb").join("; "));
})();
