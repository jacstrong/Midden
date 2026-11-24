/**
 * Seeds a hosted data dir for trying Midden by hand: five users (an admin, a lead, two analysts,
 * a viewer), two teams, a case, a run and a few tasks. The generated password is written to
 * <dir>/test-users.txt. `pnpm dev` runs this for you when the folder has no database yet.
 *
 *   pnpm seed:dev                  seed data/dev (refuses if it already has a database)
 *   pnpm seed:dev --if-missing     seed only if there's no database yet (what `pnpm dev` does)
 *   pnpm dev:reset                 delete data/dev and seed it again
 *   pnpm seed:dev some/other/dir   seed another folder
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { loadConfig } from '../packages/server/src/config.ts';
import { openDatabase } from '../packages/server/src/db/db.ts';
import { buildApp } from '../packages/server/src/app.ts';
import { createUser } from '../packages/server/src/auth/sessions.ts';
import { hashPassword } from '../packages/server/src/auth/password.ts';

const repo = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
for (const f of flags)
  if (f !== '--if-missing' && f !== '--reset') {
    console.error(`Unknown option ${f}. Use --if-missing or --reset.`);
    process.exit(2);
  }
// The same folder the dev server uses: MIDDEN_DATA if set, else data/dev.
const dir = resolve(
  args.find((a) => !a.startsWith('--')) ?? process.env.MIDDEN_DATA ?? join(repo, 'data', 'dev'),
);
const shown = relative(process.cwd(), dir) || '.';
const dbFile = join(dir, 'midden.db');

if (flags.has('--reset') && existsSync(dir)) {
  // Only ever delete a folder under the repo's gitignored data/, never a path typed by mistake.
  if (!dir.startsWith(join(repo, 'data') + sep)) {
    console.error(
      `--reset only deletes folders inside ${join(repo, 'data')}. Delete ${shown} yourself.`,
    );
    process.exit(2);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`Deleted ${shown}`);
} else if (existsSync(dbFile)) {
  if (flags.has('--if-missing')) process.exit(0);
  console.error(
    `${shown} already has a database. Run \`pnpm dev:reset\` to delete it and seed it again.`,
  );
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
const cfg = loadConfig({ ...process.env, MIDDEN_DATA: dir, MIDDEN_ARGON2_MEMORY_KIB: '8192' });
const db = openDatabase(join(dir, 'midden.db'));
const app = buildApp({ db, cfg, logger: false, version: 'dev' });
await app.ready();
const password = randomBytes(12).toString('base64url');
const hash = hashPassword(password, { memory: 8192, passes: 3, parallelism: 1, tagLength: 32 });
const id: Record<string, string> = {};
for (const [u, name, role] of [
  ['root', 'Root Admin', 'admin'],
  ['lena', 'Lena Lead', 'analyst'],
  ['ann', 'Ann Analyst', 'analyst'],
  ['bob', 'Bob Network', 'analyst'],
  ['vic', 'Vic Viewer', 'viewer'],
] as const)
  id[u] = createUser(db, {
    username: u,
    displayName: name,
    role,
    passwordHash: hash,
    mustChangePassword: false,
  }).id;

const cookie = async (u: string) => {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-midden-client': '1' },
    payload: { username: u, password },
  });
  if (r.statusCode !== 200) throw new Error(r.body);
  const c = r.cookies.find((x) => x.name === 'midden_session')!;
  return `${c.name}=${c.value}`;
};
const call = async (c: string, method: string, url: string, payload?: unknown) => {
  const r = await app.inject({
    method: method as 'GET',
    url,
    headers: { cookie: c, 'x-midden-client': '1' },
    ...(payload ? { payload } : {}),
  });
  if (r.statusCode >= 300) throw new Error(`${method} ${url}: ${r.body}`);
  return r.json();
};
const root = await cookie('root');
const lena = await cookie('lena');
const host = (
  await call(root, 'POST', '/api/teams', { name: 'Host', description: 'Host analysis cell' })
).team.id;
const net = (
  await call(root, 'POST', '/api/teams', { name: 'Network', description: 'Network analysis cell' })
).team.id;
await call(root, 'PUT', `/api/teams/${host}/members/${id.lena}`, { role: 'lead' });
await call(root, 'PUT', `/api/teams/${host}/members/${id.ann}`, { role: 'member' });
await call(root, 'PUT', `/api/teams/${net}/members/${id.bob}`, { role: 'lead' });
const kase = (await call(lena, 'POST', '/api/cases', { name: 'Op NIGHTJAR', number: 'CASE-0042' }))
  .case.id;
const run = (
  await call(lena, 'POST', '/api/task-runs', { name: 'Hunt 2026-11 kickoff', teamId: host })
).run.id;
const mk = (b: object) => call(lena, 'POST', '/api/tasks', b);
const a = (
  await mk({
    title: 'Pull EDR telemetry for the enclave',
    runId: run,
    teamId: host,
    assignees: [id.ann],
    priority: 'high',
    checklist: ['Confirm sensor coverage', 'Export last 30 days', 'Hash the export'],
  })
).task;
const b = (
  await mk({
    title: 'Baseline scheduled tasks on DCs',
    runId: run,
    teamId: host,
    blockedBy: [a.id],
    caseId: kase,
  })
).task;
await mk({
  title: 'Review persistence on jump hosts',
  runId: run,
  teamId: host,
  status: 'in_progress',
  assignees: [id.lena],
  description: `Depends on ${'T-' + b.num}. Ask @ann about the GPO export.`,
});
await mk({
  title: 'Disable legacy SMBv1 on file server',
  runId: run,
  teamId: host,
  approverId: id.root,
  priority: 'urgent',
  assignees: [id.ann],
});
await mk({ title: 'Zeek: hunt for long-lived DNS sessions', teamId: net, assignees: [id.bob] });
await mk({ title: 'Write up kickoff notes', status: 'done' });
writeFileSync(
  join(dir, 'test-users.txt'),
  `Local dev test users (root lena ann bob vic), password: ${password}\n`,
  { mode: 0o600 },
);
await app.close();
db.close();
console.log(`Seeded ${shown}: users root (admin), lena (Host lead), ann, bob (Network lead) and vic
(viewer), all with the password in ${join(shown, 'test-users.txt')}.`);
