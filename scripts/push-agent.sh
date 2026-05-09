#!/usr/bin/env bash
#
# push-agent.sh — push the locally-built kaiad-agent image into the
# Kaiad-hosted OCI registry on the dev (or prod) stack.
#
# Usage:
#   scripts/push-agent.sh [tag ...]
#
# Examples:
#   scripts/push-agent.sh                      # pushes :0.1.0 + :latest
#   scripts/push-agent.sh 0.1.0
#   KAIAD_REGISTRY=panel.kaiad.dev scripts/push-agent.sh
#
# Prerequisites:
#   - The kaiad-agent:dev image already exists in the local docker
#     daemon. Build it with: (cd apps/agent && docker build -t kaiad-agent:dev .)
#   - The Kaiad registry is reachable at $KAIAD_REGISTRY (default
#     panel.dev.kaiad.dev) and serves the OCI distribution API at /v2/.
#   - docker login $KAIAD_REGISTRY  if/when Phase 2 (bearer auth) lands.
#     Phase 1 has anonymous read+write so login is not required yet.
#
# Phase 2 follow-up: replace this script with an entrypoint hook in
# deploy/docker/Dockerfile.unified that bakes a kaiad-agent OCI bundle
# into the kaiad image and pushes it to the local registry on first
# boot, removing the manual step.
set -euo pipefail

REGISTRY="${KAIAD_REGISTRY:-panel.dev.kaiad.dev}"
SOURCE="${KAIAD_AGENT_SOURCE_IMAGE:-kaiad-agent:dev}"

if [[ $# -gt 0 ]]; then
  TAGS=("$@")
else
  # Read the kaiad version out of the root package.json so the registry
  # tag tracks the release without anyone having to remember to update it.
  VERSION="$(node -e 'console.log(require("./package.json").version)')"
  TAGS=("${VERSION}" "latest")
fi

if ! docker image inspect "${SOURCE}" >/dev/null 2>&1; then
  echo "[push-agent] source image '${SOURCE}' not found in local docker." >&2
  echo "[push-agent] build it first:" >&2
  echo "             (cd apps/agent && docker build -t ${SOURCE} .)" >&2
  exit 1
fi

for tag in "${TAGS[@]}"; do
  remote="${REGISTRY}/kaiad-agent:${tag}"
  echo "[push-agent] tag  ${SOURCE} → ${remote}"
  docker tag "${SOURCE}" "${remote}"
  echo "[push-agent] push ${remote}"
  docker push "${remote}"
done

echo "[push-agent] done. Repo contents:"
curl -fsSL "https://${REGISTRY}/v2/kaiad-agent/tags/list" || true
echo
