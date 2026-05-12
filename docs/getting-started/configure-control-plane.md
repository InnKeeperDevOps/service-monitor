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
| `PORT` | API | HTTP listen port (default **3001** in code; **8091** in prod compose, **8092** in dev compose). |
| `KAIAD_DATA_DIR` | API | Root for persistent files written by the API process — `/data` in compose. Sub-paths include `registry-auth/` (JWT signing keys), `builds/` (artifact storage), and the registry-auth keypair if not explicitly overridden. |
| `KAIAD_ENCRYPTION_KEY` | API, worker | AES-256-GCM key used to encrypt stored secrets (SSH keys, …). Either 64 hex chars (32 raw bytes) or any string (sha256-hashed). Required when `NODE_ENV=production`; dev falls back to a fixed key. Must match across all processes that read the encrypted rows. |
| `SM_EMBED_WORKER` | API | When `1`, the API process also runs the build worker and BullMQ consumers in-process. Default for both compose stacks — one container does everything (API + worker + native registry + web bundle). |
| `GITHUB_WEBHOOK_SECRET` | API | Shared secret for **HMAC-SHA256** verification of `POST /webhooks/github` (`x-hub-signature-256`). Must match the secret configured in the GitHub App’s webhook settings. |
| `NODE_ENV` | API, worker | `production` disables dev-only shortcuts (e.g. seeded dev user, `admin:dev-token` Basic-auth shortcut on `/registry/token`); use `development` for local iteration. |
| `WORKER_HEALTH_PORT` | Worker | HTTP port for the worker **health** endpoint when run standalone (default derived in worker entry; standalone compose sets **9090**). Unused with `SM_EMBED_WORKER=1`. |
| `WORKER_HEALTH_HOST` | Worker | Bind address (default `0.0.0.0`). |

Readiness (`GET /ready`) uses **TCP probes** to Postgres and Redis when `POSTGRES_*` and `REDIS_*` host/port pairs are configured—see `readyChecks` in the API—so load balancers only route traffic when dependencies are reachable.

## Build pipeline

When `SM_EMBED_WORKER=1` (the compose default), the API process also runs the build pipeline that turns service repos into pushed images. Configure it with:

| Variable | Purpose |
|----------|---------|
| `KAIAD_BUILDS_HOST_DIR` | Absolute **host** path to the bind-mounted builds workspace. The build worker shells out to `docker build`/`docker run` against the host daemon; the spawned containers need the workspace at a path the host can see. Compose: `${PWD}/data/kaiad-builds`. |
| `KAIAD_REGISTRY_HOST` | External hostname recorded in image refs (e.g. `panel.kaiad.dev`). Agents pull from this. Used in DB rows and `{kaiad_registry_host}` template interpolation. |
| `KAIAD_REGISTRY_INTERNAL` | Loopback hostname the build worker uses for in-container crane pushes. Compose: `127.0.0.1:<PORT>`. Falls back to `KAIAD_REGISTRY_HOST` if unset. |
| `KAIAD_REGISTRY_REALM` | **Absolute URL** of `/registry/token` advertised in WWW-Authenticate challenges. Must be absolute — crane's Go HTTP client rejects relative paths with `unsupported protocol scheme`. Compose: `http://127.0.0.1:<PORT>/registry/token`. |
| `KAIAD_REGISTRY_INSECURE` | When `0`, the registry endpoint is HTTPS. Default `1` (plain HTTP for internal pushes). |

The build pipeline also needs `/var/run/docker.sock` bind-mounted into the container so the worker can spawn build containers via the host docker daemon. Both compose stacks wire this — see `env/dev/docker-compose.yml` and `env/prod/docker-compose.yml`.

For the build pipeline schema (`kaiad.yaml`) and variable interpolation, see [`kaiad.yaml` reference]({% link reference/pipeline.md %}) and [Pipeline variables]({% link reference/pipeline-variables.md %}).

## Built-in OCI registry

The same process serves an OCI Distribution v2 registry at `/v2/*`. Image blobs live in Postgres `pg_largeobject`; manifests inline as BYTEA. Auth uses JWTs minted by `/registry/token`.

| Variable | Purpose |
|----------|---------|
| `REGISTRY_AUTH_KEY_PATH` | Private signing key (PEM). Default `${KAIAD_DATA_DIR}/registry-auth/key.pem`. Generated on first boot if missing. |
| `REGISTRY_AUTH_CERT_PATH` | Public cert (PEM). Default `${KAIAD_DATA_DIR}/registry-auth/cert.pem`. The libtrust `kid` is derived from its SPKI. |
| `REGISTRY_AUTH_ISSUER` | JWT `iss` claim. Default `kaiad`. |
| `REGISTRY_AUTH_SERVICE` | JWT `aud` claim. Default `kaiad-registry`. |
| `REGISTRY_AUTH_TOKEN_TTL_SECONDS` | Token lifetime. Default `3600` (bumped from the 5-min docker/distribution default so multi-GB layer pushes don't 401 mid-upload). |

Persist `KAIAD_DATA_DIR/registry-auth/` (a bind mount in compose) so the keypair survives restarts — otherwise every restart rotates the keypair, invalidating any tokens issued before the restart. For everything else about the registry (endpoints, GC, pulling from agents), see [Built-in OCI registry]({% link reference/registry.md %}).

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

Two canonical stacks live in the repo:

- **`env/dev/docker-compose.yml`** — the **unified-container** dev stack. Builds `Dockerfile.unified`, runs API + worker + native registry + web bundle in one `kaiad` container alongside Postgres and Redis. Mounts `./data/kaiad`, `./data/registry-auth`, `./data/kaiad-builds`, and `/var/run/docker.sock`. Listens on **8092**. UID 1000.
- **`env/prod/docker-compose.yml`** — same unified shape for production. Listens on **8091**, runs as root, no perms-init sidecar. Secrets (`KAIAD_ENCRYPTION_KEY`) read from `env/prod/.env` (gitignored).

The older **`deploy/docker/compose.yml`** runs API, worker, and web as separate containers (no embedded worker, no native registry) and is kept as a reference for layouts that prefer process isolation over the unified container. New deployments should follow the unified pattern.

Use these files as **references** for port mappings, volume mounts, and dependency wiring—not as one-size-fits-all production charts.

## Related

- [GitHub App setup]({% link getting-started/github-app.md %}) — webhook secret and `GITHUB_WEBHOOK_SECRET`.
- [Install Agent]({% link agent/install.md %}) — point agents at `wss://…/realtime` (or `ws://` in dev).
- [Onboarding a service]({% link getting-started/onboarding-services.md %}) — once the plane is up, add a service.
- [`kaiad.yaml` reference]({% link reference/pipeline.md %}) — pipeline schema.
- [Built-in OCI registry]({% link reference/registry.md %}) — pull/push, auth, garbage collection.
- [Reference — environment tables]({% link reference/index.md %}) — extended list including queues and headers.
