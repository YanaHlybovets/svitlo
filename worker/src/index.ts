const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function listBuildings(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT slug, address_uk, address_en, district, status, status_since, last_report_at
       FROM buildings
      WHERE active = 1
      ORDER BY district, address_uk`,
  ).all();
  return json({ buildings: results });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

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
