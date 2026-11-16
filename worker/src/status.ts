// Status rules (docs/architecture.md, "Status logic"). Pure: no I/O, so every
// rule is unit-tested directly. All times are Unix seconds.

export type Grid = "on" | "off";
export type Status = Grid | "no_data";

/** An "off" must be confirmed by a report at least this long after it began. */
export const OFF_CONFIRM_S = 30;
/** Power must be back this long before the building counts as "on". */
export const ON_CONFIRM_S = 60;
/** A sensor with no report for longer than this is silent. */
export const SILENT_AFTER_S = 180;

export interface BuildingState {
  status: Status;
  /** Shown as "since …". For on/off, when that status truly began. */
  since: number | null;
  /** Last confirmed on/off. Kept through "no data". */
  definite: Grid | null;
  definiteSince: number | null;
  /** Start of the open event row, so new events never start before it. */
  eventStart: number | null;
}

/** One row of grid_changes: the grid state that began at `at`. */
export interface Change {
  grid: Grid;
  at: number;
}

export interface SensorSnapshot {
  /** Sensor time of its last accepted report. */
  lastTs: number;
  /** Server time of its last accepted report. */
  lastSeen: number;
}

export interface Transition {
  status: Status;
  /** Start time of the new event row. */
  at: number;
  /** True when subscribers get an alert. */
  notify: boolean;
  /** How long the previous on/off lasted, for the alert text. */
  prevDuration: number | null;
}

const confirmAfter = (grid: Grid) => (grid === "off" ? OFF_CONFIRM_S : ON_CONFIRM_S);

/**
 * Applies the sensor's grid changes to a building's state.
 *
 * `changes` are ascending and start with the change active at `state.since`
 * (or all of them while the building has no status yet). The last one is the
 * sensor's current state. Re-running with the same input changes nothing.
 */
export function evaluate(
  state: BuildingState,
  changes: Change[],
  sensor: SensorSnapshot | null,
  now: number,
  maintenance: boolean,
): { state: BuildingState; transitions: Transition[] } {
  const s = { ...state };
  const transitions: Transition[] = [];

  const go = (status: Status, at: number) => {
    if (status === s.status) return;
    let since = at;
    let notify = false;
    let prevDuration: number | null = null;

    if (status !== "no_data") {
      if (status === s.definite) {
        // Back after "no data" in the same state: no alert, and keep the true start.
        since = s.definiteSince ?? at;
      } else {
        // A real change. The very first status of a new sensor is not alerted.
        if (s.definite !== null && s.definiteSince !== null) {
          prevDuration = Math.max(0, at - s.definiteSince);
          notify = !maintenance;
        }
        s.definite = status;
        s.definiteSince = at;
      }
    }

    const eventAt = Math.max(at, s.eventStart ?? at);
    transitions.push({ status, at: eventAt, notify, prevDuration });
    s.status = status;
    s.since = since;
    s.eventStart = eventAt;
  };

  if (sensor === null) {
    go("no_data", now);
    return { state: s, transitions };
  }

  // Closed periods: each lasted until the next change.
  for (let i = 0; i < changes.length - 1; i++) {
    const c = changes[i]!;
    const next = changes[i + 1]!;
    if (next.at - c.at >= confirmAfter(c.grid)) go(c.grid, c.at);
    // Shorter periods are flickers: shown in history, never alerted.
  }

  // The current period.
  const open = changes.at(-1);
  if (open === undefined) return { state: s, transitions }; // never reported yet

  const silent = now - sensor.lastSeen > SILENT_AFTER_S;
  if (open.grid === "off") {
    // A sensor on its battery can always report "off", so silence after "off" stays OFF.
    if (silent || sensor.lastTs - open.at >= OFF_CONFIRM_S) go("off", open.at);
  } else if (silent) {
    // Silent while the grid was on: the router or sensor is down, not the power.
    go("no_data", sensor.lastSeen);
  } else if (now - open.at >= ON_CONFIRM_S) {
    go("on", open.at);
  }

  return { state: s, transitions };
}
