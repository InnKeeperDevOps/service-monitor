# Kaiad Agent Operator (Design)

Date: 2026-05-08
Status: Draft

## Overview

Today, installing a Kaiad agent on a host means: generate an enrollment token in the panel, copy a long `SM_REALTIME_URL=… SM_ENROLLMENT_TOKEN=… /usr/local/bin/agent` start command, paste it onto a machine. That works for VMs and bare metal but is a poor fit for Kubernetes, where users expect a declarative install (`kubectl apply -f`) and an operator-managed lifecycle.

This document proposes a Kubernetes operator that reconciles a `KaiadAgent` custom resource into a running agent Deployment, owning the agent's lifecycle (image, env, RBAC, enrollment) inside the cluster. The agent itself, once running, continues to manage workloads via the existing `kubernetes` runtime backend. Operator handles agent infra; agent handles workloads.

## Goals

1. Cluster admins can install a Kaiad agent by applying a single `KaiadAgent` CR — no shell-pasted start command.
2. The CR captures everything currently embedded in the start command: control-plane URL, enrollment, optional service binding, runtime backend.
3. Lifecycle (rolling updates, deletion, ownership) follows kube-native conventions: owner refs, finalizers, status conditions.
4. The operator scopes the agent's RBAC narrowly so a misbehaving agent cannot escape the namespaces it was granted.
5. Coexists with the existing manual start-command flow — the manual flow remains the recommended path for non-k8s hosts.

## Non-Goals

- **Replacing the workload Deployment with a CR.** A separate `KaiadService` CRD that reconciles into an arbitrary workload Deployment is a much larger product step (Kaiad-as-deployment-platform); this design stops at the agent.
- **Same-pod sidecar topology.** Agent and workload in the same pod was considered and rejected: kubelet owns sibling-container lifecycle, so the agent loses its core "restart / replace image" capabilities. The operator places the agent in its own Deployment and lets it drive workload Deployments via the kube API.
- **Multi-cluster federation.** One operator manages agents inside its own cluster. Cross-cluster scenarios are out of scope.

## Custom Resource

```yaml
apiVersion: kaiad.dev/v1alpha1
kind: KaiadAgent
metadata:
  name: edge-agent
  namespace: kaiad-system
spec:
  # Required: how the agent reaches Kaiad
  controlPlane:
    realtimeUrl: wss://panel.example.com/realtime

  # Required: bootstrap credential (Secret holds the token; operator never logs it)
  enrollment:
    secretRef:
      name: kaiad-enrollment
      key: token              # default "token"
    # Optional: ask the operator to mint a token for us if the secret is absent
    # Requires the operator to be configured with an admin API credential.
    # autoMint: true

  # Optional: pin all log frames from this agent to a specific Kaiad service
  serviceId: svc-api-1

  # Required: the agent image
  image: ghcr.io/innkeeperdevops/kaiad-agent:v1.2.3

  # Optional: standard pod knobs
  resources:
    requests: { cpu: 50m, memory: 64Mi }
    limits:   { cpu: 500m, memory: 256Mi }
  nodeSelector: { ... }
  tolerations: [ ... ]
  priorityClassName: ...

  # RBAC: which workloads this agent may manage. The operator generates a
  # ServiceAccount + (Cluster)Role with exactly these permissions. Anything
  # outside this list is unreachable from the agent's API client.
  manages:
    - apiGroups: ["apps"]
      resources: ["deployments", "statefulsets"]
      verbs: ["get", "list", "watch", "patch", "update"]
      namespaceSelector:
        matchLabels: { kaiad.dev/managed: "true" }
    - apiGroups: [""]
      resources: ["pods", "pods/log"]
      verbs: ["get", "list", "watch"]
      namespaceSelector:
        matchLabels: { kaiad.dev/managed: "true" }

status:
  conditions:
    - type: Ready
      status: "True"
      reason: AgentEnrolled
      message: Agent connected to control plane
      lastTransitionTime: 2026-05-08T20:14:02Z
  enrolledAgentId: agt-9f3a…
  observedGeneration: 1
  deploymentName: edge-agent
```

Field notes:

- `runtime` is **not** in the spec — operator-installed agents always run with `SM_AGENT_RUNTIME_OVERRIDE=kubernetes`. The runtime selector in the AgentsPage panel is for the manual start-command flow only.
- `manages` is a hard ceiling, not a hint. The operator never grants broader permissions even if the platform would like them.
- `enrollment.autoMint` is deferred to v2 (see "Token flow" below).

## Operator responsibilities

For each `KaiadAgent` CR the operator reconciles into:

1. **`ServiceAccount`** in the CR's namespace, named after the CR.
2. **`(Cluster)Role` + `(Cluster)RoleBinding`** generated from `spec.manages`. ClusterRole if any selector is cluster-wide; otherwise per-namespace Roles.
3. **`Deployment`** with one replica running the agent image. Env wiring:
   - `SM_REALTIME_URL` from `spec.controlPlane.realtimeUrl`
   - `SM_ENROLLMENT_TOKEN` from the referenced Secret (env-from-secret, never logged)
   - `SM_AGENT_RUNTIME_OVERRIDE=kubernetes`
   - `SM_SERVICE_ID` if `spec.serviceId` is set
   - `SM_AGENT_PERSIST_CREDENTIALS=1` so the agent persists its post-enrollment credential into a mounted volume (see below)
4. **`Secret`** (operator-owned) for the agent's persisted credential after first successful enrollment, mounted into the agent pod. Avoids re-using the bootstrap token across restarts.
5. **Owner refs** on every generated object so deleting the CR garbage-collects the lot.
6. **Status conditions**: `Ready`, `EnrollmentValid`, `Reconciling`. Updated from observed Deployment status plus the agent's own check-in (operator polls Kaiad API for `agt-…` presence — see "Operator → Kaiad API" below).

Reconciliation is idempotent. Spec drift (e.g., image bump) results in a Deployment patch; rollout is whatever the Deployment strategy dictates.

## RBAC model

Two layers:

**Operator → cluster (install-time, via Helm chart):**
- Read/watch `KaiadAgent`
- Create/patch/delete `Deployment`, `ServiceAccount`, `Role`, `RoleBinding`, `Secret` in any namespace where a CR exists
- Update `KaiadAgent/status`

**Agent → cluster (per CR, generated):**
- Whatever `spec.manages` says. Nothing else.

The operator validates `spec.manages` against an allow-list (defaults: `apps/Deployment`, `apps/StatefulSet`, `pods`, `pods/log`, `events`). Anything outside the allow-list is rejected at admission time. This prevents a tenant CR from binding `cluster-admin` to its agent.

## Token flow

The trickiest part. Three viable shapes; this design picks (B).

| Approach | Pros | Cons |
|----|----|----|
| (A) Admin pre-creates Secret | No operator → API calls; minimal trust surface. | Manual two-step install (mint token, kubectl apply). Doesn't really feel "kube-native." |
| (B) Operator mints on demand (chosen) | Single-step install. Operator holds long-lived API credential, mints short-TTL bootstrap tokens per CR. | Adds an API permission scope (`enrollment-tokens.create`) + token rotation story for the operator's own credential. |
| (C) Per-CR projected token | Each agent has its own kube-issued JWT validated by Kaiad. | Requires Kaiad to validate kube SA JWTs (large change). Out of scope. |

For (B), the operator is configured at install time with a Kaiad **operator API credential** (a long-lived bearer token) stored in `kaiad-system/kaiad-operator-credentials`. The credential carries `enrollment-tokens.create` and `agents.read`. When a CR is reconciled and `spec.enrollment.secretRef` resolves to an empty/missing Secret with `autoMint: true`, the operator calls `POST /api/v1/agents/enrollment-tokens` with a short TTL (e.g., 5 minutes), writes the result into the Secret, and proceeds. The token is consumed on first agent connection; after that, `SM_AGENT_PERSIST_CREDENTIALS=1` makes the persisted credential the live one. The bootstrap Secret can be wiped by the operator after `Ready=True`.

This requires a new API scope on the Kaiad side. It does not require a new API endpoint — `POST /api/v1/agents/enrollment-tokens` already exists.

## Install UX

The Agents page gains a second install path. The existing **start-command flow** stays for VM/bare-metal hosts. New tab:

> **Install on Kubernetes**
>
> ```bash
> # 1. Install the operator (one-time per cluster)
> helm install kaiad-operator oci://ghcr.io/innkeeperdevops/charts/kaiad-operator
>
> # 2. Apply a KaiadAgent CR
> kubectl apply -f - <<EOF
> apiVersion: kaiad.dev/v1alpha1
> kind: KaiadAgent
> metadata: { name: edge-agent, namespace: kaiad-system }
> spec:
>   controlPlane: { realtimeUrl: wss://panel.example.com/realtime }
>   enrollment: { autoMint: true }
>   serviceId: <generated-service-id-or-blank>
>   image: ghcr.io/innkeeperdevops/kaiad-agent:v1.2.3
>   manages:
>     - apiGroups: ["apps"]
>       resources: ["deployments"]
>       verbs: ["get","list","watch","patch","update"]
>       namespaceSelector: { matchLabels: { kaiad.dev/managed: "true" } }
> EOF
> ```

The panel can pre-fill the YAML with the user's chosen `serviceId`. This becomes a "copy YAML" button next to the existing "copy start command" — analogous flows, two install paths.

## Repo layout

New module under `deploy/operator/`:

```
deploy/operator/
  README.md
  go.mod
  cmd/manager/main.go
  api/v1alpha1/
    kaiad_agent_types.go
    zz_generated_deepcopy.go
  internal/controller/
    kaiadagent_controller.go
    rbac.go            # spec.manages → Role/RoleBinding generation
    enrollment.go      # token minting / Secret materialization
  config/
    crd/kaiad.dev_kaiadagents.yaml
    rbac/role.yaml
    samples/v1alpha1_kaiadagent.yaml
  charts/kaiad-operator/  # Helm chart
```

Built with kubebuilder/controller-runtime. Lives in the same repo for now; can split out later if it grows.

## Versioning matrix

Three things move independently:

- **CRD version** (`v1alpha1` → `v1beta1` → `v1`). Use the standard Kubernetes API versioning rules.
- **Operator image version**. Pinned per Helm chart release.
- **Agent image version**. Specified in `KaiadAgent.spec.image`.

The operator must accept any agent image (it doesn't introspect the binary). The operator's compatibility window with the Kaiad control plane API is documented per release. CRD storage version is bumped only via formal conversion webhooks.

## Migration / coexistence

- The manual start-command flow is **not** deprecated. Reasons: VMs, edge devices, dev laptops.
- Agents enrolled via either flow appear identically in the panel — there is no schema-level distinction. The `agents` row already has everything we need.
- A future enhancement (out of scope here) is for the panel to surface "this agent was operator-installed" by detecting kube-style metadata in the agent's `kaiad hello`. Cosmetic; not load-bearing.

## Open questions

1. **Should the operator create the workload Deployment too?** (i.e., a `KaiadService` CRD wrapping the workload spec). Decision deferred. Flagged as the obvious follow-up.
2. **What's the operator's posture on multi-tenant clusters?** Currently the CR namespace implicitly defines scope. Should one operator instance serve multiple Kaiad tenants? Probably yes — the API credential resolves the tenant — but RBAC review needed before locking in.
3. **Helm vs. OLM distribution.** Helm is sufficient for the MVP audience. OLM would be a v2 nice-to-have for OpenShift / catalog-driven installs.
4. **Should `manages` allow a `cluster: true` flag (cluster-wide RBAC)?** Defaulting to namespace-scoped is safer; cluster-wide is opt-in only.

## Cost estimate

Realistic build for MVP (CRD + reconciler + RBAC generator + token mint flow + Helm chart + tests + docs): **1–2 weeks of focused work**. The reconciler itself is small; most of the time goes to RBAC generation correctness, end-to-end testing on a real cluster, and the Helm chart packaging story.

## Decision

Pending review of this document.
