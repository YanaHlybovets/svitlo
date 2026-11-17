-- Step 6: alert delivery.

-- A random token replaced on every status write. Writers check it, so two
-- evaluations of the same building (the cron job and the fast path after a
-- report) can never both record the same change or send the same alert twice.
ALTER TABLE buildings ADD COLUMN rev TEXT;

-- Alert batches already delivered (one row per up to 40 recipients), so a
-- queue redelivery never sends the same alert again. Cleaned after 7 days.
CREATE TABLE alert_batches (
  id      TEXT    PRIMARY KEY,                 -- "<event id>:<part>[.<retry>]"
  done_at INTEGER NOT NULL DEFAULT (unixepoch())
);
