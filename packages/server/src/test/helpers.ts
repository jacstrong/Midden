import type { FastifyInstance, InjectOptions } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.js';
import { openDatabase } from '../db/db.js';
import { loadConfig } from '../config.js';
import { hashPassword } from '../auth/password.js';
import { createUser, type GlobalRole } from '../auth/sessions.js';

export const FAST_ARGON = { memory: 8192, passes: 1, parallelism: 1, tagLength: 32 };

export function testApp(): FastifyInstance {
  return testAppWith({});
}

/** In-memory database, temp data dir, fast argon2, no web bundle. */
export function testAppWith(env: Record<string, string>): FastifyInstance {
  const cfg = loadConfig({
    MIDDEN_DATA: mkdtempSync(join(tmpdir(), 'midden-test-')),
    MIDDEN_ARGON2_MEMORY_KIB: '8192',
    MIDDEN_PUBLIC_DIR: '/nonexistent',
    ...env,
  });
  const db = openDatabase(':memory:');
  // MIDDEN_TEST_LOG=1 surfaces server-side warnings while debugging a failing test.
  const logger = process.env.MIDDEN_TEST_LOG ? { level: 'debug' } : false;
  return buildApp({ db, cfg, logger });
}

export function addUser(
  app: FastifyInstance,
  username: string,
  role: GlobalRole = 'analyst',
  password = 'correct horse battery',
): string {
  return createUser(app.db, {
    username,
    displayName: username.toUpperCase(),
    role,
    passwordHash: hashPassword(password, FAST_ARGON),
  }).id;
}

export async function login(
  app: FastifyInstance,
  username: string,
  password = 'correct horse battery',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-midden-client': '1' },
    payload: { username, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === 'midden_session');
  return `${c!.name}=${c!.value}`;
}

export function as(cookie: string, extra: Partial<InjectOptions> = {}): Partial<InjectOptions> {
  return { ...extra, headers: { cookie, 'x-midden-client': '1', ...(extra.headers ?? {}) } };
}
