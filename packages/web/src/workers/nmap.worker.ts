/**
 * Standalone-mode nmap parser. Runs off the main thread so a large scan does not freeze the
 * UI. Built to a self-contained IIFE (vite.worker.config.ts) and spawned from a data: URL so
 * it works from file:// in every engine.
 */
import {
  detectNmapFormat,
  parseNmapText,
  parseNmapXml,
  type ScanHost,
  type ScanRunMeta,
} from '@midden/core';

export interface ParseRequest {
  t: 'parse';
  /** Raw file bytes, read on the main thread and transferred in (see nmap.ts). */
  buffer: ArrayBuffer;
}
export type ParseResponse =
  | { t: 'hosts'; hosts: ScanHost[] }
  | { t: 'progress'; hosts: number }
  | { t: 'done'; meta: ScanRunMeta; hosts: number }
  | { t: 'error'; message: string }
  | { t: 'pong'; echo: string };

const post = (m: ParseResponse): void => self.postMessage(m);
const BATCH = 500;

const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Decode the transferred bytes in slices so the parser never sees one huge string. The worker
 * is handed an ArrayBuffer rather than the File itself: WebKit will not let a data:-URL worker
 * read a local file picked on a file:// page. TextDecoder's streaming mode keeps multi-byte
 * characters intact across slice boundaries.
 */
function* chunks(buffer: ArrayBuffer): Generator<string> {
  const decoder = new TextDecoder('utf-8');
  const bytes = new Uint8Array(buffer);
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const text = decoder.decode(bytes.subarray(offset, offset + CHUNK_BYTES), { stream: true });
    if (text) yield text;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

async function run(buffer: ArrayBuffer): Promise<void> {
  const head = new TextDecoder('utf-8').decode(new Uint8Array(buffer).subarray(0, 512));
  const fmt = detectNmapFormat(head);
  if (fmt === 'unknown') {
    post({ t: 'error', message: 'Not recognised as nmap XML (-oX) or normal (-oN) output' });
    return;
  }
  let batch: ScanHost[] = [];
  let total = 0;
  const flush = (): void => {
    if (!batch.length) return;
    post({ t: 'hosts', hosts: batch });
    batch = [];
  };
  try {
    let meta: ScanRunMeta;
    if (fmt === 'xml') {
      meta = await parseNmapXml(chunks(buffer), (h) => {
        batch.push(h);
        total++;
        if (batch.length >= BATCH) {
          flush();
          post({ t: 'progress', hosts: total });
        }
      });
    } else {
      let whole = '';
      for (const c of chunks(buffer)) whole += c;
      const parsed = parseNmapText(whole);
      for (const h of parsed.hosts) {
        batch.push(h);
        total++;
        if (batch.length >= BATCH) flush();
      }
      meta = parsed.meta;
    }
    flush();
    post({ t: 'done', meta, hosts: total });
  } catch (err) {
    post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (e: MessageEvent<ParseRequest | { t: 'ping'; echo: string }>) => {
  const msg = e.data;
  if (msg.t === 'ping') {
    post({ t: 'pong', echo: msg.echo });
    return;
  }
  if (msg.t === 'parse') void run(msg.buffer);
};
