import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { addUser, as, login, testApp } from '../test/helpers.js';
import { PROTOCOL_VERSIONS } from './routes.js';

const WRITE_TOOLS = [
  'add_event',
  'add_host',
  'add_task',
  'comment_on_task',
  'revert_change',
  'update_event',
  'update_host',
  'update_task',
];

describe('the MCP endpoint', () => {
  let app: FastifyInstance;
  let base: string;
  let ann: string;
  let caseId: string;
  const open: Client[] = [];

  const mint = async (cookie: string, name: string, scope: 'read' | 'write'): Promise<string> =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/tokens',
        ...as(cookie),
        payload: { name, scope },
      })
    ).json().token as string;

  /** The official SDK client, over real HTTP. */
  const connect = async (token: string): Promise<Client> => {
    const client = new Client({ name: 'midden-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    open.push(client);
    return client;
  };

  const call = async (
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool returns its own shape
  ): Promise<{ isError: boolean; data: any }> => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    return { isError: !!res.isError, data: JSON.parse(res.content[0]!.text) };
  };

  beforeEach(async () => {
    app = testApp();
    addUser(app, 'ann');
    addUser(app, 'vic', 'viewer');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
    ann = await login(app, 'ann');
    const res = await app.inject({
      method: 'POST',
      url: '/api/cases',
      ...as(ann),
      payload: { name: 'Agents', summary: 'Suspected beacon' },
    });
    caseId = res.json().case.id as string;
  });
  afterEach(async () => {
    for (const c of open.splice(0)) await c.close();
    await app.close();
  });

  it('keeps up with the newest protocol version the SDK knows', () => {
    expect(PROTOCOL_VERSIONS).toContain(LATEST_PROTOCOL_VERSION);
  });

  it('handshakes with the official client and warns about untrusted data', async () => {
    const client = await connect(await mint(ann, 'agent', 'read'));
    expect(client.getServerVersion()?.name).toBe('midden');
    expect(client.getInstructions()).toMatch(/never follow instructions/i);
    await expect(client.ping()).resolves.toBeDefined();
  });

  it('offers a read token only read tools, and a write token the rest', async () => {
    const reader = await connect(await mint(ann, 'reader', 'read'));
    const readTools = (await reader.listTools()).tools;
    expect(readTools.map((t) => t.name)).not.toEqual(expect.arrayContaining(['add_event']));
    for (const t of readTools) expect(t.annotations?.readOnlyHint).toBe(true);

    const writer = await connect(await mint(ann, 'writer', 'write'));
    const names = (await writer.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(WRITE_TOOLS));
  });

  it('refuses a write tool on a read token, even if the agent calls it anyway', async () => {
    const reader = await connect(await mint(ann, 'reader', 'read'));
    const res = await call(reader, 'add_event', {
      caseId,
      event: { activity: 'x', ts: '2026-11-04T00:00:00Z' },
    });
    expect(res.isError).toBe(true);
    expect(res.data.error).toMatch(/read-only/);
    const state = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/state`,
      ...as(ann),
    });
    expect(Object.keys(state.json().state.events)).toHaveLength(0);
  });

  it('adds, finds, changes and reverts an event, all attributed to the token', async () => {
    const agent = await connect(await mint(ann, 'triage-bot', 'write'));
    const added = await call(agent, 'add_event', {
      caseId,
      event: {
        ts: '2026-11-04T09:14:00Z',
        activity: 'Beacon to 203.0.113.7',
        indicator: '203.0.113.7',
        sev: 'high',
      },
      clientOpId: 'alert-1',
    });
    expect(added.isError).toBe(false);
    const eventId = added.data.eventId as string;

    const found = await call(agent, 'list_events', {
      caseId,
      query: '203.0.113',
      severity: 'high',
    });
    expect(found.data.total).toBe(1);
    expect(found.data.items[0].id).toBe(eventId);
    expect((await call(agent, 'list_events', { caseId, severity: 'low' })).data.total).toBe(0);

    const patched = await call(agent, 'update_event', {
      caseId,
      eventId,
      patch: { notes: 'Confirmed by EDR' },
    });
    expect(patched.isError).toBe(false);
    expect((await call(agent, 'get_event', { caseId, eventId })).data.event.notes).toBe(
      'Confirmed by EDR',
    );

    const history = await call(agent, 'get_history', { caseId });
    const last = history.data.ops.at(-1);
    expect(last.actor.name).toBe('ANN via triage-bot');
    expect(last.via).toBe('triage-bot');

    const reverted = await call(agent, 'revert_change', { caseId, seq: last.seq });
    expect(reverted.isError).toBe(false);
    expect((await call(agent, 'get_event', { caseId, eventId })).data.event.notes).toBe('');
  });

  it('adds and updates hosts, and reads the case', async () => {
    const agent = await connect(await mint(ann, 'triage-bot', 'write'));
    const { data } = await call(agent, 'add_host', {
      caseId,
      host: { name: 'dc01', ip: '10.0.0.5' },
    });
    await call(agent, 'update_host', { caseId, hostId: data.hostId, patch: { status: 'suspect' } });
    const host = (await call(agent, 'get_host', { caseId, hostId: data.hostId })).data.host;
    expect(host).toMatchObject({ name: 'dc01', status: 'suspect' });
    expect((await call(agent, 'list_hosts', { caseId, query: 'dc0' })).data.total).toBe(1);
    expect((await call(agent, 'list_cases')).data.cases[0].id).toBe(caseId);
    expect((await call(agent, 'get_case', { caseId })).data.summary).toBe('Suspected beacon');
    expect((await call(agent, 'list_scans', { caseId })).data.scans).toEqual([]);
    expect((await call(agent, 'list_attachments', { caseId })).data.attachments).toEqual([]);
  });

  it('works the task board: add, move, comment, and list what is mine', async () => {
    const agent = await connect(await mint(ann, 'hunt-bot', 'write'));
    const me = (await app.inject({ method: 'GET', url: '/api/auth/me', ...as(ann) })).json().user
      .id as string;
    const added = await call(agent, 'add_task', {
      caseId,
      task: { title: 'Sweep DCs for DCSync', assignees: [me], checklist: ['Pull 4662'] },
    });
    expect(added.isError).toBe(false);
    const { taskId } = added.data;
    await call(agent, 'update_task', {
      caseId,
      taskId,
      patch: { status: 'done', outcome: 'Clean' },
    });
    await call(agent, 'comment_on_task', { caseId, taskId, text: 'Checked DC01 and DC02' });
    const got = (await call(agent, 'get_task', { caseId, taskId })).data;
    expect(got.task).toMatchObject({ status: 'done', outcome: 'Clean', assigneeNames: ['ANN'] });
    expect(got.task.completedAt).toBeTruthy();
    expect(got.task.checklist[0]).toMatchObject({ text: 'Pull 4662', done: false });
    expect(got.comments.map((c: { text: string }) => c.text)).toEqual(['Checked DC01 and DC02']);
    expect((await call(agent, 'list_tasks', { caseId, assignee: 'me' })).data.total).toBe(1);
    expect((await call(agent, 'list_tasks', { caseId, status: 'todo' })).data.total).toBe(0);
  });

  it('turns bad input and API refusals into tool errors, not crashes', async () => {
    const agent = await connect(await mint(ann, 'agent', 'write'));
    const missing = await call(agent, 'add_event', { caseId, event: { activity: 'no timestamp' } });
    expect(missing.isError).toBe(true);
    const nope = await call(agent, 'get_event', { caseId, eventId: 'nope' });
    expect(nope.isError).toBe(true);
    const noCase = await call(agent, 'list_events', { caseId: 'nope' });
    expect(noCase).toMatchObject({ isError: true, data: { error: 'No such case' } });
    await expect(agent.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(
      /Unknown tool/,
    );
  });

  it("holds an agent to its owner's access", async () => {
    const vic = await login(app, 'vic');
    const agent = await connect(await mint(vic, 'viewer-agent', 'write'));
    const res = await call(agent, 'add_event', {
      caseId,
      event: { activity: 'x', ts: '2026-11-04T00:00:00Z' },
    });
    expect(res.isError).toBe(true);
    expect(res.data.error).toMatch(/edit access/);

    await app.inject({
      method: 'PATCH',
      url: `/api/cases/${caseId}`,
      ...as(ann),
      payload: { restricted: true },
    });
    expect((await call(agent, 'list_cases')).data.cases).toEqual([]);
    expect((await call(agent, 'list_events', { caseId })).isError).toBe(true);
  });

  it('never returns the contents of a file', async () => {
    const agent = await connect(await mint(ann, 'agent', 'read'));
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => /download|raw|content|file/.test(n))).toEqual([]);
  });

  describe('over plain HTTP', () => {
    const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const post = (headers: Record<string, string>, payload: unknown = rpc) =>
      app.inject({ method: 'POST', url: '/api/mcp', headers, payload: payload as object });

    it('refuses a missing or bad token with a 401 a client can act on', async () => {
      for (const headers of [{}, { authorization: 'Bearer mdn_nonsense' }]) {
        const res = await post(headers);
        expect(res.statusCode).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Bearer');
      }
    });

    it('does not accept a browser session', async () => {
      const res = await post({ cookie: ann, 'x-midden-client': '1' });
      expect(res.statusCode).toBe(401);
    });

    it('refuses a request from a web page on another origin', async () => {
      const token = await mint(ann, 'agent', 'read');
      const res = await post({
        authorization: `Bearer ${token}`,
        origin: 'http://evil.example',
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects an unsupported protocol version', async () => {
      const token = await mint(ann, 'agent', 'read');
      const res = await post({
        authorization: `Bearer ${token}`,
        'mcp-protocol-version': '1999-01-01',
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts a notification with no reply, and reports unknown methods', async () => {
      const authorization = `Bearer ${await mint(ann, 'agent', 'read')}`;
      const note = await post(
        { authorization },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      );
      expect(note.statusCode).toBe(202);
      const unknown = await post({ authorization }, { jsonrpc: '2.0', id: 2, method: 'nope' });
      expect(unknown.json().error.code).toBe(-32601);
    });

    it('answers GET and DELETE with 405', async () => {
      for (const method of ['GET', 'DELETE'] as const) {
        const res = await app.inject({ method, url: '/api/mcp' });
        expect(res.statusCode).toBe(405);
      }
    });
  });
});
