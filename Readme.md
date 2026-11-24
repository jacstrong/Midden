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
- **Tasks and playbooks** (hosted only). Teams, team queues, boards and tables, checklists,
  dependencies and sign-offs. A lead imports the hunt's playbook from a CSV file, starts a run
  and shares the work out. Tasks can link to a case, host or event, and a task on a restricted
  case stays hidden from people outside it. Notifications arrive in the app, and optionally in a
  Rocket.Chat channel.
- **Insights and metrics.** An Insights page shows open work, throughput, cycle time and
  burndowns for leads. Optional Prometheus metrics cover the server itself.

## Running it

See [docs/deploy.md](docs/deploy.md) for the full guide: Raspberry Pi notes, HTTPS, single
sign-on, backup and restore, and every environment variable. There are also guides for
[Compose with HTTPS](docs/https-proxy.md), [Kubernetes with Helm](docs/kubernetes.md) and
[networks without internet access](docs/air-gapped.md).

```bash
docker run -d --name midden -p 8080:8080 \
  -v "$PWD/midden-data:/data" \
  -e MIDDEN_ADMIN_USER=admin -e MIDDEN_ADMIN_PASSWORD='choose something long' \
  ghcr.io/jacstrong/midden:latest
```

For the standalone build, download `midden-standalone-<version>.html` from a release and open it.

## Extending and reviewing Midden

- [Tasks and playbooks](docs/tasks.md): teams, runs, approvals, notifications, and the CSV
  format for playbooks, imports and exports.
- [Metrics](docs/metrics.md): Prometheus metrics, example queries and alerts.
- [API guide](docs/api.md) and [reference](docs/api-reference.md): scripts and integrations, with
  API tokens and an OpenAPI description.
- [Connecting AI agents](docs/mcp.md): the built-in MCP endpoint, and what to weigh before giving
  an agent write access.
- [Auditing a release](docs/auditing.md): SBOMs, checksums and how to scan a release.

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
scripts           ci-*.sh shared by GitHub Actions and GitLab CI, the nmap command check, the
                  API docs generator and seed-dev.ts, which fills a local dev database.
docker            compose files and the container entrypoint.
charts            the Helm chart.
docs              the guides, as plain Markdown. Also published on the project site.
website           VitePress landing page and docs site; reads docs/ in place.
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

Requires Node 24.22.1 or newer and pnpm 10 (`corepack enable`). Everything you need is a root
`package.json` script:

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs the core type build in watch mode, the API on `:8080` and Vite on `:5173`
(proxying `/api` to the API). Open <http://localhost:5173>.

### Dev data

The dev server keeps its data in `data/dev` (gitignored). The first `pnpm dev` seeds it with a
case, two teams, a playbook run and a few tasks, plus five users who share one password:

| User   | Role                     |
| ------ | ------------------------ |
| `root` | admin                    |
| `lena` | analyst, lead of Host    |
| `ann`  | analyst, on Host         |
| `bob`  | analyst, lead of Network |
| `vic`  | viewer                   |

The password is in `data/dev/test-users.txt`. To start again from a fresh seed:

```bash
pnpm dev:reset
```

Deleting `data/dev` by hand works too: the next `pnpm dev` seeds it again. To use another
folder, set `MIDDEN_DATA` for both `pnpm seed:dev` and `pnpm dev`. A folder that has no users
and isn't seeded gets an admin from `MIDDEN_ADMIN_USER` and `MIDDEN_ADMIN_PASSWORD`, or a
one-time password printed in the server log.

If the server stops with "Port 8080 is already in use", another Midden server is still running.
Stop it, or set `MIDDEN_PORT`.

### Scripts

| Script                  | What it does                                                               |
| ----------------------- | -------------------------------------------------------------------------- |
| `pnpm dev`              | Seed `data/dev` if it's empty, then run core, the API and the web client   |
| `pnpm dev:server`       | Only the API, on `:8080`, with the same seeding                            |
| `pnpm dev:web`          | Only the web client, on `:5173`                                            |
| `pnpm dev:standalone`   | The standalone build, served by Vite, with no server                       |
| `pnpm dev:reset`        | Delete `data/dev` and seed it again                                        |
| `pnpm seed:dev`         | Seed `data/dev`, or the folder you name; refuses if it has a database      |
| `pnpm build`            | Build core, then the server, then the web client                           |
| `pnpm build:standalone` | Build `packages/web/dist-standalone/index.html`                            |
| `pnpm start`            | Run the built server on `:8080`, serving the built client, with `data/dev` |
| `pnpm test`             | Unit and integration tests (`pnpm test:watch` to keep them running)        |
| `pnpm lint`             | ESLint                                                                     |
| `pnpm typecheck`        | TypeScript, in every package                                               |
| `pnpm format`           | Format with Prettier (`pnpm format:check` only checks)                     |
| `pnpm e2e:install`      | Install the Playwright browsers, once                                      |
| `pnpm e2e:hosted`       | Build, then the hosted end-to-end tests in Chromium and WebKit             |
| `pnpm e2e:standalone`   | Build the standalone file, then test it in Chromium, Firefox and WebKit    |
| `pnpm e2e`              | Every end-to-end test, against the current builds                          |
| `pnpm load`             | Build, then a load check: twenty clients at five operations a second       |
| `pnpm check:nmap`       | Check generated scan commands against the local nmap                       |
| `pnpm check:native`     | Check the server's dependencies contain no native modules                  |
| `pnpm docs:api`         | Regenerate `docs/api-reference.md` and `docs/openapi.json` from the server |
| `pnpm site:dev`         | The landing page and docs on `:5173`, live-reloading edits to `docs/`      |
| `pnpm site:build`       | Build the site                                                             |
| `pnpm ci`               | Everything CI runs: install, lint, format, typecheck, build, tests and e2e |

The end-to-end tests run the built server and client, so `pnpm e2e` tests whatever you last
built. `e2e:hosted` and `e2e:standalone` build first. If your home directory isn't writable,
point Playwright at a project-local cache:
`export PLAYWRIGHT_BROWSERS_PATH=$PWD/e2e/.cache/ms-playwright`.

The dev server runs the TypeScript sources directly under `node --watch` (see
`scripts/dev-ts.mjs`) and reads `@midden/core` from its build output, which `pnpm dev` keeps
current.

## Status

The core package, the standalone build, the hosted server with live collaboration, terrain
ingestion and the network map, the scan builder, evidence attachments, optional OpenID
Connect, task management with notifications and Insights, and Prometheus metrics are all built
and tested. CI builds the image for `linux/amd64` and `linux/arm64` on
every push. What has not been exercised yet is the tagged release path that pushes to the two
registries, and acceptance on a physical Raspberry Pi.
