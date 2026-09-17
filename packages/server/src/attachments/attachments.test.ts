import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dangerReason, sniffMime, safeFilename } from './mime.js';
import { INFECTED_PASSWORD } from './zip.js';
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

describe('dangerReason', () => {
  it('recognises executables, scripts, shortcuts and macro carriers by their bytes', () => {
    expect(dangerReason(Buffer.from('MZ\x90\x00', 'latin1'), 'update.bin')).toMatch(/PE/);
    expect(dangerReason(Buffer.from('\x7fELF', 'latin1'), 'a.out')).toMatch(/ELF/);
    expect(dangerReason(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), 'agent')).toMatch(/Mach-O/);
    expect(dangerReason(Buffer.from([0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0]), 'invoice.pdf')).toMatch(
      /shortcut/,
    );
    expect(
      dangerReason(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'q3.doc'),
    ).toMatch(/OLE/);
    expect(dangerReason(Buffer.from('#!/bin/sh\nrm -rf /'), 'notes.txt')).toMatch(/shebang/);
    expect(dangerReason(Buffer.from('<!DOCTYPE html><script>'), 'page.png')).toMatch(/markup/);
  });

  it('falls back to the extension, and leaves ordinary evidence alone', () => {
    expect(dangerReason(Buffer.from('plain text'), 'stage2.ps1')).toMatch(/script \(\.ps1\)/);
    expect(dangerReason(Buffer.from('PK\x03\x04', 'latin1'), 'macro.docm')).toMatch(/macro/);
    expect(dangerReason(PNG, 'lsass.png')).toBeNull();
    expect(dangerReason(Buffer.from('2026-07-14 login failed\n'), 'auth.log')).toBeNull();
    expect(dangerReason(Buffer.from('%PDF-1.7'), 'report.pdf')).toBeNull();
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
      content: '2026-07-14 13:02:41 4624 CORP\\j.reyes logon type 10 from 10.20.9.10\n',
    });
    const att = res.json().attachment;
    expect(att.mime).toBe('text/plain');
    expect(att.dangerous).toBe(false);
    const dl = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/attachments/${att.id}`,
      ...as(ann),
    });
    expect(dl.headers['content-type']).toContain('text/plain');
    expect(dl.headers['content-disposition']).toBe('attachment; filename="evidence.png"');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
  });

  it('treats markup disguised as an image as dangerous, not merely non-inline', async () => {
    const res = await upload(ann, {
      name: 'evidence.png',
      content: '<html><script>alert(document.cookie)</script></html>',
    });
    expect(res.json().dangerReason).toMatch(/markup/);
    const dl = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/attachments/${res.json().attachment.id}`,
      ...as(ann),
    });
    expect(dl.headers['content-type']).toContain('application/zip');
    expect(dl.headers['content-disposition']).toBe('attachment; filename="evidence.png.zip"');
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

  const EXE = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00', 'latin1'), Buffer.alloc(300, 0xcc)]);

  const unzipAvailable = (() => {
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it('flags an executable on sight, keeps the sample bytes, and serves it wrapped', async () => {
    const res = await upload(ann, { name: 'dropper.exe', content: EXE });
    expect(res.statusCode).toBe(201);
    expect(res.json().dangerReason).toMatch(/PE/);
    const att = res.json().attachment;
    expect(att.dangerous).toBe(true);

    // the flag travels with the case state, so every client sees it
    const state = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/state`,
      ...as(vic),
    });
    expect(state.json().state.attachments[att.id].dangerous).toBe(true);

    // what is stored is the sample itself: the hashes an analyst records are the sample's hashes
    const { createHash } = await import('node:crypto');
    expect(att.sha256).toBe(createHash('sha256').update(EXE).digest('hex'));
    expect(att.md5).toBe(createHash('md5').update(EXE).digest('hex'));

    const dl = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/attachments/${att.id}`,
      ...as(vic),
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('application/zip');
    expect(dl.headers['content-disposition']).toBe('attachment; filename="dropper.exe.zip"');
    expect(dl.headers['x-midden-dangerous']).toBe('1');
    expect(Number(dl.headers['content-length'])).toBe(dl.rawPayload.length);
    // the sample never leaves in the clear
    expect(dl.rawPayload.indexOf(EXE.subarray(0, 16))).toBe(-1);

    if (unzipAvailable) {
      const file = join(mkdtempSync(join(tmpdir(), 'midden-dl-')), 'dropper.exe.zip');
      writeFileSync(file, dl.rawPayload);
      const out = execFileSync('unzip', ['-P', INFECTED_PASSWORD, '-p', file]);
      expect(Buffer.compare(out, EXE)).toBe(0);
    }
  });

  it('lets the uploader flag a file the sniffer would have trusted, and never renders it inline', async () => {
    const res = await upload(
      ann,
      { name: 'lure.png', content: PNG },
      {
        targetKind: 'event',
        targetId: 'ev_1',
        dangerous: '1',
      },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().dangerReason).toBeNull();
    const att = res.json().attachment;
    expect(att.dangerous).toBe(true);
    const dl = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/attachments/${att.id}`,
      ...as(ann),
    });
    expect(dl.headers['content-type']).toContain('application/zip');
    expect(dl.headers['content-disposition']).toBe('attachment; filename="lure.png.zip"');
  });

  it('keeps a custody record: uploader name, note on upload, and a note edited through the op log', async () => {
    const res = await upload(
      ann,
      { name: 'auth.log', content: 'login failed\n' },
      {
        targetKind: 'event',
        targetId: 'ev_1',
        note: 'Pulled from the DC at 14:02, sha verified on host',
      },
    );
    expect(res.statusCode).toBe(201);
    const att = res.json().attachment;
    expect(att).toMatchObject({
      uploadedBy: expect.any(String),
      uploadedByName: 'ANN',
      note: 'Pulled from the DC at 14:02, sha verified on host',
      dangerous: false,
    });
    expect(att.md5).toMatch(/^[0-9a-f]{32}$/);

    // the note is the one editable field, and it edits like everything else: an op
    const set = await app.inject({
      method: 'POST',
      url: `/api/cases/${caseId}/ops`,
      ...as(ann),
      payload: {
        op: { type: 'attachment.set', id: att.id, patch: { note: 'Re-checked: benign' } },
      },
    });
    expect(set.statusCode).toBe(200);
    const state = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/state`,
      ...as(vic),
    });
    expect(state.json().state.attachments[att.id].note).toBe('Re-checked: benign');
    // and the projected row, which the REST list reads, followed it
    const list = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/attachments`,
      ...as(vic),
    });
    expect(list.json().attachments.find((a: { id: string }) => a.id === att.id).note).toBe(
      'Re-checked: benign',
    );

    // viewers cannot edit the note, and the note is the only thing anyone can patch: other keys
    // are dropped before the op is applied, the same as every patch schema in core
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/cases/${caseId}/ops`,
          ...as(vic),
          payload: { op: { type: 'attachment.set', id: att.id, patch: { note: 'x' } } },
        })
      ).statusCode,
    ).toBe(403);
    await app.inject({
      method: 'POST',
      url: `/api/cases/${caseId}/ops`,
      ...as(ann),
      payload: {
        op: { type: 'attachment.set', id: att.id, patch: { note: 'y', dangerous: true, md5: '0' } },
      },
    });
    const after = (
      await app.inject({ method: 'GET', url: `/api/cases/${caseId}/state`, ...as(ann) })
    ).json().state.attachments[att.id];
    expect(after.note).toBe('y');
    expect(after.dangerous).toBe(false);
    expect(after.md5).toBe(att.md5);
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
