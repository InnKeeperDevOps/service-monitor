# BUG-DOC-006: Workflow node/trigger type list in AGENTS.md is generic and incomplete

**Detected by:** Manual review vs `.cursor/plans/workflow_editor_graph_actions_+_trigger_params_2277c547.plan.md` and `.cursor/plans/service_monitor_platform_5fd05388.plan.md`
**Severity:** Low
**Status:** Open

---

## Summary

`service-monitor/AGENTS.md` lists workflow node types as: `trigger, runShell, httpRequest, slackNotify, branchIf, etc.` The workflow graph actions plan defines concrete trigger subtypes (`onBuild`, `onStartup`, `onCrash`, `onShutdown`, `onLogPattern`, `onSchedule`) with specific parameter contracts, and the platform plan names action nodes `runCursorPlan`/`runClaudePlan` (in addition to `runShell`). Using a generic `trigger` bucket in `AGENTS.md` understates what is actually implemented.

## Expected behaviour

`AGENTS.md` should enumerate the specific trigger node types and note action nodes like `runCursorPlan`/`runClaudePlan` alongside `runShell`, giving implementers an accurate picture of the node catalog.

## Actual behaviour

The `apps/web` Workflow editor bullet in `AGENTS.md` lists only `trigger, runShell, httpRequest, slackNotify, branchIf, etc.` — hiding the six specific trigger types and AI-runner action nodes behind a generic label.

## Fix direction

Update the Workflow editor bullet to enumerate node types:

```markdown
- **Workflow editor** — React Flow canvas for building, saving, and running automation graphs.
  - **Trigger nodes:** `onCrash`, `onStartup`, `onShutdown`, `onBuild`, `onLogPattern`, `onSchedule` (each with type-specific parameter contracts).
  - **Action nodes:** `runShell`, `runCursorPlan`, `runClaudePlan`, `httpRequest`, `slackNotify`, `branchIf`.
```
