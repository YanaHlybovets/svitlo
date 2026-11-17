import { buildingHistory, listBuildings } from "./api.ts";
import { deliver, type AlertMessage } from "./alerts.ts";
import { runStatusCron } from "./cron.ts";
import { telegramClient } from "./telegram/client.ts";
import { handleReport } from "./report.ts";
import { handleTelegramWebhook } from "./telegram/webhook.ts";

const HISTORY = /^\/api\/v1\/buildings\/([^/]+)\/history$/;

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "POST" && pathname === "/api/v1/report") return handleReport(request, env, ctx);
    if (request.method === "POST" && pathname === "/tg/webhook") return handleTelegramWebhook(request, env);
    if (request.method === "GET") {
      if (pathname === "/api/v1/health") {
        return new Response('{"ok":true}', { headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (pathname === "/api/v1/buildings") return listBuildings(url, env, ctx);
      const history = HISTORY.exec(pathname);
      if (history?.[1]) return buildingHistory(history[1], url, env, ctx);
    }
    return notFound();
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runStatusCron(env).then(() => undefined));
  },

  // Alert fan-out: one queue message (up to 40 chats) per run.
  async queue(batch, env): Promise<void> {
    const tg = telegramClient(env.TELEGRAM_BOT_TOKEN);
    for (const message of batch.messages) {
      await deliver(message.body, env, { tg, queue: env.ALERTS });
      message.ack();
    }
  },
} satisfies ExportedHandler<Env, AlertMessage>;
