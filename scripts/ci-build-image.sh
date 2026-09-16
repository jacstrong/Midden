#!/usr/bin/env bash
# Build the multi-arch image. Usage: ci-build-image.sh <image> <tag> [--push]
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE="${1:?image name}"
TAG="${2:?tag}"
PUSH="${3:-}"
EXTRA=()
if [ "$PUSH" = "--push" ]; then
  EXTRA+=(--push)
else
  # Multi-arch manifests cannot be loaded into the local daemon; just verify the build.
  EXTRA+=(--output type=image,push=false)
fi
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "$IMAGE:$TAG" \
  "${EXTRA[@]}" \
  .
