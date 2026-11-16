-- A report writes only the sensor row (one write per report), so the
-- building's "last report" time is read from sensors.last_seen instead.
ALTER TABLE buildings DROP COLUMN last_report_at;
