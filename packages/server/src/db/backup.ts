import type { Db } from './db.js';

/** Online backup to `dest`, using the SQLite backup API when available and VACUUM INTO otherwise. */
export async function backupDatabase(db: Db, dest: string): Promise<void> {
  const raw = db.raw as unknown as { backup?: (path: string) => Promise<unknown> };
  if (typeof raw.backup === 'function') {
    await raw.backup(dest);
    return;
  }
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}
