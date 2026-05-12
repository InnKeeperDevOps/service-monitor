---
title: PostgreSQL failure
parent: Runbooks
nav_order: 2
---

# PostgreSQL failure

PostgreSQL is the **system of record** for tenants, RBAC, incidents, agents, services, audit-related state, **and the built-in OCI registry** (image blobs in `pg_largeobject`, manifests inline as BYTEA — see [registry reference]({% link reference/registry.md %}#storage)).

## Symptoms

- HTTP **5xx** on CRUD and authenticated routes; health endpoints may report DB unhealthy.
- `/v2/*` returns **503 UNAVAILABLE** (`Registry storage not configured`); `docker pull` and `crane push` fail; build worker can't push new images.
- Agents fail to pull workload images with `ImagePullBackOff` / `unauthorized` — manifests can't be served.
- Worker errors on **transactions**, **connection pool** exhaustion, or migration/version mismatch.
- Replication lag or failover events (managed Postgres), or **disk full** / **corruption** alerts.

## Impact

- **Critical**: Control plane and workers cannot persist or read tenant data; new incidents and policy checks may fail.
- **Critical for builds + deploys**: the registry is unreachable, so newly-built images can't be pushed and previously-built images can't be pulled. Already-running workloads on agents are unaffected (kubelet/docker has the image locally); only new pulls fail.
- **Severe during migration**: schema drift blocks startup until migrations succeed. Registry-related migrations add the `registry_blobs`, `registry_manifests`, `registry_tags`, `registry_uploads` tables — failure here means the kaiad process won't start.
- **Disk pressure** specifically: blob storage in `pg_largeobject` can grow large fast. A few GB of layers is normal per service. Run [`pnpm --filter @sm/api registry:gc`]({% link reference/registry.md %}#garbage-collection) before treating "disk full" as a Postgres capacity problem.

## Immediate actions

1. Distinguish **availability** (instance down, network) vs **capacity** (connections, disk, CPU).
2. For **connection storms**: scale pool limits carefully; restart misbehaving clients; avoid thundering herd.
3. For **disk**: expand storage or purge bloat per ops policy; ensure autovacuum and monitoring.
4. For **failover** (HA): confirm DNS/endpoints updated; verify app **connection strings** and **read/write** roles.
5. **Do not** delete data in panic; restore from **backup/snapshot** only via approved restore procedure.

## Validation checks

- `psql` or admin SQL from an app host succeeds with the same creds as the API/worker.
- Migrations applied to expected version; API **readiness** passes.
- Spot-check **tenant-scoped** read/write in staging or a safe canary query.
- Worker can **complete** a job that touches Postgres (incident update, agent command).
