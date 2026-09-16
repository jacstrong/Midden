/**
 * Load check for the op log: N clients on one case, each sending R ops/s over WebSocket.
 * Starts its own server on a temp data dir, seeds users through the API, reports ack latency.
 *
 *   node scripts/load-ws.ts [clients=20] [opsPerSec=5] [seconds=10]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';

const CLIENTS = Number(process.argv[2] ?? 20);
const RATE = Number(process.argv[3] ?? 5);
const SECONDS = Number(process.argv[4] ?? 10);
const PORT = 18095;
const BASE = `http://127.0.0.1:${PORT}`;
const H = { 'x-midden-client': '1', 'content-type': 'application/json' };

async function waitFor(url: string, ms: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

async function login(username: string, password: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0]!;
}

async function main(): Promise<void> {
  const data = mkdtempSync(join(tmpdir(), 'midden-load-'));
  const server = spawn(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', resolve(import.meta.dirname, '../dist/main.js')],
    {
      env: {
        ...process.env,
        MIDDEN_PORT: String(PORT),
        MIDDEN_HOST: '127.0.0.1',
        MIDDEN_DATA: data,
        MIDDEN_ADMIN_USER: 'admin',
        MIDDEN_ADMIN_PASSWORD: 'load-admin-pass',
        MIDDEN_ARGON2_MEMORY_KIB: '8192',
        MIDDEN_LOGIN_RATE_LIMIT: '10000',
        MIDDEN_LOG_LEVEL: 'error',
        MIDDEN_PUBLIC_DIR: '/nonexistent',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  try {
    await waitFor(`${BASE}/api/health`, 15_000);
    const admin = await login('admin', 'load-admin-pass');
    const cookies: string[] = [];
    for (let i = 0; i < CLIENTS; i++) {
      const username = `load${i}`;
      const password = `load-password-${i}`;
      await fetch(`${BASE}/api/users`, {
        method: 'POST',
        headers: { ...H, cookie: admin },
        body: JSON.stringify({ username, role: 'analyst', password }),
      });
      const c = await login(username, password);
      await fetch(`${BASE}/api/auth/password`, {
        method: 'POST',
        headers: { ...H, cookie: c },
        body: JSON.stringify({ next: password }),
      });
      cookies.push(c);
    }
    const created = await fetch(`${BASE}/api/cases`, {
      method: 'POST',
      headers: { ...H, cookie: admin },
      body: JSON.stringify({ name: 'Load' }),
    });
    const caseId = ((await created.json()) as { case: { id: string } }).case.id;

    const latencies: number[] = [];
    let received = 0;
    let rejected = 0;
    const sockets = await Promise.all(
      cookies.map(
        (cookie) =>
          new Promise<WebSocket>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws`, { headers: { cookie } });
            const sent = new Map<string, number>();
            ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', caseId, lastSeq: null })));
            ws.on('message', (d) => {
              const m = JSON.parse(String(d)) as { t: string; clientOpId?: string; seq?: number };
              if (m.t === 'snapshot') resolve(ws);
              if (m.t === 'op') received++;
              if (m.t === 'ack' && m.clientOpId) {
                const t0 = sent.get(m.clientOpId);
                if (t0 !== undefined) latencies.push(performance.now() - t0);
              }
              if (m.t === 'reject') rejected++;
            });
            ws.on('error', reject);
            (ws as WebSocket & { sentMap: Map<string, number> }).sentMap = sent;
          }),
      ),
    );

    const t0 = Date.now();
    let n = 0;
    const timers = sockets.map((ws, i) =>
      setInterval(() => {
        const id = `c${i}-${n++}`;
        (ws as WebSocket & { sentMap: Map<string, number> }).sentMap.set(id, performance.now());
        const op =
          n % 3 === 0
            ? {
                type: 'host.add',
                host: { id: `h-${i}-${n}`, name: `H${i}-${n}`, ip: `10.${i}.${n % 250}.1` },
              }
            : {
                type: 'event.add',
                event: {
                  id: `e-${i}-${n}`,
                  ts: new Date().toISOString(),
                  activity: `event ${n} from ${i}`,
                  hostId: `h-${i}-0`,
                },
              };
        ws.send(JSON.stringify({ t: 'op', clientOpId: id, baseSeq: 0, op }));
      }, 1000 / RATE),
    );
    await new Promise((r) => setTimeout(r, SECONDS * 1000));
    timers.forEach(clearInterval);
    await new Promise((r) => setTimeout(r, 1500));
    sockets.forEach((ws) => ws.close());
    const elapsed = (Date.now() - t0) / 1000;
    latencies.sort((a, b) => a - b);
    const pct = (p: number): number =>
      latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
    const opsSent = latencies.length;
    const mem = await (await fetch(`${BASE}/api/health`)).json();
    console.log(
      JSON.stringify(
        {
          clients: CLIENTS,
          opsPerSecPerClient: RATE,
          seconds: elapsed.toFixed(1),
          acked: opsSent,
          rejected,
          broadcastsReceived: received,
          throughputOpsPerSec: (opsSent / elapsed).toFixed(1),
          p50ms: pct(0.5).toFixed(1),
          p95ms: pct(0.95).toFixed(1),
          p99ms: pct(0.99).toFixed(1),
          maxMs: (latencies.at(-1) ?? 0).toFixed(1),
          health: mem,
        },
        null,
        2,
      ),
    );
    if (pct(0.95) > 200) {
      console.error(`FAIL: p95 ack latency ${pct(0.95).toFixed(1)}ms exceeds 200ms`);
      process.exitCode = 1;
    }
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
