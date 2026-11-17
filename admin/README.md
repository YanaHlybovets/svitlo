# admin/

The admin panel UI, served by the `svitlo-admin` Worker (`worker/src/admin/`, config `worker/wrangler.admin.jsonc`) at https://svitlo-admin.yanasworks.com, behind Cloudflare Access ([ADR 0007](../docs/decisions/0007-admin-panel.md)).

- Overview: buildings, users (and how many blocked the bot), subscriptions, sensor requests.
- Each building: status, subscribers, and sensor health (last report, battery, signal, firmware; problems in red). Actions: create a sensor or issue a new key (shown once), maintenance mode, disable/enable the sensor, hide/show on the site.
- Add a building (the slug is suggested from the English address).
- Requests from the bot ("I want a sensor"), and the audit log.

Locally: `cd ../worker && npm run dev:admin`, then open http://localhost:8788 (`DEV_NO_ACCESS=1` in `.dev.vars`).
