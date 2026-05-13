---
title: Reference
nav_order: 7
has_children: true
---

# Reference

Material here is **dense and factual**: schemas, flags, queues, and headers. Use it when integrating agents, automating deployments, or debugging cross-service behavior. For narrative onboarding, start with [Getting started]({% link getting-started/index.md %}).

## Build & deploy

The build pipeline and registry have their own reference pages — start here when onboarding a repo or debugging a build:

- **[`kaiad.yaml` reference]({% link reference/pipeline.md %})** — every field, every option, the build-mode split (`build/runtime` vs `dockerfile:`), `environments:`, `dependsOn:`, `kind:`, validation rules.
- **[Pipeline variables]({% link reference/pipeline-variables.md %})** — `{var}` substitution, system vars (`kaiad_registry_host`), dependency vars (`{<dep>_version}`, `{<dep>_image_ref}`, …), naming rules.
- **[Built-in OCI registry]({% link reference/registry.md %})** — `/v2/*` endpoints, JWT auth, Postgres-backed storage, pagination, garbage collection CLI, compose env vars.

For the panel walkthrough (SSH key, service creation, first build), see [Onboarding a service]({% link getting-started/onboarding-services.md %}).

## Kubernetes custom resources

The Kaiad operator reconciles a single CRD that wires an agent + its scoped RBAC into a cluster:

- **[`KaiadAgent` CRD reference]({% link reference/kaiad-agent-crd.md %})** — `kaiad.dev/v1alpha1`, spec fields, the RBAC allow-list, status condition types + reasons, reconcile lifecycle diagram.

For the install path (helm chart, operator credential, first CR), see [Install on Kubernetes]({% link agent/kubernetes.md %}).

## OpenAPI

The HTTP contract is captured in the **OpenAPI 3.1** document generated from shared contracts:

- Repository path: **`packages/contracts/openapi/openapi.yaml`**

Regenerate or extend that spec when you add or change routes in `@sm/contracts` so clients, mocks, and docs stay aligned.

## Agent binary

The v1 agent is a **Go** binary that maintains a **WebSocket** to the control plane’s realtime endpoint.

| Mechanism | Description |
|-----------|-------------|
| **Planned CLI flags** | `--platform-url` (WSS base, e.g. `wss://api.example.com`), `--enrollment-token` (one-time or rotating enrollment secret), `--docker-socket` (path to Docker socket for workload control). Use these in systemd units and containers when the CLI exposes them. |
| **Current configuration** | Today the sample binary reads **`SM_REALTIME_URL`** (defaults to `ws://localhost:3001/realtime`) and **`SM_AGENT_ID`**. Align env names with your orchestration until flag parity ships. |

See [Install Agent]({% link agent/install.md %}) for packaging and systemd.

## Environment variables (summary)

### API

| Variable | Notes |
|----------|--------|
| `PORT` | HTTP port (default `3001`). |
| `DATABASE_URL` | Postgres connection string when using Postgres-backed tenant store. |
| `GITHUB_WEBHOOK_SECRET` | Webhook HMAC secret for `POST /webhooks/github`. |
| `DEFAULT_WEBHOOK_TENANT_ID` | Tenant used when mapping certain webhook payloads (default `t-webhook` in code). |
| `POSTGRES_HOST` / `POSTGRES_PORT` | Used by readiness TCP checks when configured. |
| `REDIS_HOST` / `REDIS_PORT` or `REDIS_URL` | Readiness and queue connectivity. |

### Worker

| Variable | Notes |
|----------|--------|
| `REDIS_URL` or `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | BullMQ connection. |
| `WORKER_HEALTH_PORT` / `WORKER_HEALTH_HOST` | Worker HTTP health bind. |
| `GITHUB_APP_PRIVATE_KEY` | PEM for GitHub App (worker GitHub client). |
| `SM_GITHUB_SIMULATE` | When set to `1`, simulates GitHub where implemented. |
| `SM_EXECUTOR_SIMULATE` | Simulates executors when set to `1`. |
| `REDIS_DISABLED` | Worker entry may skip Redis in special modes—see worker entry for behavior. |

### Agent

| Variable | Notes |
|----------|--------|
| `SM_REALTIME_URL` | WebSocket URL including path `/realtime` (or your routed path). |
| `SM_AGENT_ID` | Agent identity presented on the wire. |

## Queue names (BullMQ)

Logical names are defined in `@sm/contracts` (`QUEUE_NAMES`):

| Key | Queue name string |
|-----|-------------------|
| `remediation` | `remediation` |
| `github` | `github` |
| `agentCommands` | `agent-commands` |
| `logIngestion` | `log-ingestion` |

Workers and producers must use the **same** strings so jobs land in the expected BullMQ queues on Redis.

## Correlation header

Use **`x-correlation-id`** (constant `CORRELATION_HEADER` in contracts) on requests that fan out through the API, workers, or agents so logs and traces can be joined end to end. Propagate the same value across retries.

## Endpoint catalog

For method-by-method coverage, see [API reference]({% link reference/api.md %}).
