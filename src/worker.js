// HOTFIX: eBay Finding-only backend (no OAuth), with caching & backoff
// /api/estimate returns items_current, items_sold, stats, note
// Env: EBAY_APP_ID (prod), X_EBAY_MARKETPLACE_ID optional (unused here)

const CACHE = new Map(); // simple in-memory cache by query for 15 min
const TTL_MS = 15 * 60 * 1000;

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json" } });
}

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

  // Handle rate limit (10001) politely
  const err = data && data.errorMessage && data.errorMessage.error && data.errorMessage.error[0];
  if (err) {
    const code = String(err.errorId && err.errorId[0] || "");
    const msg = String(err.message && err.message[0] || "");
    if (code === "10001") throw Object.assign(new Error("Finding rate limit: " + msg), { rateLimited: true });
    throw new Error("Finding error " + code + ": " + msg);
  }
  return data;
}

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

async function searchFindingCurrent(q, appId) {
  // Current = findItemsByKeywords; if numeric 8-14 digits, try UPC filter
  const isDigits = /^[0-9]{8,14}$/.test(q);
  const params = isDigits
    ? { keywords: q, "itemFilter(0).name": "UPC", "itemFilter(0).value": q, "paginationInput.entriesPerPage": "50" }
    : { keywords: q, "paginationInput.entriesPerPage": "50" };
  const data = await ebayFinding("findItemsByKeywords", params, appId);
  const arr = (((data.findItemsByKeywordsResponse || [])[0] || {}).searchResult || [])[0] || {};
  const list = Array.isArray(arr.item) ? arr.item : [];
  const items = mapFindingItems(list, "ebay_current_finding");
  return { items, note: "eBay Finding (current)" };
}

async function searchFindingSold(q, appId) {
  // SOLD = findCompletedItems + SoldItemsOnly
  const isDigits = /^[0-9]{8,14}$/.test(q);
  const params = {
    keywords: q,
    "itemFilter(0).name": "SoldItemsOnly",
    "itemFilter(0).value": "true",
    "paginationInput.entriesPerPage": "50"
  };
  if (isDigits) { params["itemFilter(1).name"] = "UPC"; params["itemFilter(1).value"] = q; }
  const data = await ebayFinding("findCompletedItems", params, appId);
  const arr = (((data.findCompletedItemsResponse || [])[0] || {}).searchResult || [])[0] || {};
  const list = Array.isArray(arr.item) ? arr.item : [];
  const items = mapFindingItems(list, "ebay_sold_finding");
  return { items, note: "eBay Finding (sold)" };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/estimate") {
      const q = (url.searchParams.get("query") || "").trim();
      if (!q) return json({ error: "Missing query" }, 400);
      if (!env.EBAY_APP_ID) return json({ items_current: [], items_sold: [], stats: { current: {}, sold: {}, combined: {} }, note: "EBAY_APP_ID not set" }, 500);

      const now = Date.now(), cacheKey = q;
      const cached = CACHE.get(cacheKey);
      if (cached && cached.exp > now) return json(cached.payload);

      let items_current = [], items_sold = [], notes = [];
      try {
        const [cur, sold] = await Promise.all([
          searchFindingCurrent(q, env.EBAY_APP_ID).catch(e => { if (e.rateLimited) notes.push("Finding current: rate-limited"); else notes.push("Finding current error: " + e.message); return { items: [] }; }),
          searchFindingSold(q, env.EBAY_APP_ID).catch(e => { if (e.rateLimited) notes.push("Finding sold: rate-limited"); else notes.push("Finding sold error: " + e.message); return { items: [] }; })
        ]);
        items_current = cur.items || [];
        items_sold = sold.items || [];
        if (cur.note) notes.push(cur.note);
        if (sold.note) notes.push(sold.note);
      } catch (e) {
        notes.push("Finding fatal: " + (e && e.message ? e.message : String(e)));
      }

      const stats_current = summarize(items_current.map(i => i.price));
      const stats_sold = summarize(items_sold.map(i => i.price));
      const stats_combined = summarize(items_current.concat(items_sold).map(i => i.price));
      const payload = { items_current, items_sold, stats: { current: stats_current, sold: stats_sold, combined: stats_combined }, note: notes.join(" | ") };

      CACHE.set(cacheKey, { exp: now + TTL_MS, payload });
      return json(payload);
    }

    if (url.pathname === "/log" && req.method === "POST") { return new Response("ok"); }
    if (env.ASSETS && env.ASSETS.fetch) return env.ASSETS.fetch(req);
    return new Response("Not Found", { status: 404 });
  }
};
