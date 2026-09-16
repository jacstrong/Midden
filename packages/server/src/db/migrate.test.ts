import { describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { loadMigrations, migrate, schemaVersion } from './migrate.js';

describe('migrations', () => {
  it('applies in order, once, and records user_version', () => {
    const db = openDatabase(':memory:');
    const applied = migrate(db);
    expect(applied.length).toBeGreaterThan(0);
    expect(schemaVersion(db)).toBe(loadMigrations().at(-1)!.version);
    expect(migrate(db)).toEqual([]);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'users',
        'sessions',
        'cases',
        'ops',
        'hosts',
        'events',
        'case_host_ips',
      ]),
    );
    db.close();
  });
});
