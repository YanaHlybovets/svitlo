import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { encryptSensorKey, randomKey, signBody } from "../src/crypto.ts";

const URL_REPORT = "https://svitlo.test/api/v1/report";
const SENSOR = "s-revutskogo-54a";

const nowS = () => Math.floor(Date.now() / 1000);

async function addSensor(enabled = 1) {
  const key = randomKey();
  await env.DB.prepare("INSERT INTO sensors (id, building_id, key_encrypted, enabled) VALUES (?, 1, ?, ?)")
    .bind(SENSOR, await encryptSensorKey(env.MASTER_KEY, key), enabled)
    .run();
  return key;
}

function body(overrides: Record<string, unknown> = {}): string {
  const ts = nowS();
  return JSON.stringify({
    sensor_id: SENSOR, grid: "off", since: ts - 5, ts,
    battery_mv: 4000, wifi_rssi: -60, fw: "0.1.0",
    ...overrides,
  });
}

async function send(raw: string, signature: string): Promise<number> {
  const res = await exports.default.fetch(URL_REPORT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signature },
    body: raw,
  });
  return res.status;
}

async function sensorRow() {
  return env.DB.prepare("SELECT * FROM sensors WHERE id = ?").bind(SENSOR).first<Record<string, unknown>>();
}

describe("POST /api/v1/report", () => {
  // Tests in one file share a database, so start each test without a sensor.
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM sensors");
  });

  it("accepts a valid signed report and updates only the sensor row", async () => {
    const key = await addSensor();
    const raw = body();
    expect(await send(raw, await signBody(key, raw))).toBe(204);

    const parsed = JSON.parse(raw);
    expect(await sensorRow()).toMatchObject({
      grid: "off", grid_changed_at: parsed.since, last_ts: parsed.ts,
      battery_mv: 4000, wifi_rssi: -60, firmware: "0.1.0",
    });
    // The building's status is decided by the cron job, not by the report.
    const building = await env.DB.prepare("SELECT status FROM buildings WHERE id = 1").first();
    expect(building).toEqual({ status: "no_data" });
  });

  it("rejects a wrong signature", async () => {
    const key = await addSensor();
    const raw = body();
    const other = await signBody(randomKey(), raw);
    expect(await send(raw, other)).toBe(401);
    expect(await send(raw, "not-hex")).toBe(401);
    expect((await sensorRow())?.last_ts).toBeNull();
    expect(await send(raw, await signBody(key, raw))).toBe(204);
  });

  it("rejects a signature over a different body", async () => {
    const key = await addSensor();
    const signed = body({ grid: "on" });
    const tampered = signed.replace('"grid":"on"', '"grid":"off"');
    expect(await send(tampered, await signBody(key, signed))).toBe(401);
  });

  it("rejects a replay of an accepted report", async () => {
    const key = await addSensor();
    const raw = body();
    const sig = await signBody(key, raw);
    expect(await send(raw, sig)).toBe(204);
    expect(await send(raw, sig)).toBe(401);
  });

  it("rejects a report older than the last accepted one", async () => {
    const key = await addSensor();
    const newer = body({ ts: nowS() });
    const older = body({ ts: nowS() - 10, since: nowS() - 20 });
    expect(await send(newer, await signBody(key, newer))).toBe(204);
    expect(await send(older, await signBody(key, older))).toBe(401);
  });

  it("rejects timestamps more than 60 s from server time", async () => {
    const key = await addSensor();
    for (const ts of [nowS() - 120, nowS() + 120]) {
      const raw = body({ ts, since: ts - 1 });
      expect(await send(raw, await signBody(key, raw))).toBe(401);
    }
  });

  it("rejects unknown and disabled sensors", async () => {
    const key = randomKey();
    const raw = body();
    expect(await send(raw, await signBody(key, raw))).toBe(401);

    const disabledKey = await addSensor(0);
    expect(await send(raw, await signBody(disabledKey, raw))).toBe(401);
  });

  it.each([
    ["not JSON", "hello"],
    ["an array", "[]"],
    ["an unknown grid value", body({ grid: "maybe" })],
    ["since after ts", body({ since: nowS() + 30 })],
    ["a bad sensor id", body({ sensor_id: "DROP TABLE" })],
    ["a non-integer battery", body({ battery_mv: "4000" })],
  ])("rejects %s with 400", async (_name, raw) => {
    const key = await addSensor();
    expect(await send(raw, await signBody(key, raw))).toBe(400);
  });

  it("rejects bodies over 1 KB with 413", async () => {
    const key = await addSensor();
    const raw = body({ fw: "x".repeat(2000) });
    expect(await send(raw, await signBody(key, raw))).toBe(413);
  });

  it("is POST only", async () => {
    expect((await exports.default.fetch(URL_REPORT)).status).toBe(404);
  });

  it("shows the sensor's last report time in the building list", async () => {
    const key = await addSensor();
    const raw = body();
    await send(raw, await signBody(key, raw));
    const res = await exports.default.fetch("https://svitlo.test/api/v1/buildings");
    const { buildings } = (await res.json()) as { buildings: { updated_at: number | null }[] };
    expect(buildings[0]?.updated_at).toBeGreaterThan(0);
  });
});
