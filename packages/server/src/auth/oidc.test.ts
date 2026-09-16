import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { OAuth2Server } from 'oauth2-mock-server';
import { addUser, as, login, testAppWith } from '../test/helpers.js';
import { oidcConfigFromEnv, provisionUser, resetOidcDiscovery } from './oidc.js';
import { openDatabase } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { createUser, findUserByUsername, listUsers } from './sessions.js';

const CFG = {
  issuer: 'http://localhost',
  clientId: 'midden',
  clientSecret: 'secret',
  scopes: 'openid profile email',
  adminClaim: 'groups',
  adminValue: 'midden-admins',
  allowInsecure: true,
};

describe('oidcConfigFromEnv', () => {
  it('is off unless issuer, client id and secret are all present', () => {
    expect(oidcConfigFromEnv({})).toBeNull();
    expect(oidcConfigFromEnv({ MIDDEN_OIDC_ISSUER: 'https://idp.example' })).toBeNull();
    const cfg = oidcConfigFromEnv({
      MIDDEN_OIDC_ISSUER: 'https://idp.example',
      MIDDEN_OIDC_CLIENT_ID: 'midden',
      MIDDEN_OIDC_CLIENT_SECRET: 's3cret',
      MIDDEN_OIDC_ADMIN_CLAIM: 'roles',
      MIDDEN_OIDC_ADMIN_VALUE: 'ir-lead',
    });
    expect(cfg).toMatchObject({
      issuer: 'https://idp.example',
      scopes: 'openid profile email',
      adminClaim: 'roles',
      adminValue: 'ir-lead',
    });
  });
});

describe('provisionUser', () => {
  const db = openDatabase(':memory:');
  beforeAll(() => migrate(db));

  it('creates an analyst on first sign-in and matches on the subject afterwards', () => {
    const u = provisionUser(db, CFG, {
      sub: 'idp|123',
      name: 'Ann Analyst',
      preferred_username: 'ann',
    });
    expect(u).toMatchObject({
      username: 'ann',
      displayName: 'Ann Analyst',
      role: 'analyst',
      hasPassword: false,
    });
    const again = provisionUser(db, CFG, {
      sub: 'idp|123',
      name: 'Ann Renamed',
      preferred_username: 'ann',
    });
    expect(again.id).toBe(u.id);
    expect(again.displayName).toBe('Ann Renamed');
    expect(listUsers(db)).toHaveLength(1);
  });

  it('grants and revokes admin from the configured claim', () => {
    const boss = provisionUser(db, CFG, {
      sub: 'idp|boss',
      preferred_username: 'boss',
      groups: ['midden-admins'],
    });
    expect(boss.role).toBe('admin');
    const demoted = provisionUser(db, CFG, {
      sub: 'idp|boss',
      preferred_username: 'boss',
      groups: ['staff'],
    });
    expect(demoted.role).toBe('analyst');
    const spaceSeparated = provisionUser(db, CFG, {
      sub: 'idp|two',
      preferred_username: 'two',
      groups: 'staff midden-admins',
    });
    expect(spaceSeparated.role).toBe('admin');
    // without the claim configured, roles are left to local administration
    const plain = provisionUser(
      db,
      { ...CFG, adminClaim: null, adminValue: null },
      { sub: 'idp|three', preferred_username: 'three' },
    );
    expect(plain.role).toBe('analyst');
  });

  it('links an existing local account with the same username instead of duplicating it', () => {
    const local = createUser(db, {
      username: 'carl',
      displayName: 'Carl',
      role: 'admin',
      passwordHash: 'x',
    });
    const linked = provisionUser(db, CFG, {
      sub: 'idp|carl',
      preferred_username: 'carl',
      name: 'Carl Via SSO',
    });
    expect(linked.id).toBe(local.id);
    expect(findUserByUsername(db, 'carl')?.oidcSub).toBe('idp|carl');
  });

  it('refuses a disabled account and a response with no subject', () => {
    const u = provisionUser(db, CFG, { sub: 'idp|gone', preferred_username: 'gone' });
    db.run('UPDATE users SET disabled = 1 WHERE id = ?', u.id);
    expect(() => provisionUser(db, CFG, { sub: 'idp|gone', preferred_username: 'gone' })).toThrow(
      /disabled/,
    );
    expect(() => provisionUser(db, CFG, { preferred_username: 'nobody' })).toThrow(/subject/);
  });
});

describe('OIDC sign-in against a real provider', () => {
  const idp = new OAuth2Server();
  let app: FastifyInstance;
  let issuer: string;

  beforeAll(async () => {
    await idp.issuer.keys.generate('RS256');
    await idp.start(0, 'localhost');
    issuer = idp.issuer.url!;
  });
  afterAll(async () => {
    await idp.stop();
  });
  beforeEach(() => {
    resetOidcDiscovery();
    idp.service.removeAllListeners('beforeTokenSigning');
  });
  afterEach(async () => {
    await app?.close();
  });

  const start = async (): Promise<FastifyInstance> => {
    app = testAppWith({
      MIDDEN_OIDC_ISSUER: issuer,
      MIDDEN_OIDC_CLIENT_ID: 'midden',
      MIDDEN_OIDC_CLIENT_SECRET: 'secret',
      MIDDEN_OIDC_ALLOW_INSECURE: '1',
      MIDDEN_OIDC_ADMIN_CLAIM: 'groups',
      MIDDEN_OIDC_ADMIN_VALUE: 'midden-admins',
      MIDDEN_PUBLIC_ORIGIN: 'http://127.0.0.1:18080',
    });
    await app.ready();
    return app;
  };

  it('advertises that SSO is available', async () => {
    await start();
    const r = await app.inject({ method: 'GET', url: '/api/auth/oidc/enabled' });
    expect(r.json()).toEqual({ enabled: true, issuer });
  });

  it('is absent when unconfigured', async () => {
    app = testAppWith({});
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/auth/oidc/enabled' })).json()).toEqual({
      enabled: false,
      issuer: null,
    });
    expect((await app.inject({ method: 'GET', url: '/api/auth/oidc/start' })).statusCode).toBe(404);
  });

  /** Walk the provider's authorize endpoint so it registers the PKCE challenge, as a browser would. */
  const authorize = async (location: string): Promise<{ code: string; state: string }> => {
    const res = await fetch(location, { redirect: 'manual' });
    const back = res.headers.get('location');
    if (!back) throw new Error(`provider did not redirect back: ${res.status} ${await res.text()}`);
    const url = new URL(back);
    return { code: url.searchParams.get('code')!, state: url.searchParams.get('state')! };
  };

  it('completes the code flow, provisions the user, and issues a session', async () => {
    await start();
    idp.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }) => {
      token.payload.preferred_username = 'sso.ann';
      token.payload.name = 'SSO Ann';
      token.payload.groups = ['midden-admins'];
    });

    const startRes = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/start?next=/%23/cases',
    });
    expect(startRes.statusCode).toBe(302);
    const location = startRes.headers.location as string;
    const authUrl = new URL(location);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:18080/api/auth/oidc/callback',
    );
    expect(authUrl.searchParams.get('scope')).toBe('openid profile email');
    const loginCookie = startRes.cookies.find((c) => c.name === 'midden_oidc');
    expect(loginCookie).toBeTruthy();

    const { code, state } = await authorize(location);
    expect(state).toBe(authUrl.searchParams.get('state'));

    const cb = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      headers: { cookie: `midden_oidc=${loginCookie!.value}` },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/#/cases');
    const session = cb.cookies.find((c) => c.name === 'midden_session');
    expect(session).toBeTruthy();

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: `midden_session=${session!.value}` },
    });
    expect(me.json().user).toMatchObject({
      username: 'sso.ann',
      displayName: 'SSO Ann',
      role: 'admin',
      hasPassword: false,
    });
    expect(me.json().oidc).toBe(true);

    // a second sign-in reuses the same account rather than creating another
    idp.service.removeAllListeners('beforeTokenSigning');
    const start2 = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    const cookie2 = start2.cookies.find((c) => c.name === 'midden_oidc')!;
    idp.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }) => {
      token.payload.preferred_username = 'sso.ann';
      token.payload.groups = [];
    });
    const second = await authorize(start2.headers.location as string);
    const cb2 = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=${encodeURIComponent(second.code)}&state=${encodeURIComponent(second.state)}`,
      headers: { cookie: `midden_oidc=${cookie2.value}` },
    });
    expect(cb2.statusCode).toBe(302);
    const users = (
      await app.inject({
        method: 'GET',
        url: '/api/users',
        headers: { cookie: `midden_session=${session!.value}` },
      })
    ).json().users;
    expect(users.filter((u: { username: string }) => u.username === 'sso.ann')).toHaveLength(1);
    // the group was removed upstream, so admin was revoked on sign-in
    expect(users.find((u: { username: string }) => u.username === 'sso.ann').role).toBe('analyst');
  });

  it('rejects a callback with no login cookie or a mismatched state', async () => {
    await start();
    const noCookie = await app.inject({
      method: 'GET',
      url: '/api/auth/oidc/callback?code=x&state=y',
    });
    expect(noCookie.statusCode).toBe(400);
    expect(noCookie.json().error.code).toBe('oidc_state');

    const startRes = await app.inject({ method: 'GET', url: '/api/auth/oidc/start' });
    const loginCookie = startRes.cookies.find((c) => c.name === 'midden_oidc')!;
    const { code } = await authorize(startRes.headers.location as string);
    const wrongState = await app.inject({
      method: 'GET',
      url: `/api/auth/oidc/callback?code=${encodeURIComponent(code)}&state=not-the-state`,
      headers: { cookie: `midden_oidc=${loginCookie.value}` },
    });
    expect(wrongState.statusCode).toBe(401);
  });

  it('keeps local password sign-in working alongside SSO', async () => {
    await start();
    addUser(app, 'local');
    const cookie = await login(app, 'local');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', ...as(cookie) });
    expect(me.json().user.username).toBe('local');
  });
});
