import { buildingHistory, listBuildings } from "./api.ts";
import { runStatusCron } from "./cron.ts";
import { handleReport } from "./report.ts";

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

    if (request.method === "POST" && pathname === "/api/v1/report") return handleReport(request, env);
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
} satisfies ExportedHandler<Env>;
