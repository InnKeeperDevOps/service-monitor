# Kaiad

Monorepo for the Kaiad control plane and agent.

## Apps in this repo

- `apps/web` - React/Vite admin UI (default preview port `4173`)
- `apps/api` - Fastify API and realtime endpoint (default port `3001`)
- `apps/worker` - BullMQ background workers + health server (default health port `9090`)
- `apps/agent` - Go runtime agent that connects outbound to realtime

## Prerequisites

- Node.js 22+
- pnpm (`corepack enable`)
- Go 1.22+ (for `apps/agent`)
- Docker (optional, for Compose-based local stack)

## Install dependencies

```bash
corepack enable
pnpm install
```

## Option 1: Run the control plane with Docker Compose

This starts `web`, `api`, `worker`, `postgres`, and `redis` together.

```bash
docker compose -f deploy/docker/compose.yml up --build
```

Endpoints after startup:

- Web UI: `http://localhost:4173`
- API health: `http://localhost:3001/health`
- API readiness: `http://localhost:3001/ready`
- Worker health: `http://localhost:9090/health`

## Quick Start (Single Container)

Kaiad can run as a single container serving the web UI, API, and optional embedded worker on one port:

```bash
docker compose -f deploy/docker/compose.unified.yml up --build
```

Open http://localhost:3001 to access the setup wizard. You'll configure:

- PostgreSQL and Redis connections
- Admin account
- GitHub App credentials (optional)
- OAuth providers (optional)

### Configuration

Kaiad stores its config in `KAIAD_DATA_DIR` (default: `/data` in Docker, `./data` locally).

In Docker Compose, setup persistence depends on the `kaiad-data` volume. Do not run `docker compose down -v` unless you intentionally want to wipe setup state. If you deploy from different directories or with varying project names, set `KAIAD_DATA_VOLUME_NAME` to a stable value so the same volume is reused.

**Environment variable precedence**: Environment variables always override values from `kaiad.config.json`. This means Kubernetes secrets, Docker env, or shell exports take priority over the config file.

**Key environment variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP listen port | `3001` |
| `KAIAD_DATA_DIR` | Data/config directory | `./data` |
| `DATABASE_URL` | PostgreSQL connection string | Set via wizard |
| `REDIS_URL` | Redis connection string | Set via wizard |
| `SM_EMBED_WORKER` | Run BullMQ workers in API process | `0` |
| `SM_ALLOW_DEV_TOKEN` | Allow `dev-token` auth in production | `0` |

**Pre-configured deployment** (skip wizard): Set `DATABASE_URL` and `REDIS_URL` as environment variables. The wizard is only shown when no `DATABASE_URL` is available.

### Kubernetes

For Kubernetes deployments:

- Mount `KAIAD_DATA_DIR` as a PersistentVolume or use environment variables exclusively
- Use Kubernetes Secrets for `DATABASE_URL`, `REDIS_URL`, `GITHUB_APP_PRIVATE_KEY`, etc.
- The config file (`kaiad.config.json`) is written with mode `0600` for security
- Set `SM_EMBED_WORKER=1` for single-pod deployments or run the worker separately for scale

## Option 2: Run each app locally (multiple terminals)

Use one terminal per long-running process.

### 1) Start dependencies (Postgres + Redis)

```bash
# Optional overrides (defaults: postgres/postgres/service_monitor)
# export POSTGRES_USER=myuser
# export POSTGRES_PASSWORD=mypassword
# export POSTGRES_DB=mydb
docker compose -f deploy/docker/compose.yml up -d postgres redis
```

`compose.yml` now mounts a persistent API data volume at `/data` and sets `KAIAD_DATA_DIR=/data`, so setup wizard values (like `databaseUrl`) are persisted across container restarts.

### 2) Run API (`apps/api`)

```bash
export NODE_ENV=development
export PORT=3001
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/service_monitor
export REDIS_URL=redis://localhost:6379
pnpm --filter @sm/api build
pnpm --filter @sm/api start
```

### 3) Run worker (`apps/worker`)

```bash
export NODE_ENV=development
export WORKER_HEALTH_PORT=9090
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/service_monitor
export REDIS_URL=redis://localhost:6379
pnpm --filter @sm/worker build
pnpm --filter @sm/worker start
```

### 4) Run web (`apps/web`)

For iterative frontend development:

```bash
pnpm --filter @sm/web dev
```

For production-like preview:

```bash
pnpm --filter @sm/web build
pnpm --filter @sm/web preview
```

### 5) Run agent (`apps/agent`)

In another terminal:

```bash
cd apps/agent
SM_REALTIME_URL=ws://localhost:3001/realtime \
SM_AGENT_ID=local-agent \
SM_ENROLLMENT_TOKEN=dev-token \
go run ./cmd/agent
```

## Useful repo commands

```bash
pnpm build
pnpm lint
pnpm test
pnpm typecheck
```

## Notes

- The API and worker need Redis for queues.
- The API uses Postgres when `DATABASE_URL` is set.
- In production mode, the Go agent requires `SM_ENROLLMENT_TOKEN` unless you opt into file-backed credentials with `SM_AGENT_PERSIST_CREDENTIALS=1`.
