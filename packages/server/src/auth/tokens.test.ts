import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { addUser, as, login, testApp } from '../test/helpers.js';
import { tokenMayUse } from './tokens.js';

describe('API tokens', () => {
  let app: FastifyInstance;
  let ann: string;
  let caseId: string;
  beforeEach(async () => {
    app = testApp();
    addUser(app, 'ann');
    addUser(app, 'root', 'admin');
    await app.ready();
    ann = await login(app, 'ann');
    const c = await app.inject({
      method: 'POST',
      url: '/api/cases',
      ...as(ann),
      payload: { name: 'Tokens' },
    });
    caseId = c.json().case.id as string;
  });
  afterEach(async () => {
    await app.close();
  });

  const mint = async (
    cookie: string,
    body: object = { name: 'agent', scope: 'write' },
  ): Promise<{ token: string; id: string }> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      ...as(cookie),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return { token: res.json().token, id: res.json().record.id };
  };
  const bearer = (token: string, extra: Record<string, unknown> = {}) => ({
    ...extra,
    headers: { authorization: `Bearer ${token}` },
  });
  const noop = { op: { type: 'noop' } };

  it('shows the token once, stores only a hash, and lists it without the secret', async () => {
    const { token } = await mint(ann);
    expect(token).toMatch(/^mdn_/);
    const row = app.db.get<{ token_hash: string }>('SELECT token_hash FROM api_tokens');
    expect(row?.token_hash).not.toContain(token);
    const list = await app.inject({ method: 'GET', url: '/api/tokens', ...as(ann) });
    expect(JSON.stringify(list.json())).not.toContain(token);
    expect(list.json().tokens[0]).toMatchObject({ name: 'agent', scope: 'write' });
    expect(list.json().tokens[0].prefix).toBe(token.slice(0, 10));
  });

  it('defaults to read-only, and a read token cannot write', async () => {
    const { token } = await mint(ann, { name: 'reader' });
    const read = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/state`,
      ...bearer(token),
    });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({
      method: 'POST',
      url: `/api/cases/${caseId}/ops`,
      ...bearer(token),
      payload: noop,
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('read_only_token');
  });

  it('lets a write token work without the CSRF header and records who did it', async () => {
    const { token } = await mint(ann, { name: 'triage-bot', scope: 'write' });
    const write = await app.inject({
      method: 'POST',
      url: `/api/cases/${caseId}/ops`,
      ...bearer(token),
      payload: noop,
    });
    expect(write.statusCode).toBe(200);
    const ops = await app.inject({ method: 'GET', url: `/api/cases/${caseId}/ops`, ...as(ann) });
    const last = ops.json().ops.at(-1);
    expect(last.via).toBe('triage-bot');
    expect(last.actor.name).toBe('ANN via triage-bot');
    expect(ops.json().ops[0].via).toBeNull();
  });

  it('never does more than its owner can', async () => {
    addUser(app, 'vic', 'viewer');
    const vic = await login(app, 'vic');
    const { token } = await mint(vic);
    const write = await app.inject({
      method: 'POST',
      url: `/api/cases/${caseId}/ops`,
      ...bearer(token),
      payload: noop,
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('readonly');
  });

  it('keeps accounts, tokens, admin and case destruction away from tokens, even an admin one', async () => {
    const root = await login(app, 'root');
    const { token } = await mint(root);
    for (const [method, url] of [
      ['GET', '/api/tokens'],
      ['POST', '/api/tokens'],
      ['GET', '/api/users'],
      ['POST', '/api/users'],
      ['GET', '/api/admin/backup'],
      ['GET', '/api/admin/stats'],
      ['POST', '/api/auth/password'],
      ['DELETE', `/api/cases/${caseId}`],
      ['PATCH', `/api/cases/${caseId}`],
      ['PUT', `/api/cases/${caseId}/members/x`],
    ] as const) {
      const res = await app.inject({ method, url, ...bearer(token) });
      expect([method, url, res.statusCode, res.json().error.code]).toEqual([
        method,
        url,
        403,
        'session_required',
      ]);
    }
  });

  it('cannot be talked past with an encoded path', async () => {
    const root = await login(app, 'root');
    const { token } = await mint(root);
    const reader = await mint(root, { name: 'reader' });
    for (const url of ['/%61pi/admin/stats', '/api/%61dmin/stats', '/%61%70%69/admin/stats']) {
      const res = await app.inject({ method: 'GET', url, ...bearer(token) });
      expect([url, res.statusCode, res.json().error.code]).toEqual([url, 403, 'session_required']);
    }
    const write = await app.inject({
      method: 'POST',
      url: `/%61pi/cases/${caseId}/ops`,
      ...bearer(reader.token),
      payload: noop,
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().error.code).toBe('read_only_token');
  });

  it('still requires the CSRF header on an encoded path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/%61pi/cases`,
      headers: { cookie: ann },
      payload: { name: 'forged' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf');
  });

  it('classifies a route it has never heard of as browser-only', () => {
    expect(tokenMayUse('write', 'POST', '/api/some/future/route')).toBe('browser_only');
    expect(tokenMayUse('write', 'GET', undefined)).toBeNull();
    expect(tokenMayUse('read', 'POST', '/api/mcp')).toBeNull();
  });

  it('rejects revoked, expired, unknown and disabled-owner tokens, without using the cookie', async () => {
    const url = `/api/cases/${caseId}`;
    const { token, id } = await mint(ann);
    expect((await app.inject({ method: 'GET', url, ...bearer(token) })).statusCode).toBe(200);

    const revoke = await app.inject({ method: 'DELETE', url: `/api/tokens/${id}`, ...as(ann) });
    expect(revoke.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url, ...bearer(token) })).statusCode).toBe(401);

    const expired = await mint(ann);
    app.db.run(
      'UPDATE api_tokens SET expires_at = ? WHERE id = ?',
      new Date(Date.now() - 1000).toISOString(),
      expired.id,
    );
    expect((await app.inject({ method: 'GET', url, ...bearer(expired.token) })).statusCode).toBe(
      401,
    );

    // A bad token alongside a good cookie is still a bad token.
    const both = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: ann, authorization: 'Bearer mdn_nonsense' },
    });
    expect(both.statusCode).toBe(401);
  });

  it("cannot revoke someone else's token", async () => {
    const root = await login(app, 'root');
    const { id } = await mint(root);
    const res = await app.inject({ method: 'DELETE', url: `/api/tokens/${id}`, ...as(ann) });
    expect(res.statusCode).toBe(404);
  });

  it('revokes tokens when an admin disables the owner or resets their password', async () => {
    const root = await login(app, 'root');
    const annId = app.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'ann'")!.id;
    const url = `/api/cases/${caseId}`;

    const first = await mint(ann);
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${annId}`,
      ...as(root),
      payload: { password: 'a long new temporary password' },
    });
    expect((await app.inject({ method: 'GET', url, ...bearer(first.token) })).statusCode).toBe(401);

    app.db.run('UPDATE users SET must_change_password = 0 WHERE id = ?', annId);
    const again = await login(app, 'ann', 'a long new temporary password');
    const second = await mint(again);
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${annId}`,
      ...as(root),
      payload: { disabled: true },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${annId}`,
      ...as(root),
      payload: { disabled: false },
    });
    expect((await app.inject({ method: 'GET', url, ...bearer(second.token) })).statusCode).toBe(
      401,
    );
  });

  it('will not mint a token for an account still on a temporary password', async () => {
    const annId = app.db.get<{ id: string }>("SELECT id FROM users WHERE username = 'ann'")!.id;
    app.db.run('UPDATE users SET must_change_password = 1 WHERE id = ?', annId);
    const res = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      ...as(ann),
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });
});
