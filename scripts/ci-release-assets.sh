#!/usr/bin/env bash
# Collect release assets into ./release: the standalone HTML, the example case, and checksums.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:?version}"
OUT=release
rm -rf "$OUT" && mkdir -p "$OUT"

cp packages/web/dist-standalone/index.html "$OUT/midden-standalone-$VERSION.html"

# The example investigation, so a new user has something to open immediately.
node --no-warnings=ExperimentalWarning -e "
  const { demoCaseState, writeCaseFile } = require('./packages/core/dist/index.js');
  const file = writeCaseFile(demoCaseState(), { generator: 'MIDDEN $VERSION' });
  require('node:fs').writeFileSync('$OUT/midden-example-case.json', JSON.stringify(file, null, 2));
"

( cd "$OUT" && sha256sum -- * > SHA256SUMS )
ls -la "$OUT"
