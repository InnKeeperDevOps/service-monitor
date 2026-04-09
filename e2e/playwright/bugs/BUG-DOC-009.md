# BUG-DOC-009: Rust and alternate agent language exclusion not stated in AGENTS.md

**Detected by:** Manual review vs `.cursor/plans/service_monitor_platform_5fd05388.plan.md`
**Severity:** Low
**Status:** Open

---

## Summary

The platform plan states: *"Customer agent (`apps/agent`): Go as the only MVP implementation language; Rust (or others) are out of scope unless the plan is explicitly revised."* `PROJECT_DEFINITION.md` echoes this: *"Agent language: Go (locked for v1; other languages are out of scope unless plan is explicitly revised)."*

`service-monitor/AGENTS.md` says only "Go (locked for v1)" without noting that Rust or other languages are explicitly excluded, losing the deliberate intent of the lock.

## Expected behaviour

`AGENTS.md` tech stack line for the agent language should read:

> **Agent language:** Go (locked for v1; other languages are out of scope unless the plan is explicitly revised).

## Actual behaviour

`AGENTS.md` line 95 reads: `**Agent language:** Go (locked for v1).`

## Fix direction

One-line change in the Tech stack section:

```markdown
- **Agent language:** Go (locked for v1; other languages are out of scope unless the plan is explicitly revised).
```
