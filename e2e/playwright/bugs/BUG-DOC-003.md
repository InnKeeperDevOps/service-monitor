# BUG-DOC-003: mTLS option missing from agent description in AGENTS.md

**Detected by:** Manual review vs `.cursor/plans/service_monitor_platform_5fd05388.plan.md` (summary + agent model section)
**Severity:** Medium
**Status:** Open

---

## Summary

The platform plan and its summary document both state that the Go agent supports **"mTLS or token auth"** for its outbound WebSocket connection to the control plane. `service-monitor/AGENTS.md` describes the agent as using only an enrollment token; mTLS is never mentioned.

With the `customer-agent` todo still marked `in_progress`, omitting mTLS from the agent instructions means an implementer reading only `AGENTS.md` has no signal that mutual TLS is a planned security option.

## Expected behaviour

The `apps/agent` description in `service-monitor/AGENTS.md` should reflect both security modes, e.g.:

> **Outbound WebSocket connection** — connects to the control plane's `/realtime` endpoint using an enrollment token (mTLS is a planned hardening option); maintains a persistent, backpressure-aware channel with exponential reconnect backoff.

## Actual behaviour

`AGENTS.md` line 73 says only "connects to the control plane's `/realtime` endpoint using an enrollment token" — no mention of mTLS.

## Fix direction

Update the `apps/agent` bullet for the outbound connection to mention mTLS as a planned/optional security layer alongside token auth. Cross-reference the platform plan's agent model section and the KMS/rotation notes in risks.
