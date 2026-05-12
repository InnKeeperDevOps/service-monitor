---
title: Install on Kubernetes
nav_order: 3
parent: Install Agent
---

# Install Kaiad agent on Kubernetes

For Kubernetes clusters, the **Kaiad operator** reconciles a `KaiadAgent`
custom resource into a running agent Deployment. This is the recommended
install path for k8s — the manual start-command flow described in
[Install Agent]({% link agent/install.md %}) remains for VMs, edge devices,
and dev laptops.

## Architecture in one paragraph

The operator owns the agent's pod-side lifecycle (Deployment,
ServiceAccount, scoped RBAC, enrollment Secret). The agent itself, once
running, manages workload Deployments via the kube API in `kubernetes`
runtime mode. They are two separate concerns, intentionally: the operator
handles agent **infra**, the agent handles workload **lifecycle**. We did
**not** put the agent in the same pod as the workload — kubelet owns sibling
container lifecycle, so the agent loses its ability to restart or replace
workloads.

## Prerequisites

- A Kubernetes cluster (1.27+) and `kubectl` access.
- `helm` 3.14+.
- Network egress from the cluster to your Kaiad control plane on HTTPS/WSS.
- An admin or owner login on the Kaiad panel (you'll need to mint an
  operator API credential).

## 1. Mint an operator API credential

The operator needs a long-lived bearer token to call the Kaiad API on your
behalf (for minting short-TTL enrollment tokens). Create one once per
cluster. See the [API Credentials reference]({% link admin/api-credentials.md %})
for the full lifecycle (rotation, revocation, scopes).

```bash
curl -X POST https://panel.example.com/api/v1/admin/api-credentials \
  -H "Authorization: Bearer $YOUR_OWNER_SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"k8s-operator","scopes":["enrollment-tokens.create"]}'
```

The response includes a one-time `token` field — save it. The credential
hash is stored server-side; you cannot retrieve the raw token later. If you
lose it, revoke the credential and mint a new one.

## 2. Install the operator

```bash
kubectl create namespace kaiad-system

# Recommended: pre-provision the credential Secret so the chart doesn't
# template it (template-rendered Secrets leak into the Helm release object).
kubectl create secret generic kaiad-operator-credentials \
  --namespace kaiad-system \
  --from-literal=token="$KAIAD_OPERATOR_TOKEN"

helm install kaiad-operator \
  oci://ghcr.io/innkeeperdevops/charts/kaiad-operator \
  --namespace kaiad-system \
  --set kaiad.apiBaseURL=https://panel.example.com
```

The chart installs the `kaiadagents.kaiad.dev` CRD, a 1-replica operator
Deployment, and the operator's own ServiceAccount + ClusterRole.

Confirm it's healthy:

```bash
kubectl -n kaiad-system get pods,deploy,clusterrole | grep kaiad
```

## 3. Apply a `KaiadAgent` resource

```yaml
# edge-agent.yaml
apiVersion: kaiad.dev/v1alpha1
kind: KaiadAgent
metadata:
  name: edge-agent
  namespace: kaiad-system
spec:
  controlPlane:
    realtimeUrl: wss://panel.example.com/realtime
  enrollment:
    autoMint: true            # operator mints a token via the API
  image: ghcr.io/innkeeperdevops/kaiad-agent:latest
  serviceId: svc-api-1        # optional: pin log frames to a Kaiad service
  manages:
    - apiGroups: ["apps"]
      resources: ["deployments", "statefulsets"]
      verbs: ["get", "list", "watch", "patch", "update"]
      namespaceSelector:
        matchLabels:
          kaiad.dev/managed: "true"
    - apiGroups: [""]
      resources: ["pods", "pods/log"]
      verbs: ["get", "list", "watch"]
      namespaceSelector:
        matchLabels:
          kaiad.dev/managed: "true"
```

The Kaiad panel (Agents → Enrollment Tokens → "Kubernetes (operator)" tab)
generates this YAML for you with the right `realtimeUrl` pre-filled. Copy
it from there to avoid typos.

```bash
kubectl apply -f edge-agent.yaml
```

## 4. Verify

```bash
kubectl get kaiadagents -A
# NAME         IMAGE                                            AGENTID    READY   AGE
# edge-agent   ghcr.io/innkeeperdevops/kaiad-agent:latest       agt-...    True    45s
```

Within 60 seconds you should see the agent appear online in the Kaiad panel
under the **Agents** page.

## Pulling workload images from the Kaiad registry

Services built by Kaiad land in the [built-in OCI registry]({% link reference/registry.md %})
at `<KAIAD_REGISTRY_HOST>/<service-name>:<git-sha>`. When the agent deploys
those services, the cluster's kubelet needs credentials to pull from that
registry — Kaiad doesn't accept anonymous pulls.

The operator generates an **`imagePullSecrets`** Secret per `KaiadAgent`
containing a long-lived enrollment-token-derived `registrytoken` in
docker-config-json shape. The Secret is referenced in the Deployments the
agent creates for managed workloads, so kubelets `docker pull` against
Kaiad authenticate transparently.

The enrollment token grants **pull-only**, scoped to any repository — push
from this credential is rejected. Token rotation is handled by the
operator's reconcile loop; you don't need to refresh the Secret manually.

If you see `ImagePullBackOff` with `unauthorized: authentication required`,
check:

- The Secret exists (`kubectl -n <workload-ns> get secret kaiad-pull`).
- The workload Deployment references it (`imagePullSecrets: [{name: kaiad-pull}]`).
- The image ref starts with `KAIAD_REGISTRY_HOST` (not the loopback alias).
- The cluster can resolve and reach that hostname (egress + DNS) — see
  [Agent networking]({% link security/agent-networking.md %}).

## RBAC scope: what `manages` actually allows

The operator validates `spec.manages` against an allow-list. As of v0.1
the allow-list contains:

| API Group | Resources | Verbs |
|----|----|----|
| `apps` | `deployments`, `statefulsets` | `get`, `list`, `watch`, `patch`, `update` |
| `apps` | `daemonsets` | `get`, `list`, `watch` |
| (core) | `pods`, `pods/log` | `get`, `list`, `watch` |
| (core) | `events` | `get`, `list`, `watch`, `create`, `patch` |
| (core) | `configmaps` | `get`, `list`, `watch` |
| `batch` | `jobs` | `get`, `list`, `watch`, `create`, `delete` |
| `batch` | `cronjobs` | `get`, `list`, `watch` |

Anything outside this list — including `secrets`, `clusterroles`, or
wildcards — is rejected at admission time and surfaced as
`Ready=False, Reason=InvalidSpec`.

If your workflow needs a verb not in the allow-list, that's a deliberate
review point — open an issue rather than working around it.

## Removing an agent

Delete the CR; the operator garbage-collects the Deployment, ServiceAccount,
and namespaced RBAC objects via owner references:

```bash
kubectl delete kaiadagent edge-agent -n kaiad-system
```

ClusterRoles and ClusterRoleBindings (which can't carry namespace-scoped
owner refs) are deleted explicitly by the controller during finalizer
processing.

## Troubleshooting

**`Ready=False, Reason=InvalidSpec`**
:   `spec.manages` contains a rule outside the allow-list. The status
    `message` names the offending tuple. Adjust the rule or pick a
    different resource.

**`Ready=False, Reason=EnrollmentFailed`**
:   The operator could not mint a token. Common causes: wrong
    `kaiad.apiBaseURL`, missing/revoked operator credential, or the Kaiad
    API is unreachable from the cluster. `kubectl -n kaiad-system logs deploy/kaiad-operator`
    has the request error.

**`Ready=False, Reason=AgentNotOnline`**
:   The pod is running but the control plane has not seen the agent yet.
    Check egress from the cluster to the realtime URL, and look at the
    agent pod's stdout for connection errors.

**`Ready=False, Reason=DeploymentPending`**
:   Standard k8s scheduling/pull issues. `kubectl -n <agent-ns> describe deployment <agent-name>`.

## See also

- [Install Agent (Linux/VM)]({% link agent/install.md %}) — manual flow for non-k8s.
- [Agent runtimes]({% link agent/runtimes.md %}) — what `docker` / `podman` / `shell` / `kubernetes` actually do.
- [Agent networking]({% link security/agent-networking.md %}) — egress and TLS.
- Design doc: `docs/superpowers/specs/2026-05-08-kaiad-agent-operator-design.md`.
- Operator repo: `deploy/operator/`.
