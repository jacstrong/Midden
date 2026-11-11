-- Tasks themselves live in the operation log with the rest of a case. These tables hold what is
-- personal rather than part of the case: who follows which task, and what each person has been
-- told. Neither is exported with a case or reverted with its history.
CREATE TABLE task_follows (
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, task_id, user_id)
);
CREATE INDEX task_follows_user ON task_follows(user_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  task_id TEXT,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);
CREATE INDEX notifications_unread ON notifications(user_id) WHERE read_at IS NULL;
