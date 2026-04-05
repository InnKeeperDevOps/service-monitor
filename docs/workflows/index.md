---
title: Workflows
nav_order: 8
has_children: true
---

# Workflows

**Workflows** are **directed graphs** of **nodes** and **edges** stored per tenant. Each graph describes what happens when a **trigger** fires: which branches run in parallel, where **joins** occur, and which **actions** execute with what inputs. The runtime executes graphs using a **DAG executor** that respects ordering and branch decisions.

## Mental model

- **Graph** — Nodes (steps) and edges (dependencies). Cycles are invalid; the engine works on a topological ordering.
- **Trigger nodes** — Entry points tied to platform events (build, crash, schedule, log pattern, etc.). See [Workflow MVP nodes]({% link workflows/mvp-nodes.md %}) for the v1 trigger catalog.
- **Action nodes** — Do work: shell/Docker/compose, notifications, webhooks, plan runners, templating, conditional routing.
- **Outputs** — Each node can write to a shared **execution context** (`outputs`, `env`, `triggerPayload`) for downstream nodes.

## DAG execution: waves, parallelism, joins

The executor computes **topological waves**: each wave is a set of nodes whose dependencies are satisfied. Within a wave, independent nodes may run **in parallel** (`Promise.all` in the reference implementation).

- **Topological waves** — Nodes with no unmet incoming edges run in the earliest possible wave; dependents run in later waves.
- **Parallel branches** — Multiple edges from one trigger or gateway fan out; those targets share a wave when their prerequisites align.
- **Joins** — A node with multiple incoming edges runs only when **all** predecessors have completed. If **all** incoming paths failed or were skipped, the node may be **skipped** (see `branchIf` behavior below).

**`branchIf` nodes** evaluate a condition and choose **one** outgoing edge; the engine **marks the non-taken subtree as skipped** so downstream work does not run—this is how conditional routing stays deterministic.

## Trigger types vs action types

| Category | Purpose |
|----------|---------|
| **Triggers** | Decide *when* a workflow instance starts and with what **payload** (e.g. build finished, error log matched). |
| **Actions** | Decide *what* to do after start—run commands, notify, open PRs, etc. |

Keep triggers **lean** (event selection + filtering) and actions **explicit** (side effects and retries). Policy gates (e.g. GitHub) apply at action boundaries, not inside trigger definitions.

## Authoring: API vs editor

- **API** — `GET/POST /api/v1/workflows` list and create workflow graphs with validated bodies (`createWorkflowGraph` schema from contracts). Use for GitOps, seeding, and automation.
- **Editor (SPA)** — Visual or form-based editing targets the same graph model; export/import should round-trip through the same schema for drift control.

Regardless of path, store **versioned** definitions if you need rollback— the platform’s MVP may treat graphs as latest-only until versioning is added.

## Validation rules (typical)

Concrete rules are enforced by **Zod** (or equivalent) schemas in `@sm/contracts` and engine prechecks:

- **Acyclic graph** — Edges must not introduce cycles.
- **Known node types** — Every `node.type` must map to a registered handler in the executor.
- **Referential integrity** — Edges reference existing node ids; orphan nodes may be rejected or ignored depending on schema.
- **Tenant scope** — All reads/writes are scoped to the authenticated tenant.

When validation fails, the API returns **400** with a structured error; fix the graph and resubmit.

## Related

- [Workflow MVP nodes]({% link workflows/mvp-nodes.md %}) — Trigger and action inventory for the MVP.
- [API reference]({% link reference/api.md %}) — Workflow endpoints.
- [Reference — queues]({% link reference/index.md %}) — BullMQ names for async workflow or remediation work.
