-- In-app notifications, each person's preferences, due-date reminders, and outgoing webhooks
-- (Rocket.Chat incoming format) with a delivery queue.

-- One row per person per thing to tell them. Changes to one task within a couple of minutes
-- update the same unread row (same group_key) instead of adding another; a bulk change is one
-- row listing every task. Task text is never stored here: it is read from the task state when
-- the notification is shown, so a task that later becomes hidden says nothing.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The most important of `kinds`, which titles the notification.
  kind TEXT NOT NULL,
  kinds TEXT NOT NULL,
  task_ids TEXT NOT NULL,
  actor_ids TEXT NOT NULL,
  comment_ids TEXT NOT NULL DEFAULT '[]',
  group_key TEXT NOT NULL,
  -- How many changes were folded into this row.
  count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, updated_at);
CREATE INDEX notifications_group ON notifications(user_id, group_key, read_at);

CREATE TABLE notification_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Reminders already sent. Keyed by the due date too, so moving a due date arms them again.
CREATE TABLE task_reminders (
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  due_at TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (task_id, kind, due_at)
);

-- Empty team_id: a global webhook (admins). Otherwise it hears about that team's tasks and
-- is managed by its leads. The URL is a secret and is never sent back in full.
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX webhooks_team ON webhooks(team_id);

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  -- pending | ok | failed
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_status INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at);
