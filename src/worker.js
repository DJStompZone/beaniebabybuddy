/**
 * eBay Estimator (compat API) — Now with Browse (OAuth) for current listings when query is a UPC.
 *
 * API (unchanged):
 *   GET /api/estimate?query=<string>
 *   -> { items_current, items_sold, stats: { current, sold, combined }, note }
 *
 * Env:
 *   EBAY_APP_ID                // required for Finding API (current+sold fallback)
 *   EBAY_CLIENT_ID             // optional; if present with secret, we try Browse for "current" when query is digits
 *   EBAY_CLIENT_SECRET         // optional; pairs with EBAY_CLIENT_ID for Browse (client-credentials)
 *   X_EBAY_MARKETPLACE_ID      // optional; defaults to EBAY_US for Browse
 *
 * Caching:
 *   - Result cache: in-memory Map for 15 minutes (same as your original).
 *   - OAuth token cache: in-memory + Workers Cache API (no KV used). TTL derived from expires_in (~2h).
 *
 * Notes:
 *   - SOLD still uses Finding (findCompletedItems) because Browse comps require a separate, gated API.
 *   - CURRENT prefers Browse (if UPC-ish and creds present), else Finding (your original behavior).
 */

const CACHE = new Map(); // response cache by query for 15 min
const TTL_MS = 15 * 60 * 1000;

// Per-isolate OAuth memo (no KV)
let TOKEN_MEMO = { access_token: null, expires_at: 0, scope_key: "" };
const BROWSE_SCOPE = "https://api.ebay.com/oauth/api_scope";

/**
 * @param {any} body
 * @param {number} [status=200]
 * @returns {Response}
 */
function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json" } });
}

/**
 * Robust descriptive stats with IQR-trimmed average.
 * @param {number[]} values
 * @returns {{count:number,min:number,max:number,avg:number,median:number,p25:number,p75:number,avg_trimmed:number}}
 */
function summarize(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return { count: 0, min: NaN, max: NaN, avg: NaN, median: NaN, p25: NaN, p75: NaN, avg_trimmed: NaN };
  const sum = a.reduce((s, v) => s + v, 0), avg = sum / a.length;
  const q = p => { const i = (a.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return (a[lo] + a[hi]) / 2; };
  const p25 = q(0.25), median = q(0.5), p75 = q(0.75), iqr = p75 - p25, lo = p25 - 1.5 * iqr, hi = p75 + 1.5 * iqr;
  const trimmed = a.filter(v => v >= lo && v <= hi);
  const avg_trimmed = trimmed.length ? trimmed.reduce((s, v) => s + v, 0) / trimmed.length : avg;
  return { count: a.length, min: a[0], max: a[a.length - 1], avg, median, p25, p75, avg_trimmed };
}

/**
 * Light wrapper for eBay Finding API.
 * Handles JSON parsing and rate-limit error 10001 as a typed error.
 * @param {string} op
 * @param {Record<string,string|number|boolean>} params
 * @param {string} appId
 */
async function ebayFinding(op, params, appId) {
  const url = new URL("https://svcs.ebay.com/services/search/FindingService/v1");
  url.searchParams.set("OPERATION-NAME", op);
  url.searchParams.set("SERVICE-VERSION", "1.13.0");
  url.searchParams.set("SECURITY-APPNAME", appId);
  url.searchParams.set("RESPONSE-DATA-FORMAT", "JSON");
  url.searchParams.set("REST-PAYLOAD", "true");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { throw new Error("Finding parse error: " + text.slice(0, 200)); }

  const err = data && data.errorMessage && data.errorMessage.error && data.errorMessage.error[0];
  if (err) {
    const code = String(err.errorId && err.errorId[0] || "");
    const msg = String(err.message && err.message[0] || "");
    if (code === "10001") throw Object.assign(new Error("Finding rate limit: " + msg), { rateLimited: true });
    throw new Error("Finding error " + code + ": " + msg);
  }
  return data;
}

/**
 * Map Finding items to your current item shape.
 * @param {any[]} arr
 * @param {string} sourceTag
 */
function mapFindingItems(arr, sourceTag) {
  const items = [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    const title = it.title && it.title[0] || "";
    const selling = it.sellingStatus && it.sellingStatus[0] || {};
    const priceObj = selling.currentPrice && selling.currentPrice[0] || {};
    const price = Number(priceObj.__value__ || NaN);
    const url = it.viewItemURL && it.viewItemURL[0] || undefined;
    const cond = it.condition && it.condition[0] && it.condition[0].conditionDisplayName && it.condition[0].conditionDisplayName[0] || undefined;
    if (Number.isFinite(price)) items.push({ title, price, condition: cond, url, source: sourceTag });
  }
  return items;
}

/**
 * Current items via Finding (keywords; optional UPC filter).
 * @param {string} q
 * @param {string} appId
 */
async function searchFindingCurrent(q, appId) {
  const isDigits = /^[0-9]{8,14}$/.test(q);
  const params = isDigits ? { keywords: q, "itemFilter(0).name": "UPC", "itemFilter(0).value": q, "paginationInput.entriesPerPage": "50" } : { keywords: q, "paginationInput.entriesPerPage": "50" };
  const data = await ebayFinding("findItemsByKeywords", params, appId);
  const arr = (((data.findItemsByKeywordsResponse || [])[0] || {}).searchResult || [])[0] || {};
  const list = Array.isArray(arr.item) ? arr.item : [];
  const items = mapFindingItems(list, "ebay_current_finding");
  return { items, note: "eBay Finding (current)" };
}

/**
 * Sold items via Finding (findCompletedItems + SoldItemsOnly true).
 * @param {string} q
 * @param {string} appId
 */
async function searchFindingSold(q, appId) {
  const isDigits = /^[0-9]{8,14}$/.test(q);
  const params = { keywords: q, "itemFilter(0).name": "SoldItemsOnly", "itemFilter(0).value": "true", "paginationInput.entriesPerPage": "50" };
  if (isDigits) { params["itemFilter(1).name"] = "UPC"; params["itemFilter(1).value"] = q; }
  const data = await ebayFinding("findCompletedItems", params, appId);
  const arr = (((data.findCompletedItemsResponse || [])[0] || {}).searchResult || [])[0] || {};
  const list = Array.isArray(arr.item) ? arr.item : [];
  const items = mapFindingItems(list, "ebay_sold_finding");
  return { items, note: "eBay Finding (sold)" };
}

/**
 * Get an application access token for Browse using client-credentials.
 * Caches token in-memory and via Workers Cache API (no KV). TTL = ~90% of expires_in.
 * @param {any} env
 * @param {string} scopes
 */
async function getAppTokenCached(env, scopes) {
  const now = Date.now();
  if (TOKEN_MEMO.access_token && TOKEN_MEMO.expires_at > now + 60_000 && TOKEN_MEMO.scope_key === scopes) return TOKEN_MEMO.access_token;

  const cache = caches.default;
  const keyReq = new Request("https://token-cache/ebay/app?scope=" + encodeURIComponent(scopes), { method: "GET" });
  const cached = await cache.match(keyReq);
  if (cached && cached.ok) {
    const data = await cached.json();
    if (data?.access_token && data?.expires_at && data.expires_at > now + 60_000) {
      TOKEN_MEMO = { access_token: data.access_token, expires_at: data.expires_at, scope_key: scopes };
      return data.access_token;
    }
  }

  const clientId = env.EBAY_CLIENT_ID, clientSecret = env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Browse token requested but EBAY_CLIENT_ID/EBAY_CLIENT_SECRET missing");

  const basic = btoa(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: scopes });

  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", { method: "POST", headers: { "authorization": `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token fetch failed ${res.status}: ${text.slice(0, 400)}`);
  }
  const tok = await res.json(); // { access_token, expires_in, token_type, ... }
  const expires_in = Math.max(60, Number(tok.expires_in || 0));
  const expires_at = Date.now() + expires_in * 1000;

  TOKEN_MEMO = { access_token: tok.access_token, expires_at, scope_key: scopes };

  // Cache API with TTL ~ 90% of expires_in
  const ttlSec = Math.max(60, Math.floor(expires_in * 0.9));
  const cacheResp = new Response(JSON.stringify({ access_token: tok.access_token, expires_at }), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSec}` } });
  await cache.put(keyReq, cacheResp);

  return tok.access_token;
}

/**
 * Browse "current listings" via item_summary/search using q=<UPC>.
 * Only used when the query looks like digits and we have OAuth creds.
 * @param {string} q
 * @param {number} limit
 * @param {string} market
 * @param {string} token
 * @returns {{items: Array<{title:string,price:number,condition?:string,url?:string,source:string}>, note: string}}
 */
async function searchBrowseCurrentByQ(q, limit, market, token) {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(Math.min(Math.max(1, limit || 50), 200)));

  const res = await fetch(url.toString(), { headers: { "authorization": `Bearer ${token}`, "x-ebay-c-marketplace-id": market || "EBAY_US", "accept": "application/json" } });
  if (!res.ok) {
    // We won't blow up the whole request — just let caller fallback to Finding.
    const txt = await res.text();
    throw new Error(`Browse q failed ${res.status}: ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  const arr = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];
  const items = [];
  for (const it of arr) {
    const title = it?.title || "";
    const val = Number(it?.price?.value || NaN);
    const currency = it?.price?.currency || undefined; // you don't surface currency in items_current, so we ignore; stats still use price only
    const url = it?.itemWebUrl || undefined;
    const condition = typeof it?.condition === "string" ? it.condition : undefined;
    if (Number.isFinite(val)) items.push({ title, price: val, condition, url, source: "ebay_current_browse" });
  }
  return { items, note: "eBay Browse (current via q)" };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/estimate") {
      const q = (url.searchParams.get("query") || "").trim();
      if (!q) return json({ error: "Missing query" }, 400);

      if (!env.EBAY_APP_ID && !(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET)) {
        // Preserve shape; signal config issue
        return json({ items_current: [], items_sold: [], stats: { current: {}, sold: {}, combined: {} }, note: "EBAY_APP_ID or EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set" }, 500);
      }

      const now = Date.now();
      const cached = CACHE.get(q);
      if (cached && cached.exp > now) return json(cached.payload);

      let items_current = [], items_sold = [], notes = [];
      const isDigits = /^[0-9]{8,14}$/.test(q);

      // Try Browse for current if UPC-ish and creds present; else Finding current
      if (isDigits && env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) {
        try {
          const token = await getAppTokenCached(env, BROWSE_SCOPE);
          const market = env.X_EBAY_MARKETPLACE_ID || "EBAY_US";
          const cur = await searchBrowseCurrentByQ(q, 50, market, token);
          items_current = cur.items || [];
          if (cur.note) notes.push(cur.note);
        } catch (e) {
          notes.push("Browse current error: " + (e && e.message ? e.message : String(e)));
          // Fall through to Finding current as backup if we have APP_ID
          if (env.EBAY_APP_ID) {
            try {
              const curF = await searchFindingCurrent(q, env.EBAY_APP_ID);
              items_current = curF.items || [];
              if (curF.note) notes.push(curF.note);
            } catch (e2) {
              if (e2.rateLimited) notes.push("Finding current: rate-limited");
              else notes.push("Finding current error: " + (e2 && e2.message ? e2.message : String(e2)));
            }
          }
        }
      } else if (env.EBAY_APP_ID) {
        try {
          const cur = await searchFindingCurrent(q, env.EBAY_APP_ID);
          items_current = cur.items || [];
          if (cur.note) notes.push(cur.note);
        } catch (e) {
          if (e.rateLimited) notes.push("Finding current: rate-limited");
          else notes.push("Finding current error: " + (e && e.message ? e.message : String(e)));
        }
      }

      // SOLD always via Finding
      if (env.EBAY_APP_ID) {
        try {
          const sold = await searchFindingSold(q, env.EBAY_APP_ID);
          items_sold = sold.items || [];
          if (sold.note) notes.push(sold.note);
        } catch (e) {
          if (e.rateLimited) notes.push("Finding sold: rate-limited");
          else notes.push("Finding sold error: " + (e && e.message ? e.message : String(e)));
        }
      }

      // Stats are computed the same way
      const stats_current = summarize(items_current.map(i => i.price));
      const stats_sold = summarize(items_sold.map(i => i.price));
      const stats_combined = summarize(items_current.concat(items_sold).map(i => i.price));
      const payload = { items_current, items_sold, stats: { current: stats_current, sold: stats_sold, combined: stats_combined }, note: notes.join(" | ") };

      CACHE.set(q, { exp: now + TTL_MS, payload });
      return json(payload);
    }

    if (url.pathname === "/log" && req.method === "POST") return new Response("ok");
    if (env.ASSETS && env.ASSETS.fetch) return env.ASSETS.fetch(req);
    return new Response("Not Found", { status: 404 });
  }
};
