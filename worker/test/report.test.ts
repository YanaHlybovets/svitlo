import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { randomKey, signBody } from "../src/crypto.ts";
import { addSensor, BASE, nowS, reportBody, resetState, SENSOR, sendRaw, sendReport } from "./helpers.ts";

async function sensorRow() {
  return env.DB.prepare("SELECT * FROM sensors WHERE id = ?").bind(SENSOR).first<Record<string, unknown>>();
}

async function changes() {
  const { results } = await env.DB.prepare("SELECT grid, at FROM grid_changes ORDER BY at, id").all();
  return results;
}

describe("POST /api/v1/report", () => {
  beforeEach(resetState);

  it("accepts a valid signed report and updates only the sensor row", async () => {
    const key = await addSensor();
    const raw = reportBody();
    expect(await sendRaw(raw, await signBody(key, raw))).toBe(204);

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
    const raw = reportBody();
    const other = await signBody(randomKey(), raw);
    expect(await sendRaw(raw, other)).toBe(401);
    expect(await sendRaw(raw, "not-hex")).toBe(401);
    expect((await sensorRow())?.last_ts).toBeNull();
    expect(await sendRaw(raw, await signBody(key, raw))).toBe(204);
  });

  it("rejects a signature over a different body", async () => {
    const key = await addSensor();
    const signed = reportBody({ grid: "on" });
    const tampered = signed.replace('"grid":"on"', '"grid":"off"');
    expect(await sendRaw(tampered, await signBody(key, signed))).toBe(401);
  });

  it("rejects a replay of an accepted report", async () => {
    const key = await addSensor();
    const raw = reportBody();
    const sig = await signBody(key, raw);
    expect(await sendRaw(raw, sig)).toBe(204);
    expect(await sendRaw(raw, sig)).toBe(401);
  });

  it("rejects a report older than the last accepted one", async () => {
    const key = await addSensor();
    const newer = reportBody({ ts: nowS() });
    const older = reportBody({ ts: nowS() - 10, since: nowS() - 20 });
    expect(await sendRaw(newer, await signBody(key, newer))).toBe(204);
    expect(await sendRaw(older, await signBody(key, older))).toBe(401);
  });

  it("rejects timestamps more than 60 s from server time", async () => {
    const key = await addSensor();
    for (const ts of [nowS() - 120, nowS() + 120]) {
      const raw = reportBody({ ts, since: ts - 1 });
      expect(await sendRaw(raw, await signBody(key, raw))).toBe(401);
    }
  });

  it("rejects unknown and disabled sensors", async () => {
    const key = randomKey();
    const raw = reportBody();
    expect(await sendRaw(raw, await signBody(key, raw))).toBe(401);

    const disabledKey = await addSensor(0);
    expect(await sendRaw(raw, await signBody(disabledKey, raw))).toBe(401);
  });

  it.each([
    ["not JSON", "hello"],
    ["an array", "[]"],
    ["an unknown grid value", reportBody({ grid: "maybe" })],
    ["since after ts", reportBody({ since: nowS() + 30 })],
    ["a bad sensor id", reportBody({ sensor_id: "DROP TABLE" })],
    ["a non-integer battery", reportBody({ battery_mv: "4000" })],
  ])("rejects %s with 400", async (_name, raw) => {
    const key = await addSensor();
    expect(await sendRaw(raw, await signBody(key, raw))).toBe(400);
  });

  it("rejects bodies over 1 KB with 413", async () => {
    const key = await addSensor();
    const raw = reportBody({ fw: "x".repeat(2000) });
    expect(await sendRaw(raw, await signBody(key, raw))).toBe(413);
  });

  it("is POST only", async () => {
    expect((await exports.default.fetch(`${BASE}/api/v1/report`)).status).toBe(404);
  });

  it("shows the sensor's last report time in the building list", async () => {
    const key = await addSensor();
    const raw = reportBody();
    await sendRaw(raw, await signBody(key, raw));
    const res = await exports.default.fetch(`${BASE}/api/v1/buildings`);
    const { buildings } = (await res.json()) as { buildings: { updated_at: number | null }[] };
    expect(buildings[0]?.updated_at).toBeGreaterThan(0);
  });

  it("logs a grid change only when the state changes", async () => {
    const key = await addSensor();
    const t = nowS();
    expect(await sendReport(key, { grid: "on", since: t - 100, ts: t - 20 })).toBe(204);
    expect(await sendReport(key, { grid: "on", since: t - 100, ts: t - 10 })).toBe(204); // periodic, same state
    expect(await sendReport(key, { grid: "off", since: t - 5, ts: t - 5 })).toBe(204); // change
    expect(await changes()).toEqual([
      { grid: "on", at: t - 100 },
      { grid: "off", at: t - 5 },
    ]);
  });

  it("does not log a change from a rejected report", async () => {
    const key = await addSensor();
    const raw = reportBody({ grid: "off" });
    const sig = await signBody(key, raw);
    expect(await sendRaw(raw, sig)).toBe(204);
    await env.DB.exec("DELETE FROM grid_changes");
    expect(await sendRaw(raw, sig)).toBe(401); // replay
    const older = reportBody({ grid: "on", ts: nowS() - 30, since: nowS() - 40 });
    expect(await sendRaw(older, await signBody(key, older))).toBe(401); // out of order
    expect(await changes()).toEqual([]);
  });

  it("never logs a grid change earlier than the previous one (sensor clock reset)", async () => {
    const key = await addSensor();
    const t = nowS();
    await sendReport(key, { grid: "off", since: t - 20, ts: t - 20 });
    await sendReport(key, { grid: "on", since: t - 50, ts: t - 10 }); // since before the outage began
    await sendReport(key, { grid: "on", since: t - 60, ts: t - 5 }); // same state, older since: ignored
    expect(await changes()).toEqual([
      { grid: "off", at: t - 20 },
      { grid: "on", at: t - 20 },
    ]);
    expect((await sensorRow())?.grid_changed_at).toBe(t - 20);
  });
});
