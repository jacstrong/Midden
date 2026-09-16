#!/bin/sh
# Keep the V8 heap modest on small ARM boards unless the operator overrides it.
set -e
if [ "$(uname -m)" = "aarch64" ] && [ -z "${MIDDEN_NODE_HEAP_MB:-}" ]; then
  MIDDEN_NODE_HEAP_MB=1024
fi
if [ -n "${MIDDEN_NODE_HEAP_MB:-}" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${MIDDEN_NODE_HEAP_MB}"
fi
exec node /app/dist/main.js "$@"
