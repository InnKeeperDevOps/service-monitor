---
title: Install Agent
nav_order: 2
---

# Install Agent

The **Kaiad agent** is a small **Go** process that runs on infrastructure you control (bare metal, VM, or container host). It maintains an **outbound** WebSocket connection to the control plane **realtime** endpoint, receives **AgentCommand** messages, and can run shell steps, Docker operations, and plan executors (Cursor / Claude) against a workspace.

You do **not** open an inbound port from the internet for the SaaS path: the agent only **dials out**. See [Agent networking]({% link security/agent-networking.md %}) for firewall and TLS expectations.

## Prerequisites

- **Network**: Egress to your Kaiad hostname on **HTTPS/WSS** (typically **443**). The WebSocket URL usually ends with `/realtime` (see [Configure the control plane]({% link getting-started/configure-control-plane.md %})).
- **Production enrollment**: With `NODE_ENV=production`, the agent **exits** unless `SM_ENROLLMENT_TOKEN` is set **or** a credential file already exists from a previous successful enrollment.
- **Docker (optional but typical)**: For container inspection, Docker CLI ops, and log streaming, the host should expose the Docker API (default Unix socket `/var/run/docker.sock`). Override with `SM_DOCKER_SOCKET` if needed.

## Install the binary

### Release binaries (CI builds)

Official **static** binaries are attached to [GitHub Releases](https://github.com/InnKeeperDevOps/kaiad/releases) for each **annotated version tag** matching `v*` (for example `v1.2.3`). The [`go-release`](https://github.com/InnKeeperDevOps/kaiad/blob/main/.github/workflows/go-release.yml) workflow cross-compiles the agent with `CGO_ENABLED=0` and publishes artifacts plus **`checksums.txt`**.

Download the file that matches your OS and CPU, verify it against `checksums.txt`, make it executable (on Unix), and install it as `agent` (or keep the release name and point `ExecStart` at that path):

| Asset | Platform |
|-------|----------|
| `agent-agent_linux_amd64` | Linux x86_64 |
| `agent-agent_linux_arm64` | Linux ARM64 |
| `agent-agent_darwin_amd64` | macOS Intel |
| `agent-agent_darwin_arm64` | macOS Apple silicon |
| `agent-agent_windows_amd64.exe` | Windows x86_64 |

Example (Linux amd64, replace `vX.Y.Z` with a real tag):

```bash
curl -fsSL -O "https://github.com/InnKeeperDevOps/kaiad/releases/download/vX.Y.Z/agent-agent_linux_amd64" \
  -O "https://github.com/InnKeeperDevOps/kaiad/releases/download/vX.Y.Z/checksums.txt"
# Checksums are produced for paths under dist/; strip that prefix so sha256sum matches downloaded filenames.
sed 's| dist/| |' checksums.txt | sha256sum -c --ignore-missing
chmod +x agent-agent_linux_amd64
sudo install -m 0755 agent-agent_linux_amd64 /usr/local/bin/agent
```

On macOS, use `shasum -a 256` instead of `sha256sum` if the latter is not installed:  
`sed 's| dist/| |' checksums.txt | shasum -a 256 -c --ignore-missing`

### Build from source

From the monorepo root:

```bash
cd apps/agent
go build -o agent ./cmd/agent
```

Install to a stable path (the sample systemd unit uses `/usr/local/bin/agent`):

```bash
sudo install -m 0755 agent /usr/local/bin/agent
```

### Build the container image

The Dockerfile lives in `apps/agent/`. Build with that directory as context:

```bash
docker build -t kaiad-agent:latest apps/agent
```

The image entrypoint runs `/usr/local/bin/agent` with no default shell; pass configuration via `-e` / `--env-file`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SM_REALTIME_URL` | **Yes** (prod) | WebSocket URL for the realtime channel. **Production:** `wss://<your-host>/realtime`. **Local dev:** defaults to `ws://localhost:3001/realtime` if unset. |
| `SM_ENROLLMENT_TOKEN` | **Yes** in production if no saved credential | One-time or rotating enrollment secret from the control plane. After first successful connection, the agent can persist credentials and omit this on later starts. |
| `NODE_ENV` | Recommended | Set to `production` on real workloads so the agent fails closed without a token or saved credential. |
| `SM_AGENT_ID` | Optional | Logical agent id (default `agent-local`). After enrollment, saved credentials may override this. |
| `SM_CREDENTIAL_PATH` | Optional | Filesystem path for the JSON credential file. Default: `~/.service-monitor/agent-credential.json`. |
| `SM_DOCKER_SOCKET` | Optional | Path to the Docker API socket (default `/var/run/docker.sock`). |
| `SM_ENABLE_LOG_STREAMING` | Optional | Set to `0` to disable streaming logs from existing containers on startup. |
| `SM_AGENT_VERSION` | Optional | Reported agent version in heartbeats (defaults to `0.1.0` in code if unset). |

### Optional: plan executors and isolation

For `run_cursor_plan` / `run_claude_plan` and related behavior, the agent reads additional variables (timeouts, binary paths, optional container-isolated runners). See [`apps/agent/README.md`](https://github.com/InnKeeperDevOps/kaiad/blob/main/apps/agent/README.md) in the repository for `SM_EXECUTOR_*`, `SM_CURSOR_BIN`, and `SM_CLAUDE_BIN`.

## Enrollment and stored credentials

1. **Create an enrollment token** in the Kaiad UI (Settings) or via the API (`POST /api/v1/agents/enrollment-tokens`) with a valid tenant session.
2. Set `SM_ENROLLMENT_TOKEN` to that token and `SM_REALTIME_URL` to your control plane realtime URL.
3. Start the agent. On first successful connection, it writes **`SM_CREDENTIAL_PATH`** (or the default under `~/.service-monitor/`) with `0600` permissions and can reconnect using that file **without** putting the raw token in the environment again.

Rotate or revoke tokens at the control plane if a host is compromised; treat the credential file like a secret.

## Run with systemd

A reference unit file is in the repo at `apps/agent/packaging/systemd/service-monitor-agent.service`. Copy and adapt it:

```ini
[Service]
Environment=SM_REALTIME_URL=wss://your-kaiad.example.com/realtime
Environment=NODE_ENV=production
Environment=SM_ENROLLMENT_TOKEN=your-one-time-token
# Or use EnvironmentFile=/etc/kaiad/agent.env for secrets (not committed to git)
ExecStart=/usr/local/bin/agent
```

Prefer **`EnvironmentFile=`** for secrets instead of inline `Environment=` in shared templates. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now service-monitor-agent
sudo journalctl -u service-monitor-agent -f
```

## Run with Docker

Mount the Docker socket when you need Docker-backed commands and log streaming:

```bash
docker run -d --name kaiad-agent --restart=unless-stopped \
  -e NODE_ENV=production \
  -e SM_REALTIME_URL=wss://your-kaiad.example.com/realtime \
  -e SM_ENROLLMENT_TOKEN=your-token \
  -v /var/run/docker.sock:/var/run/docker.sock \
  kaiad-agent:latest
```

For a persistent credential file across restarts, mount a host directory and set `SM_CREDENTIAL_PATH=/data/agent-credential.json`.

## Local development (monorepo)

With API and dependencies running per the main [repository README](https://github.com/InnKeeperDevOps/kaiad/blob/main/README.md):

```bash
cd apps/agent
SM_REALTIME_URL=ws://localhost:3001/realtime \
SM_AGENT_ID=local-agent \
SM_ENROLLMENT_TOKEN=dev-token \
go run ./cmd/agent
```

Use a token your API accepts (for example the dev enrollment flow configured for your environment).

## Verify

- **Logs**: On start you should see the agent id, WebSocket URL, and Docker socket path.
- **Connectivity**: If TLS or routing is wrong, the process will log connection errors and retry with backoff.
- **Control plane**: Confirm the agent appears connected in the dashboard; if the realtime tier is misconfigured, see [Realtime gateway]({% link runbooks/realtime-gateway.md %}).

## Related

- [Agent networking]({% link security/agent-networking.md %}) — egress-only model and hardening checklist.
- [Configure the control plane]({% link getting-started/configure-control-plane.md %}) — API ports and stack layout.
- [Realtime gateway]({% link runbooks/realtime-gateway.md %}) — troubleshooting WSS and command delivery.
