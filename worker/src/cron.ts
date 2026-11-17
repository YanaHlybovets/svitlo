// Every minute: apply the status rules to every building and record changes.
// Writes happen only when a building's status changes.

import { evaluate, type Change, type Grid, type Status, type Transition } from "./status.ts";

interface BuildingRow {
  id: number;
  slug: string;
  status: Status;
  status_since: number | null;
  definite_status: Grid | null;
  definite_since: number | null;
  maintenance: number;
  sensor_id: string | null;
  enabled: number | null;
  last_ts: number | null;
  last_seen: number | null;
  event_start: number | null;
}

export interface BuildingTransition extends Transition {
  buildingId: number;
  slug: string;
}

export async function runStatusCron(env: Env, now = Math.floor(Date.now() / 1000)): Promise<BuildingTransition[]> {
  const { results: buildings } = await env.DB.prepare(
    `SELECT b.id, b.slug, b.status, b.status_since, b.definite_status, b.definite_since, b.maintenance,
            s.id AS sensor_id, s.enabled, s.last_ts, s.last_seen,
            (SELECT started_at FROM events e WHERE e.building_id = b.id AND e.ended_at IS NULL) AS event_start
       FROM buildings b
       LEFT JOIN sensors s ON s.building_id = b.id
      WHERE b.active = 1`,
  ).all<BuildingRow>();
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
  const all: BuildingTransition[] = [];

  buildings.forEach((b, i) => {
    const sensor =
      b.sensor_id !== null && b.enabled === 1
        ? { lastTs: b.last_ts ?? 0, lastSeen: b.last_seen ?? 0 }
        : null;
    const { state, transitions } = evaluate(
      {
        status: b.status,
        since: b.status_since,
        definite: b.definite_status,
        definiteSince: b.definite_since,
        eventStart: b.event_start,
      },
      changeSets[i]?.results ?? [],
      sensor,
      now,
      b.maintenance === 1,
    );
    if (transitions.length === 0) return;

    for (const t of transitions) {
      writes.push(
        env.DB.prepare("UPDATE events SET ended_at = ? WHERE building_id = ? AND ended_at IS NULL").bind(t.at, b.id),
        env.DB.prepare(
          "INSERT INTO events (building_id, status, started_at, notify, prev_duration_s) VALUES (?, ?, ?, ?, ?)",
        ).bind(b.id, t.status, t.at, t.notify ? 1 : 0, t.prevDuration),
      );
      all.push({ ...t, buildingId: b.id, slug: b.slug });
    }
    writes.push(
      env.DB.prepare(
        `UPDATE buildings SET status = ?, status_since = ?, definite_status = ?, definite_since = ? WHERE id = ?`,
      ).bind(state.status, state.since, state.definite, state.definiteSince, b.id),
    );
  });

  // One transaction for all changes in this run.
  if (writes.length > 0) await env.DB.batch(writes);

  for (const t of all) {
    console.log(JSON.stringify({ msg: "status_change", building: t.slug, status: t.status, at: t.at, notify: t.notify }));
  }
  // Step 6 puts the `notify` transitions on the alert queue.
  return all;
}
