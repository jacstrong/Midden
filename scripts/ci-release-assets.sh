#!/usr/bin/env bash
# Collect release assets into ./release: the standalone HTML, the example case, the SBOMs, the
# API description, and checksums over all of them.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?version}"
OUT=release
rm -rf "$OUT" && mkdir -p "$OUT"

# The GitLab job starts from a clean checkout, so don't assume an earlier step did this.
pnpm install --frozen-lockfile
pnpm --filter @midden/core build

cp packages/web/dist-standalone/index.html "$OUT/midden-standalone-$VERSION.html"

# The example investigation, so a new user has something to open immediately.
node --no-warnings=ExperimentalWarning -e "
  const { demoCaseState, writeCaseFile } = require('./packages/core/dist/index.js');
  const file = writeCaseFile(demoCaseState(), { generator: 'MIDDEN $VERSION' });
  require('node:fs').writeFileSync('$OUT/midden-example-case.json', JSON.stringify(file, null, 2));
"

# SBOMs, read from the same deploy step the Dockerfile uses so they list what the image ships.
DEPLOYED="$(mktemp -d "${TMPDIR:-/tmp}/midden-deploy.XXXXXX")"
trap 'rm -rf "$DEPLOYED"' EXIT
pnpm --filter @midden/server deploy --legacy --prod --ignore-scripts "$DEPLOYED/server"
node scripts/gen-sbom.mjs --version "$VERSION" --deployed "$DEPLOYED/server" --out "$OUT"

cp docs/openapi.json "$OUT/midden-openapi-$VERSION.json"

( cd "$OUT" && sha256sum -- * > SHA256SUMS )
ls -la "$OUT"
