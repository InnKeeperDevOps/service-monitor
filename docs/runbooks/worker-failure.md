---
title: Worker failure
parent: Runbooks
nav_order: 4
---

# Worker failure

**Workers** consume BullMQ jobs: ingest/detection, GitHub API calls, notifications, and **AgentCommand** dispatch via the realtime tier.

## Symptoms

- Queue **depth** grows; jobs **retry** or move to **failed** in BullMQ.
- No GitHub mutations (PR, merge, dispatch) completing; webhooks enqueue but nothing finishes.
- Worker pods/processes **crash looping**, **OOM**, or **idle** while Redis is healthy.

## Impact

- **High**: Remediation and automation stop; incidents may be detected but not resolved.
- **Partial**: Only some queues or tenants affected—check **concurrency**, **rate limits**, and **per-tenant** failures.

## Immediate actions

1. Correlate with [Redis failure]({% link runbooks/redis-failure.md %}) and [PostgreSQL failure]({% link runbooks/postgres-failure.md %}); fix upstream first if broken.
2. Inspect worker logs for **GitHub** `401/403/429`, **installation token** issues, or **policy** denials.
3. Scale worker **replicas** or **concurrency** if CPU-bound legitimately; avoid masking leaks.
4. For poison messages: **quarantine** job payload per incident process; **do not** disable retries globally without review.
5. If dispatch to agents fails: see [Realtime gateway]({% link runbooks/realtime-gateway.md %}).

## Validation checks

- BullMQ shows **active** consumers; failed rate returns to baseline.
- End-to-end test: enqueue job → **GitHub** or **agent** side effect completes.
- **Webhook → job → outcome** path verified in staging or with a safe production operation.
- Resource usage stable (memory/FDs); no repeated crash signature.
