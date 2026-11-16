-- Svitlo: initial schema.
-- All times are Unix seconds (UTC). Booleans are INTEGER 0/1.

CREATE TABLE buildings (
  id             INTEGER PRIMARY KEY,
  slug           TEXT    NOT NULL UNIQUE,             -- used in URLs and Telegram deep links
  address_uk     TEXT    NOT NULL,
  address_en     TEXT    NOT NULL,
  district       TEXT    NOT NULL,                    -- key, e.g. 'darnytskyi'; translated in the UI
  status         TEXT    NOT NULL DEFAULT 'no_data'
                         CHECK (status IN ('on', 'off', 'no_data')),
  status_since   INTEGER,                             -- sensor time the current status began
  last_report_at INTEGER,
  maintenance    INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1)),  -- no alerts while 1
  active         INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch())
);

-- One sensor per building. Each report updates only this row.
CREATE TABLE sensors (
  id              TEXT    PRIMARY KEY,                -- flashed into the device
  building_id     INTEGER NOT NULL UNIQUE REFERENCES buildings (id),
  key_encrypted   TEXT    NOT NULL,                   -- HMAC key, AES-GCM with the master key (Worker secret)
  last_seen       INTEGER,                            -- server time of the last accepted report
  last_ts         INTEGER,                            -- sensor time of the last accepted report (replay guard)
  grid            TEXT    CHECK (grid IN ('on', 'off')),
  grid_changed_at INTEGER,                            -- sensor time of the last grid change
  battery_mv      INTEGER,
  wifi_rssi       INTEGER,
  firmware        TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Status history. Written only when a building's status changes.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  building_id INTEGER NOT NULL REFERENCES buildings (id),
  status      TEXT    NOT NULL CHECK (status IN ('on', 'off', 'no_data')),
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER                                 -- NULL while ongoing
);
CREATE INDEX events_building_started ON events (building_id, started_at);

CREATE TABLE users (
  telegram_chat_id INTEGER PRIMARY KEY,
  language         TEXT    NOT NULL DEFAULT 'uk' CHECK (language IN ('uk', 'en')),
  quiet_from       INTEGER CHECK (quiet_from BETWEEN 0 AND 1439),  -- minutes after midnight, Kyiv time
  quiet_to         INTEGER CHECK (quiet_to BETWEEN 0 AND 1439),
  blocked          INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1)),
  created_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE subscriptions (
  chat_id     INTEGER NOT NULL REFERENCES users (telegram_chat_id) ON DELETE CASCADE,
  building_id INTEGER NOT NULL REFERENCES buildings (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (chat_id, building_id)
) WITHOUT ROWID;
CREATE INDEX subscriptions_building ON subscriptions (building_id);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY,
  at      INTEGER NOT NULL DEFAULT (unixepoch()),
  admin   TEXT    NOT NULL,
  action  TEXT    NOT NULL,
  details TEXT                                        -- JSON
);
