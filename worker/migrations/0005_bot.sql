-- Step 5: Telegram bot.

-- What the bot expects the user's next text message to be.
ALTER TABLE users ADD COLUMN pending TEXT CHECK (pending IN ('request'));

-- "I want a sensor in my building" requests, for the admin panel (Step 8).
-- Deleted with the user (/delete_me).
CREATE TABLE building_requests (
  id         INTEGER PRIMARY KEY,
  chat_id    INTEGER NOT NULL REFERENCES users (telegram_chat_id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
