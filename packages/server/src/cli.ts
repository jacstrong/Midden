import { join } from 'node:path';
import type { Config } from './config.js';
import { openDatabase } from './db/db.js';
import { migrate } from './db/migrate.js';
import { backupDatabase } from './db/backup.js';
import { rebuildCase } from './cases/projection.js';
import { hashPassword } from './auth/password.js';
import { createUser, findUserByUsername } from './auth/sessions.js';

const USAGE = `midden <command>
  serve                      start the server (default)
  rebuild <caseId|all>       replay the op log into fresh projection tables
  backup <path>              write a consistent copy of the database
  create-user <name> <pass> [admin|analyst|viewer]
  reset-password <name> <pass>`;

export async function runCli(cfg: Config, cmd: string, args: string[]): Promise<number> {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return 0;
  }
  const db = openDatabase(join(cfg.dataDir, 'midden.db'));
  migrate(db);
  try {
    switch (cmd) {
      case 'rebuild': {
        const target = args[0];
        if (!target) throw new Error('rebuild needs a case id or "all"');
        const ids =
          target === 'all'
            ? db.all<{ id: string }>('SELECT id FROM cases').map((r) => r.id)
            : [target];
        for (const id of ids) {
          const s = rebuildCase(db, id);
          console.log(
            `${id}: ${Object.keys(s.hosts).length} hosts, ${Object.keys(s.events).length} events`,
          );
        }
        return 0;
      }
      case 'backup': {
        const dest = args[0];
        if (!dest) throw new Error('backup needs a destination path');
        await backupDatabase(db, dest);
        console.log(`backup written to ${dest}`);
        return 0;
      }
      case 'create-user': {
        const [name, pass, role = 'analyst'] = args;
        if (!name || !pass) throw new Error('create-user needs <name> <pass>');
        if (!['admin', 'analyst', 'viewer'].includes(role))
          throw new Error('role must be admin, analyst or viewer');
        if (findUserByUsername(db, name)) throw new Error(`user ${name} already exists`);
        const u = createUser(db, {
          username: name,
          displayName: name,
          role: role as 'admin' | 'analyst' | 'viewer',
          passwordHash: hashPassword(pass),
        });
        console.log(`created ${u.username} (${u.role})`);
        return 0;
      }
      case 'reset-password': {
        const [name, pass] = args;
        if (!name || !pass) throw new Error('reset-password needs <name> <pass>');
        const u = findUserByUsername(db, name);
        if (!u) throw new Error(`no such user ${name}`);
        db.run(
          'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?',
          hashPassword(pass),
          u.id,
        );
        db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
        console.log(`password reset for ${name}; existing sessions revoked`);
        return 0;
      }
      default:
        console.error(`unknown command "${cmd}"\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    db.close();
  }
}
