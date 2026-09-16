/**
 * Optional OpenID Connect sign-in. Local accounts remain the default; when MIDDEN_OIDC_ISSUER,
 * CLIENT_ID and CLIENT_SECRET are set, a "Sign in with SSO" option appears alongside them.
 *
 * Authorization code flow with PKCE. The verifier and state live in a short-lived, http-only
 * cookie rather than server memory, so a restart mid-login is harmless. Users are provisioned
 * on first sign-in as analysts (or admins when the configured claim says so) and are matched on
 * the issuer's stable subject, never on a mutable email or name.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import { HttpError } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import {
  createSession,
  findUserById,
  SESSION_COOKIE,
  type GlobalRole,
  type User,
} from './sessions.js';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Claim inspected to decide admin rights, e.g. "groups" or "roles". */
  adminClaim: string | null;
  /** Value that must be present in that claim. */
  adminValue: string | null;
  /** Allow a plain-http issuer (local testing only). */
  allowInsecure: boolean;
}

export function oidcConfigFromEnv(env: NodeJS.ProcessEnv): OidcConfig | null {
  const issuer = env.MIDDEN_OIDC_ISSUER;
  const clientId = env.MIDDEN_OIDC_CLIENT_ID;
  const clientSecret = env.MIDDEN_OIDC_CLIENT_SECRET;
  if (!issuer || !clientId || !clientSecret) return null;
  return {
    issuer,
    clientId,
    clientSecret,
    scopes: env.MIDDEN_OIDC_SCOPES ?? 'openid profile email',
    adminClaim: env.MIDDEN_OIDC_ADMIN_CLAIM ?? null,
    adminValue: env.MIDDEN_OIDC_ADMIN_VALUE ?? null,
    allowInsecure: /^(1|true|yes|on)$/i.test(env.MIDDEN_OIDC_ALLOW_INSECURE ?? ''),
  };
}

const LOGIN_COOKIE = 'midden_oidc';
const LoginState = z.object({
  v: z.string().min(1),
  s: z.string().min(1),
  r: z.string().optional(),
});

let cached: Promise<oidc.Configuration> | null = null;
function discover(cfg: OidcConfig): Promise<oidc.Configuration> {
  cached ??= oidc.discovery(
    new URL(cfg.issuer),
    cfg.clientId,
    cfg.clientSecret,
    undefined,
    cfg.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
  );
  return cached;
}

/** Test seam: drop the memoised discovery result. */
export function resetOidcDiscovery(): void {
  cached = null;
}

function redirectUri(app: FastifyInstance, req: FastifyRequest): string {
  const base =
    app.cfg.publicOrigin ?? `${req.protocol}://${req.headers.host ?? `localhost:${app.cfg.port}`}`;
  return `${base.replace(/\/+$/, '')}/api/auth/oidc/callback`;
}

function claimString(claims: Record<string, unknown>, key: string): string | null {
  const v = claims[key];
  return typeof v === 'string' && v ? v : null;
}

function isAdmin(cfg: OidcConfig, claims: Record<string, unknown>): boolean {
  if (!cfg.adminClaim || !cfg.adminValue) return false;
  const v = claims[cfg.adminClaim];
  if (Array.isArray(v)) return v.map(String).includes(cfg.adminValue);
  return typeof v === 'string' ? v.split(/[\s,]+/).includes(cfg.adminValue) : false;
}

/** Find or create the local account behind an issuer subject. */
export function provisionUser(db: Db, cfg: OidcConfig, claims: Record<string, unknown>): User {
  const sub = claimString(claims, 'sub');
  if (!sub) throw new HttpError(502, 'The identity provider returned no subject claim', 'oidc');
  const existing = db.get<{ id: string }>('SELECT id FROM users WHERE oidc_sub = ?', sub);
  const displayName =
    claimString(claims, 'name') ??
    claimString(claims, 'preferred_username') ??
    claimString(claims, 'email') ??
    sub;
  const role: GlobalRole = isAdmin(cfg, claims) ? 'admin' : 'analyst';

  if (existing) {
    db.run('UPDATE users SET display_name = ? WHERE id = ?', displayName, existing.id);
    // Admin rights follow the provider on every sign-in, both ways.
    if (cfg.adminClaim)
      db.run(
        'UPDATE users SET role = ? WHERE id = ? AND role != ?',
        role,
        existing.id,
        role === 'admin' ? 'admin' : 'viewer',
      );
    const u = findUserById(db, existing.id);
    if (!u) throw new HttpError(500, 'User vanished during sign-in', 'oidc');
    if (u.disabled) throw new HttpError(403, 'That account is disabled', 'disabled');
    return u;
  }

  // Link an existing local account with the same username rather than creating a duplicate.
  const username = claimString(claims, 'preferred_username') ?? claimString(claims, 'email') ?? sub;
  const byName = db.get<{ id: string; oidc_sub: string | null }>(
    'SELECT id, oidc_sub FROM users WHERE username = ?',
    username,
  );
  if (byName && !byName.oidc_sub) {
    db.run(
      'UPDATE users SET oidc_sub = ?, display_name = ? WHERE id = ?',
      sub,
      displayName,
      byName.id,
    );
    const u = findUserById(db, byName.id);
    if (!u) throw new HttpError(500, 'User vanished during sign-in', 'oidc');
    if (u.disabled) throw new HttpError(403, 'That account is disabled', 'disabled');
    return u;
  }

  const id = newId('u');
  db.run(
    'INSERT INTO users (id, username, display_name, password_hash, role, oidc_sub, disabled, must_change_password, created_at) VALUES (?,?,?,NULL,?,?,0,0,?)',
    id,
    byName ? `${username}-${sub.slice(0, 6)}` : username,
    displayName,
    role,
    sub,
    nowIso(),
  );
  return findUserById(db, id)!;
}

export async function oidcRoutes(app: FastifyInstance): Promise<void> {
  const cfg = app.cfg.oidc;
  app.get('/api/auth/oidc/enabled', async () => ({ enabled: !!cfg, issuer: cfg?.issuer ?? null }));
  if (!cfg) return;

  app.get<{ Querystring: { next?: string } }>('/api/auth/oidc/start', async (req, reply) => {
    const config = await discover(cfg);
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const state = oidc.randomState();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(app, req),
      scope: cfg.scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    setLoginCookie(app, req, reply, { v: verifier, s: state, r: safeNext(req.query.next) });
    return reply.redirect(url.href);
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const raw = req.cookies[LOGIN_COOKIE];
    const parsed = raw
      ? LoginState.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')))
      : null;
    if (!parsed?.success)
      throw new HttpError(
        400,
        'Sign-in expired or was started elsewhere. Try again.',
        'oidc_state',
      );
    reply.clearCookie(LOGIN_COOKIE, { path: '/' });

    const config = await discover(cfg);
    const current = new URL(redirectUri(app, req));
    for (const [k, v] of Object.entries(req.query as Record<string, string>))
      current.searchParams.set(k, v);
    let claims: Record<string, unknown>;
    try {
      const tokens = await oidc.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: parsed.data.v,
        expectedState: parsed.data.s,
      });
      claims = (tokens.claims() ?? {}) as Record<string, unknown>;
    } catch (err) {
      app.log.warn({ err }, 'oidc callback failed');
      throw new HttpError(401, 'The identity provider rejected the sign-in', 'oidc');
    }
    const user = provisionUser(app.db, cfg, claims);
    const token = createSession(app.db, user.id, { ip: req.ip, ua: req.headers['user-agent'] });
    const secure =
      app.cfg.sessionSecure === 'auto'
        ? req.protocol === 'https' || (app.cfg.publicOrigin?.startsWith('https://') ?? false)
        : app.cfg.sessionSecure;
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 14 * 24 * 3600,
    });
    return reply.redirect(parsed.data.r ?? '/');
  });
}

/** Only same-site paths, so the provider cannot bounce a user to another origin. */
function safeNext(next: string | undefined): string | undefined {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return undefined;
  return next;
}

function setLoginCookie(
  app: FastifyInstance,
  req: FastifyRequest,
  reply: FastifyReply,
  value: { v: string; s: string; r?: string | undefined },
): void {
  const secure =
    app.cfg.sessionSecure === 'auto'
      ? req.protocol === 'https' || (app.cfg.publicOrigin?.startsWith('https://') ?? false)
      : app.cfg.sessionSecure;
  reply.setCookie(LOGIN_COOKIE, Buffer.from(JSON.stringify(value)).toString('base64url'), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 600,
  });
}
