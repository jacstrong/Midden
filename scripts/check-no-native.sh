#!/usr/bin/env sh
# Fails if any native addon is present in the given node_modules tree.
# Midden's runtime image must be pure JS so the arm64 image is a copy of the amd64 one.
set -eu
DIR="${1:-node_modules}"
if [ ! -d "$DIR" ]; then
  echo "check-no-native: $DIR does not exist" >&2
  exit 2
fi
FOUND=$(find "$DIR" \( -name '*.node' -o -name 'binding.gyp' \) -not -path '*/esbuild/*' -not -path '*/@esbuild/*' -not -path '*/rolldown/*' -not -path '*/@rolldown/*' -not -path '*/@oxc-*' -not -path '*/lightningcss*' -not -path '*/@swc/*' -not -path '*/playwright*' -not -path '*/@parcel/*' -not -path '*/fsevents/*' -not -path '*/@tailwindcss/*' 2>/dev/null || true)
if [ -n "$FOUND" ]; then
  echo "check-no-native: native addons found in $DIR:" >&2
  echo "$FOUND" >&2
  exit 1
fi
echo "check-no-native: OK ($DIR)"
