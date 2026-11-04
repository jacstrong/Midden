# Auditing a release

Every Midden release comes with what you need to check what's in it before you run it: software bills of materials (SBOMs), checksums, and a description of the API.

## What comes with a release

These are attached to each [GitHub release](https://github.com/jacstrong/Midden/releases):

| File                                   | What it is                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `midden-server-<version>.cdx.json`     | CycloneDX SBOM of the container image's application: server and web client. |
| `midden-standalone-<version>.cdx.json` | CycloneDX SBOM of the standalone `.html` file.                              |
| `midden-openapi-<version>.json`        | The API, as an OpenAPI 3.1 description.                                     |
| `SHA256SUMS`                           | Checksums of every file in the release.                                     |

The container image also carries its own SBOM and build provenance, attached in the registry.

## Which SBOM to use

The two kinds cover different things, so a full review of the image uses both.

**The CycloneDX file** lists Midden's own dependencies, with each package's version, license, SHA-512 hash and place in the dependency tree. It includes the packages bundled into the web client, which a scanner can't see once they are minified into JavaScript. Packages are read from what actually gets deployed and checked against `pnpm-lock.yaml`, and the image build fails if the two ever disagree.

**The image attestation** is an SPDX SBOM made by scanning the finished image. It covers everything on disk, including Alpine's packages and the Node runtime, which the CycloneDX file only names as the base image. It can't see inside the web bundle. Read it with:

```bash
docker buildx imagetools inspect ghcr.io/jacstrong/midden:latest \
  --format '{{ json (index .SBOM "linux/amd64").SPDX }}' > midden-image.spdx.json
```

To read the build provenance, use `{{ json .Provenance }}` in the same command.

## Checking for known vulnerabilities

Any scanner that reads CycloneDX or SPDX will work. With [Grype](https://github.com/anchore/grype), for example:

```bash
grype sbom:./midden-server-1.3.0.cdx.json
grype ghcr.io/jacstrong/midden:latest
```

The first command checks the application's dependencies, including the bundled web client. The second scans the image, which also covers Alpine and Node.

## Checking a download

From the folder you downloaded the release files to:

```bash
sha256sum --check --ignore-missing SHA256SUMS
```

Checksums show that a file arrived intact, but they come from the same place as the file, so they don't prove who made it. Releases aren't cryptographically signed yet.

## Things that help a review

- **No native code runs in the server.** Its dependencies are pure JavaScript, and it uses Node's built-in SQLite and password hashing. The build fails if a native module appears, so there's no compiled third-party code to review.
- **There are no external services.** One container and one data volume are the whole installation. The server only reaches outside if you configure [single sign-on](deploy.md#single-sign-on).
- **The standalone file makes no network calls.** A test in the build opens it with the network watched and fails if it tries.
- **Every change to a case is recorded.** The operation log is append-only and records who made each change, and when, which you can export as a CSV from `GET /api/cases/{id}/ops?format=csv`.
- **Agents have limits the server enforces.** See [what an agent can do](mcp.md#what-an-agent-can-do).

## Reporting a vulnerability

Please use [GitHub's private vulnerability reporting](https://github.com/jacstrong/Midden/security/advisories/new) rather than opening a public issue.
