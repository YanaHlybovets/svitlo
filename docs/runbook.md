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

## Add a building and its sensor

1. Add the building row: a migration for now, the admin panel later (Step 8).
2. `MASTER_KEY=… npm run sensor-key -- add <slug> --remote`. This prints the key once and saves it to `.sensors/remote/`.
3. Flash the sensor ID and key into the device.
4. Test with the fake sensor first: `npm run fake-sensor -- s-<slug> attack --remote`.

## Disable a lost sensor / rotate its key

```sh
npx wrangler d1 execute svitlo-db --remote --command "UPDATE sensors SET enabled = 0 WHERE id = 's-<slug>'"
MASTER_KEY=… npm run sensor-key -- rotate <slug> --remote
npx wrangler d1 execute svitlo-db --remote --command "UPDATE sensors SET enabled = 1 WHERE id = 's-<slug>'"
```

## To do

- [ ] Rotate the Telegram bot token (Step 5)
- [ ] Restore the D1 database: D1 Time Travel, `wrangler d1 time-travel restore svitlo-db --timestamp=…`
- [ ] What to do when a free-plan daily limit is hit
