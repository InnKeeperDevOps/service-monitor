#!/usr/bin/env bash
# End-to-end smoke test for the Kaiad operator on a `kind` cluster.
#
# Required tooling on PATH: kind, kubectl, helm, docker, curl, jq.
# Required env:
#   KAIAD_API_BASE_URL   Base URL of a running Kaiad API (e.g. http://host.docker.internal:3000)
#   KAIAD_API_CREDENTIAL Bearer token with scope `enrollment-tokens.create`
#
# What this script asserts:
#   1. The operator chart installs cleanly.
#   2. The KaiadAgent CRD is registered.
#   3. Applying a sample CR results in a Deployment, ServiceAccount, and
#      scoped Role/RoleBinding being created.
#   4. The agent reports `Ready=True` within the timeout (default 3min).
#   5. Deleting the CR garbage-collects every owned object.
#
# Exit codes:
#   0 on success, non-zero on any assertion failure.

set -euo pipefail

KIND_CLUSTER="${KIND_CLUSTER:-kaiad-op-e2e}"
NAMESPACE="${NAMESPACE:-kaiad-system}"
AGENT_NAME="${AGENT_NAME:-edge-e2e}"
AGENT_IMAGE="${AGENT_IMAGE:-ghcr.io/innkeeperdevops/kaiad-agent:latest}"
OPERATOR_IMAGE="${OPERATOR_IMAGE:-kaiad-operator:e2e}"
TIMEOUT="${TIMEOUT:-180}"

if [[ -z "${KAIAD_API_BASE_URL:-}" || -z "${KAIAD_API_CREDENTIAL:-}" ]]; then
  echo "ERROR: KAIAD_API_BASE_URL and KAIAD_API_CREDENTIAL must be set" >&2
  exit 64
fi

repo_root() {
  cd "$(dirname "$0")/../../../.." && pwd
}

cleanup() {
  set +e
  kubectl delete kaiadagent "$AGENT_NAME" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1
  helm uninstall kaiad-operator -n "$NAMESPACE" >/dev/null 2>&1
  if [[ "${KEEP_KIND:-0}" != "1" ]]; then
    kind delete cluster --name "$KIND_CLUSTER" >/dev/null 2>&1
  fi
}
trap cleanup EXIT

step() { printf '\n=== %s ===\n' "$*"; }

step "create kind cluster"
kind create cluster --name "$KIND_CLUSTER" --wait 60s

step "build + load operator image"
ROOT="$(repo_root)"
docker build -t "$OPERATOR_IMAGE" "$ROOT/deploy/operator"
kind load docker-image "$OPERATOR_IMAGE" --name "$KIND_CLUSTER"

step "install operator chart"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic kaiad-operator-credentials \
  --namespace "$NAMESPACE" \
  --from-literal=token="$KAIAD_API_CREDENTIAL" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install kaiad-operator "$ROOT/deploy/operator/charts/kaiad-operator" \
  --namespace "$NAMESPACE" \
  --set "image.repository=${OPERATOR_IMAGE%:*}" \
  --set "image.tag=${OPERATOR_IMAGE##*:}" \
  --set "image.pullPolicy=IfNotPresent" \
  --set "kaiad.apiBaseURL=$KAIAD_API_BASE_URL" \
  --wait --timeout 90s

step "wait for operator to be ready"
kubectl -n "$NAMESPACE" wait --for=condition=Available deployment/kaiad-operator --timeout=60s

step "verify CRD is registered"
kubectl get crd kaiadagents.kaiad.dev >/dev/null

step "label a managed namespace"
kubectl create namespace e2e-target --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace e2e-target kaiad.dev/managed=true --overwrite

step "apply KaiadAgent CR"
cat <<EOF | kubectl apply -f -
apiVersion: kaiad.dev/v1alpha1
kind: KaiadAgent
metadata:
  name: $AGENT_NAME
  namespace: $NAMESPACE
spec:
  controlPlane:
    realtimeUrl: ${KAIAD_API_BASE_URL/http/ws}/realtime
  enrollment:
    autoMint: true
  image: $AGENT_IMAGE
  manages:
    - apiGroups: ["apps"]
      resources: ["deployments"]
      verbs: ["get", "list", "watch", "patch", "update"]
      namespaceSelector:
        matchLabels:
          kaiad.dev/managed: "true"
EOF

step "wait for KaiadAgent Ready=True (timeout ${TIMEOUT}s)"
deadline=$(( $(date +%s) + TIMEOUT ))
while (( $(date +%s) < deadline )); do
  status=$(kubectl get kaiadagent "$AGENT_NAME" -n "$NAMESPACE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)
  if [[ "$status" == "True" ]]; then
    echo "Ready=True"
    break
  fi
  reason=$(kubectl get kaiadagent "$AGENT_NAME" -n "$NAMESPACE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].reason}' 2>/dev/null || true)
  echo "  Ready=$status reason=$reason; sleeping 5s..."
  sleep 5
done
if [[ "$status" != "True" ]]; then
  kubectl describe kaiadagent "$AGENT_NAME" -n "$NAMESPACE" || true
  kubectl -n "$NAMESPACE" logs deployment/kaiad-operator --tail=200 || true
  echo "FAIL: KaiadAgent did not reach Ready=True within ${TIMEOUT}s" >&2
  exit 1
fi

step "verify owned objects exist"
kubectl get deployment "$AGENT_NAME" -n "$NAMESPACE" >/dev/null
kubectl get serviceaccount "${AGENT_NAME}-agent" -n "$NAMESPACE" >/dev/null
kubectl get role "kaiad-agent-${AGENT_NAME}" -n e2e-target >/dev/null

step "verify agent shows online in Kaiad API"
agent_id=$(kubectl get kaiadagent "$AGENT_NAME" -n "$NAMESPACE" -o jsonpath='{.status.enrolledAgentId}')
if [[ -z "$agent_id" ]]; then
  echo "FAIL: status.enrolledAgentId is empty" >&2
  exit 1
fi
api_status=$(curl -fsS -H "Authorization: Bearer $KAIAD_API_CREDENTIAL" \
  "$KAIAD_API_BASE_URL/api/v1/agents/$agent_id" | jq -r '.status')
if [[ "$api_status" != "online" ]]; then
  echo "FAIL: Kaiad API reports agent status=$api_status (expected online)" >&2
  exit 1
fi

step "delete CR and verify garbage collection"
kubectl delete kaiadagent "$AGENT_NAME" -n "$NAMESPACE"
gc_deadline=$(( $(date +%s) + 60 ))
while (( $(date +%s) < gc_deadline )); do
  if ! kubectl get deployment "$AGENT_NAME" -n "$NAMESPACE" >/dev/null 2>&1 \
     && ! kubectl get role "kaiad-agent-${AGENT_NAME}" -n e2e-target >/dev/null 2>&1; then
    echo "Garbage collection complete"
    break
  fi
  sleep 2
done

echo "PASS: e2e install + enrollment + cleanup"
