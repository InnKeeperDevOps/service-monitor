---
name: kaiad-local-agent-enrollment
description: >-
  Use when bringing up local Kaiad (Docker), signing into the admin UI, issuing an
  agent enrollment token, and running the Go agent against localhost—especially when
  enrollment fails, dev-token API calls fail with ENROLLMENT_STORE_UNAVAILABLE or FK
  errors, or the agent cannot reach realtime / Docker.
---

# Kaiad local stack + agent enrollment

End-to-end flow: **control plane up → authenticated session → enrollment token → agent binary**.

## Preconditions

- Repo root: monorepo with `deploy/docker/compose.unified.yml` (single-container Kaiad + Postgres + Redis).
- Docker daemon reachable; if `docker ps` fails with **permission denied** on the socket, use **`sudo`** for Docker commands or fix group membership (`docker` group + re-login).
- **Go toolchain** on `PATH` to build `apps/agent` (e.g. `/usr/local/go/bin`).

## 1) Start Kaiad (unified Compose)

From the repository root:

```bash
sudo docker compose -f deploy/docker/compose.unified.yml up -d --build
```

Wait until the API is ready:

```bash
curl -sf http://127.0.0.1:3001/ready
```

Expected: JSON including `"status":"ready"` (or HTTP 200 ready handler).

**URLs:** Web UI and API on **`http://127.0.0.1:3001/`** (unified image serves the SPA from the API process).

**Do not** run `docker compose down -v` unless wiping state—the `kaiad-data` volume holds wizard config and DB persistence.

## 2) Sign in (admin UI)

1. Open `http://127.0.0.1:3001/` (or `#login`).
2. If **`/api/v1/setup/status`** returns `setupRequired: true`, complete the **setup wizard** first (DB, Redis, admin account).
3. Sign in with an existing local account (email + password).

**Credentials:** Prefer credentials the operator already has. **Do not** reset or overwrite database passwords unless the user explicitly asks—security-sensitive.

**Optional API-only auth:** `POST /api/v1/auth/login` with `{"email":"...","password":"..."}` returns a **session token** (64-char hex) for `Authorization: Bearer <token>` on subsequent API calls.

### `dev-token` and `SM_ALLOW_DEV_TOKEN`

- In **`NODE_ENV=production`**, the API accepts `Authorization: Bearer dev-token` only if **`SM_ALLOW_DEV_TOKEN=1`** is set on the Kaiad process.
- **`dev-token` maps to a fixed dev tenant/session** (`u-1` / `t-1` in code paths). It is **not** a substitute for a real user when the database has different tenant IDs.
- **Do not** use `dev-token` for **`POST /api/v1/agents/enrollment-tokens`** against a real Postgres-backed deployment: inserts target tenant `t-1` and can fail with **`ENROLLMENT_STORE_UNAVAILABLE`** or **foreign key** errors on `agent_enrollment_tokens_tenant_id_fkey`.
- To enable `dev-token` without editing Compose (discouraged as default), recreate or run the Kaiad container with `-e SM_ALLOW_DEV_TOKEN=1` and the same `/data` volume—see repo rule **`docker-compose-change-gate`**: avoid editing `compose.unified.yml` unless the user approved a deploy change.

## 3) Create an enrollment token

**Preferred (UI):** **Settings → Enrollment tokens → Generate token** (preset TTL / expiry). Copy the plaintext token once; it may be shown only once.

**API (must use a real session):**

```bash
TOKEN="$(curl -s -X POST http://127.0.0.1:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"YOUR_EMAIL","password":"YOUR_PASSWORD"}' \
  | jq -r '.token')"

curl -s -X POST http://127.0.0.1:3001/api/v1/agents/enrollment-tokens \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"ttlSeconds":86400}'
```

Response includes **`token`** (plaintext) and metadata; use **`token`** for the agent.

## 4) Build the agent

```bash
export PATH="/usr/local/go/bin:${PATH}"
cd apps/agent
go build -o /tmp/kaiad-agent ./cmd/agent
```

## 5) Run the agent against local realtime

Minimal environment:

| Variable | Purpose |
|----------|---------|
| `SM_REALTIME_URL` | WebSocket base, e.g. `ws://127.0.0.1:3001/realtime` |
| `SM_ENROLLMENT_TOKEN` | Plaintext token from step 3 |
| `NODE_ENV` | Use `development` for local iteration if you need relaxed defaults; **`production` requires token or persisted credentials** per `apps/agent` |

Example:

```bash
export PATH="/usr/local/go/bin:${PATH}"
SM_REALTIME_URL=ws://127.0.0.1:3001/realtime \
SM_ENROLLMENT_TOKEN='<paste-token>' \
NODE_ENV=development \
/tmp/kaiad-agent
```

### Docker socket on the host

If logs show **`dial unix /var/run/docker.sock: connect: permission denied`**, either:

- run the agent with **`sudo`** (preserve env: `sudo env SM_REALTIME_URL=... SM_ENROLLMENT_TOKEN=... /tmp/kaiad-agent`), or  
- add the user to the **`docker`** group and re-login.

### Success signals in logs

- **`kaiad hello:`** line with **`configReady`** and runtime backend (e.g. `docker`).
- No fatal exit after connect.

### After enrollment

Tokens may be **single-use** or rotated by policy; if reconnect fails with invalid token, **issue a new token** in Settings.

## 6) Quick verification (optional)

With a session token from login:

```bash
curl -s http://127.0.0.1:3001/api/v1/agents \
  -H "Authorization: Bearer ${TOKEN}"
```

Lists registered agents for the tenant (connection state updates when the agent is running).

## References in-repo

- Agent env and production enrollment: `apps/agent/README.md`, `docs/agent/install.md`
- Architecture: `apps/agent/ARCHITECTURE.md`
- API: `docs/reference/api.md` (enrollment routes)

## Anti-patterns

- Using **`dev-token`** to create enrollment tokens against a real DB without understanding tenant mismatch.
- Editing **`deploy/docker/compose.unified.yml`** for a one-off env var without user approval (use documented overrides or runtime env instead).
- Assuming **`localhost` from inside another container** resolves to the host; from a **containerized** agent, use **`host.docker.internal`** or the Docker bridge gateway IP and published port.
