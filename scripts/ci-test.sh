#!/usr/bin/env bash
# Full verification, shared by GitHub Actions and GitLab CI so the pipelines cannot drift.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm install --frozen-lockfile
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm build:standalone
pnpm test

# Prove the scan builder's output is accepted by the real nmap binary, when one is present.
pnpm check:nmap
if [ "${SKIP_E2E:-0}" != "1" ]; then
  pnpm --filter @midden/e2e install-browsers
  pnpm e2e
fi
