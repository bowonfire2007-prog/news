# Project context — "Matt's Daily Read" news dashboard

Paste this whole file into an AI assistant before asking it to change the site.
Your actual request goes at the very bottom, under "MY QUESTION".

---

You are helping me maintain my personal news dashboard ("Matt's Daily Read", Clinton MO).
Two files, no build step:

• index.html — entire front end (~9000 lines). Inline CSS + vanilla JS in one <script>.
  Served from GitHub Pages.

• worker.js — Cloudflare Worker at https://rss-proxy.bowonfire2007.workers.dev
  KV store: BILLS_KV (trackers, briefs, bills, rate-limit counters),
  WEEKLY_KV (cattle market, lake readings).
  Secrets: ANTHROPIC_API_KEY (Claude Sonnet), FINNHUB_API_KEY (stocks),
  TOMORROW_API_KEY (weather), UPLOAD_PIN (PDF upload + admin key fallback),
  ADMIN_KEY (optional, overrides UPLOAD_PIN for admin URLs), STATS_KEY,
  CF_ANALYTICS_TOKEN.
  Crons: 0 13 * * * (8am CDT) bills+trackers+briefs; 0 1 * * * bills+briefs
  repair; Mon/Tue 18:00 UTC MO weekly; Fri 21:00 UTC Wheeler/Kingsville.
  Deploy: push.bat → runs `node preflight.js` (syntax + structure; aborts on
  FAIL) → wrangler deploy → git push. Seed AI endpoints once with
  /<endpoint>-refresh?force=1&key=ADMIN_KEY after worker changes.
  Health check any time: `node preflight.js --live` (set ADMIN_KEY env var
  to also read the cron heartbeat).

ACCESS GUARDS (worker.js, top of file — added 2026-09-16):
• ADMIN_PATHS (all *-refresh, /tabbriefs-repair, /weeklyrefresh, /cron-status)
  need ?key=<ADMIN_KEY or UPLOAD_PIN> → else 403. requireAdminKey().
• BROWSER_PATHS (/brief, /followup, /fishplan, /stockbrief, /cattlemanual,
  /cattleprice, /cattlerecord, /lake-reading, /wx-forecast, /stock*, and the
  ?url= RSS proxy) need an Origin/Referer of the GitHub Pages site, localhost,
  or file:// ("null") → else 403. guardBrowserCall(). The admin key bypasses.
• SPEND_PATHS (the Claude-backed subset) count against daily budgets in
  BILLS_KV: 60 per IP, 400 site-wide (SPEND_LIMIT_* consts) → 429 past that.
  /cattleprice only counts with ?fresh=1. guardSpend().
• Plain KV reads (/tabbriefs, /trackers, /local-bills, /reps, /weeklydata,
  /cattlehistory, /lake-history) are NOT gated.
• Cron jobs call run*Scheduled() directly — guards never touch them.
• NEW ENDPOINT RULE: add it to the matching Set. A new Claude endpoint goes in
  BROWSER_PATHS and SPEND_PATHS; a new hand-run admin URL goes in ADMIN_PATHS.

KEY PATTERNS IN index.html:
• CATEGORIES array — defines every news tab (id, label, feeds[]).
• TAB_RAIL map — controls right-column cards per tab.
  Types: "data" (live worker fetch), "tracker" (AI status card), "brief" (AI digest),
         "watch" (Google News topic), "reference" (static).
• DATA_MODULES — { id: { title, icon, color, load(), render() } } for live cards.
• TRACKER_DATA — fallback data for tracker cards if worker is unavailable.
• renderRailModule() — switch on mod.type; add new types here.
• railCardShell(def, bodyHtml) — shared visual shell for all rail cards.
• CF_WORKER constant — base URL for all worker fetches.

KEY PATTERNS IN worker.js:
• fetchTopicHeadlines(query, max) — Google News RSS → [{title,src,url,date,desc}]
• generateTrackerCard(cfg, headlines, key) — calls Claude, returns structured card JSON.
• jsonResponse(data, status) — standard JSON response with CORS headers.
• hashKey(str) — async SHA-256 for cache-busting checks.
• KV pattern: put with expirationTtl: 2*365*24*3600; get returns null if missing.
• All AI endpoints follow: fetch headlines → hash check → call Claude → store KV →
  return cached on GET, refresh on /endpoint-refresh?force=1.

CONVENTIONS:
• Preserve existing structure; change as little as needed.
• New rail cards: add to DATA_MODULES + TAB_RAIL. New AI topics: add to TRACKERS_CONFIG.
• CSS variables: --bg, --text, --accent (#b8331a), --sage, --border. Dark-mode toggle exists.
• Card classes: .track-card, .tc-*, .tc-head, .tc-note, .tc-srcline, .rail-err.
• After worker edits: push.bat, then hit /endpoint-refresh?force=1 to seed.
• RESPONSIVE CSS: the stylesheet ends with a block commented "MOBILE CONSOLIDATION".
  It is deliberately LAST and ordered 760px → 520px → 420px so the narrower
  breakpoint always wins. Put NEW mobile rules there, not in the older
  @media blocks earlier in the file (those are largely superseded).

KEEPING THIS PROMPT CURRENT:
After any session that adds a new feature, endpoint, module, or changes a key pattern,
ask Cowork to update this file so the next session starts with accurate context. Specifically
update: new KV keys, new worker endpoints, new DATA_MODULES entries, new TRACKERS_CONFIG
keys, new TAB_RAIL entries, changed cron schedules, or any new deploy steps.

RECENT CHANGES (update this section after big sessions):
• History cards + weather history (2026-09-17):
  - worker.js, new section between handleBriefsRefresh and `export default`:
    · GET /wx-history → { wx, tornado }. wx = today's record hi/lo/pcpn/snow
      (with tie years), 1991-2020 normals, last-year-today, 35-day PRISM strip
      with normal band, month-to-date rank vs normal, all-time top-5 lists.
      Source: NOAA ACIS — station "231711 2" (Clinton COOP, 1906→) for records
      and normals; GridData grid 21 (PRISM) for anything recent because the
      COOP observer skips weekends. tornado = SPC database filtered to Henry +
      8 neighbouring counties (TORNADO_COUNTIES), 60-day cache.
      KV: wxhist:data (daily), wxhist:tornado.
    · GET /history → { history: { local, usa, world } }. One Sonnet call per
      tab per day (HISTORY_TABS, generateHistoryCard). The Local prompt gets
      VERIFIED facts (today's records, tornadoes on this date) from the wx
      store. KV: history:data:<tab>, keyed by Central date (centralDateStr).
    · Admin: /history-refresh?force=1&key=…, /wx-history-refresh?force=1&key=…
      (both in ADMIN_PATHS). Cron: both daily crons run wx-history then
      history; each no-ops if today's copy exists.
    · Every ACIS value goes through acisNum() — "M"/-999 → null, never 0.
  - index.html: DATA_MODULES historyLocal/historyUsa/historyWorld (built by
    historyModuleDef), wxHistory, tornadoHistory. TAB_RAIL: local/usa/world
    get a history card; NEW `forecast` rail carries the two weather cards.
    renderRailModule "data" now honours an optional def.isLive(data) so a
    stale payload drops the Live badge. calendarAgeDays() compares Central
    calendar dates (briefAgeDays would call a morning card "1 day old" by
    evening). Helpers: railFetchMemo, fetchHistoryAll, fetchWxHistory,
    wxSparklineSVG. CSS: .hx-* and .wxh-* next to the .track-card rules; one
    :has() rule in MOBILE CONSOLIDATION keeps the forecast rail below the
    forecast on phones.
  - preflight.js --live now also checks /history and /wx-history.
  - SEED AFTER DEPLOY: /wx-history-refresh?force=1&key=… then
    /history-refresh?force=1&key=… (in that order — Local uses the wx facts).
  - STATIC DATA (same session, round 2): data/climate.json and
    data/mdc-seasons.json are committed files served by Pages, built by
    tools/build-climate-data.js (tornadoes since 1950 for Henry + 8
    neighbours, Clinton freeze dates per year, Truman pool by calendar day
    since 1986 from USACE CDA) and tools/build-mdc-seasons.js (scrapes MDC's
    hunting + fishing "seasons at a glance" tables). Re-run each once a
    year; the page reads them via fetchClimate()/fetchMdcSeasons(); the
    worker fetches climate.json only for the Local history facts.
    Why static: the upstream files are 8–11 MB; parsing them in a Worker is
    the CPU-heavy job Workers are worst at, and none of it changes daily.
  - More DATA_MODULES: almanac (sun/daylight/moon/next solstice/freeze
    outlook — sunTimes() is NOAA math, no API), growingSeason (GDD + rain
    since Apr 1 vs normal from /wx-history `season`), lakeThisDate (pool
    today vs every year on this date), seasonCountdown (MDC open/soon/later).
    TAB_RAIL now has forecast, outdoor and garden entries; the MOBILE
    CONSOLIDATION :has() rule keeps those three rails BELOW the main content
    on phones.
  - Outdoor tab also carries DATA_MODULES.stateRecords: MDC state record fish
    (all 135, local waters first, this-week-in-record-history) + two hand-kept
    whitetail benchmarks, from data/records.json (tools/build-records.js —
    re-run when MDC announces a new record).
  - Market tab: renderWeeklyLookback() strip above the weekly history list —
    stocker/corn/boxed beef vs 4 wks, 8 wks, year ago (year-ago says
    "from Feb 2027" until the store is 12 months deep).
• Security / hygiene pass (2026-09-16) — see AUDIT-2026-09-16.md for the findings:
  - worker.js: access guards (above). Every Claude-backed and data-writing
    endpoint was previously callable by anyone; /followup was a free chat proxy.
  - worker.js: hard-coded fallback upload PIN removed — UPLOAD_PIN is required.
  - worker.js: generateBrief prompt has an explicit GROUNDING RULE and drops
    bullets that resolve to no source headline.
  - preflight.js added; push.bat runs it before deploying.
  - Old index.backup-* / worker.backup-* files moved to _archive/ (gitignored).
    git history holds every deployed version — `git log --oneline`.
  - Known live issue found by preflight --live: /wx-forecast returns
    "Tomorrow.io HTTP 401" — the TOMORROW_API_KEY secret is expired/invalid.
    Fix: get a new key at tomorrow.io, then `wrangler secret put TOMORROW_API_KEY`.
  - index.html: WATCH_TOPICS moved from Google News search RSS to Bing News
    RSS (`terms` list per topic, watchFeedUrls/unwrapBingLink helpers).
    ROOT CAUSE, worth remembering: news.google.com/rss blocks datacenter IPs.
    The Worker proxy gets a 503 "Sorry" page; rss2json only serves a Google
    query it already has cached (a fresh one fails after ~8 s); allorigins is
    CORS-blocked. Any Google News feed still in CATEGORIES (there are ~100)
    only loads when rss2json happens to have it cached, and rss2json 429s
    this household's IP under load. FIXED SAME DAY: worker.js
    handleGoogleNewsViaBing (just above handleRssProxy) intercepts every
    news.google.com/rss/search url the page sends through ?url= and answers
    it from Bing News RSS — the Google query is parsed (quotes, site:,
    when:Nd, OR, parentheses) into ≤4 Bing searches (GN_MAX_QUERIES),
    merged, and returned as RSS 2.0. So CATEGORIES can keep using Google
    News urls as the query "language"; they just never reach Google.
    index.html fetchFeed sends those urls to the cfworker proxy only.
    Bing can't answer site: for small sites (mdc.mo.gov, clintondailydemocrat)
    — use keyword queries or a direct feed for those.
  - Dead DIRECT feeds noticed while testing (404 — not fixed, low priority):
    bassmaster.com/rss.xml, 1source.basspro.com/feed, realtree.com/feed,
    drovers.com/feed/, agweb.com/rss.xml.
  - Dead code (not removed): worker handleUsdaCattle + addCattlePricesBatch;
    index.html dayLabel + renderCattleSparkline.
• Brief integrity pass (2026-08-30) — follow-on to the 8/29 feed fix:
  - worker.js: sourceLabel(url) + SRC_LABELS map added above parseNewsItems.
    Direct RSS feeds carry no <source> element, so once Google News was dropped
    from BRIEFS_CONFIG every brief and tracker bullet rendered with a BLANK
    byline. parseNewsItems now falls back to a domain-derived label. Add new
    feeds' domains to SRC_LABELS or they get a title-cased domain instead.
  - worker.js: local brief feed kmbc.com/topstories-rss REPLACED — it answers
    HTTP 451 to this Worker's egress IP (works fine from a browser). Swapped for
    kshb.com/news.rss + columbiamissourian.com search RSS.
  - worker.js: runBriefsRepair(env, ctx) added, wired to the existing 01:00 UTC
    cron and exposed at GET /tabbriefs-repair. Regenerates ONLY briefs whose
    stored card is 2+ days old, so a one-off morning feed outage self-heals that
    night. No-op (no Claude call) when everything is current.
  - index.html: briefAgeDays() + BRIEF_STALE_DAYS in briefCardHTML. A brief card
    2+ days old loses its "Live" badge and gets an amber banner saying how old it
    is. This is the safety net for the 18-day tech incident: the card was frozen
    and wearing a Live badge the whole time.
  - Diagnostics: /tabbriefs-refresh?force=1 returns deadFeeds per topic — that
    is the fastest way to see which feed has gone dark.
• Tracker hardening (2026-08-30, same session):
  - Every tracker used Google News as its PRIMARY source with only 1-3 direct
    feeds behind it (quantum and cannabis had exactly one). Added verified
    fallback feeds so no tracker depends on a single publisher:
    cannabis +mjbizdaily +ganjapreneur; local +utilitydive +missourinet;
    cannabis_mo +missourinet +mjbizdaily; quantum +phys.org +IEEE Spectrum
    +HPCwire; ai_agi +techcrunch AI +technologyreview.
  - fetchTopicHeadlines now attaches out.sourceStats ({src, kept, raw, err} per
    source) and out.newestAgeDays. `raw` is the pre-keyword-filter count, so a
    dead feed (raw 0) is distinguishable from a too-narrow keyword list
    (raw 40 / kept 0). processOneTracker surfaces both in /trackers-refresh.
  - generateTrackerCard now THROWS on an empty headline pool instead of writing
    a card from the scaffold alone — the same failure mode that produced the
    18-day fictional tech brief.
  - "all sources failed" now names each source and its error.
  - index.html: TRACKER_STALE_DAYS = 10 (much looser than briefs — trackers pin
    via minAgeDays and cover quiet niches). Past that the "Tracking" badge is
    replaced by "Nd old" plus an amber note. If LIVE_TRACKERS is unavailable and
    the card falls back to the hardcoded TRACKER_DATA, the badge reads
    "Offline copy" — that fallback used to be indistinguishable from live data.
• Mobile usability pass (Aug 2026) — index.html only, no worker changes:
  - STRUCTURAL: .section-bar + .quick-tabs moved OUT of <header> into a new
    <div class="section-nav" id="sectionNav"> that is a direct child of <body>,
    sitting between </header> and <main>. <header> is now position:relative
    (it was sticky, and it also has overflow:hidden, which would have broken a
    nested sticky anyway). .section-nav is position:sticky; top:0 — so the
    section tabs stay reachable at any scroll depth. All element IDs unchanged.
  - header.header-hidden is now a no-op rule; setupHeaderAutoHide() still
    toggles it but its only real job is showing the floating scroll-to-top pill.
  - New helpers lockScroll() / unlockScroll() / isScrollLocked() replace
    `document.body.style.overflow = "hidden"` for the drawer (iOS-safe, pins
    the body and restores the exact scroll offset). Body gets .scroll-locked.
  - Pull-to-refresh rewritten as setupPullToRefresh(): requires a 90px mostly
    vertical pull, rejects horizontal swipes and horizontally scrollable strips,
    no-ops while the drawer/modal is open, and shows a .ptr-pill indicator.
  - All collapse panels got much larger max-height values so they stop clipping
    wrapped text on narrow screens.
  - Inputs are 16px under 760px (stops iOS focus zoom); touch targets enlarged;
    :active feedback added under @media (hover:none); background-attachment
    switched to scroll under 900px and footer backdrop-filter removed (jank).
• JBTDS / InnovaPrep Monitor — REMOVED 2026-08-23 (no code remains; see
  _archive/*prejbtdsremoval* if it ever needs to come back).

---

## MY QUESTION

<!-- Write your request below this line. -->
