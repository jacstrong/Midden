import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import type { ScanFormat } from '@midden/core';
import { TerrainInserter, failScan, finishScan } from './insert.js';
import { parseInto } from './parse.js';

export interface IngestResult {
  ok: boolean;
  hosts: number;
  error?: string | undefined;
}

/**
 * Parse `filePath` into terrain rows for `scanId`. Uses a worker thread when the database is a
 * real file (WAL allows the concurrent writer); runs inline for in-memory databases (tests).
 */
export function ingestScan(
  app: FastifyInstance,
  scanId: string,
  filePath: string,
  fmt: ScanFormat,
  onProgress: (hosts: number) => void,
): Promise<IngestResult> {
  const dbPath = app.db.path;
  if (dbPath === ':memory:' || dbPath === '')
    return ingestInline(app, scanId, filePath, fmt, onProgress);
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./ingest.worker.js', import.meta.url), {
      workerData: { dbPath, scanId, filePath, fmt, bits: 24 },
    });
    let settled = false;
    worker.on('message', (m: { t: string; hosts?: number; message?: string }) => {
      if (m.t === 'progress') onProgress(m.hosts ?? 0);
      else if (m.t === 'done') {
        settled = true;
        resolve({ ok: true, hosts: m.hosts ?? 0 });
      } else if (m.t === 'failed') {
        settled = true;
        resolve({ ok: false, hosts: 0, error: m.message });
      }
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      failScan(app.db, scanId, err.message);
      resolve({ ok: false, hosts: 0, error: err.message });
    });
    worker.on('exit', (code) => {
      if (settled) return;
      settled = true;
      const error = `ingest worker exited with code ${code}`;
      failScan(app.db, scanId, error);
      resolve({ ok: false, hosts: 0, error });
    });
  });
}

async function ingestInline(
  app: FastifyInstance,
  scanId: string,
  filePath: string,
  fmt: ScanFormat,
  onProgress: (hosts: number) => void,
): Promise<IngestResult> {
  const ins = new TerrainInserter(app.db, scanId, 24);
  try {
    const meta = await parseInto(filePath, fmt, ins, onProgress);
    finishScan(app.db, scanId, meta, ins.inserted);
    return { ok: true, hosts: ins.inserted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failScan(app.db, scanId, message);
    return { ok: false, hosts: 0, error: message };
  }
}
