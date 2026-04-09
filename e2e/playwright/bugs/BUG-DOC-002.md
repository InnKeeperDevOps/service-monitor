# BUG-DOC-002: SQLite local-dev option omitted from AGENTS.md

**Detected by:** Manual review vs `.cursor/plans/service_monitor_platform_5fd05388.plan.md`
**Severity:** Low
**Status:** Open

---

## Summary

The platform plan goals table states: *"PostgreSQL for production multi-tenant; SQLite optional for local dev via ORM abstraction (Drizzle or Prisma)."* `service-monitor/AGENTS.md` (and `PROJECT_DEFINITION.md`) list only PostgreSQL, omitting SQLite entirely. If SQLite is still a valid local development path, agents and contributors will not know about it.

## Expected behaviour

If SQLite local dev is still supported, the tech stack entry in `service-monitor/AGENTS.md` should read something like:

> **Database:** PostgreSQL (Drizzle ORM); SQLite optional for local dev.

If it has been deliberately dropped, the platform plan should be updated to reflect that.

## Actual behaviour

`service-monitor/AGENTS.md` tech stack says only "PostgreSQL (Drizzle ORM)" with no mention of SQLite.

## Fix direction

Either:
- Add the SQLite local-dev note to the tech stack in `AGENTS.md` (if the option is still valid), or
- Mark the SQLite goal in the platform plan as superseded/dropped and add a note that Postgres is required even for local development.
