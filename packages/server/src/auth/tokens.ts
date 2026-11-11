/**
 * API tokens: long-lived credentials for scripts and agents, acting as the user who made them.
 * A token can never do more than its owner, and `read` tokens can only read. Everything that
 * changes who can see data, or destroys it outright, still needs a person signed in; see
 * `tokenMayUse`.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/db.js';
import { newId, nowIso } from '../lib/ids.js';
import { findUserById, type User } from './sessions.js';

export type TokenScope = 'read' | 'write';

/** The prefix makes a leaked token recognisable to secret scanners. */
export const TOKEN_PREFIX = 'mdn_';

export interface ApiToken {
  id: string;
  name: string;
  /** The first characters of the token, so its owner can tell which one they are looking at. */
  prefix: string;
  scope: TokenScope;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface TokenIdentity {
  id: string;
  name: string;
  scope: TokenScope;
}

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  scope: TokenScope;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

// The token is 256 random bits, so a fast hash is enough; there is nothing to brute force.
const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex');

const rowToToken = (r: TokenRow): ApiToken => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  scope: r.scope,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
});

/** Create a token. The raw value is returned here and can never be read back. */
export function createToken(
  db: Db,
  userId: string,
  input: { name: string; scope: TokenScope; expiresAt?: string | null | undefined },
): { token: string; record: ApiToken } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const id = newId('tok');
  db.run(
    'INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scope, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
    id,
    userId,
    input.name,
    hashToken(token),
    token.slice(0, TOKEN_PREFIX.length + 6),
    input.scope,
    nowIso(),
    input.expiresAt ?? null,
  );
  const row = db.get<TokenRow>('SELECT * FROM api_tokens WHERE id = ?', id)!;
  return { token, record: rowToToken(row) };
}

export function listTokens(db: Db, userId: string): ApiToken[] {
  return db
    .all<TokenRow>(
      'SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      userId,
    )
    .map(rowToToken);
}

/** Revoke one of a user's tokens. Returns false if they have no such live token. */
export function revokeToken(db: Db, userId: string, id: string): boolean {
  const res = db.run(
    'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    nowIso(),
    id,
    userId,
  );
  return Number(res.changes) > 0;
}

export function revokeUserTokens(db: Db, userId: string): void {
  db.run(
    'UPDATE api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    nowIso(),
    userId,
  );
}

/** Resolve a raw token to its owner, or null if it is unknown, revoked or expired. */
export function resolveToken(db: Db, raw: string): { user: User; token: TokenIdentity } | null {
  const row = db.get<TokenRow>('SELECT * FROM api_tokens WHERE token_hash = ?', hashToken(raw));
  if (!row || row.revoked_at) return null;
  const now = Date.now();
  if (row.expires_at && Date.parse(row.expires_at) <= now) return null;
  const user = findUserById(db, row.user_id);
  if (!user || user.disabled) return null;
  if (!row.last_used_at || now - Date.parse(row.last_used_at) > 60_000)
    db.run(
      'UPDATE api_tokens SET last_used_at = ? WHERE id = ?',
      new Date(now).toISOString(),
      row.id,
    );
  return { user, token: { id: row.id, name: row.name, scope: row.scope } };
}

/** Pull a Midden token from an Authorization header. Other schemes belong to a proxy in front. */
export function bearerToken(header: string | undefined): string | null {
  const m = header?.match(/^Bearer\s+(mdn_\S+)$/i);
  return m?.[1] ?? null;
}

/**
 * Routes a token may reach, by route pattern. This is an allowlist so that a new route stays
 * browser-only until someone decides otherwise. Left out on purpose: accounts, tokens, admin
 * (the backup contains password hashes), deleting a case, and anything that changes who can see
 * one. A stolen token should not be able to mint more tokens or widen its own reach.
 */
const TOKEN_ROUTES: Record<string, readonly string[]> = {
  '/api/health': ['GET'],
  '/api/openapi.json': ['GET'],
  '/api/auth/me': ['GET'],
  '/api/ws': ['GET'],
  '/api/mcp': ['POST', 'GET', 'DELETE'],
  '/api/cases': ['GET', 'POST'],
  '/api/cases/:id': ['GET'],
  '/api/cases/:id/state': ['GET'],
  '/api/cases/:id/ops': ['GET', 'POST'],
  '/api/cases/:id/revert': ['POST'],
  '/api/cases/:id/export': ['GET'],
  '/api/cases/:id/import': ['POST'],
  '/api/cases/:id/attachments': ['GET', 'POST'],
  '/api/cases/:id/attachments/:attId': ['GET', 'DELETE'],
  '/api/cases/:id/scans': ['GET', 'POST'],
  '/api/cases/:id/scans/:scanId': ['DELETE'],
  '/api/cases/:id/scans/:scanId/hosts': ['GET'],
  '/api/cases/:id/scans/:scanId/hosts/:ip': ['GET'],
  '/api/cases/:id/scans/:scanId/map': ['GET'],
  '/api/cases/:id/scans/:scanId/targets.txt': ['GET'],
  '/api/cases/:id/scans/:scanId/raw': ['GET'],
  '/api/cases/:id/people': ['GET'],
  '/api/cases/:id/follows': ['GET'],
  '/api/cases/:id/tasks/:taskId/follow': ['PUT', 'DELETE'],
  '/api/notifications': ['GET'],
  '/api/notifications/read': ['POST'],
};

export type TokenDenial = 'browser_only' | 'read_only';

/** Why a token may not make this request, or null if it may. */
export function tokenMayUse(
  scope: TokenScope,
  method: string,
  route: string | undefined,
): TokenDenial | null {
  if (!route) return null; // no such route: let it 404
  const verb = method === 'HEAD' ? 'GET' : method;
  if (verb === 'OPTIONS') return null;
  if (!TOKEN_ROUTES[route]?.includes(verb)) return 'browser_only';
  // MCP is one POST endpoint for reads and writes; each write tool checks the scope itself.
  if (scope === 'read' && verb !== 'GET' && route !== '/api/mcp') return 'read_only';
  return null;
}
