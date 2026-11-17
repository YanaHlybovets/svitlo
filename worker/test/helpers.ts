import { env, exports } from "cloudflare:workers";
import { encryptSensorKey, randomKey, signBody } from "../src/crypto.ts";

export const BASE = "https://svitlo.test";
export const SENSOR = "s-revutskogo-54a";
export const nowS = () => Math.floor(Date.now() / 1000);

/** Tests in one file share D1 and the cache: start each test from the pilot building only. */
export async function resetState(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM grid_changes"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM sensors"),
    env.DB.prepare(
      `UPDATE buildings SET status = 'no_data', status_since = NULL, definite_status = NULL,
              definite_since = NULL, maintenance = 0`,
    ),
  ]);
  await caches.default.delete(`${BASE}/api/v1/buildings`);
  for (const days of [1, 7, 30]) {
    await caches.default.delete(`${BASE}/api/v1/buildings/revutskogo-54a/history?days=${days}`);
  }
}

export async function addSensor(enabled = 1) {
  const key = randomKey();
  await env.DB.prepare("INSERT INTO sensors (id, building_id, key_encrypted, enabled) VALUES (?, 1, ?, ?)")
    .bind(SENSOR, await encryptSensorKey(env.MASTER_KEY, key), enabled)
    .run();
  return key;
}

export function reportBody(overrides: Record<string, unknown> = {}): string {
  const ts = nowS();
  return JSON.stringify({
    sensor_id: SENSOR, grid: "off", since: ts - 5, ts,
    battery_mv: 4000, wifi_rssi: -60, fw: "0.1.0",
    ...overrides,
  });
}

export async function sendRaw(raw: string, signature: string): Promise<number> {
  const res = await exports.default.fetch(`${BASE}/api/v1/report`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signature },
    body: raw,
  });
  return res.status;
}

export async function sendReport(key: Uint8Array<ArrayBuffer>, overrides: Record<string, unknown> = {}) {
  const raw = reportBody(overrides);
  return sendRaw(raw, await signBody(key, raw));
}

/**
 * Records a sensor report the way the report handler stores it, without the
 * HTTP request and so without the fast path. For tests of the cron logic alone.
 */
export async function recordReport(grid: "on" | "off", since: number, ts: number): Promise<void> {
  const prev = await env.DB.prepare("SELECT grid, grid_changed_at FROM sensors WHERE id = ?")
    .bind(SENSOR)
    .first<{ grid: string | null; grid_changed_at: number | null }>();
  const statements = [
    env.DB.prepare("UPDATE sensors SET grid = ?, grid_changed_at = ?, last_ts = ?, last_seen = ? WHERE id = ?")
      .bind(grid, since, ts, ts, SENSOR),
  ];
  if (prev?.grid !== grid || prev?.grid_changed_at !== since) {
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO grid_changes (building_id, grid, at) VALUES (1, ?, ?)").bind(grid, since));
  }
  await env.DB.batch(statements);
}
