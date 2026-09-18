#!/usr/bin/env node
// preflight.js — "did I break it?" check for Matt's Daily Read.
//
//   node preflight.js            local checks only (syntax + structure). Fast, no network.
//   node preflight.js --live     also probes the deployed worker + GitHub Pages.
//   set ADMIN_KEY=yourpin        (optional) lets --live read /cron-status too.
//
// push.bat runs the local checks first and stops on failure. Exit code 1 = a
// FAIL was found; WARNs never block a deploy.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = __dirname;
const WORKER = "https://rss-proxy.bowonfire2007.workers.dev";
const SITE = "https://bowonfire2007-prog.github.io/news/";
const LIVE = process.argv.includes("--live");
const ADMIN_KEY = process.env.ADMIN_KEY || "";

let fails = 0, warns = 0;
const ok   = (m) => console.log("  ok    " + m);
const warn = (m) => { warns++; console.log("  WARN  " + m); };
const fail = (m) => { fails++; console.log("  FAIL  " + m); };
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// ── 1. Syntax ────────────────────────────────────────────────────────────────
console.log("\n[1] Syntax");
const workerSrc = read("worker.js");
const htmlSrc   = read("index.html");
try {
  // Compile as a module-ish script: strip `export default` so vm.Script accepts it.
  new vm.Script(workerSrc.replace(/^export default\s*\{/m, "const __w = {"), { filename: "worker.js" });
  ok("worker.js compiles");
} catch (e) { fail("worker.js: " + e.message); }

const scripts = [...htmlSrc.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) fail("index.html: no inline <script> found");
scripts.forEach((s, i) => {
  try { new vm.Script(s, { filename: "index.html#script" + (i + 1) }); ok("index.html inline script " + (i + 1) + " compiles (" + Math.round(s.length / 1024) + " KB)"); }
  catch (e) { fail("index.html inline script " + (i + 1) + ": " + e.message); }
});

// ── 2. Structure ─────────────────────────────────────────────────────────────
console.log("\n[2] Structure");
const workerBriefKeys   = [...workerSrc.matchAll(/^\s*\{ key:"([a-z_]+)", title:"[^"]+", icon:/gm)].map(m => m[1]);
const workerTrackerKeys = [...workerSrc.slice(workerSrc.indexOf("const TRACKERS_CONFIG"), workerSrc.indexOf("const BRIEFS_CONFIG")).matchAll(/^\s+key:\s*"([a-z_]+)"/gm)].map(m => m[1]);
const railBlock = (htmlSrc.match(/const TAB_RAIL = \{([\s\S]*?)\n\};/) || [])[1] || "";
const railBriefs   = [...railBlock.matchAll(/type:"brief",\s*key:"([a-z_]+)"/g)].map(m => m[1]);
const railTrackers = [...railBlock.matchAll(/type:"tracker",\s*key:"([a-z_]+)"/g)].map(m => m[1]);
const railData     = [...railBlock.matchAll(/type:"data",\s*id:"([A-Za-z_]+)"/g)].map(m => m[1]);
if (!railBlock) fail("index.html: TAB_RAIL not found");
railBriefs.forEach(k => workerBriefKeys.includes(k) ? ok("brief '" + k + "' exists in worker BRIEFS_CONFIG") : fail("TAB_RAIL brief '" + k + "' has no BRIEFS_CONFIG entry in worker.js"));
railTrackers.forEach(k => (workerTrackerKeys.includes(k) || htmlSrc.includes("\n  " + k + ": [{")) ? ok("tracker '" + k + "' has a config/fallback") : fail("TAB_RAIL tracker '" + k + "' has no TRACKERS_CONFIG or TRACKER_DATA entry"));
railData.forEach(id => htmlSrc.includes("  " + id + ": {") ? ok("data module '" + id + "' defined") : fail("TAB_RAIL data id '" + id + "' missing from DATA_MODULES"));

const cfConst = (htmlSrc.match(/const CF_WORKER = "([^"]+)"/) || [])[1];
cfConst && cfConst.startsWith(WORKER) ? ok("CF_WORKER points at " + WORKER) : fail("CF_WORKER is " + cfConst);

const toml = read("wrangler.toml");
const tomlCrons = ((toml.match(/crons\s*=\s*\[([^\]]*)\]/) || [])[1] || "").match(/"[^"]+"/g) || [];
const codeCrons = [...new Set([...workerSrc.matchAll(/cron === "([^"]+)"/g)].map(m => '"' + m[1] + '"'))];
codeCrons.forEach(c => tomlCrons.includes(c) ? ok("cron " + c + " in wrangler.toml") : fail("worker.js checks cron " + c + " but wrangler.toml doesn't schedule it"));
tomlCrons.forEach(c => codeCrons.includes(c) ? null : warn("wrangler.toml schedules " + c + " but worker.js never handles it"));

const guardPaths = ["/brief", "/followup", "/fishplan", "/cattlemanual"];
guardPaths.forEach(p => workerSrc.includes('"' + p + '"') && /BROWSER_PATHS = new Set\(\[[\s\S]*?\]\)/.test(workerSrc) ? null : warn("guard list missing " + p));
/const ADMIN_PATHS = new Set/.test(workerSrc) ? ok("access guards present") : fail("ADMIN_PATHS guard block missing from worker.js");
/"cattle25"/.test(workerSrc) ? fail("hard-coded fallback PIN is back in worker.js") : ok("no hard-coded PIN");

const mobileIdx = htmlSrc.indexOf("MOBILE CONSOLIDATION");
const styleEnd  = htmlSrc.indexOf("</style>");
if (mobileIdx < 0) warn("MOBILE CONSOLIDATION comment not found in CSS");
else if (mobileIdx > styleEnd) fail("MOBILE CONSOLIDATION block is outside the <style> tag");
else ok("MOBILE CONSOLIDATION block present in stylesheet");

// ── 3. Live ──────────────────────────────────────────────────────────────────
async function live() {
  console.log("\n[3] Live worker (" + WORKER + ")");
  const get = async (p, opts) => {
    const r = await fetch(WORKER + p, { ...opts, signal: AbortSignal.timeout(25000) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    return { status: r.status, json: j, text: t };
  };
  const ageDays = (d) => Math.round((Date.now() - Date.parse(String(d).slice(0, 10) + "T12:00:00Z")) / 86400000);

  // Guards live?
  try {
    const r = await get("/followup", { method: "POST", body: "{}" });
    r.status === 403 ? ok("guards deployed: /followup without Origin → 403") : warn("guards NOT deployed yet: /followup without Origin → " + r.status + " (run push.bat)");
    const a = await get("/tabbriefs-refresh");
    a.status === 403 ? ok("admin gate deployed: /tabbriefs-refresh without key → 403") : warn("admin gate NOT deployed: /tabbriefs-refresh → " + a.status);
  } catch (e) { fail("worker unreachable: " + e.message); return; }

  // Briefs
  try {
    const r = await get("/tabbriefs");
    if (r.status !== 200 || !r.json) fail("/tabbriefs → HTTP " + r.status);
    else for (const k of railBriefs) {
      const b = r.json.briefs[k];
      if (!b) { warn("brief '" + k + "': no card in KV"); continue; }
      const age = ageDays(b.updated), nb = (b.bullets || []).length, nl = (b.bullets || []).filter(x => x.url).length;
      (age >= 2 ? warn : ok)("brief '" + k + "': updated " + b.updated + " (" + age + "d), " + nb + " bullets, " + nl + " linked");
      if (nb && nl === 0) warn("brief '" + k + "': no bullet links to an article");
    }
  } catch (e) { fail("/tabbriefs: " + e.message); }

  // Trackers
  try {
    const r = await get("/trackers");
    if (r.status !== 200 || !r.json) fail("/trackers → HTTP " + r.status);
    else for (const k of railTrackers) {
      const t = Array.isArray(r.json.trackers[k]) ? r.json.trackers[k][0] : r.json.trackers[k];
      if (!t) { warn("tracker '" + k + "': no card in KV"); continue; }
      const age = ageDays(t.updated);
      (age >= 7 ? warn : ok)("tracker '" + k + "': updated " + t.updated + " (" + age + "d) — " + (t.status || "").slice(0, 60));
    }
  } catch (e) { fail("/trackers: " + e.message); }

  // Cheap data endpoints the rail calls
  for (const p of ["/local-bills", "/reps", "/weeklydata?limit=5", "/cattlehistory", "/lake-history", "/history", "/wx-history"]) {
    try { const r = await get(p); (r.status === 200 && r.json ? ok : fail)(p + " → HTTP " + r.status); }
    catch (e) { fail(p + ": " + e.message); }
  }
  for (const p of ["/lake", "/watertemp", "/stockquote?ticker=SPY", "/wx-forecast"]) {
    try {
      const r = await get(p, { headers: { Origin: "https://bowonfire2007-prog.github.io" } });
      (r.status === 200 && r.json && !r.json.error ? ok : warn)(p + " → HTTP " + r.status + (r.json && r.json.error ? " " + r.json.error : ""));
    } catch (e) { warn(p + ": " + e.message); }
  }

  // Google News → Bing translation (worker rewrites news.google.com search feeds)
  try {
    const gn = "https://news.google.com/rss/search?q=%22Truman+Lake%22&hl=en-US&gl=US&ceid=US:en";
    const r = await get("/?url=" + encodeURIComponent(gn), { headers: { Origin: "https://bowonfire2007-prog.github.io" } });
    const n = (r.text.match(/<item>/g) || []).length;
    (r.status === 200 && n > 0 ? ok : warn)("Google News feed via worker → HTTP " + r.status + ", " + n + " items" + (n ? "" : " (translator not deployed, or Bing empty)"));
  } catch (e) { warn("google→bing probe: " + e.message); }

  // Cron heartbeat
  if (ADMIN_KEY) {
    try {
      const r = await get("/cron-status?key=" + encodeURIComponent(ADMIN_KEY));
      if (r.status !== 200 || !r.json) fail("/cron-status → HTTP " + r.status + " (wrong ADMIN_KEY?)");
      else {
        const ev = (r.json.recent_cron_events || []);
        const daily = ev.find(e => e.cron === "0 13 * * *");
        const h = daily ? (Date.now() - Date.parse(daily.at)) / 3600000 : Infinity;
        (h < 26 ? ok : warn)("daily 13:00 UTC cron last fired " + (daily ? Math.round(h) + "h ago" : "never (no record)"));
      }
    } catch (e) { warn("/cron-status: " + e.message); }
  } else warn("set ADMIN_KEY env var to also check the cron heartbeat");

  // Is the live page the same as this folder?
  console.log("\n[4] Live page (" + SITE + ")");
  try {
    const r = await fetch(SITE, { signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    r.status === 200 ? ok("GitHub Pages → 200, " + Math.round(t.length / 1024) + " KB") : fail("GitHub Pages → HTTP " + r.status);
    t === htmlSrc ? ok("live index.html matches this folder") : warn("live index.html differs from this folder (unpushed changes, or Pages still building)");
  } catch (e) { warn("GitHub Pages: " + e.message); }
}

(async () => {
  if (LIVE) await live();
  console.log("\n" + (fails ? "PREFLIGHT FAILED — " + fails + " fail, " + warns + " warn" : "PREFLIGHT PASSED — " + warns + " warn"));
  process.exit(fails ? 1 : 0);
})();
