/**
 * Evidence attachments on events and hosts. Files live in the content-addressed blob store;
 * the case only carries metadata, which travels through the op log like everything else.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AttachmentMeta, Op } from '@midden/core';
import { accessOrThrow } from '../cases/routes.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { TooLargeError } from '../blobs/store.js';
import { dangerReason, safeFilename, sniffMime } from './mime.js';
import { INFECTED_PASSWORD, crc32Of, encryptedZipLength, encryptedZipStream } from './zip.js';

const TargetKind = z.enum(['event', 'host']);

interface AttachmentRow {
  id: string;
  case_id: string;
  sha256: string;
  size: number;
  mime: string;
  name: string;
  target_kind: 'event' | 'host';
  target_id: string;
  uploaded_by: string;
  created_at: string;
  deleted_at: string | null;
  dangerous: number;
  md5: string;
  uploaded_by_name: string;
  note: string;
}

const rowToMeta = (r: AttachmentRow): AttachmentMeta => ({
  id: r.id,
  sha256: r.sha256,
  size: Number(r.size),
  mime: r.mime,
  name: r.name,
  target: { kind: r.target_kind, id: r.target_id },
  uploadedBy: r.uploaded_by,
  uploadedByName: r.uploaded_by_name,
  createdAt: r.created_at,
  md5: r.md5,
  note: r.note,
  dangerous: !!r.dangerous,
});

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/api/cases/:id/attachments', async (req) => {
    accessOrThrow(app, req, req.params.id, 'read');
    const rows = app.db.all<AttachmentRow>(
      'SELECT * FROM attachments WHERE case_id = ? AND deleted_at IS NULL ORDER BY created_at',
      req.params.id,
    );
    return { attachments: rows.map(rowToMeta) };
  });

  app.post<{ Params: { id: string } }>('/api/cases/:id/attachments', async (req, reply) => {
    const { user, access } = accessOrThrow(app, req, req.params.id, 'edit');
    const caseId = req.params.id;
    const maxBytes = app.cfg.maxUploadMb * 1_048_576;
    let stored: { sha256: string; md5: string; size: number; path: string } | null = null;
    let filename = 'evidence';
    let targetKind: string | undefined;
    let targetId: string | undefined;
    let flagged = false;
    let note = '';

    for await (const part of req.parts({ limits: { fileSize: maxBytes, files: 1 } })) {
      if (part.type === 'file') {
        filename = part.filename || filename;
        try {
          stored = await app.blobs.putStream(part.file, { maxBytes });
        } catch (err) {
          if (err instanceof TooLargeError) throw new HttpError(413, err.message, 'too_large');
          throw err;
        }
        if (part.file.truncated) {
          await app.blobs.release(stored.sha256);
          throw new HttpError(
            413,
            `Attachment exceeds the ${app.cfg.maxUploadMb} MB limit`,
            'too_large',
          );
        }
      } else if (part.fieldname === 'targetKind') targetKind = String(part.value);
      else if (part.fieldname === 'targetId') targetId = String(part.value);
      else if (part.fieldname === 'dangerous')
        flagged = /^(1|true|on|yes)$/i.test(String(part.value));
      else if (part.fieldname === 'note') note = String(part.value).slice(0, 4000);
    }

    const fail = async (e: HttpError): Promise<never> => {
      if (stored) await app.blobs.release(stored.sha256);
      throw e;
    };
    if (!stored) throw badRequest('No file uploaded (field "file")');
    if (stored.size === 0) await fail(badRequest('The uploaded file is empty'));
    const kind = TargetKind.safeParse(targetKind);
    if (!kind.success || !targetId)
      await fail(badRequest('targetKind (event|host) and targetId are required'));

    const rt = app.runtimes.get(caseId);
    const exists =
      kind.data === 'event' ? !!rt.state.events[targetId!] : !!rt.state.hosts[targetId!];
    if (!exists) await fail(notFound(`No such ${kind.data} in this case`));

    // Per-case quota keeps one investigation from filling the volume.
    const used = Number(
      app.db.get<{ n: number }>(
        'SELECT COALESCE(SUM(size), 0) AS n FROM attachments WHERE case_id = ? AND deleted_at IS NULL',
        caseId,
      )?.n ?? 0,
    );
    const quota = app.cfg.caseQuotaMb * 1_048_576;
    if (used + stored.size > quota)
      await fail(
        new HttpError(
          413,
          `This case has used its ${app.cfg.caseQuotaMb} MB attachment quota`,
          'quota',
        ),
      );

    const head = await readHead(app, stored.sha256);
    const { mime } = sniffMime(head);
    // The uploader's word or the bytes themselves; either is enough to wrap every download.
    const reason = dangerReason(head, filename);
    const dangerous = flagged || reason !== null;
    const meta: AttachmentMeta = {
      id: newId('att'),
      sha256: stored.sha256,
      size: stored.size,
      mime,
      name: safeFilename(filename),
      target: { kind: kind.data!, id: targetId! },
      uploadedBy: user.id,
      uploadedByName: user.displayName,
      createdAt: nowIso(),
      md5: stored.md5,
      note,
      dangerous,
    };
    app.db.run(
      'INSERT INTO attachments (id, case_id, sha256, size, mime, name, target_kind, target_id, uploaded_by, created_at, dangerous, md5, uploaded_by_name, note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      meta.id,
      caseId,
      meta.sha256,
      meta.size,
      meta.mime,
      meta.name,
      meta.target.kind,
      meta.target.id,
      meta.uploadedBy,
      meta.createdAt,
      dangerous ? 1 : 0,
      meta.md5,
      meta.uploadedByName,
      meta.note,
    );
    const r = rt.appendOp(
      { id: user.id, name: user.displayName },
      { type: 'attachment.add', att: meta } satisfies Op,
      { canEdit: access.edit },
    );
    if (!r.ok) {
      app.db.run('DELETE FROM attachments WHERE id = ?', meta.id);
      await app.blobs.release(meta.sha256);
      throw new HttpError(400, r.message, r.code);
    }
    rt.broadcast({ t: 'op', ...r.broadcast });
    reply.status(201);
    return { attachment: meta, dangerReason: reason };
  });

  app.get<{ Params: { id: string; attId: string } }>(
    '/api/cases/:id/attachments/:attId',
    async (req, reply) => {
      accessOrThrow(app, req, req.params.id, 'read');
      const row = app.db.get<AttachmentRow>(
        'SELECT * FROM attachments WHERE id = ? AND case_id = ? AND deleted_at IS NULL',
        req.params.attId,
        req.params.id,
      );
      if (!row) throw notFound('No such attachment');
      if (row.dangerous) return sendWrapped(app, reply, row);
      const { mime, inlineImage } = sniffMime(await readHead(app, row.sha256));
      // Only recognised images render inline; anything else downloads, so uploaded markup can never execute.
      return reply
        .type(mime)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('content-length', String(row.size))
        .header(
          'content-disposition',
          `${inlineImage ? 'inline' : 'attachment'}; filename="${safeFilename(row.name)}"`,
        )
        .send(app.blobs.open(row.sha256));
    },
  );

  app.delete<{ Params: { id: string; attId: string } }>(
    '/api/cases/:id/attachments/:attId',
    async (req) => {
      const { user, access } = accessOrThrow(app, req, req.params.id, 'edit');
      const row = app.db.get<AttachmentRow>(
        'SELECT * FROM attachments WHERE id = ? AND case_id = ? AND deleted_at IS NULL',
        req.params.attId,
        req.params.id,
      );
      if (!row) throw notFound('No such attachment');
      const rt = app.runtimes.get(req.params.id);
      const r = rt.appendOp(
        { id: user.id, name: user.displayName },
        { type: 'attachment.remove', id: row.id },
        { canEdit: access.edit },
      );
      if (!r.ok) throw new HttpError(400, r.message, r.code);
      rt.broadcast({ t: 'op', ...r.broadcast });
      app.db.run('UPDATE attachments SET deleted_at = ? WHERE id = ?', nowIso(), row.id);
      await app.blobs.release(row.sha256);
      return { ok: true };
    },
  );
}

/**
 * A dangerous attachment never leaves the server bare. The stored bytes are the sample itself,
 * so its hash stays meaningful; what the analyst downloads is that file inside an encrypted zip
 * with the password `infected`, which no double-click can run and no workstation scanner eats.
 */
async function sendWrapped(app: FastifyInstance, reply: FastifyReply, row: AttachmentRow) {
  const inner = safeFilename(row.name);
  const size = Number(row.size);
  const crc32 = await crc32Of(app.blobs.open(row.sha256));
  const entry = { name: inner, size, crc32, mtime: new Date(row.created_at) };
  return reply
    .type('application/zip')
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', "default-src 'none'; sandbox")
    .header('content-length', String(encryptedZipLength(entry)))
    .header('content-disposition', `attachment; filename="${inner}.zip"`)
    .header('x-midden-dangerous', '1')
    .send(encryptedZipStream(entry, app.blobs.open(row.sha256), INFECTED_PASSWORD));
}

async function readHead(app: FastifyInstance, sha256: string): Promise<Buffer> {
  const { open } = await import('node:fs/promises');
  const fh = await open(app.blobs.pathFor(sha256), 'r');
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, 512, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
