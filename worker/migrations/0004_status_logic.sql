-- Step 3: status logic.

-- Every grid change a sensor reports (written only when the state changes).
-- The cron job reads it, so outages shorter than a cron interval are not
-- missed, and the website shows short flickers from it.
CREATE TABLE grid_changes (
  id          INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings (id),
  grid        TEXT    NOT NULL CHECK (grid IN ('on', 'off')),
  at          INTEGER NOT NULL,                       -- sensor time the state began
  UNIQUE (building_id, at, grid)                      -- replays cannot add duplicates
);

-- The last confirmed on/off status. It survives a "no data" gap, so a sensor
-- that comes back in the same state sends no alert.
ALTER TABLE buildings ADD COLUMN definite_status TEXT CHECK (definite_status IN ('on', 'off'));
ALTER TABLE buildings ADD COLUMN definite_since  INTEGER;

-- Whether subscribers are alerted about this change, and how long the
-- previous on/off lasted ("було 5 год 42 хв").
ALTER TABLE events ADD COLUMN notify          INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0, 1));
ALTER TABLE events ADD COLUMN prev_duration_s INTEGER;
