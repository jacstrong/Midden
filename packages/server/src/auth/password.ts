/**
 * Password hashing with argon2id from `node:crypto` (Node 24 + OpenSSL >= 3.2).
 * Zero native modules. Hashes are stored as PHC strings so they interoperate with
 * every other argon2 implementation if the server is ever migrated.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as crypto from 'node:crypto';

export interface Argon2Params {
  /** Memory in KiB. */
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

export const DEFAULT_ARGON2: Argon2Params = {
  memory: 65536,
  passes: 3,
  parallelism: 1,
  tagLength: 32,
};

type Argon2Sync = (
  algorithm: 'argon2id' | 'argon2i' | 'argon2d',
  options: {
    message: Buffer | string;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
) => Buffer;

function argon2Sync(): Argon2Sync {
  const fn = (crypto as unknown as { argon2Sync?: Argon2Sync }).argon2Sync;
  if (typeof fn !== 'function') {
    throw new Error(
      'crypto.argon2Sync is not available. Midden needs Node 24+ built against OpenSSL 3.2 or newer.',
    );
  }
  return fn;
}

export function argon2Available(): boolean {
  try {
    argon2Sync();
    return true;
  } catch {
    return false;
  }
}

const b64 = (b: Buffer): string => b.toString('base64').replace(/=+$/, '');
const unb64 = (s: string): Buffer => Buffer.from(s, 'base64');

export function hashPassword(password: string, params: Argon2Params = DEFAULT_ARGON2): string {
  const nonce = randomBytes(16);
  const tag = argon2Sync()('argon2id', { message: password, nonce, ...params });
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(nonce)}$${b64(tag)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export function verifyPassword(password: string, phc: string): boolean {
  const m = PHC.exec(phc);
  if (!m) return false;
  const [, mem, t, p, salt, hash] = m;
  const expected = unb64(hash!);
  const actual = argon2Sync()('argon2id', {
    message: password,
    nonce: unb64(salt!),
    memory: Number(mem),
    passes: Number(t),
    parallelism: Number(p),
    tagLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
