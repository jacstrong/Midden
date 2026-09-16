import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { demoCaseState, writeCaseFile } from '@midden/core';
import { addUser, as, login, testApp } from '../test/helpers.js';

describe('case routes', () => {
  let app: FastifyInstance;
  let admin: string;
  let ann: string;
  let bob: string;
  let vic: string;
  beforeEach(async () => {
    app = testApp();
    addUser(app, 'admin', 'admin');
    addUser(app, 'ann');
    addUser(app, 'bob');
    addUser(app, 'vic', 'viewer');
    await app.ready();
    admin = await login(app, 'admin');
    ann = await login(app, 'ann');
    bob = await login(app, 'bob');
    vic = await login(app, 'vic');
  });
  afterEach(async () => {
    await app.close();
  });

  const create = async (
    cookie: string,
    body: object = { name: 'Op Test', number: 'IR-1' },
  ): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/cases',
      ...as(cookie),
      payload: body,
    });
    expect(res.statusCode).toBe(201);
    return res.json().case.id as string;
  };

  it('creates a case with an owner and a first case.set op, and lists it', async () => {
    const id = await create(ann);
    const list = await app.inject({ method: 'GET', url: '/api/cases', ...as(bob) });
    expect(list.json().cases.map((c: { id: string }) => c.id)).toEqual([id]);
    expect(list.json().cases[0].access).toMatchObject({
      read: true,
      edit: true,
      manage: false,
      role: 'open',
    });
    const ops = await app.inject({ method: 'GET', url: `/api/cases/${id}/ops`, ...as(bob) });
    expect(ops.json().ops).toHaveLength(1);
    expect(ops.json().ops[0]).toMatchObject({ seq: 1, type: 'case.set', actor: { name: 'ANN' } });
    const st = await app.inject({ method: 'GET', url: `/api/cases/${id}/state`, ...as(bob) });
    expect(st.json().state.case.name).toBe('Op Test');
    expect(
      (await app.inject({ method: 'POST', url: '/api/cases', ...as(vic), payload: { name: 'x' } }))
        .statusCode,
    ).toBe(403);
  });

  it('enforces open/restricted access and membership', async () => {
    const id = await create(ann, { name: 'Secret', restricted: true });
    expect(
      (await app.inject({ method: 'GET', url: `/api/cases/${id}`, ...as(bob) })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/api/cases/${id}`, ...as(admin) })).statusCode,
    ).toBe(200);
    // bob cannot add himself
    const bobId = (await app.inject({ method: 'GET', url: '/api/auth/me', ...as(bob) })).json().user
      .id as string;
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/cases/${id}/members/${bobId}`,
          ...as(bob),
          payload: { role: 'editor' },
        })
      ).statusCode,
    ).toBe(404);
    // owner adds bob as viewer: can read, cannot edit
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/cases/${id}/members/${bobId}`,
          ...as(ann),
          payload: { role: 'viewer' },
        })
      ).statusCode,
    ).toBe(200);
    const asBob = await app.inject({ method: 'GET', url: `/api/cases/${id}`, ...as(bob) });
    expect(asBob.json().case.access).toMatchObject({ read: true, edit: false, role: 'viewer' });
    const denied = await app.inject({
      method: 'POST',
      url: `/api/cases/${id}/ops`,
      ...as(bob),
      payload: { op: { type: 'noop' } },
    });
    expect(denied.statusCode).toBe(403);
    // global viewer on an open case: read only
    const open = await create(ann);
    const v = await app.inject({ method: 'GET', url: `/api/cases/${open}`, ...as(vic) });
    expect(v.json().case.access).toMatchObject({ read: true, edit: false });
    // archived cases are read-only even for the owner
    await app.inject({
      method: 'PATCH',
      url: `/api/cases/${open}`,
      ...as(ann),
      payload: { archived: true },
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/cases/${open}/ops`,
          ...as(ann),
          payload: { op: { type: 'noop' } },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: 'GET', url: '/api/cases?archived=1', ...as(ann) })).json().cases,
    ).toHaveLength(1);
  });

  it('accepts ops over REST, exposes history with inverses, reverts, exports and imports', async () => {
    const id = await create(ann);
    const add = await app.inject({
      method: 'POST',
      url: `/api/cases/${id}/ops`,
      ...as(ann),
      payload: {
        op: { type: 'host.add', host: { id: 'h1', name: 'WKS' } },
        clientOpId: 'k1',
        baseSeq: 1,
      },
    });
    expect(add.json()).toMatchObject({ seq: 2, overwrote: [], duplicate: false });
    const again = await app.inject({
      method: 'POST',
      url: `/api/cases/${id}/ops`,
      ...as(ann),
      payload: {
        op: { type: 'host.add', host: { id: 'h1', name: 'WKS' } },
        clientOpId: 'k1',
        baseSeq: 1,
      },
    });
    expect(again.json()).toMatchObject({ seq: 2, duplicate: true });
    const set = await app.inject({
      method: 'POST',
      url: `/api/cases/${id}/ops`,
      ...as(bob),
      payload: { op: { type: 'host.set', id: 'h1', patch: { status: 'compromised' } }, baseSeq: 2 },
    });
    expect(set.json().seq).toBe(3);
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/cases/${id}/ops`,
      ...as(ann),
      payload: { op: { type: 'host.set', id: 'h1', patch: { status: 'clean' } }, baseSeq: 2 },
    });
    expect(conflict.json().overwrote).toEqual([
      { field: 'h1/status', bySeq: 3, byActor: { id: expect.any(String), name: 'BOB' } },
    ]);

    const hist = await app.inject({
      method: 'GET',
      url: `/api/cases/${id}/ops?after=1`,
      ...as(vic),
    });
    expect(hist.json().ops.map((o: { type: string }) => o.type)).toEqual([
      'host.add',
      'host.set',
      'host.set',
    ]);
    expect(hist.json().ops[2].inverse).toEqual({
      type: 'host.set',
      id: 'h1',
      patch: { status: 'compromised' },
    });
    const csv = await app.inject({
      method: 'GET',
      url: `/api/cases/${id}/ops?format=csv`,
      ...as(vic),
    });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\r\n')).toHaveLength(5);

    const rev = await app.inject({
      method: 'POST',
      url: `/api/cases/${id}/revert`,
      ...as(ann),
      payload: { seq: 4 },
    });
    expect(rev.json().seq).toBe(5);
    const st = await app.inject({ method: 'GET', url: `/api/cases/${id}/state`, ...as(ann) });
    expect(st.json().state.hosts.h1.status).toBe('compromised');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/cases/${id}/revert`,
          ...as(vic),
          payload: { seq: 4 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/cases/${id}/ops`,
          ...as(ann),
          payload: { op: { type: 'host.set', id: 'nope', patch: {} } },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/cases/${id}/ops`,
          ...as(ann),
          payload: { op: { type: 'bogus' } },
        })
      ).statusCode,
    ).toBe(400);

    const imp = await app.inject({
      method: 'POST',
      url: `/api/cases/${id}/import`,
      ...as(ann),
      payload: { file: writeCaseFile(demoCaseState()) },
    });
    expect(imp.json().report.events).toBe(14);
    const exp = await app.inject({ method: 'GET', url: `/api/cases/${id}/export`, ...as(vic) });
    expect(exp.json().schema).toBe('midden.case.v2');
    expect(exp.json().events).toHaveLength(14);
    expect(exp.json().hosts).toHaveLength(6);
  });

  it('serves health and a 404 for unknown API paths', async () => {
    const h = await app.inject({ method: 'GET', url: '/api/health' });
    expect(h.json()).toMatchObject({ ok: true, argon2: true });
    expect((await app.inject({ method: 'GET', url: '/api/nothing' })).statusCode).toBe(404);
  });
});
