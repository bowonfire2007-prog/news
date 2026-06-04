// Matt's RSS Proxy + AI Brief — Cloudflare Worker
// Deploy this at workers.cloudflare.com (free account)
//
// One-time setup for the AI Brief feature:
//   1. In your Worker's dashboard → Settings → Variables → Secrets
//   2. Add a secret named:  ANTHROPIC_API_KEY  (paste your Claude API key)
//   3. (Optional) Add a plain variable AI_MODEL — defaults to claude-sonnet-4-5
//
// Endpoints:
//   GET  /?url=<rss_feed_url>     RSS proxy (existing)
//   POST /brief                   AI research brief
//                                 body: { url, title, description?, source? }
//                                 returns: { brief, model, generated_at, cached }
//   GET  /lake                    Truman Lake data scraped from USACE NWK Corps page
//                                 returns: { elevation, inflow, outflow, change24h, ... }
//                                 ?debug=1 returns raw HTML for tuning regex

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

// ─────────────── CRON RUNNERS ─────────────────────────────────────────────────
// Called from the scheduled() handler above.  Both are fire-and-forget — errors
// are swallowed so a bad week doesn't crash the cron entirely.

// Friday ~3pm CST: fetch Wheeler's latest scan, OCR with Claude, save to KV.
async function runWheelerScheduled(env, ctx) {
  try {
    // Bust today's edge cache so we always get a live Claude read, not yesterday's.
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = "cattleprice:wheeler:" + today;
    await caches.default.delete(
      new Request("https://cattleprice-cache.local/" + encodeURIComponent(cacheKey))
    );
    // Re-use the full handleCattlePrice logic by passing a fake URL object.
    // addCattlePriceToKV is already wired into handleCattlePrice for fresh results.
    const fakeUrl = new URL("https://rss-proxy.bowonfire2007.workers.dev/cattleprice?barn=wheeler");
    const fakeCtx = { waitUntil: (p) => p }; // ctx.waitUntil not needed for cron
    await handleCattlePrice(fakeUrl, env, fakeCtx);
  } catch (_) {}
}

// Monday ~9am CST: download newest Missouri weekly PDF, extract with Claude, save to KV.
//
// IMPORTANT — why we don't just hit /Market/pdf/weeklysummary.pdf:
// MDA stopped updating that "latest" alias around April 6, 2026. It still
// serves the April 6 report no matter what. Real reports now live at dated
// URLs only — e.g. /Market/pdf/2026_0518.pdf. To find the newest one we
// scrape the archive index page, which DOES update reliably.
const MO_WEEKLY_LATEST_URL  = "https://agriculture.mo.gov/Market/pdf/weeklysummary.pdf";
const MO_ARCHIVE_URL_FMT    = "https://agriculture.mo.gov/abd/wklymarketarchive.php?cyear=";

// Scrape the archive page → return dated PDF URLs, newest first, plus the
// legacy "latest" URL as a final fallback.
async function findMoWeeklyPdfUrls() {
  const urls = [];
  const seen = new Set();
  const tryYear = async (year) => {
    try {
      const res = await fetch(MO_ARCHIVE_URL_FMT + year, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MoMarketBot/1.0)" }
      });
      if (!res.ok) return;
      const html = await res.text();
      // Match /Market/pdf/YYYY_MMDD.pdf entries. MDA lists newest-first.
      const re = /\/Market\/pdf\/(20\d{2})_(\d{4})\.pdf/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const full = "https://agriculture.mo.gov" + m[0];
        if (!seen.has(full)) { seen.add(full); urls.push(full); }
      }
    } catch (_) {}
  };
  // Try current year, then previous (handles early-January rollover where
  // the new year's archive may not yet have the late-December report).
  const now = new Date();
  await tryYear(now.getFullYear());
  if (now.getMonth() === 0) await tryYear(now.getFullYear() - 1);
  // Final fallback — the legacy "latest" URL. Usually stale but no harm in trying.
  if (!seen.has(MO_WEEKLY_LATEST_URL)) urls.push(MO_WEEKLY_LATEST_URL);
  return urls;
}

// Parse the dated URL pattern /YYYY_MMDD.pdf → "YYYY-MM-DD". Returns null on
// the legacy URL (which has no date hint).
function isoDateFromMoUrl(url) {
  const m = url && url.match(/\/(20\d{2})_(\d{2})(\d{2})\.pdf$/);
  return m ? (m[1] + "-" + m[2] + "-" + m[3]) : null;
}

// Send a single PDF to Claude → extract → save to KV. Returns the saved date
// on success, or null on any failure.
async function extractAndSaveMoWeekly(pdfUrl, env) {
  try {
    const pdfRes = await fetch(pdfUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MoMarketBot/1.0)" }
    });
    if (!pdfRes.ok) return null;
    const pdfBase64 = arrayBufferToBase64(await pdfRes.arrayBuffer());

    const model = env.AI_MODEL || "claude-sonnet-4-5";
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "pdfs-2024-09-25",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
            { type: "text", text: `You are extracting data from a Missouri Weekly Market Summary PDF published by the Missouri Department of Agriculture.

Return ONLY valid JSON (no markdown, no explanation) with EXACTLY these fields:

{
  "report_date": "YYYY-MM-DD",
  "stocker_formula_cwt": <number: Missouri Stocker Formula weighted average price per cwt for 400-649 lb steers>,
  "stocker_formula_weight": <number: weighted average weight in lbs for the stocker formula>,
  "stocker_formula_head": <number: head count in stocker formula>,
  "feeder_steer_500_600_avg_low": <number: average of the LOW ends of the 500-600 lb feeder steer price ranges across ALL Missouri regions listed>,
  "feeder_steer_500_600_avg_high": <number: average of the HIGH ends of the 500-600 lb feeder steer price ranges across ALL Missouri regions listed>,
  "corn_kc_fri": <number: Kansas City Friday corn cash price per bushel, midpoint if a range>,
  "corn_stl_fri": <number: St. Louis Friday corn cash price per bushel, midpoint if a range>,
  "corn_central_fri": <number: Central Missouri Friday corn cash price per bushel, midpoint if a range>,
  "soybean_kc_fri": <number: Kansas City Friday soybean cash price per bushel, midpoint if a range>,
  "soybean_stl_fri": <number: St. Louis Friday soybean cash price per bushel, midpoint if a range>,
  "boxed_beef_choice_5day": <number: 5-day simple average for Choice boxed beef cutout>,
  "boxed_beef_select_5day": <number: 5-day simple average for Select boxed beef cutout>,
  "total_receipts": <integer: total weekly cattle receipts>,
  "week_ago_receipts": <integer: week-ago cattle receipts>,
  "year_ago_receipts": <integer: year-ago cattle receipts>,
  "market_narrative": "<2-3 sentence plain-English summary of the week's market conditions from the main weekly summary section>"
}

Use null for any field you cannot find. For the 500-600 lb ranges, average ONLY across regions that explicitly list a 500-600 lb steer line (skip any region that doesn't list it).` }
          ]
        }]
      })
    });
    if (!claudeRes.ok) return null;

    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    let extracted;
    try {
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      extracted = JSON.parse(cleaned);
    } catch { return null; }
    if (!extracted.report_date || !/^\d{4}-\d{2}-\d{2}$/.test(extracted.report_date)) return null;

    const record = { ...extracted, uploaded_at: new Date().toISOString(), model, source: "scheduled", pdf_url: pdfUrl };
    const kvKey = "weekly:" + extracted.report_date;
    await env.WEEKLY_KV.put(kvKey, JSON.stringify(record), { expirationTtl: 4 * 365 * 24 * 3600 });

    const indexRaw = await env.WEEKLY_KV.get("weekly:index");
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    if (!index.includes(extracted.report_date)) {
      index.push(extracted.report_date);
      index.sort();
      await env.WEEKLY_KV.put("weekly:index", JSON.stringify(index), { expirationTtl: 4 * 365 * 24 * 3600 });
    }
    await caches.default.delete(new Request("https://weeklydata-cache.local/v1/limit=300"));
    return extracted.report_date;
  } catch (_) {
    return null;
  }
}

async function runMissouriScheduled(env, ctx) {
  try {
    if (!env.ANTHROPIC_API_KEY || !env.WEEKLY_KV) return;

    // Snapshot the index up-front so we can skip URLs whose date we already have.
    const indexRaw = await env.WEEKLY_KV.get("weekly:index");
    const index = indexRaw ? JSON.parse(indexRaw) : [];
    const knownDates = new Set(index);

    const urls = await findMoWeeklyPdfUrls();
    // Walk newest-first. Skip URLs whose date is already in KV. Stop at the
    // first successful new save — no need to re-fetch every older report.
    for (const pdfUrl of urls) {
      const urlDate = isoDateFromMoUrl(pdfUrl);
      if (urlDate && knownDates.has(urlDate)) continue;
      const savedDate = await extractAndSaveMoWeekly(pdfUrl, env);
      if (savedDate && !knownDates.has(savedDate)) return; // new report saved, done
    }
  } catch (_) {}
}

// Manual-trigger HTTP endpoint. Hit GET /weeklyrefresh to force a fetch.
// Returns JSON detailing what was tried + what got saved, so you can debug
// without staring at Cloudflare's cron logs.
async function handleWeeklyRefresh(request, env, ctx) {
  if (!env.ANTHROPIC_API_KEY || !env.WEEKLY_KV) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY or WEEKLY_KV not configured" }, 500);
  }
  const indexRaw = await env.WEEKLY_KV.get("weekly:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  const knownDates = new Set(index);

  const urls = await findMoWeeklyPdfUrls();
  const tried = [];
  let saved = null;

  for (const pdfUrl of urls) {
    const urlDate = isoDateFromMoUrl(pdfUrl);
    if (urlDate && knownDates.has(urlDate)) {
      tried.push({ url: pdfUrl, urlDate, action: "skipped-already-have" });
      continue;
    }
    const savedDate = await extractAndSaveMoWeekly(pdfUrl, env);
    if (savedDate && !knownDates.has(savedDate)) {
      tried.push({ url: pdfUrl, urlDate, savedDate, action: "saved-new" });
      saved = savedDate;
      break;
    } else if (savedDate) {
      tried.push({ url: pdfUrl, urlDate, savedDate, action: "claude-returned-known-date" });
    } else {
      tried.push({ url: pdfUrl, urlDate, action: "fetch-or-parse-failed" });
    }
  }
  return jsonResponse({
    saved,
    discovered_urls: urls.length,
    already_known_dates: index.length,
    attempts: tried
  }, 200);
}


export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (url.pathname === "/brief") {
      return handleBrief(request, env, ctx);
    }
    if (url.pathname === "/lake") {
      return handleLake(url, ctx);
    }
    if (url.pathname === "/fishplan") {
      return handleFishPlan(request, env, ctx);
    }
    if (url.pathname === "/cattleprice") {
      return handleCattlePrice(url, env, ctx);
    }
    if (url.pathname === "/cattlemanual") {
      return handleCattleManual(request, env, ctx);
    }
    if (url.pathname === "/cattlehistory") {
      return handleCattleHistory(url, env, ctx);
    }
    if (url.pathname === "/cattlerecord") {
      return handleCattleRecord(request, env, ctx);
    }
    if (url.pathname === "/followup") {
      return handleFollowUp(request, env);
    }
    if (url.pathname === "/weeklyupload") {
      return handleWeeklyUpload(request, env, ctx);
    }
    if (url.pathname === "/weeklydata") {
      return handleWeeklyData(url, env, ctx);
    }
    if (url.pathname === "/weeklyrefresh") {
      // Manual trigger — runs the same logic as the Monday cron. Hit this URL
      // from a browser any time you want to force-pull the newest MDA report.
      // Returns JSON listing every URL the worker tried + what date got saved.
      return handleWeeklyRefresh(request, env, ctx);
    }
    if (url.pathname === "/watertemp") {
      return handleWaterTemp(url, ctx);
    }
    if (url.pathname === "/lake-reading") {
      return handleLakeReading(request, env, ctx);
    }
    if (url.pathname === "/lake-history") {
      return handleLakeHistory(url, env, ctx);
    }
    // ── Stock Analysis endpoints (Finnhub-backed) ──
    if (url.pathname === "/stockquote")   return handleStockQuote(url, env, ctx);
    if (url.pathname === "/stockcandles") return handleStockCandles(url, env, ctx);
    if (url.pathname === "/stocknews")    return handleStockNews(url, env, ctx);
    if (url.pathname === "/stockforecast") return handleStockForecast(url, env, ctx);
    if (url.pathname === "/stockbrief")   return handleStockBrief(request, env, ctx);
    return handleRssProxy(url);
  },

  // ── Cloudflare Cron Triggers ───────────────────────────────────────────────
  // Schedules (UTC — Missouri is CST = UTC-6, CDT = UTC-5):
  //   "0 21 * * 5"  →  Friday   3 pm CST / 4 pm CDT  — Wheeler auto-fetch
  //   "0 15 * * 1"  →  Monday   9 am CST / 10 am CDT  — Missouri weekly report
  //   "0 18 * * 2"  →  Tuesday  noon CST / 1 pm CDT  — backup pull (holiday weeks)
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    if (cron === "0 21 * * 5") ctx.waitUntil(runWheelerScheduled(env, ctx));
    if (cron === "0 15 * * 1") ctx.waitUntil(runMissouriScheduled(env, ctx));
    if (cron === "0 18 * * 2") ctx.waitUntil(runMissouriScheduled(env, ctx));
  }
};

// ─────────────── AI FISHING SMART PLAN ───────────────
// Takes today's actual lake/weather conditions and asks Claude Sonnet to write a
// custom fishing plan tuned to Truman Lake / Sparrowfoot Park / Grand River arm.
// Cached 6h by a hash of the conditions so a stable forecast period doesn't re-bill.
async function handleFishPlan(request, env, ctx) {
  if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY secret is not set" }, 500);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  // Build a stable cache key from the rounded condition snapshot — small wobble in
  // wind speed shouldn't bust the cache. Round elevation/temp/wind to coarse bins.
  const snap = {
    elev:    body.lake?.stage    !== undefined ? Math.round(body.lake.stage * 2) / 2 : null,
    chg:     body.lake?.dailyChange !== undefined ? Math.round(body.lake.dailyChange * 4) / 4 : null,
    inflow:  body.lake?.inflow   !== undefined ? Math.round((body.lake.inflow  || 0) / 1000) : null,
    outflow: body.lake?.outflow  !== undefined ? Math.round((body.lake.outflow || 0) / 1000) : null,
    wDir:    body.wind?.dir || null,
    wSpd:    body.wind?.speed !== undefined ? Math.round(body.wind.speed / 5) * 5 : null,
    temp:    body.weather?.temp !== undefined ? Math.round(body.weather.temp / 5) * 5 : null,
    cond:    body.weather?.condition || null,
    month:   new Date().getUTCMonth() + 1
  };
  const cacheKey = await hashKey("fishplan:" + JSON.stringify(snap));
  const cache = caches.default;
  const cacheReq = new Request("https://fishplan-cache.local/" + cacheKey, { method: "GET" });
  const cached = await cache.match(cacheReq);
  if (cached) {
    const cachedJson = await cached.json();
    return jsonResponse({ ...cachedJson, cached: true });
  }

  const prompt = buildFishPlanPrompt(body);
  const model = env.AI_MODEL || "claude-sonnet-4-5";

  let claudeRes;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch (err) {
    return jsonResponse({ error: "Claude fetch failed: " + err.message }, 502);
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: "Claude API " + claudeRes.status, details: errText.slice(0, 600) }, 502);
  }

  const data = await claudeRes.json();
  const planText = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text).join("\n\n").trim();

  if (!planText) {
    return jsonResponse({ error: "Empty response", stop_reason: data.stop_reason || null }, 502);
  }

  const result = { plan: planText, model, generated_at: new Date().toISOString(), conditions: snap };
  const cacheRes = new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=21600" } // 6h
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));

  return jsonResponse({ ...result, cached: false });
}

function buildFishPlanPrompt(b) {
  const lake    = b.lake    || {};
  const wx      = b.weather || {};
  const wind    = b.wind    || {};
  const moon    = b.moon    || {};
  const sol     = b.solunar || {};
  const baro    = b.baro    || null;
  const history = Array.isArray(b.lakeHistory)    ? b.lakeHistory    : [];
  const catches = Array.isArray(b.recentCatches)  ? b.recentCatches  : [];

  // Determine the target date/time and month
  const targetDate = b.targetDateTime ? new Date(b.targetDateTime) : new Date();
  const monthNum  = targetDate.getUTCMonth() + 1;
  const monthName = targetDate.toLocaleDateString("en-US", { month: "long" });
  const targetLabel = b.targetLabel || targetDate.toLocaleString("en-US", { weekday:"long", month:"short", day:"numeric", hour:"numeric", minute:"2-digit" });

  // ── Conditions block ──
  const lines = [];
  if (Number.isFinite(lake.stage))       lines.push(`Pool elevation: ${lake.stage.toFixed(1)} ft (normal pool 706.0 ft, flood pool 739.6 ft)`);
  if (Number.isFinite(lake.dailyChange)) lines.push(`24h change: ${lake.dailyChange >= 0 ? "+" : ""}${lake.dailyChange.toFixed(2)} ft (${lake.dailyChange < -0.1 ? "falling" : lake.dailyChange > 0.1 ? "rising" : "stable"})`);
  if (Number.isFinite(lake.inflow) && Number.isFinite(lake.outflow)) {
    const net = lake.inflow - lake.outflow;
    lines.push(`Inflow: ${lake.inflow.toLocaleString()} cfs / Outflow: ${lake.outflow.toLocaleString()} cfs (net ${net >= 0 ? "+" : ""}${net.toLocaleString()} cfs — dam ${net < -2000 ? "releasing hard" : net > 2000 ? "holding back" : "near balance"})`);
  }
  if (Number.isFinite(b.waterTempF)) lines.push(`Water temp: ${b.waterTempF}°F (USGS)`);
  if (wind.dir)                      lines.push(`Wind: ${wind.dir}${Number.isFinite(wind.speed) ? " " + Math.round(wind.speed) + " mph" : ""}${Number.isFinite(wind.sustainedHours) ? ", sustained " + wind.sustainedHours + "h" : ""}`);
  if (Number.isFinite(wx.temp))      lines.push(`Air temp: ${Math.round(wx.temp)}°F${Number.isFinite(wx.feels) ? " (feels " + Math.round(wx.feels) + "°)" : ""}`);
  if (wx.condition)                  lines.push(`Sky: ${wx.condition}`);
  if (Number.isFinite(wx.humidity))  lines.push(`Humidity: ${wx.humidity}%`);

  // ── Barometric pressure ──
  const baroLine = baro
    ? `Barometer: ${baro.pressure} hPa — ${baro.trend} (${baro.change > 0 ? "+" : ""}${baro.change} hPa / 6h)`
    : "";

  // ── Moon & solunar ──
  const moonLine = moon.phaseName
    ? `Moon: ${moon.emoji || ""} ${moon.phaseName}, ${moon.illumination}% illuminated, day ${Math.floor(moon.age || 0)} of cycle`
    : "";
  const solLines = (sol.major1 && sol.major2) ? [
    `Solunar major feed windows: ${sol.major1} and ${sol.major2} (peak activity — plan to be on the water)`,
    `Solunar minor feed windows: ${sol.minor1} and ${sol.minor2}`
  ] : [];

  // ── Multi-week lake trend ──
  const historyLines = [];
  if (history.length >= 3) {
    const oldest = history[0], newest = history[history.length - 1];
    const daySpan = Math.max(1, Math.round((new Date(newest.date) - new Date(oldest.date)) / 86400000));
    const totalChange = newest.elevation - oldest.elevation;
    const trendWord = totalChange < -0.3 ? "falling" : totalChange > 0.3 ? "rising" : "stable";
    historyLines.push(`${daySpan}-day trend: ${trendWord} ${Math.abs(totalChange).toFixed(1)} ft total — from ${oldest.elevation.toFixed(1)} ft to ${newest.elevation.toFixed(1)} ft`);
    let fallingStreak = 0, risingStreak = 0;
    for (let i = history.length - 1; i > 0; i--) { if (history[i].elevation < history[i-1].elevation - 0.02) fallingStreak++; else break; }
    for (let i = history.length - 1; i > 0; i--) { if (history[i].elevation > history[i-1].elevation + 0.02) risingStreak++; else break; }
    if (fallingStreak >= 3) historyLines.push(`${fallingStreak} consecutive falling days — fish pulling off bank cover, staging on channel edges and main-lake points`);
    else if (risingStreak >= 3) historyLines.push(`${risingStreak} consecutive rising days — fish moving into flooded timber and shallow flats`);
  }

  // ── Spawn calendar ──
  const spawningNotes = {
    3:  "Pre-spawn (Mar): water warming 40s→50s°F. Blues feeding hard pre-spawn. Crappie moving shallow. Shad schooling near surface.",
    4:  "Spawn ramp-up (Apr): crappie spawn triggers at 60°F on shallow brush. Blue cat pre-spawn feeding binge — best blue cat bite of the year approaching. Shad schooling in coves.",
    5:  "Peak spawn (May): crappie full spawn 2-6 ft on brush when water hits 60°F+. Blues move to spawn at 70-75°F on rocky banks and timber edges. Gizzard shad spawn May-June (65°F+) — fresh shad concentrated and ideal cutbait. Flatheads turning on.",
    6:  "Post-spawn (Jun): crappie retreat to 8-15 ft. Blues and flatheads guarding nests then recovering. Summer pattern establishing. Shad scattered.",
    7:  "Summer (Jul): blues stacked in current below dam and deep channel bends. Crappie suspended 10-20 ft. Night bite prime for flatheads on live bream.",
    8:  "Late summer (Aug): oxygen stratification — fish at thermocline or in current. Blues concentrate in main channel below Truman Dam outflow.",
    9:  "Fall transition (Sep): cooling water triggers feed-up. Blue cat fall binge starts — one of the best times of year. Crappie moving shallower. Shad schooling again.",
    10: "Peak fall (Oct): 55-65°F water, excellent blue cat action. Crappie stacking on brush 8-15 ft. Shad tightly schooled — ideal cast-netting.",
    11: "Late fall (Nov): water cooling to 50s. Blues and crappie still active but slowing. Best bite mid-afternoon on sunny days.",
    12: "Winter (Dec): water 40-50°F. Blues on deep channel ledges 20-30 ft. Crappie tight to structure 15-25 ft. Slow presentations.",
    1:  "Deep winter (Jan): water 38-45°F. Blues in deep holes. Crappie barely moving. Best bite near dam outflow at midday.",
    2:  "Late winter (Feb): blues beginning to stir. Crappie staging near spawning structure by end of month."
  };
  const spawnNote = spawningNotes[monthNum] || "";

  // ── Recent catches from trip log ──
  const catchSection = catches.length
    ? `\nANGLER'S RECENT CATCHES (use to spot patterns):\n${catches.map(c => `- ${c}`).join("\n")}`
    : "";

  return `You are an expert fishing guide for Truman Lake in west-central Missouri. The angler fishes from Sparrowfoot Park on the Grand River arm and has access to BOTH boat and bank.

TARGET SPECIES (these only — do NOT recommend largemouth bass, walleye, or white bass):
- Blue catfish (the headliner — this lake is famous for them)
- Flathead catfish
- Crappie (black and white)
- Gizzard shad — for cast-netting bait
- Bluegill — only in nearby farm ponds, not the lake

PLAN FOR: ${targetLabel} (${monthName})

LAKE & WEATHER CONDITIONS:
${lines.join("\n")}
${baroLine ? baroLine : ""}

MOON & SOLUNAR:
${moonLine}
${solLines.join("\n")}

LAKE LEVEL HISTORY:
${historyLines.length ? historyLines.join("\n") : "Not enough history yet."}

SEASONAL CONTEXT:
${spawnNote}
${catchSection}

Write a tight, specific fishing plan in 2-3 short paragraphs of plain prose. NO bullet points, NO headers, NO markdown. Open by naming the best species AND timing for the planned trip date/time — if the solunar major window overlaps their planned time, say so and emphasize it. Explain why given today's lake state AND the multi-week trend (if falling for many days, say fish have relocated). Include exact technique: bait type, rig, depth, retrieve. Factor in spawn phase — crappie on beds needs a different approach than blues on a post-spawn summer pattern. Name specific spots on the Grand River arm near Sparrowfoot. If the angler has recent catches logged, reference the pattern if it helps. End with whether tonight, tomorrow morning, or another window this week looks better based on solunar and conditions. ~175-220 words.`;
}

// ─────────────── FOLLOW-UP Q&A ───────────────
// Answers follow-up questions about an article using the already-generated brief as context.
// No web search needed — Claude reasons from the brief + conversation history.
//   POST /followup
//   body: { title, url, brief, question, history: [{q, a}] }
//   returns: { answer, model, generated_at }
async function handleFollowUp(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY secret is not set" }, 500);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const { title, url: articleUrl, brief, question, history = [] } = body;
  if (!question || !brief) return jsonResponse({ error: "question and brief are required" }, 400);

  const system = `You are a news research assistant. The user is reading a news article and asking follow-up questions. Answer clearly and concisely in plain prose — no bullet points or headers unless explicitly requested. Stay grounded in the brief and your general knowledge; if you don't know something, say so.

Article: "${(title || "").slice(0, 200)}"
${articleUrl ? "URL: " + articleUrl : ""}

Research brief already generated for this article:
${brief}`;

  // Build multi-turn conversation
  const messages = [];
  for (const { q, a } of history) {
    messages.push({ role: "user", content: q });
    messages.push({ role: "assistant", content: a });
  }
  messages.push({ role: "user", content: question });

  const model = env.AI_MODEL || "claude-haiku-4-5-20251001";

  let claudeRes;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({ model, max_tokens: 600, system, messages })
    });
  } catch (err) {
    return jsonResponse({ error: "Claude fetch failed: " + err.message }, 502);
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: "Claude API " + claudeRes.status, details: errText.slice(0, 300) }, 502);
  }

  const data = await claudeRes.json();
  const answer = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n\n").trim();
  if (!answer) return jsonResponse({ error: "Empty response from model" }, 502);

  return jsonResponse({ answer, model, generated_at: new Date().toISOString() });
}

// ─────────────── TRUMAN LAKE WATER TEMPERATURE ───────────────
// Scrapes LakeMonster's server-rendered og:description tag which contains the
// current surface water temp for Harry S. Truman Reservoir.
// Cached 3 hours — water temp doesn't change that fast.
//   GET /watertemp  →  { tempF, source, fetched_at, cached }
async function handleWaterTemp(url, ctx) {
  const cache = caches.default;
  const cacheReq = new Request("https://watertemp-cache.local/truman-v1", { method: "GET" });

  const cached = await cache.match(cacheReq);
  if (cached) {
    const j = await cached.json();
    return jsonResponse({ ...j, cached: true });
  }

  let tempF = null;
  try {
    const res = await fetch(
      "https://lakemonster.com/lake/Missouri-lakes/Harry-S.-Truman-Reservoir-water-temperature-650",
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; NewsBot/1.0)" } }
    );
    if (res.ok) {
      const html = await res.text();
      // og:description contains e.g. 'Water temp: 65°F - Perfect for fishing!'
      const m = html.match(/Water temp:\s*(\d+)°F/i);
      if (m) tempF = parseInt(m[1], 10);
    }
  } catch {}

  if (tempF === null) {
    return jsonResponse({ error: "Could not parse water temp from LakeMonster" }, 502);
  }

  const result = { tempF, source: "LakeMonster / Harry S. Truman Reservoir", fetched_at: new Date().toISOString() };
  const cacheRes = new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10800" } // 3h
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));

  return jsonResponse({ ...result, cached: false });
}

// ─────────────── LAKE LEVEL HISTORY ───────────────
// Stores one lake reading per day in WEEKLY_KV under "lake:history".
// Keeps the last 365 daily readings. Used by the AI fish plan for multi-week trend context.
//   POST /lake-reading  body: { elevation, inflow, outflow }
//   GET  /lake-history  returns: { readings: [{date, ts, elevation, inflow, outflow}], count }

const LAKE_HISTORY_KEY = "lake:history";

async function handleLakeReading(request, env, ctx) {
  if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  if (!env.WEEKLY_KV) return jsonResponse({ error: "WEEKLY_KV not bound" }, 500);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const { elevation, inflow, outflow } = body;
  if (!Number.isFinite(elevation)) return jsonResponse({ error: "elevation required" }, 400);

  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  let history = [];
  try {
    const raw = await env.WEEKLY_KV.get(LAKE_HISTORY_KEY);
    if (raw) history = JSON.parse(raw);
  } catch {}

  const existing = history.find(r => r.date === today);
  if (existing) {
    const ageH = (Date.now() - existing.ts) / 3600000;
    if (ageH < 1) return jsonResponse({ ok: true, skipped: true, count: history.length });
    // Update if it's been more than 1 hour (better reading later in the day)
    existing.elevation = elevation;
    if (Number.isFinite(inflow))  existing.inflow  = inflow;
    if (Number.isFinite(outflow)) existing.outflow = outflow;
    existing.ts = Date.now();
  } else {
    history.push({
      date: today,
      ts: Date.now(),
      elevation,
      inflow:  Number.isFinite(inflow)  ? inflow  : null,
      outflow: Number.isFinite(outflow) ? outflow : null
    });
  }

  // Keep sorted, trim to last 365 days
  history.sort((a, b) => a.date.localeCompare(b.date));
  if (history.length > 365) history = history.slice(-365);

  ctx.waitUntil(env.WEEKLY_KV.put(LAKE_HISTORY_KEY, JSON.stringify(history), {
    expirationTtl: 2 * 365 * 24 * 3600
  }));

  return jsonResponse({ ok: true, count: history.length });
}

async function handleLakeHistory(url, env, ctx) {
  if (!env.WEEKLY_KV) return jsonResponse({ error: "WEEKLY_KV not bound" }, 500);

  const limit = Math.min(parseInt(url.searchParams.get("limit") || "365", 10), 365);

  let history = [];
  try {
    const raw = await env.WEEKLY_KV.get(LAKE_HISTORY_KEY);
    if (raw) history = JSON.parse(raw);
  } catch {}

  const readings = history.slice(-limit);
  return jsonResponse({ readings, count: readings.length });
}

// ─────────────── STOCK ANALYSIS (Finnhub) ─────────────────────────────────────
//
// Primary data provider: Finnhub (FINNHUB_API_KEY secret).
// To swap to Alpha Vantage: replace fetch URLs with:
//   https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=TICKER&apikey=AV_API_KEY
//   https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=TICKER&outputsize=full&apikey=AV_API_KEY
// To swap to Twelve Data: replace with:
//   https://api.twelvedata.com/quote?symbol=TICKER&apikey=TWELVE_DATA_KEY
//   https://api.twelvedata.com/time_series?symbol=TICKER&interval=1day&outputsize=DAYS&apikey=TWELVE_DATA_KEY
//
// All endpoints cache aggressively: quotes 60s, candles 1h, news 2h, forecast 4h, brief 6h.

// GET /stockquote?ticker=AAPL
// Returns current price, daily change, 52w high/low, company name + industry.
async function handleStockQuote(url, env, ctx) {
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase().trim();
  if (!ticker) return jsonResponse({ error: "ticker required" }, 400);
  if (!env.FINNHUB_API_KEY) return jsonResponse({ error: "FINNHUB_API_KEY not set" }, 500);

  const cache = caches.default;
  const cacheReq = new Request("https://stockquote-cache.local/" + encodeURIComponent(ticker));
  const cached = await cache.match(cacheReq);
  if (cached) return jsonResponse({ ...(await cached.json()), cached: true });

  const base = "https://finnhub.io/api/v1";
  const tok  = env.FINNHUB_API_KEY;

  // Fetch quote + company profile + 52w metrics in parallel
  const [quoteRes, profileRes, metricRes] = await Promise.all([
    fetch(`${base}/quote?symbol=${encodeURIComponent(ticker)}&token=${tok}`),
    fetch(`${base}/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${tok}`),
    fetch(`${base}/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${tok}`)
  ]);

  if (!quoteRes.ok) return jsonResponse({ error: "Finnhub quote HTTP " + quoteRes.status }, 502);
  const [quote, profile, metric] = await Promise.all([
    quoteRes.json(),
    profileRes.ok ? profileRes.json() : {},
    metricRes.ok  ? metricRes.json()  : {}
  ]);

  if (!quote || quote.c == null) return jsonResponse({ error: "No quote data" }, 502);

  // Finnhub quote: c=current, d=change, dp=changePct, h=dayHigh, l=dayLow, o=open, pc=prevClose, t=timestamp
  const result = {
    ticker,
    name:       profile.name      || ticker,
    exchange:   profile.exchange  || "",
    industry:   profile.finnhubIndustry || "",
    price:      quote.c,
    change:     quote.d,
    changePct:  quote.dp,
    high:       quote.h,
    low:        quote.l,
    open:       quote.o,
    prevClose:  quote.pc,
    timestamp:  quote.t,
    week52High: metric?.metric?.["52WeekHigh"] ?? null,
    week52Low:  metric?.metric?.["52WeekLow"]  ?? null,
    source: "Finnhub"
  };

  const cacheRes = new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" }
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));
  return jsonResponse({ ...result, cached: false });
}

// GET /stockcandles?ticker=AAPL&range=1Y
// Returns daily OHLCV candles via Yahoo Finance (free, no key required).
// Range: 1M / 6M / 1Y / 5Y
async function handleStockCandles(url, env, ctx) {
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase().trim();
  const range  = url.searchParams.get("range") || "1Y";
  if (!ticker) return jsonResponse({ error: "ticker required" }, 400);

  const cache = caches.default;
  const cacheReq = new Request("https://stockcandles-cache2.local/" + encodeURIComponent(ticker + ":" + range));
  const cached = await cache.match(cacheReq);
  if (cached) return jsonResponse({ ...(await cached.json()), cached: true });

  // Yahoo Finance chart API — free, no key, supports 1mo/6mo/1y/5y ranges
  const RANGE_MAP = { "1M": "1mo", "6M": "6mo", "YTD": "ytd", "1Y": "1y", "5Y": "5y", "MAX": "max" };
  const yhRange = RANGE_MAP[range] || "1y";
  const yhUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${yhRange}`;

  const res = await fetch(yhUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "application/json, */*"
    }
  });
  if (!res.ok) return jsonResponse({ error: "Yahoo candles HTTP " + res.status }, 502);

  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r || !r.timestamp) return jsonResponse({ error: "No candle data for " + ticker }, 404);

  const q = r.indicators?.quote?.[0] || {};
  const timestamps = r.timestamp;
  const candles = timestamps
    .map((t, i) => ({
      time:   t,
      open:   q.open?.[i]   != null ? +q.open[i].toFixed(4)   : null,
      high:   q.high?.[i]   != null ? +q.high[i].toFixed(4)   : null,
      low:    q.low?.[i]    != null ? +q.low[i].toFixed(4)     : null,
      close:  q.close?.[i]  != null ? +q.close[i].toFixed(4)  : null,
      volume: q.volume?.[i] != null ? Math.round(q.volume[i]) : 0
    }))
    .filter(c => c.open != null && c.close != null)
    .sort((a, b) => a.time - b.time);

  const result = { ticker, range, candles, count: candles.length, source: "Yahoo" };
  const cacheRes = new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" }
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));
  return jsonResponse({ ...result, cached: false });
}

// GET /stocknews?ticker=AAPL
// Returns last 90 days of company news from Finnhub, capped at 50 items.
async function handleStockNews(url, env, ctx) {
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase().trim();
  if (!ticker) return jsonResponse({ error: "ticker required" }, 400);
  if (!env.FINNHUB_API_KEY) return jsonResponse({ error: "FINNHUB_API_KEY not set" }, 500);

  const cache = caches.default;
  const cacheReq = new Request("https://stocknews-cache.local/" + encodeURIComponent(ticker));
  const cached = await cache.match(cacheReq);
  if (cached) return jsonResponse({ ...(await cached.json()), cached: true });

  const now     = new Date();
  const toDate  = now.toISOString().slice(0, 10);
  const fromDate = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
  const tok     = env.FINNHUB_API_KEY;

  // ── Provider: Finnhub /company-news ──
  // Alpha Vantage swap: GET /query?function=NEWS_SENTIMENT&tickers=TICKER&apikey=AV_API_KEY
  const res = await fetch(
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${fromDate}&to=${toDate}&token=${tok}`
  );
  if (!res.ok) return jsonResponse({ error: "Finnhub news HTTP " + res.status }, 502);

  const data = await res.json();
  if (!Array.isArray(data)) return jsonResponse({ error: "Unexpected response format" }, 502);

  const news = data.slice(0, 50).map(n => ({
    headline: n.headline,
    summary:  n.summary  || "",
    url:      n.url,
    source:   n.source   || "",
    datetime: n.datetime   // unix seconds
  }));

  const result = { ticker, news, count: news.length, source: "Finnhub" };
  const cacheRes = new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=7200" }
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));
  return jsonResponse({ ...result, cached: false });
}

// GET /stockforecast?ticker=AAPL
// Returns analyst recs, price targets, recent earnings, and next earnings date.
async function handleStockForecast(url, env, ctx) {
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase().trim();
  if (!ticker) return jsonResponse({ error: "ticker required" }, 400);
  if (!env.FINNHUB_API_KEY) return jsonResponse({ error: "FINNHUB_API_KEY not set" }, 500);

  const cache = caches.default;
  const cacheReq = new Request("https://stockforecast-cache.local/" + encodeURIComponent(ticker));
  const cached = await cache.match(cacheReq);
  if (cached) return jsonResponse({ ...(await cached.json()), cached: true });

  const tok      = env.FINNHUB_API_KEY;
  const now      = new Date();
  const fromDate = now.toISOString().slice(0, 10);
  const toDate   = new Date(now.getTime() + 90 * 86400000).toISOString().slice(0, 10);

  // ── Provider: Finnhub — all fetched in parallel ──
  // Alpha Vantage swap: /query?function=EARNINGS&symbol=TICKER&apikey=AV_API_KEY (no analyst recs)
  const [recsRes, targetRes, earningsRes, calRes] = await Promise.all([
    fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${encodeURIComponent(ticker)}&token=${tok}`),
    fetch(`https://finnhub.io/api/v1/stock/price-target?symbol=${encodeURIComponent(ticker)}&token=${tok}`),
    fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(ticker)}&limit=8&token=${tok}`),
    fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(ticker)}&from=${fromDate}&to=${toDate}&token=${tok}`)
  ]);

  const [recs, target, earnings, cal] = await Promise.all([
    recsRes.ok    ? recsRes.json()    : [],
    targetRes.ok  ? targetRes.json()  : {},
    earningsRes.ok ? earningsRes.json() : [],
    calRes.ok     ? calRes.json()     : {}
  ]);

  const latestRec = Array.isArray(recs) && recs.length ? recs[0] : null;
  const nextE = (cal?.earningsCalendar || []).find(e => e.date >= fromDate) || null;

  const result = {
    ticker,
    recommendation: latestRec ? {
      period:    latestRec.period,
      strongBuy: latestRec.strongBuy,
      buy:       latestRec.buy,
      hold:      latestRec.hold,
      sell:      latestRec.sell,
      strongSell: latestRec.strongSell
    } : null,
    priceTarget: (target?.targetHigh) ? {
      high:     target.targetHigh,
      low:      target.targetLow,
      mean:     target.targetMean,
      median:   target.targetMedian,
      analysts: target.numberOfAnalysts || null
    } : null,
    earnings: Array.isArray(earnings) ? earnings.slice(0, 8).map(e => ({
      period:      e.period,
      actual:      e.actual,
      estimate:    e.estimate,
      surprise:    e.surprise,
      surprisePct: e.surprisePercent
    })) : [],
    nextEarnings: nextE ? {
      date:            nextE.date,
      epsEstimate:     nextE.epsEstimate     ?? null,
      revenueEstimate: nextE.revenueEstimate ?? null,
      quarter:         nextE.quarter,
      year:            nextE.year
    } : null,
    source: "Finnhub"
  };

  const cacheRes = new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=14400" }
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));
  return jsonResponse({ ...result, cached: false });
}

// POST /stockbrief
// Body: { ticker, name, price, changePct, weekHigh, weekLow, yoyPct, news, forecast }
// Returns a 2-3 sentence AI "what's the chart and news saying" blurb, cached 6h per day.
async function handleStockBrief(request, env, ctx) {
  if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY not set" }, 500);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  const { ticker } = body;
  if (!ticker) return jsonResponse({ error: "ticker required" }, 400);

  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = await hashKey("stockbrief:" + ticker + ":" + today);
  const cache = caches.default;
  const cacheReq = new Request("https://stockbrief-cache.local/" + cacheKey);
  const cached = await cache.match(cacheReq);
  if (cached) return jsonResponse({ ...(await cached.json()), cached: true });

  const model = env.AI_MODEL || "claude-haiku-4-5-20251001";
  let claudeRes;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        messages: [{ role: "user", content: buildStockBriefPrompt(body) }]
      })
    });
  } catch (err) {
    return jsonResponse({ error: "Claude fetch failed: " + err.message }, 502);
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: "Claude API " + claudeRes.status, details: errText.slice(0, 300) }, 502);
  }

  const data = await claudeRes.json();
  const brief = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n\n").trim();
  if (!brief) return jsonResponse({ error: "Empty response from model" }, 502);

  const result = { brief, model, generated_at: new Date().toISOString() };
  const cacheRes = new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=21600" }
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));
  return jsonResponse({ ...result, cached: false });
}

function buildStockBriefPrompt(b) {
  const { ticker, name, price, changePct, weekHigh, weekLow, yoyPct, news, forecast } = b;
  const lines = [];
  lines.push(`Ticker: ${ticker}${name && name !== ticker ? " (" + name + ")" : ""}`);
  if (price != null) lines.push(`Current price: $${Number(price).toFixed(2)} (${changePct >= 0 ? "+" : ""}${Number(changePct || 0).toFixed(2)}% today)`);
  if (weekHigh && weekLow) lines.push(`52-week range: $${Number(weekLow).toFixed(2)} – $${Number(weekHigh).toFixed(2)}`);
  if (yoyPct != null) lines.push(`YoY performance: ${yoyPct >= 0 ? "+" : ""}${Number(yoyPct).toFixed(1)}%`);
  const pt = forecast?.priceTarget;
  if (pt?.mean) lines.push(`Analyst price target: low $${Number(pt.low).toFixed(2)}, mean $${Number(pt.mean).toFixed(2)}, high $${Number(pt.high).toFixed(2)}${pt.analysts ? " (" + pt.analysts + " analysts)" : ""}`);
  const rec = forecast?.recommendation;
  if (rec) {
    const buy = (rec.strongBuy || 0) + (rec.buy || 0);
    lines.push(`Analyst consensus (${rec.period}): ${buy} buy, ${rec.hold || 0} hold, ${(rec.sell || 0) + (rec.strongSell || 0)} sell`);
  }
  if (forecast?.nextEarnings) lines.push(`Next earnings: ${forecast.nextEarnings.date}`);
  if (Array.isArray(news) && news.length) {
    lines.push(`\nRecent news:`);
    news.slice(0, 5).forEach(n => lines.push(`- ${n.headline || n}`));
  }
  return `You are a concise market analyst. Based on the following public market data, write 2-3 sentences of plain prose summarizing what the data suggests about this stock: momentum direction, how the price compares to analyst targets, and the key news driver if any. NO bullet points, NO headers, NO investment advice, NO buy/sell recommendations. End with: "This is AI-generated analysis of public data."

${lines.join("\n")}`;
}

// ─────────────── RSS PROXY ───────────────
async function handleRssProxy(url) {
  const target = url.searchParams.get("url");
  if (!target || (!target.startsWith("http://") && !target.startsWith("https://"))) {
    return new Response("Missing or invalid ?url= parameter", {
      status: 400,
      headers: CORS_HEADERS
    });
  }
  try {
    const res = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RSSReader/1.0)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
      },
      cf: { cacheTtl: 300, cacheEverything: true }
    });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": res.headers.get("Content-Type") || "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      }
    });
  } catch (err) {
    return new Response("Fetch failed: " + err.message, {
      status: 502,
      headers: CORS_HEADERS
    });
  }
}

// ─────────────── AI BRIEF ───────────────
async function handleBrief(request, env, ctx) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POST only" }, 405);
  }
  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY secret is not set on this Worker" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const articleUrl  = (body.url || "").trim();
  const title       = (body.title || "").trim();
  const description = (body.description || "").trim();
  const source      = (body.source || "").trim();

  if (!articleUrl || !title) {
    return jsonResponse({ error: "url and title are required" }, 400);
  }

  // ── Cache lookup (by URL hash) ──
  const cacheKey = await hashKey(articleUrl);
  const cache = caches.default;
  const cacheReq = new Request("https://brief-cache.local/" + cacheKey, { method: "GET" });
  const cached = await cache.match(cacheReq);
  if (cached) {
    const cachedJson = await cached.json();
    return jsonResponse({ ...cachedJson, cached: true });
  }

  // ── Build prompt and call Claude with web_search ──
  const prompt = buildBriefPrompt({ title, description, source, url: articleUrl });
  const model = env.AI_MODEL || "claude-sonnet-4-5";

  let claudeRes;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        tools: [
          {
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 3
          }
        ],
        messages: [{ role: "user", content: prompt }]
      })
    });
  } catch (err) {
    return jsonResponse({ error: "Claude fetch failed: " + err.message }, 502);
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse(
      { error: "Claude API " + claudeRes.status, details: errText.slice(0, 600) },
      502
    );
  }

  const data = await claudeRes.json();
  const textBlocks = (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text);
  const briefText = textBlocks.join("\n\n").trim();

  if (!briefText) {
    return jsonResponse(
      { error: "Empty response from model", stop_reason: data.stop_reason || null },
      502
    );
  }

  const result = {
    brief: briefText,
    model,
    generated_at: new Date().toISOString()
  };

  // Cache 24h so repeat clicks (and revisits) are free
  const cacheRes = new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=86400"
    }
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));

  return jsonResponse({ ...result, cached: false });
}

function buildBriefPrompt({ title, description, source, url }) {
  return `Research this news article and write a concise briefing for a smart reader who wants the key facts and implications without reading the full piece.

ARTICLE
Title: ${title}
Source: ${source || "unknown"}
URL: ${url}
${description ? "Snippet: " + description : ""}

INSTRUCTIONS
1. Use web search (up to 3 targeted searches) to gather actual reporting on this story — what happened, the background, expert reactions, and what is likely to come next.
2. If the article appears to be paywalled or the snippet is thin, search for other coverage of the same story to triangulate the facts.
3. Write a brief of about 100-160 words that includes:
   - What happened (the core news, with specific facts)
   - Important context the headline does not capture
   - Implications, who is affected, or what to watch next
4. Be specific. Use real names, numbers, dates, and quotes drawn from your research. Do not paraphrase the headline.
5. If your research surfaces information that contradicts or significantly extends the headline, say so.
6. If you cannot find enough information to write a substantive brief, say so honestly in one sentence rather than padding.

Format: a single, clean paragraph or two of plain prose. No bullet points, no headers, no meta-commentary about your research process — just the briefing itself, ready to read.`;
}

// ─────────────── TRUMAN LAKE — USACE NWK ───────────────
// Strategy 1: hit the USACE CDA (Corps Water Management Data API) timeseries endpoint
//             server-side — no CORS, returns clean JSON for elevation, inflow, outflow.
// Strategy 2: fall back to scraping the NWK overview HTML page (the SPA, mostly empty,
//             but kept around in case Strategy 1 fails or the API gets renamed).
// The client has its own USGS gauge fallback for elevation alone.
async function handleLake(url, ctx) {
  const debug = url.searchParams.get("debug") === "1";
  const cache = caches.default;
  const cacheReq = new Request("https://lake-cache.local/hast-v2", { method: "GET" });

  if (!debug) {
    const cached = await cache.match(cacheReq);
    if (cached) {
      const cachedJson = await cached.json();
      return jsonResponse({ ...cachedJson, cached: true });
    }
  }

  // ── Strategy 1: USACE CDA timeseries API ──
  const cda = await fetchUsaceCdaTimeseries();
  const cdaHasData = cda && !cda._empty && cda.elevation !== null;
  if (cdaHasData) {
    // Strip the debug trail from the production response — only expose it when ?debug=1.
    const { debug: cdaDebug, _empty, ...cdaPublic } = cda;
    const result = {
      ...cdaPublic,
      source: "USACE CDA NWK",
      fetched_at: new Date().toISOString()
    };
    if (!debug) {
      const cacheRes = new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=600" }
      });
      ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));
    }
    if (debug) return jsonResponse({ strategy: "cda", result, cdaDebug });
    return jsonResponse({ ...result, cached: false });
  }

  // ── Strategy 2: scrape USACE NWK overview HTML ──
  let html;
  try {
    const res = await fetch("https://water.usace.army.mil/overview/nwk/locations/hast", {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      },
      cf: { cacheTtl: 600, cacheEverything: true }
    });
    if (!res.ok) {
      return jsonResponse({ error: "USACE HTTP " + res.status, cdaTried: cda }, 502);
    }
    html = await res.text();
  } catch (err) {
    return jsonResponse({ error: "USACE fetch failed: " + err.message, cdaTried: cda }, 502);
  }

  const parsed = parseUsaceHast(html);

  if (debug) {
    return jsonResponse({
      strategy: "scrape",
      parsed,
      cdaTried: cda,        // include CDA debug trail (steps, sampleNames, what was tried)
      htmlLength: html.length,
      htmlSample: html.slice(0, 4000),
      htmlMid: html.slice(Math.floor(html.length / 2), Math.floor(html.length / 2) + 4000)
    });
  }

  if (parsed.elevation === null) {
    return jsonResponse({ error: "Could not parse pool elevation — CDA empty + scrape empty", parsed, cdaTried: cda }, 502);
  }

  const result = {
    ...parsed,
    source: "USACE NWK HAST scrape",
    fetched_at: new Date().toISOString()
  };

  const cacheRes = new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=600" }
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));

  return jsonResponse({ ...result, cached: false });
}

// ── USACE CDA Timeseries API ──
// Step 1: hit the catalog endpoint to discover the actual timeseries names available
//         for HAST in the NWK office. Naming conventions vary (NWK-Cmb-Rev vs Ccp-Rev
//         vs raw, ~1Hour vs 1Hour, etc.), so guessing static names is fragile.
// Step 2: filter the catalog to the most relevant timeseries for elevation, inflow,
//         and outflow. Pick the highest-frequency one we find for each.
// Step 3: fetch all three in parallel and parse out the latest value + 24h-ago value.
async function fetchUsaceCdaTimeseries() {
  const office = "NWK";
  const debug = { steps: [] };

  // ── Catalog discovery ──
  // CDA's `like` parameter uses Java regex — bare strings don't match. Need ".*" wildcards.
  // Empirical: the office=NWK filter on the catalog endpoint returns 0 entries for HAST,
  // but dropping the office filter and filtering by name prefix returns 29 entries (all
  // genuinely NWK). So the no-office query is the one that actually works for this lake.
  // We still try with office first so other lakes work, then fall through.
  let catalogEntries = [];
  const catalogQueries = [
    { like: "HAST.*",     office: null   }, // ← the one that works for Truman
    { like: "HAST.*",     office: office },
    { like: ".*HAST.*",   office: null   },
    { like: "Truman.*",   office: office },
    { like: ".*Truman.*", office: office },
  ];
  for (const q of catalogQueries) {
    let catUrl = "https://cwms-data.usace.army.mil/cwms-data/catalog/TIMESERIES?" +
      "like=" + encodeURIComponent(q.like) + "&page-size=500";
    if (q.office) catUrl += "&office=" + q.office;
    try {
      const res = await fetch(catUrl, {
        headers: { "Accept": "application/json;version=2" },
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      if (!res.ok) {
        debug.steps.push({ step: "catalog", like: q.like, office: q.office, status: res.status });
        continue;
      }
      const data = await res.json();
      const entries = data?.entries || data?.["time-series-catalog"]?.entries || [];
      debug.steps.push({ step: "catalog", like: q.like, office: q.office, count: entries.length });
      if (entries.length) { catalogEntries = entries; break; }
    } catch (err) {
      debug.steps.push({ step: "catalog-error", like: q.like, message: err.message });
    }
  }

  // Pull (name, office) pairs out of the catalog response. The office attribute on each
  // entry is what we need to pass to /timeseries — turns out it's NOT always "NWK" even
  // for NWK-suffixed names. CDA's office system has confusing parent/child distinctions.
  const allEntries = catalogEntries
    .map(e => {
      if (typeof e === "string") return { name: e, office: null };
      const name = e.name || e["timeseries-id"] || e.id || "";
      const office = e.office || e["office-id"] || e.officeId || null;
      return { name, office };
    })
    .filter(x => x.name && x.name.indexOf("HAST") === 0);
  const allNames = allEntries.map(x => x.name);
  // Build a name → office map so we can pick the right office for each timeseries fetch.
  const nameToOffice = {};
  for (const x of allEntries) if (x.office) nameToOffice[x.name] = x.office;
  // Sample what we found so debug shows the office attribute too.
  debug.steps.push({ step: "catalog-offices", sample: allEntries.slice(0, 5) });

  // Score each candidate name and pick the best one. Higher-score name wins.
  // Empirical scoring tuned for what NWK actually publishes for HAST:
  //   - .Best-NWK suffix is the canonical observed/processed series
  //   - Fcst-* is FORECAST, not measurement → reject
  //   - For elevation: must NOT contain "Tailwater" (that's the river below the dam)
  //   - For flow: hourly observed isn't published; daily Ave is what's available
  function pickBest(filterRe, mustNotMatch) {
    const matches = allNames.filter(n =>
      filterRe.test(n) && (!mustNotMatch || !mustNotMatch.test(n))
    );
    if (!matches.length) return null;
    function score(name) {
      let s = 0;
      // Reject forecasts — they're projections, not measurements
      if (/\.Fcst-/i.test(name)) s -= 100;
      // Suffix preference: Best-NWK is canonical for this district
      if (/Best-NWK$/i.test(name)) s += 10;
      else if (/NWK-Cmb-Rev$/i.test(name)) s += 8;
      else if (/Ccp-Rev$/i.test(name)) s += 5;
      else if (/Rev$/i.test(name)) s += 3;
      else if (/Production$/i.test(name)) s += 2;
      // Interval preference: hourly > daily for elevation; either is fine for flow
      if (/\.~1Hour\./.test(name)) s += 5;
      else if (/\.1Hour\./.test(name)) s += 4;
      else if (/\.15Minutes\./.test(name)) s += 5;
      else if (/\.6Hours\./.test(name)) s += 2;
      else if (/\.1Day\./.test(name)) s += 1;
      // Aggregation preference depends on context — caller filter narrows that already
      if (/\.Inst\./.test(name)) s += 1;
      else if (/\.Ave\./.test(name)) s += 1;
      return s;
    }
    return matches.sort((a, b) => score(b) - score(a))[0];
  }

  // For pool elevation: match HAST.Elev or HAST.Elev-Pool, but EXCLUDE Tailwater
  // (HAST-Tailwater.Elev is the discharge tailrace below the dam — wrong).
  const elevName =
    pickBest(/^HAST\.Elev[-\.]?Pool\./i, /Tailwater/i) ||
    pickBest(/^HAST\.Elev\./i, /Tailwater/i);
  // For inflow/outflow: match the lake-level series, NOT tailwater. Forecasts rejected
  // by the score function via the .Fcst- penalty.
  const inflowName  = pickBest(/^HAST\.Flow[-\.]?In(?:[-\.]?Total)?\./i, /Tailwater/i);
  const outflowName =
    pickBest(/^HAST\.Flow[-\.]?Out(?:[-\.]?Total)?\./i, /Tailwater/i) ||
    pickBest(/^HAST\.Flow[-\.]?Total\./i, /Tailwater/i);

  debug.steps.push({ step: "selected", elevName, inflowName, outflowName, sampleNames: allNames.slice(0, 40) });

  // If catalog discovery failed, fall back to the actual NWK names we discovered live
  // (Best-NWK suffix, no -Pool tag on elev, daily Ave on flows).
  const fallbackElev    = ["HAST.Elev.Inst.1Hour.0.Best-NWK"];
  const fallbackInflow  = ["HAST.Flow-In.Ave.1Day.1Day.Best-NWK"];
  const fallbackOutflow = ["HAST.Flow-Out.Ave.1Day.1Day.Best-NWK"];

  const elevTry    = elevName    ? [elevName,    ...fallbackElev]    : fallbackElev;
  const inflowTry  = inflowName  ? [inflowName,  ...fallbackInflow]  : fallbackInflow;
  const outflowTry = outflowName ? [outflowName, ...fallbackOutflow] : fallbackOutflow;

  // ── Fetch all three in parallel ──
  const end = new Date();
  const begin = new Date(end.getTime() - 30 * 3600 * 1000);
  const beginIso = begin.toISOString();
  const endIso = end.toISOString();

  // Try a list of timeseries names. For each attempt, record the outcome (status, shape,
  // count) into debug.steps so the user-visible debug=1 response can show why a fetch
  // failed. The /timeseries endpoint REQUIRES office (400 without it) but the right
  // office is NOT always "NWK" — it's the office attribute attached to the catalog entry
  // (could be "MBRFC", "ABRFC", "SWT", etc. depending on data provenance). Try the
  // catalog-supplied office first, then fall through to NWK / common alternatives.
  async function fetchOne(field, nameList) {
    const officesToTry = (tsName) => {
      const offices = [];
      if (nameToOffice[tsName]) offices.push(nameToOffice[tsName]);
      for (const o of [office, "MBRFC", "SWT", "NWO", "NWD"]) {
        if (!offices.includes(o)) offices.push(o);
      }
      return offices;
    };
    for (const tsName of nameList) {
      for (const tryOffice of officesToTry(tsName)) {
        const tsUrl = "https://cwms-data.usace.army.mil/cwms-data/timeseries?" +
          "name=" + encodeURIComponent(tsName) +
          "&office=" + encodeURIComponent(tryOffice) +
          "&begin=" + encodeURIComponent(beginIso) +
          "&end=" + encodeURIComponent(endIso) +
          "&page-size=200";
        const useOffice = tryOffice;
        try {
          const res = await fetch(tsUrl, {
            headers: { "Accept": "application/json;version=2" },
            cf: { cacheTtl: 600, cacheEverything: true }
          });
          if (!res.ok) {
            debug.steps.push({ step: "ts-fetch", field, tsName, useOffice, status: res.status });
            continue;
          }
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); }
          catch (e) {
            debug.steps.push({ step: "ts-parse-fail", field, tsName, useOffice, sample: text.slice(0, 200) });
            continue;
          }
          const valuesArr =
            data?.values ||
            data?.["time-series"]?.values ||
            data?.value?.["time-series"]?.values ||
            [];
          if (!valuesArr.length) {
            debug.steps.push({ step: "ts-empty", field, tsName, useOffice, keys: Object.keys(data || {}).slice(0, 8) });
            continue;
          }
          const numeric = valuesArr
            .map(row => Array.isArray(row)
              ? [row[0], row[1]]
              : [row["date-time"] || row.dateTime || row.timestamp || row.date, row.value])
            .filter(([, v]) => v !== null && v !== undefined && isFinite(parseFloat(v)))
            .map(([t, v]) => [typeof t === "number" ? t : new Date(t).getTime(), parseFloat(v)]);
          if (numeric.length) {
            debug.steps.push({ step: "ts-ok", field, tsName, useOffice, count: numeric.length });
            return { tsName, numeric };
          }
          debug.steps.push({ step: "ts-no-numeric", field, tsName, useOffice, raw: valuesArr.slice(0, 2) });
        } catch (err) {
          debug.steps.push({ step: "ts-error", field, tsName, useOffice, message: err.message });
        }
      }
    }
    return null;
  }

  const [elevRes, inflowRes, outflowRes] = await Promise.all([
    fetchOne("elevation", elevTry),
    fetchOne("inflow", inflowTry),
    fetchOne("outflow", outflowTry)
  ]);

  const result = { elevation: null, inflow: null, outflow: null, change24h: null, timestamp: null, debug };

  if (elevRes) {
    const last = elevRes.numeric[elevRes.numeric.length - 1];
    result.elevation = parseFloat(last[1].toFixed(2));
    result.timestamp = new Date(last[0]).toISOString();
    if (elevRes.numeric.length >= 2) {
      const targetTs = Date.now() - 24 * 3600 * 1000;
      let closest = elevRes.numeric[0], minDiff = Infinity;
      for (const row of elevRes.numeric) {
        const diff = Math.abs(row[0] - targetTs);
        if (diff < minDiff) { minDiff = diff; closest = row; }
      }
      if (minDiff < 6 * 3600 * 1000) {
        result.change24h = parseFloat((last[1] - closest[1]).toFixed(2));
      }
    }
    debug.steps.push({ step: "elev-ok", tsName: elevRes.tsName });
  }
  if (inflowRes) {
    result.inflow = Math.round(inflowRes.numeric[inflowRes.numeric.length - 1][1]);
    debug.steps.push({ step: "inflow-ok", tsName: inflowRes.tsName });
  }
  if (outflowRes) {
    result.outflow = Math.round(outflowRes.numeric[outflowRes.numeric.length - 1][1]);
    debug.steps.push({ step: "outflow-ok", tsName: outflowRes.tsName });
  }

  // Sanity checks
  if (result.elevation !== null && (result.elevation < 690 || result.elevation > 745)) {
    result.elevation = null;
    result.change24h = null;
  }
  if (result.inflow !== null && Math.abs(result.inflow) > 1000000) result.inflow = null;
  if (result.outflow !== null && Math.abs(result.outflow) > 1000000) result.outflow = null;

  if (result.elevation === null && result.inflow === null && result.outflow === null) {
    // Return the debug trail anyway so ?debug=1 can show what we tried.
    return { ...result, _empty: true };
  }
  return result;
}

function parseUsaceHast(html) {
  const result = {
    elevation: null,    // ft NGVD (e.g. 715.12)
    inflow: null,       // cfs (e.g. 1234)
    outflow: null,      // cfs (e.g. 567)
    change24h: null,    // ft (e.g. +0.42 or -0.15)
    timestamp: null
  };

  // Strategy 1: look for an embedded JSON blob (SPA hydration data).
  // Common patterns: __NEXT_DATA__, window.__INITIAL_STATE__, or labeled data tags.
  const jsonBlobMatches = [
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/,
    /window\.__DATA__\s*=\s*(\{[\s\S]*?\});/,
    /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i
  ];
  for (const pat of jsonBlobMatches) {
    const m = html.match(pat);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]);
      const found = scanObjectForLakeValues(obj, result);
      if (found.elevation !== null) Object.assign(result, found);
      if (result.elevation !== null) break;
    } catch {}
  }

  // Strategy 2: regex against rendered HTML — look for labeled values.
  // Patterns are written generously so they survive minor format changes.
  if (result.elevation === null) {
    const elevPats = [
      /Pool\s+Elev(?:ation)?[^<>\d-]*?(\d{3}\.\d{1,2})/i,
      /Elev(?:ation)?[^<>\d-]*?(\d{3}\.\d{1,2})/i,
      /Lake\s+Level[^<>\d-]*?(\d{3}\.\d{1,2})/i,
      // Last resort: any 3-digit-decimal number that looks like Truman pool elevation
      /(\b7[01]\d\.\d{1,2}\b)/
    ];
    for (const pat of elevPats) {
      const m = html.match(pat);
      if (m) {
        const v = parseFloat(m[1]);
        if (v >= 690 && v <= 745) { result.elevation = v; break; }
      }
    }
  }

  if (result.inflow === null) {
    const inflowPats = [
      /Inflow[^<>\d-]*?([\d,]+)\s*cfs/i,
      /Total\s+Inflow[^<>\d-]*?([\d,]+)/i,
      /Net\s+Inflow[^<>\d-]*?(-?[\d,]+)/i
    ];
    for (const pat of inflowPats) {
      const m = html.match(pat);
      if (m) {
        const v = parseInt(m[1].replace(/,/g, ""), 10);
        if (isFinite(v)) { result.inflow = v; break; }
      }
    }
  }

  if (result.outflow === null) {
    const outflowPats = [
      /Outflow[^<>\d-]*?([\d,]+)\s*cfs/i,
      /Total\s+Outflow[^<>\d-]*?([\d,]+)/i,
      /Release[^<>\d-]*?([\d,]+)\s*cfs/i
    ];
    for (const pat of outflowPats) {
      const m = html.match(pat);
      if (m) {
        const v = parseInt(m[1].replace(/,/g, ""), 10);
        if (isFinite(v)) { result.outflow = v; break; }
      }
    }
  }

  if (result.change24h === null) {
    const changePats = [
      /24[\s-]?(?:hour|hr)\s+Change[^<>\d-]*?(-?\d+\.\d{1,2})/i,
      /Daily\s+Change[^<>\d-]*?(-?\d+\.\d{1,2})/i,
      /Change[^<>\d-]*?(-?\d+\.\d{1,2})\s*ft/i
    ];
    for (const pat of changePats) {
      const m = html.match(pat);
      if (m) {
        const v = parseFloat(m[1]);
        if (isFinite(v) && Math.abs(v) < 50) { result.change24h = v; break; }
      }
    }
  }

  return result;
}

// Recursively scan a parsed JSON blob for likely lake field names.
// Useful when the SPA hydration data has elevation/inflow/outflow nested somewhere.
function scanObjectForLakeValues(obj, baseline) {
  const found = { ...baseline };
  const seen = new WeakSet();
  function walk(o) {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      const key = k.toLowerCase();
      if (typeof v === "number" || (typeof v === "string" && /^-?\d+\.?\d*$/.test(v.trim()))) {
        const num = typeof v === "number" ? v : parseFloat(v);
        if (!isFinite(num)) continue;
        if (found.elevation === null && /pool.*elev|elev.*pool|lake.*level/i.test(key) && num >= 690 && num <= 745) {
          found.elevation = num;
        } else if (found.elevation === null && /^elev/i.test(key) && num >= 690 && num <= 745) {
          found.elevation = num;
        } else if (found.inflow === null && /inflow/i.test(key) && Math.abs(num) < 1000000) {
          found.inflow = Math.round(num);
        } else if (found.outflow === null && /(outflow|release)/i.test(key) && Math.abs(num) < 1000000) {
          found.outflow = Math.round(num);
        } else if (found.change24h === null && /(change|delta).*24|24.*change/i.test(key) && Math.abs(num) < 50) {
          found.change24h = num;
        }
      } else if (Array.isArray(v) || (typeof v === "object" && v !== null)) {
        walk(v);
      }
    }
  }
  walk(obj);
  return found;
}

// ─────────────── HELPERS ───────────────
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
}

async function hashKey(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─────────────── CATTLE PRICE OCR (Wheeler Livestock) ───────────────
// Fetches Wheeler Livestock's latest scanned market report, sends to Claude vision,
// and extracts pricing for 500–550 lb feeder steers as structured JSON.
// Cached 12h by sale date so repeat taps don't re-bill.
//   GET /cattleprice?barn=wheeler
//   returns: { barn, sale_date, weight_class, head_count, avg_cwt, low_cwt, high_cwt, frame_grade, notes, image_url, model, generated_at, cached }
async function handleCattlePrice(url, env, ctx) {
  const barn = url.searchParams.get("barn") || "wheeler";
  if (barn !== "wheeler") return jsonResponse({ error: "Only 'wheeler' is supported right now." }, 400);
  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY secret is not set" }, 500);

  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = "cattleprice:" + barn + ":" + today;
  const cache = caches.default;
  const cacheReq = new Request("https://cattleprice-cache.local/" + encodeURIComponent(cacheKey), { method: "GET" });
  const cached = await cache.match(cacheReq);
  if (cached) {
    const cachedJson = await cached.json();
    return jsonResponse({ ...cachedJson, cached: true });
  }

  // Fetch Wheeler's market report page
  const wheelerUrl = "https://www.wheelerlivestock.com/market-report-1";
  let html;
  try {
    const res = await fetch(wheelerUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CattleReader/1.0)" },
      cf: { cacheTtl: 600, cacheEverything: true }
    });
    if (!res.ok) return jsonResponse({ error: "Wheeler page returned HTTP " + res.status }, 502);
    html = await res.text();
  } catch (err) {
    return jsonResponse({ error: "Wheeler fetch failed: " + err.message }, 502);
  }

  // Extract candidate image URLs. Wheeler posts scanned reports as JPEG on Wix
  // CDN. Filename varies (sometimes "market", sometimes a Wix UUID). Collect
  // ALL Wix images from the page body first; meta tags are fallback only.
  const allWix = Array.from(new Set(html.match(/https:\/\/static\.wixstatic\.com\/media\/[^"'\s)]+\.(?:jpe?g|png|webp)/ig) || []));
  // og:image and twitter:image are typically the site banner — put them LAST
  // so page-body images (the actual scanned report) take priority.
  const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)
                    || html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
  const twitterImageMatch = html.match(/<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i)
                         || html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']twitter:image["']/i);
  const metaImages = [ogImageMatch, twitterImageMatch].filter(m => m).map(m => m[1]);
  // Page images first, meta banner images as last-resort fallback
  const allCandidates = Array.from(new Set([...allWix, ...metaImages]));
  if (allCandidates.length === 0) {
    return jsonResponse({ error: "No images found on Wheeler page" }, 404);
  }

  // Build an alt-text map so we can reward images whose filename hints at
  // being a market report (Wix stores files by UUID; the alt text keeps
  // the original upload filename, e.g. "MREPORT 051426_Page_1.jpg").
  const altMap = {};
  const imgTagRe = /<img\s[^>]*>/ig;
  let _imgMatch;
  while ((_imgMatch = imgTagRe.exec(html)) !== null) {
    const tag = _imgMatch[0];
    const srcM = tag.match(/src="([^"]+)"/i);
    const altM = tag.match(/alt="([^"]+)"/i);
    if (srcM && altM) {
      const base = (srcM[1].match(/https:\/\/static\.wixstatic\.com\/media\/[^"'\s)]+\.(?:jpe?g|png|webp)/i) || [])[0];
      if (base) altMap[base] = altM[1];
    }
  }

  function imgScore(u) {
    let s = 0;
    if (/market/i.test(u)) s += 100;
    if (/report/i.test(u)) s += 60;
    if (/\.jpe?g(\?|$|\/)/i.test(u)) s += 20;
    if (/blur_2/.test(u)) s -= 50;
    // Reward images whose original filename (in alt text) looks like a market report
    const alt = altMap[u] || "";
    if (/mreport|market.?report/i.test(alt)) s += 120;
    // Wix CDN URLs embed width (w_N) and height (h_N) in the transform path.
    // Scanned report pages are portrait (h > w); site banners are landscape (w >> h).
    const wMatch = u.match(/w_(\d{2,5})/);
    const hMatch = u.match(/h_(\d{2,5})/);
    const imgW = wMatch ? parseInt(wMatch[1], 10) : 0;
    const imgH = hMatch ? parseInt(hMatch[1], 10) : 0;
    if (imgW > 0) s += Math.min(20, imgW / 50);          // mild size bonus
    if (imgH > 0 && imgW > 0 && imgH > imgW) s += 65;    // portrait bonus — scanned pages
    if (imgH > 0 && imgW > 0 && imgW > imgH * 1.4) s -= 45; // landscape penalty — banners
    if (/logo|icon|favicon|avatar/i.test(u)) s -= 80;
    return s;
  }
  const ranked = allCandidates.map(u => ({ u, s: imgScore(u) })).sort((a, b) => b.s - a.s);
  // Wix encodes images as AVIF by default (enc_avif in the transform URL).
  // Claude vision can't read AVIF, so force JPEG by replacing the encoder directive.
  const imgUrl = ranked[0].u.replace(/enc_avif/gi, "enc_jpg");

  // Debug mode: dump everything we found on the page so we can iterate
  if (url.searchParams.get("debug") === "1") {
    return jsonResponse({
      debug: true,
      page_url: wheelerUrl,
      page_html_bytes: html.length,
      og_image: ogImageMatch ? ogImageMatch[1] : null,
      twitter_image: twitterImageMatch ? twitterImageMatch[1] : null,
      all_wix_images: allWix,
      all_candidates_ranked: ranked,
      chosen: imgUrl
    });
  }

  // Fetch image bytes. Wix has aggressive hotlink protection on its /v1/fit/...
  // transform endpoint, and also blocks the common image proxies. We try a long
  // chain of strategies — bare-URL (strip /v1/fit/...), Googlebot UA, multiple
  // proxies — before giving up.
  async function fetchImage(u, kind) {
    let decoded = u;
    try { decoded = decodeURIComponent(u); } catch (_) {}
    // Bare original URL: strip Wix's /v1/{fit,fill,crop,scale}/... transform
    // suffix. The bare asset endpoint tends to have looser hotlink rules.
    const bare = decoded.replace(/\/v1\/(?:fit|fill|crop|scale)\/[^/]+\/[^?#]+\.(?:jpe?g|png|webp)/i, "");
    const stripped = decoded.replace(/^https?:\/\//, "");
    const strippedBare = bare.replace(/^https?:\/\//, "");

    const browserHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Referer": "https://www.wheelerlivestock.com/",
      "Origin": "https://www.wheelerlivestock.com",
      "Accept": "image/jpeg,image/png,image/webp,image/*;q=0.9,*/*;q=0.5",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Dest": "image",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site"
    };
    const googlebotHeaders = Object.assign({}, browserHeaders, { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" });

    let target, headers = {};
    if (kind === "direct-bare")          { target = bare;    headers = browserHeaders; }
    else if (kind === "direct")          { target = decoded; headers = browserHeaders; }
    else if (kind === "googlebot-bare")  { target = bare;    headers = googlebotHeaders; }
    else if (kind === "googlebot")       { target = decoded; headers = googlebotHeaders; }
    else if (kind === "wsrv-bare")       { target = "https://wsrv.nl/?url="          + encodeURIComponent(strippedBare) + "&output=jpg&q=92"; }
    else if (kind === "wsrv")            { target = "https://wsrv.nl/?url="          + encodeURIComponent(stripped)     + "&output=jpg&q=92"; }
    else if (kind === "weserv-bare")     { target = "https://images.weserv.nl/?url=" + encodeURIComponent(strippedBare) + "&output=jpg&q=92"; }
    else if (kind === "weserv")          { target = "https://images.weserv.nl/?url=" + encodeURIComponent(stripped)     + "&output=jpg&q=92"; }
    else if (kind === "corsproxy-bare")  { target = "https://corsproxy.io/?"         + encodeURIComponent(bare);    headers = browserHeaders; }
    else if (kind === "corsproxy")       { target = "https://corsproxy.io/?"         + encodeURIComponent(decoded); headers = browserHeaders; }
    else if (kind === "allorigins-bare") { target = "https://api.allorigins.win/raw?url=" + encodeURIComponent(bare); }
    else if (kind === "allorigins")      { target = "https://api.allorigins.win/raw?url=" + encodeURIComponent(decoded); }
    else if (kind === "thumio-page")     { target = "https://image.thum.io/get/width/1600/crop/2400/https://www.wheelerlivestock.com/market-report-1"; }
    else if (kind === "microlink-page")  { target = "https://api.microlink.io/?url=" + encodeURIComponent("https://www.wheelerlivestock.com/market-report-1") + "&screenshot=true&meta=false&embed=screenshot.url"; }
    else throw new Error("unknown kind: " + kind);

    const r = await fetch(target, { headers });
    if (!r.ok) throw new Error("HTTP " + r.status);
    // Sanity-check: did we actually get image bytes? Some proxies return HTML
    // error pages with 200 status when the upstream fetch fails.
    const ct = (r.headers.get("Content-Type") || "").toLowerCase();
    if (ct && !ct.startsWith("image/") && !ct.startsWith("application/octet-stream")) {
      throw new Error("not an image (ct=" + ct.slice(0, 40) + ")");
    }
    return r;
  }

  const model = env.AI_MODEL_VISION || "claude-sonnet-4-5";

  // Common prompt body — much more directive about grade priority. The user has
  // observed Haiku picking M/L 1-2 (mixed grade) lines instead of the higher-quality
  // M/L 1 (single grade) lines. Sonnet + this prompt should fix that.
  const commonPromptBody =
    "TASK: Find the SINGLE BEST feeder steer line for the user's tracker. The user wants TOP DOLLAR pricing for the highest-grade feeder steers closest to 500 lb actual weight.\n\n" +
    "GRADE PRIORITY (strictly enforce):\n" +
    "1. STRONGLY PREFER 'Medium and Large 1' (also written 'M&L 1', 'M/L 1', 'Med & Lg 1', 'Medium & Large #1'). This is a single-grade, higher-quality line.\n" +
    "2. Only fall back to 'Medium and Large 1-2' (M&L 1-2, mixed-grade range) if NO M&L 1 feeder steer line exists on the report.\n" +
    "3. NEVER pick 'Medium and Large 2', 'Medium 2', or any grade 3 line.\n\n" +
    "WEIGHT SELECTION (within the chosen grade):\n" +
    "- READ ALL weight lines in the chosen grade section carefully before picking.\n" +
    "- CLOSEST TO 500 LB means the SMALLEST absolute difference: |weight - 500|.\n" +
    "  Example: |509 - 500| = 9 lb  vs  |443 - 500| = 57 lb  →  509 wins.\n" +
    "  Example: |320 - 500| = 180 lb  vs  |650 - 500| = 150 lb  →  650 wins.\n" +
    "- For a weight RANGE (e.g. '500-549'), use the midpoint (524) for the distance calc.\n" +
    "- Grade priority overrides weight proximity ONLY when comparing across grade tiers\n" +
    "  (e.g. M&L 1 at 583 lb beats M&L 1-2 at 509 lb). Within the same grade, always\n" +
    "  pick the line closest to 500 lb by the calculation above.\n\n" +
    "PRICE READING:\n" +
    "- Prices are in $/cwt (dollars per hundredweight), typically $200-$400 in current market.\n" +
    "- high_cwt is the TOP DOLLAR price (the highest number on that line) — this is the headline number the user tracks. Read it carefully, double-check the digits.\n" +
    "- If only a single price is shown (no range), set avg_cwt = low_cwt = high_cwt to that price.\n\n" +
    "OUTPUT — Return ONLY valid JSON, no markdown, no commentary outside the JSON. Schema:\n" +
    '{\n' +
    '  "barn": "wheeler",\n' +
    '  "sale_date": "YYYY-MM-DD",\n' +
    '  "weight_class": "<exactly as written, e.g. \\"583 lbs\\" or \\"500-549\\"">,\n' +
    '  "head_count": <number_or_null>,\n' +
    '  "avg_cwt": <avg_price_dollars>,\n' +
    '  "low_cwt": <low_price>,\n' +
    '  "high_cwt": <TOP_DOLLAR_HIGH_PRICE>,\n' +
    '  "frame_grade": "<exact grade as shown, e.g. \\"Med & Lg 1\\" or \\"M&L 1-2\\">",\n' +
    '  "notes": "<one sentence: which line you picked and why, including grade + weight + whether you fell back from M&L 1 because none existed>"\n' +
    '}\n' +
    "If no feeder steer data is visible at all, return {\"error\":\"no feeder steer data found\"}.";
  const promptDirect     = "This is a livestock auction market report from Wheeler Livestock Auction in Osceola, MO. " + commonPromptBody;
  const promptScreenshot = "This is a screenshot of Wheeler Livestock Auction's website. The page shows their latest scanned market report from their auction in Osceola, MO. Look at the market report image embedded on the page and read it carefully. " + commonPromptBody;

  // Helper: call Claude with one or more image content blocks + a text prompt.
  // imageContent may be a single block object OR an array of blocks.
  async function callClaude(imageContent, useText) {
    const imgBlocks = Array.isArray(imageContent) ? imageContent : [imageContent];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        messages: [{ role: "user", content: [...imgBlocks, { type: "text", text: useText }] }]
      })
    });
    if (!r.ok) {
      const errText = await r.text();
      throw new Error("HTTP " + r.status + ": " + errText.slice(0, 300));
    }
    return await r.json();
  }

  // ── PLAN A: Anthropic URL-source (all top pages in one call) ──
  // For each unique Wix image UUID (i.e. each distinct report page), pick the
  // HIGHEST-RESOLUTION version available — better OCR means fewer misread weights.
  // Then send all pages to Claude at once so it sees the full report.
  function wixUUID(u) { const m = u.match(/media\/([^/~%]+)/); return m ? m[1] : null; }
  const seenUUIDs = new Set();
  const allTopUrls = [];
  for (const { u: candidateUrl } of ranked.filter(r => r.s >= 50)) {
    const uuid = wixUUID(candidateUrl);
    if (!uuid || seenUUIDs.has(uuid)) continue;
    seenUUIDs.add(uuid);
    // Among all versions of this UUID, pick the tallest (highest h_) for best resolution
    const allVersions = ranked.filter(r => wixUUID(r.u) === uuid);
    const best = allVersions.reduce((a, b) => {
      const hA = parseInt((a.u.match(/h_(\d+)/) || [0, 0])[1], 10) || 0;
      const hB = parseInt((b.u.match(/h_(\d+)/) || [0, 0])[1], 10) || 0;
      return hB > hA ? b : a;
    });
    let resolved = best.u.replace(/enc_avif/gi, "enc_jpg");
    try { resolved = decodeURIComponent(resolved); } catch (_) {}
    allTopUrls.push(resolved);
    if (allTopUrls.length >= 4) break;
  }

  let claudeData = null;
  let fetchedVia = null;
  const attempts = [];

  // Try with all top pages at once, then fall back to just the primary image.
  const planAVariants = [
    { urls: allTopUrls,  label: "anthropic-url-multi" },
    { urls: [allTopUrls[0]], label: "anthropic-url" }
  ];
  for (const variant of planAVariants) {
    try {
      const imgBlocks = variant.urls.map(u => ({ type: "image", source: { type: "url", url: u } }));
      claudeData = await callClaude(imgBlocks, promptDirect);
      fetchedVia = variant.label;
      break;
    } catch (e) {
      attempts.push(variant.label + ":" + e.message.slice(0, 200));
    }
  }

  let imgUrlDecoded = imgUrl;
  try { imgUrlDecoded = decodeURIComponent(imgUrl); } catch (_) {}

  // ── PLAN B: byte-fetch chain (12 strategies) ──
  // If Anthropic couldn't fetch the URL either, try fetching the bytes ourselves
  // and sending them as base64. (Unlikely to work given Wix has been blocking us,
  // but kept as a defense-in-depth fallback.)
  if (!claudeData) {
    let imgRes = null;
    let mediaType = "image/jpeg";
    const strategies = [
      "direct-bare", "direct",
      "googlebot-bare", "googlebot",
      "wsrv-bare", "wsrv",
      "weserv-bare", "weserv",
      "corsproxy-bare", "corsproxy",
      "allorigins-bare", "allorigins",
      "thumio-page",
      "microlink-page"
    ];
    for (const kind of strategies) {
      try {
        imgRes = await fetchImage(imgUrl, kind);
        fetchedVia = kind;
        break;
      } catch (e) {
        attempts.push(kind + ":" + e.message);
      }
    }

    // ── PLAN C: WordPress mShots — full-page screenshot ──
    if (!imgRes) {
      try {
        const mshotsUrl = "https://s.wordpress.com/mshots/v1/" + encodeURIComponent(wheelerUrl) + "?w=1600&h=2400";
        let mshotsRes = await fetch(mshotsUrl);
        if (mshotsRes.ok) {
          const len = parseInt(mshotsRes.headers.get("Content-Length") || "0", 10);
          if (len > 0 && len < 10000) {
            await new Promise(r => setTimeout(r, 5000));
            mshotsRes = await fetch(mshotsUrl);
          }
        }
        if (mshotsRes.ok) {
          const ct = (mshotsRes.headers.get("Content-Type") || "").toLowerCase();
          if (ct.startsWith("image/")) {
            imgRes = mshotsRes;
            fetchedVia = "mshots";
            attempts.push("mshots:OK");
          } else {
            attempts.push("mshots:not-image-ct=" + ct);
          }
        } else {
          attempts.push("mshots:HTTP " + mshotsRes.status);
        }
      } catch (e) {
        attempts.push("mshots:" + e.message);
      }
    }

    if (!imgRes) {
      return jsonResponse({ error: "Wheeler image fetch failed — " + attempts.join(" | "), image_url: imgUrl }, 502);
    }

    let imgBytes;
    try {
      const ct = imgRes.headers.get("Content-Type") || "";
      if (ct.includes("png")) mediaType = "image/png";
      imgBytes = await imgRes.arrayBuffer();
    } catch (err) {
      return jsonResponse({ error: "Wheeler image read failed: " + err.message, image_url: imgUrl, fetched_via: fetchedVia }, 502);
    }

    const base64 = arrayBufferToBase64(imgBytes);
    const isScreenshot = fetchedVia === "mshots" || fetchedVia === "thumio-page" || fetchedVia === "microlink-page";
    const usePrompt = isScreenshot ? promptScreenshot : promptDirect;
    try {
      claudeData = await callClaude(
        { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        usePrompt
      );
    } catch (e) {
      return jsonResponse({ error: "Claude vision call failed: " + e.message, image_url: imgUrl, fetched_via: fetchedVia, attempts }, 502);
    }
  }

  // ── Parse Claude response ──
  const text = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  let parsed;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return jsonResponse({ error: "Could not parse Claude response as JSON", raw: text.slice(0, 600), fetched_via: fetchedVia }, 502);
  }
  if (parsed.error) return jsonResponse({ ...parsed, image_url: imgUrl, model, fetched_via: fetchedVia }, 200);

  // ── Freshness check ──
  // Wheeler sells on Tuesdays. If Claude returns a sale_date more than 10 days
  // before today, the report is stale — most often because a full-page
  // screenshot strategy (thumio-page, microlink-page, mshots) captured last
  // week's report before Wheeler posted this week's. We refuse to cache or
  // return stale data so the user sees a clear error and uploads manually.
  if (parsed.sale_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.sale_date)) {
    const todayMs   = Date.parse(today + "T00:00:00Z");
    const saleMs    = Date.parse(parsed.sale_date + "T00:00:00Z");
    const ageDays   = (todayMs - saleMs) / 86400000;
    if (isFinite(ageDays) && ageDays > 10) {
      return jsonResponse({
        error: "Wheeler hasn't posted this week's report yet (auto-fetch returned a stale " + parsed.sale_date + " scan). Tap 📤 Upload Wheeler Image once the new scan is available.",
        stale_sale_date: parsed.sale_date,
        age_days: Math.round(ageDays),
        fetched_via: fetchedVia,
        image_url: imgUrl
      }, 200);
    }
  }

  const result = { ...parsed, model, image_url: imgUrl, fetched_via: fetchedVia, attempts: attempts.length ? attempts : undefined, generated_at: new Date().toISOString() };
  const cacheRes = new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=43200" } // 12h
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));
  // Auto-save to KV so every browser and every scheduled run sees this result
  if (env.WEEKLY_KV && result.sale_date) {
    const kvPrice = parseFloat(result.high_cwt || result.avg_cwt);
    if (kvPrice > 0) ctx.waitUntil(addCattlePriceToKV(env, barn, kvPrice, result.sale_date, result));
  }
  return jsonResponse({ ...result, cached: false });
}


//   POST /cattlemanual
//   body: { image_base64, media_type ("image/jpeg" | "image/png") }
//   returns: same shape as /cattleprice but with fetched_via:"manual-upload"
async function handleCattleManual(request, env, ctx) {
  if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY secret is not set" }, 500);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
  if (!body.image_base64) return jsonResponse({ error: "Missing image_base64" }, 400);
  const mediaType = body.media_type || "image/jpeg";
  const model = env.AI_MODEL_VISION || "claude-sonnet-4-5";

  const prompt =
    "This is a livestock auction market report image the user uploaded from Wheeler Livestock Auction in Osceola, MO.\n\n" +
    "TASK: Find the SINGLE BEST feeder steer line for the user's tracker. The user wants TOP DOLLAR pricing for the highest-grade feeder steers closest to 500 lb actual weight.\n\n" +
    "GRADE PRIORITY (strictly enforce):\n" +
    "1. STRONGLY PREFER 'Medium and Large 1' (also written 'M&L 1', 'M/L 1', 'Med & Lg 1', 'Medium & Large #1'). This is a single-grade, higher-quality line.\n" +
    "2. Only fall back to 'Medium and Large 1-2' if NO M&L 1 feeder steer line exists.\n" +
    "3. NEVER pick M&L 2 or grade 3 lines.\n\n" +
    "WEIGHT SELECTION: Some weeks Wheeler shows single avg weights (583 lbs, 538 lbs, 612 lbs), some weeks ranges (500-549). Pick whichever entry within the chosen grade is closest to 500 lb. A single-weight 583 lb M&L 1 line is preferred over a 500-549 M&L 1-2 range — grade priority outranks weight proximity.\n\n" +
    "PRICES are in $/cwt (typically $200-$400). high_cwt is the TOP DOLLAR (highest) price on the line — read it carefully, this is the headline number the user tracks.\n\n" +
    "OUTPUT — Return ONLY valid JSON, no markdown:\n" +
    '{\n' +
    '  "barn": "wheeler", "sale_date": "YYYY-MM-DD", "weight_class": "<as written>",\n' +
    '  "head_count": <number_or_null>, "avg_cwt": <avg>, "low_cwt": <low>, "high_cwt": <TOP_DOLLAR>,\n' +
    '  "frame_grade": "<exact grade>", "notes": "<which line you picked and why>"\n' +
    '}\n' +
    "If no feeder steer data is visible, return {\"error\":\"no feeder steer data found\"}.";

  let claudeRes;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: body.image_base64 } },
          { type: "text", text: prompt }
        ] }]
      })
    });
  } catch (err) {
    return jsonResponse({ error: "Claude fetch failed: " + err.message }, 502);
  }
  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: "Claude API " + claudeRes.status, details: errText.slice(0, 600) }, 502);
  }
  const data = await claudeRes.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  let parsed;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return jsonResponse({ error: "Could not parse Claude response as JSON", raw: text.slice(0, 600) }, 502);
  }
  if (parsed.error) return jsonResponse({ ...parsed, model, fetched_via: "manual-upload" }, 200);

  // Purge today's /cattleprice cache so a subsequent auto-fetch tap can't
  // overwrite this fresh manual reading with stale screenshot data.
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = "cattleprice:wheeler:" + today;
  const cacheReq = new Request("https://cattleprice-cache.local/" + encodeURIComponent(cacheKey), { method: "GET" });
  ctx.waitUntil(caches.default.delete(cacheReq));

  return jsonResponse({ ...parsed, model, fetched_via: "manual-upload", generated_at: new Date().toISOString() });
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.byteLength)));
  }
  return btoa(binary);
}


// ─────────────── CATTLE PRICE HISTORY — KV SYNC ───────────────────────────
// Stores Wheeler price history in WEEKLY_KV under "cattle:history" so every
// browser sees the same 1-year chart, exactly like the Missouri weekly report.
//
//   GET  /cattlehistory          → returns { history: { wheeler: [{date,price,...}] } }
//   POST /cattlerecord           → body { barn, price, date, [weight_class, head_count, avg_cwt, low_cwt, high_cwt, frame_grade, notes, fetched_via] }
//                                   records an entry and returns updated history

const CATTLE_HISTORY_KV_KEY = "cattle:history";

// Shared helper — write one price entry into WEEKLY_KV cattle history.
// Used by handleCattleRecord (HTTP endpoint), handleCattlePrice (auto-save),
// and the cron-triggered runWheelerScheduled.
async function addCattlePriceToKV(env, barn, priceNum, date, extra) {
  if (!env.WEEKLY_KV) return;
  const raw = await env.WEEKLY_KV.get(CATTLE_HISTORY_KV_KEY);
  const hist = raw ? JSON.parse(raw) : {};
  if (!Array.isArray(hist[barn])) hist[barn] = [];
  if (hist[barn].some(e => e.date === date && parseFloat(e.price) === priceNum)) return; // no-op duplicate
  const entry = { date, price: priceNum, recorded_at: new Date().toISOString() };
  for (const k of ["weight_class", "head_count", "avg_cwt", "low_cwt", "high_cwt", "frame_grade", "notes", "fetched_via"]) {
    if (extra && extra[k] != null) entry[k] = extra[k];
  }
  hist[barn].push(entry);
  hist[barn].sort((a, b) => a.date.localeCompare(b.date));
  if (hist[barn].length > 52) hist[barn] = hist[barn].slice(-52);
  await env.WEEKLY_KV.put(CATTLE_HISTORY_KV_KEY, JSON.stringify(hist), { expirationTtl: 4 * 365 * 24 * 3600 });
}

async function handleCattleHistory(url, env, ctx) {
  if (!env.WEEKLY_KV) return jsonResponse({ error: "WEEKLY_KV not bound" }, 500);
  const raw = await env.WEEKLY_KV.get(CATTLE_HISTORY_KV_KEY);
  const hist = raw ? JSON.parse(raw) : {};
  return jsonResponse({ history: hist }, 200, { "Cache-Control": "no-store" });
}

async function handleCattleRecord(request, env, ctx) {
  if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  if (!env.WEEKLY_KV) return jsonResponse({ error: "WEEKLY_KV not bound" }, 500);
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }
  const { barn, price, date } = body;
  if (!barn || price == null || !date) return jsonResponse({ error: "Missing barn, price, or date" }, 400);
  const priceNum = parseFloat(price);
  if (!isFinite(priceNum) || priceNum <= 0) return jsonResponse({ error: "Invalid price value" }, 400);
  await addCattlePriceToKV(env, barn, priceNum, date, body);
  const updated = await env.WEEKLY_KV.get(CATTLE_HISTORY_KV_KEY);
  return jsonResponse({ ok: true, history: updated ? JSON.parse(updated) : {} });
}


// ─────────────── MISSOURI WEEKLY MARKET SUMMARY — UPLOAD ───────────────
// POST /weeklyupload
// Body (JSON): { pdf_base64: string, upload_pin: string }
// Accepts the Missouri Weekly Market Summary PDF, uses Claude to extract
// key commodity data, then stores it in Cloudflare KV so ALL users see it.
//
// One-time setup (run these in your terminal):
//   wrangler kv namespace create WEEKLY_KV          ← creates the namespace, prints the id
//   wrangler secret put UPLOAD_PIN                  ← set any PIN you want (e.g. "cattle25")
//   Then paste the id into wrangler.toml and run: wrangler deploy

async function handleWeeklyUpload(request, env, ctx) {
  if (request.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  if (!env.ANTHROPIC_API_KEY) return jsonResponse({ error: "ANTHROPIC_API_KEY secret not set" }, 500);
  if (!env.WEEKLY_KV) return jsonResponse({ error: "WEEKLY_KV namespace not bound — see wrangler.toml setup" }, 500);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON body" }, 400); }

  // PIN gate so only you can push data
  const expectedPin = env.UPLOAD_PIN || "cattle25";
  if (!body.upload_pin || body.upload_pin !== expectedPin) {
    return jsonResponse({ error: "Invalid upload PIN" }, 403);
  }

  if (!body.pdf_base64) return jsonResponse({ error: "pdf_base64 is required" }, 400);

  // ── Call Claude with the PDF document ──────────────────────────────────
  const model = env.AI_MODEL || "claude-sonnet-4-5";
  let claudeRes;
  try {
    claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "pdfs-2024-09-25",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: body.pdf_base64
              }
            },
            {
              type: "text",
              text: `You are extracting data from a Missouri Weekly Market Summary PDF published by the Missouri Department of Agriculture.

Return ONLY valid JSON (no markdown, no explanation) with EXACTLY these fields:

{
  "report_date": "YYYY-MM-DD",
  "stocker_formula_cwt": <number: Missouri Stocker Formula weighted average price per cwt for 400-649 lb steers>,
  "stocker_formula_weight": <number: weighted average weight in lbs for the stocker formula>,
  "stocker_formula_head": <number: head count in stocker formula>,
  "feeder_steer_500_600_avg_low": <number: average of the LOW ends of the 500-600 lb feeder steer price ranges across ALL Missouri regions listed>,
  "feeder_steer_500_600_avg_high": <number: average of the HIGH ends of the 500-600 lb feeder steer price ranges across ALL Missouri regions listed>,
  "corn_kc_fri": <number: Kansas City Friday corn cash price per bushel, midpoint if a range>,
  "corn_stl_fri": <number: St. Louis Friday corn cash price per bushel, midpoint if a range>,
  "corn_central_fri": <number: Central Missouri Friday corn cash price per bushel, midpoint if a range>,
  "soybean_kc_fri": <number: Kansas City Friday soybean cash price per bushel, midpoint if a range>,
  "soybean_stl_fri": <number: St. Louis Friday soybean cash price per bushel, midpoint if a range>,
  "boxed_beef_choice_5day": <number: 5-day simple average for Choice boxed beef cutout>,
  "boxed_beef_select_5day": <number: 5-day simple average for Select boxed beef cutout>,
  "total_receipts": <integer: total weekly cattle receipts>,
  "week_ago_receipts": <integer: week-ago cattle receipts>,
  "year_ago_receipts": <integer: year-ago cattle receipts>,
  "market_narrative": "<2-3 sentence plain-English summary of the week's market conditions from the main weekly summary section>"
}

Use null for any field you cannot find. For the 500-600 lb ranges, average ONLY across regions that explicitly list a 500-600 lb steer line (skip any region that doesn't list it).`
            }
          ]
        }]
      })
    });
  } catch (err) {
    return jsonResponse({ error: "Claude API fetch failed: " + err.message }, 502);
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return jsonResponse({ error: "Claude API error " + claudeRes.status, details: errText.slice(0, 600) }, 502);
  }

  const claudeData = await claudeRes.json();
  const rawText = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();

  let extracted;
  try {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    extracted = JSON.parse(cleaned);
  } catch (err) {
    return jsonResponse({ error: "Could not parse Claude response as JSON", raw: rawText.slice(0, 800) }, 502);
  }

  if (!extracted.report_date || !/^\d{4}-\d{2}-\d{2}$/.test(extracted.report_date)) {
    return jsonResponse({ error: "Claude did not return a valid report_date", raw: rawText.slice(0, 400) }, 502);
  }

  // ── Store in KV ────────────────────────────────────────────────────────
  const record = {
    ...extracted,
    uploaded_at: new Date().toISOString(),
    model
  };
  const kvKey = "weekly:" + extracted.report_date;

  // KV TTL: 4 years (won't expire within any normal tracking window)
  await env.WEEKLY_KV.put(kvKey, JSON.stringify(record), { expirationTtl: 4 * 365 * 24 * 3600 });

  // Update the sorted date index
  const indexRaw = await env.WEEKLY_KV.get("weekly:index");
  const index = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(extracted.report_date)) {
    index.push(extracted.report_date);
    index.sort();
    await env.WEEKLY_KV.put("weekly:index", JSON.stringify(index), { expirationTtl: 4 * 365 * 24 * 3600 });
  }

  // Purge the /weeklydata edge cache so the new upload is visible immediately
  // on every device. KV (the source of truth for the historical chart) is
  // untouched — we're only invalidating the cached HTTP response.
  const cache = caches.default;
  ctx.waitUntil(Promise.all(
    [50, 100, 200, 300].map(limit =>
      cache.delete(new Request("https://weeklydata-cache.local/v1/limit=" + limit))
    )
  ));

  return jsonResponse({ success: true, date: extracted.report_date, data: record });
}

// ─────────────── MISSOURI WEEKLY MARKET SUMMARY — READ ───────────────
// GET /weeklydata[?limit=N]
// Returns all stored weekly records from KV (sorted oldest → newest).
// Called by every user's browser to render charts and the latest summary.
// Cached at the CDN edge for 1 hour so reads are fast everywhere.

async function handleWeeklyData(url, env, ctx) {
  if (!env.WEEKLY_KV) return jsonResponse({ error: "WEEKLY_KV namespace not bound — see wrangler.toml setup" }, 500);

  const limit = Math.min(parseInt(url.searchParams.get("limit") || "300", 10), 300);

  // ── Try CDN cache first ───────────────────────────────────────────────
  const cache = caches.default;
  const cacheKey = "https://weeklydata-cache.local/v1/limit=" + limit;
  const cached = await cache.match(new Request(cacheKey));
  if (cached) {
    const payload = await cached.json();
    return jsonResponse({ ...payload, cache_hit: true });
  }

  // ── Read index then fetch each record ─────────────────────────────────
  const indexRaw = await env.WEEKLY_KV.get("weekly:index");
  if (!indexRaw) return jsonResponse({ records: [], count: 0 });

  const index = JSON.parse(indexRaw);
  const dates = index.slice(-limit);

  const records = (await Promise.all(
    dates.map(async d => {
      const raw = await env.WEEKLY_KV.get("weekly:" + d);
      return raw ? JSON.parse(raw) : null;
    })
  )).filter(Boolean).sort((a, b) => a.report_date.localeCompare(b.report_date));

  const payload = { records, count: records.length, fetched_at: new Date().toISOString() };

  // Cache at edge for 1 hour
  ctx.waitUntil(
    cache.put(new Request(cacheKey), new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" }
    }))
  );

  return jsonResponse(payload);
}
