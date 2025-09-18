# Beanie Scanner — Etsy-first (CF Worker + SPA)

- Scans UPC/EAN/Code128 in-browser (ZXing).
- Searches **Etsy** active listings by keywords (Etsy v3) using `ETSY_API_KEY`.
- Optional **eBay Browse** fallback if `EBAY_OAUTH_TOKEN` is set.
- Returns items and lets the client compute median & IQR for a fast price sanity check.

## Secrets

```bash
wrangler secret put ETSY_API_KEY
# optional:
wrangler secret put ETSY_OAUTH_TOKEN
wrangler secret put EBAY_OAUTH_TOKEN
```

## Deploy

```bash
wrangler init --yes
wrangler deploy
```

## Notes
- Etsy money object => price = amount / divisor (currency displayed as USD symbol on client for simplicity).
- Etsy doesn’t give GTIN search; we pass your scanned digits as keywords.
- There is no truly free aggregator for eBay + Etsy. This setup is legal, lightweight, and fast.
