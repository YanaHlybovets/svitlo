// POST /api/v1/report: a signed status report from a building sensor.
//
// Body (JSON, at most 1 KB):
//   { "sensor_id": "s-revutskogo-54a", "grid": "on" | "off",
//     "since": <sensor time the current grid state began>,
//     "ts": <sensor time this report was sent>,
//     "battery_mv": 4012, "wifi_rssi": -61, "fw": "0.1.0" }
// Header: X-Signature: hex(HMAC-SHA256(sensor key, exact body bytes))
//
// Times are Unix seconds. A report is accepted only if its signature is valid,
// its ts is within 60 s of server time, and its ts is later than the last
// accepted one (replay guard, see docs/decisions/0002). It writes exactly one
// row: the sensor's. The cron job decides building status from that row.

import { decryptSensorKey, fromHex, importHmacKey } from "./crypto.ts";

export const MAX_BODY_BYTES = 1024;
export const MAX_CLOCK_SKEW_S = 60;

export interface Report {
  sensor_id: string;
  grid: "on" | "off";
  since: number;
  ts: number;
  battery_mv: number | null;
  wifi_rssi: number | null;
  fw: string | null;
}

const SENSOR_ID = /^[a-z0-9-]{1,64}$/;
const FIRMWARE = /^[0-9A-Za-z.+-]{1,32}$/;

function isInt(v: unknown): v is number {
  return Number.isSafeInteger(v);
}

/** Optional integer in [min, max]: null when absent, undefined when invalid. */
function optionalInt(v: unknown, min: number, max: number): number | null | undefined {
  if (v === undefined || v === null) return null;
  return isInt(v) && v >= min && v <= max ? v : undefined;
}

export function parseReport(text: string): Report | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;

  const { sensor_id, grid, since, ts, fw } = o;
  if (typeof sensor_id !== "string" || !SENSOR_ID.test(sensor_id)) return null;
  if (grid !== "on" && grid !== "off") return null;
  if (!isInt(ts) || ts <= 0) return null;
  if (!isInt(since) || since <= 0 || since > ts) return null;

  const battery_mv = optionalInt(o.battery_mv, 0, 10_000);
  const wifi_rssi = optionalInt(o.wifi_rssi, -127, 0);
  if (battery_mv === undefined || wifi_rssi === undefined) return null;
  if (fw !== undefined && fw !== null && (typeof fw !== "string" || !FIRMWARE.test(fw))) return null;

  return { sensor_id, grid, since, ts, battery_mv, wifi_rssi, fw: fw ?? null };
}

/** Reads at most `limit` bytes of the body; null if it is larger. */
async function readBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// Imported HMAC keys, reused while the stored (encrypted) key is unchanged.
const keyCache = new Map<string, { stored: string; key: CryptoKey }>();

async function hmacKeyFor(env: Env, sensorId: string, stored: string): Promise<CryptoKey> {
  const cached = keyCache.get(sensorId);
  if (cached?.stored === stored) return cached.key;
  const key = await importHmacKey(await decryptSensorKey(env.MASTER_KEY, stored), ["verify"]);
  keyCache.set(sensorId, { stored, key });
  return key;
}

const status = (code: number) => new Response(null, { status: code });
// Every authentication failure gets the same answer, so it reveals nothing.
const unauthorized = () => status(401);

export async function handleReport(request: Request, env: Env): Promise<Response> {
  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === null) return status(413);

  const signature = fromHex(request.headers.get("x-signature") ?? "");
  if (signature === null || signature.length !== 32) return unauthorized();

  const report = parseReport(new TextDecoder().decode(body));
  if (report === null) return status(400);

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - report.ts) > MAX_CLOCK_SKEW_S) return unauthorized();

  const sensor = await env.DB.prepare("SELECT key_encrypted FROM sensors WHERE id = ? AND enabled = 1")
    .bind(report.sensor_id)
    .first<{ key_encrypted: string }>();
  if (sensor === null) return unauthorized();

  const key = await hmacKeyFor(env, report.sensor_id, sensor.key_encrypted);
  if (!(await crypto.subtle.verify("HMAC", key, signature, body))) return unauthorized();

  // One write. The last_ts condition makes replays (and out-of-order copies) a no-op.
  const result = await env.DB.prepare(
    `UPDATE sensors
        SET last_seen = ?, last_ts = ?, grid = ?, grid_changed_at = ?,
            battery_mv = ?, wifi_rssi = ?, firmware = COALESCE(?, firmware)
      WHERE id = ? AND enabled = 1 AND (last_ts IS NULL OR last_ts < ?)`,
  )
    .bind(
      now, report.ts, report.grid, report.since,
      report.battery_mv, report.wifi_rssi, report.fw,
      report.sensor_id, report.ts,
    )
    .run();
  if (result.meta.changes !== 1) return unauthorized();

  return status(204);
}
