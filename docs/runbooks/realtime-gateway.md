---
title: Realtime gateway
parent: Runbooks
nav_order: 3
---

# Realtime gateway (agent WSS)

The **agent realtime** tier carries **bidirectional WSS**: telemetry up, **AgentCommand** down. It may share a process with the HTTP API or run separately behind a load balancer.

## Symptoms

- Agents **disconnect** or flap; dashboard shows **offline** or missing telemetry.
- **Commands** not delivered; backlog in **Redis**-backed per-agent queues (if used) grows.
- Load balancer **502/504** on WSS path; TLS or upgrade errors at the edge.

## Impact

- **High**: No live agent channel—log streaming and remote remediation steps that depend on the agent stop working.
- **Partial**: Some agents OK (other regions/instances); investigate affinity and gateway instance health.

## Immediate actions

1. Confirm **edge routing**: WSS path, **TLS** termination, and **WebSocket upgrade** headers allowed.
2. If multiple gateway instances: verify **sticky sessions** **or** shared **Redis** command queue (design must not rely on single-node memory).
3. **Drain** misbehaving instances: stop new connections, allow in-flight acks, then restart (per deploy playbook).
4. Check **Redis** if command durability/replay depends on it; see [Redis failure]({% link runbooks/redis-failure.md %}).
5. Validate **agent token** / enrollment config unchanged; clock skew within tolerance.

## Validation checks

- Sample agent shows **connected** state; heartbeat or enrollment succeeds.
- Send a **no-op or safe** AgentCommand in non-prod; observe **ack** path.
- Metrics/logs: stable connection count, low error rate on upgrade path.
- After gateway deploy: **reconnect storm** subsides without sustained 5xx.
