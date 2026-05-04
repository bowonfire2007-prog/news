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
