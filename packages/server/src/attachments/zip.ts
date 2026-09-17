/**
 * A one-entry zip with traditional PKWARE ("ZipCrypto") encryption and no compression.
 *
 * This is how dangerous evidence is handed to an analyst: the sample goes inside an archive with
 * the password `infected`, the convention every malware-sharing tool follows. The cipher is weak
 * by design and that is fine, it is not hiding anything. It stops a double-click from running
 * the file and stops antivirus on the workstation from quarantining the evidence on arrival.
 * ZipCrypto rather than AES because it is what `unzip`, Explorer, Finder and 7-Zip all open
 * with no extra software, and it is about forty lines, so no dependency.
 *
 * Stored (uncompressed) so the whole archive's length is known up front from the entry size,
 * which lets the download carry a Content-Length. Sizes stay under 4 GB (no zip64) because the
 * upload cap is far below that.
 */
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
const crcByte = (crc: number, byte: number): number =>
  (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;

export function crc32(data: Uint8Array, seed = 0): number {
  let crc = ~seed >>> 0;
  for (const b of data) crc = crcByte(crc, b);
  return ~crc >>> 0;
}

/** Streaming CRC-32 over an async byte source. */
export async function crc32Of(source: AsyncIterable<Uint8Array>): Promise<number> {
  let crc = 0xffffffff;
  for await (const chunk of source) for (const b of chunk) crc = crcByte(crc, b);
  return ~crc >>> 0;
}

/** PKWARE traditional encryption, APPNOTE 6.1. The key stream depends on the plaintext seen so far. */
class ZipCrypto {
  private k0 = 0x12345678;
  private k1 = 0x23456789;
  private k2 = 0x34567890;

  constructor(password: string) {
    for (const b of Buffer.from(password, 'latin1')) this.update(b);
  }

  private update(plain: number): void {
    this.k0 = crcByte(this.k0, plain);
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = crcByte(this.k2, this.k1 >>> 24);
  }

  /** Encrypts in place. */
  encrypt(buf: Uint8Array): Uint8Array {
    for (let i = 0; i < buf.length; i++) {
      const t = (this.k2 | 2) & 0xffff;
      const key = (Math.imul(t, t ^ 1) >>> 8) & 0xff;
      const plain = buf[i]!;
      buf[i] = plain ^ key;
      this.update(plain);
    }
    return buf;
  }
}

export interface ZipEntry {
  name: string;
  size: number;
  crc32: number;
  /** Modification time; defaults to now. */
  mtime?: Date | undefined;
}

const ENCRYPTION_HEADER = 12;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const EOCD = 22;

/** Exact archive length for an entry, so the response can state Content-Length. */
export function encryptedZipLength(entry: ZipEntry): number {
  const nameLen = Buffer.byteLength(entry.name, 'utf8');
  return LOCAL_HEADER + nameLen + ENCRYPTION_HEADER + entry.size + CENTRAL_HEADER + nameLen + EOCD;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Build the archive as a Readable: local header, encrypted data, central directory, end record.
 * `data` must yield exactly `entry.size` bytes whose CRC-32 is `entry.crc32`; the caller has
 * already streamed the blob once to learn those.
 */
export function encryptedZipStream(
  entry: ZipEntry,
  data: AsyncIterable<Uint8Array>,
  password: string,
): Readable {
  const name = Buffer.from(entry.name, 'utf8');
  const { time, date } = dosDateTime(entry.mtime ?? new Date());
  const compressedSize = entry.size + ENCRYPTION_HEADER;
  const flags = 0x0001; // bit 0: encrypted
  const method = 0; // stored
  const version = 20;

  const local = Buffer.alloc(LOCAL_HEADER);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(version, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(entry.crc32, 14);
  local.writeUInt32LE(compressedSize, 18);
  local.writeUInt32LE(entry.size, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(CENTRAL_HEADER);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(version, 4); // version made by
  central.writeUInt16LE(version, 6); // version needed
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(entry.crc32, 16);
  central.writeUInt32LE(compressedSize, 20);
  central.writeUInt32LE(entry.size, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset

  const centralSize = CENTRAL_HEADER + name.length;
  const centralOffset = LOCAL_HEADER + name.length + compressedSize;
  const end = Buffer.alloc(EOCD);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  async function* chunks(): AsyncGenerator<Buffer> {
    yield local;
    yield name;
    const cipher = new ZipCrypto(password);
    // Eleven random bytes and the CRC's high byte: the check byte unzip uses to reject a wrong password.
    const header = randomBytes(ENCRYPTION_HEADER);
    header[ENCRYPTION_HEADER - 1] = (entry.crc32 >>> 24) & 0xff;
    yield Buffer.from(cipher.encrypt(header));
    let seen = 0;
    for await (const chunk of data) {
      seen += chunk.length;
      yield Buffer.from(cipher.encrypt(Buffer.from(chunk)));
    }
    if (seen !== entry.size)
      throw new Error(`zip entry ${entry.name}: expected ${entry.size} bytes, streamed ${seen}`);
    yield central;
    yield name;
    yield end;
  }
  return Readable.from(chunks());
}

/** The password every malware-sharing convention uses. */
export const INFECTED_PASSWORD = 'infected';
