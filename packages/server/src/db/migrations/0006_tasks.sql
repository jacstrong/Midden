-- Task management. Tasks live outside cases in one global op log (task_ops); the tables below
-- the log are projections of it, kept for listing, history lookups and insights.

-- Teams (e.g. host and network analyst cells). A user may be on several; leads import
-- playbooks and bulk-assign within the teams they lead.
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('lead', 'member')),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members(user_id);

-- The log. One row holds its sequence number so appends can take it with UPDATE ... RETURNING.
CREATE TABLE task_log (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO task_log (id, seq) VALUES (1, 0);

CREATE TABLE task_ops (
  seq INTEGER PRIMARY KEY,
  actor_id TEXT NOT NULL,
  via TEXT,
  ts TEXT NOT NULL,
  client_op_id TEXT UNIQUE,
  base_seq INTEGER,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  inverse TEXT
);

-- Which tasks each op touched, so a task's history is one indexed lookup.
CREATE TABLE task_op_tasks (
  seq INTEGER NOT NULL REFERENCES task_ops(seq) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);

CREATE TABLE task_snapshots (
  seq INTEGER PRIMARY KEY,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Projections.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  num INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status_id TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  run_id TEXT NOT NULL DEFAULT '',
  team_id TEXT NOT NULL DEFAULT '',
  case_id TEXT NOT NULL DEFAULT '',
  due_at TEXT NOT NULL DEFAULT '',
  approver_id TEXT NOT NULL DEFAULT '',
  approval_state TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_at TEXT NOT NULL,
  done_at TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL
);
CREATE INDEX tasks_run ON tasks(run_id);
CREATE INDEX tasks_team ON tasks(team_id, category);
CREATE INDEX tasks_case ON tasks(case_id);
CREATE INDEX tasks_category ON tasks(category, archived);

CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_assignees_user ON task_assignees(user_id);

CREATE TABLE task_followers (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX task_followers_user ON task_followers(user_id);

CREATE TABLE task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_by_id TEXT NOT NULL,
  PRIMARY KEY (task_id, blocked_by_id)
);

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX task_comments_task ON task_comments(task_id, created_at);

-- Every change of status, for cycle time, aging and burndown. Category is as of the change.
CREATE TABLE task_transitions (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  from_status TEXT NOT NULL DEFAULT '',
  to_status TEXT NOT NULL,
  from_category TEXT NOT NULL DEFAULT '',
  to_category TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX task_transitions_task ON task_transitions(task_id, at);
CREATE INDEX task_transitions_at ON task_transitions(at);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  team_id TEXT NOT NULL DEFAULT '',
  playbook_id TEXT NOT NULL DEFAULT '',
  workflow_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
