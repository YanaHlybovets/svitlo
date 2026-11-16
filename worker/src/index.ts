import { handleReport } from "./report.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function listBuildings(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT b.slug, b.address_uk, b.address_en, b.district, b.status, b.status_since,
            s.last_seen AS updated_at
       FROM buildings b
       LEFT JOIN sensors s ON s.building_id = b.id
      WHERE b.active = 1
      ORDER BY b.district, b.address_uk`,
  ).all();
  return json({ buildings: results });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/api/v1/report") return handleReport(request, env);
    if (request.method === "GET") {
      if (pathname === "/api/v1/health") return json({ ok: true });
      if (pathname === "/api/v1/buildings") return listBuildings(env);
    }
    return json({ error: "not_found" }, 404);
  },

  async scheduled(): Promise<void> {
    // Step 3: status logic for every building.
  },
} satisfies ExportedHandler<Env>;
