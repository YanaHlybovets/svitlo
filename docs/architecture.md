# Architecture

## Components

1. **Sensor** (one per building): ESP32 with an 18650 battery, measuring whether its wall USB charger has power.
2. **Backend:** Cloudflare Workers, D1, Queues, Cron Triggers.
3. **Outputs:** Telegram bot (per-address subscriptions) and a static website on Pages.

Data flows one way, from sensors out to users. The cron job is the **only** part that decides a building's status, so the website and the bot always agree.

## Status logic

| Situation | Status | Subscribers |
|---|---|---|
| Sensor reports grid off, confirmed by a report 30 s later | OFF | Alert at once |
| Sensor reports grid on for 60 s or more | ON | Alert |
| Outage shorter than 60 s | (logged in history) | No alert |
| Silent for over 3 min, last report "off" | Stays OFF | No new alert |
| Silent for over 3 min, last report "on" | NO DATA | No alert; admin alerted |
| Sensor back after silence | From buffered state | Alert only if state changed |
| Maintenance mode | Maintenance | No alerts |

Durations are measured from the sensor's own timestamp of the change.

## Data model (D1)

`buildings`, `sensors`, `events`, `users`, `subscriptions`, `audit_log`. See the plan for columns. Details will be added in Phase 2.

## Sensor report format

`POST /api/v1/report`, JSON body of at most 1 KB, signed with the sensor's key:

```json
{ "sensor_id": "s-revutskogo-54a", "grid": "off", "since": 1794842600, "ts": 1794842669,
  "battery_mv": 3900, "wifi_rssi": -63, "fw": "0.1.0" }
```

Header `X-Signature: <hex HMAC-SHA256 of the exact body>`. `since` is the sensor's time the current grid state began; `ts` is when the report was sent. Responses: `204` accepted, `400` malformed, `401` any authentication failure, `413` too large. Details in [ADR 0002](decisions/0002-signed-reports-replay-guard.md).
