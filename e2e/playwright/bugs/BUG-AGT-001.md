# BUG-AGT-001: Settings change not pushed live to connected agent

**Detected by:** `E2E-AGT-001` in `agent-settings-live-propagation.spec.ts`
**Severity:** Medium
**Status:** Open

---

## Summary

When an operator changes `agentRuntimeBackend` (Agent runtime) via the Kaiad UI and saves, the setting is persisted to the store but **not pushed** to Go agents that are already connected via WebSocket. The agent continues running with stale settings until it disconnects and reconnects.

## Affected field

`agentRuntimeBackend` → reflected in `runtime.backend` of the `/realtime` `hello` frame.

## Expected behaviour

Within a few seconds of the operator saving a new `agentRuntimeBackend` value, Kaiad should deliver an updated frame (a re-sent `hello` or a new `settings_update` message) to every WebSocket session belonging to the affected tenant. The connected Go agent should apply the new runtime backend without requiring a restart or reconnect.

## Actual behaviour

The connected agent's WebSocket receives no update. The `runtime.backend` field in the agent's current session remains the value that was sent in the initial `hello` at connection time. The new value is only visible after the agent closes its connection and reconnects (at which point the server reads the updated settings and sends a fresh `hello`).

## Reproduction steps

1. Start Kaiad (`KAIAD_SKIP_SETUP_GATE=1 node dist/server.js`).
2. Enroll a Go agent — it connects to `/realtime` and receives a `hello` with `runtime.backend = "docker"`.
3. In the Kaiad UI, navigate to **Tenants → Configure → Tenant Configuration**.
4. Change **Agent runtime** from `Default (Docker)` to `Kubernetes` and click **Save tenant settings**.
5. Observe: the already-connected agent's WebSocket receives no new frame. Its `runtime.backend` remains `"docker"`.
6. Disconnect and reconnect the agent.
7. Observe: the new `hello` now contains `runtime.backend = "kubernetes"`.

## Impact

Agents remain running with stale runtime configuration until they restart. In a production environment with long-lived agent connections (heartbeat keeps sessions alive indefinitely), an operator changing the runtime backend (e.g. from Docker to Kubernetes) would see no effect until the agent process is restarted — which may not be immediately obvious.

## Root cause

`buildRealtimeAgentHello` in `apps/api/src/agentHelloPayload.ts` is called once at WebSocket upgrade time (`apps/api/src/server.ts`, `/realtime` handler). The `RealtimeManager` can send arbitrary frames to connected agents via `sendCommand`, but there is no code path that iterates connected sessions and re-sends a `hello` (or equivalent) when `POST /api/v1/settings` succeeds.

## Fix direction

After a successful `upsertTenantSettings` call in the `POST /api/v1/settings` handler, iterate `realtimeManager.getConnectedAgentIds()`, look up the tenant for each session (requires storing `agentId → tenantId` in `RealtimeManager`), and send an updated `hello` frame to every agent belonging to the saved tenant.

```typescript
// Sketch — apps/api/src/server.ts POST /api/v1/settings
const saved = await upsertTenantSettings(payload);
const updatedHello = buildRealtimeAgentHello(saved);
for (const agentId of realtimeManager.getAgentsForTenant(session.tenantId)) {
  await realtimeManager.sendCommand(agentId, JSON.stringify(updatedHello));
}
return saved;
```

`RealtimeManager` needs a `tenantId` stored alongside each `AgentSession` and a `getAgentsForTenant(tenantId)` helper.

## Test coverage

`E2E-AGT-001` in `e2e/playwright/tests/agent-settings-live-propagation.spec.ts` — step **"Agent runtime: default → kubernetes"** — uses `expect.soft()` for the live-push assertion and will continue to fail (and re-write this file) until the fix is in place. The reconnect assertion in the same step passes, confirming the stored value is correct.
