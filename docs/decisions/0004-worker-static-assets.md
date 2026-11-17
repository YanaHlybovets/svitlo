# ADR 0004: Serve the website from the Worker (static assets), not Pages

- **Status:** Accepted
- **Date:** 2026-11-17

## Context

The plan put the static website on Cloudflare Pages and the API on a Worker route under the same hostname. That needs two projects, a Pages custom domain set up by hand, and a Worker route on top of it. Cloudflare now recommends Workers static assets over Pages for new projects.

## Decision

One Worker, `svitlo`, serves `svitlo.yanasworks.com` as a **custom domain**:

- Files in `web/` are uploaded as static assets. Requests for them are served without running Worker code, so they are free and don't count toward the 100,000 requests a day.
- Only `/api/*` and `/tg/*` run the Worker (`run_worker_first`).
- `web/_headers` sets the security headers (CSP, HSTS, X-Frame-Options and others). `web/.assetsignore` keeps anything that isn't site content out of the upload.
- `workers.dev` and preview URLs are off. The edge cache doesn't work on workers.dev, and one public address is enough.

## Consequences

- One `npm run deploy` publishes the site, the API and the cron job together, and wrangler creates the DNS record and certificate.
- The free-plan budget is unchanged, and website traffic no longer touches it.
- `web/` stays a plain folder of static files, so moving it to Pages later is still possible.
