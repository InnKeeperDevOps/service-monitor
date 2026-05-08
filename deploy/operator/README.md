# Kaiad Agent Operator

The Kaiad agent operator reconciles `KaiadAgent` custom resources into
running agent Deployments inside a Kubernetes cluster. It owns the agent's
pod-side lifecycle (Deployment, ServiceAccount, scoped RBAC, enrollment
Secret); the agent itself, once running, manages workload Deployments via
the kube API.

See `docs/superpowers/specs/2026-05-08-kaiad-agent-operator-design.md` for
the design rationale and `docs/superpowers/plans/2026-05-08-kaiad-agent-operator-plan.md`
for the task-by-task implementation plan.

## Layout

```
deploy/operator/
  cmd/manager/         -- manager entrypoint (main.go)
  api/v1alpha1/        -- KaiadAgent CRD Go types
  internal/controller/ -- reconciler + RBAC generator
  internal/kaiad/      -- HTTP client for the Kaiad API
  config/              -- CRD YAML, RBAC manifests, sample CRs
  charts/              -- Helm chart
  test/e2e/            -- bash-driven kind smoke test
```

## Build

```bash
go build ./...        # compile from this directory
make docker-build     # build the manager container image (default tag kaiad-operator:dev)
```

## Run locally

The operator needs an admin API credential for the Kaiad control plane. Mint one
at `POST /api/v1/admin/api-credentials` with the `enrollment-tokens.create`
scope, then:

```bash
KAIAD_API_BASE_URL=http://localhost:3000 \
KAIAD_API_CREDENTIAL=kop_... \
go run ./cmd/manager
```

The manager will look up `~/.kube/config` and start watching `KaiadAgent`
resources in the active context.
