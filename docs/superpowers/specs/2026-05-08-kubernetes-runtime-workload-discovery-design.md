# Kubernetes-runtime workload discovery (Design)

Date: 2026-05-08
Status: Draft

## Problem

The Kaiad agent's `kubernetes` runtime is currently a stub. It connects
to the control plane, accepts the `kaiad hello` message, and runs
`run_step` / `run_fix_plan` commands as ordinary processes inside the
agent pod. It does **not**:

- discover workloads (Deployments, Pods) in the cluster,
- tail logs from those workloads,
- emit `app_log_error` frames from the workload's stderr/stdout,
- populate or update `MonitoredService` rows on the platform.

The integration test on minikube
(`docs/superpowers/plans/2026-05-08-docs-refresh-plan.md` follow-up,
covered in this session) confirmed this end-to-end: the operator
successfully reconciled a `KaiadAgent` and the agent appeared online
in the panel, but a deployed `springboot-test-server` workload was
invisible to Kaiad until a `MonitoredService` row was hand-created
purely as metadata. No logs flowed.

This design proposes a workload-discovery + log-tailing path that
brings the kubernetes runtime to feature parity with the docker
runtime for the **observability** subset (logs + telemetry +
auto-fix). Container lifecycle ops (`docker_op`) and `sync_desired_state`
remain out of scope for now — kubelet owns pod lifecycle in k8s and
mapping those onto kube API calls is a separate, larger conversation.

## Goals

1. The agent watches pods that match user-declared selectors and
   streams their logs into the existing `app_log_error` pipeline.
2. A panel-side `MonitoredService` declares its kubernetes binding
   (namespace + label selector) once; the agent attaches automatically
   on creation and detaches on update/delete.
3. The auto-fix loop works on kubernetes-runtime agents: when an
   `app_log_error` lands, `run_fix_plan` clones the service repo, runs
   the configured plan executor, commits, and pushes — same flow as
   docker today, just inside the agent pod.
4. RBAC stays narrow: discovery and log-tailing fit inside the
   existing `pods` / `pods/log` allow-list.

## Non-goals

- **`docker_op` mapping.** `kubectl rollout restart`, `kubectl apply`,
  etc. would let the platform mutate workloads. That's a separate
  feature and a different RBAC story (`patch deployments`).
- **Auto-create `MonitoredService` rows from cluster state.** Tempting
  but invasive — turns Kaiad into a service registry. Stick with
  user-declared services that opt in via labels.
- **`metrics-server`-backed per-pod telemetry.** The docker runtime
  ships per-container CPU/mem; the kube equivalent is `PodMetrics`,
  requires `metrics-server` to be installed in the cluster, and is
  noisy. Defer.
- **`sync_desired_state` mapping.** That command's intent is "make
  these processes/containers exist." On Kubernetes, that's the
  workload Deployment's job, not the agent's. Treat the operator +
  Deployment as the lifecycle layer; the agent observes only.

## Discovery model

Three options were considered.

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A. Watch every pod the agent has RBAC for** | Tail every pod in every namespace matching the `KaiadAgent.spec.manages` selector. | Zero per-service config. | Grouping is awkward — what `serviceId` does the agent send for an unowned pod? Likely "unknown" or pod name; either is poor UX. Hard to disable per-workload. |
| **B. Per-MonitoredService kubernetes binding (recommended)** | Add `kubernetes: { namespace, labelSelector }` to `MonitoredService`. Agent attaches one tailer per service. | Explicit, reviewable, opt-in. Maps cleanly onto existing service abstraction. Re-uses `serviceId` for fingerprint correctness in error grouping. | Requires schema change + UI affordance. |
| **C. Pod-side annotation (`kaiad.dev/service-id: svc-1`)** | Workload owners annotate their pods with the service id. Agent watches all pods, attaches when annotation matches a `MonitoredService`. | Works without a label-selector; close to the docker runtime where the container name = service id. | Inverts the trust direction — workload teams configure Kaiad. Annotation drift is hard to debug. |

**Recommendation: option B.** It mirrors how the docker runtime uses
the service id baked into the container's `SM_SERVICE_ID` env var,
keeps `MonitoredService` as the single source of truth, and gives the
panel an obvious UI hook ("which pods belong to this service?").
Option C is a useful future addition once B is in place.

## Schema changes

### Add `kubernetes` to `MonitoredService`

```ts
// packages/contracts/src/http.ts
export const kubernetesServiceBindingSchema = z.object({
  namespace: z.string().min(1),
  labelSelector: z.object({
    matchLabels: z.record(z.string()).optional(),
    matchExpressions: z.array(/* standard selector expression */).optional()
  })
});

export const monitoredServiceSchema = z.object({
  // ...existing fields...
  kubernetes: kubernetesServiceBindingSchema.optional()
});
```

Database column: `monitored_services.kubernetes_binding jsonb null`.
Migration: additive; existing services keep `kubernetes = null` and the
agent ignores them.

### Why a `LabelSelector`, not a list of pod names

Pods are ephemeral. A Deployment's pods cycle on rollout; the selector
matches whatever the live ReplicaSet creates. Listing pod names would
require continuous reconciliation by the user or the panel, and would
break on every rolling update.

## Agent implementation

New package: `apps/agent/internal/kube/`. Three pieces:

### 1. `client`

Thin wrapper around `client-go`. Reads the in-cluster
ServiceAccount token (already mounted at
`/var/run/secrets/kubernetes.io/serviceaccount/`) and exposes:

```go
type Client interface {
    WatchPods(ctx context.Context, namespace string, selector labels.Selector) (PodEventStream, error)
    StreamLogs(ctx context.Context, namespace, pod, container string, opts LogOptions) (io.ReadCloser, error)
}
```

The agent already authenticates to the kube API via its
`kaiad-agent-<crname>` SA generated by the operator. No new RBAC.

### 2. `tailer`

Per-service goroutine that:

- subscribes to platform messages of type `kubernetes_binding_update`
  (new realtime command — see below) to learn its assigned services
  and selectors;
- watches pods matching each service's selector in its namespace;
- for each new pod, opens a streaming `pods/log?follow=true` request
  and pipes lines into the same `logship.Sender` the docker runtime
  uses, tagged with the service id;
- handles pod deletion / container restart by reopening the stream
  with a `sinceTime` of the last seen line (lossy but bounded);
- stops watching when a binding is removed.

The `logship.Sender` already does line-level error classification +
context buffering. Same `app_log_error` frames, same fingerprint
normalization, same auto-fix dispatch path. **No platform-side change
to the error-grouping or auto-fix flow.** That's the cleanness benefit
of routing through the existing pipeline.

### 3. wiring in `cmd/agent/main.go`

The `case "kubernetes":` arm of the `kaiad hello` switch grows from
2 lines to:

```go
case "kubernetes":
    exec.Configure(nil, executor.RuntimeKubernetes)
    kc, err := kube.InCluster()
    if err != nil {
        log.Printf("kubernetes runtime: in-cluster client failed: %v", err)
        return
    }
    tailer := kube.NewTailer(kc, logSender, agentID)
    exec.SetServiceReconciler(tailer) // see below
    log.Printf("kubernetes-runtime tailer wired (agent=%s)", agentID)
```

Mirrors the existing `case "shell"` shape. `SetServiceReconciler` is a
new method on the executor; it accepts a callback the platform uses
to push updated bindings.

## Realtime protocol additions

One new platform→agent message kind:

```ts
// packages/contracts/src/realtime.ts
const kubernetesBindingUpdateSchema = z.object({
  type: z.literal("kubernetes_binding_update"),
  bindings: z.array(z.object({
    serviceId: z.string(),
    namespace: z.string(),
    labelSelector: z.object({/* … */})
  }))
});
```

Sent on agent connect + whenever the tenant's services with non-null
`kubernetes_binding` change. The agent reconciles the new list against
its in-flight tailers (start new ones, stop removed ones, leave
unchanged ones running).

This avoids the agent having to call the platform back to enumerate
services — the platform tells it what to watch. Same pattern the
existing `sync_desired_state` uses for shell-runtime processes.

## RBAC

The `KaiadAgent.spec.manages` allow-list already permits the verbs we
need:

```yaml
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list", "watch"]
  namespaceSelector: { matchLabels: { kaiad.dev/managed: "true" } }
```

`watch` covers the streaming list-watch the tailer uses. `pods/log` is
the subresource for streaming logs. No new entries on the operator's
allow-list (`internal/controller/allowlist.go`).

A `MonitoredService.kubernetes.namespace` outside the agent's
`manages.namespaceSelector` is a config error; the agent should refuse
the binding and report a `service_binding_error` event rather than
fail silently. Surfacing it requires a small UI affordance on the
service detail page.

## Lifecycle

| Event | Agent behavior |
|---|---|
| New `MonitoredService` with `kubernetes` block | Platform pushes `kubernetes_binding_update`; agent starts a watch + per-pod tailers. |
| `MonitoredService` updated (selector change) | Agent stops the old watch (close pod streams), starts a new one. In-flight context buffers are dropped — acceptable, the fingerprint + group dedup absorb it. |
| `MonitoredService` deleted | Agent stops the watch and closes all log streams. |
| Pod added to selector match | Agent opens `pods/log?follow=true` for each container; fans into the service's log buffer. |
| Pod restart (container exit + recreate) | Stream EOFs; agent waits for next pod-update event from the watch and reopens. Brief gap is acceptable; document it. |
| Pod deleted | Stream EOFs and the watch fires Deleted; agent drops the buffer. |
| Namespace selector on `KaiadAgent.spec.manages` changes | Operator already re-reconciles RBAC; agent learns via watch failures (apiserver returns Forbidden) and re-fetches bindings on the next reconcile. |

## Failure modes

- **Agent loses kube API connectivity.** Watches return errors; the
  agent retries with exponential backoff. While disconnected, pod
  events are missed; on reconnect, the agent does a full list and
  reconciles. Logs from that interval are gone — same as a docker
  daemon outage on the docker runtime.
- **Agent loses platform connectivity.** Existing transport
  reconnect logic handles this; the bindings list is replayed on the
  next `kubernetes_binding_update`.
- **Pod is very chatty.** The per-service `logship.Sender` already
  buffers lines and fingerprints aggressively. A pod producing 10k
  lines/sec produces 1 group per fingerprint, not 10k. Same as today.
- **Pod has many containers.** Agent opens one stream per container;
  acceptable for typical 1–3 container pods. Cap at 10 containers per
  pod to bound goroutine count; log a warning above that.

## Open questions

1. **Should the agent auto-bind a service when a Deployment label
   matches the service's selector but the user hasn't set
   `kubernetes.namespace`?** Probably not — explicit beats clever
   here. But worth raising before locking in.
2. **What is the panel UX for binding a `MonitoredService` to a
   kubernetes selector?** Probably a section on the service create /
   edit form with `namespace` + `matchLabels` text input. Defer the
   visual design.
3. **Multi-cluster.** ~~A single `MonitoredService` whose pods live in
   multiple clusters. Each cluster has its own KaiadAgent → operator
   → SA. Probably each agent independently tails its in-cluster pods
   and reports under the same `serviceId`. Confirm before building.~~
   **Resolved**: the agent ↔ service binding is now many-to-many (see
   `docs/superpowers/plans/2026-05-08-multi-agent-service-binding-plan.md`),
   so a single `MonitoredService` can have one agent in each of several
   clusters. Each agent independently watches its in-cluster pods using
   the per-binding `kubernetes.namespace + labelSelector`. Logs flow
   under the same `serviceId` and dedupe at the API into one error-group
   set. No protocol change required.
4. **Init containers / sidecars.** Should the tailer pick up logs
   from init containers (one-shot, often diagnostic)? Conservatively:
   no — only the primary container by default, with an opt-in flag
   on the binding.

## Cost estimate

For the MVP described above (option B, no auto-discovery, no
`docker_op` mapping):

| Surface | Effort |
|---|---|
| Schema (`monitored_services.kubernetes_binding`, contracts, generator) | 0.5 day |
| Agent `internal/kube/{client,tailer}` | 1.5 days |
| Wiring in `cmd/agent/main.go` + executor reconciler hook | 0.5 day |
| Realtime `kubernetes_binding_update` push from platform | 0.5 day |
| Panel form for binding + service detail page surfacing | 0.5 day |
| Tests (agent unit + envtest, contract round-trip, panel) | 0.5 day |
| Docs update (`runtimes.md`, `kubernetes.md`) | 0.5 day |

**~4 days total**, sized to one focused engineer-week including the
inevitable kube-client edge cases. Comparable to the original operator
build.

## Decision

Pending review of this document.
