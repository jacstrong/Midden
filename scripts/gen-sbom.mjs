#!/usr/bin/env node
/**
 * Write CycloneDX software bills of materials for a release, with no dependencies of its own.
 *
 *   node scripts/gen-sbom.mjs --version 1.3.0 --deployed <dir> --out <dir>
 *   node scripts/gen-sbom.mjs --check --deployed <dir>
 *
 * `--deployed` is the output of `pnpm --filter @midden/server deploy`, the tree that goes in the
 * image. Packages are read from there rather than from the lockfile, so the list is what really
 * ships. Each must then match an entry in the lockfile, which supplies its hash, and anything
 * that does not fails the run. `--check` does only that, and the image build runs it so an image
 * can never contain dependencies the lockfile does not vouch for.
 *
 * The web client is listed too. It is bundled into minified JavaScript, where an image scanner
 * cannot see the packages inside it.
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_URL = 'https://github.com/jacstrong/Midden';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values: args } = parseArgs({
  options: {
    version: { type: 'string' },
    deployed: { type: 'string' },
    out: { type: 'string' },
    check: { type: 'boolean', default: false },
  },
});
if (!args.deployed || (!args.check && (!args.version || !args.out))) {
  console.error('usage: gen-sbom.mjs --deployed <dir> (--check | --version <v> --out <dir>)');
  process.exit(2);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** `name@version` to SHA-512 hex, from the lockfile's `packages:` section. */
function readLockfile() {
  const text = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const start = text.indexOf('\npackages:\n');
  const end = text.indexOf('\nsnapshots:\n', start);
  if (start < 0 || end < 0) throw new Error('pnpm-lock.yaml: cannot find the packages section');
  const hashes = new Map();
  const entry =
    /^ {2}'?((?:@[^/@\s]+\/)?[^@\s']+@[^'\s:]+)'?:\n {4}resolution: \{integrity: sha512-([^,}\s]+)/gm;
  for (const m of text.slice(start, end).matchAll(entry))
    hashes.set(m[1], Buffer.from(m[2], 'base64').toString('hex'));
  return hashes;
}

function findPackage(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    if (dir === dirname(dir)) return null;
  }
}

/** Walk a package's runtime dependencies. Returns `name@version` to its details. */
function walk(rootDir, into = new Map()) {
  const visit = (dir) => {
    const pkg = readJson(join(dir, 'package.json'));
    const key = `${pkg.name}@${pkg.version}`;
    if (into.has(key)) return key;
    const node = { pkg, depends: new Set() };
    into.set(key, node);
    const optional = new Set([
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    const names = new Set([...Object.keys(pkg.dependencies ?? {}), ...optional]);
    for (const name of names) {
      const found = findPackage(dir, name);
      if (!found) {
        if (optional.has(name)) continue;
        throw new Error(`${key} depends on ${name}, which is not installed`);
      }
      node.depends.add(visit(found));
    }
    return key;
  };
  visit(realpathSync(rootDir));
  return into;
}

const FIRST_PARTY = /^(@midden\/|midden$)/;

/** Fail if anything that would ship is not in the lockfile. */
function verifyAgainstLockfile(tree, hashes) {
  const strays = [...tree.keys()].filter((k) => !FIRST_PARTY.test(k) && !hashes.has(k));
  if (strays.length) {
    console.error(`These would ship but are not in pnpm-lock.yaml:\n  ${strays.join('\n  ')}`);
    process.exit(1);
  }
}

const hashes = readLockfile();
const serverTree = walk(args.deployed);
const webTree = walk(join(root, 'packages/web'));
verifyAgainstLockfile(serverTree, hashes);
verifyAgainstLockfile(webTree, hashes);

if (args.check) {
  console.log(`gen-sbom: all ${serverTree.size + webTree.size} packages match the lockfile`);
  process.exit(0);
}

const SPDX_IDS = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
]);

function licenses(pkg) {
  const raw = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
  if (!raw) return undefined;
  if (SPDX_IDS.has(raw)) return [{ license: { id: raw } }];
  if (/\s(OR|AND)\s/.test(raw)) return [{ expression: raw }];
  return [{ license: { name: raw } }];
}

const purl = (pkg) => `pkg:npm/${pkg.name.replace('@', '%40')}@${pkg.version}`;
const ref = (key, tree) => {
  const { pkg } = tree.get(key);
  return FIRST_PARTY.test(pkg.name) ? `first-party/${pkg.name}@${args.version}` : purl(pkg);
};

function component(key, tree) {
  const { pkg } = tree.get(key);
  const firstParty = FIRST_PARTY.test(pkg.name);
  const [group, name] = pkg.name.startsWith('@') ? pkg.name.split('/') : [undefined, pkg.name];
  const sha512 = hashes.get(key);
  return {
    type: 'library',
    'bom-ref': ref(key, tree),
    ...(group ? { group } : {}),
    name,
    version: firstParty ? args.version : pkg.version,
    ...(firstParty ? { licenses: [{ license: { id: 'Apache-2.0' } }] } : {}),
    ...(!firstParty && licenses(pkg) ? { licenses: licenses(pkg) } : {}),
    ...(firstParty ? {} : { purl: purl(pkg) }),
    ...(sha512 ? { hashes: [{ alg: 'SHA-512', content: sha512 }] } : {}),
  };
}

function commitDate() {
  if (process.env.SOURCE_DATE_EPOCH)
    return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
  try {
    return execFileSync('git', ['log', '-1', '--format=%cI'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return new Date().toISOString();
  }
}

/** The base image, as the Dockerfile names it. Its contents are in the image's own attestation. */
function baseImage() {
  const m = readFileSync(join(root, 'Dockerfile'), 'utf8').match(/^FROM node:(\S+) AS runtime$/m);
  if (!m) throw new Error('Dockerfile: cannot find the runtime base image');
  return {
    type: 'container',
    'bom-ref': `pkg:docker/library/node@${m[1]}`,
    name: 'node',
    version: m[1],
    purl: `pkg:docker/library/node@${m[1]}`,
  };
}

function bom({ name, description, trees, extra = [] }) {
  const merged = new Map();
  for (const tree of trees) for (const [k, v] of tree) if (!merged.has(k)) merged.set(k, v);
  const rootRef = `first-party/${name}@${args.version}`;
  const isRoot = (k) => /^(@midden\/server|@midden\/web)@/.test(k);
  const keys = [...merged.keys()].filter((k) => !isRoot(k)).sort();
  const direct = new Set(
    [...merged.entries()].filter(([k]) => isRoot(k)).flatMap(([, n]) => [...n.depends]),
  );
  const body = {
    metadata: {
      timestamp: commitDate(),
      tools: { components: [{ type: 'application', name: 'midden-gen-sbom', version: '1' }] },
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name,
        version: args.version,
        description,
        licenses: [{ license: { id: 'Apache-2.0' } }],
        externalReferences: [{ type: 'vcs', url: REPO_URL }],
      },
    },
    components: [...keys.map((k) => component(k, merged)), ...extra],
    dependencies: [
      {
        ref: rootRef,
        dependsOn: [...[...direct].map((k) => ref(k, merged)), ...extra.map((c) => c['bom-ref'])],
      },
      ...keys.map((k) => ({
        ref: ref(k, merged),
        dependsOn: [...merged.get(k).depends].map((d) => ref(d, merged)),
      })),
    ],
  };
  // The serial is derived from the content so that the same inputs make the same file.
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    ...body,
  };
}

mkdirSync(args.out, { recursive: true });
const write = (file, doc) => {
  writeFileSync(join(args.out, file), JSON.stringify(doc, null, 2) + '\n');
  console.log(`gen-sbom: ${file}: ${doc.components.length} components`);
};
write(
  `midden-server-${args.version}.cdx.json`,
  bom({
    name: 'midden-server',
    description: 'The Midden container image: server, its runtime dependencies and the web client.',
    trees: [serverTree, webTree],
    extra: [baseImage()],
  }),
);
write(
  `midden-standalone-${args.version}.cdx.json`,
  bom({
    name: 'midden-standalone',
    description: 'The single-file Midden web client.',
    trees: [webTree],
  }),
);
