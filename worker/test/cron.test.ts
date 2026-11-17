import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runStatusCron } from "../src/cron.ts";
import worker from "../src/index.ts";
import { addSensor, BASE, nowS, resetState, sendReport } from "./helpers.ts";

beforeEach(resetState);

async function building() {
  return env.DB.prepare(
    "SELECT status, status_since, definite_status, definite_since FROM buildings WHERE id = 1",
  ).first();
}

async function events() {
  const { results } = await env.DB.prepare(
    "SELECT status, started_at, ended_at, notify, prev_duration_s FROM events ORDER BY id",
  ).all();
  return results;
}

describe("status cron", () => {
  it("does nothing while the sensor has never reported", async () => {
    await addSensor();
    expect(await runStatusCron(env)).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("follows a full outage: first status, off, back on", async () => {
    const key = await addSensor();
    const t = nowS();

    // Power on for 2 minutes: the first status, not alerted.
    await sendReport(key, { grid: "on", since: t - 120, ts: t - 60 });
    expect(await runStatusCron(env, t - 60)).toMatchObject([{ status: "on", notify: false }]);

    // Power off, confirmed 30 s later.
    await sendReport(key, { grid: "off", since: t - 40, ts: t - 40 });
    expect(await runStatusCron(env, t - 40)).toEqual([]); // not confirmed yet
    await sendReport(key, { grid: "off", since: t - 40, ts: t - 10 });
    expect(await runStatusCron(env, t - 10)).toMatchObject([{ status: "off", notify: true, prevDuration: 80 }]);
    expect(await building()).toEqual({ status: "off", status_since: t - 40, definite_status: "off", definite_since: t - 40 });

    // Running again changes nothing.
    expect(await runStatusCron(env, t - 5)).toEqual([]);

    // Power back for 60 s: ON with the outage length.
    await sendReport(key, { grid: "on", since: t, ts: t });
    expect(await runStatusCron(env, t + 60)).toMatchObject([{ status: "on", notify: true, prevDuration: 40 }]);

    expect(await events()).toEqual([
      { status: "on", started_at: t - 120, ended_at: t - 40, notify: 0, prev_duration_s: null },
      { status: "off", started_at: t - 40, ended_at: t, notify: 1, prev_duration_s: 80 },
      { status: "on", started_at: t, ended_at: null, notify: 1, prev_duration_s: 40 },
    ]);
  });

  it("marks a silent sensor NO DATA, then restores ON without an alert", async () => {
    const key = await addSensor();
    const t = nowS();
    await sendReport(key, { grid: "on", since: t - 600, ts: t });
    await runStatusCron(env, t);

    expect(await runStatusCron(env, t + 181)).toMatchObject([{ status: "no_data", notify: false }]);
    expect(await building()).toMatchObject({ status: "no_data", definite_status: "on" });

    // The sensor comes back still on.
    await env.DB.prepare("UPDATE sensors SET last_seen = ?, last_ts = ? WHERE id = 's-revutskogo-54a'")
      .bind(t + 300, t + 300)
      .run();
    expect(await runStatusCron(env, t + 300)).toMatchObject([{ status: "on", notify: false }]);
    expect(await building()).toMatchObject({ status: "on", status_since: t - 600 });
  });

  it("does not alert during maintenance", async () => {
    const key = await addSensor();
    const t = nowS();
    await sendReport(key, { grid: "on", since: t - 600, ts: t - 60 });
    await runStatusCron(env, t - 60);
    await env.DB.exec("UPDATE buildings SET maintenance = 1");
    await sendReport(key, { grid: "off", since: t - 40, ts: t });
    expect(await runStatusCron(env, t)).toMatchObject([{ status: "off", notify: false }]);
  });

  it("runs from the scheduled handler", async () => {
    const key = await addSensor();
    await sendReport(key, { grid: "on", since: nowS() - 600, ts: nowS() });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "* * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await building()).toMatchObject({ status: "on" });
  });
});

describe("public API", () => {
  it("serves the building list with a 15 s cache", async () => {
    const res = await exports.default.fetch(`${BASE}/api/v1/buildings`);
    expect(res.headers.get("cache-control")).toBe("public, max-age=15");
    const body = (await res.json()) as { buildings: unknown[] };
    expect(body.buildings[0]).toMatchObject({ slug: "revutskogo-54a", status: "no_data", maintenance: false });
  });

  it("serves later requests from the cache, even with extra query strings", async () => {
    await exports.default.fetch(`${BASE}/api/v1/buildings`);
    await env.DB.exec("UPDATE buildings SET status = 'off'");
    const res = await exports.default.fetch(`${BASE}/api/v1/buildings?nocache=123`);
    const body = (await res.json()) as { buildings: { status: string }[] };
    expect(body.buildings[0]?.status).toBe("no_data"); // cached copy
  });

  it("returns history with events and short flickers", async () => {
    // Reports older than 60 s are rejected by design, so seed the past directly.
    await addSensor();
    const t = nowS();
    const change = env.DB.prepare("INSERT INTO grid_changes (building_id, grid, at) VALUES (1, ?, ?)");
    await env.DB.batch([
      change.bind("on", t - 3600),
      change.bind("off", t - 2000), // 20 s flicker
      change.bind("on", t - 1980),
      change.bind("off", t - 1000), // real outage
      env.DB.prepare("UPDATE sensors SET last_ts = ?, last_seen = ?").bind(t - 900, t - 900),
    ]);
    await runStatusCron(env, t - 900);

    const res = await exports.default.fetch(`${BASE}/api/v1/buildings/revutskogo-54a/history?days=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      slug: "revutskogo-54a",
      days: 1,
      events: [
        { status: "on", started_at: t - 3600, ended_at: t - 1000 },
        { status: "off", started_at: t - 1000, ended_at: null },
      ],
      flickers: [{ started_at: t - 2000, ended_at: t - 1980 }],
    });
  });

  it("clamps days and rejects unknown buildings", async () => {
    const res = await exports.default.fetch(`${BASE}/api/v1/buildings/revutskogo-54a/history?days=999`);
    expect(((await res.json()) as { days: number }).days).toBe(30);
    expect((await exports.default.fetch(`${BASE}/api/v1/buildings/nowhere/history`)).status).toBe(404);
    expect((await exports.default.fetch(`${BASE}/api/v1/buildings/Bad%20Slug/history`)).status).toBe(404);
  });
});
