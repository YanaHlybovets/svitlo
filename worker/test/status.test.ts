// One test per row of the status table in docs/architecture.md.
import { describe, expect, it } from "vitest";
import { evaluate, type BuildingState, type Change } from "../src/status.ts";

const T = 1_800_000_000; // a fixed "now"
const MIN = 60;

const ON_SINCE_YESTERDAY: BuildingState = {
  status: "on", since: T - 86_400, definite: "on", definiteSince: T - 86_400, eventStart: T - 86_400,
};
const OFF_SINCE_AN_HOUR: BuildingState = {
  status: "off", since: T - 3600, definite: "off", definiteSince: T - 3600, eventStart: T - 3600,
};
const NEW_BUILDING: BuildingState = { status: "no_data", since: null, definite: null, definiteSince: null, eventStart: null };

/** A sensor that last reported `ago` seconds ago. */
const fresh = (ago = 0) => ({ lastTs: T - ago, lastSeen: T - ago });

const run = (state: BuildingState, changes: Change[], sensor = fresh(), maintenance = false) =>
  evaluate(state, changes, sensor, T, maintenance);

describe("status rules", () => {
  it("grid off confirmed by a report 30 s later -> OFF, alert at once", () => {
    const off = T - 30;
    const { state, transitions } = run(ON_SINCE_YESTERDAY, [{ grid: "on", at: T - 86_400 }, { grid: "off", at: off }]);
    expect(transitions).toEqual([{ status: "off", at: off, notify: true, prevDuration: off - (T - 86_400) }]);
    expect(state).toMatchObject({ status: "off", since: off, definite: "off", definiteSince: off });
  });

  it("grid off not yet confirmed -> no change yet", () => {
    const changes: Change[] = [{ grid: "on", at: T - 86_400 }, { grid: "off", at: T - 10 }];
    expect(run(ON_SINCE_YESTERDAY, changes).transitions).toEqual([]);
  });

  it("grid on for 60 s or more -> ON, alert with the outage length", () => {
    const back = T - MIN;
    const { transitions } = run(OFF_SINCE_AN_HOUR, [{ grid: "off", at: T - 3600 }, { grid: "on", at: back }]);
    expect(transitions).toEqual([{ status: "on", at: back, notify: true, prevDuration: back - (T - 3600) }]);
  });

  it("grid on for less than 60 s -> still OFF", () => {
    const changes: Change[] = [{ grid: "off", at: T - 3600 }, { grid: "on", at: T - 20 }];
    expect(run(OFF_SINCE_AN_HOUR, changes).transitions).toEqual([]);
  });

  it("an outage shorter than 30 s (flicker) -> no change, no alert", () => {
    const changes: Change[] = [
      { grid: "on", at: T - 86_400 },
      { grid: "off", at: T - 50 },
      { grid: "on", at: T - 30 },
    ];
    expect(run(ON_SINCE_YESTERDAY, changes).transitions).toEqual([]);
  });

  it("an outage that began and ended between two cron runs is still recorded", () => {
    const changes: Change[] = [
      { grid: "on", at: T - 86_400 },
      { grid: "off", at: T - 100 }, // 45 s outage
      { grid: "on", at: T - 55 },
    ];
    const { state, transitions } = run(ON_SINCE_YESTERDAY, changes);
    expect(transitions).toEqual([{ status: "off", at: T - 100, notify: true, prevDuration: 86_400 - 100 }]);
    // Power is back but not yet for 60 s; the next run confirms ON.
    expect(state.status).toBe("off");
    const next = evaluate(state, changes.slice(1), fresh(), T + 10, false);
    expect(next.transitions).toEqual([{ status: "on", at: T - 55, notify: true, prevDuration: 45 }]);
  });

  it("silent for over 3 min after reporting off -> stays OFF, no new alert", () => {
    const changes: Change[] = [{ grid: "off", at: T - 3600 }];
    expect(run(OFF_SINCE_AN_HOUR, changes, fresh(4 * MIN)).transitions).toEqual([]);
  });

  it("silent for over 3 min after an unconfirmed off -> OFF (the battery kept it able to report)", () => {
    const changes: Change[] = [{ grid: "on", at: T - 86_400 }, { grid: "off", at: T - 5 * MIN }];
    const sensor = { lastTs: T - 5 * MIN, lastSeen: T - 5 * MIN }; // only the first "off" report arrived
    const { transitions } = run(ON_SINCE_YESTERDAY, changes, sensor);
    expect(transitions).toMatchObject([{ status: "off", at: T - 5 * MIN, notify: true }]);
  });

  it("silent for over 3 min after reporting on -> NO DATA, no alert", () => {
    const lastSeen = T - 4 * MIN;
    const { state, transitions } = run(ON_SINCE_YESTERDAY, [{ grid: "on", at: T - 86_400 }], fresh(4 * MIN));
    expect(transitions).toEqual([{ status: "no_data", at: lastSeen, notify: false, prevDuration: null }]);
    expect(state).toMatchObject({ status: "no_data", since: lastSeen, definite: "on" });
  });

  it("silent for exactly 3 min -> not yet NO DATA", () => {
    expect(run(ON_SINCE_YESTERDAY, [{ grid: "on", at: T - 86_400 }], fresh(3 * MIN)).transitions).toEqual([]);
  });

  it("back after silence in the same state -> ON again, no alert, original since kept", () => {
    const noData: BuildingState = { ...ON_SINCE_YESTERDAY, status: "no_data", since: T - 600, eventStart: T - 600 };
    const { state, transitions } = run(noData, [{ grid: "on", at: T - 86_400 }]);
    expect(transitions).toEqual([{ status: "on", at: T - 600, notify: false, prevDuration: null }]);
    expect(state).toMatchObject({ status: "on", since: T - 86_400 });
  });

  it("back after silence with power gone meanwhile -> OFF with alert, real outage start", () => {
    const noData: BuildingState = { ...ON_SINCE_YESTERDAY, status: "no_data", since: T - 600, eventStart: T - 600 };
    const changes: Change[] = [{ grid: "on", at: T - 86_400 }, { grid: "off", at: T - 300 }];
    const { state, transitions } = run(noData, changes);
    // The on-period before it is closed first (no alert), then the outage is alerted.
    expect(transitions).toEqual([
      { status: "on", at: T - 600, notify: false, prevDuration: null },
      { status: "off", at: T - 300, notify: true, prevDuration: 86_400 - 300 },
    ]);
    expect(state).toMatchObject({ status: "off", since: T - 300 });
  });

  it("maintenance -> status still tracked, but no alerts", () => {
    const changes: Change[] = [{ grid: "on", at: T - 86_400 }, { grid: "off", at: T - 60 }];
    const { transitions } = run(ON_SINCE_YESTERDAY, changes, fresh(), true);
    expect(transitions).toMatchObject([{ status: "off", notify: false }]);
  });

  it("the first status of a new sensor is not alerted", () => {
    const { transitions } = run(NEW_BUILDING, [{ grid: "on", at: T - 120 }]);
    expect(transitions).toEqual([{ status: "on", at: T - 120, notify: false, prevDuration: null }]);
  });

  it("a sensor that never reported -> stays NO DATA", () => {
    expect(run(NEW_BUILDING, []).transitions).toEqual([]);
  });

  it("no sensor or a disabled one -> NO DATA", () => {
    const { transitions } = evaluate(ON_SINCE_YESTERDAY, [], null, T, false);
    expect(transitions).toMatchObject([{ status: "no_data", at: T, notify: false }]);
  });

  it("is idempotent: running again with the same input changes nothing", () => {
    const changes: Change[] = [{ grid: "on", at: T - 86_400 }, { grid: "off", at: T - 40 }];
    const first = run(ON_SINCE_YESTERDAY, changes);
    expect(first.transitions).toHaveLength(1);
    expect(run(first.state, changes.slice(1)).transitions).toEqual([]);
  });

  it("never starts an event before the open one", () => {
    // Sensor clock slightly behind the time the current event began.
    const state: BuildingState = { ...ON_SINCE_YESTERDAY, eventStart: T - 20 };
    const { transitions } = run(state, [{ grid: "on", at: T - 86_400 }, { grid: "off", at: T - 40 }]);
    expect(transitions[0]?.at).toBe(T - 20);
  });
});
