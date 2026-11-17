// POST /tg/webhook: Telegram updates. Accepted only with the secret token set
// at webhook registration (scripts/telegram-setup.ts).

import { handleUpdate, type Update } from "./bot.ts";
import { telegramClient } from "./client.ts";

const MAX_UPDATE_BYTES = 64 * 1024;

function secretMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!secretMatches(request.headers.get("x-telegram-bot-api-secret-token") ?? "", env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response(null, { status: 401 });
  }
  if (Number(request.headers.get("content-length") ?? "0") > MAX_UPDATE_BYTES) return new Response(null, { status: 413 });

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return new Response(null, { status: 400 });
  }

  try {
    await handleUpdate(update, env, telegramClient(env.TELEGRAM_BOT_TOKEN));
  } catch (error) {
    // Answer 200 anyway: Telegram would otherwise retry the same update again and again.
    console.error(JSON.stringify({ msg: "bot_error", update_id: update.update_id, error: String(error) }));
  }
  return new Response("ok");
}
