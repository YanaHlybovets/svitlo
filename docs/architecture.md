# Architecture

## Components

1. **Sensor** (one per building): ESP32 with an 18650 battery, measuring whether its wall USB charger has power.
2. **Backend:** Cloudflare Workers, D1, Queues, Cron Triggers.
3. **Outputs:** Telegram bot (per-address subscriptions) and a static website on Pages.

Data flows one way, from sensors out to users. The cron job is the **only** part that decides a building's status, so the website and the bot always agree.

## Status logic

Implemented in `worker/src/status.ts` (a pure function with one test per row) and run every minute by `worker/src/cron.ts`. See [ADR 0003](decisions/0003-grid-change-log.md).

| Situation | Status | Subscribers |
|---|---|---|
| Grid off, confirmed by a report at least 30 s after it began | OFF | Alert |
| Grid on for 60 s or more | ON | Alert, with the outage length |
| Outage shorter than 30 s (flicker) | Unchanged; shown in history | No alert |
| Outage that began and ended between two cron runs | Recorded from the change log | Alert |
| Silent for over 3 min, last report "off" | OFF | No new alert |
| Silent for over 3 min, last report "on" | NO DATA | No alert (admin alert in Step 6) |
| Back after silence, same state | Previous status, original "since" | No alert |
| Back after silence, state changed | New status, real start time | Alert |
| Maintenance | Tracked as usual | No alerts |
| First status of a new sensor | ON or OFF | No alert |

Durations are measured from the sensor's own timestamps, not from when the cron job noticed.

## Data model (D1)

`buildings`, `sensors`, `grid_changes`, `events`, `users`, `subscriptions`, `audit_log`. The schema lives in `worker/migrations/`.

## Sensor report format

`POST /api/v1/report`, JSON body of at most 1 KB, signed with the sensor's key:

```json
{ "sensor_id": "s-revutskogo-54a", "grid": "off", "since": 1794842600, "ts": 1794842669,
  "battery_mv": 3900, "wifi_rssi": -63, "fw": "0.1.0" }
```

Header `X-Signature: <hex HMAC-SHA256 of the exact body>`. `since` is the sensor's time the current grid state began; `ts` is when the report was sent. Responses: `204` accepted, `400` malformed, `401` any authentication failure, `413` too large. Details in [ADR 0002](decisions/0002-signed-reports-replay-guard.md).
