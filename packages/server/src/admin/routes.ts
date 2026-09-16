import { createReadStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../app.js';
import { backupDatabase } from '../db/backup.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /** Consistent online copy of the database, streamed as a download. */
  app.get('/api/admin/backup', async (req, reply) => {
    requireAdmin(req);
    const dir = join(app.cfg.dataDir, 'tmp');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `backup-${Date.now()}.db`);
    await backupDatabase(app.db, path);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    reply
      .header('content-disposition', `attachment; filename="midden-backup-${stamp}.db"`)
      .type('application/vnd.sqlite3');
    const stream = createReadStream(path);
    stream.on('close', () => void rm(path, { force: true }));
    return reply.send(stream);
  });

  app.get('/api/admin/stats', async (req) => {
    requireAdmin(req);
    const n = (sql: string): number => Number(app.db.get<{ n: number }>(sql)?.n ?? 0);
    return {
      users: n('SELECT COUNT(*) AS n FROM users'),
      cases: n('SELECT COUNT(*) AS n FROM cases'),
      ops: n('SELECT COUNT(*) AS n FROM ops'),
      events: n('SELECT COUNT(*) AS n FROM events WHERE deleted_at IS NULL'),
      sessions: n('SELECT COUNT(*) AS n FROM sessions'),
    };
  });
}
