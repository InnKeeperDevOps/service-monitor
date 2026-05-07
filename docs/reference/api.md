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

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/services` | Bearer | List monitored services for the tenant. |
| POST | `/api/v1/services` | Bearer | Create a monitored service (**201**). |

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
| POST | `/api/v1/agents/enrollment-tokens` | Bearer | Create enrollment token (optional `ttlSeconds`). |

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
