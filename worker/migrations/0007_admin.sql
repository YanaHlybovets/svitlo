-- Step 8: admin panel.

-- Set once the admin has been told about a low battery; cleared when it recovers.
ALTER TABLE sensors ADD COLUMN low_battery_alerted INTEGER NOT NULL DEFAULT 0 CHECK (low_battery_alerted IN (0, 1));
