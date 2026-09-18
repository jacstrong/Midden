/**
 * Content-addressed blob store under <data>/blobs/<aa>/<sha256>. Reference counts live in the
 * `blobs` table so a file shared by two uploads is stored once and removed when both go.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { Db } from '../db/db.js';
import { nowIso } from '../lib/ids.js';

export class BlobStore {
  constructor(
    private readonly db: Db,
    readonly root: string,
  ) {}

  pathFor(sha256: string): string {
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  /** Stream an upload to a temp file while hashing, then move it into place. Increments the refcount. */
  async putStream(
    input: Readable,
    opts: { maxBytes?: number | undefined } = {},
  ): Promise<{ sha256: string; md5: string; size: number; path: string; tmpPath: string }> {
    await mkdir(join(this.root, 'tmp'), { recursive: true });
    const tmpPath = join(
      this.root,
      'tmp',
      `upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const hash = createHash('sha256');
    const md5 = createHash('md5'); // not for identity, only so the record carries what threat intel keys on
    let size = 0;
    const limit = opts.maxBytes ?? Number.POSITIVE_INFINITY;
    const out = createWriteStream(tmpPath);
    try {
      await pipeline(
        input,
        async function* (source) {
          for await (const chunk of source as AsyncIterable<Buffer>) {
            size += chunk.length;
            if (size > limit) throw new TooLargeError(limit);
            hash.update(chunk);
            md5.update(chunk);
            yield chunk;
          }
        },
        out,
      );
    } catch (err) {
      await rm(tmpPath, { force: true });
      throw err;
    }
    const sha256 = hash.digest('hex');
    const path = this.pathFor(sha256);
    await mkdir(dirname(path), { recursive: true });
    if (!existsSync(path)) await rename(tmpPath, path);
    else await rm(tmpPath, { force: true });
    this.db.run(
      'INSERT INTO blobs (sha256, size, refcount, created_at) VALUES (?,?,1,?) ON CONFLICT(sha256) DO UPDATE SET refcount = refcount + 1',
      sha256,
      size,
      nowIso(),
    );
    return { sha256, md5: md5.digest('hex'), size, path, tmpPath };
  }

  addRef(sha256: string): void {
    this.db.run('UPDATE blobs SET refcount = refcount + 1 WHERE sha256 = ?', sha256);
  }

  /** Decrement and delete the file when nothing references it any more. */
  async release(sha256: string): Promise<void> {
    const row = this.db.get<{ refcount: number }>(
      'SELECT refcount FROM blobs WHERE sha256 = ?',
      sha256,
    );
    if (!row) return;
    if (Number(row.refcount) <= 1) {
      this.db.run('DELETE FROM blobs WHERE sha256 = ?', sha256);
      await rm(this.pathFor(sha256), { force: true });
    } else {
      this.db.run('UPDATE blobs SET refcount = refcount - 1 WHERE sha256 = ?', sha256);
    }
  }

  open(sha256: string): Readable {
    return createReadStream(this.pathFor(sha256));
  }

  async size(sha256: string): Promise<number> {
    return (await stat(this.pathFor(sha256))).size;
  }

  /** Remove blobs no row references (after a crash between steps). */
  async gc(): Promise<number> {
    const orphans = this.db.all<{ sha256: string }>('SELECT sha256 FROM blobs WHERE refcount <= 0');
    for (const o of orphans) {
      this.db.run('DELETE FROM blobs WHERE sha256 = ?', o.sha256);
      await rm(this.pathFor(o.sha256), { force: true });
    }
    return orphans.length;
  }
}

export class TooLargeError extends Error {
  constructor(limit: number) {
    super(`Upload exceeds the ${Math.round(limit / 1_048_576)} MB limit`);
    this.name = 'TooLargeError';
  }
}
