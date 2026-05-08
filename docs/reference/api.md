---
title: API reference
parent: Reference
nav_order: 1
---

# API reference

Base URL is your deployed API origin (e.g. `https://api.example.com`). Versioned REST routes live under **`/api/v1`**. Authenticated routes expect:

```http
Authorization: Bearer <token>
```

unless noted otherwise. Error bodies follow the shared **`apiError`** shape (`code`, `message`, optional `correlationId`).

## Health and readiness

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Liveness: process up and uptime. |
| GET | `/ready` | No | Readiness: returns **503** if Postgres/Redis TCP checks fail when those dependencies are configured. |

## Authentication and session

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/auth/login` | No | Body: `email`, `password`. Returns `token` and `user` session payload. |
| GET | `/api/v1/me` | Bearer | Current user and tenant membership. |

In **non-production**, a development bearer shortcut may exist—do not rely on it outside local dev.

## Tenant settings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/settings` | Bearer | Returns tenant settings or **404** if none stored yet. |
| POST | `/api/v1/settings` | Bearer | Upsert tenant settings; body must match session **tenantId** (cross-tenant writes denied). |

## Monitored services

A service can be bound to **zero or more agents**. The response shape carries
`agents: [{ agentId }, …]`. Create/update accept `agentIds: string[]` to set
the binding atomically with the service write. Per-binding endpoints below
let you bind/unbind without touching the service row.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/services` | Bearer | List monitored services for the tenant. Each service includes its bound agents. |
| POST | `/api/v1/services` | Bearer | Create a monitored service (**201**). Optional `agentIds` initial bindings. |
| PATCH | `/api/v1/services/:id` | Bearer | Update fields. When `agentIds` is provided, replaces the full set of bindings. Pass `[]` to detach all. |
| DELETE | `/api/v1/services/:id` | Bearer | Delete a service; its bindings are garbage-collected. |

### Per-binding endpoints

These work without rewriting the whole service. Useful from the Agents page
where you bind one service at a time. See [Agent ↔ service binding]({% link agent/binding-services.md %})
for the full model.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/agents/:agentId/services` | Bearer | List services currently bound to one agent. |
| POST | `/api/v1/agents/:agentId/services/:serviceId` | Bearer | Bind a service to an agent. Idempotent: response `bound=false` on repeat. |
| DELETE | `/api/v1/agents/:agentId/services/:serviceId` | Bearer | Remove a binding (404 if not bound). |

## Incidents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/incidents` | Bearer | List incidents for the tenant. |
| GET | `/api/v1/incidents/:id` | Bearer | Get one incident by id; **404** if missing or out of scope. |
| PATCH | `/api/v1/incidents/:id/status` | Bearer | Update incident **status** (validated body); **404** if not found. |

> **Note:** Status updates use the **`…/status`** sub-resource, not `PATCH` on the collection.

## Agents and enrollment

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/agents` | Bearer | List agents registered for the tenant. |
| GET | `/api/v1/agents/:id` | Bearer | Fetch one agent including live WebSocket presence. |
| PATCH | `/api/v1/agents/:id` | Bearer (admin) | Update agent metadata (`name`, `allowedCapabilities`). |
| DELETE | `/api/v1/agents/:id` | Bearer (admin) | Remove an agent registration; detaches it from any services and closes its realtime session. |
| GET | `/api/v1/agents/enrollment-tokens` | Bearer | List active enrollment tokens. |
| POST | `/api/v1/agents/enrollment-tokens` | Bearer **or** API credential with `enrollment-tokens.create` | Create enrollment token (`ttlSeconds` required). |
| POST | `/api/v1/agents/enrollment-tokens/:tokenId/deactivate` | Bearer | Mark an active token as revoked; agents using it are rejected on next connect. |
| DELETE | `/api/v1/agents/enrollment-tokens/:tokenId` | Bearer | Delete an inactive (revoked or expired) token row. Active tokens must be deactivated first. |

The enrollment endpoint accepts either a user session or an
[API credential]({% link admin/api-credentials.md %}) carrying the
`enrollment-tokens.create` scope. The latter is how the
[Kaiad agent operator]({% link agent/kubernetes.md %}) mints tokens
on a cluster's behalf.

## Admin / API credentials

Long-lived bearer tokens for machine integrations. Owner or admin
session is required for all three endpoints — API credentials cannot
mint or revoke other API credentials. See the dedicated
[API Credentials]({% link admin/api-credentials.md %}) page for scope
documentation, rotation guidance, and the privilege-escalation gate.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/admin/api-credentials` | Bearer (owner/admin) | Mint a credential. Body: `name`, `scopes[]`. Returns metadata + the plaintext **`token`** (shown once). |
| GET | `/api/v1/admin/api-credentials` | Bearer (owner/admin) | List credentials for the tenant. Plaintext token is **never** returned. |
| DELETE | `/api/v1/admin/api-credentials/:id` | Bearer (owner/admin) | Revoke (sets `revoked_at`; row is preserved for audit). |

Token format: `kop_` + 64 hex chars. Stored as a SHA-256 hash; recovery
of a lost plaintext is impossible — revoke and re-mint instead.

## Error groups

Deduplicated buckets of error-level log frames the agent has shipped.
See [Error grouping & auto-fix]({% link agent/error-grouping.md %}) for
the full lifecycle.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/error-groups` | Bearer | All error groups for the tenant. |
| GET | `/api/v1/agents/:agentId/error-groups` | Bearer | Groups originating from one agent. |
| GET | `/api/v1/services/:id/error-groups` | Bearer | Groups originating from one service. |

Status flips (`open` → `fixing` → `fixed` / `paused` / `missing_auth`)
are driven by the auto-fix dispatcher and broadcast to the tenant's
panel sessions as `error_group_updated` UI telemetry events on the
realtime channel. There is no public REST endpoint to set status
manually today — the panel handles it. Programmatic control is a
known gap.

## GitHub

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/github/installations` | Bearer | List GitHub installations recorded for the tenant. |
| POST | `/api/v1/github/installations` | Bearer | Upsert installation metadata; tenant scope enforced. |
| POST | `/api/v1/github/policy/check` | Bearer | Evaluate automation policy for a proposed action; **403** if policy denies. |

## Webhooks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/webhooks/github` | **Signature** | GitHub webhooks: validates **`x-hub-signature-256`** with `GITHUB_WEBHOOK_SECRET`; **401** if invalid. Enqueues processing jobs. |

## Realtime (agents)

| Protocol | Path | Auth | Description |
|----------|------|------|-------------|
| WebSocket | `/realtime` | **Session on wire** | Agents connect over WS/WSS; first valid **`heartbeat`** registers the agent. Messages include `log_event` ingestion and acknowledgements. |

Treat the WebSocket as a **long-lived channel**, not a REST substitute—pair with enrollment tokens and tenant policies for production.

## Related

- [Reference index]({% link reference/index.md %}) — OpenAPI path, queues, headers.
- [GitHub App setup]({% link getting-started/github-app.md %}) — webhook headers and secrets.
