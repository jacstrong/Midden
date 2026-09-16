export type NmapFormat = 'xml' | 'text' | 'unknown';

/** Sniff the first few hundred bytes of an upload. */
export function detectNmapFormat(head: string): NmapFormat {
  const h = (head.charCodeAt(0) === 0xfeff ? head.slice(1) : head).trimStart().slice(0, 400);
  if (h.startsWith('<?xml') || h.includes('<nmaprun')) return 'xml';
  if (
    /^# Nmap [\d.]+ scan initiated/m.test(h) ||
    /^Nmap scan report for /m.test(h) ||
    /^Starting Nmap /m.test(h)
  )
    return 'text';
  return 'unknown';
}
