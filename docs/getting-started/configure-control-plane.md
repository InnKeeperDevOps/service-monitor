---
title: Configure the control plane
parent: Getting started
nav_order: 1
---

# Configure the control plane

This page covers **environment variables**, **bootstrap identity**, and **how to run** the API and worker processes. For a full stack layout (web, API, worker, Postgres, Redis), use the repository’s Docker Compose reference.

## Environment variables (core)

| Variable | Component | Purpose |
|----------|-----------|---------|
| `DATABASE_URL` | API | When set and Postgres is available, tenant settings and related data use **Postgres**. If unset or driver missing, the API may fall back to an **in-memory** store (suitable for dev only). |
| `REDIS_URL` | API, worker | Preferred single URL for Redis (also used by BullMQ). Alternatively `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` are supported by the queue layer. |
| `PORT` | API | HTTP listen port (default **3001** in code and Compose). |
| `GITHUB_WEBHOOK_SECRET` | API | Shared secret for **HMAC-SHA256** verification of `POST /webhooks/github` (`x-hub-signature-256`). Must match the secret configured in the GitHub App’s webhook settings. |
| `NODE_ENV` | API, worker | `production` disables dev-only shortcuts (e.g. seeded dev user); use `development` for local iteration. |
| `WORKER_HEALTH_PORT` | Worker | HTTP port for the worker **health** endpoint (default derived in worker entry; Compose sets **9090**). |
| `WORKER_HEALTH_HOST` | Worker | Bind address (default `0.0.0.0`). |

Readiness (`GET /ready`) uses **TCP probes** to Postgres and Redis when `POSTGRES_*` and `REDIS_*` host/port pairs are configured—see `readyChecks` in the API—so load balancers only route traffic when dependencies are reachable.

## First admin user

Behavior depends on **auth backend** and **environment**:

- In **non-production**, the API may **seed a development user** (e.g. `admin@example.com` with a known password) so you can log in immediately—treat this as **non-secret** and **never** rely on it in production.
- For **production**, plan explicit provisioning: create users and tenant memberships through your chosen auth path (or automation) as soon as a real user store is wired. Until then, document who owns bootstrap credentials and rotate them after first login.

Use `POST /api/v1/auth/login` to obtain a **Bearer** token, then call `GET /api/v1/me` to confirm tenant scope.

## Running the API

From the monorepo (after install):

```bash
pnpm --filter @sm/api build
pnpm --filter @sm/api start
```

The process listens on `PORT` (default `3001`). Verify:

- `GET /health` — process up.
- `GET /ready` — dependencies reachable (or 503 with a reason code).

## Running the worker

Workers consume **BullMQ** queues on Redis. Start the worker service with Redis reachable using the same connection settings as the API:

```bash
pnpm --filter @sm/worker build
pnpm --filter @sm/worker start
```

Confirm the worker **health** HTTP endpoint (see `WORKER_HEALTH_PORT`) responds OK for orchestrators.

## Docker Compose reference

The canonical multi-service layout is in **`deploy/docker/compose.yml`**: **web** (preview), **api**, **worker**, **postgres**, **redis**, with healthchecks on web, API, and worker. Mounts assume a dev-style workspace bind; adjust images and commands for your own registry and CI-built artifacts.

Use that file as a **reference** for port mappings (`3001` API, `9090` worker health, `5432` / `6379` data stores) and dependency wiring—not as a one-size-fits-all production chart.

## Related

- [GitHub App setup]({% link getting-started/github-app.md %}) — webhook secret and `GITHUB_WEBHOOK_SECRET`.
- [Install Agent]({% link agent/install.md %}) — point agents at `wss://…/realtime` (or `ws://` in dev).
- [Reference — environment tables]({% link reference/index.md %}) — extended list including queues and headers.
