import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { addUser, as, login, testApp } from '../test/helpers.js';
import { renderReference } from './render.js';
import { documentedRoutes, openApiDocument, responseSchemas } from './spec.js';

const docsFile = (name: string): string =>
  readFileSync(new URL(`../../../../docs/${name}`, import.meta.url), 'utf8');

/** Every `$ref` anywhere in a document. */
function refs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => refs(n, out));
  else if (node && typeof node === 'object')
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else refs(v, out);
    }
  return out;
}

describe('the API description', () => {
  let app: FastifyInstance;
  let ann: string;
  let caseId: string;
  beforeEach(async () => {
    app = testApp();
    addUser(app, 'ann');
    await app.ready();
    ann = await login(app, 'ann');
    const c = await app.inject({
      method: 'POST',
      url: '/api/cases',
      ...as(ann),
      payload: { name: 'Described' },
    });
    caseId = c.json().case.id as string;
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents exactly the routes the server has', () => {
    // The sign-on redirects only exist on a server with OIDC configured.
    const onlyWithOidc = ['GET /api/auth/oidc/start', 'GET /api/auth/oidc/callback'];
    const documented = documentedRoutes().filter((r) => !onlyWithOidc.includes(r));
    expect(documented.sort()).toEqual([...new Set(app.apiRoutes)].sort());
  });

  it('is served without signing in', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toBe('3.1.0');
  });

  it('only refers to schemas it defines', () => {
    const doc = openApiDocument() as { components: { schemas: Record<string, unknown> } };
    const all = refs(doc);
    expect(all.length).toBeGreaterThan(20);
    for (const r of all) {
      expect(r).toMatch(/^#\/components\/schemas\//);
      expect(doc.components.schemas).toHaveProperty(r.replace('#/components/schemas/', ''));
    }
  });

  it('marks what tokens may reach, from the rule that enforces it', () => {
    const doc = openApiDocument() as {
      paths: Record<string, Record<string, { 'x-midden-token': string }>>;
    };
    const token = (p: string, m: string): string | undefined =>
      doc.paths[p]?.[m]?.['x-midden-token'];
    expect(token('/api/cases', 'get')).toBe('read');
    expect(token('/api/cases', 'post')).toBe('write');
    expect(token('/api/tokens', 'post')).toBe('none');
    expect(token('/api/admin/backup', 'get')).toBe('none');
    expect(token('/api/health', 'get')).toBe('open');
  });

  it('describes what the server really returns', async () => {
    const get = async (url: string): Promise<unknown> => {
      const res = await app.inject({ method: 'GET', url, ...as(ann) });
      expect(res.statusCode, url).toBe(200);
      return res.json();
    };
    const s = responseSchemas;
    s.Health.parse(await app.inject({ method: 'GET', url: '/api/health' }).then((r) => r.json()));
    s.CaseSummary.strict().parse(((await get(`/api/cases/${caseId}`)) as { case: unknown }).case);
    s.CaseState.parse(((await get(`/api/cases/${caseId}/state`)) as { state: unknown }).state);
    const ops = (await get(`/api/cases/${caseId}/ops`)) as { ops: unknown[] };
    expect(ops.ops.length).toBeGreaterThan(0);
    for (const op of ops.ops) s.OpRecord.strict().parse(op);
    const created = await app.inject({
      method: 'POST',
      url: '/api/tokens',
      ...as(ann),
      payload: { name: 'doc' },
    });
    s.ApiToken.strict().parse(created.json().record);
    const me = (await get('/api/auth/me')) as { user: unknown };
    s.User.strict().parse(me.user);
    const bad = await app.inject({ method: 'GET', url: `/api/cases/nope`, ...as(ann) });
    s.Error.parse(bad.json());
  });

  it('matches the copies in docs/; run `pnpm docs:api` if this fails', () => {
    expect(JSON.parse(docsFile('openapi.json'))).toEqual(openApiDocument());
    expect(docsFile('api-reference.md')).toBe(renderReference(openApiDocument()));
  });
});
