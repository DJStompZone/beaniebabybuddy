// BeanieBabyBuddy — unified estimate with eBay Buy tokens + Finding fallback + optional Etsy
// Copyright © 2025 DJ
// All rights reserved

let __TOKENS = {}; // in-memory per-scope token cache

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "content-type": "application/json" },
  });
}

/** -------- Token minting (client-credentials) -------------------------------- */
async function getEbayToken(env, scope) {
  const t = __TOKENS[scope];
  if (t && t.exp > Date.now() + 60000) return t.val;

  const id = env.EBAY_CLIENT_ID,
    sec = env.EBAY_CLIENT_SECRET;
  if (!id || !sec) throw new Error("Missing EBAY_CLIENT_ID/EBAY_CLIENT_SECRET");
  const basic = btoa(id + ":" + sec);

  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + basic,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent(scope),
  });
  if (!res.ok)
    throw new Error(
      "eBay token error " + res.status + " " + (await res.text())
    );
  const data = await res.json();
  const val = String(data.access_token || "");
  const exp = Date.now() + Number(data.expires_in || 0) * 1000;
  if (!val) throw new Error("No access_token in token response");
  __TOKENS[scope] = { val, exp };
  return val;
}

/** -------- Browse (current) + MI (sold) -------------------------------------- */
async function searchEbayCurrent(query, token, marketplace) {
  const isDigits = /^[0-9]{8,14}$/.test(query);
  const params = new URLSearchParams({ limit: "50" });
  if (isDigits) params.set("gtin", query);
  else params.set("q", query);
  const res = await fetch(
    "https://api.ebay.com/buy/browse/v1/item_summary/search?" + params,
    {
      headers: {
        Authorization: "Bearer " + token,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
        Accept: "application/json",
      },
    }
  );
  if (!res.ok)
    throw new Error(
      res.status + " " + res.statusText + ": " + (await res.text())
    );
  const data = await res.json();
  const items = (data.itemSummaries || [])
    .map((it) => {
      const price = Number(
        (it.price && it.price.value) ||
          (it.currentBidPrice && it.currentBidPrice.value) ||
          Number.NaN
      );
      return {
        title: it.title || "",
        price,
        condition: it.condition,
        url: it.itemWebUrl,
        source: "ebay_current",
      };
    })
    .filter((i) => Number.isFinite(i.price));
  return {
    items,
    note: isDigits
      ? "eBay Browse (GTIN, current)"
      : "eBay Browse (keywords, current)",
  };
}

async function searchEbaySold(query, token, marketplace) {
  const isDigits = /^[0-9]{8,14}$/.test(query);
  const params = new URLSearchParams({ limit: "50" });
  if (isDigits) params.set("gtin", query);
  else params.set("q", query);
  const res = await fetch(
    "https://api.ebay.com/buy/marketplace_insights/v1/item_sales/search?" +
      params,
    {
      headers: {
        Authorization: "Bearer " + token,
        "X-EBAY-C-MARKETPLACE-ID": marketplace,
        Accept: "application/json",
      },
    }
  );
  if (!res.ok)
    throw new Error(
      res.status + " " + res.statusText + ": " + (await res.text())
    );
  const data = await res.json();
  const arr = Array.isArray(data.itemSales)
    ? data.itemSales
    : Array.isArray(data.item_sales)
    ? data.item_sales
    : Array.isArray(data.items)
    ? data.items
    : [];
  const items = [];
  for (const it of arr) {
    const title = String(it?.title || it?.itemTitle || it?.item?.title || "");
    const condition =
      it?.condition || it?.itemCondition || it?.item?.condition || undefined;
    const url =
      it?.itemWebUrl || it?.item_web_url || it?.item?.itemWebUrl || undefined;
    const price = Number(
      it?.price?.value ??
        it?.soldPrice?.value ??
        it?.lastSoldPrice?.value ??
        it?.transactionPrice?.value ??
        it?.item?.price?.value ??
        Number.NaN
    );
    if (Number.isFinite(price))
      items.push({ title, price, condition, url, source: "ebay_sold" });
  }
  return {
    items,
    note: isDigits
      ? "eBay Insights (GTIN, sold)"
      : "eBay Insights (keywords, sold)",
  };
}

/** -------- Legacy Finding API fallback (no OAuth) ---------------------------- */
async function searchEbayFindingCurrent(query, appId) {
  const p = new URLSearchParams({
    "OPERATION-NAME": "findItemsByKeywords",
    "SERVICE-VERSION": "1.13.0",
    "SECURITY-APPNAME": appId,
    "RESPONSE-DATA-FORMAT": "JSON",
    "REST-PAYLOAD": "true",
    "GLOBAL-ID": "EBAY-US",
    keywords: query,
    "paginationInput.entriesPerPage": "50",
  });
  const res = await fetch(
    "https://svcs.ebay.com/services/search/FindingService/v1?" + p
  );
  if (!res.ok)
    throw new Error(
      res.status + " " + res.statusText + ": " + (await res.text())
    );
  const data = await res.json();
  const list =
    (((data || {}).findItemsByKeywordsResponse || [])[0] || {})
      .searchResult?.[0]?.item || [];
  const items = list
    .map((it) => {
      const title = it.title?.[0] || "";
      const price = Number(
        it.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || Number.NaN
      );
      const url = it.viewItemURL?.[0];
      const condition = it.condition?.[0]?.conditionDisplayName?.[0];
      return { title, price, condition, url, source: "ebay_current_legacy" };
    })
    .filter((i) => Number.isFinite(i.price));
  return { items, note: "eBay Finding (keywords, current)" };
}

async function searchEbayFindingSold(query, appId) {
  const p = new URLSearchParams({
    "OPERATION-NAME": "findCompletedItems",
    "SERVICE-VERSION": "1.13.0",
    "SECURITY-APPNAME": appId,
    "RESPONSE-DATA-FORMAT": "JSON",
    "REST-PAYLOAD": "true",
    "GLOBAL-ID": "EBAY-US",
    keywords: query,
    "paginationInput.entriesPerPage": "50",
    "itemFilter(0).name": "SoldItemsOnly",
    "itemFilter(0).value": "true",
  });
  const res = await fetch(
    "https://svcs.ebay.com/services/search/FindingService/v1?" + p
  );
  if (!res.ok)
    throw new Error(
      res.status + " " + res.statusText + ": " + (await res.text())
    );
  const data = await res.json();
  const list =
    (((data || {}).findCompletedItemsResponse || [])[0] || {}).searchResult?.[0]
      ?.item || [];
  const items = list
    .map((it) => {
      const title = it.title?.[0] || "";
      const price = Number(
        it.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || Number.NaN
      );
      const url = it.viewItemURL?.[0];
      const condition = it.condition?.[0]?.conditionDisplayName?.[0];
      return { title, price, condition, url, source: "ebay_sold_legacy" };
    })
    .filter((i) => Number.isFinite(i.price));
  return { items, note: "eBay Finding (keywords, sold)" };
}

/** -------- Etsy fallback (optional) ----------------------------------------- */
async function searchEtsyCurrent(query, env) {
  const params = new URLSearchParams({
    limit: "50",
    state: "active",
    keywords: query,
    sort_on: "score",
  });
  const headers = { "x-api-key": env.ETSY_API_KEY, Accept: "application/json" };
  if (env.ETSY_OAUTH_TOKEN)
    headers["Authorization"] = "Bearer " + env.ETSY_OAUTH_TOKEN;
  const res = await fetch(
    "https://api.etsy.com/v3/application/listings/active?" + params,
    { headers }
  );
  if (!res.ok)
    throw new Error(
      res.status + " " + res.statusText + ": " + (await res.text())
    );
  const data = await res.json();
  const results = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.listings)
    ? data.listings
    : [];
  const items = results
    .map((it) => {
      const m = it.price || it.original_price || null;
      let price = Number.NaN;
      if (
        m &&
        isFinite(Number(m.amount)) &&
        isFinite(Number(m.divisor)) &&
        Number(m.divisor) !== 0
      )
        price = Number(m.amount) / Number(m.divisor);
      else if (typeof it.price === "string") price = Number(it.price);
      const title = it.title || it.listing_title || "";
      const url =
        it.url ||
        (it.listing_id
          ? "https://www.etsy.com/listing/" + it.listing_id
          : undefined);
      const cond = it.who_made ? "who_made:" + it.who_made : undefined;
      return { title, price, condition: cond, url, source: "etsy_current" };
    })
    .filter((i) => Number.isFinite(i.price));
  return { items, note: "Etsy active listings (keywords, current)" };
}

/** -------- Stats ------------------------------------------------------------ */
function summarize(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length)
    return {
      count: 0,
      min: NaN,
      max: NaN,
      avg: NaN,
      median: NaN,
      p25: NaN,
      p75: NaN,
      avg_trimmed: NaN,
    };
  const sum = a.reduce((s, v) => s + v, 0),
    avg = sum / a.length;
  const q = (p) => {
    const i = (a.length - 1) * p;
    const lo = Math.floor(i),
      hi = Math.ceil(i);
    return (a[lo] + a[hi]) / 2;
  };
  const p25 = q(0.25),
    median = q(0.5),
    p75 = q(0.75);
  const iqr = p75 - p25,
    lo = p25 - 1.5 * iqr,
    hi = p75 + 1.5 * iqr;
  const trimmed = a.filter((v) => v >= lo && v <= hi);
  const avg_trimmed = trimmed.length
    ? trimmed.reduce((s, v) => s + v, 0) / trimmed.length
    : avg;
  return {
    count: a.length,
    min: a[0],
    max: a[a.length - 1],
    avg,
    median,
    p25,
    p75,
    avg_trimmed,
  };
}

/** -------- Worker ----------------------------------------------------------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/estimate") {
      const q = url.searchParams.get("query")?.trim();
      if (!q) return json({ error: "Missing query" }, 400);

      const marketplace = env.X_EBAY_MARKETPLACE_ID || "EBAY_US";
      const appId = env.EBAY_CLIENT_ID; // used for Finding
      const notes = [];
      let items_current = [];
      let items_sold = [];

      // CURRENT: try Browse → fallback Finding → optional Etsy
      try {
        const tok = await getEbayToken(
          env,
          "https://api.ebay.com/oauth/api_scope/buy.browse"
        );
        const cur = await searchEbayCurrent(q, tok, marketplace);
        items_current = cur.items;
        notes.push(cur.note);
      } catch (e) {
        notes.push(
          "Browse token/current error: " +
            String(e && e.message ? e.message : e)
        );
        try {
          const cur = await searchEbayFindingCurrent(q, appId);
          items_current = cur.items;
          notes.push(cur.note);
        } catch (e2) {
          notes.push(
            "Finding current error: " +
              String(e2 && e2.message ? e2.message : e2)
          );
        }
        if (!items_current.length && env.ETSY_API_KEY) {
          try {
            const et = await searchEtsyCurrent(q, env);
            items_current = et.items;
            notes.push(et.note);
          } catch (e3) {
            notes.push(
              "Etsy current error: " +
                String(e3 && e3.message ? e3.message : e3)
            );
          }
        }
      }

      // SOLD: try MI → fallback Finding
      try {
        const tok = await getEbayToken(
          env,
          "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights"
        );
        const sold = await searchEbaySold(q, tok, marketplace);
        items_sold = sold.items;
        notes.push(sold.note);
      } catch (e) {
        notes.push(
          "Insights token/sold error: " + String(e && e.message ? e.message : e)
        );
        try {
          const sold = await searchEbayFindingSold(q, appId);
          items_sold = sold.items;
          notes.push(sold.note);
        } catch (e2) {
          notes.push(
            "Finding sold error: " + String(e2 && e2.message ? e2.message : e2)
          );
        }
      }

      const stats_current = summarize(items_current.map((i) => i.price));
      const stats_sold = summarize(items_sold.map((i) => i.price));
      const stats_combined = summarize(
        items_current.concat(items_sold).map((i) => i.price)
      );

      return json({
        items_current,
        items_sold,
        stats: {
          current: stats_current,
          sold: stats_sold,
          combined: stats_combined,
        },
        note: notes.join(" | "),
      });
    }

    if (url.pathname === "/log" && req.method === "POST") {
      try {
        const body = await req.json();
        const lvl =
          typeof body.level === "string" ? body.level.toLowerCase() : "log";
        const msg = "[client] " + (body.msg || "");
        if (lvl === "error") console.error(msg, body.meta || null);
        else if (lvl === "warn") console.warn(msg, body.meta || null);
        else console.log(msg, body.meta || null);
      } catch (e) {
        console.warn("[client] bad /log payload", String(e));
      }
      return new Response("ok", { status: 200 });
    }

    if (env.ASSETS && env.ASSETS.fetch) return env.ASSETS.fetch(req);
    return new Response("Not Found", { status: 404 });
  },
};
