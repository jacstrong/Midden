/**
 * The OpenAPI description of Midden's HTTP API, served at /api/openapi.json and rendered into
 * docs/. Request schemas are the same zod objects the routes validate with, and token access is
 * read from `tokenMayUse`, so neither can drift. openapi.test.ts fails if a route is missing
 * here or a documented route does not exist, and checks response schemas against real responses.
 */
import { z } from 'zod';
import {
  AttachmentMetaSchema,
  CaseStateSchema,
  EventSchema,
  HostSchema,
  OpSchema,
  ScanMetaSchema,
  TaskCommentSchema,
  TaskSchema,
} from '@midden/core';
import { CreateTokenBody } from '../auth/tokenRoutes.js';
import { tokenMayUse } from '../auth/tokens.js';
import { CreateUser, Login, PatchUser, Password } from '../auth/routes.js';
import {
  CreateCase,
  ImportBody,
  MemberRole,
  PatchCase,
  Revert,
  SubmitOp,
} from '../cases/routes.js';
import { HostsQuery, MapQuery } from '../terrain/routes.js';
import { MarkRead, NotificationsQuery } from '../tasks/routes.js';

/** The version of the API contract, which is independent of the product's release number. */
export const API_VERSION = '1.0.0';

const named = {
  Error: z.object({ error: z.object({ code: z.string(), message: z.string() }) }),
  Ok: z.object({ ok: z.literal(true) }),
  Health: z.object({
    ok: z.boolean(),
    version: z.string(),
    node: z.string(),
    arch: z.string(),
    sqlite: z.string(),
    argon2: z.boolean(),
    diskFreeMb: z.number().nullable(),
  }),
  User: z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    role: z.enum(['admin', 'analyst', 'viewer']),
    disabled: z.boolean(),
    mustChangePassword: z.boolean(),
    createdAt: z.string(),
    hasPassword: z.boolean(),
  }),
  ApiToken: z.object({
    id: z.string(),
    name: z.string(),
    prefix: z.string().meta({ description: 'The first characters, to recognise the token by.' }),
    scope: z.enum(['read', 'write']),
    createdAt: z.string(),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
  }),
  CaseAccess: z.object({
    read: z.boolean(),
    edit: z.boolean(),
    manage: z.boolean(),
    role: z.enum(['owner', 'editor', 'viewer', 'admin', 'open']).nullable(),
  }),
  CaseSummary: z.object({
    id: z.string(),
    name: z.string(),
    number: z.string(),
    analyst: z.string(),
    classification: z.string(),
    createdAt: z.string(),
    modifiedAt: z.string(),
    archivedAt: z.string().nullable(),
    restricted: z.boolean(),
    seq: z.number().int().meta({ description: 'The sequence number of the latest operation.' }),
    hosts: z.number().int(),
    events: z.number().int(),
    get access() {
      return named.CaseAccess;
    },
  }),
  OpRecord: z.object({
    seq: z.number().int(),
    ts: z.string(),
    actor: z.object({ id: z.string(), name: z.string() }),
    via: z
      .string()
      .nullable()
      .meta({ description: 'The name of the API token that made this change, if one did.' }),
    type: z.string(),
    get op() {
      return OpSchema;
    },
    get inverse() {
      return OpSchema.nullable();
    },
    clientOpId: z.string().nullable(),
    baseSeq: z.number().int().nullable(),
  }),
  TerrainHost: z.looseObject({
    ip: z.string(),
    hostnames: z.array(z.string()),
    state: z.string(),
    osName: z.string(),
    bucket: z.string(),
    role: z.string(),
    flags: z.array(z.string()),
    openCount: z.number().int(),
    ports: z.array(z.looseObject({ port: z.number().int(), proto: z.string(), name: z.string() })),
  }),
  Notification: z.object({
    id: z.string(),
    caseId: z.string(),
    caseName: z.string(),
    taskId: z
      .string()
      .nullable()
      .meta({ description: 'Null when the notice sums up a change to several tasks.' }),
    seq: z.number().int().meta({ description: 'The operation that caused it.' }),
    kind: z.enum([
      'assigned',
      'unassigned',
      'status',
      'updated',
      'commented',
      'deleted',
      'summary',
    ]),
    actor: z.object({ id: z.string(), name: z.string() }),
    text: z.string().meta({ description: 'What happened, to follow the actor name.' }),
    createdAt: z.string(),
    readAt: z.string().nullable(),
  }),
  Op: OpSchema,
  CaseState: CaseStateSchema,
  Task: TaskSchema,
  TaskComment: TaskCommentSchema,
  Event: EventSchema,
  Host: HostSchema,
  ScanMeta: ScanMetaSchema,
  AttachmentMeta: AttachmentMetaSchema,
  CreateCase,
  PatchCase,
  SubmitOp,
  Revert,
  ImportBody,
  MemberRole,
  Login,
  Password,
  CreateUser,
  PatchUser,
  CreateToken: CreateTokenBody,
  MarkRead,
};

/** Response schemas, exported so the tests can hold real responses to them. */
export const responseSchemas = named;

type Tag =
  | 'Meta'
  | 'Auth'
  | 'Tokens'
  | 'Users'
  | 'Admin'
  | 'Cases'
  | 'History'
  | 'Tasks'
  | 'Scans'
  | 'Files';

interface RouteDoc {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  tag: Tag;
  summary: string;
  description?: string;
  /** No sign-in needed. */
  open?: boolean;
  query?: z.ZodObject;
  /** A named schema from `named`, or a `{ field: named-or-inline }` response object. */
  body?: keyof typeof named;
  multipart?: Record<string, { description: string; required?: boolean; binary?: boolean }>;
  /** Success status. Default 200. */
  status?: number;
  response?: z.ZodType | { contentType: string; description: string };
}

const ref = (name: keyof typeof named) => named[name];
const CASE = '/api/cases/{id}';
const SCAN = `${CASE}/scans/{scanId}`;

const routes: RouteDoc[] = [
  {
    method: 'get',
    path: '/api/health',
    tag: 'Meta',
    open: true,
    summary: 'Server health and versions',
    response: ref('Health'),
  },
  {
    method: 'get',
    path: '/api/openapi.json',
    tag: 'Meta',
    open: true,
    summary: 'This API description',
    response: { contentType: 'application/json', description: 'An OpenAPI 3.1 document.' },
  },
  {
    method: 'get',
    path: '/api/ws',
    tag: 'Meta',
    summary: 'Live updates over a WebSocket',
    description:
      'Upgrades to a WebSocket. Send `{"t":"hello","caseId":"...","lastSeq":null}` to join a case, then receive a snapshot and every later operation. The messages are defined by `ClientMessageSchema` and `ServerMessage` in `packages/core/src/sync/protocol.ts`. Read tokens may watch, and any operation they send is rejected.',
    status: 101,
    response: { contentType: 'text/plain', description: 'Switches to the WebSocket protocol.' },
  },

  {
    method: 'post',
    path: '/api/mcp',
    tag: 'Meta',
    summary: 'Model Context Protocol endpoint for AI agents',
    description:
      'Speaks JSON-RPC over the stateless form of the Streamable HTTP transport, and takes an API token only, never a session. See the MCP guide.',
    response: { contentType: 'application/json', description: 'A JSON-RPC response.' },
  },
  {
    method: 'get',
    path: '/api/mcp',
    tag: 'Meta',
    summary: 'Not supported; this endpoint has no server-sent stream',
    status: 405,
    response: { contentType: 'application/json', description: 'Always refused.' },
  },
  {
    method: 'delete',
    path: '/api/mcp',
    tag: 'Meta',
    summary: 'Not supported; this endpoint has no sessions to end',
    status: 405,
    response: { contentType: 'application/json', description: 'Always refused.' },
  },

  {
    method: 'post',
    path: '/api/auth/login',
    tag: 'Auth',
    open: true,
    summary: 'Sign in and receive a session cookie',
    body: 'Login',
    response: z.object({ user: ref('User'), mustChangePassword: z.boolean() }),
  },
  {
    method: 'post',
    path: '/api/auth/logout',
    tag: 'Auth',
    open: true,
    summary: 'End the session',
    response: ref('Ok'),
  },
  {
    method: 'get',
    path: '/api/auth/me',
    tag: 'Auth',
    summary: 'Who am I',
    response: z.object({
      user: ref('User'),
      mustChangePassword: z.boolean(),
      openCases: z.boolean(),
      oidc: z.boolean(),
    }),
  },
  {
    method: 'post',
    path: '/api/auth/password',
    tag: 'Auth',
    summary: 'Change your password',
    body: 'Password',
    response: ref('Ok'),
  },
  {
    method: 'get',
    path: '/api/auth/oidc/enabled',
    tag: 'Auth',
    open: true,
    summary: 'Whether single sign-on is configured',
    response: z.object({ enabled: z.boolean(), issuer: z.string().nullable() }),
  },
  {
    method: 'get',
    path: '/api/auth/oidc/start',
    tag: 'Auth',
    open: true,
    summary: 'Begin single sign-on',
    status: 302,
    response: { contentType: 'text/plain', description: 'Redirects to the identity provider.' },
  },
  {
    method: 'get',
    path: '/api/auth/oidc/callback',
    tag: 'Auth',
    open: true,
    summary: 'Return from single sign-on',
    status: 302,
    response: { contentType: 'text/plain', description: 'Redirects back into the app.' },
  },

  {
    method: 'get',
    path: '/api/tokens',
    tag: 'Tokens',
    summary: 'List your API tokens',
    response: z.object({ tokens: z.array(ref('ApiToken')) }),
  },
  {
    method: 'post',
    path: '/api/tokens',
    tag: 'Tokens',
    summary: 'Create an API token',
    description: 'The `token` value is returned only here and cannot be read back.',
    body: 'CreateToken',
    status: 201,
    response: z.object({ token: z.string(), record: ref('ApiToken') }),
  },
  {
    method: 'delete',
    path: '/api/tokens/{id}',
    tag: 'Tokens',
    summary: 'Revoke an API token',
    response: ref('Ok'),
  },

  {
    method: 'get',
    path: '/api/users',
    tag: 'Users',
    summary: 'List users',
    response: z.object({ users: z.array(ref('User')) }),
  },
  {
    method: 'post',
    path: '/api/users',
    tag: 'Users',
    summary: 'Create a user (admin)',
    body: 'CreateUser',
    status: 201,
    response: z.object({ user: ref('User'), temporaryPassword: z.string().optional() }),
  },
  {
    method: 'patch',
    path: '/api/users/{id}',
    tag: 'Users',
    summary: 'Update a user (admin)',
    description: 'Disabling a user or resetting their password revokes their API tokens.',
    body: 'PatchUser',
    response: z.object({ user: ref('User') }),
  },

  {
    method: 'get',
    path: '/api/admin/stats',
    tag: 'Admin',
    summary: 'Row counts (admin)',
    response: z.object({
      users: z.number().int(),
      cases: z.number().int(),
      ops: z.number().int(),
      events: z.number().int(),
      sessions: z.number().int(),
    }),
  },
  {
    method: 'get',
    path: '/api/admin/backup',
    tag: 'Admin',
    summary: 'Download a consistent database backup (admin)',
    response: { contentType: 'application/octet-stream', description: 'A SQLite database file.' },
  },

  {
    method: 'get',
    path: '/api/cases',
    tag: 'Cases',
    summary: 'List the cases you can read',
    query: z.object({
      archived: z.enum(['1']).optional().meta({ description: 'Set to 1 to list archived cases.' }),
    }),
    response: z.object({ cases: z.array(ref('CaseSummary')) }),
  },
  {
    method: 'post',
    path: '/api/cases',
    tag: 'Cases',
    summary: 'Create a case',
    body: 'CreateCase',
    status: 201,
    response: z.object({ case: ref('CaseSummary') }),
  },
  {
    method: 'get',
    path: CASE,
    tag: 'Cases',
    summary: 'A case and its members',
    response: z.object({
      case: ref('CaseSummary'),
      members: z.array(
        z.object({
          userId: z.string(),
          role: z.enum(['owner', 'editor', 'viewer']),
          displayName: z.string(),
          username: z.string(),
        }),
      ),
    }),
  },
  {
    method: 'patch',
    path: CASE,
    tag: 'Cases',
    summary: 'Archive or restrict a case',
    body: 'PatchCase',
    response: z.object({ case: ref('CaseSummary') }),
  },
  {
    method: 'delete',
    path: CASE,
    tag: 'Cases',
    summary: 'Permanently delete a case (admin)',
    response: ref('Ok'),
  },
  {
    method: 'get',
    path: `${CASE}/state`,
    tag: 'Cases',
    summary: 'The full current state of a case',
    response: z.object({ seq: z.number().int(), state: ref('CaseState') }),
  },
  {
    method: 'get',
    path: `${CASE}/export`,
    tag: 'Cases',
    summary: 'Export a case file',
    description: 'The same `.json` file the standalone app opens and saves.',
    response: { contentType: 'application/json', description: 'A Midden case file.' },
  },
  {
    method: 'post',
    path: `${CASE}/import`,
    tag: 'Cases',
    summary: 'Merge a case file into a case',
    body: 'ImportBody',
    response: z.object({ seq: z.number().int(), report: z.unknown() }),
  },
  {
    method: 'put',
    path: `${CASE}/members/{userId}`,
    tag: 'Cases',
    summary: 'Add a member or change their role',
    body: 'MemberRole',
    response: ref('Ok'),
  },
  {
    method: 'delete',
    path: `${CASE}/members/{userId}`,
    tag: 'Cases',
    summary: 'Remove a member',
    response: ref('Ok'),
  },

  {
    method: 'get',
    path: `${CASE}/ops`,
    tag: 'History',
    summary: 'The operation log',
    description: 'The audit trail of every change. Add `format=csv` to download it as a CSV.',
    query: z.object({
      after: z.coerce.number().int().optional().meta({ description: 'Return ops after this seq.' }),
      before: z.coerce
        .number()
        .int()
        .optional()
        .meta({ description: 'Return the newest ops before this seq.' }),
      limit: z.coerce.number().int().min(1).max(2000).default(200),
      format: z.enum(['csv']).optional(),
    }),
    response: z.object({ ops: z.array(ref('OpRecord')), seq: z.number().int() }),
  },
  {
    method: 'post',
    path: `${CASE}/ops`,
    tag: 'History',
    summary: 'Submit an operation',
    description:
      'The way to change a case. Send a `clientOpId` so a retry cannot apply twice. Send `baseSeq`, the seq you last saw, to hear in `overwrote` which fields someone else changed since.',
    body: 'SubmitOp',
    response: z.object({
      seq: z.number().int(),
      overwrote: z.array(
        z.object({
          field: z.string(),
          bySeq: z.number().int(),
          byActor: z.object({ id: z.string(), name: z.string() }),
        }),
      ),
      duplicate: z.boolean(),
    }),
  },
  {
    method: 'post',
    path: `${CASE}/revert`,
    tag: 'History',
    summary: 'Undo an operation',
    description: 'Appends a new operation that reverses the old one. Nothing is erased.',
    body: 'Revert',
    response: z.object({ seq: z.number().int() }),
  },

  {
    method: 'get',
    path: `${CASE}/people`,
    tag: 'Tasks',
    summary: 'The people who can be assigned tasks in a case',
    description:
      'Everyone with an enabled account who can read the case. `canEdit` says whether they can also move their own cards.',
    response: z.object({
      people: z.array(
        z.object({
          id: z.string(),
          username: z.string(),
          displayName: z.string(),
          canEdit: z.boolean(),
        }),
      ),
    }),
  },
  {
    method: 'get',
    path: `${CASE}/follows`,
    tag: 'Tasks',
    summary: 'Who follows which task',
    response: z.object({
      follows: z.array(z.object({ taskId: z.string(), userId: z.string() })),
    }),
  },
  {
    method: 'put',
    path: `${CASE}/tasks/{taskId}/follow`,
    tag: 'Tasks',
    summary: 'Follow a task',
    description:
      'Followers are notified of every change to the task, as its assignees are. Read access is enough, so a viewer can follow work too.',
    response: ref('Ok'),
  },
  {
    method: 'delete',
    path: `${CASE}/tasks/{taskId}/follow`,
    tag: 'Tasks',
    summary: 'Stop following a task',
    response: ref('Ok'),
  },
  {
    method: 'get',
    path: '/api/notifications',
    tag: 'Tasks',
    summary: 'Your notices about tasks, newest first',
    description:
      'Notices also arrive live over the WebSocket as `{"t":"notify"}` messages. Notices from cases you can no longer read are left out.',
    query: NotificationsQuery,
    response: z.object({
      notifications: z.array(ref('Notification')),
      unread: z.number().int(),
    }),
  },
  {
    method: 'post',
    path: '/api/notifications/read',
    tag: 'Tasks',
    summary: 'Mark notices as read',
    body: 'MarkRead',
    response: z.object({ ok: z.literal(true), unread: z.number().int() }),
  },

  {
    method: 'get',
    path: `${CASE}/scans`,
    tag: 'Scans',
    summary: 'List scans',
    response: z.object({
      scans: z.array(z.object({ ...ScanMetaSchema.shape, hostCount: z.number().int() })),
    }),
  },
  {
    method: 'post',
    path: `${CASE}/scans`,
    tag: 'Scans',
    summary: 'Upload an nmap scan',
    description:
      'Takes nmap XML or normal output. Parsing happens in the background: the scan starts as `parsing`, so poll the list or watch the WebSocket until it is `ready` or `failed`.',
    multipart: {
      file: { description: 'The scan output.', required: true, binary: true },
      name: { description: 'A display name.' },
      phase: { description: '`discovery`, `service` or `other`. Inferred if left out.' },
    },
    status: 201,
    response: z.object({ scan: ref('ScanMeta') }),
  },
  {
    method: 'delete',
    path: SCAN,
    tag: 'Scans',
    summary: 'Delete a scan',
    response: ref('Ok'),
  },
  {
    method: 'get',
    path: `${SCAN}/hosts`,
    tag: 'Scans',
    summary: 'Page through the hosts in a scan',
    description: 'Pass the returned `next` value as `after` to get the next page.',
    query: HostsQuery,
    response: z.object({ items: z.array(ref('TerrainHost')), next: z.string().nullable() }),
  },
  {
    method: 'get',
    path: `${SCAN}/hosts/{ip}`,
    tag: 'Scans',
    summary: 'One host, with ports, scripts and traceroute',
    response: z.object({ host: ref('TerrainHost') }),
  },
  {
    method: 'get',
    path: `${SCAN}/map`,
    tag: 'Scans',
    summary: 'The aggregated network map',
    query: MapQuery,
    response: { contentType: 'application/json', description: 'The subnet or traceroute layout.' },
  },
  {
    method: 'get',
    path: `${SCAN}/targets.txt`,
    tag: 'Scans',
    summary: 'The addresses of hosts that are up, one per line',
    response: { contentType: 'text/plain', description: 'One IP address per line.' },
  },
  {
    method: 'get',
    path: `${SCAN}/raw`,
    tag: 'Scans',
    summary: 'The original scan file',
    response: { contentType: 'application/xml', description: 'The file as it was uploaded.' },
  },

  {
    method: 'get',
    path: `${CASE}/attachments`,
    tag: 'Files',
    summary: 'List attachments',
    response: z.object({ attachments: z.array(ref('AttachmentMeta')) }),
  },
  {
    method: 'post',
    path: `${CASE}/attachments`,
    tag: 'Files',
    summary: 'Attach a file to an event or host',
    multipart: {
      file: { description: 'The file.', required: true, binary: true },
      targetKind: { description: '`event` or `host`.', required: true },
      targetId: { description: 'The id of that event or host.', required: true },
      note: { description: 'An analyst note.' },
      dangerous: { description: 'Set to `1` to flag the file as dangerous yourself.' },
    },
    status: 201,
    response: z.object({ attachment: ref('AttachmentMeta'), dangerReason: z.string().nullable() }),
  },
  {
    method: 'get',
    path: `${CASE}/attachments/{attId}`,
    tag: 'Files',
    summary: 'Download an attachment',
    description:
      'A dangerous file never leaves the server bare. It comes as an encrypted zip with the password `infected`.',
    response: { contentType: 'application/octet-stream', description: 'The file.' },
  },
  {
    method: 'delete',
    path: `${CASE}/attachments/{attId}`,
    tag: 'Files',
    summary: 'Delete an attachment',
    response: ref('Ok'),
  },
];

/** What kind of token, if any, may call a route. Read from the rule that enforces it. */
export function tokenAccess(method: string, fastifyPath: string): 'read' | 'write' | 'none' {
  const verb = method.toUpperCase();
  if (!tokenMayUse('read', verb, fastifyPath)) return 'read';
  if (!tokenMayUse('write', verb, fastifyPath)) return 'write';
  return 'none';
}

const toFastifyPath = (p: string): string => p.replace(/\{(\w+)\}/g, ':$1');

/** `METHOD /api/path` for every documented route, in Fastify's spelling. */
export const documentedRoutes = (): string[] =>
  routes.map((r) => `${r.method.toUpperCase()} ${toFastifyPath(r.path)}`);

type Json = Record<string, unknown>;

let cached: Json | null = null;

/** A schema written out on its own refers to named schemas locally; send those to components. */
function pointAtComponents(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(pointAtComponents);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) =>
      k === '$ref' && typeof v === 'string'
        ? [k, v.replace('#/$defs/', '#/components/schemas/')]
        : [k, pointAtComponents(v)],
    ),
  );
}

export function openApiDocument(): Json {
  if (cached) return cached;

  // Named schemas become components that refer to each other, and the recursive Op refers to
  // itself. Anything unnamed is written out inline where it is used.
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(named)) registry.add(schema, { id });
  const inline = (schema: z.ZodType, io: 'input' | 'output'): Json => {
    const js = z.toJSONSchema(schema, { metadata: registry, io, unrepresentable: 'any' }) as Json;
    const { $schema: _s, $defs: _d, ...rest } = js;
    return pointAtComponents(rest) as Json;
  };
  const all = z.toJSONSchema(registry, {
    io: 'input',
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Json> };
  const schemas: Record<string, Json> = {};
  for (const [id, js] of Object.entries(all.schemas)) {
    const { $schema: _s, $id: _i, ...rest } = js;
    schemas[id] = rest;
  }

  const paths: Record<string, Json> = {};
  for (const r of routes) {
    const access = tokenAccess(r.method, toFastifyPath(r.path));
    const parameters: Json[] = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    if (r.query) {
      const q = inline(r.query, 'input') as {
        properties?: Record<string, Json>;
        required?: string[];
      };
      for (const [name, schema] of Object.entries(q.properties ?? {})) {
        const { description, ...rest } = schema as Json & { description?: string };
        parameters.push({
          name,
          in: 'query',
          required: q.required?.includes(name) ?? false,
          ...(description ? { description } : {}),
          schema: rest,
        });
      }
    }

    const op: Json = {
      tags: [r.tag],
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      operationId: `${r.method}_${r.path.replace(/^\/api\//, '').replace(/[^\w]+/g, '_')}`.replace(
        /_$/,
        '',
      ),
      'x-midden-token': r.open ? 'open' : access,
      security: r.open
        ? []
        : access === 'none'
          ? [{ session: [] }]
          : [{ session: [] }, { token: [] }],
      ...(parameters.length ? { parameters } : {}),
    };
    if (r.body)
      op.requestBody = {
        required: true,
        content: {
          'application/json': { schema: { $ref: `#/components/schemas/${r.body}` } },
        },
      };
    if (r.multipart) {
      const properties: Record<string, Json> = {};
      const required: string[] = [];
      for (const [name, f] of Object.entries(r.multipart)) {
        properties[name] = {
          type: 'string',
          description: f.description,
          ...(f.binary ? { format: 'binary' } : {}),
        };
        if (f.required) required.push(name);
      }
      op.requestBody = {
        required: true,
        content: { 'multipart/form-data': { schema: { type: 'object', properties, required } } },
      };
    }

    const success =
      r.response && 'contentType' in r.response
        ? {
            description: r.response.description,
            content: { [r.response.contentType]: {} },
          }
        : {
            description: 'Success',
            ...(r.response
              ? {
                  content: {
                    'application/json': { schema: inline(r.response as z.ZodType, 'output') },
                  },
                }
              : {}),
          };
    op.responses = {
      [String(r.status ?? 200)]: success,
      default: {
        description: 'An error',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    };
    (paths[r.path] ??= {})[r.method] = op;
  }

  cached = {
    openapi: '3.1.0',
    info: {
      title: 'Midden API',
      version: API_VERSION,
      description:
        'Everything the Midden web client does goes through this API. See the API guide for authentication, conventions and examples.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: '/', description: 'This Midden server' }],
    tags: [
      { name: 'Meta', description: 'Health, this document and live updates.' },
      { name: 'Auth', description: 'Signing in. Scripts should use an API token instead.' },
      { name: 'Tokens', description: 'Credentials for scripts and agents.' },
      { name: 'Users', description: 'Accounts.' },
      { name: 'Admin', description: 'Server administration.' },
      { name: 'Cases', description: 'Investigations.' },
      { name: 'History', description: 'The operation log: how a case changes.' },
      {
        name: 'Tasks',
        description:
          'Who can be assigned work, who follows it, and notices. Tasks themselves are changed with `task.*` and `comment.*` operations.',
      },
      { name: 'Scans', description: 'Uploaded nmap scans and the terrain they map.' },
      { name: 'Files', description: 'Evidence attached to events and hosts.' },
    ],
    paths,
    components: {
      securitySchemes: {
        token: {
          type: 'http',
          scheme: 'bearer',
          description: 'An API token, sent as `Authorization: Bearer mdn_...`.',
        },
        session: {
          type: 'apiKey',
          in: 'cookie',
          name: 'midden_session',
          description:
            'A browser session. Requests that change anything must also send an `X-Midden-Client` header.',
        },
      },
      schemas,
    },
  };
  return cached;
}
