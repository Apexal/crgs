CREATE TABLE submissions (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  town        TEXT,
  who         TEXT NOT NULL CHECK (who IN ('me', 'known', 'legend')),
  story       TEXT,
  audio_key   TEXT,
  audio_type  TEXT,
  audio_bytes INTEGER,
  duration_s  REAL,
  anonymous   INTEGER NOT NULL DEFAULT 0,
  credit      TEXT,
  credit_line TEXT NOT NULL,
  publish_ok  INTEGER NOT NULL CHECK (publish_ok = 1),
  voice_ok    INTEGER NOT NULL DEFAULT 0,
  contact_ok  INTEGER NOT NULL DEFAULT 0,
  contact     TEXT,
  CHECK (audio_key IS NOT NULL OR story IS NOT NULL)
);

CREATE INDEX submissions_created_at ON submissions (created_at);
