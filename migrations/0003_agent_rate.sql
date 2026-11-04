-- Per-key request counter, one row per key per minute. A call reserves its slot atomically before it runs.
CREATE TABLE IF NOT EXISTS agent_rate (
  key_id TEXT NOT NULL,
  bucket INTEGER NOT NULL,                -- floor(unix ms / 60000)
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, bucket)
);
