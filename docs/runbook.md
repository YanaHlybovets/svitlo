# Runbook

## Where things are

| What | Where |
|---|---|
| Website and API | https://svitlo.yanasworks.com (one Worker, `svitlo`) |
| Database | D1 `svitlo-db`, region EEUR |
| Production master key | `~/.svitlo/production.json` on the maintainer's Mac (mode 600) **and** a password manager. Also a Worker secret. |
| Production sensor keys | `worker/.sensors/remote/` (git-ignored); D1 holds them only encrypted |
| Logs | `cd worker && npm run tail` (live), or Cloudflare dashboard → Workers → svitlo → Logs |

If the master key is lost, every sensor key has to be re-issued (`sensor-key rotate`) and every sensor re-flashed.

## Deploy

```sh
cd worker
npm test && npm run typecheck
npm run db:migrate:remote        # only when there are new migrations
npx wrangler deploy --secrets-file ~/.svitlo/production.json
```

Check: `curl https://svitlo.yanasworks.com/api/v1/health` returns `{"ok":true}`.

## Admin panel

https://svitlo-admin.yanasworks.com, behind Cloudflare Access (one-time code to your email).

- Deploy: `cd worker && npm run deploy:admin` (uses `~/.svitlo/admin.json`: `MASTER_KEY`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAILS`).
- Locally: `npm run dev:admin`, then open http://localhost:8788.
- Access setup (once): Zero Trust → Access → Applications → Self-hosted, domain `svitlo-admin.yanasworks.com`, policy Allow → Emails → your email, login method One-time PIN. Put the team domain and the application's AUD tag in `~/.svitlo/admin.json`, then deploy.

## Add a building and its sensor

1. Admin panel → **Додати будинок**.
2. On its card → **➕ Створити датчик**. Copy the key shown (it appears once).
3. Flash the sensor ID and key into the device.
4. Watch **Останній звіт** on the card; problems show in red.

Without the admin panel: `MASTER_KEY=… npm run sensor-key -- add <slug> --remote` (the building must exist).

## Disable a lost sensor / rotate its key

In the admin panel: **Вимкнути датчик**, then **🔑 Новий ключ**, re-flash, then **Увімкнути датчик**. From the command line:


```sh
npx wrangler d1 execute svitlo-db --remote --command "UPDATE sensors SET enabled = 0 WHERE id = 's-<slug>'"
MASTER_KEY=… npm run sensor-key -- rotate <slug> --remote
npx wrangler d1 execute svitlo-db --remote --command "UPDATE sensors SET enabled = 1 WHERE id = 's-<slug>'"
```

## Telegram bot

Set up or refresh the webhook, commands and descriptions: `npm run telegram-setup`. Check it with the last line of that output (`pending` should be 0, with no last error).

**Replace a leaked bot token:** @BotFather → `/revoke` → choose the bot. Put the new token in `~/.svitlo/production.json`, deploy with `--secrets-file`, then run `npm run telegram-setup`.

**Receive "I want a sensor" requests:** add `"ADMIN_CHAT_ID": "<your chat id>"` to `~/.svitlo/production.json` and deploy with `--secrets-file`.

## Alerts

- Queue: `svitlo-alerts` (Cloudflare dashboard → Queues). It's created once with `npx wrangler queues create svitlo-alerts`.
- Live logs while testing: `npm run tail`. Look for `status_change`, `alert_send_failed`, `alert_gave_up`, `alert_stale_dropped`.
- Live test with the fake sensor: `npm run fake-sensor -- s-revutskogo-54a once off --remote`, then about 35 s later `npm run fake-sensor -- s-revutskogo-54a once off --for 35 --remote`. The OFF alert arrives within seconds of the second report.

## To do

- [ ] Restore the D1 database: D1 Time Travel, `wrangler d1 time-travel restore svitlo-db --timestamp=…`
- [ ] What to do when a free-plan daily limit is hit
