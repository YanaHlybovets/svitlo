# worker/

Cloudflare Worker (Phase 2 onwards):

- `POST /api/v1/report`: signed sensor reports (HMAC-SHA256, timestamp and nonce check)
- `GET /api/v1/buildings`, `GET /api/v1/buildings/:slug/history`: public read-only API, CDN-cached
- `POST /tg/webhook`: Telegram bot (secret-token header required)
- Cron (every minute): status logic, writes events, enqueues alerts
- Queue consumer: Telegram fan-out (40 chats per message, about 25 msg/s)

Bindings: D1, Queues, Cron Triggers. Secrets via `wrangler secret put`; local secrets in `.dev.vars` (git-ignored).
