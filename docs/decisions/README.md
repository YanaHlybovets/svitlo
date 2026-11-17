# Decision records

| # | Decision |
|---|---|
| [0001](0001-cloudflare-free-plan.md) | Run everything on Cloudflare's free plan |
| [0002](0002-signed-reports-replay-guard.md) | Signed sensor reports with a timestamp replay guard |
| [0003](0003-grid-change-log.md) | Status decided by the cron job from a grid-change log |
| [0004](0004-worker-static-assets.md) | Serve the website from the Worker (static assets), not Pages |
| [0005](0005-lte-sensors.md) | Sensors connect over LTE, not the host's Wi-Fi |
| [0006](0006-alert-fan-out.md) | Alert fan-out through a queue, with a fast path and write guards |

Planned: one sensor per building on its own battery; a Telegram bot rather than channels; Cloudflare Access for admin.
