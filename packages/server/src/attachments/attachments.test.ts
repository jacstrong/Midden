import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sniffMime, safeFilename } from './mime.js';
import { addUser, as, login, testAppWith } from '../test/helpers.js';

function multipart(
  fields: Record<string, string>,
  file: { name: string; content: Buffer | string; mime?: string },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----midden' + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime ?? 'application/octet-stream'}\r\n\r\n`,
    ),
  );
  parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

describe('sniffMime', () => {
  it('recognises the formats analysts actually attach', () => {
    expect(sniffMime(PNG)).toEqual({ mime: 'image/png', inlineImage: true });
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toMatchObject({
      mime: 'image/jpeg',
      inlineImage: true,
    });
    expect(sniffMime(Buffer.from('GIF89a'))).toMatchObject({ mime: 'image/gif' });
    expect(
      sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])),
    ).toMatchObject({ mime: 'image/webp' });
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toEqual({
      mime: 'application/pdf',
      inlineImage: false,
    });
    expect(sniffMime(Buffer.from([0xd4, 0xc3, 0xb2, 0xa1]))).toMatchObject({
      mime: 'application/vnd.tcpdump.pcap',
    });
    expect(sniffMime(Buffer.from('2026-07-14 13:02:41 login failed\n'))).toEqual({
      mime: 'text/plain',
      inlineImage: false,
    });
  });

  it('never marks markup or binaries as inline images', () => {
    expect(sniffMime(Buffer.from('<html><script>alert(1)</script>'))).toEqual({
      mime: 'text/plain',
      inlineImage: false,
    });
    expect(sniffMime(Buffer.from('<svg onload="alert(1)"/>'))).toEqual({
      mime: 'text/plain',
      inlineImage: false,
    });
    expect(sniffMime(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toEqual({
      mime: 'application/octet-stream',
      inlineImage: false,
    });
  });

  it('sanitises filenames for the download header', () => {
    expect(safeFilename('screenshot.png')).toBe('screenshot.png');
    // separators become underscores and leading dots are dropped, so no hidden or traversing names
    expect(safeFilename('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFilename('evil"; rm -rf /.txt')).toBe('evil_ rm -rf _.txt');
    expect(safeFilename('')).toBe('attachment');
  });
});

describe('attachment routes', () => {
  let app: FastifyInstance;
  let ann: string;
  let vic: string;
  let caseId: string;
  let eventId: string;

  beforeEach(async () => {
    app = testAppWith({
      MIDDEN_BLOB_DIR: mkdtempSync(join(tmpdir(), 'midden-att-')),
      MIDDEN_MAX_UPLOAD_MB: '1',
      MIDDEN_CASE_QUOTA_MB: '1',
    });
    addUser(app, 'ann');
    addUser(app, 'vic', 'viewer');
    await app.ready();
    ann = await login(app, 'ann');
    vic = await login(app, 'vic');
    caseId = (
      await app.inject({
        method: 'POST',
        url: '/api/cases',
        ...as(ann),
        payload: { name: 'Evidence' },
      })
    ).json().case.id as string;
    eventId = 'ev_1';
    await app.inject({
      method: 'POST',
      url: `/api/cases/${caseId}/ops`,
      ...as(ann),
      payload: {
        op: {
          type: 'event.add',
          event: { id: eventId, ts: '2026-07-14T13:00:00.000Z', activity: 'LSASS dumped' },
        },
      },
    });
  });
  afterEach(async () => {
    await app.close();
  });

  const upload = async (
    cookie: string,
    file: { name: string; content: Buffer | string },
    fields: Record<string, string> = { targetKind: 'event', targetId: 'ev_1' },
  ) => {
    const mp = multipart(fields, file);
    return app.inject({
      method: 'POST',
      url: `/api/cases/${caseId}/attachments`,
      ...as(cookie, { headers: mp.headers }),
      payload: mp.payload,
    });
  };

  it('attaches a screenshot, records it in case state, serves it inline, and removes it', async () => {
    const res = await upload(ann, { name: 'lsass.png', content: PNG });
    expect(res.statusCode).toBe(201);
    const att = res.json().attachment;
    expect(att).toMatchObject({
      mime: 'image/png',
      name: 'lsass.png',
      size: PNG.length,
      target: { kind: 'event', id: eventId },
    });

    const state = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/state`,
      ...as(vic),
    });
    expect(state.json().state.attachments[att.id]).toMatchObject({ name: 'lsass.png' });
    const list = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/attachments`,
      ...as(vic),
    });
    expect(list.json().attachments).toHaveLength(1);

    const dl = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/attachments/${att.id}`,
      ...as(vic),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('image/png');
    expect(dl.headers['content-disposition']).toBe('inline; filename="lsass.png"');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.rawPayload.length).toBe(PNG.length);

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/cases/${caseId}/attachments/${att.id}`,
          ...as(vic),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/cases/${caseId}/attachments/${att.id}`,
          ...as(ann),
        })
      ).statusCode,
    ).toBe(200);
    expect(app.db.get('SELECT COUNT(*) AS n FROM blobs')).toEqual({ n: 0 });
    const after = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/state`,
      ...as(ann),
    });
    expect(after.json().state.attachments).toEqual({});
  });

  it('forces anything that is not a recognised image to download', async () => {
    const res = await upload(ann, {
      name: 'evidence.png',
      content: '<html><script>alert(document.cookie)</script></html>',
    });
    const att = res.json().attachment;
    expect(att.mime).toBe('text/plain');
    const dl = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/attachments/${att.id}`,
      ...as(ann),
    });
    expect(dl.headers['content-type']).toContain('text/plain');
    expect(dl.headers['content-disposition']).toBe('attachment; filename="evidence.png"');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
  });

  it('rejects viewers, unknown targets, empty files, and enforces the case quota', async () => {
    expect((await upload(vic, { name: 'a.png', content: PNG })).statusCode).toBe(403);
    expect(
      (
        await upload(
          ann,
          { name: 'a.png', content: PNG },
          { targetKind: 'event', targetId: 'nope' },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await upload(
          ann,
          { name: 'a.png', content: PNG },
          { targetKind: 'planet', targetId: 'ev_1' },
        )
      ).statusCode,
    ).toBe(400);
    expect((await upload(ann, { name: 'empty.png', content: '' })).statusCode).toBe(400);

    // 1 MB per-file cap
    const big = await upload(ann, { name: 'big.bin', content: Buffer.alloc(1_100_000, 1) });
    expect(big.statusCode).toBe(413);

    // 1 MB case quota: two 600 KB files do not both fit
    expect(
      (await upload(ann, { name: 'one.bin', content: Buffer.alloc(600_000, 2) })).statusCode,
    ).toBe(201);
    const second = await upload(ann, { name: 'two.bin', content: Buffer.alloc(600_000, 3) });
    expect(second.statusCode).toBe(413);
    expect(second.json().error.code).toBe('quota');
    expect(app.db.get('SELECT COUNT(*) AS n FROM attachments WHERE deleted_at IS NULL')).toEqual({
      n: 1,
    });
  });

  it('shares one blob between identical attachments and keeps it until both are gone', async () => {
    const a = await upload(ann, { name: 'same.png', content: PNG });
    const b = await upload(ann, { name: 'copy.png', content: PNG });
    expect(app.db.get('SELECT refcount FROM blobs')).toEqual({ refcount: 2 });
    await app.inject({
      method: 'DELETE',
      url: `/api/cases/${caseId}/attachments/${a.json().attachment.id}`,
      ...as(ann),
    });
    expect(app.db.get('SELECT refcount FROM blobs')).toEqual({ refcount: 1 });
    const stillThere = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/attachments/${b.json().attachment.id}`,
      ...as(ann),
    });
    expect(stillThere.statusCode).toBe(200);
  });
});
