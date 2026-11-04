-- API tokens let scripts and agents act for a user without a browser session. Only the SHA-256 of
-- a token is stored. `via` on an op records which token made it, by name as it was at the time,
-- so the history can tell an analyst's edit from one made by their agent.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

ALTER TABLE ops ADD COLUMN via TEXT;
