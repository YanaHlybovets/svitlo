# ADR 0003: Status decided by the cron job from a grid-change log

- **Status:** Accepted
- **Date:** 2026-11-16

## Context

The plan makes the every-minute cron job the only part that decides a building's status, so the website and the bot always agree. But a report only updates the sensor's own row, which holds just its **latest** state. An outage that starts and ends between two cron runs (for example, 45 s) would never be seen, and short flickers couldn't be shown in the history.

## Decision

- When a report shows a **new** grid state, the report handler also writes one row to `grid_changes` (`building_id`, `grid`, `at` = the sensor's own time the state began). Periodic reports in the same state write nothing extra.
- The cron job reads, for each building, the change that was active when its current status began plus every later change, and replays them through one pure function (`worker/src/status.ts`):
  - an `off` period counts once it lasted **30 s** (confirmed by a later report or by the next change);
  - an `on` period counts once it lasted **60 s**;
  - shorter periods are flickers: kept in `grid_changes` and shown in history, never alerted.
- `buildings.definite_status` / `definite_since` keep the last confirmed on/off through a "no data" gap. A sensor that comes back in the same state restores it without an alert, and with its original "since".
- A grid change is never logged earlier than the previous one, which guards against a reset sensor clock.

## Consequences

- No outage is missed, whatever its timing relative to cron runs. Durations come from the sensor's timestamps.
- Writes stay within the free-plan budget: still one row per report, plus one per real grid change. Building and event rows are written only when a status changes.
- The rules are a pure function with one test per row of the status table, so tuning thresholds after the pilot is low-risk.
