# BUG-DOC-004: command_id idempotency and at-least-once delivery semantics absent from AGENTS.md

**Detected by:** Manual review vs `.cursor/plans/service_monitor_platform_5fd05388.plan.md` (agent model + command-dispatch-hardening todo)
**Severity:** Medium
**Status:** Open

---

## Summary

The platform plan's agent model section requires: *"`command_id` idempotency for at-least-once delivery; Redis-backed pending commands (not in-memory-only in prod); backpressure when per-agent queues exceed limits."* The `command-dispatch-hardening` todo (status: `completed`) also covers replay/ack/backpressure semantics.

`service-monitor/AGENTS.md` shows the AgentCommand dispatch flow in its mermaid diagrams but never documents these durability semantics. An implementer reading only `AGENTS.md` would not know that:
- Every `AgentCommand` must carry a `command_id` for idempotent replay.
- Pending commands must be Redis-backed (not in-memory) in production.
- The gateway must apply per-agent backpressure.

## Expected behaviour

`AGENTS.md` should document at minimum that `AgentCommand` dispatch uses `command_id` idempotency, Redis-backed pending command storage, and per-agent backpressure — either inline in the agent description or as a note in the Architecture flows section.

## Actual behaviour

The agent connection lifecycle diagram and surrounding prose make no mention of `command_id`, replay, ack, or backpressure.

## Fix direction

Add a durability/idempotency note to the `apps/agent` command execution bullet and/or to the "Agent connection lifecycle" diagram section:

```markdown
- **Command durability** — `AgentCommand` frames carry a `command_id`; the gateway persists pending commands in Redis (never in-memory-only in production) and applies per-agent backpressure when queues exceed limits. At-least-once delivery with idempotent replay on reconnect.
```
