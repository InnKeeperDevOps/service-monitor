# BUG-WRK-001: Missing execution handlers for workflow control nodes (loop, wait, split, join)

**Detected by:** code review plan comparison
**Severity:** High
**Status:** Open

## Summary
The workflow execution engine does not implement actual handlers for `loop`, `wait`, `split`, and `join` control nodes for live execution. While dry-run handlers were added and the UI components support configuring them, the backend engine skips real execution or lacks the handlers entirely, breaking workflow execution for these node types.

## Affected plan / definition reference
`docs/superpowers/plans/2026-04-13-workflow-editor-revamp.md` Task 4 (Backend Execution Engine - Handlers Update) required adding handlers with iteration and timeout logic for live execution.

## Reproduction steps
1. Create a workflow graph with a `wait` node or a `loop` node.
2. Configure the duration or items.
3. Queue the workflow for live execution on an agent.
4. The worker running the workflow execution logic will throw an error or skip execution due to missing handlers for these node kinds, as `apps/worker/src/workflow-execution.ts` does not contain handlers for them.

## Root cause
The implementation for Task 4 only added logic to `createDryRunHandlers` in `apps/api/src/server.ts` and failed to provide actual implementations for `loop`, `wait`, `join`, and `split` in the real workflow execution paths (e.g. `apps/worker/src/workflow-execution.ts` or wherever real handlers are registered for the executor).

## Fix direction
1. Implement the required handlers in the worker's workflow execution service (`apps/worker/src/workflow-execution.ts`).
2. Add the necessary logic (`setTimeout` for wait, array iteration for loops).
3. Validate domain schemas to properly accept `items` and `duration` strings for loop and wait nodes, respectively.