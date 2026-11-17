// Status evaluation: every minute for all buildings (cron), and at once for one
// building when a sensor report may change its status (fast path in report.ts).
// Writes happen only when a status changes, guarded by buildings.rev so two
// concurrent evaluations never record the same change twice (ADR 0006).

import { batteryAlerts, enqueueAlerts, notifyAdmin, type AlertMessage, type StatusChange } from "./alerts.ts";
import { evaluate, type Change, type Grid, type Status } from "./status.ts";
import { telegramClient, type TelegramClient } from "./telegram/client.ts";

interface BuildingRow {
  id: number;
  slug: string;
  address_uk: string;
  address_en: string;
  status: Status;
  status_since: number | null;
  definite_status: Grid | null;
  definite_since: number | null;
  maintenance: number;
  rev: string | null;
  sensor_id: string | null;
  enabled: number | null;
  last_ts: number | null;
  last_seen: number | null;
  event_start: number | null;
}

export interface RunOptions {
  now?: number;
  /** Only this building (fast path); all active buildings when omitted. */
  buildingId?: number;
  queue?: Queue<AlertMessage>;
  tg?: TelegramClient;
}

export async function runStatus(env: Env, options: RunOptions = {}): Promise<StatusChange[]> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const only = options.buildingId;
  const { results: buildings } = await env.DB.prepare(
    `SELECT b.id, b.slug, b.address_uk, b.address_en, b.status, b.status_since, b.definite_status,
            b.definite_since, b.maintenance, b.rev,
            s.id AS sensor_id, s.enabled, s.last_ts, s.last_seen,
            (SELECT started_at FROM events e WHERE e.building_id = b.id AND e.ended_at IS NULL) AS event_start
       FROM buildings b
       LEFT JOIN sensors s ON s.building_id = b.id
      WHERE b.active = 1 ${only === undefined ? "" : "AND b.id = ?"}`,
  )
    .bind(...(only === undefined ? [] : [only]))
    .all<BuildingRow>();
  if (buildings.length === 0) return [];

  // The change active when the current status began, and everything after it.
  const changeSets = await env.DB.batch<Change>(
    buildings.map((b) =>
      env.DB.prepare(
        `SELECT grid, at FROM grid_changes
          WHERE building_id = ?1
            AND at >= COALESCE((SELECT MAX(at) FROM grid_changes WHERE building_id = ?1 AND at <= ?2), 0)
          ORDER BY at, id`,
      ).bind(b.id, b.status_since ?? 0),
    ),
  );

  const writes: D1PreparedStatement[] = [];
  const plans: { guard: number; inserts: number[]; changes: Omit<StatusChange, "eventId">[] }[] = [];

  buildings.forEach((b, i) => {
    const sensor = b.sensor_id !== null && b.enabled === 1 ? { lastTs: b.last_ts ?? 0, lastSeen: b.last_seen ?? 0 } : null;
    const { state, transitions } = evaluate(
      { status: b.status, since: b.status_since, definite: b.definite_status, definiteSince: b.definite_since, eventStart: b.event_start },
      changeSets[i]?.results ?? [],
      sensor,
      now,
      b.maintenance === 1,
    );
    if (transitions.length === 0) return;

    const rev = crypto.randomUUID();
    const mine = `EXISTS (SELECT 1 FROM buildings WHERE id = ? AND rev = ?)`;
    const guard = writes.length;
    writes.push(
      env.DB.prepare(
        `UPDATE buildings SET status = ?, status_since = ?, definite_status = ?, definite_since = ?, rev = ?
          WHERE id = ? AND rev IS ?`,
      ).bind(state.status, state.since, state.definite, state.definiteSince, rev, b.id, b.rev),
    );
    const inserts: number[] = [];
    let previous = b.status;
    const changes: Omit<StatusChange, "eventId">[] = [];
    for (const t of transitions) {
      writes.push(
        env.DB.prepare(`UPDATE events SET ended_at = ? WHERE building_id = ? AND ended_at IS NULL AND ${mine}`)
          .bind(t.at, b.id, b.id, rev),
      );
      inserts.push(writes.length);
      writes.push(
        env.DB.prepare(
          `INSERT INTO events (building_id, status, started_at, notify, prev_duration_s)
           SELECT ?, ?, ?, ?, ? WHERE ${mine} RETURNING id`,
        ).bind(b.id, t.status, t.at, t.notify ? 1 : 0, t.prevDuration, b.id, rev),
      );
      changes.push({
        buildingId: b.id, slug: b.slug, address_uk: b.address_uk, address_en: b.address_en,
        status: t.status, previous, at: t.at, notify: t.notify, prevDuration: t.prevDuration,
      });
      previous = t.status;
    }
    plans.push({ guard, inserts, changes });
  });

  if (writes.length === 0) return [];
  const results = await env.DB.batch<{ id: number }>(writes);

  // Keep only the buildings whose guarded write won.
  const committed: StatusChange[] = [];
  for (const p of plans) {
    if (results[p.guard]?.meta.changes !== 1) continue;
    p.changes.forEach((c, k) => {
      const eventId = results[p.inserts[k] ?? -1]?.results[0]?.id;
      if (eventId !== undefined) committed.push({ ...c, eventId });
    });
  }

  for (const c of committed) {
    console.log(JSON.stringify({ msg: "status_change", building: c.slug, status: c.status, at: c.at, notify: c.notify }));
  }
  if (committed.length > 0) {
    await enqueueAlerts(env, committed, options.queue ?? env.ALERTS, now);
    await notifyAdmin(env, committed, options.tg ?? telegramClient(env.TELEGRAM_BOT_TOKEN), now);
  }
  return committed;
}

/** The every-minute job: all buildings, low-battery checks, and hourly clean-up of old delivery records. */
export async function runStatusCron(env: Env, now = Math.floor(Date.now() / 1000), options: Omit<RunOptions, "now" | "buildingId"> = {}) {
  const changes = await runStatus(env, { ...options, now });
  await batteryAlerts(env, options.tg ?? telegramClient(env.TELEGRAM_BOT_TOKEN));
  if (Math.floor(now / 60) % 60 === 0) {
    await env.DB.prepare("DELETE FROM alert_batches WHERE done_at < ?").bind(now - 7 * 86_400).run();
  }
  return changes;
}
