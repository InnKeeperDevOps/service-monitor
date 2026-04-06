---
name: build-and-test-all-apps
description: Use when validating repository-wide app health before handoff, PR creation, or merge, especially when changes may affect more than one app under apps/.
---

# Build and Test All Apps

Run a full app-level verification pass from the repository root.

## Prerequisites

- Node.js 22.x (required by the Vite toolchain in `apps/web`)
- pnpm (workspace package manager)
- Go toolchain for `apps/agent` checks (optional unless strict mode is enabled)
- Set `SM_REQUIRE_GO=1` to fail fast when Go is missing

## When to Use

- Before claiming a change is complete.
- Before opening or updating a PR.
- After touching shared packages used by multiple apps.

## Commands

Run these from the repo root:

```bash
pnpm build:apps
pnpm test:apps
```

## What These Cover

- `apps/web` build and tests (`@sm/web`)
- `apps/api` build and tests (`@sm/api`)
- `apps/worker` build and tests (`@sm/worker`)
- `apps/agent` Go build and tests (`go build ./...` and `go test ./...`)

## Failure Handling

1. Stop on the first failing app.
2. Fix the failing app or its shared dependency.
3. Re-run `pnpm build:apps` and `pnpm test:apps` until both pass.
