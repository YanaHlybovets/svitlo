---
name: deploy-svitlo
description: Deploy Svitlo to production (public Worker, and the admin Worker when it changed) after a pull request is merged. Use when the user says "deploy", "merged, deploy", "ship it" or "/deploy-svitlo".
---

# Deploy Svitlo

Deploy what is on `main` to https://svitlo.yanasworks.com (Worker `svitlo`) and, when admin code changed, to https://svitlo-admin.yanasworks.com (Worker `svitlo-admin`). Stop at the first failure and report it; never deploy past a failing step.

## Steps

1. **Start from the merged code.**
   ```sh
   cd "$(git rev-parse --show-toplevel)" && git switch main && git pull --ff-only
   ```
   Note the previous production commit if known (from the last deploy report) so the changes can be listed.

2. **Check before deploying** (in `worker/`):
   ```sh
   npm ci --silent && npm test && npm run typecheck
   ```
   If anything fails: stop, show the failure, do not deploy.

3. **Database migrations.** List pending ones and apply them before the code that needs them:
   ```sh
   npx wrangler d1 migrations list svitlo-db --remote
   npm run db:migrate:remote
   ```
   Migrations are append-only. Never edit an applied one.

4. **Public Worker** (site, API, cron, bot, alert queue):
   ```sh
   npx wrangler deploy --secrets-file ~/.svitlo/production.json
   ```
   Never print or read the secrets files' contents; only pass their path.

5. **Admin Worker**, only if `worker/src/admin/`, `worker/wrangler.admin.jsonc`, `admin/` or shared code it imports changed since the last deploy:
   ```sh
   npm run deploy:admin
   ```

6. **Check that it's live:**
   - `curl -s https://svitlo.yanasworks.com/api/v1/health` must return `{"ok":true}`.
   - `curl -s -o /dev/null -w "%{http_code}" https://svitlo.yanasworks.com/` must be `200`.
   - Admin (if deployed): `https://svitlo-admin.yanasworks.com/` must answer `302` (redirect to the Cloudflare Access login) for an unauthenticated request.
   - If a Telegram-related change was deployed: `npm run telegram-setup` only when commands, descriptions or the webhook changed.

7. **Report** in plain language: the commit deployed, migrations applied, which Workers were deployed, the results of each check, and anything the user should try by hand (for example, "open the bot and send /my").

## Never

- Deploy from a branch other than `main` unless the user explicitly asks for a preview deploy.
- Skip tests or type checks to "just deploy".
- Use `--force`, delete resources, or change Cloudflare settings (Access, DNS, plans) as part of a deploy.
- Echo, log or commit anything from `~/.svitlo/`.
