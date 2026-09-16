import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(): Migration[] {
  const dir = fileURLToPath(MIGRATIONS_DIR);
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({
      version: Number(f.slice(0, 4)),
      name: f,
      sql: readFileSync(join(dir, f), 'utf8'),
    }));
}

/** Apply pending migrations under PRAGMA user_version, each in its own transaction. */
export function migrate(db: Db, migrations: Migration[] = loadMigrations()): number[] {
  const applied: number[] = [];
  for (const m of migrations) {
    const current = schemaVersion(db);
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
    applied.push(m.version);
  }
  return applied;
}

export function schemaVersion(db: Db): number {
  return Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
}
