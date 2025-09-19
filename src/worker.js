// BeanieBabyBuddy — /api/estimate now fetches CURRENT (Browse) + SOLD (Marketplace Insights)
// Copyright © 2025 DJ Woodward-Magar
// All Rights Reserved

/**
 * @fileoverview
 * This worker exposes:
 *   - GET /api/estimate?query=...   -> returns current items, sold items, and stats for both
 *   - POST /log                     -> client log sink
 *   - static fallback via env.ASSETS
 *
 * ENV VARS (Workers > Settings > Variables):
 *   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET      // for Marketplace Insights (client credentials)
 *   EBAY_OAUTH_TOKEN                        // optional: Browse API bearer (app token works too)
 *   ETSY_API_KEY, ETSY_OAUTH_TOKEN          // optional: fallback if eBay current comes up empty
 *   X_EBAY_MARKETPLACE_ID                   // optional: defaults to EBAY_US
 *
 * Response shape for /api/estimate:
 * {
 *   items_current: [{title,price,condition?,url?,source}],
 *   items_sold:    [{title,price,condition?,url?,source}],
 *   stats: {
 *     current:  {count,min,max,avg,median,p25,p75,avg_trimmed},
 *     sold:     {count,min,max,avg,median,p25,p75,avg_trimmed},
 *     combined: {count,min,max,avg,median,p25,p75,avg_trimmed}
 *   },
 *   note: "status notes | …"
 * }
 */

let EBAY_MI_TOKEN = null;
let EBAY_MI_TOKEN_EXP = 0;

/**
 * Get an eBay Marketplace Insights app token via client-credentials.
 * Token cached in-memory until expiry (fine for Workers).
 * @param {any} env
 * @returns {Promise<string>}
 */
async function getEbayInsightsToken(env) {
  const now = Date.now();
  if (EBAY_MI_TOKEN && EBAY_MI_TOKEN_EXP - 60_000 > now) return EBAY_MI_TOKEN;

  const clientId = env.EBAY_CLIENT_ID;
  const clientSecret = env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET");

  const basic = btoa(`${clientId}:${clientSecret}`);
  const scope = "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights";

  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope })
  });
  if (!res.ok) throw new Error(`OAuth token error ${res.status} ${res.statusText}: ${await res.text()}`);

  const data = await res.json();
  const token = String(data.access_token || "");
  const expires = Number(data.expires_in || 0) * 1000;
  if (!token) throw new Error("OAuth token response missing access_token");

  EBAY_MI_TOKEN = token;
  EBAY_MI_TOKEN_EXP = Date.now() + Math.max(expires, 0);
  return token;
}

/**
 * Browse API: search active listings (ask prices) by GTIN or keywords.
 * @param {string} query
 * @param {string} token
 * @param {string} marketplace
 */
async function searchEbayCurrent(query, token, marketplace) {
  const isDigits = /^[0-9]{8,14}$/.test(query);
  const params = new URLSearchParams({ limit: "50" });
  if (isDigits) params.set("gtin", query); else params.set("q", query);

  const headers = { "Authorization": "Bearer " + token, "X-EBAY-C-MARKETPLACE-ID": marketplace, "Accept": "application/json" };
  const res = await fetch("https://api.ebay.com/buy/browse/v1/item_summary/search?" + params, { headers });
  if (!res.ok) throw new Error(res.status + " " + res.statusText + ": " + (await res.text()));
  const data = await res.json();

  const items = (data.itemSummaries || []).map(function (it) {
    const price = Number(it.price && it.price.value || it.currentBidPrice && it.currentBidPrice.value || Number.NaN);
    return { title: it.title, price: price, condition: it.condition, url: it.itemWebUrl, source: "ebay_current" };
  }).filter(function (i) { return Number.isFinite(i.price); });

  return { items, note: isDigits ? "eBay Browse (GTIN, current)" : "eBay Browse (keywords, current)" };
}

/**
 * Marketplace Insights: SOLD comps (roughly last 90 days), by GTIN or keywords.
 * @param {string} query
 * @param {string} token
 * @param {string} marketplace
 */
async function searchEbaySold(query, token, marketplace) {
  const isDigits = /^[0-9]{8,14}$/.test(query);
  const params = new URLSearchParams({ limit: "50" });
  if (isDigits) params.set("gtin", query); else params.set("q", query);

  const headers = { "Authorization": "Bearer " + token, "X-EBAY-C-MARKETPLACE-ID": marketplace, "Accept": "application/json" };
  const url = "https://api.ebay.com/buy/marketplace_insights/v1/item_sales/search?" + params;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(res.status + " " + res.statusText + ": " + (await res.text()));
  const data = await res.json();

  const rows = [];
  const arr = Array.isArray(data.itemSales) ? data.itemSales : Array.isArray(data.item_sales) ? data.item_sales : Array.isArray(data.items) ? data.items : [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i] || {};
    const title = String(it.title || it.itemTitle || it.item?.title || "");
    const condition = it.condition || it.itemCondition || it.item?.condition || undefined;
    const urlWeb = it.itemWebUrl || it.item_web_url || it.item?.itemWebUrl || undefined;
    const price = Number(
      (it.price && it.price.value) ||
      (it.soldPrice && it.soldPrice.value) ||
      (it.lastSoldPrice && it.lastSoldPrice.value) ||
      (it.transactionPrice && it.transactionPrice.value) ||
      (it.item && it.item.price && it.item.price.value) ||
      Number.NaN
    );
    if (Number.isFinite(price)) rows.push({ title, price, condition, url: urlWeb, source: "ebay_sold" });
  }

  const note = (isDigits ? "eBay Marketplace Insights (GTIN, sold)" : "eBay Marketplace Insights (keywords, sold)") + (rows.length ? "" : " — no parsable prices");
  return { items: rows, note };
}

/**
 * Etsy fallback for current listings if eBay current is dry.
 * @param {string} query
 * @param {any} env
 */
async function searchEtsyCurrent(query, env) {
  const params = new URLSearchParams({ limit: "50", state: "active", keywords: query, sort_on: "score" });
  const headers = { "x-api-key": env.ETSY_API_KEY, "Accept": "application/json" };
  if (env.ETSY_OAUTH_TOKEN) headers["Authorization"] = "Bearer " + env.ETSY_OAUTH_TOKEN;

  const res = await fetch("https://api.etsy.com/v3/application/listings/active?" + params, { headers });
  if (!res.ok) throw new Error(res.status + " " + res.statusText + ": " + (await res.text()));
  const data = await res.json();
  const results = Array.isArray(data && data.results) ? data.results : (Array.isArray(data && data.listings) ? data.listings : []);

  const items = results.map(function (it) {
    const m = it.price || it.original_price || null;
    let price = Number.NaN;
    if (m && isFinite(Number(m.amount)) && isFinite(Number(m.divisor)) && Number(m.divisor) !== 0) price = Number(m.amount) / Number(m.divisor);
    else if (typeof it.price === "string") price = Number(it.price);
    const title = it.title || it.listing_title || "";
    const url = it.url || (it.listing_id ? ("https://www.etsy.com/listing/" + it.listing_id) : undefined);
    const cond = it.who_made ? ("who_made:" + it.who_made) : undefined;
    return { title: title, price: price, condition: cond, url: url, source: "etsy_current" };
  }).filter(function (i) { return Number.isFinite(i.price); });

  return { items, note: "Etsy active listings (keywords, current)" };
}

/** Robust stats (with mild IQR trim for avg_trimmed). */
function summarize(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return { count: 0, min: NaN, max: NaN, avg: NaN, median: NaN, p25: NaN, p75: NaN, avg_trimmed: NaN };
  const sum = a.reduce((s, v) => s + v, 0);
  const avg = sum / a.length;
  const q = p => { const i = (a.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return (a[lo] + a[hi]) / 2; };
  const p25 = q(0.25), median = q(0.5), p75 = q(0.75);
  const iqr = p75 - p25, loFence = p25 - 1.5 * iqr, hiFence = p75 + 1.5 * iqr;
  const trimmed = a.filter(v => v >= loFence && v <= hiFence);
  const avg_trimmed = trimmed.length ? trimmed.reduce((s, v) => s + v, 0) / trimmed.length : avg;
  return { count: a.length, min: a[0], max: a[a.length - 1], avg, median, p25, p75, avg_trimmed };
}

/** JSON helper */
function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // === Unified endpoint: current + sold ===
    if (url.pathname === "/api/estimate") {
      const q = url.searchParams.get("query")?.trim();
      if (!q) return json({ error: "Missing query" }, 400);

      const notes = [];
      const marketplace = env.X_EBAY_MARKETPLACE_ID || "EBAY_US";

      // Stage 🔎: Kick both requests (parallel), but we’ll be explicit about statuses in the notes.
      let pCurrent = null;
      let pSold = null;

      // CURRENT (eBay Browse, fallback Etsy)
      if (env.EBAY_OAUTH_TOKEN) {
        pCurrent = searchEbayCurrent(q, env.EBAY_OAUTH_TOKEN, marketplace).catch(e => ({ error: "eBay current error: " + (e && e.message ? e.message : String(e)) }));
      } else {
        notes.push("EBAY_OAUTH_TOKEN not set (current)");
      }

      // SOLD (Marketplace Insights)
      let miReady = true;
      let miToken = null;
      try { miToken = await getEbayInsightsToken(env); }
      catch (e) { miReady = false; notes.push("eBay Insights token error: " + (e && e.message ? e.message : String(e))); }
      if (miReady && miToken) {
        pSold = searchEbaySold(q, miToken, marketplace).catch(e => ({ error: "eBay sold error: " + (e && e.message ? e.message : String(e)) }));
      }

      // Wait 🔎/📈
      const [cur, sold] = await Promise.all([pCurrent, pSold]);

      /** Assemble results */
      let items_current = Array.isArray(cur?.items) ? cur.items : [];
      if (!items_current.length && env.ETSY_API_KEY) {
        // Fallback to Etsy (current) only if eBay current is empty
        try {
          const et = await searchEtsyCurrent(q, env);
          if (et.items.length) items_current = et.items;
          if (cur && cur.note) notes.push(cur.note);
          notes.push(et.note);
        } catch (e) {
          notes.push("Etsy current error: " + (e && e.message ? e.message : String(e)));
        }
      } else {
        if (cur && cur.note) notes.push(cur.note);
        if (cur && cur.error) notes.push(cur.error);
      }

      const items_sold = Array.isArray(sold?.items) ? sold.items : [];
      if (sold && sold.note) notes.push(sold.note);
      if (sold && sold.error) notes.push(sold.error);

      // Stats 📈 → 🏁
      const stats_current = summarize(items_current.map(i => i.price));
      const stats_sold = summarize(items_sold.map(i => i.price));
      const stats_combined = summarize(items_current.concat(items_sold).map(i => i.price));

      return json({ items_current, items_sold, stats: { current: stats_current, sold: stats_sold, combined: stats_combined }, note: notes.join(" | ") });
    }

    // === Client log sink ===
    if (url.pathname === "/log" && req.method === "POST") {
      try {
        const body = await req.json();
        const level = typeof body.level === "string" ? body.level.toLowerCase() : "log";
        const line = "[client] " + (body.msg || "");
        if (level === "error") console.error(line, body.meta || null);
        else if (level === "warn") console.warn(line, body.meta || null);
        else console.log(line, body.meta || null);
      } catch (e) {
        console.warn("[client] bad /log payload", String(e));
      }
      return new Response("ok", { status: 200 });
    }

    // === Static site ===
    if (env.ASSETS && env.ASSETS.fetch) return env.ASSETS.fetch(req);

    return new Response("Not Found", { status: 404 });
  }
};
