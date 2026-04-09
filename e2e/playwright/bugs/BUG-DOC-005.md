# BUG-DOC-005: workflow-engine server-side dry-run use case omitted from AGENTS.md

**Detected by:** Manual review vs `PROJECT_DEFINITION.md` (shared packages table)
**Severity:** Low
**Status:** Open

---

## Summary

`PROJECT_DEFINITION.md` describes the `workflow-engine` package as: *"Used by `apps/api` for server-side dry-run and `sm-workflow-exec` on the agent."* `service-monitor/AGENTS.md` describes the same package as only "DAG executor for workflow graphs: parallel branches, join nodes, conditional branching, step result tracking" — the `apps/api` server-side dry-run use case is absent.

## Expected behaviour

The `workflow-engine` row in the packages table of `AGENTS.md` should mention that it is used by both `apps/api` (server-side dry-run / validation) and `sm-workflow-exec` on the agent (runtime execution).

## Actual behaviour

`AGENTS.md` line 88 describes the package with no mention of which apps consume it or the dry-run use case.

## Fix direction

Update the packages table entry:

```markdown
| `workflow-engine` | DAG executor for workflow graphs: parallel branches, join nodes, conditional branching, step result tracking. Used by `apps/api` for server-side dry-run/validation and by `sm-workflow-exec` on the agent for runtime execution. |
```
