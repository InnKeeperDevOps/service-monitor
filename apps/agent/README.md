# Kaiad Agent (Go)

- Primary transport: TLS WebSocket (`SM_REALTIME_URL`).
- Enrollment uses token-auth over outbound WSS (`SM_ENROLLMENT_TOKEN`) with local credential persistence for subsequent reconnects; mTLS lifecycle remains a documented hardening path.
- In production (`NODE_ENV=production`), the agent fails closed unless an enrollment token or saved credential is available.
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
