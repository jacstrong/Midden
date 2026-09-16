import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { oidcConfigFromEnv, type OidcConfig } from './auth/oidc.js';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  publicDir: string | null;
  /** Override for the blob directory (default <dataDir>/blobs). */
  blobDir: string | null;
  logLevel: string;
  /** Public origin (scheme://host[:port]) used for WebSocket origin checks and secure cookies. */
  publicOrigin: string | null;
  trustProxy: boolean;
  /** New cases are open to every analyst unless restricted by an owner. */
  openCases: boolean;
  adminUser: string | null;
  adminPassword: string | null;
  argon2MemoryKiB: number;
  maxUploadMb: number;
  /** Total attachment bytes allowed per case. */
  caseQuotaMb: number;
  /** Login attempts per minute per IP (the per-username backoff is the brute-force defence). */
  loginRateLimit: number;
  tls: { cert: string; key: string } | null;
  sessionSecure: boolean | 'auto';
  /** Null unless the OIDC environment variables are all set. */
  oidc: OidcConfig | null;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
}

function envBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.MIDDEN_DATA ?? './data');
  const defaultPublic = fileURLToPath(new URL('../public', import.meta.url));
  const publicDir = env.MIDDEN_PUBLIC_DIR
    ? resolve(env.MIDDEN_PUBLIC_DIR)
    : existsSync(defaultPublic)
      ? defaultPublic
      : null;
  const tls =
    env.MIDDEN_TLS_CERT && env.MIDDEN_TLS_KEY
      ? { cert: env.MIDDEN_TLS_CERT, key: env.MIDDEN_TLS_KEY }
      : null;
  return {
    port: envInt(env, 'MIDDEN_PORT', 8080),
    host: env.MIDDEN_HOST ?? '0.0.0.0',
    dataDir,
    publicDir,
    blobDir: env.MIDDEN_BLOB_DIR ? resolve(env.MIDDEN_BLOB_DIR) : null,
    logLevel: env.MIDDEN_LOG_LEVEL ?? 'info',
    oidc: oidcConfigFromEnv(env),
    publicOrigin: env.MIDDEN_PUBLIC_ORIGIN?.replace(/\/+$/, '') ?? null,
    trustProxy: envBool(env, 'MIDDEN_TRUST_PROXY', false),
    openCases: envBool(env, 'MIDDEN_OPEN_CASES', true),
    adminUser: env.MIDDEN_ADMIN_USER ?? null,
    adminPassword: env.MIDDEN_ADMIN_PASSWORD ?? null,
    argon2MemoryKiB: envInt(env, 'MIDDEN_ARGON2_MEMORY_KIB', 65536),
    maxUploadMb: envInt(env, 'MIDDEN_MAX_UPLOAD_MB', 25),
    caseQuotaMb: envInt(env, 'MIDDEN_CASE_QUOTA_MB', 2048),
    loginRateLimit: envInt(env, 'MIDDEN_LOGIN_RATE_LIMIT', 30),
    tls,
    sessionSecure:
      env.MIDDEN_SESSION_SECURE === undefined
        ? 'auto'
        : envBool(env, 'MIDDEN_SESSION_SECURE', false),
  };
}
