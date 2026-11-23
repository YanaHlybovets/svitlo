# Svitlo: Claude Code instructions

Real-time electricity status for Kyiv apartment buildings: an LTE sensor in each building, Cloudflare Workers + D1, Telegram alerts, a public website and an admin panel. The full design is in `README.md` and `docs/` (architecture, decision records, runbook). Read the relevant ADR before changing a design decision.

## Layout

| Path | What |
|---|---|
| `worker/` | Public Worker `svitlo` (API, cron status logic, queue fan-out, Telegram bot) and admin Worker `svitlo-admin` (`src/admin/`). TypeScript, Wrangler, Vitest. |
| `web/` | Public website, static files served by the `svitlo` Worker. Plain HTML/CSS/JS modules, no build step. |
| `admin/` | Admin panel UI, served by `svitlo-admin` behind Cloudflare Access. |
| `firmware/` | ESP32 firmware for the LilyGO T-A7670E (PlatformIO). |
| `docs/` | `architecture.md`, `decisions/` (ADRs), `runbook.md`. |

## Commands (run in `worker/`)

```sh
npm test                 # all tests, in the Workers runtime
npm run typecheck        # Worker + scripts
npm run dev              # public site + API on http://localhost:8787
npm run dev:admin        # admin panel on http://localhost:8788 (Access skipped on localhost)
npm run db:migrate:local / db:migrate:remote
npx wrangler deploy --secrets-file ~/.svitlo/production.json   # public Worker
npm run deploy:admin                                            # admin Worker
npm run fake-sensor -- s-revutskogo-54a [once on|off --for N | attack] [--remote]
```

Firmware: `cd firmware && ~/.platformio/penv/bin/pio run` (needs `include/secrets.h`, git-ignored).

## Rules for this project

- **Free plan first.** Every design must fit Cloudflare's free daily limits (see the budget in `docs/decisions/0001` and the admin usage panel). One D1 row write per sensor report; building and event rows are written only when a status changes.
- **Security checklist from the plan still applies.** Signed sensor reports with the replay guard; webhook secret token; bound SQL parameters only; strict CSP; DOM built with text nodes (no `innerHTML` with data); admin actions written to `audit_log`; never publish which apartments host sensors.
- **Migrations are append-only**: add `worker/migrations/000N_*.sql`, never edit an applied one. Apply locally and remotely before deploying code that needs them.
- **Secrets** live in `~/.svitlo/production.json` (public Worker) and `~/.svitlo/admin.json` (admin Worker), never in the repo. Sensor keys: `worker/.sensors/` (git-ignored).
- **Tests never reach the network**: fake Telegram clients in unit tests; the outbound interceptor in `vitest.config.ts` for everything else.
- **User-facing texts are Ukrainian first**, with English; times are shown in Kyiv time (`Europe/Kyiv`).
- **Flow:** branch → tests and typecheck → commit → PR → the user merges → deploy from `main` (pull first). Add or update an ADR for design decisions, and the runbook for operating procedures.
- Check website changes with headless Chrome screenshots (light, dark, about 500 px and desktop) before opening a PR.

## Live

- Website: https://svitlo.yanasworks.com · Admin: https://svitlo-admin.yanasworks.com · Bot: @yhLightBot
- Pilot building: Ревуцького 54а (`revutskogo-54a`), sensor `s-revutskogo-54a`.
