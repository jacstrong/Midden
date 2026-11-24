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
  StatusCategorySchema,
  WorkflowStatusSchema,
  TaskCommentSchema,
  TaskOpSchema,
  TaskRunSchema,
  TaskSchema,
  TaskStateSchema,
  TaskViewConfigSchema,
  WorkflowSchema,
  GRID_KINDS,
  NOTIFY_KINDS,
  NotifyPrefsPatchSchema,
  WEBHOOK_EVENTS,
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
import {
  CommentBody,
  CreateRun,
  CreateTask,
  PatchRun,
  PatchTask,
  PutWorkflow,
  TaskListQuery,
} from '../tasks/routes.js';
import { CreateTeam, PatchTeam, TeamMemberBody } from '../teams/routes.js';
import { CreateTaskView, PatchTaskView } from '../tasks/viewRoutes.js';
import {
  CreatePlaybook,
  ExportQuery,
  ImportQuery,
  ImportTasks,
  PatchPlaybook,
  SaveRunAsPlaybook,
} from '../tasks/playbookRoutes.js';
import { CreateWebhook, MarkRead, NotificationQuery, PatchWebhook } from '../notify/routes.js';
import { InsightsQuery } from '../tasks/insights.js';

/** The version of the API contract, which is independent of the product's release number. */
export const API_VERSION = '1.0.0';

const WebhookDeliverySchema = z.object({
  id: z.string(),
  event: z.string().meta({ description: 'Comma-separated events, or `test`.' }),
  status: z.enum(['pending', 'ok', 'failed']),
  attempts: z.number().int(),
  nextAttemptAt: z.string().nullable(),
  lastStatus: z.number().int().nullable(),
  lastError: z.string(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  payload: z.unknown().meta({ description: 'The Rocket.Chat message that was sent.' }),
});

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
  Op: OpSchema,
  CaseState: CaseStateSchema,
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
  Team: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    createdAt: z.string(),
    members: z.array(
      z.object({
        userId: z.string(),
        role: z.enum(['lead', 'member']),
        username: z.string(),
        displayName: z.string(),
      }),
    ),
  }),
  Task: TaskSchema.extend({
    ref: z.string().meta({ description: 'The task number as people say it, e.g. `T-12`.' }),
    category: StatusCategorySchema,
    statusName: z.string(),
  }),
  TaskBrief: z.object({
    id: z.string(),
    ref: z.string(),
    title: z.string(),
    category: StatusCategorySchema,
  }),
  TaskComment: TaskCommentSchema,
  TaskRun: TaskRunSchema.extend({
    counts: z.record(StatusCategorySchema, z.number().int()),
    total: z.number().int(),
  }),
  Workflow: WorkflowSchema,
  TaskOp: TaskOpSchema,
  TaskState: TaskStateSchema,
  TaskOpRecord: z.object({
    seq: z.number().int(),
    ts: z.string(),
    actor: z.object({ id: z.string(), name: z.string() }),
    via: z.string().nullable(),
    type: z.string(),
    get op() {
      return TaskOpSchema;
    },
    get inverse() {
      return TaskOpSchema.nullable();
    },
    clientOpId: z.string().nullable(),
    baseSeq: z.number().int().nullable(),
  }),
  CreateTeam,
  PatchTeam,
  TeamMember: TeamMemberBody,
  CreateTask,
  PatchTask,
  Comment: CommentBody,
  CreateRun,
  PatchRun,
  PutWorkflow,
  TaskView: z.object({
    id: z.string(),
    name: z.string(),
    ownerId: z.string(),
    teamId: z
      .string()
      .meta({ description: 'The team it is shared with; empty for a personal view.' }),
    builtIn: z.boolean(),
    config: TaskViewConfigSchema,
  }),
  CreateTaskView,
  PatchTaskView,
  Playbook: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    teamId: z.string().meta({ description: 'Empty for a playbook every team can use.' }),
    statuses: z
      .array(WorkflowStatusSchema)
      .nullable()
      .meta({ description: 'Workflow for runs started from it; null uses the default.' }),
    version: z.number().int().meta({ description: 'Goes up when the CSV or workflow changes.' }),
    rows: z.number().int().meta({ description: 'Tasks in the CSV.' }),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedBy: z.string(),
    updatedAt: z.string(),
  }),
  CreatePlaybook,
  PatchPlaybook,
  SaveRunAsPlaybook,
  ImportTasks,
  ImportIssue: z.object({
    line: z.number().int().meta({ description: '0 for problems with the file as a whole.' }),
    severity: z.enum(['error', 'warning']),
    message: z.string(),
  }),
  Notification: z.object({
    id: z.string(),
    kind: z.enum(NOTIFY_KINDS).meta({ description: 'The most important of `kinds`.' }),
    kinds: z.array(z.enum(NOTIFY_KINDS)),
    tasks: z
      .array(z.object({ id: z.string(), num: z.number().int(), title: z.string() }))
      .meta({ description: 'Only tasks you can still see.' }),
    actors: z.array(z.object({ id: z.string(), name: z.string() })),
    comments: z.array(z.object({ id: z.string(), taskId: z.string(), excerpt: z.string() })),
    count: z.number().int().meta({ description: 'Changes folded into this notification.' }),
    createdAt: z.string(),
    updatedAt: z.string(),
    read: z.boolean(),
  }),
  NotifyPrefs: z.object({
    grid: z
      .record(
        z.enum(GRID_KINDS),
        z.object({
          assignee: z.boolean(),
          follower: z.boolean(),
          creator: z.boolean(),
          approver: z.boolean(),
        }),
      )
      .meta({ description: 'What happened × how you are related to the task.' }),
    queue: z.boolean().meta({ description: "Tell me about new tasks in my teams' queues." }),
    autoFollow: z.object({
      created: z.boolean(),
      assigned: z.boolean(),
      commented: z.boolean(),
      approver: z.boolean(),
    }),
  }),
  NotifyPrefsPatch: NotifyPrefsPatchSchema,
  MarkRead,
  WebhookDelivery: WebhookDeliverySchema,
  TaskInsights: (() => {
    const taskRef = { id: z.string(), num: z.number().int(), title: z.string() };
    const duration = z.object({
      count: z.number().int(),
      medianSec: z.number().nullable(),
      p90Sec: z.number().nullable(),
    });
    const cat = z.enum(['backlog', 'todo', 'in_progress', 'blocked', 'done', 'cancelled']);
    return z.object({
      now: z.string(),
      from: z.string(),
      to: z.string(),
      open: z.object({
        total: z.number().int(),
        byCategory: z.record(cat, z.number().int()).meta({
          description: 'Every task that is not archived, open or not, by status category.',
        }),
        overdue: z.number().int(),
        unassigned: z.number().int().meta({ description: 'Open, with no one and no team queue.' }),
      }),
      queues: z.array(
        z.object({ teamId: z.string(), open: z.number().int(), oldestAt: z.string() }),
      ),
      people: z.array(
        z.object({
          userId: z.string(),
          open: z.number().int(),
          inProgress: z.number().int(),
          blocked: z.number().int(),
          overdue: z.number().int(),
        }),
      ),
      throughput: z
        .array(z.object({ week: z.string(), created: z.number().int(), done: z.number().int() }))
        .meta({ description: 'One entry per week, starting Mondays (UTC).' }),
      cycle: duration.meta({
        description: 'First in progress to done, for tasks done in the window.',
      }),
      lead: duration.meta({ description: 'Created to done, for tasks done in the window.' }),
      stuck: z.array(
        z.object({
          ...taskRef,
          statusId: z.string(),
          category: cat,
          since: z.string(),
          assignees: z.array(z.string()),
        }),
      ),
      approvals: z.array(z.object({ ...taskRef, approverId: z.string(), since: z.string() })),
      burndown: z
        .object({
          runId: z.string(),
          points: z.array(
            z.object({ date: z.string(), total: z.number().int(), open: z.number().int() }),
          ),
        })
        .nullable(),
    });
  })(),
  Webhook: z.object({
    id: z.string(),
    teamId: z.string().meta({ description: 'Empty for a webhook that hears about every task.' }),
    name: z.string(),
    url: z.string().meta({ description: 'Masked; the full URL is never returned.' }),
    events: z.array(z.enum(WEBHOOK_EVENTS)),
    enabled: z.boolean(),
    createdBy: z.string(),
    createdAt: z.string(),
    updatedBy: z.string(),
    updatedAt: z.string(),
    last: WebhookDeliverySchema.nullable(),
  }),
  CreateWebhook,
  PatchWebhook,
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
  | 'Scans'
  | 'Files'
  | 'Teams'
  | 'Tasks'
  | 'Notifications'
  | 'Webhooks';

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
const TASK = '/api/tasks/{id}';
const SUBMITTED = z.object({
  seq: z.number().int(),
  overwrote: z.array(
    z.object({
      field: z.string(),
      bySeq: z.number().int(),
      byActor: z.object({ id: z.string(), name: z.string() }),
    }),
  ),
  duplicate: z.boolean(),
});

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

  {
    method: 'get',
    path: '/api/teams',
    tag: 'Teams',
    summary: 'List teams and their members',
    response: z.object({ teams: z.array(ref('Team')) }),
  },
  {
    method: 'post',
    path: '/api/teams',
    tag: 'Teams',
    summary: 'Create a team (admin)',
    body: 'CreateTeam',
    status: 201,
    response: z.object({ team: ref('Team') }),
  },
  {
    method: 'patch',
    path: '/api/teams/{id}',
    tag: 'Teams',
    summary: 'Rename or describe a team (admin)',
    body: 'PatchTeam',
    response: z.object({ team: ref('Team') }),
  },
  {
    method: 'delete',
    path: '/api/teams/{id}',
    tag: 'Teams',
    summary: 'Delete a team (admin)',
    description: 'Tasks keep their team id and show it as a deleted team.',
    response: ref('Ok'),
  },
  {
    method: 'put',
    path: '/api/teams/{id}/members/{userId}',
    tag: 'Teams',
    summary: 'Add a member or change their role',
    description:
      'Admins may do anything. A lead of the team may add and remove members, but not leads.',
    body: 'TeamMember',
    response: z.object({ team: ref('Team') }),
  },
  {
    method: 'delete',
    path: '/api/teams/{id}/members/{userId}',
    tag: 'Teams',
    summary: 'Remove a member',
    response: z.object({ team: ref('Team') }),
  },

  {
    method: 'get',
    path: '/api/task-views',
    tag: 'Tasks',
    summary: 'List your saved views and those shared with your teams',
    description:
      'Built-in views (My tasks, Everyone’s tasks, …) are part of the web client and not listed.',
    response: z.object({ views: z.array(ref('TaskView')) }),
  },
  {
    method: 'post',
    path: '/api/task-views',
    tag: 'Tasks',
    summary: 'Save a view',
    description: 'Give a `teamId` to share it with a team; only that team’s leads and admins may.',
    body: 'CreateTaskView',
    status: 201,
    response: z.object({ view: ref('TaskView') }),
  },
  {
    method: 'patch',
    path: '/api/task-views/{id}',
    tag: 'Tasks',
    summary: 'Change a saved view',
    description: 'Its owner may change a personal view; a lead of the team, a shared one.',
    body: 'PatchTaskView',
    response: z.object({ view: ref('TaskView') }),
  },
  {
    method: 'delete',
    path: '/api/task-views/{id}',
    tag: 'Tasks',
    summary: 'Delete a saved view',
    response: ref('Ok'),
  },

  {
    method: 'get',
    path: '/api/tasks',
    tag: 'Tasks',
    summary: 'Find tasks',
    description:
      'Newest first. Tasks linked to a restricted case are left out unless you can read that case.',
    query: TaskListQuery,
    response: z.object({
      tasks: z.array(ref('Task')),
      total: z.number().int(),
      seq: z.number().int(),
    }),
  },
  {
    method: 'post',
    path: '/api/tasks',
    tag: 'Tasks',
    summary: 'Create a task',
    body: 'CreateTask',
    status: 201,
    response: z.object({ task: ref('Task'), seq: z.number().int() }),
  },
  {
    method: 'get',
    path: '/api/tasks/state',
    tag: 'Tasks',
    summary: 'Every task, comment, run and workflow you can see',
    response: z.object({ seq: z.number().int(), state: ref('TaskState') }),
  },
  {
    method: 'get',
    path: TASK,
    tag: 'Tasks',
    summary: 'A task with its comments and dependencies',
    description: 'The id may also be a task number: `T-12` or `12`.',
    response: z.object({
      task: ref('Task'),
      comments: z.array(ref('TaskComment')),
      blockedBy: z.array(ref('TaskBrief')),
      blocking: z.array(ref('TaskBrief')),
    }),
  },
  {
    method: 'patch',
    path: TASK,
    tag: 'Tasks',
    summary: 'Change a task',
    description:
      'Moving a task to a done status fails while its approver has not approved it. Changing who is assigned here affects one task, so it needs no lead.',
    body: 'PatchTask',
    response: z.object({ task: ref('Task'), seq: z.number().int() }),
  },
  {
    method: 'post',
    path: `${TASK}/comments`,
    tag: 'Tasks',
    summary: 'Comment on a task',
    body: 'Comment',
    status: 201,
    response: z.object({ comment: ref('TaskComment'), seq: z.number().int() }),
  },
  {
    method: 'get',
    path: `${TASK}/history`,
    tag: 'Tasks',
    summary: "A task's history",
    response: z.object({ ops: z.array(ref('TaskOpRecord')) }),
  },
  {
    method: 'get',
    path: '/api/tasks/ops',
    tag: 'Tasks',
    summary: 'The task operation log',
    description: 'Operations touching a task you cannot see are left out.',
    query: z.object({
      after: z.coerce.number().int().optional().meta({ description: 'Return ops after this seq.' }),
      before: z.coerce
        .number()
        .int()
        .optional()
        .meta({ description: 'Return the newest ops before this seq.' }),
      limit: z.coerce.number().int().min(1).max(2000).default(200),
    }),
    response: z.object({ ops: z.array(ref('TaskOpRecord')), seq: z.number().int() }),
  },
  {
    method: 'post',
    path: '/api/tasks/ops',
    tag: 'Tasks',
    summary: 'Submit a task operation',
    description:
      'Takes any client operation from `TaskOpSchema`. Assigning more than one task in one operation takes a team lead or an admin. Send a `clientOpId` so a retry cannot apply twice.',
    body: 'SubmitOp',
    response: SUBMITTED,
  },
  {
    method: 'post',
    path: '/api/tasks/revert',
    tag: 'Tasks',
    summary: 'Undo a task operation',
    description: 'Applies the recorded inverse of that operation as a new one.',
    body: 'Revert',
    response: SUBMITTED,
  },
  {
    method: 'get',
    path: '/api/task-runs',
    tag: 'Tasks',
    summary: 'List runs (playbook instances) with progress',
    response: z.object({ runs: z.array(ref('TaskRun')) }),
  },
  {
    method: 'post',
    path: '/api/task-runs',
    tag: 'Tasks',
    summary: 'Start a run (team lead or admin)',
    description:
      'The run gets its own copy of a workflow, so its statuses can change without affecting others.',
    body: 'CreateRun',
    status: 201,
    response: z.object({ run: ref('TaskRun'), seq: z.number().int() }),
  },
  {
    method: 'patch',
    path: '/api/task-runs/{id}',
    tag: 'Tasks',
    summary: 'Rename, move or close a run (team lead or admin)',
    body: 'PatchRun',
    response: z.object({ run: ref('TaskRun'), seq: z.number().int() }),
  },
  {
    method: 'get',
    path: '/api/playbooks',
    tag: 'Tasks',
    summary: 'List playbooks',
    description:
      'Every signed-in user can read playbooks. The CSV itself comes with `GET /api/playbooks/{id}`.',
    response: z.object({ playbooks: z.array(ref('Playbook')) }),
  },
  {
    method: 'post',
    path: '/api/playbooks',
    tag: 'Tasks',
    summary: 'Save a playbook (team lead or admin)',
    description:
      'The CSV is checked for errors in the file itself; names of people, teams and cases are only resolved when a run is started from it. A playbook with no team takes an admin.',
    body: 'CreatePlaybook',
    status: 201,
    response: z.object({ playbook: ref('Playbook') }),
  },
  {
    method: 'get',
    path: '/api/playbooks/{id}',
    tag: 'Tasks',
    summary: 'Get a playbook with its CSV',
    response: z.object({ playbook: named.Playbook.extend({ csv: z.string() }) }),
  },
  {
    method: 'patch',
    path: '/api/playbooks/{id}',
    tag: 'Tasks',
    summary: 'Change a playbook (team lead or admin)',
    body: 'PatchPlaybook',
    response: z.object({ playbook: ref('Playbook') }),
  },
  {
    method: 'delete',
    path: '/api/playbooks/{id}',
    tag: 'Tasks',
    summary: 'Delete a playbook (team lead or admin)',
    description: 'Runs started from it keep their tasks.',
    response: ref('Ok'),
  },
  {
    method: 'post',
    path: '/api/task-runs/{id}/playbook',
    tag: 'Tasks',
    summary: 'Save a run as a playbook (team lead or admin)',
    description:
      "Due dates become offsets from the run's start, and by default statuses, ticks and assignees are cleared so the next hunt starts fresh. Case links are dropped, and tasks linked to a restricted case are left out (`skipped`), since a playbook is shared with the whole team.",
    body: 'SaveRunAsPlaybook',
    status: 201,
    response: z.object({ playbook: ref('Playbook'), skipped: z.number().int() }),
  },
  {
    method: 'post',
    path: '/api/tasks/import',
    tag: 'Tasks',
    summary: 'Import tasks from CSV or a playbook (team lead or admin)',
    description:
      "Starts a run (`run`) or adds to one (`runId`), as a single operation that undoes in one step. With `?preview=1` nothing changes: the response lists the tasks as they would be created and every problem found, including the ones the permission checks would raise. Status names the run's workflow lacks are listed in `unknownStatuses`; pass them back in `addStatuses` to add them. See the CSV format in the guide.",
    query: ImportQuery,
    body: 'ImportTasks',
    status: 201,
    response: z.union([
      z.object({
        run: ref('TaskRun'),
        created: z.number().int(),
        warnings: z.array(ref('ImportIssue')),
        seq: z.number().int(),
      }),
      z.object({
        ok: z.boolean(),
        issues: z.array(ref('ImportIssue')),
        unknownStatuses: z.array(z.string()),
        run: z.object({
          id: z.string(),
          name: z.string(),
          teamId: z.string(),
          startDate: z.string(),
        }),
        workflow: z.object({ name: z.string(), statuses: z.array(WorkflowStatusSchema) }),
        tasks: z.array(
          z.object({
            line: z.number().int(),
            key: z.string(),
            title: z.string(),
            status: z.string(),
            category: StatusCategorySchema,
            priority: z.string(),
            assignees: z.array(z.string()),
            team: z.string(),
            labels: z.array(z.string()),
            dueAt: z.string(),
            blockedBy: z.array(z.string()),
            checklist: z.number().int(),
            approver: z.string(),
            case: z.string(),
          }),
        ),
      }),
    ]),
  },
  {
    method: 'get',
    path: '/api/tasks/export',
    tag: 'Tasks',
    summary: 'Export tasks as CSV',
    description:
      "Takes the same filters as `GET /api/tasks` and writes the import format, so an export can be imported again. Cells that start with `= + - @` get a leading `'` so spreadsheets do not run them as formulas; import removes it.",
    query: ExportQuery,
    response: { contentType: 'text/csv', description: 'The tasks in the playbook CSV format.' },
  },
  {
    method: 'get',
    path: '/api/workflows',
    tag: 'Tasks',
    summary: 'List workflows',
    response: z.object({ workflows: z.array(ref('Workflow')), defaultWorkflowId: z.string() }),
  },
  {
    method: 'put',
    path: '/api/workflows/{id}',
    tag: 'Tasks',
    summary: 'Create or replace a workflow',
    description:
      "The default workflow takes an admin; a run's workflow takes a lead of the run's team. Every task must still have a status in its workflow afterwards.",
    body: 'PutWorkflow',
    response: z.object({ workflow: ref('Workflow'), seq: z.number().int() }),
  },
  {
    method: 'get',
    path: '/api/tasks/insights',
    tag: 'Tasks',
    summary: 'Open work, throughput, cycle time and what is stuck',
    description:
      'Counted over the tasks you can see: a task linked to a restricted case you cannot read is left out of every number. Archived tasks count toward throughput and cycle time but not open work. Give `run` for its burndown.',
    query: InsightsQuery,
    response: z.object({ insights: ref('TaskInsights') }),
  },
  {
    method: 'get',
    path: '/api/metrics',
    tag: 'Meta',
    summary: 'Prometheus metrics',
    description:
      'Off unless the server sets `MIDDEN_METRICS=token`; then it needs an API token belonging to an admin (read-only is enough). Text exposition format 0.0.4. Labels name status categories and teams, never people, cases or tasks. See the metrics guide.',
    response: { contentType: 'text/plain', description: 'Prometheus text format.' },
  },
  {
    method: 'get',
    path: '/api/notifications',
    tag: 'Notifications',
    summary: 'Your notifications, newest first',
    description:
      'Changes to one task within two minutes fold into one unread notification, and a bulk change is one notification listing every task. Tasks you can no longer see drop out, and a notification left with none is not listed or counted. Page with `before` set to the last `updatedAt`.',
    query: NotificationQuery,
    response: z.object({ notifications: z.array(ref('Notification')), unread: z.number().int() }),
  },
  {
    method: 'post',
    path: '/api/notifications/read',
    tag: 'Notifications',
    summary: 'Mark notifications read',
    body: 'MarkRead',
    response: z.object({ unread: z.number().int() }),
  },
  {
    method: 'get',
    path: '/api/notifications/prefs',
    tag: 'Notifications',
    summary: 'Your notification preferences',
    description:
      'Being assigned, @mentioned or asked to approve always notifies you; the grid covers everything else. Your own changes never notify you.',
    response: z.object({ prefs: ref('NotifyPrefs'), defaults: ref('NotifyPrefs') }),
  },
  {
    method: 'patch',
    path: '/api/notifications/prefs',
    tag: 'Notifications',
    summary: 'Change your notification preferences',
    description: 'Send only what changes; everything else keeps its value.',
    body: 'NotifyPrefsPatch',
    response: z.object({ prefs: ref('NotifyPrefs') }),
  },
  {
    method: 'get',
    path: '/api/webhooks',
    tag: 'Webhooks',
    summary: 'Webhooks you manage',
    description:
      "Admins see every webhook; team leads see their teams'. `allowedHosts` is the server's MIDDEN_WEBHOOK_ALLOWED_HOSTS: webhooks can only post there, and are off when it is empty.",
    response: z.object({
      webhooks: z.array(ref('Webhook')),
      allowedHosts: z.array(z.string()),
      origin: z.string().nullable(),
    }),
  },
  {
    method: 'post',
    path: '/api/webhooks',
    tag: 'Webhooks',
    summary: 'Add a webhook (team lead or admin)',
    description:
      "Posts Rocket.Chat incoming-webhook messages (Slack and Mattermost accept them too). A team's webhook hears about tasks on that team or in its runs; one with no team (admins only) hears about every task. Tasks linked to a restricted case are described by number only.",
    body: 'CreateWebhook',
    status: 201,
    response: z.object({ webhook: ref('Webhook') }),
  },
  {
    method: 'patch',
    path: '/api/webhooks/{id}',
    tag: 'Webhooks',
    summary: 'Change a webhook',
    description: 'Leave out `url` to keep the current one.',
    body: 'PatchWebhook',
    response: z.object({ webhook: ref('Webhook') }),
  },
  {
    method: 'delete',
    path: '/api/webhooks/{id}',
    tag: 'Webhooks',
    summary: 'Delete a webhook',
    response: ref('Ok'),
  },
  {
    method: 'post',
    path: '/api/webhooks/{id}/test',
    tag: 'Webhooks',
    summary: 'Send a test message now',
    description: 'Waits for the attempt and returns it. A failed test is not retried.',
    response: z.object({ delivery: ref('WebhookDelivery') }),
  },
  {
    method: 'get',
    path: '/api/webhooks/{id}/deliveries',
    tag: 'Webhooks',
    summary: 'Recent deliveries',
    description:
      'The last 50, newest first. Failed sends are retried after 30 s, 2 min, 10 min, 30 min and 2 h, then marked failed.',
    response: z.object({ deliveries: z.array(ref('WebhookDelivery')) }),
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
      { name: 'Scans', description: 'Uploaded nmap scans and the terrain they map.' },
      { name: 'Files', description: 'Evidence attached to events and hosts.' },
      { name: 'Teams', description: 'Analyst teams and their leads.' },
      { name: 'Tasks', description: 'Task management, outside cases: tasks, runs and workflows.' },
      {
        name: 'Notifications',
        description: 'Your inbox and what you are told about. Browser sessions only.',
      },
      {
        name: 'Webhooks',
        description:
          'Chat messages (Rocket.Chat format) about task changes, per team or for every task.',
      },
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
