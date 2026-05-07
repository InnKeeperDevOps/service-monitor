---
title: PostgreSQL failure
parent: Runbooks
nav_order: 2
---

# PostgreSQL failure

PostgreSQL is the **system of record** for tenants, RBAC, incidents, agents, services, and audit-related state.

## Symptoms

- HTTP **5xx** on CRUD and authenticated routes; health endpoints may report DB unhealthy.
- Worker errors on **transactions**, **connection pool** exhaustion, or migration/version mismatch.
- Replication lag or failover events (managed Postgres), or **disk full** / **corruption** alerts.

## Impact

- **Critical**: Control plane and workers cannot persist or read tenant data; new incidents and policy checks may fail.
- **Severe during migration**: schema drift blocks startup until migrations succeed.

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
