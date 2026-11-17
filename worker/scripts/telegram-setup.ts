// Sets up the production bot: webhook (with a secret token), command menu and
// descriptions in Ukrainian and English.
//
//   node scripts/telegram-setup.ts
//
// Reads ~/.svitlo/production.json (TELEGRAM_BOT_TOKEN). The first run adds a
// random TELEGRAM_WEBHOOK_SECRET there and stops: deploy with
// `npx wrangler deploy --secrets-file ~/.svitlo/production.json`, then run again.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { telegramClient } from "../src/telegram/client.ts";

const WEBHOOK_URL = "https://svitlo.yanasworks.com/tg/webhook";
const file = `${homedir()}/.svitlo/production.json`;
const secrets = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;

const token = secrets.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error(`TELEGRAM_BOT_TOKEN missing in ${file}`);

if (!secrets.TELEGRAM_WEBHOOK_SECRET) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  secrets.TELEGRAM_WEBHOOK_SECRET = Buffer.from(bytes).toString("base64url"); // A-Z a-z 0-9 _ - only, as Telegram requires
  writeFileSync(file, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
  console.log(`Added TELEGRAM_WEBHOOK_SECRET to ${file}.`);
  console.log("Now deploy (npx wrangler deploy --secrets-file ~/.svitlo/production.json) and run this script again.");
  process.exit(0);
}

const tg = telegramClient(token);
async function call(method: string, params: Record<string, unknown>) {
  const res = await tg.call(method, params);
  if (!res.ok) throw new Error(`${method} failed: ${res.description}`);
  console.log(`✓ ${method}${params.language_code ? ` (${params.language_code})` : ""}`);
  return res.result;
}

const commands = {
  uk: [
    ["my", "Мої адреси"],
    ["status", "Статус моїх адрес"],
    ["add", "Додати адресу"],
    ["settings", "Мова й тихі години"],
    ["delete_me", "Видалити мої дані"],
  ],
  en: [
    ["my", "My addresses"],
    ["status", "Status of my addresses"],
    ["add", "Add an address"],
    ["settings", "Language and quiet hours"],
    ["delete_me", "Delete my data"],
  ],
};
const toCommands = (list: string[][]) => list.map(([command, description]) => ({ command, description }));

await call("setWebhook", {
  url: WEBHOOK_URL,
  secret_token: secrets.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ["message", "callback_query", "my_chat_member"],
  drop_pending_updates: true,
  max_connections: 10,
});
await call("setMyCommands", { commands: toCommands(commands.uk) });
await call("setMyCommands", { commands: toCommands(commands.en), language_code: "en" });
await call("setMyDescription", {
  description:
    "Сповіщення, коли у вашому будинку зникає або з’являється світло. Дані надходять від датчика в самому будинку, а не з графіків.",
});
await call("setMyDescription", {
  description: "Alerts when the power goes off or comes back in your building, from a sensor in the building itself, not from schedules.",
  language_code: "en",
});
await call("setMyShortDescription", { short_description: "Чи є світло у вашому будинку: статус і сповіщення." });
await call("setMyShortDescription", { short_description: "Is there power in your building: status and alerts.", language_code: "en" });

const info = (await call("getWebhookInfo", {})) as { url: string; pending_update_count: number; last_error_message?: string };
console.log(`Webhook: ${info.url} (pending: ${info.pending_update_count}${info.last_error_message ? `, last error: ${info.last_error_message}` : ""})`);
