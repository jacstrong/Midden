import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { defaultViewConfig } from '@midden/core';
import { addUser, as, login, testApp } from '../test/helpers.js';

describe('saved task views', () => {
  let app: FastifyInstance;
  const c: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const call = async (
    who: string,
    method: InjectOptions['method'],
    url: string,
    payload?: unknown,
  ) => app.inject({ method, url, ...as(c[who]!), ...(payload !== undefined ? { payload } : {}) });

  beforeEach(async () => {
    app = testApp();
    for (const [n, role] of [
      ['root', 'admin'],
      ['lead', 'analyst'],
      ['ann', 'analyst'],
      ['out', 'analyst'],
    ] as const)
      ids[n] = addUser(app, n, role);
    await app.ready();
    for (const n of ['root', 'lead', 'ann', 'out']) c[n] = await login(app, n);
    ids.team = (await call('root', 'POST', '/api/teams', { name: 'Host' })).json().team.id;
    await call('root', 'PUT', `/api/teams/${ids.team}/members/${ids.lead}`, { role: 'lead' });
    await call('root', 'PUT', `/api/teams/${ids.team}/members/${ids.ann}`, { role: 'member' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('keeps personal views private and shares team views with members', async () => {
    const config = defaultViewConfig({ groupBy: 'assignee' });
    expect(
      (await call('ann', 'POST', '/api/task-views', { name: 'Mine', config })).statusCode,
    ).toBe(201);
    // a member can't share with the team; its lead can
    expect(
      (await call('ann', 'POST', '/api/task-views', { name: 'X', teamId: ids.team, config }))
        .statusCode,
    ).toBe(403);
    const shared = await call('lead', 'POST', '/api/task-views', {
      name: 'Hunt board',
      teamId: ids.team,
      config,
    });
    expect(shared.statusCode).toBe(201);
    const sid = shared.json().view.id;

    const names = async (who: string) =>
      (await call(who, 'GET', '/api/task-views')).json().views.map((v: { name: string }) => v.name);
    expect(await names('ann')).toEqual(['Hunt board', 'Mine']);
    expect(await names('lead')).toEqual(['Hunt board']);
    expect(await names('out')).toEqual([]);

    expect(
      (await call('ann', 'PATCH', `/api/task-views/${sid}`, { name: 'Mine now' })).statusCode,
    ).toBe(403);
    expect(
      (await call('lead', 'PATCH', `/api/task-views/${sid}`, { name: 'Hunt 2' })).json().view.name,
    ).toBe('Hunt 2');
    expect((await call('root', 'DELETE', `/api/task-views/${sid}`)).statusCode).toBe(200);
    expect(await names('ann')).toEqual(['Mine']);
  });

  it('refuses a config it does not understand', async () => {
    const bad = { ...defaultViewConfig(), groupBy: 'mood' };
    expect(
      (await call('ann', 'POST', '/api/task-views', { name: 'Bad', config: bad })).statusCode,
    ).toBe(400);
  });
});
