<script setup lang="ts">
import { ref } from 'vue';
import { withBase } from 'vitepress';

const REPO = 'https://github.com/jacstrong/Midden';
const IMAGE = 'ghcr.io/jacstrong/midden:latest';

// The quick start from docs/deploy.md, split into tokens so it can be coloured like a shell.
type Tok = [kind: 'cmd' | 'flag' | 'env' | 'str' | 'img' | 'txt', text: string];
const lines: Tok[][] = [
  [
    ['cmd', 'docker run'],
    ['flag', ' -d --name'],
    ['txt', ' midden \\'],
  ],
  [
    ['flag', '  -p'],
    ['txt', ' 8080:8080 \\'],
  ],
  [
    ['flag', '  -v'],
    ['str', ' "$PWD/midden-data:/data"'],
    ['txt', ' \\'],
  ],
  [
    ['flag', '  -e'],
    ['env', ' MIDDEN_SECRET'],
    ['txt', '='],
    ['str', '"$(openssl rand -base64 32)"'],
    ['txt', ' \\'],
  ],
  [
    ['flag', '  -e'],
    ['env', ' MIDDEN_ADMIN_USER'],
    ['txt', '=admin \\'],
  ],
  [
    ['flag', '  -e'],
    ['env', ' MIDDEN_ADMIN_PASSWORD'],
    ['txt', '='],
    ['str', "'choose something long'"],
    ['txt', ' \\'],
  ],
  [['img', `  ${IMAGE}`]],
];
const command = lines.map((l) => l.map(([, t]) => t).join('')).join('\n');

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
async function copy() {
  try {
    await navigator.clipboard.writeText(command);
    copied.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied.value = false), 1800);
  } catch {
    // Clipboard refused (insecure context or permissions); the text is still selectable.
  }
}

// An illustrative case in the shape of the app's branch graph: one lane per host, ordered by
// when the adversary first reached it, with a branch wherever activity pivoted. Colours are the
// ATT&CK tactic colours from packages/core/src/domain/reference.ts.
const T = {
  initial: '#ff2e88',
  exec: '#ff6b3d',
  persist: '#ffb020',
  privesc: '#ff4d5e',
  evasion: '#9d6bff',
  cred: '#22e8ff',
  disc: '#4dff9a',
  lateral: '#00d1b8',
  collect: '#a0d911',
  c2: '#ff2ed4',
  exfil: '#ff8c00',
};
const lanes = [
  { name: 'WEB-01', ip: '10.20.4.15', y: 44, from: 96, status: '#ff4d5e' },
  { name: 'WS-114', ip: '10.20.31.114', y: 100, from: 268, status: '#ff4d5e' },
  { name: 'FS-02', ip: '10.20.8.22', y: 156, from: 396, status: '#ffb020' },
  { name: 'DC-01', ip: '10.20.8.10', y: 212, from: 452, status: '#ffb020' },
];
const events = [
  { x: 96, lane: 0, c: T.initial },
  { x: 136, lane: 0, c: T.exec },
  { x: 176, lane: 0, c: T.persist },
  { x: 216, lane: 0, c: T.cred },
  { x: 268, lane: 1, c: T.lateral },
  { x: 308, lane: 1, c: T.disc },
  { x: 348, lane: 1, c: T.privesc },
  { x: 396, lane: 2, c: T.lateral },
  { x: 452, lane: 3, c: T.lateral },
  { x: 436, lane: 2, c: T.collect },
  { x: 492, lane: 3, c: T.cred },
  { x: 476, lane: 2, c: T.c2 },
  { x: 532, lane: 2, c: T.exfil, sel: true },
  { x: 540, lane: 3, c: T.evasion },
];
const pivots = [
  { x1: 216, l1: 0, x2: 268, l2: 1 },
  { x1: 348, l1: 1, x2: 396, l2: 2 },
  { x1: 348, l1: 1, x2: 452, l2: 3 },
];
const pivotPath = (p: (typeof pivots)[number]) => {
  const y1 = lanes[p.l1]!.y;
  const y2 = lanes[p.l2]!.y;
  const mx = (p.x1 + p.x2) / 2;
  return `M${p.x1},${y1} C${mx},${y1} ${mx},${y2} ${p.x2 - 7},${y2}`;
};

const ways = [
  {
    key: 'hosted',
    title: 'Hosted',
    tag: 'Docker',
    accent: 'var(--cy)',
    points: [
      'One container with the database, file store and web client inside.',
      'About twenty analysts on one case at once, each seeing the others’ changes as they happen.',
      'Runs on a laptop or a Raspberry Pi 4/5. Images for amd64 and arm64.',
    ],
  },
  {
    key: 'standalone',
    title: 'Standalone',
    tag: 'Single .html',
    accent: 'var(--vi)',
    points: [
      'One file. No server, no storage, no network calls.',
      'Open it from disk, work, save a .json, reopen it later.',
      'Parses nmap scans in the page.',
    ],
  },
];

const features = [
  {
    k: 'Timeline + branch graph',
    c: 'var(--cy)',
    d: 'One lane per host, ordered by when the adversary first reached it, with a branch wherever activity pivoted. Read every event in UTC, your local time, or the source system’s own timezone.',
  },
  {
    k: 'Hosts, indicators, ATT&CK',
    c: 'var(--mg)',
    d: 'Indicators are deduplicated across the case with every sighting kept. Techniques roll up into the Enterprise matrix.',
  },
  {
    k: 'Terrain from nmap',
    c: 'var(--gr)',
    d: 'Upload -oX or -oN output for a searchable inventory and a network map: a hub per subnet, case hosts overlaid by status. Promote a scanned host in one click.',
  },
  {
    k: 'Scan builder',
    c: 'var(--am)',
    d: 'Composes nmap commands for the two-phase workflow: find live hosts, then service-scan exactly those. Every command it can produce is checked against real nmap in CI.',
  },
  {
    k: 'Evidence',
    c: 'var(--vi)',
    d: 'Screenshots, log excerpts and small captures attach to events and hosts. Content-addressed, and only recognised image formats ever render inline.',
  },
  {
    k: 'Reports',
    c: '#00d1b8',
    d: 'HTML, Markdown, a timeline CSV and an indicator list, assembled from the case.',
  },
  {
    k: 'History',
    c: 'var(--rd)',
    d: 'Every change is an operation with an actor and a time. See before and after, and revert anything.',
  },
];

const principles = [
  {
    k: 'Operation log',
    d: 'Every change is recorded with who made it and when. Live collaboration, the history view and revert are one mechanism, not three.',
  },
  {
    k: 'Per-field last write wins',
    d: 'Editors send only the fields that changed, so two analysts on the same host both keep their work. On a real collision the loser is told who overwrote what.',
  },
  {
    k: 'Terrain beside the log',
    d: 'A /16 scan is 65,000 hosts. Scans are bulk-loaded and paged; case status is overlaid by address, so recolouring the map needs no round trip.',
  },
  {
    k: 'Zero native modules',
    d: 'SQLite and argon2id come from Node itself. The arm64 image is the same JavaScript as amd64.',
  },
  {
    k: 'One volume',
    d: '/data holds the database and every file. Copy it and you have copied the installation.',
  },
];
</script>

<template>
  <div class="landing">
    <!-- ======== hero ======== -->
    <section class="hero">
      <div class="hero-text">
        <p class="kicker">
          <i class="dot" />Cyber hunt <s>//</s> DCO attack reconstruction <s>//</s> Terrain mapping
        </p>
        <h1>What the adversary did, <em>where</em>, and in what order.</h1>
        <p class="lede">
          Midden is a shared case for hunt teams. Record each step of an intrusion with the evidence
          attached, map the terrain from nmap scans, and hand the whole thing to the next shift as a
          live case.
        </p>

        <div class="term notch">
          <div class="term-bar">
            <span class="term-title">Run it</span>
            <button class="btn" :class="{ ok: copied }" type="button" @click="copy">
              {{ copied ? 'Copied' : 'Copy' }}
            </button>
          </div>
          <pre class="term-body" aria-label="docker run command"><code><span
            v-for="(line, i) in lines"
            :key="i"
            class="ln"
          ><span v-if="i === 0" class="ps">$ </span><span v-else class="ps">  </span><span
            v-for="([kind, text], j) in line"
            :key="j"
            :class="kind"
          >{{ text }}</span>
</span></code></pre>
        </div>
        <p class="after">
          Then open <code>localhost:8080</code> and sign in as <code>admin</code>.
          <a :href="withBase('/docs/deploy')">Deployment guide →</a>
        </p>
      </div>

      <figure
        class="case notch"
        aria-label="Illustration of Midden's branch graph: four hosts, three pivots"
      >
        <div class="case-top">
          <span class="case-brand"><i class="dot" />MIDDEN</span>
          <span class="case-name">OP NIGHTJAR</span>
          <span class="case-num">IR-2026-0412</span>
        </div>
        <div class="case-tabs" aria-hidden="true">
          <span>Timeline</span><span class="on">Graph</span><span>Hosts</span><span>Map</span
          ><span>Matrix</span>
        </div>
        <svg viewBox="0 0 600 252" role="img" aria-hidden="true">
          <defs>
            <marker
              id="m-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 z" fill="#ff2e88" />
            </marker>
          </defs>
          <g v-for="(l, i) in lanes" :key="l.name" class="lane" :style="{ '--d': `${i * 0.18}s` }">
            <rect x="10" :y="l.y - 3" width="4" height="6" :fill="l.status" />
            <text x="20" :y="l.y - 2" class="host">{{ l.name }}</text>
            <text x="20" :y="l.y + 9" class="ip">{{ l.ip }}</text>
            <line :x1="l.from" :x2="586" :y1="l.y" :y2="l.y" class="rail" />
          </g>
          <path
            v-for="(p, i) in pivots"
            :key="i"
            :d="pivotPath(p)"
            class="pivot"
            marker-end="url(#m-arrow)"
            :style="{ '--d': `${0.5 + i * 0.25}s` }"
          />
          <g
            v-for="(e, i) in events"
            :key="i"
            class="ev"
            :style="{ '--d': `${0.2 + (e.x - 96) / 400}s` }"
          >
            <circle :cx="e.x" :cy="lanes[e.lane]!.y" r="9" :fill="e.c" opacity="0.16" />
            <circle :cx="e.x" :cy="lanes[e.lane]!.y" r="4.5" :fill="e.c" />
            <circle
              v-if="e.sel"
              :cx="e.x"
              :cy="lanes[e.lane]!.y"
              r="10"
              fill="none"
              stroke="#eaf6ff"
              stroke-width="1.2"
              class="sel"
            />
          </g>
          <g class="callout" :style="{ '--d': '1.5s' }">
            <line x1="532" y1="146" x2="532" y2="124" stroke="rgba(120,200,255,.4)" />
            <rect
              x="436"
              y="104"
              width="150"
              height="20"
              fill="#0d1524"
              stroke="rgba(120,200,255,.28)"
            />
            <rect x="436" y="104" width="2" height="20" fill="#ff8c00" />
            <text x="444" y="117.5" class="call">Exfil over C2 · 03:12Z</text>
          </g>
        </svg>
        <figcaption>Illustrative case. One lane per host, a branch at every pivot.</figcaption>
      </figure>
    </section>

    <!-- ======== two ways ======== -->
    <section class="block">
      <h2 class="sb">Two ways to run it</h2>
      <p class="sub">The same interface in both. Case files move freely between them.</p>
      <div class="ways">
        <article v-for="w in ways" :key="w.key" class="way notch" :style="{ '--acc': w.accent }">
          <header>
            <b>{{ w.title }}</b>
            <span class="badge">{{ w.tag }}</span>
          </header>
          <ul>
            <li v-for="p in w.points" :key="p">{{ p }}</li>
          </ul>
        </article>
      </div>
    </section>

    <!-- ======== features ======== -->
    <section class="block">
      <h2 class="sb">What it does</h2>
      <div class="feats">
        <article v-for="f in features" :key="f.k" class="feat notch" :style="{ '--acc': f.c }">
          <h3><i />{{ f.k }}</h3>
          <p>{{ f.d }}</p>
        </article>
      </div>
    </section>

    <!-- ======== principles ======== -->
    <section class="block">
      <h2 class="sb">How it holds together</h2>
      <dl class="kv">
        <template v-for="p in principles" :key="p.k">
          <dt>{{ p.k }}</dt>
          <dd>{{ p.d }}</dd>
        </template>
      </dl>
    </section>

    <!-- ======== close ======== -->
    <section class="close notch">
      <div>
        <b>Self-hosted. Open source.</b>
        <span>Apache-2.0. Your cases stay on your own hardware.</span>
      </div>
      <div class="close-act">
        <a class="btn pri" :href="withBase('/docs/')">Read the docs</a>
        <a class="btn ghost" :href="REPO">Source on GitHub</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.landing {
  max-width: 1180px;
  margin: 0 auto;
  padding: 56px 24px 72px;
  color: var(--ink);
}
@media (max-width: 640px) {
  .landing {
    padding: 32px 16px 56px;
  }
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  background: var(--gr);
  box-shadow: 0 0 10px var(--gr);
  animation: m-pulse 2.6s infinite;
}

/* ---------- buttons (the app's .btn) ---------- */
.btn {
  display: inline-block;
  text-decoration: none;
  background: #0c1524;
  border: 1px solid var(--line2);
  color: var(--ink);
  padding: 9px 16px;
  cursor: pointer;
  font-family: var(--mono);
  letter-spacing: 0.14em;
  font-size: 11px;
  text-transform: uppercase;
  transition: 0.14s;
  white-space: nowrap;
  clip-path: var(--notch-sm);
}
.btn:hover {
  background: #13233a;
  border-color: var(--cy);
  color: var(--bright);
  box-shadow: 0 0 14px rgba(34, 232, 255, 0.22);
}
.btn:active {
  transform: translateY(1px);
}
.btn.pri {
  background: linear-gradient(180deg, #0f3f52, #0a2836);
  border-color: var(--cy);
  color: var(--cy);
}
.btn.pri:hover {
  background: linear-gradient(180deg, #155a75, #0d3548);
}
.btn.ghost {
  background: transparent;
  border-color: var(--line2);
}
.btn.ok {
  border-color: var(--gr);
  color: var(--gr);
}

/* ---------- hero ---------- */
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr);
  gap: 48px;
  align-items: center;
}
@media (max-width: 960px) {
  .hero {
    grid-template-columns: minmax(0, 1fr);
    gap: 36px;
  }
}
.kicker {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 0 0 18px;
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--dim);
}
.kicker s {
  text-decoration: none;
  color: var(--mg);
}
.kicker .dot {
  margin-right: 4px;
}
h1 {
  margin: 0;
  font-family: var(--mono);
  font-size: clamp(30px, 4.6vw, 48px);
  line-height: 1.12;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--bright);
  text-wrap: balance;
}
h1 em {
  font-style: normal;
  color: var(--cy);
  text-shadow: 0 0 22px rgba(34, 232, 255, 0.5);
}
.lede {
  margin: 20px 0 28px;
  max-width: 34em;
  font-size: 16.5px;
  line-height: 1.7;
  color: var(--dim);
}

.term {
  background: #04070d;
  border: 1px solid var(--line2);
  border-left: 2px solid var(--cy);
  box-shadow: 0 0 40px rgba(34, 232, 255, 0.07);
}
.term-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px 7px 14px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, #0b1220, #070b13);
}
.term-title {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  color: var(--cy);
}
.term-bar .btn {
  padding: 4px 10px;
  font-size: 9.5px;
}
.term-body {
  margin: 0;
  padding: 14px 16px 16px;
  overflow-x: auto;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--ink);
}
.term-body code {
  font: inherit;
  color: inherit;
  background: none;
  padding: 0;
}
.ln {
  white-space: pre;
}
.ps {
  color: var(--dimmer);
  user-select: none;
}
.cmd {
  color: var(--cy);
}
.flag {
  color: var(--dim);
}
.env {
  color: var(--am);
}
.str {
  color: var(--gr);
}
.img {
  color: #ff6fb0;
}
.after {
  margin: 14px 0 0;
  font-size: 14px;
  color: var(--dim);
}
.after code {
  font-family: var(--mono);
  font-size: 0.9em;
  color: #9fe8ff;
}
.after a {
  margin-left: 6px;
  color: var(--cy);
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.08em;
  text-decoration: none;
  white-space: nowrap;
}
.after a:hover {
  color: var(--bright);
  text-shadow: 0 0 10px rgba(34, 232, 255, 0.5);
}

/* ---------- case illustration ---------- */
.case {
  margin: 0;
  background: rgba(10, 15, 25, 0.88);
  border: 1px solid var(--line2);
  box-shadow:
    0 0 0 1px rgba(34, 232, 255, 0.04),
    0 30px 80px rgba(0, 0, 0, 0.5),
    0 0 60px rgba(34, 232, 255, 0.06);
}
.case-top {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  height: 40px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  background: linear-gradient(180deg, #0b1220, #070b13);
  font-family: var(--mono);
}
.case-top::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: repeating-linear-gradient(0deg, rgba(34, 232, 255, 0.05) 0 1px, transparent 1px 3px);
  opacity: 0.5;
}
.case-brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.34em;
  color: var(--cy);
  text-shadow: 0 0 14px rgba(34, 232, 255, 0.55);
}
.case-brand .dot {
  width: 6px;
  height: 6px;
}
.case-name {
  font-size: 11.5px;
  letter-spacing: 0.06em;
  color: var(--bright);
}
.case-num {
  margin-left: auto;
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--am);
}
.case-tabs {
  display: flex;
  overflow: hidden;
  border-bottom: 1px solid var(--line);
  background: rgba(7, 11, 19, 0.9);
}
.case-tabs span {
  padding: 8px 13px;
  font-family: var(--mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--dimmer);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.case-tabs span.on {
  color: var(--cy);
  border-bottom-color: var(--cy);
  text-shadow: 0 0 12px rgba(34, 232, 255, 0.5);
  background: linear-gradient(180deg, transparent, rgba(34, 232, 255, 0.07));
}
.case svg {
  display: block;
  width: 100%;
  height: auto;
  padding: 6px 0 2px;
}
.case figcaption {
  padding: 8px 14px 10px;
  border-top: 1px solid var(--line);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--dimmer);
}
.host {
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  fill: var(--bright);
}
.ip {
  font-family: var(--mono);
  font-size: 8.5px;
  fill: var(--dimmer);
}
.rail {
  stroke: rgba(120, 200, 255, 0.22);
  stroke-width: 1.4;
}
.pivot {
  fill: none;
  stroke: #ff2e88;
  stroke-width: 1.5;
  stroke-dasharray: 4 3;
  filter: drop-shadow(0 0 3px rgba(255, 46, 136, 0.6));
}
.sel {
  filter: drop-shadow(0 0 4px rgba(234, 246, 255, 0.8));
}
.call {
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  fill: var(--ink);
}

/* draw the case in on first paint */
.lane,
.ev,
.pivot,
.callout {
  animation: m-in 0.6s both;
  animation-delay: var(--d, 0s);
}
.lane .rail {
  stroke-dasharray: 600;
  stroke-dashoffset: 600;
  animation: m-draw 1.2s ease-out forwards;
  animation-delay: var(--d, 0s);
}
@keyframes m-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes m-draw {
  to {
    stroke-dashoffset: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .lane,
  .ev,
  .pivot,
  .callout,
  .lane .rail,
  .dot {
    animation: none;
  }
  .lane .rail {
    stroke-dashoffset: 0;
  }
}

/* ---------- sections ---------- */
.block {
  margin-top: 96px;
}
@media (max-width: 640px) {
  .block {
    margin-top: 64px;
  }
}
.sb {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 8px;
  padding: 0;
  border: 0;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--cy);
  text-shadow: 0 0 12px rgba(34, 232, 255, 0.4);
}
.sb::before {
  content: '//';
  color: var(--mg);
  text-shadow: none;
}
.sb::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line);
}
.sub {
  margin: 0 0 22px;
  color: var(--dim);
  font-size: 15px;
}

.ways {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
@media (max-width: 760px) {
  .ways {
    grid-template-columns: minmax(0, 1fr);
  }
}
.way {
  padding: 22px 24px 18px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-top: 2px solid var(--acc);
}
.way header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.way b {
  font-family: var(--mono);
  font-size: 18px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--acc);
}
.badge {
  padding: 1px 7px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  border: 1px solid currentColor;
  color: var(--dim);
  white-space: nowrap;
}
.way ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.way li {
  position: relative;
  padding: 7px 0 7px 18px;
  border-top: 1px dashed var(--line);
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--ink);
}
.way li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 15px;
  width: 6px;
  height: 6px;
  background: var(--acc);
  transform: rotate(45deg);
}

.feats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
  margin-top: 22px;
}
.feat {
  padding: 18px 20px 16px;
  background: var(--panel);
  border: 1px solid var(--line);
  transition: 0.14s;
}
.feat:hover {
  background: var(--panel2);
  border-color: var(--line2);
  box-shadow: inset 0 0 0 1px rgba(34, 232, 255, 0.04);
}
.feat h3 {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 9px;
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--bright);
}
.feat h3 i {
  flex: 0 0 8px;
  width: 8px;
  height: 8px;
  background: var(--acc);
  box-shadow: 0 0 8px var(--acc);
  transform: rotate(45deg);
}
.feat p {
  margin: 0;
  font-size: 14px;
  line-height: 1.65;
  color: var(--dim);
}

.kv {
  display: grid;
  grid-template-columns: minmax(200px, auto) 1fr;
  margin: 22px 0 0;
  border-top: 1px solid var(--line);
}
.kv dt,
.kv dd {
  margin: 0;
  padding: 14px 0;
  border-bottom: 1px solid var(--line);
}
.kv dt {
  padding-right: 24px;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--am);
  padding-top: 16px;
}
.kv dd {
  font-size: 15px;
  line-height: 1.65;
  color: var(--ink);
}
@media (max-width: 640px) {
  .kv {
    grid-template-columns: minmax(0, 1fr);
  }
  .kv dt {
    border-bottom: 0;
    padding-bottom: 0;
  }
}

.close {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 18px 32px;
  margin-top: 96px;
  padding: 26px 28px;
  background: linear-gradient(90deg, rgba(34, 232, 255, 0.08), transparent 60%), var(--panel);
  border: 1px solid var(--line2);
  border-left: 3px solid var(--cy);
}
.close b {
  display: block;
  font-family: var(--mono);
  font-size: 16px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--bright);
}
.close span {
  display: block;
  margin-top: 4px;
  color: var(--dim);
  font-size: 14.5px;
}
.close-act {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
</style>
