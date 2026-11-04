-- Agent API: scoped keys for AI agents (MCP at /mcp, REST at /api/agent/v1) and an audit trail of every call.
-- Keys are shown to the owner once and stored only as a SHA-256 hash.

CREATE TABLE IF NOT EXISTS agent_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,      -- sha256 hex of the full key
  key_prefix   TEXT NOT NULL,             -- first characters, for recognising a key in the list
  scopes       TEXT NOT NULL,             -- space-separated, e.g. "menu:read menu:write"
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE IF NOT EXISTS agent_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id     TEXT NOT NULL,
  key_name   TEXT NOT NULL,
  channel    TEXT NOT NULL CHECK(channel IN ('mcp','rest')),
  tool       TEXT NOT NULL,
  ok         INTEGER NOT NULL,
  status     INTEGER,
  summary    TEXT,                        -- arguments and result, truncated; never image bytes
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_audit_created ON agent_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_audit_key_created ON agent_audit(key_id, created_at);

