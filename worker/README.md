# worker/

Cloudflare Worker: the sensor API, status logic, Telegram bot and alert fan-out. TypeScript, D1, Cron Triggers (Queues are added in Step 6).

## Run locally

```sh
cd worker
npm install
npm run db:migrate:local   # create the local D1 database and apply migrations
npm run dev                # http://localhost:8787
```

- `GET /api/v1/health` returns `{"ok":true}`
- `GET /api/v1/buildings` returns the building list
- Trigger the cron job by hand: `curl localhost:8787/cdn-cgi/handler/scheduled`

Everything runs on your machine. No Cloudflare account is needed until the first deploy.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Tests inside the real Workers runtime, with a fresh D1 per test file |
| `npm run typecheck` | TypeScript check |
| `npm run types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `npm run deploy` | Deploy to Cloudflare (Step 4) |

## Layout

| Path | |
|---|---|
| `src/index.ts` | Entry point: HTTP routes and the cron handler |
| `migrations/` | D1 schema, applied in order (`0001_init.sql`, …) |
| `test/` | Vitest tests (`@cloudflare/vitest-plugin`) |
| `wrangler.jsonc` | Worker config: bindings, cron |

## Endpoints

| Endpoint | Status |
|---|---|
| `GET /api/v1/health` | ✅ |
| `GET /api/v1/buildings` | ✅ basic version; CDN caching comes in Step 3 |
| `POST /api/v1/report` | Step 2 |
| `GET /api/v1/buildings/:slug/history` | Step 3 |
| `POST /tg/webhook` | Step 5 |
| Cron, every minute | Step 3 (stub now) |

## Secrets

None yet. From Step 2: local secrets go in `worker/.dev.vars` (git-ignored), production secrets via `wrangler secret put`. Never commit them.
