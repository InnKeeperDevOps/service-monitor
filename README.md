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

## Option 2: Run each app locally (multiple terminals)

Use one terminal per long-running process.

### 1) Start dependencies (Postgres + Redis)

```bash
docker compose -f deploy/docker/compose.yml up -d postgres redis
```

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
- In production mode, the Go agent requires enrollment token or saved credentials.
