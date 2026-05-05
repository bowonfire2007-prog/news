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
    return handleRssProxy(url);
  }
};

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

// ─────────────── TRUMAN LAKE — USACE NWK SCRAPE ───────────────
// Fetches the official Corps page for Harry S Truman Dam & Reservoir and extracts
// pool elevation, inflow, outflow, and 24-hour change. Falls through gracefully if
// the page format changes — the client side has its own NOAA TUMM7 fallback.
async function handleLake(url, ctx) {
  const debug = url.searchParams.get("debug") === "1";
  const cache = caches.default;
  const cacheReq = new Request("https://lake-cache.local/hast", { method: "GET" });

  if (!debug) {
    const cached = await cache.match(cacheReq);
    if (cached) {
      const cachedJson = await cached.json();
      return jsonResponse({ ...cachedJson, cached: true });
    }
  }

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
      return jsonResponse({ error: "USACE HTTP " + res.status }, 502);
    }
    html = await res.text();
  } catch (err) {
    return jsonResponse({ error: "USACE fetch failed: " + err.message }, 502);
  }

  // If the page is a JS-rendered SPA, the data may live inside an embedded JSON blob
  // rather than rendered HTML. We try several extraction strategies and use whichever
  // one yields valid values.
  const parsed = parseUsaceHast(html);

  if (debug) {
    return jsonResponse({
      parsed,
      htmlLength: html.length,
      htmlSample: html.slice(0, 4000),
      htmlMid: html.slice(Math.floor(html.length / 2), Math.floor(html.length / 2) + 4000)
    });
  }

  if (parsed.elevation === null) {
    return jsonResponse({ error: "Could not parse pool elevation from USACE page", parsed }, 502);
  }

  const result = {
    ...parsed,
    source: "USACE NWK HAST",
    fetched_at: new Date().toISOString()
  };

  const cacheRes = new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=600"
    }
  });
  ctx.waitUntil(cache.put(cacheReq, cacheRes.clone()));

  return jsonResponse({ ...result, cached: false });
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
