/**
 * Each person's notification preferences, laid over the defaults. Read on every task commit
 * (for auto-follow and recipients), so they are cached; saving one replaces its cache entry.
 */
import {
  DEFAULT_NOTIFY_PREFS,
  mergeNotifyPrefs,
  type NotifyPrefs,
  type NotifyPrefsPatch,
} from '@midden/core';
import type { Db } from '../db/db.js';
import { nowIso } from '../lib/ids.js';

export class NotifyPrefsStore {
  private readonly cache = new Map<string, NotifyPrefs>();

  constructor(private readonly db: Db) {}

  get(userId: string): NotifyPrefs {
    let p = this.cache.get(userId);
    if (!p) {
      const row = this.db.get<{ prefs: string }>(
        'SELECT prefs FROM notification_prefs WHERE user_id = ?',
        userId,
      );
      p = row ? mergeNotifyPrefs(DEFAULT_NOTIFY_PREFS, safeJson(row.prefs)) : DEFAULT_NOTIFY_PREFS;
      this.cache.set(userId, p);
    }
    return p;
  }

  /** Apply a validated patch and store the whole result. */
  update(userId: string, patch: NotifyPrefsPatch): NotifyPrefs {
    const next = mergeNotifyPrefs(this.get(userId), patch);
    this.db.run(
      'INSERT INTO notification_prefs (user_id, prefs, updated_at) VALUES (?,?,?) ON CONFLICT DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at',
      userId,
      JSON.stringify(next),
      nowIso(),
    );
    this.cache.set(userId, next);
    return next;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
