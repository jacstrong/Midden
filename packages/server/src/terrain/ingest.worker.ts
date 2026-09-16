/**
 * Worker thread: parses an uploaded scan into terrain rows with its own SQLite connection, so
 * a 300 MB -sV import never blocks the main thread's WebSocket traffic.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../db/db.js';
import { TerrainInserter, failScan, finishScan } from './insert.js';
import { parseInto } from './parse.js';

interface Job {
  dbPath: string;
  scanId: string;
  filePath: string;
  fmt: 'xml' | 'text';
  bits: number;
}

const job = workerData as Job;
const db = openDatabase(job.dbPath);
const ins = new TerrainInserter(db, job.scanId, job.bits);

parseInto(job.filePath, job.fmt, ins, (n) => parentPort?.postMessage({ t: 'progress', hosts: n }))
  .then((meta) => {
    finishScan(db, job.scanId, meta, ins.inserted);
    parentPort?.postMessage({ t: 'done', hosts: ins.inserted });
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    failScan(db, job.scanId, message);
    parentPort?.postMessage({ t: 'failed', message });
  })
  .finally(() => db.close());
