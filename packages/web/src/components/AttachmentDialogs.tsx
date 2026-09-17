import { useRef, useState } from 'react';
import type { AttachmentMeta } from '@midden/core';
import { api, ApiError, apiUpload } from '../lib/api';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { toast } from '../store/useToasts';
import { Modal } from './Modal';

const KB = 1024;
export function humanSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(0)} KB`;
  return `${(bytes / (KB * KB)).toFixed(1)} MB`;
}

/** The password every malware-sharing convention uses; the server wraps dangerous downloads with it. */
export const INFECTED_PASSWORD = 'infected';

function DangerNotice({ verb }: { verb: 'will be' | 'is' }) {
  return (
    <div className="dangernote" data-testid="danger-notice">
      <b>Dangerous file.</b> The file {verb} stored exactly as uploaded, so its hashes are the
      sample&rsquo;s own. Every download {verb === 'is' ? 'comes' : 'will come'} wrapped in an
      encrypted zip so nothing opens it by accident and no scanner quarantines it. Open the zip with
      the password <code className="pw">{INFECTED_PASSWORD}</code>.
    </div>
  );
}

/* ------------------------------------------------------------------ upload */

export function AttachmentUploadDialog({
  targetKind,
  targetId,
  onClose,
}: {
  targetKind: 'event' | 'host';
  targetId: string;
  onClose: () => void;
}) {
  const caseId = useCaseStore((s) => s.caseId);
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [dangerous, setDangerous] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!file || !caseId) return;
    setBusy(true);
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('targetKind', targetKind);
    form.append('targetId', targetId);
    form.append('note', note.trim());
    if (dangerous) form.append('dangerous', '1');
    try {
      const r = await apiUpload<{ attachment: AttachmentMeta; dangerReason: string | null }>(
        `/api/cases/${caseId}/attachments`,
        form,
      );
      if (r.dangerReason)
        toast(`Attached ${file.name} — flagged as dangerous: ${r.dangerReason}`, 'warn');
      else if (r.attachment.dangerous) toast(`Attached ${file.name} as dangerous`, 'warn');
      else toast(`Attached ${file.name}`);
      onClose();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Upload failed', 'bad');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Attach evidence to this ${targetKind}`}
      onClose={onClose}
      narrow
      foot={
        <>
          <span className="sp" />
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn pri"
            onClick={() => void submit()}
            disabled={!file || busy}
            data-testid="attach-submit"
          >
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>File</label>
        <div className="filepick">
          <button
            className="btn"
            onClick={() => input.current?.click()}
            disabled={busy}
            data-testid="attach-choose"
          >
            {file ? 'Choose a different file' : 'Choose a file…'}
          </button>
          {file ? (
            <span className="filename" data-testid="attach-chosen">
              {file.name} <span className="dimmer">· {humanSize(file.size)}</span>
            </span>
          ) : (
            <span className="hint">Screenshots, log excerpts, captures, samples.</span>
          )}
          <input
            ref={input}
            type="file"
            style={{ display: 'none' }}
            data-testid="attach-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) setFile(f);
            }}
          />
        </div>
      </div>
      <div className="field">
        <label>Note (optional)</label>
        <textarea
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Where it came from, how it was collected, what it shows"
          data-testid="attach-note"
        />
      </div>
      <label className="ck" style={{ marginTop: 4 }}>
        <input
          type="checkbox"
          checked={dangerous}
          onChange={(e) => setDangerous(e.target.checked)}
          data-testid="attach-dangerous"
        />{' '}
        This is a dangerous file (malware, a weaponised document, a script from a host)
      </label>
      {dangerous && <DangerNotice verb="will be" />}
      <div className="hint" style={{ marginTop: 8 }}>
        Executables, scripts, shortcuts and macro documents are flagged automatically whatever you
        tick here.
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ detail */

function Hash({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <dt>{label}</dt>
      <dd className="hashrow">
        <code className="hash" data-testid={`hash-${label.toLowerCase()}`}>
          {value || '—'}
        </code>
        {value && (
          <button
            className="btn sm ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
            title="Copy"
          >
            {copied ? 'copied' : 'copy'}
          </button>
        )}
      </dd>
    </>
  );
}

export function AttachmentDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const caseId = useCaseStore((s) => s.caseId);
  const att = useCaseStore((s) => s.state.attachments[id]);
  const canEdit = useCaseStore((s) => s.access.edit);
  const dispatch = useCaseStore((s) => s.dispatch);
  const seq = useCaseStore((s) => s.seq);
  const confirm = useUiStore((s) => s.confirm);
  const [note, setNote] = useState(att?.note ?? '');
  const [baseSeq] = useState(seq);
  const [saving, setSaving] = useState(false);

  if (!att || !caseId) {
    return (
      <Modal title="Attachment" onClose={onClose} narrow>
        <p className="hint">This attachment is no longer part of the case.</p>
      </Modal>
    );
  }
  const href = `/api/cases/${caseId}/attachments/${att.id}`;
  // Snapshots written before the note existed carry no key at all, so treat absent as empty.
  const dirty = note !== (att.note ?? '');

  const save = async (): Promise<void> => {
    setSaving(true);
    const r = await dispatch({ type: 'attachment.set', id: att.id, patch: { note } }, { baseSeq });
    setSaving(false);
    if (r.ok) toast('Note saved');
    else toast(r.error ?? 'Could not save the note', 'bad');
  };

  const remove = (): void => {
    confirm(
      'Remove attachment',
      `Remove ${att.name} from this ${att.target.kind}? The file is deleted from the server.`,
      'Remove',
      () => {
        // Back to the editor first: the confirm restores this record, which is about to be gone.
        onClose();
        void api('DELETE', href)
          .then(() => toast('Attachment removed', 'warn'))
          .catch((err: unknown) =>
            toast(err instanceof ApiError ? err.message : 'Could not remove it', 'bad'),
          );
      },
      true,
    );
  };

  const isImage = att.mime.startsWith('image/') && !att.dangerous;
  return (
    <div className={att.dangerous ? 'modal-danger' : undefined}>
      <Modal
        title={att.name}
        onClose={onClose}
        head={att.dangerous ? <span className="badge dangerbadge">dangerous</span> : undefined}
        foot={
          <>
            {canEdit && (
              <button className="btn ghost mag" onClick={remove} data-testid="attachment-remove">
                Remove
              </button>
            )}
            <span className="sp" />
            {canEdit && dirty && (
              <button
                className="btn"
                onClick={() => void save()}
                disabled={saving}
                data-testid="attachment-save-note"
              >
                {saving ? 'Saving…' : 'Save note'}
              </button>
            )}
            <a
              className="btn pri"
              href={href}
              download={att.dangerous ? `${att.name}.zip` : att.name}
              data-testid="attachment-download"
            >
              {att.dangerous ? `Download ${att.name}.zip` : 'Download'}
            </a>
          </>
        }
      >
        {att.dangerous && <DangerNotice verb="is" />}
        {isImage && (
          <a href={href} target="_blank" rel="noopener" className="attachpreview">
            <img src={href} alt={att.name} />
          </a>
        )}
        <dl className="kv attachkv">
          <dt>Type</dt>
          <dd>{att.mime}</dd>
          <dt>Size</dt>
          <dd>
            {humanSize(att.size)}{' '}
            <span className="dimmer">({att.size.toLocaleString()} bytes)</span>
          </dd>
          <Hash label="SHA-256" value={att.sha256} />
          <Hash label="MD5" value={att.md5} />
          <dt>Uploaded by</dt>
          <dd>{att.uploadedByName || att.uploadedBy}</dd>
          <dt>Uploaded</dt>
          <dd>
            {new Date(att.createdAt).toLocaleString()}{' '}
            <span className="dimmer">· {att.createdAt}</span>
          </dd>
          <dt>Attached to</dt>
          <dd>
            {att.target.kind} <span className="dimmer">{att.target.id}</span>
          </dd>
        </dl>
        <div className="field" style={{ marginTop: 12 }}>
          <label>Note</label>
          {canEdit ? (
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Where it came from, how it was collected, what it shows"
              data-testid="attachment-note"
            />
          ) : (
            <p className="notetext">{att.note || <span className="hint">No note.</span>}</p>
          )}
        </div>
      </Modal>
    </div>
  );
}
