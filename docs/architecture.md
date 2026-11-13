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
