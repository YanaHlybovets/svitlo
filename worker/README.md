# worker/

Cloudflare Worker: the sensor API, status logic, Telegram bot and alert fan-out. TypeScript, D1, Cron Triggers (Queues are added in Step 6).

## Run locally

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars   # then put a key in it: openssl rand -base64 32
npm run db:migrate:local         # create the local D1 database and apply migrations
npm run dev                      # http://localhost:8787
```

- `GET /api/v1/health` returns `{"ok":true}`
- `GET /api/v1/buildings` returns the building list
- `GET /api/v1/buildings/revutskogo-54a/history?days=7` returns events and flickers
- Run the status cron job by hand (it doesn't run by itself locally): `curl localhost:8787/cdn-cgi/local/scheduled`
- `/` returns 404 on purpose: the website is served by Cloudflare Pages (Step 7)

Everything runs on your machine. No Cloudflare account is needed until the first deploy.

## Fake sensor

Until the ESP32 exists, a script sends the same signed reports the firmware will.

```sh
npm run sensor-key -- add revutskogo-54a            # once: creates the sensor and its key
npm run fake-sensor -- s-revutskogo-54a             # interactive: o = on, f = off, w = Wi-Fi down/up, q = quit
npm run fake-sensor -- s-revutskogo-54a once off    # one report
npm run fake-sensor -- s-revutskogo-54a once off --for 45   # the outage began 45 s ago (confirmed)
npm run fake-sensor -- s-revutskogo-54a attack      # replay, bad signature, stale time: all must be rejected
```

The key is saved to `worker/.sensors/<sensor-id>.json` (git-ignored). Use `rotate` instead of `add` to issue a new key. If `npm run dev` says the port is in use, an old dev server is still running: `lsof -ti tcp:8787 | xargs kill`.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Tests inside the real Workers runtime, with a fresh D1 per test file |
| `npm run typecheck` | TypeScript check |
| `npm run types` | Regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `npm run sensor-key -- add\|rotate <slug>` | Create a sensor or issue it a new key |
| `npm run fake-sensor -- <sensor-id> [once on\|off \| attack]` | Send signed test reports |
| `npm run deploy` | Deploy to Cloudflare (Step 4) |

## Layout

| Path | |
|---|---|
| `src/index.ts` | Entry point: HTTP routes and the cron handler |
| `migrations/` | D1 schema, applied in order (`0001_init.sql`, …) |
| `src/report.ts` | `POST /api/v1/report`: signature, time and replay checks; logs grid changes |
| `src/status.ts` | Status rules (pure function) |
| `src/cron.ts` | Every-minute job: applies the rules, writes events |
| `src/api.ts` | Public read-only API with edge caching |
| `src/crypto.ts` | HMAC signing and AES-GCM key encryption (shared with scripts) |
| `scripts/` | `sensor-key.ts`, `fake-sensor.ts` (run with Node 22.18+, no build step) |
| `test/` | Vitest tests (`@cloudflare/vitest-plugin`) |
| `wrangler.jsonc` | Worker config: bindings, cron |

## Endpoints

| Endpoint | Status |
|---|---|
| `GET /api/v1/health` | ✅ |
| `GET /api/v1/buildings` | ✅ cached 15 s |
| `POST /api/v1/report` | ✅ signed reports (see [ADR 0002](../docs/decisions/0002-signed-reports-replay-guard.md)) |
| `GET /api/v1/buildings/:slug/history?days=7` | ✅ events and flickers, 1–30 days, cached 60 s |
| `POST /tg/webhook` | Step 5 |
| Cron, every minute | ✅ status logic ([ADR 0003](../docs/decisions/0003-grid-change-log.md)); alerts are queued in Step 6 |

## Secrets

| Secret | Purpose |
|---|---|
| `MASTER_KEY` | 32 random bytes, base64. Encrypts sensor keys in D1 |

Local secrets go in `worker/.dev.vars` (git-ignored); production secrets via `wrangler secret put`. Never commit them.
