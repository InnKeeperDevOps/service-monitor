---
title: KaiadAgent CRD
parent: Reference
nav_order: 5
---

# `KaiadAgent` CRD reference

The **Kaiad operator** reconciles a `KaiadAgent` custom resource into a
running agent Pod plus the supporting Kubernetes objects (Deployment,
ServiceAccount, scoped RBAC, optional ImagePullSecret reference). This
page is the field-level reference for the CR.

For the install narrative (operator credential, first CR), see
[Install on Kubernetes]({% link agent/kubernetes.md %}) — both Helm
and plain `kubectl apply` paths are documented there. For the
underlying agent binary itself, see [Install Agent]({% link agent/install.md %}).

The CRD source of truth is **`deploy/operator/api/v1alpha1/kaiadagent_types.go`**;
the rendered CRD YAML lives at
**`deploy/operator/charts/kaiad-operator/crds/kaiadagents.yaml`** (the
file is plain `apiextensions.k8s.io/v1`, applicable with `kubectl apply
-f` whether or not you use Helm).

## Identity

| Property | Value |
|----------|-------|
| **API group** | `kaiad.dev` |
| **Version** | `v1alpha1` |
| **Kind** | `KaiadAgent` |
| **Scope** | Namespaced |
| **Short name** | `kagent` |
| **List kind** | `KaiadAgentList` |

`kubectl` examples:

```sh
kubectl get kaiadagents -A
kubectl get kagent -n kaiad-system edge-agent -o yaml
```

## Printer columns

`kubectl get kaiadagents` emits these columns by default (from the
`+kubebuilder:printcolumn` markers on the Go type):

| Column | JSONPath | Notes |
|--------|----------|-------|
| `Image` | `.spec.image` | The agent container image the operator deploys. |
| `AgentId` | `.status.enrolledAgentId` | Set once the agent has registered with the control plane via the enrollment token. |
| `Ready` | `.status.conditions[?(@.type=='Ready')].status` | `True` when the pod is ready AND the control plane confirms the agent is online. |
| `Age` | `.metadata.creationTimestamp` | Standard `Age` column. |

## `spec` fields

| Path | Type | Required | Validation | Description |
|------|------|----------|------------|-------------|
| `spec.controlPlane.realtimeUrl` | string | yes | Pattern `^wss?://.+` | WebSocket URL the agent dials. Typically `wss://panel.example.com/realtime`; `ws://…` is accepted for in-cluster control planes that haven't terminated TLS. |
| `spec.enrollment.secretRef.name` | string | yes | non-empty | Name of a **Secret in the same namespace as the CR** holding the bootstrap enrollment token. Pre-provision via `kubectl create secret generic <name> --from-literal=token=<value>`. |
| `spec.enrollment.secretRef.key` | string | no | default `token` | Key inside the Secret. |
| `spec.serviceId` | string | no | — | Pins every log frame and command from this agent to a specific Kaiad service id (mirrors `SM_SERVICE_ID` in the manual flow). Leave unset when the agent observes many services. |
| `spec.image` | string | yes | MinLength=1 | Agent container image ref. Typically `ghcr.io/innkeeperdevops/kaiad-agent:<tag>`. |
| `spec.resources` | `core/v1.ResourceRequirements` | no | — | Standard k8s `requests`/`limits` shape, applied to the agent container. |
| `spec.nodeSelector` | `map[string]string` | no | — | Standard k8s node selector. |
| `spec.tolerations` | `[]core/v1.Toleration` | no | — | Standard k8s tolerations. |
| `spec.imagePullSecrets` | `[]core/v1.LocalObjectReference` | no | — | Names of `dockerconfigjson` Secrets the kubelet uses to pull the agent image. Typically `<agent>-pull` — the panel emits one alongside the enrollment Secret so kubelets can pull from the [built-in Kaiad registry]({% link reference/registry.md %}). |
| `spec.manages` | `[]ManagesRule` | no | MaxItems=32 | RBAC rules the operator grants to the agent's ServiceAccount. Each entry is validated against the allow-list below; anything outside is rejected. |

### `ManagesRule` fields

Each entry under `spec.manages[]` becomes (at most) one Role and one
ClusterRole grant:

| Path | Type | Required | Notes |
|------|------|----------|-------|
| `apiGroups` | `[]string` | yes | Kubernetes API groups (e.g. `["apps"]`, `[""]` for core). |
| `resources` | `[]string` | yes (MinItems=1) | Resource plurals (`deployments`, `pods`, `pods/log`, …). |
| `verbs` | `[]string` | yes (MinItems=1) | RBAC verbs (`get`, `list`, `watch`, `patch`, …). |
| `namespaceSelector` | `metav1.LabelSelector` | no | When present, restricts the rule to namespaces matching the selector. When omitted, the rule applies cluster-wide (a ClusterRole is generated). Setting an empty `{}` matches every namespace but still uses per-namespace Roles, which the operator narrows on namespace events. |

### RBAC allow-list

The operator validates `spec.manages` against this map before generating
any Role/ClusterRole. Anything outside fails admission with
`Ready=False, Reason=InvalidSpec`, naming the offending
`(group, resource, verb)`.

| API Group | Resources | Permitted verbs |
|-----------|-----------|-----------------|
| `apps` | `deployments`, `statefulsets` | `get`, `list`, `watch`, `patch`, `update` |
| `apps` | `daemonsets` | `get`, `list`, `watch` |
| `""` (core) | `pods`, `pods/log` | `get`, `list`, `watch` |
| `""` (core) | `events` | `get`, `list`, `watch`, `create`, `patch` |
| `""` (core) | `configmaps` | `get`, `list`, `watch` |
| `batch` | `jobs` | `get`, `list`, `watch`, `create`, `delete` |
| `batch` | `cronjobs` | `get`, `list`, `watch` |

The intent is that **a tenant who can apply a `KaiadAgent` CR cannot
escalate to cluster-admin or read Secrets through it.** Adding a row
should be a deliberate decision — pair it with a test in
`deploy/operator/internal/controller/rbac_test.go`.

Source: **`deploy/operator/internal/controller/allowlist.go`**.

## `status` fields

The operator owns `status`; do not edit it by hand. `+kubebuilder:subresource:status`
means `kubectl edit` on the CR doesn't touch it either.

| Path | Type | Notes |
|------|------|-------|
| `status.conditions` | `[]metav1.Condition` | See condition types below. |
| `status.enrolledAgentId` | string | The agent id assigned by the control plane on first successful enrollment. Stable across restarts. |
| `status.observedGeneration` | int64 | `metadata.generation` of the spec the operator last reconciled. Use this to detect a stale status. |
| `status.deploymentName` | string | Name of the Deployment the operator created. Useful for `kubectl describe deploy <name>`. |

### Condition types

| Type | True means | Common failure reasons |
|------|-----------|------------------------|
| `Ready` | Pod is `Ready` AND control plane has confirmed the agent is online. | `EnrollmentFailed`, `DeploymentPending`, `AgentNotOnline`. |
| `EnrollmentValid` | A usable bootstrap token exists in the referenced Secret. | `SecretNotFound`, `MissingKey`, `EmptyToken`. |
| `Reconciling` | The operator is mid-apply. | (transient; flips back to `False` after settle.) |

A failure reason on `Ready=False` is mirrored in the condition's
`message` field with the exact offending tuple or upstream error —
look at `kubectl get kagent <name> -o yaml` under `status.conditions[]`
when triage starts.

## Minimal `KaiadAgent`

The smallest spec that will actually run:

```yaml
apiVersion: kaiad.dev/v1alpha1
kind: KaiadAgent
metadata:
  name: edge-agent
  namespace: kaiad-system
spec:
  controlPlane:
    realtimeUrl: wss://panel.example.com/realtime
  enrollment:
    secretRef:
      name: kaiad-enrollment
  image: ghcr.io/innkeeperdevops/kaiad-agent:v1.2.3
```

The Secret it references:

```sh
kubectl -n kaiad-system create secret generic kaiad-enrollment \
  --from-literal=token='<paste-from-panel>'
```

Generate the token in the panel under **Settings → Enrollment tokens →
Generate token** before applying the CR.

## Full example with RBAC + pull secret

```yaml
apiVersion: kaiad.dev/v1alpha1
kind: KaiadAgent
metadata:
  name: edge-agent
  namespace: kaiad-system
spec:
  controlPlane:
    realtimeUrl: wss://panel.example.com/realtime
  enrollment:
    secretRef:
      name: kaiad-enrollment
      key: token
  image: ghcr.io/innkeeperdevops/kaiad-agent:v1.2.3

  # Optional: pin every log frame from this agent to one service.
  serviceId: svc-api-1

  # Standard pod knobs.
  resources:
    requests: { cpu: 50m,  memory: 64Mi }
    limits:   { cpu: 500m, memory: 256Mi }
  nodeSelector:
    kaiad.dev/role: agent
  tolerations:
    - key: kaiad.dev/dedicated
      operator: Equal
      value: agent
      effect: NoSchedule

  # Pull the agent image (and any workload images Kaiad built) from the
  # built-in registry. The panel emits this Secret alongside the
  # enrollment Secret.
  imagePullSecrets:
    - name: edge-agent-pull

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
    - apiGroups: ["batch"]
      resources: ["jobs"]
      verbs: ["get", "list", "watch", "create", "delete"]
      namespaceSelector:
        matchLabels:
          kaiad.dev/managed: "true"
```

## Reconcile lifecycle

{::nomarkdown}
{% include mermaid-kaiad-agent-reconcile.html %}
{:/nomarkdown}

1. **Validate spec** — `manages` against the allow-list. Any rule
   outside the allow-list → `Ready=False, Reason=InvalidSpec` and the
   reconcile stops here.
2. **Resolve enrollment Secret** — read `spec.enrollment.secretRef.name`
   from the CR's namespace. Missing or empty key → `EnrollmentValid=False`
   and the reconcile retries on Secret update.
3. **Ensure ServiceAccount + RBAC** — create the agent's
   ServiceAccount; for each `manages[]` rule, create the
   namespace-scoped Roles + RoleBindings (or one ClusterRole +
   ClusterRoleBinding when `namespaceSelector` is omitted).
4. **Ensure Deployment** — 1-replica Deployment running the
   `spec.image` container, with `SM_REALTIME_URL`,
   `SM_ENROLLMENT_TOKEN` (from the Secret), and optional
   `SM_SERVICE_ID` injected as env. `imagePullSecrets` threaded onto
   the Pod spec.
5. **Wait for the pod** — flip `Reconciling=False`. Once the kubelet
   reports `Ready=True` AND the control plane responds that the agent
   is online, flip `Ready=True` and record `enrolledAgentId`.

Owner references make all the generated objects garbage-collect when
the CR is deleted. ClusterRoles / ClusterRoleBindings (which can't
carry namespace-scoped owner refs) are deleted by the controller's
finalizer.

## Removing an agent

```sh
kubectl delete kaiadagent edge-agent -n kaiad-system
```

Behavior:

- The agent Pod stops first; the control plane flips the agent to
  `offline` after heartbeat timeout (~30s).
- Owner-referenced objects (Deployment, ServiceAccount, Roles,
  RoleBindings) are garbage-collected by Kubernetes.
- ClusterRoles and ClusterRoleBindings are deleted explicitly by the
  finalizer.
- The enrollment Secret you created is **not** removed (the operator
  doesn't own it). Delete it separately if the token shouldn't outlive
  the agent.

## Troubleshooting condition values

Before any of these reasons can show up, the CRD must actually be
installed. A `kubectl apply` of a `KaiadAgent` against a cluster
without the CRD fails at `kubectl` time (not in the operator) with:

```
error: resource mapping not found for name: "<name>" namespace: "<ns>"
no matches for kind "KaiadAgent" in version "kaiad.dev/v1alpha1"
ensure CRDs are installed first
```

Apply the CRD once per cluster — see
[Install on Kubernetes]({% link agent/kubernetes.md %}#3-apply-a-kaiadagent-resource)
for the install command — then retry your CR apply. The CRD is
cluster-scoped, so every namespace inherits it.

| Reason | Meaning | Next step |
|--------|---------|-----------|
| `InvalidSpec` | A `manages[]` rule names a tuple outside the allow-list. | Fix the rule or open an issue arguing for the new allow-list entry. |
| `SecretNotFound` | `spec.enrollment.secretRef.name` doesn't exist in the namespace. | Create it (`kubectl create secret generic …`). |
| `MissingKey` | The Secret exists but the configured `key` (default `token`) isn't set. | Add the key or adjust `enrollment.secretRef.key`. |
| `EmptyToken` | The key is set but empty. | Mint a real enrollment token in the panel. |
| `EnrollmentRejected` | The control plane rejected the token (expired, revoked, or wrong tenant). | Mint a new token; tokens are tenant-bound at mint time and can't be moved. |
| `DeploymentPending` | The Deployment exists but no Pod is `Ready` yet. | `kubectl -n <ns> describe deploy <status.deploymentName>` for scheduling / pull errors. |
| `AgentNotOnline` | The Pod is `Ready` but the control plane hasn't seen a heartbeat. | Check egress to `realtimeUrl` from inside the cluster; agent pod stdout will name the connect failure. |

## See also

- [Install on Kubernetes]({% link agent/kubernetes.md %}) — install narrative with both Helm and plain `kubectl apply` paths.
- [Binding services to agents]({% link agent/binding-services.md %}) — many-to-many binding lifecycle.
- [Built-in OCI registry]({% link reference/registry.md %}) — what the `imagePullSecrets` Secret authenticates against.
- [Agent networking]({% link security/agent-networking.md %}) — egress and TLS expectations.
- Operator code: `deploy/operator/api/v1alpha1/kaiadagent_types.go`,
  `deploy/operator/internal/controller/`.
