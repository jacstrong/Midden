# Midden

Cyber hunt and DCO attack reconstruction with terrain mapping. Midden grew out of a hunt
mission: record what an adversary did, on which hosts, in what order, with the evidence
attached; map the terrain from nmap scans; and hand the whole thing to the next shift as a
live, shared case.

Two ways to run it, the same interface in both:

- **Hosted** — one Docker container with the database, file store and web client inside. About
  twenty analysts work the same case at once and see each other's changes as they happen. Runs
  on a laptop or a Raspberry Pi 4/5.
- **Standalone** — a single `.html` file. No server, no storage, no network calls. Open it from
  disk, work, save a `.json`, reopen it later. It parses nmap scans in the page.

Case files move freely between the two, and still open in the original prototype.

## What it does

- **Timeline and branch graph.** One lane per host, ordered by when the adversary first reached
  it, with a branch drawn wherever activity pivoted from one system to another. Every event
  keeps the source system's timezone alongside UTC, so you can read it as UTC, as your local
  time, or as the source logged it.
- **Hosts, indicators and ATT&CK coverage.** Indicators are deduplicated across the case with
  every sighting; techniques roll up into the Enterprise matrix.
- **Terrain from nmap.** Upload `-oX` or `-oN` output. Midden parses it into a searchable host
  inventory and a network map: one hub per subnet, expandable to individual hosts, with your
  case hosts overlaid by status. Promote a scanned host into the case in one click; it stays
  linked by address.
- **Scan builder.** Composes nmap commands for the two-phase workflow: find live hosts on the
  target subnets, upload the result, then service-scan exactly those hosts from the generated
  target list. Every command it can produce is checked against the real nmap binary in CI.
- **Evidence.** Screenshots, log excerpts and small captures attach to events and hosts.
  Uploads are content-addressed and only recognised image formats are ever rendered inline.
- **Reports.** HTML, Markdown, timeline CSV and an indicator list, assembled from the case.
- **History.** Every change is an operation with an actor and a time. The history view shows
  before and after, and anything can be reverted.

## Running it

See [docs/deploy.md](docs/deploy.md) for the full guide: Raspberry Pi notes, HTTPS, single
sign-on, backup and restore, and every environment variable.

```bash
docker run -d --name midden -p 8080:8080 \
  -v "$PWD/midden-data:/data" \
  -e MIDDEN_ADMIN_USER=admin -e MIDDEN_ADMIN_PASSWORD='choose something long' \
  ghcr.io/jacobstrong/midden:latest
```

For the standalone build, download `midden-standalone.html` from a release and open it.

## Layout

```
packages/core     pure TypeScript shared by server and client: domain types, the operation
                  reducer, case-file codecs, nmap parsing and classification, map layouts,
                  the ATT&CK reference and the nmap command builder. No I/O.
packages/server   Fastify + node:sqlite + WebSockets. Auth, the operation log, terrain
                  ingestion in a worker thread, the blob store, and the `midden` CLI.
packages/web      React + Vite. Hosted bundle and standalone single-file build.
e2e               Playwright: standalone in three engines, hosted multi-user, prototype
                  compatibility.
scripts           ci-*.sh shared by GitHub Actions and GitLab CI, plus the nmap command check.
docker            compose file and container entrypoint.
legacy            the original prototypes, kept as parity oracles.
```

## How it holds together

- **The operation log is the source of truth.** Every change to a case is an operation
  recorded with who made it and when; the tables the UI reads are a projection that can be
  rebuilt from the log at any time (`midden rebuild`). That is what makes live collaboration,
  the history view and revert the same mechanism rather than three.
- **Per-field last write wins.** Editors send only the fields that actually changed, so two
  analysts editing different fields of the same host both keep their work. When they do collide,
  the loser is told who overwrote what.
- **Terrain is not in the log.** A /16 scan is 65,000 hosts and half a million ports. Scans are
  bulk-loaded into ordinary tables and read back paginated; only the scan's registration is an
  operation. Case status is overlaid client-side by address, so changing a host's status
  recolours the map with no round trip.
- **Zero native modules.** SQLite and argon2id come from Node itself. The arm64 image is a copy
  of the same JavaScript as amd64, so multi-arch builds never compile under emulation.
- **One volume.** `/data` holds the database and the content-addressed files. Copying it copies
  the installation.

## Development

Requires Node 24 and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm build              # core → server → web
pnpm build:standalone   # packages/web/dist-standalone/index.html
pnpm test               # unit tests
pnpm lint && pnpm typecheck && pnpm format:check
pnpm check:nmap         # validate generated scan commands against the local nmap
```

End-to-end tests need browsers once:

```bash
pnpm --filter @midden/e2e install-browsers
pnpm e2e
```

If your home directory is not writable, point Playwright at a project-local cache:
`export PLAYWRIGHT_BROWSERS_PATH=$PWD/e2e/.cache/ms-playwright`.

Dev servers: `pnpm dev` from the root runs all three in parallel -- the core type build in
watch mode, the API on `:8080`, and Vite on `:5173` proxying `/api` and `/ws` to it. Run one on
its own with `pnpm --filter @midden/server dev` or `pnpm --filter @midden/web dev`; both read
`@midden/core` from its build output, so run `pnpm build` once first. The server runs the
TypeScript sources directly under `node --watch` (see `scripts/dev-ts.mjs`). On first boot it
creates an admin from `MIDDEN_ADMIN_USER` and `MIDDEN_ADMIN_PASSWORD`, or prints a one-time
password to the log.

A load check for the sync path, twenty clients at five operations a second each:
`pnpm --filter @midden/server load`.

## Status

The core package, the standalone build, the hosted server with live collaboration, terrain
ingestion and the network map, the scan builder, evidence attachments, and optional OpenID
Connect are all built and tested. Multi-arch image publishing and the release pipelines are
written but have not yet been run on a real Docker daemon or a physical Pi.
