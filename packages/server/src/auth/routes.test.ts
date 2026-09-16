import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { addUser, as, login, testApp } from '../test/helpers.js';

describe('auth routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = testApp();
    addUser(app, 'admin', 'admin');
    addUser(app, 'ann');
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('rejects mutating API calls without the client header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'ann', password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf');
  });

  it('logs in, reports identity, and logs out', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    const cookie = await login(app, 'ann');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', ...as(cookie) });
    expect(me.json().user).toMatchObject({ username: 'ann', role: 'analyst' });
    expect(me.json().user.oidcSub).toBeUndefined();
    await app.inject({ method: 'POST', url: '/api/auth/logout', ...as(cookie) });
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', ...as(cookie) })).statusCode,
    ).toBe(401);
  });

  it('rejects bad credentials, disabled users, and applies per-user backoff', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-midden-client': '1' },
      payload: { username: 'ann', password: 'nope' },
    });
    expect(bad.statusCode).toBe(401);
    for (let i = 0; i < 5; i++)
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-midden-client': '1' },
        payload: { username: 'ann', password: 'nope' },
      });
    const locked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-midden-client': '1' },
      payload: { username: 'ann', password: 'correct horse battery' },
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('locked');
  });

  it('lets admins manage users and users change their own password', async () => {
    const admin = await login(app, 'admin');
    const ann = await login(app, 'ann');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/users',
          ...as(ann),
          payload: { username: 'x' },
        })
      ).statusCode,
    ).toBe(403);
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      ...as(admin),
      payload: { username: 'carl', role: 'viewer' },
    });
    expect(created.statusCode).toBe(201);
    const temp = created.json().temporaryPassword as string;
    expect(temp.length).toBeGreaterThan(8);
    const carl = await login(app, 'carl', temp);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', ...as(carl) });
    expect(me.json().mustChangePassword).toBe(true);
    // first change needs no current password
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/password',
          ...as(carl),
          payload: { next: 'a much better password' },
        })
      ).statusCode,
    ).toBe(200);
    // later changes do
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/password',
          ...as(carl),
          payload: { next: 'another long password' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/password',
          ...as(carl),
          payload: { current: 'a much better password', next: 'another long password' },
        })
      ).statusCode,
    ).toBe(200);
    // disabling revokes sessions
    const id = created.json().user.id as string;
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${id}`,
      ...as(admin),
      payload: { disabled: true },
    });
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', ...as(carl) })).statusCode).toBe(
      401,
    );
    // admin cannot demote self
    const self = (await app.inject({ method: 'GET', url: '/api/auth/me', ...as(admin) })).json()
      .user.id as string;
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/users/${self}`,
          ...as(admin),
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(400);
  });
});
