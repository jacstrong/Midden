-- Midden schema v1. Case state is op-logged; hosts/events are a projection (data = full JSON).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'analyst', 'viewer')),
  oidc_sub TEXT UNIQUE,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT,
  ua TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE login_failures (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  number TEXT NOT NULL DEFAULT '',
  analyst TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  archived_at TEXT,
  created_by TEXT,
  restricted INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE case_members (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (case_id, user_id)
);

CREATE TABLE ops (
  id INTEGER PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  client_op_id TEXT,
  base_seq INTEGER,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  inverse TEXT,
  UNIQUE (case_id, seq)
);
CREATE UNIQUE INDEX ops_client ON ops(case_id, client_op_id) WHERE client_op_id IS NOT NULL;

CREATE TABLE case_snapshots (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, seq)
);

CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX hosts_case ON hosts(case_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  host_id TEXT NOT NULL,
  indicator TEXT NOT NULL,
  data TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX events_case_ts ON events(case_id, ts);
CREATE INDEX events_case_indicator ON events(case_id, indicator);

-- Derived from hosts.ip plus manual link.set ops; used to overlay case status on terrain.
CREATE TABLE case_host_ips (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  ip TEXT NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (case_id, host_id, ip)
);
CREATE INDEX case_host_ips_ip ON case_host_ips(case_id, ip);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
