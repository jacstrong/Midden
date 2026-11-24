-- Saved task views (a filter, layout, grouping and the fields a card shows). Personal when
-- team_id is NULL; shared with a team otherwise, which its leads and admins manage.
CREATE TABLE task_views (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX task_views_owner ON task_views(owner_id);
CREATE INDEX task_views_team ON task_views(team_id);
