-- Terrain: immutable per-scan rows bulk-loaded by the upload path (never through the op log),
-- plus the content-addressed blob table shared by scan uploads and evidence attachments.
CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  refcount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE scans (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('discovery', 'service', 'other')),
  fmt TEXT NOT NULL CHECK (fmt IN ('xml', 'text')),
  nmap_args TEXT NOT NULL DEFAULT '',
  nmap_version TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  elapsed_s REAL,
  hosts_up INTEGER NOT NULL DEFAULT 0,
  hosts_down INTEGER NOT NULL DEFAULT 0,
  hosts_total INTEGER NOT NULL DEFAULT 0,
  raw_sha256 TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('parsing', 'ready', 'failed')),
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX scans_case ON scans(case_id);

CREATE TABLE scan_hosts (
  id INTEGER PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  ip TEXT NOT NULL,
  ip_sort TEXT NOT NULL,
  net_key TEXT NOT NULL,
  ipv6 TEXT NOT NULL DEFAULT '',
  mac TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  hostnames TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'up',
  reason TEXT NOT NULL DEFAULT '',
  latency TEXT NOT NULL DEFAULT '',
  distance INTEGER,
  uptime TEXT NOT NULL DEFAULT '',
  os_name TEXT NOT NULL DEFAULT '',
  os_accuracy TEXT NOT NULL DEFAULT '',
  os_family TEXT NOT NULL DEFAULT '',
  os_vendor TEXT NOT NULL DEFAULT '',
  os_type TEXT NOT NULL DEFAULT '',
  bucket TEXT NOT NULL DEFAULT 'Unknown',
  role TEXT NOT NULL DEFAULT '',
  flags TEXT NOT NULL DEFAULT '[]',
  open_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (scan_id, ip)
);
CREATE INDEX scan_hosts_sort ON scan_hosts(scan_id, ip_sort);
CREATE INDEX scan_hosts_net ON scan_hosts(scan_id, net_key);
CREATE INDEX scan_hosts_bucket ON scan_hosts(scan_id, bucket);

CREATE TABLE scan_ports (
  scan_host_id INTEGER NOT NULL REFERENCES scan_hosts(id) ON DELETE CASCADE,
  port INTEGER NOT NULL,
  proto TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  extra TEXT NOT NULL DEFAULT '',
  tunnel TEXT NOT NULL DEFAULT '',
  cpe TEXT NOT NULL DEFAULT '[]',
  scripts TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (scan_host_id, proto, port)
);
CREATE INDEX scan_ports_port ON scan_ports(port);

CREATE TABLE scan_hops (
  scan_host_id INTEGER NOT NULL REFERENCES scan_hosts(id) ON DELETE CASCADE,
  ttl INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL DEFAULT '',
  rtt TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (scan_host_id, ttl)
);

CREATE TABLE scan_scripts (
  scan_host_id INTEGER NOT NULL REFERENCES scan_hosts(id) ON DELETE CASCADE,
  script_id TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (scan_host_id, script_id)
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  target_kind TEXT NOT NULL CHECK (target_kind IN ('event', 'host')),
  target_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX attachments_case ON attachments(case_id);
CREATE INDEX attachments_target ON attachments(case_id, target_kind, target_id);
