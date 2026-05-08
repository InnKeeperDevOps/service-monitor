---
name: start-kaiad-agent
description: >-
  Start the Kaiad Go agent against the local dev or prod control plane. Use when
  the user asks to start, run, restart, or connect the agent; to enroll a new
  agent; or to verify the agent is reporting to the panel.
---

# Start Kaiad Agent

Sibling to `start-dev-environment` / `start-prod-environment`. This skill
starts the **Go agent** (`apps/agent`) and connects it to the realtime
WebSocket on the running control plane.

## Rules in force (from `.cursor/rules/`)

- `kaiad-users.mdc` — **run the agent as `claud`** (`sudo su claud`). Panel
  commands are `kaiad`; dev app / Postgres / Redis are `firestar`.
- `testing-and-ports.mdc` + `dev-environment-commands.mdc` — dev app on
  **8092**, prod app on **8091**. Dev Postgres/Redis **5001/6001**, prod
  **5002/6002**. Separate DBs per environment.
- `no-api-testing.mdc` + `ui-verification-gate.mdc` — issue enrollment tokens
  via the **dev panel UI** (`http://panel.dev.kaiad.dev`), not `curl`.
- `docker-compose-touch-gate.mdc` / `host-config-change-gate.mdc` — do **not**
  edit `deploy/docker/compose*.yml` or Nginx Proxy Manager to toggle agent
  settings without explicit user approval. Use runtime env vars.
- `no-destructive-git.mdc` — no `git clean`, no blind `git reset --hard` when
  tidying the agent working tree.
- `error-handling-must-throw-and-log.mdc` — if a step fails (build, connect,
  enrollment), report the error with context; do not silently continue.

## Preconditions

1. Control plane is up — start it with `start-dev-environment` or
   `start-prod-environment` first.
2. Go toolchain on `PATH`:
   ```bash
   export PATH="/usr/local/go/bin:${PATH}"
   ```
3. Docker socket readable by the agent user — if `docker ps` fails with
   permission denied, run the agent with `sudo env ...` or add the user to
   the `docker` group.

## 1. Switch to the agent user

```bash
sudo su claud
```

All subsequent `go build` / agent run commands execute as `claud`.

## 2. Build the agent

```bash
export PATH="/usr/local/go/bin:${PATH}"
cd /home/firestar/kaiad/apps/agent
go build -o /tmp/kaiad-agent ./cmd/agent
```

## 3. Issue an enrollment token via the panel UI

Per `no-api-testing.mdc` — do **not** `curl` the enrollment endpoint.

1. Open **`http://panel.dev.kaiad.dev`** (or `http://panel.kaiad.dev` for
   prod) using the `cursor-ide-browser` tool, or ask the user to open it.
2. Sign in (dev credentials: `test@example.com` / `mypassword123`).
3. **Settings → Enrollment tokens → Generate token**. Copy the plaintext
   token immediately — it is shown once.

If the UI route is unavailable, fall back to `kaiad-local-agent-enrollment`
skill's API path **only with user approval**, using a real session token
(never `dev-token` against real Postgres).

## 4. Run the agent

### Dev

```bash
SM_REALTIME_URL=wss://panel.dev.kaiad.dev/realtime \
SM_ENROLLMENT_TOKEN='<paste-token>' \
NODE_ENV=development \
/tmp/kaiad-agent
```

If hitting the unified dev container directly on the host:
`SM_REALTIME_URL=ws://127.0.0.1:8092/realtime`.

### Prod

```bash
SM_REALTIME_URL=wss://panel.kaiad.dev/realtime \
SM_ENROLLMENT_TOKEN='<paste-token>' \
NODE_ENV=production \
/tmp/kaiad-agent
```

`NODE_ENV=production` requires `SM_ENROLLMENT_TOKEN` (fails closed without
it). Set `SM_AGENT_DEBUG=1` for verbose `[agent:transport]` logs when
diagnosing connection issues.

### Docker socket permission errors

`dial unix /var/run/docker.sock: connect: permission denied` →

```bash
sudo env PATH="$PATH" \
  SM_REALTIME_URL=... \
  SM_ENROLLMENT_TOKEN='<token>' \
  /tmp/kaiad-agent
```

## 5. Verify in the panel

Per `ui-verification-gate.mdc` — verify the agent is connected through the
UI, not the API:

1. Navigate to **`http://panel.dev.kaiad.dev`** → **Agents**.
2. Confirm the new agent appears with an online/connected state and the
   expected `agentId`.
3. Check the agent process logs for the `kaiad hello:` line with
   `configReady` and the runtime backend (`docker`).

If the agent does not appear, do **not** declare success. Capture the
`[agent:transport]` lines with `SM_AGENT_DEBUG=1` and diagnose — common
causes: wrong `SM_REALTIME_URL`, expired/single-use token, tenant mismatch,
Docker socket permission.

## Persistent operation (optional)

`apps/agent/packaging/systemd/service-monitor-agent.service` is the
reference systemd unit. Override `Environment=SM_REALTIME_URL=...` and add
`SM_ENROLLMENT_TOKEN=...` via a drop-in before `systemctl enable --now`.
**Ask the user** before installing system-level units
(`host-config-change-gate.mdc`).

## Anti-patterns

- Testing enrollment with `curl` / API calls instead of the panel UI.
- Running the agent as `firestar` or `root` in normal dev flow — use `claud`.
- Editing `deploy/docker/compose.unified.yml` to inject `SM_ALLOW_DEV_TOKEN`
  or other agent env without explicit approval.
- Using `dev-token` as the enrollment token against a real Postgres-backed
  deployment (tenant `t-1` mismatch → `ENROLLMENT_STORE_UNAVAILABLE` or FK
  errors).
- Declaring the agent "started" based only on local logs — confirm in the
  panel UI.
