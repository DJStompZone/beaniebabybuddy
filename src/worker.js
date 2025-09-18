// BeanieBabyBuddy — Etsy-first API with eBay fallback, built to run on Cloudflare
// Copyright © 2025 DJ Woodward-Magar
// All Rights Reserved

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/api/estimate") {
      const q = url.searchParams.get("query")?.trim();
      if (!q) return json({ error: "Missing query" }, 400);

      let items = [];
      let notes = [];

      if (env.ETSY_API_KEY) {
        try {
          const et = await searchEtsy(q, env);
          if (et.items.length) items = et.items;
          notes.push(et.note);
        } catch (e) {
          notes.push("Etsy error: " + (e && e.message ? e.message : String(e)));
        }
      } else {
        notes.push("ETSY_API_KEY not set");
      }

      if (!items.length && env.EBAY_OAUTH_TOKEN) {
        try {
          const eb = await searchEbay(q, env.EBAY_OAUTH_TOKEN);
          if (eb.items.length) items = eb.items;
          notes.push(eb.note);
        } catch (e) {
          notes.push("eBay error: " + (e && e.message ? e.message : String(e)));
        }
      }

      return json({ items, note: notes.join(" | ") });
    }

    // Client log sink: POST JSON { level, msg, meta }
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

    // Static site (Workers Assets or Cloudflare Pages)
    if (env.ASSETS && env.ASSETS.fetch) {
      return env.ASSETS.fetch(req);
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function searchEtsy(query, env) {
  const params = new URLSearchParams({
    limit: "50",
    state: "active",
    keywords: query,
    sort_on: "score"
  });
  const headers = {
    "x-api-key": env.ETSY_API_KEY,
    "Accept": "application/json"
  };
  if (env.ETSY_OAUTH_TOKEN) headers["Authorization"] = "Bearer " + env.ETSY_OAUTH_TOKEN;

  const res = await fetch("https://api.etsy.com/v3/application/listings/active?" + params, { headers });
  if (!res.ok) throw new Error(res.status + " " + res.statusText + ": " + (await res.text()));
  const data = await res.json();
  const results = Array.isArray(data && data.results) ? data.results : (Array.isArray(data && data.listings) ? data.listings : []);

  const items = results.map(function (it) {
    const m = it.price || it.original_price || null;
    let price = Number.NaN;
    if (m && isFinite(Number(m.amount)) && isFinite(Number(m.divisor)) && Number(m.divisor) !== 0) {
      price = Number(m.amount) / Number(m.divisor);
    } else if (typeof it.price === "string") {
      price = Number(it.price);
    }
    const title = it.title || it.listing_title || "";
    const url = it.url || (it.listing_id ? ("https://www.etsy.com/listing/" + it.listing_id) : undefined);
    const cond = it.who_made ? ("who_made:" + it.who_made) : undefined;
    return { title: title, price: price, condition: cond, url: url, source: "etsy" };
  }).filter(function (i) { return Number.isFinite(i.price); });

  return { items, note: "Etsy active listings (keywords)" };
}

async function searchEbay(query, token) {
  const isDigits = /^[0-9]{8,14}$/.test(query);
  const params = new URLSearchParams({ limit: "50" });
  if (isDigits) params.set("gtin", query); else params.set("q", query);

  const headers = {
    "Authorization": "Bearer " + token,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    "Accept": "application/json"
  };

  const res = await fetch("https://api.ebay.com/buy/browse/v1/item_summary/search?" + params, { headers });
  if (!res.ok) throw new Error(res.status + " " + res.statusText + ": " + (await res.text()));
  const data = await res.json();

  const items = (data.itemSummaries || []).map(function (it) {
    const price = Number(it.price && it.price.value || it.currentBidPrice && it.currentBidPrice.value || Number.NaN);
    return { title: it.title, price: price, condition: it.condition, url: it.itemWebUrl, source: "ebay" };
  }).filter(function (i) { return Number.isFinite(i.price); });

  return { items, note: isDigits ? "eBay GTIN" : "eBay keywords" };
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json" } });
}
