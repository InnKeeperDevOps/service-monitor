#!/usr/bin/env bash
# Regenerate OpenAPI and fail if openapi/openapi.yaml differs from git (committed spec must match generator).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node scripts/generate-openapi.mjs

if ! git diff --exit-code openapi/openapi.yaml; then
  echo "OpenAPI spec drift detected" >&2
  exit 1
fi
