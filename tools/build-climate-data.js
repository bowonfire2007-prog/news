#!/usr/bin/env node
// Builds data/climate.json — the slow-moving local climate reference the page
// and worker read instead of re-deriving it every day:
//
//   tornado  every SPC-recorded tornado since 1950 touching Henry County MO or
//            one of its eight neighbours (SPC CSV is ~8 MB; updated yearly)
//   freeze   first-fall / last-spring 32°F dates per year for Clinton COOP,
//            plus medians, earliest/latest, and the 1996-2025 medians
//   lake     Truman Lake pool elevation by calendar day for every year since
//            1986 (USACE CDA hourly series, ~11 MB, reduced to one reading per
//            day at 06:00Z), plus the all-time high/low pool
//
// Run it by hand once a year (or after a notable event):
//     node tools/build-climate-data.js
// then push.bat. The worker cron does NOT run this — parsing 20 MB of upstream
// text is exactly the CPU-heavy work a Cloudflare Worker is bad at, and none
// of these numbers change day to day.
//
// Every value is null-guarded: ACIS "M" / "T", USACE gaps, and SPC "-9"
// magnitudes all become null, never 0.

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "climate.json");
const STATION_SID = "231711 2";                 // CLINTON, MO COOP (1906→)
const LAKE_TS = "HAST.Elev.Inst.1Hour.0.Best-NWK";
const TORNADO_COUNTIES = { 83: "Henry", 13: "Bates", 37: "Cass", 101: "Johnson", 159: "Pettis", 15: "Benton", 185: "St. Clair", 217: "Vernon", 85: "Hickory" };

const num = v => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return (v <= -998 || !Number.isFinite(v)) ? null : v;
  const s = String(v).trim();
  if (s === "" || s === "M") return null;
  if (s === "T" || s === "S" || s === "A") return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};
const median = arr => { const a = arr.slice().sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
const doy = iso => Math.round((Date.parse(iso + "T12:00:00Z") - Date.parse(iso.slice(0, 4) + "-01-01T12:00:00Z")) / 86400000) + 1;
const doyToMmdd = (d, yr = 2025) => new Date(Date.parse(yr + "-01-01T12:00:00Z") + (d - 1) * 86400000).toISOString().slice(5, 10);

async function acis(pathName, body) {
  const r = await fetch("https://data.rcc-acis.org/" + pathName, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("ACIS " + pathName + " HTTP " + r.status);
  const j = await r.json();
  if (j.error) throw new Error("ACIS " + j.error);
  return j;
}

async function buildTornado() {
  const y = new Date().getUTCFullYear();
  let text = null, used = null;
  for (const yr of [y - 1, y - 2]) {
    const r = await fetch(`https://www.spc.noaa.gov/wcm/data/1950-${yr}_torn.csv`);
    if (r.ok) { text = await r.text(); used = yr; break; }
  }
  if (!text) throw new Error("SPC CSV not found");
  const lines = text.split("\n");
  const h = lines[0].trim().split(",");
  const c = n => h.indexOf(n);
  const iDate = c("date"), iTime = c("time"), iSt = c("st"), iMag = c("mag"), iInj = c("inj"), iFat = c("fat"), iLen = c("len"), iWid = c("wid"), iF = [c("f1"), c("f2"), c("f3"), c("f4")];
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const r = lines[i].split(",");
    if (r.length < h.length || r[iSt] !== "MO") continue;
    const counties = [];
    for (const fi of iF) { const f = parseInt(r[fi], 10); if (f > 0 && TORNADO_COUNTIES[f] && !counties.includes(TORNADO_COUNTIES[f])) counties.push(TORNADO_COUNTIES[f]); }
    if (!counties.length) continue;
    const mag = parseInt(r[iMag], 10);
    events.push({ date: r[iDate], time: (r[iTime] || "").slice(0, 5), mag: Number.isFinite(mag) && mag >= 0 ? mag : null,
      inj: parseInt(r[iInj], 10) || 0, fat: parseInt(r[iFat], 10) || 0, len: parseFloat(r[iLen]) || 0, wid: parseInt(r[iWid], 10) || 0, counties });
  }
  events.sort((a, b) => a.date < b.date ? -1 : 1);
  return { source: "NOAA SPC tornado database 1950-" + used, throughYear: used, counties: Object.values(TORNADO_COUNTIES), events };
}

async function buildFreeze() {
  const por = await acis("StnData", { sid: STATION_SID, sdate: "por", edate: "por", elems: [{ name: "mint" }] });
  const rows = por.data.map(r => ({ date: r[0], lo: num(r[1]) }));
  const byYear = {};
  for (const r of rows) { const y = r.date.slice(0, 4); (byYear[y] = byYear[y] || []).push(r); }
  const firstFall = [], lastSpring = [];
  for (const y of Object.keys(byYear).sort()) {
    const yr = byYear[y];
    // Fall: first day ≤32 on/after Aug 1, but only if the Aug–Dec span isn't mostly missing.
    const fall = yr.filter(r => r.date.slice(5) >= "08-01");
    if (fall.filter(r => r.lo !== null).length >= 120) {
      const f = fall.find(r => r.lo !== null && r.lo <= 32);
      if (f) firstFall.push({ year: y, date: f.date, doy: doy(f.date), lo: f.lo });
    }
    const spring = yr.filter(r => r.date.slice(5) <= "07-31");
    if (spring.filter(r => r.lo !== null).length >= 170) {
      const s = spring.slice().reverse().find(r => r.lo !== null && r.lo <= 32);
      if (s) lastSpring.push({ year: y, date: s.date, doy: doy(s.date), lo: s.lo });
    }
  }
  const stats = (list) => {
    const recent = list.filter(x => +x.year >= 1996 && +x.year <= 2025);
    const byDoy = k => list.slice().sort((a, b) => a.doy - b.doy)[k];
    return {
      years: list.length,
      median: doyToMmdd(Math.round(median(list.map(x => x.doy)))),
      medianRecent30: recent.length ? doyToMmdd(Math.round(median(recent.map(x => x.doy)))) : null,
      earliest: byDoy(0) ? { date: byDoy(0).date, lo: byDoy(0).lo } : null,
      latest: byDoy(list.length - 1) ? { date: byDoy(list.length - 1).date, lo: byDoy(list.length - 1).lo } : null,
      last5: list.slice(-5).map(x => ({ year: x.year, date: x.date, lo: x.lo }))
    };
  };
  return { station: "Clinton, MO COOP " + STATION_SID.split(" ")[0], threshold: 32, firstFall: stats(firstFall), lastSpring: stats(lastSpring) };
}

async function buildLake() {
  const end = new Date().toISOString().slice(0, 10);
  const r = await fetch(`https://water.usace.army.mil/cda/reporting/providers/nwk/timeseries?name=${LAKE_TS}&begin=1980-01-01T00:00:00Z&end=${end}T23:59:59Z`);
  if (!r.ok) throw new Error("USACE CDA HTTP " + r.status);
  const j = await r.json();
  const vals = (j.values || []).filter(v => Array.isArray(v) && typeof v[1] === "number" && v[1] > 600 && v[1] < 800);
  // One reading per day: the 06:00Z (midnight-ish Central) value, else the first that day.
  const perDay = {};
  for (const [t, v] of vals) {
    const day = t.slice(0, 10), hr = t.slice(11, 13);
    if (!perDay[day] || hr === "06") perDay[day] = v;
  }
  const byDay = {};        // "MM-DD" → { "1986": 705.5, ... }
  let max = null, min = null;
  for (const day of Object.keys(perDay).sort()) {
    const v = Math.round(perDay[day] * 100) / 100;
    const md = day.slice(5), y = day.slice(0, 4);
    (byDay[md] = byDay[md] || {})[y] = v;
    if (!max || v > max.v) max = { v, date: day };
    if (!min || v < min.v) min = { v, date: day };
  }
  return { source: "USACE CDA NWK " + LAKE_TS, unit: "ft NGVD29", conservationPool: 706, floodPoolTop: 739.6,
           firstDate: Object.keys(perDay).sort()[0], lastDate: Object.keys(perDay).sort().pop(), days: Object.keys(perDay).length, alltime: { max, min }, byDay };
}

(async () => {
  const out = { built: new Date().toISOString(), note: "Generated by tools/build-climate-data.js — do not hand-edit." };
  for (const [k, fn] of [["tornado", buildTornado], ["freeze", buildFreeze], ["lake", buildLake]]) {
    process.stdout.write(k + "… ");
    try { out[k] = await fn(); console.log("ok"); }
    catch (e) { console.log("FAILED: " + e.message); out[k] = null; }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("wrote " + OUT + " (" + Math.round(fs.statSync(OUT).size / 1024) + " KB)");
  if (out.freeze) console.log("  first fall freeze median " + out.freeze.firstFall.median + " (recent " + out.freeze.firstFall.medianRecent30 + "), last spring " + out.freeze.lastSpring.median);
  if (out.lake) console.log("  lake all-time high " + JSON.stringify(out.lake.alltime.max) + " low " + JSON.stringify(out.lake.alltime.min) + ", " + out.lake.days + " days");
  if (out.tornado) console.log("  tornadoes " + out.tornado.events.length);
})();
