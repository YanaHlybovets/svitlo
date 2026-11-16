// Public read-only API. Responses are cached at the edge, so crowds checking
// at the same time do not reach D1. Only addresses, statuses and times are
// returned: never sensor details or user data.

import { OFF_CONFIRM_S, type Grid } from "./status.ts";

export const BUILDINGS_TTL_S = 15;
export const HISTORY_TTL_S = 60;
export const MAX_HISTORY_DAYS = 30;

const SLUG = /^[a-z0-9-]{1,64}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Serves from the edge cache, or builds and caches the response for `ttl`
 * seconds. `key` is normalised by the caller, so extra query strings cannot
 * be used to bypass the cache.
 */
async function cached(key: string, ttl: number, ctx: ExecutionContext, build: () => Promise<Response>) {
  const cache = caches.default;
  const request = new Request(key);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await build();
  response.headers.set("cache-control", `public, max-age=${ttl}`);
  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

export function listBuildings(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  return cached(`${url.origin}/api/v1/buildings`, BUILDINGS_TTL_S, ctx, async () => {
    const { results } = await env.DB.prepare(
      `SELECT b.slug, b.address_uk, b.address_en, b.district, b.status, b.status_since,
              b.maintenance, s.last_seen AS updated_at
         FROM buildings b
         LEFT JOIN sensors s ON s.building_id = b.id
        WHERE b.active = 1
        ORDER BY b.district, b.address_uk`,
    ).all<{ maintenance: number }>();
    const buildings = results.map((b) => ({ ...b, maintenance: b.maintenance === 1 }));
    return json({ buildings, generated_at: Math.floor(Date.now() / 1000) });
  });
}

export function buildingHistory(slug: string, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const requested = Number.parseInt(url.searchParams.get("days") ?? "7", 10);
  const days = Number.isNaN(requested) ? 7 : Math.min(Math.max(requested, 1), MAX_HISTORY_DAYS);
  if (!SLUG.test(slug)) return Promise.resolve(json({ error: "not_found" }, 404));

  return cached(`${url.origin}/api/v1/buildings/${slug}/history?days=${days}`, HISTORY_TTL_S, ctx, async () => {
    const building = await env.DB.prepare("SELECT id FROM buildings WHERE slug = ? AND active = 1")
      .bind(slug)
      .first<{ id: number }>();
    if (building === null) return json({ error: "not_found" }, 404);

    const now = Math.floor(Date.now() / 1000);
    const from = now - days * 86_400;
    const [events, changes] = await env.DB.batch<{ grid: Grid; at: number }>([
      env.DB.prepare(
        `SELECT status, started_at, ended_at FROM events
          WHERE building_id = ? AND (ended_at IS NULL OR ended_at > ?)
          ORDER BY started_at`,
      ).bind(building.id, from),
      env.DB.prepare(
        `SELECT grid, at FROM grid_changes
          WHERE building_id = ?1
            AND at >= COALESCE((SELECT MAX(at) FROM grid_changes WHERE building_id = ?1 AND at <= ?2), 0)
          ORDER BY at, id`,
      ).bind(building.id, from),
    ]);

    // Outages too short to confirm: shown in history, never alerted.
    const rows = changes?.results ?? [];
    const flickers: { started_at: number; ended_at: number }[] = [];
    for (let i = 0; i < rows.length - 1; i++) {
      const c = rows[i]!;
      const next = rows[i + 1]!;
      if (c.grid === "off" && c.at >= from && next.at - c.at < OFF_CONFIRM_S) {
        flickers.push({ started_at: c.at, ended_at: next.at });
      }
    }

    return json({ slug, days, from, to: now, events: events?.results ?? [], flickers });
  });
}
