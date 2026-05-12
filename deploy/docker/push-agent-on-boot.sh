#!/bin/sh
# push-agent-on-boot.sh — push the baked-in kaiad-agent OCI tarball
# into the local registry on first boot, if the requested tag isn't
# already there. Runs in the background from kaiad's entrypoint.
#
# Inputs (env, with sensible defaults set in Dockerfile.unified):
#   KAIAD_AGENT_BUNDLE         path to the OCI tarball baked into the image
#   KAIAD_AGENT_VERSION        tag to push (e.g. 0.1.0)
#   KAIAD_REGISTRY_INTERNAL    hostname:port for the OCI registry. Since
#                              kaiad now hosts /v2/* itself, this is
#                              loopback (127.0.0.1:${PORT}) in compose.
#   PORT                       port kaiad listens on (3001 in the runtime
#                              image; 8092 in dev compose, 8091 in prod)
#
# Skips silently if the tarball isn't present or kaiad isn't ready
# within a generous window. Failures are logged to /tmp/push-agent.log
# (see the Dockerfile entrypoint redirect) but do not affect the API.
set -eu

KAIAD_PORT="${PORT:-3001}"
REGISTRY="${KAIAD_REGISTRY_INTERNAL:-127.0.0.1:${KAIAD_PORT}}"
VERSION="${KAIAD_AGENT_VERSION:-0.1.0}"
TARBALL="${KAIAD_AGENT_BUNDLE:-/opt/kaiad-agent.tar}"

if [ ! -f "$TARBALL" ]; then
  echo "[push-agent] no tarball at $TARBALL; nothing to push" >&2
  exit 0
fi

# Wait for kaiad's own /ready endpoint so /registry/token AND /v2/* work.
# Both are served by the same Fastify process, so a single readiness
# check covers both — no separate registry container to wait on.
i=0
until wget -q --spider "http://127.0.0.1:${KAIAD_PORT}/ready"; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[push-agent] kaiad /ready never came up after 120s; giving up" >&2
    exit 1
  fi
  sleep 2
done
echo "[push-agent] kaiad ready at :${KAIAD_PORT} (also serves /v2/*)"

# Get a push+pull JWT from our own /registry/token. The dev-token
# shortcut is owner-class in non-prod (NODE_ENV != production OR
# SM_ALLOW_DEV_TOKEN=1) so this works for the dev compose stack
# without configuring a real admin credential.
BASIC=$(printf 'admin:dev-token' | base64 | tr -d '\n')
JWT=$(wget -qO- \
        --header="Authorization: Basic ${BASIC}" \
        "http://127.0.0.1:${KAIAD_PORT}/registry/token?service=kaiad-registry&scope=repository:kaiad-agent:push,pull" \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

if [ -z "${JWT:-}" ]; then
  echo "[push-agent] failed to obtain push JWT (is dev-token enabled?); giving up" >&2
  exit 1
fi

# Crane reads ~/.docker/config.json. The `registrytoken` form passes
# the bearer through directly, skipping crane's own re-auth roundtrip.
mkdir -p "${HOME:-/tmp}/.docker"
cat > "${HOME:-/tmp}/.docker/config.json" <<JSON
{
  "auths": {
    "${REGISTRY}": { "registrytoken": "${JWT}" }
  }
}
JSON
export DOCKER_CONFIG="${HOME:-/tmp}/.docker"

# Push the version tag if it isn't already in the registry. Different
# kaiad builds often ship different agent code under the same ${VERSION},
# so we ALSO re-push the moving :latest tag every time, pointing at the
# tarball baked into THIS kaiad image. crane push is content-addressed,
# so re-pushing identical blobs is a no-op; only differing layers actually
# move bytes.
if ! crane --insecure manifest "${REGISTRY}/kaiad-agent:${VERSION}" >/dev/null 2>&1; then
  echo "[push-agent] pushing ${TARBALL} → ${REGISTRY}/kaiad-agent:${VERSION}"
  crane --insecure push "${TARBALL}" "${REGISTRY}/kaiad-agent:${VERSION}"
fi

echo "[push-agent] re-pushing ${TARBALL} → ${REGISTRY}/kaiad-agent:latest (refresh moving tag)"
crane --insecure push "${TARBALL}" "${REGISTRY}/kaiad-agent:latest"
echo "[push-agent] done"
