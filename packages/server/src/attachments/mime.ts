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

/**
 * Why a file is considered dangerous to open, or null. Deliberately conservative: it catches the
 * things an analyst will attach from a compromised host (executables, scripts, shortcuts, macro
 * carriers, markup) and lets the uploader flag anything it misses. Never used to allow anything.
 */
export function dangerReason(head: Buffer, filename: string): string | null {
  if (startsWith(head, [0x4d, 0x5a])) return 'Windows executable (PE)';
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'Linux executable (ELF)';
  if (
    startsWith(head, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(head, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(head, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWith(head, [0xcf, 0xfa, 0xed, 0xfe])
  )
    return 'macOS executable (Mach-O)';
  if (startsWith(head, [0xca, 0xfe, 0xba, 0xbe])) return 'Java class or universal binary';
  if (startsWith(head, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) return 'Windows shortcut';
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return 'OLE document (legacy Office, MSI)';
  if (startsWith(head, [0x23, 0x21])) return 'script with a shebang';
  const text = head.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  if (/^<(!doctype html|html|script|\?xml[^>]*>\s*<(script|svg))/.test(text))
    return 'HTML or scripted markup';

  const ext = filename.toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] ?? '';
  const byExt: Record<string, string> = {
    exe: 'executable',
    dll: 'executable',
    sys: 'executable',
    scr: 'executable',
    com: 'executable',
    pif: 'executable',
    msi: 'installer',
    msp: 'installer',
    bat: 'script',
    cmd: 'script',
    ps1: 'script',
    psm1: 'script',
    vbs: 'script',
    vbe: 'script',
    js: 'script',
    jse: 'script',
    wsf: 'script',
    wsh: 'script',
    hta: 'script',
    sh: 'script',
    py: 'script',
    jar: 'Java archive',
    lnk: 'Windows shortcut',
    url: 'internet shortcut',
    docm: 'macro-enabled document',
    xlsm: 'macro-enabled workbook',
    pptm: 'macro-enabled presentation',
    dotm: 'macro-enabled template',
    xlam: 'macro-enabled add-in',
    iso: 'disk image',
    img: 'disk image',
    vhd: 'disk image',
    vhdx: 'disk image',
    chm: 'compiled help file',
    reg: 'registry script',
    inf: 'setup information file',
  };
  const reason = byExt[ext];
  return reason ? `${reason} (.${ext})` : null;
}
