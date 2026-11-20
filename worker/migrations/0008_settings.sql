-- Small key-value store for service state, e.g. the last day a usage alert was sent.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
