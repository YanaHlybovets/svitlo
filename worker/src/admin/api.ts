// Admin API (behind Cloudflare Access + JWT check). Every change is written to
// audit_log in the same transaction. Sensor keys are shown once, never stored
// in plain text.

import { encryptSensorKey, randomKey, toBase64 } from "../crypto.ts";
import { fetchUsage, shares, METRIC_LABELS } from "../usage.ts";

export interface AdminEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  MASTER_KEY: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Comma-separated. */
  ADMIN_EMAILS: string;
  /** Read-only Cloudflare API token (Account Analytics: Read) and account ID, for the usage panel. */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** "1" only in local .dev.vars: skips Access on localhost. */
  DEV_NO_ACCESS?: string;
}

export const DISTRICTS = [
  "darnytskyi", "desnianskyi", "dniprovskyi", "holosiivskyi", "obolonskyi",
  "pecherskyi", "podilskyi", "shevchenkivskyi", "solomianskyi", "sviatoshynskyi",
] as const;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const MAX_ADDRESS = 100;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
const fail = (status: number, error: string) => json({ error }, status);

function audit(env: AdminEnv, admin: string, action: string, details: Record<string, unknown>) {
  return env.DB.prepare("INSERT INTO audit_log (admin, action, details) VALUES (?, ?, ?)").bind(admin, action, JSON.stringify(details));
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") ?? "0") > 4096) return null;
  try {
    const value = (await request.json()) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function overview(env: AdminEnv): Promise<Response> {
  const [buildings, users, subs, requests, log] = await env.DB.batch([
    env.DB.prepare(
      `SELECT b.id, b.slug, b.address_uk, b.address_en, b.district, b.status, b.status_since, b.maintenance, b.active,
              s.id AS sensor_id, s.enabled AS sensor_enabled, s.last_seen, s.battery_mv, s.wifi_rssi, s.firmware,
              (SELECT COUNT(*) FROM subscriptions x WHERE x.building_id = b.id) AS subscribers
         FROM buildings b LEFT JOIN sensors s ON s.building_id = b.id
        ORDER BY b.district, b.address_uk`,
    ),
    env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(blocked), 0) AS blocked FROM users"),
    env.DB.prepare("SELECT COUNT(*) AS total FROM subscriptions"),
    env.DB.prepare("SELECT id, chat_id, text, created_at FROM building_requests ORDER BY id DESC LIMIT 100"),
    env.DB.prepare("SELECT at, admin, action, details FROM audit_log ORDER BY id DESC LIMIT 30"),
  ]);
  return json({
    now: Math.floor(Date.now() / 1000),
    buildings: buildings?.results ?? [],
    users: users?.results[0] ?? { total: 0, blocked: 0 },
    subscriptions: (subs?.results[0] as { total?: number } | undefined)?.total ?? 0,
    requests: requests?.results ?? [],
    audit: log?.results ?? [],
    districts: DISTRICTS,
  });
}

/** Today's usage against the free-plan limits; cached for 5 minutes. */
async function usage(env: AdminEnv, url: URL): Promise<Response> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return json({ configured: false });
  const cache = caches.default;
  const key = new Request(`${url.origin}/api/usage`);
  const hit = await cache.match(key);
  if (hit) return hit;
  let response: Response;
  try {
    const u = await fetchUsage(env.CF_API_TOKEN, env.CF_ACCOUNT_ID);
    response = json({
      configured: true,
      date: u.date,
      metrics: shares(u).map((s) => ({ ...s, label: METRIC_LABELS[s.metric] })),
    });
    response.headers.set("cache-control", "private, max-age=300");
    await cache.put(key, response.clone());
  } catch (error) {
    response = json({ configured: true, error: String((error as Error).message ?? error) }, 502);
  }
  return response;
}

async function addBuilding(request: Request, env: AdminEnv, admin: string): Promise<Response> {
  const b = await body(request);
  if (!b) return fail(400, "bad_body");
  const slug = String(b.slug ?? "").trim();
  const uk = String(b.address_uk ?? "").trim();
  const en = String(b.address_en ?? "").trim();
  const district = String(b.district ?? "");
  if (!SLUG.test(slug)) return fail(400, "bad_slug");
  if (!uk || !en || uk.length > MAX_ADDRESS || en.length > MAX_ADDRESS) return fail(400, "bad_address");
  if (!(DISTRICTS as readonly string[]).includes(district)) return fail(400, "bad_district");

  const exists = await env.DB.prepare("SELECT 1 AS x FROM buildings WHERE slug = ?").bind(slug).first();
  if (exists) return fail(409, "slug_taken");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO buildings (slug, address_uk, address_en, district) VALUES (?, ?, ?, ?)").bind(slug, uk, en, district),
    audit(env, admin, "building.add", { slug, address_uk: uk, address_en: en, district }),
  ]);
  return json({ ok: true }, 201);
}

async function buildingRow(env: AdminEnv, id: number) {
  return env.DB.prepare(
    "SELECT b.id, b.slug, s.id AS sensor_id FROM buildings b LEFT JOIN sensors s ON s.building_id = b.id WHERE b.id = ?",
  )
    .bind(id)
    .first<{ id: number; slug: string; sensor_id: string | null }>();
}

/** Creates the building's sensor or issues it a new key. The key is returned once. */
async function sensorKey(env: AdminEnv, admin: string, id: number): Promise<Response> {
  const building = await buildingRow(env, id);
  if (!building) return fail(404, "no_building");
  const key = randomKey();
  const stored = await encryptSensorKey(env.MASTER_KEY, key);
  const sensorId = building.sensor_id ?? `s-${building.slug}`;
  const action = building.sensor_id ? "sensor.rotate_key" : "sensor.create";
  await env.DB.batch([
    building.sensor_id
      ? env.DB.prepare("UPDATE sensors SET key_encrypted = ? WHERE id = ?").bind(stored, sensorId)
      : env.DB.prepare("INSERT INTO sensors (id, building_id, key_encrypted) VALUES (?, ?, ?)").bind(sensorId, id, stored),
    audit(env, admin, action, { sensor_id: sensorId, slug: building.slug }),
  ]);
  return json({ sensor_id: sensorId, key: toBase64(key) });
}

async function setFlag(
  env: AdminEnv, admin: string, id: number, request: Request,
  field: "maintenance" | "active" | "sensor_enabled",
): Promise<Response> {
  const b = await body(request);
  if (!b || typeof b.value !== "boolean") return fail(400, "bad_body");
  const building = await buildingRow(env, id);
  if (!building) return fail(404, "no_building");
  const value = b.value ? 1 : 0;
  let statement: D1PreparedStatement;
  if (field === "sensor_enabled") {
    if (!building.sensor_id) return fail(404, "no_sensor");
    statement = env.DB.prepare("UPDATE sensors SET enabled = ? WHERE id = ?").bind(value, building.sensor_id);
  } else {
    statement = env.DB.prepare(`UPDATE buildings SET ${field} = ? WHERE id = ?`).bind(value, id); // field is one of two literals
  }
  await env.DB.batch([statement, audit(env, admin, `${field}.${b.value ? "on" : "off"}`, { slug: building.slug })]);
  return json({ ok: true });
}

async function closeRequest(env: AdminEnv, admin: string, id: number): Promise<Response> {
  const row = await env.DB.prepare("SELECT text FROM building_requests WHERE id = ?").bind(id).first<{ text: string }>();
  if (!row) return fail(404, "no_request");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM building_requests WHERE id = ?").bind(id),
    audit(env, admin, "request.close", { id, text: row.text }),
  ]);
  return json({ ok: true });
}

/**
 * Routes /api/*. Changes need JSON, the X-Svitlo-Admin header and a same-origin
 * Origin, so another site can't trigger them with the admin's Access cookie.
 */
export async function handleAdminApi(request: Request, env: AdminEnv, admin: string): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET") {
    if (path === "/api/me") return json({ email: admin });
    if (path === "/api/overview") return overview(env);
    if (path === "/api/usage") return usage(env, url);
    return fail(404, "not_found");
  }

  const origin = request.headers.get("origin");
  if (request.headers.get("x-svitlo-admin") !== "1" || (origin !== null && origin !== url.origin)) return fail(403, "csrf");

  if (request.method === "POST" && path === "/api/buildings") return addBuilding(request, env, admin);

  const m = /^\/api\/(buildings|requests)\/([1-9][0-9]{0,9})(?:\/([a-z_]+))?$/.exec(path);
  if (!m) return fail(404, "not_found");
  const [, kind, idText, sub] = m;
  const id = Number(idText);

  if (kind === "requests" && request.method === "DELETE" && sub === undefined) return closeRequest(env, admin, id);
  if (kind === "buildings" && request.method === "POST") {
    if (sub === "sensor_key") return sensorKey(env, admin, id);
    if (sub === "maintenance" || sub === "active" || sub === "sensor_enabled") return setFlag(env, admin, id, request, sub);
  }
  return fail(404, "not_found");
}
