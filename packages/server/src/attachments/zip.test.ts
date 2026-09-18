import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  INFECTED_PASSWORD,
  crc32,
  crc32Of,
  encryptedZipLength,
  encryptedZipStream,
} from './zip.js';

async function collect(r: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(parts);
}

function hasUnzip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('crc32', () => {
  it('matches the reference vector', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('streams to the same value', async () => {
    const data = Buffer.from('the quick brown fox jumps over the lazy dog');
    const streamed = await crc32Of(Readable.from([data.subarray(0, 7), data.subarray(7)]));
    expect(streamed).toBe(crc32(data));
  });
});

describe('encrypted zip', () => {
  // A fake PE header followed by a kilobyte of pattern, so the sample is not compressible text.
  const sample = Buffer.concat([
    Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'),
    Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 37) & 0xff)),
  ]);
  const entry = {
    name: 'dropper.exe',
    size: sample.length,
    crc32: crc32(sample),
    mtime: new Date(2026, 6, 14, 13, 2, 40),
  };

  it('is exactly as long as promised, so Content-Length can be set', async () => {
    const zip = await collect(encryptedZipStream(entry, Readable.from([sample]), 'infected'));
    expect(zip.length).toBe(encryptedZipLength(entry));
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });

  it('refuses to finish if the body is shorter than declared', async () => {
    const short = encryptedZipStream(entry, Readable.from([sample.subarray(0, 10)]), 'infected');
    await expect(collect(short)).rejects.toThrow(/expected/);
  });

  it('never writes the sample bytes in the clear', async () => {
    const zip = await collect(encryptedZipStream(entry, Readable.from([sample]), 'infected'));
    expect(zip.indexOf(sample.subarray(0, 16))).toBe(-1);
  });

  it.skipIf(!hasUnzip())('opens with a stock unzip and the infected password', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'midden-zip-'));
    const file = join(dir, 'evidence.zip');
    const chunks = [sample.subarray(0, 100), sample.subarray(100, 700), sample.subarray(700)];
    writeFileSync(
      file,
      await collect(encryptedZipStream(entry, Readable.from(chunks), INFECTED_PASSWORD)),
    );

    const listing = execFileSync('unzip', ['-l', file]).toString();
    expect(listing).toContain('dropper.exe');
    expect(listing).toContain(String(sample.length));

    const out = execFileSync('unzip', ['-P', INFECTED_PASSWORD, '-p', file]);
    expect(Buffer.compare(out, sample)).toBe(0);

    // unzip verifies the CRC on -t, which also proves the check byte and the key stream.
    expect(execFileSync('unzip', ['-P', INFECTED_PASSWORD, '-t', file]).toString()).toMatch(
      /No errors detected/,
    );
    expect(() =>
      execFileSync('unzip', ['-P', 'wrong', '-p', file], { stdio: ['ignore', 'pipe', 'ignore'] }),
    ).toThrow();
  });
});
