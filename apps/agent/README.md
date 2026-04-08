# Kaiad Agent (Go)

**Architecture:** component boundaries, WebSocket protocol summary, and execution flow are described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Mock realtime server (protocol validation)

A minimal Kaiad-compatible `/realtime` WebSocket server lives in [`internal/mockrealtime`](internal/mockrealtime) and is exposed as [`cmd/mock-realtime-server`](cmd/mock-realtime-server). It sends the same `hello` shape as `apps/api` and replies to every agent frame with `{"type":"ack","accepted":true}` (matching `server.ts`). Use it to exercise the agent transport without the full API.

```bash
# Terminal A — mock listens on default Kaiad dev port
go run ./cmd/mock-realtime-server -listen 127.0.0.1:3001

# Terminal B — agent (skip Kaiad config wait for quick smoke tests)
SM_SKIP_KAIAD_CONFIG_WAIT=1 SM_REALTIME_URL=ws://127.0.0.1:3001/realtime SM_AGENT_ID=dev-agent go run ./cmd/agent
```

Optional flags: `-token <secret>` (requires `?token=` on the WebSocket URL; set `SM_ENROLLMENT_TOKEN` on the agent), `-runtime`, `-config-ready`, `-workload`, `-inject <path.json>` (send a JSON command frame after the first heartbeat — for example a `run_step` payload).

**Debug logging:** set **`SM_AGENT_DEBUG=1`** (or `true` / `yes`) to emit verbose `[agent:transport]` lines for WebSocket frames (dial, hello, heartbeats, command handling, `command_ack`). The executor logs `[agent:executor] HandleCommand …` when debug is on. `cmd/agent` also prints a one-line environment summary in debug mode. Integration tests that spin up `internal/mockrealtime` and assert protocol behavior live in [`internal/transport/mockrealtime_protocol_test.go`](internal/transport/mockrealtime_protocol_test.go).

- Primary transport: TLS WebSocket (`SM_REALTIME_URL`).
- **Stateless by default:** the agent does **not** read or write enrollment credentials on disk. Supply `SM_ENROLLMENT_TOKEN`, `SM_AGENT_ID`, and `SM_REALTIME_URL` from the environment on every run (for example Kubernetes secrets). Set **`SM_AGENT_PERSIST_CREDENTIALS=1`** only if you intentionally want the legacy file at `SM_CREDENTIAL_PATH` (default `~/.service-monitor/agent-credential.json`) for load/save across restarts.
- In production (`NODE_ENV=production`), the agent fails closed unless `SM_ENROLLMENT_TOKEN` is set (persisted credentials are ignored unless `SM_AGENT_PERSIST_CREDENTIALS=1`).
- mTLS lifecycle remains a documented hardening path.
- **`run_toolchain`** — run `python3`, `java` (jar), `node`, `go`, `php`, `typescript`, `rust`, `swift`, or `kotlin` against a file path (see [ARCHITECTURE.md](ARCHITECTURE.md)); optional env overrides **`SM_TYPESCRIPT_RUNNER`**, **`SM_KOTLIN_RUNNER`**.
- Agent command executor supports `run_cursor_plan` and `run_claude_plan` commands (in addition to shell/docker operations), with log/audit artifacts written under `<workspace>/.sm/logs/`.
- Optional container isolation for plan executors: set `SM_EXECUTOR_ISOLATE_CONTAINERS=1` with `SM_EXECUTOR_RUNNER_IMAGE` (or `SM_EXECUTOR_RUNNER_IMAGE_CURSOR` / `SM_EXECUTOR_RUNNER_IMAGE_CLAUDE`) and optional `SM_EXECUTOR_DOCKER_BIN`.

## Tests and coverage

Run the full test suite (verbose):

```bash
go test ./... -v
```

Generate a line coverage profile using Go’s built-in `-coverprofile` flag:

```bash
go test ./... -coverprofile=coverage.out
```

Inspect coverage per function:

```bash
go tool cover -func=coverage.out
```

Coverage is enforced in CI with an **80%** minimum line coverage on total package coverage. See the `go-agent-tests` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), which runs `go test ./... -coverprofile=coverage.out`, parses the total from `go tool cover -func`, and fails the job when coverage is below 80%.

No extra coverage tools are required beyond the standard `go test` and `go tool cover` commands.
