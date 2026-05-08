# BUG-AGT-002: Agent reconnects bind to wrong tenant (`t-1`) after token is marked used, so heartbeats don't update the real tenant's agent row

**Detected by:** UI inspection after API restart — `/#agents` page summary showed `1 live (WebSocket)` but the agent row status stuck at `offline` with `Last seen` frozen at the moment of restart
**Severity:** High
**Status:** Resolved

## Summary

When an agent reconnects to `/realtime` using the same enrollment token that was already marked `used_at`, the server's `consume()` returns null (treating the token as spent), and the `/realtime` handler silently falls back to `agentTenantId = "t-1"` in dev. Heartbeats then persist under a different tenant than the one the agent was originally enrolled into, so the agent's "real" row stays stuck at its last pre-restart `lastSeen` and the UI shows it as `offline` even while the WebSocket is live and acknowledged.

## Affected plan / definition reference

Per `apps/agent/README.md`: the agent is **stateless by default** and is expected to "supply `SM_ENROLLMENT_TOKEN`, `SM_AGENT_ID`, and `SM_REALTIME_URL` from the environment on every run" — i.e. the same plaintext token is expected to work across reconnects within its TTL. The current single-consume semantics of enrollment tokens contradicts that contract.

## Reproduction steps

1. Start dev stack + run the Go agent with a fresh `SM_ENROLLMENT_TOKEN` (token becomes `used_at=now()` on first successful `/realtime` handshake).
2. Restart the dev API container (`docker compose -f env/dev/docker-compose.yml up -d kaiad`).
3. Agent auto-reconnects; agent logs show `websocket connected` + `kaiad hello` + ongoing heartbeat/ack flow.
4. Panel `/#agents`: summary counter shows `1 live (WebSocket)` but the row says `offline` with `Last seen` frozen at the restart instant.

## Root cause

Two compounding issues in `apps/api/src/server.ts` at the `/realtime` handler (line 569) and in `apps/api/src/enrollmentStore.ts`:

1. `consume(plaintext)` (memory + postgres impls) requires `used_at IS NULL`, so a used-but-not-expired, not-revoked token returns null on reconnect.
2. The `/realtime` handler, when `tokenParam` is provided but validation returns null, silently falls through to the dev fallback `agentTenantId = "t-1"` at line 606 instead of rejecting. Heartbeats under `t-1` don't match the UI's selected tenant, so `recordAgentHeartbeat` never updates the row the user is watching.

## Fix direction

1. `apps/api/src/enrollmentStore.ts` — change both memory and postgres `consume` so `used_at` is set **only on first use** (`coalesce(used_at, now())`) and the query still resolves the token as long as it is not revoked and not expired. The UI's "Used" column continues to reflect first-use time.
2. `apps/api/src/server.ts` `/realtime` handler — when `tokenParam` is supplied but validation returns null, close the socket with `INVALID_TOKEN` in **all environments** (no silent dev fallback to `t-1` for supplied-but-invalid tokens). The `!tokenParam && isDev` fallback remains for the no-token case used by WS unit tests.
3. Tests: extend `apps/api/test/enrollmentStore.test.ts` (memory path — token resolvable twice with same plaintext) and add a WS test in `apps/api/test/api.test.ts` asserting that a reconnect with the same token still resolves the original tenant.

## Resolution

Applied fixes 1–3. `used_at` now records first-use; reconnects resolve through the same token until expiry/revocation; invalid tokens close the socket with `INVALID_TOKEN` regardless of env.
