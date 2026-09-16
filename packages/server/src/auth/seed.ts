import { randomBytes } from 'node:crypto';
import type { Db } from '../db/db.js';
import type { Config } from '../config.js';
import { hashPassword } from './password.js';
import { countUsers, createUser } from './sessions.js';

/**
 * First boot: create the admin from MIDDEN_ADMIN_USER / MIDDEN_ADMIN_PASSWORD, or generate a
 * one-time password and return a message for the log. Returns null when users already exist.
 */
export function seedAdmin(db: Db, cfg: Config): string | null {
  if (countUsers(db) > 0) return null;
  const username = cfg.adminUser ?? 'admin';
  const generated = !cfg.adminPassword;
  const password = cfg.adminPassword ?? randomBytes(12).toString('base64url');
  createUser(db, {
    username,
    displayName: username,
    role: 'admin',
    mustChangePassword: true,
    passwordHash: hashPassword(password, {
      memory: cfg.argon2MemoryKiB,
      passes: 3,
      parallelism: 1,
      tagLength: 32,
    }),
  });
  return generated
    ? `No users existed. Created admin "${username}" with one-time password: ${password}  (change it at first sign-in)`
    : `No users existed. Created admin "${username}" from MIDDEN_ADMIN_PASSWORD (change it at first sign-in)`;
}
