/**
 * Content sniffing for uploaded evidence. Only formats we recognise from their magic bytes are
 * ever served inline; everything else is forced to download. A file's claimed name or type is
 * never trusted, so an HTML page uploaded as "screenshot.png" cannot run in the case's origin.
 */
export interface Sniffed {
  /** The type we will serve it as. */
  mime: string;
  /** Safe to render in an <img> in the app. */
  inlineImage: boolean;
}

const startsWith = (b: Buffer, sig: number[], offset = 0): boolean =>
  sig.every((byte, i) => b[offset + i] === byte);

export function sniffMime(head: Buffer, fallback = 'application/octet-stream'): Sniffed {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mime: 'image/png', inlineImage: true };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', inlineImage: true };
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return { mime: 'image/gif', inlineImage: true };
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8))
    return { mime: 'image/webp', inlineImage: true };
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46]))
    return { mime: 'application/pdf', inlineImage: false };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]))
    return { mime: 'application/zip', inlineImage: false };
  if (startsWith(head, [0x1f, 0x8b])) return { mime: 'application/gzip', inlineImage: false };
  if (
    startsWith(head, [0xd4, 0xc3, 0xb2, 0xa1]) ||
    startsWith(head, [0xa1, 0xb2, 0xc3, 0xd4]) ||
    startsWith(head, [0x0a, 0x0d, 0x0d, 0x0a])
  )
    return { mime: 'application/vnd.tcpdump.pcap', inlineImage: false };
  if (looksTextual(head)) return { mime: 'text/plain', inlineImage: false };
  return {
    mime: fallback === 'application/octet-stream' ? fallback : 'application/octet-stream',
    inlineImage: false,
  };
}

/** UTF-8-ish text with no control bytes other than tab, newline and carriage return. */
function looksTextual(b: Buffer): boolean {
  if (!b.length) return true;
  for (const byte of b.subarray(0, 512)) {
    if (byte === 0) return false;
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
  }
  return true;
}

/** Filename that is safe to put in a Content-Disposition header. */
export function safeFilename(name: string, fallback = 'attachment'): string {
  const base = name
    .replace(/[\\/]/g, '_')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return base.slice(0, 120) || fallback;
}
