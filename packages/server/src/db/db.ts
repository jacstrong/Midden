/**
 * The only module that touches `node:sqlite`. Everything else goes through this
 * wrapper so that swapping the driver (e.g. to better-sqlite3 prebuilds) is a
 * one-file change if the built-in API shifts while it is still "active development".
 */
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

export type Row = Record<string, SQLOutputValue>;
export type Params = SQLInputValue[];

export interface Db {
  readonly path: string;
  run(
    sql: string,
    ...params: Params
  ): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T extends object = Row>(sql: string, ...params: Params): T | undefined;
  all<T extends object = Row>(sql: string, ...params: Params): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
  /** Escape hatch for streaming or driver-specific features (backup, iterate). */
  readonly raw: DatabaseSync;
}

export function openDatabase(path: string): Db {
  const raw = new DatabaseSync(path);
  const inMemory = path === ':memory:' || path === '';
  if (!inMemory) {
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
  }
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');

  const db: Db = {
    path,
    raw,
    run(sql, ...params) {
      return raw.prepare(sql).run(...params);
    },
    get<T extends object>(sql: string, ...params: Params) {
      return raw.prepare(sql).get(...params) as T | undefined;
    },
    all<T extends object>(sql: string, ...params: Params) {
      return raw.prepare(sql).all(...params) as T[];
    },
    exec(sql) {
      raw.exec(sql);
    },
    transaction<T>(fn: () => T): T {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    close() {
      raw.close();
    },
  };
  return db;
}

export function sqliteVersion(db: Db): string {
  const row = db.get<{ v: string }>('SELECT sqlite_version() AS v');
  return row?.v ?? 'unknown';
}
