import { describe, expect, it } from 'vitest';
import { openDatabase, sqliteVersion } from './db.js';

describe('db wrapper', () => {
  it('opens an in-memory database and reports the SQLite version', () => {
    const db = openDatabase(':memory:');
    expect(sqliteVersion(db)).toMatch(/^3\.\d+/);
    db.close();
  });

  it('commits and rolls back transactions', () => {
    const db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.transaction(() => {
      db.run('INSERT INTO t (v) VALUES (?)', 'a');
    });
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (v) VALUES (?)', 'b');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.all('SELECT v FROM t ORDER BY id')).toEqual([{ v: 'a' }]);
    db.close();
  });
});
