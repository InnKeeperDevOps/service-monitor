# BUG-DOC-007: NestJS exclusion not stated in AGENTS.md tech stack

**Detected by:** Manual review vs `PROJECT_DEFINITION.md` and `.cursor/plans/service_monitor_platform_5fd05388.plan.md`
**Severity:** Low
**Status:** Open

---

## Summary

Both `PROJECT_DEFINITION.md` and the platform plan explicitly state that NestJS is not a co-equal option for the API: *"Fastify (locked for v1; NestJS is not a co-equal option)."* `service-monitor/AGENTS.md` only says "Fastify (locked for v1)" without the NestJS exclusion.

This wording is intentional in the source documents — it prevents future drift where NestJS gets introduced as "just another option."

## Expected behaviour

`service-monitor/AGENTS.md` tech stack entry for the API framework should read:

> **API:** Fastify (locked for v1; NestJS is not a co-equal option).

## Actual behaviour

`AGENTS.md` line 93 reads: `**API:** Fastify (locked for v1).` — the NestJS exclusion is absent.

## Fix direction

One-line change in the Tech stack section:

```markdown
- **API:** Fastify (locked for v1; NestJS is not a co-equal option).
```
