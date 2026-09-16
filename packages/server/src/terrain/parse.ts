/** Parse a stored nmap upload (XML streaming, or text) into an inserter. */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseNmapText, parseNmapXml, type ScanFormat, type ScanRunMeta } from '@midden/core';
import type { TerrainInserter } from './insert.js';

export async function parseInto(
  path: string,
  fmt: ScanFormat,
  ins: TerrainInserter,
  onProgress?: (n: number) => void,
): Promise<ScanRunMeta> {
  if (fmt === 'xml') {
    let n = 0;
    const meta = await parseNmapXml(
      createReadStream(path, { encoding: 'utf8', highWaterMark: 256 * 1024 }),
      (h) => {
        ins.add(h);
        if (++n % 1000 === 0) onProgress?.(n);
      },
    );
    ins.flush();
    return meta;
  }
  const text = await readFile(path, 'utf8');
  const { hosts, meta } = parseNmapText(text);
  for (const h of hosts) ins.add(h);
  ins.flush();
  return meta;
}
