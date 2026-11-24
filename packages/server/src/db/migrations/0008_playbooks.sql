-- Playbooks: the task list a team runs at the start of every hunt, kept in the same CSV format
-- that import and export use. Starting a run from one copies its workflow (or the default) and
-- imports its rows. Edits bump `version`; runs remember which playbook they came from.
CREATE TABLE playbooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Empty for a playbook every team can use; only admins keep those.
  team_id TEXT NOT NULL DEFAULT '',
  csv TEXT NOT NULL,
  -- JSON list of workflow statuses, or NULL to use the default workflow.
  statuses TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX playbooks_team ON playbooks(team_id);
