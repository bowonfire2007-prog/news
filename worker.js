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
    return handleRssProxy(url);
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
  const lake = b.lake || {};
  const wx = b.weather || {};
  const wind = b.wind || {};
  const lines = [];
  if (Number.isFinite(lake.stage))       lines.push(`Pool elevation: ${lake.stage.toFixed(1)} ft (normal pool 706.0 ft, flood pool 739.6 ft)`);
  if (Number.isFinite(lake.dailyChange)) lines.push(`24h change: ${lake.dailyChange >= 0 ? "+" : ""}${lake.dailyChange.toFixed(2)} ft (${lake.dailyChange < -0.1 ? "falling" : lake.dailyChange > 0.1 ? "rising" : "stable"})`);
  if (Number.isFinite(lake.inflow) && Number.isFinite(lake.outflow)) {
    const net = lake.inflow - lake.outflow;
    lines.push(`Inflow: ${lake.inflow.toLocaleString()} cfs / Outflow: ${lake.outflow.toLocaleString()} cfs (net ${net >= 0 ? "+" : ""}${net.toLocaleString()} cfs — dam ${net < -2000 ? "releasing hard" : net > 2000 ? "holding back" : "near balance"})`);
  }
  if (wind.dir) lines.push(`Wind: ${wind.dir}${Number.isFinite(wind.speed) ? " " + Math.round(wind.speed) + " mph" : ""}${Number.isFinite(wind.sustainedHours) ? ", sustained " + wind.sustainedHours + "h" : ""}`);
  if (Number.isFinite(wx.temp))   lines.push(`Air temp: ${Math.round(wx.temp)}°F${Number.isFinite(wx.feels) ? " (feels " + Math.round(wx.feels) + "°)" : ""}`);
  if (wx.condition)               lines.push(`Sky: ${wx.condition}`);
  if (Number.isFinite(wx.humidity)) lines.push(`Humidity: ${wx.humidity}%`);

  const monthName = new Date().toLocaleDateString("en-US", { month: "long" });

  return `You are an expert fishing guide for Truman Lake in west-central Missouri. The angler fishes from Sparrowfoot Park on the Grand River arm and has access to BOTH boat and bank.

TARGET SPECIES (these only — do NOT recommend largemouth bass, walleye, or white bass):
- Blue catfish (the headliner — this lake is famous for them)
- Flathead catfish
- Crappie (black and white)
- Gizzard shad — for cast-netting bait
- Bluegill — only in nearby farm ponds, not the lake

TODAY'S CONDITIONS (${monthName}):
${lines.join("\n")}

Write a tight, specific fishing plan in 2-3 short paragraphs of plain prose. NO bullet points, NO headers, NO markdown. Lead with the best species for today's conditions and explain WHY given the lake state. Then specify exact technique — bait, rig, depth, retrieve speed. Finally, name where to focus on the Grand River arm near Sparrowfoot — channel bends, flooded timber, mud lines, riprap, creek mouths, points, etc. — and whether tonight or tomorrow morning is a better window. If conditions strongly favor a particular bite (e.g. dam releasing hard = blues stacked in current breaks), say so directly and confidently. Keep it to ~150-200 words total.`;
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

  // Extract latest market-report image URL. Wheeler posts scanned reports as
  // JPEG on Wix CDN, but the filename varies — sometimes "market", sometimes a
  // Wix UUID. Collect ALL Wix images on the page and rank them.
  const allWix = Array.from(new Set(html.match(/https:\/\/static\.wixstatic\.com\/media\/[^"'\s)]+\.(?:jpe?g|png|webp)/ig) || []));
  if (allWix.length === 0) return jsonResponse({ error: "No Wix-hosted images found on Wheeler page" }, 404);

  function imgScore(u) {
    let s = 0;
    if (/market/i.test(u)) s += 100;            // explicit market-report filename
    if (/report/i.test(u)) s += 60;             // "report" in URL
    if (/\.jpe?g(\?|$|\/)/i.test(u)) s += 20;    // JPEG (scans are usually JPEG)
    if (/blur_2/.test(u)) s -= 50;              // Wix's tiny blurred preview
    const wMatch = u.match(/w_(\d{2,5})/);      // Wix size param: w_980 etc.
    if (wMatch) s += Math.min(40, parseInt(wMatch[1], 10) / 30);
    if (/logo|icon|favicon|avatar/i.test(u)) s -= 80;
    return s;
  }
  const ranked = allWix.map(u => ({ u, s: imgScore(u) })).sort((a, b) => b.s - a.s);
  const imgUrl = ranked[0].u;

  // Fetch image bytes
  let imgBytes, mediaType = "image/jpeg";
  try {
    const imgRes = await fetch(imgUrl);
    if (!imgRes.ok) return jsonResponse({ error: "Wheeler image returned HTTP " + imgRes.status }, 502);
    const ct = imgRes.headers.get("Content-Type") || "";
    if (ct.includes("png")) mediaType = "image/png";
    imgBytes = await imgRes.arrayBuffer();
  } catch (err) {
    return jsonResponse({ error: "Wheeler image fetch failed: " + err.message }, 502);
  }

  const base64 = arrayBufferToBase64(imgBytes);
  const model = env.AI_MODEL_VISION || "claude-haiku-4-5-20251001";
  const prompt = "This is a livestock auction market report from Wheeler Livestock Auction in Osceola, MO. " +
    "Extract pricing data for FEEDER STEERS in the 500-550 lb weight class (Medium and Large frame, #1 muscle if listed). " +
    "Return ONLY valid JSON, no other text, no markdown fences. Schema: " +
    '{"barn":"wheeler","sale_date":"YYYY-MM-DD","weight_class":"500-550","head_count":<number_or_null>,' +
    '"avg_cwt":<number_dollars>,"low_cwt":<number>,"high_cwt":<number>,"frame_grade":"<eg Med & Lg 1>",' +
    '"notes":"<caveats — eg \"closest match was 500-549 lbs\" if exact range missing>"}. ' +
    "If the report doesn't contain a 500-550 lb feeder steer line, find the closest weight class and note it in 'notes'. " +
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
        max_tokens: 600,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt }
          ]
        }]
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

  if (parsed.error) return jsonResponse({ ...parsed, image_url: imgUrl, model }, 200);

  const result = { ...parsed, model, image_url: imgUrl, generated_at: new Date().toISOString() };
  const cacheRes = new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=43200" } // 12h
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));
  return jsonResponse({ ...result, cached: false });
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

