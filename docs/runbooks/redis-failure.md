---
title: Redis failure
parent: Runbooks
nav_order: 1
---

# Redis failure

Redis backs **BullMQ** (job orchestration) and may support sessions, rate limits, or light cache in the API tier.

## Symptoms

- Jobs remain **queued** or **stalled**; remediation and GitHub-related work does not progress.
- API errors referencing Redis connection, timeouts, or `ECONNREFUSED` / `NOAUTH`.
- Sudden **memory** or **eviction** alerts; elevated latency on queue operations.

## Impact

- **High**: No durable queue progress—workflows, webhooks, and scheduled tasks back up.
- **Medium** (if Redis only used for optional cache/session): degraded auth or throttling behavior depending on deployment.

## Immediate actions

1. Confirm scope: **single node** vs cluster; note **ACL/password** and **TLS** requirements from your env config.
2. Check **process / managed service** health, **CPU**, **memory**, **persistence** (AOF/RDB) if applicable.
3. Verify **network path** from API and worker hosts to Redis (security groups, firewall, service name in K8s).
4. If memory pressure: inspect **maxmemory** policy; avoid unbounded keys; scale vertically or shard if sustained.
5. After recovery: **restart workers** if they wedged on connection loss (follow worker runbook if jobs still stuck).

## Validation checks

- `redis-cli -u … PING` (or provider console) returns `PONG`.
- BullMQ queues show **consumption** (depth decreasing); sample job completes end-to-end.
- API and worker logs show **stable** Redis connections over several minutes.
- Re-run a **known-good** enqueue path (e.g. test job or webhook replay in non-prod) if available.
