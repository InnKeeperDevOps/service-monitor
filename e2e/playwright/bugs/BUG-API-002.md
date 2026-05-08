# BUG-API-002: Workflow execution queue never wired in runtime; every execute-workflow returns 503

**Detected by:** Code read of `apps/api/src/server.ts` after user hit "Workflow execution queue is not configured"
**Severity:** High
**Status:** Resolved

## Summary

Executing a workflow from the panel fails with **HTTP 503 `INTERNAL_ERROR` — "Workflow execution queue is not configured"**, even with Redis fully configured. The execute-workflow route calls `enqueueWorkflowExecution(...)` (`apps/api/src/server.ts:1719`), but the runtime wiring function `createRuntimeQueueWiringFromEnv` (`apps/api/src/server.ts:437`) only builds `enqueueLogIngestion` and `enqueueAgentCommand`. It never sets `enqueueWorkflowExecution`, so `buildServer` falls back to `noopWorkflowExecutionEnqueue` (`apps/api/src/server.ts:345-347`) which throws.

## Affected plan / definition reference

`apps/worker/src/worker-runtime.ts:104-108` already wires a BullMQ worker on the `workflowExecution` queue (`QUEUE_NAMES.workflowExecution = "workflow-execution"` in `packages/contracts/src/constants.ts`). The worker side exists; the producer side in the API was missed. The types and no-op fallback in `buildServer` imply the wiring was intended to be parallel with `enqueueLogIngestion` / `enqueueAgentCommand`.

## Reproduction steps

1. Start dev stack: `docker compose -f env/dev/docker-compose.yml up -d` (Redis and Postgres running).
2. Sign in to `http://panel.dev.kaiad.dev`.
3. Open a workflow for a service and press "Run".
4. API returns `503 INTERNAL_ERROR` with `message: "Workflow execution queue is not configured"`.

## Root cause

`createRuntimeQueueWiringFromEnv` omits the workflow execution queue. Only `logIngestion` and `agentCommands` queues are constructed; `enqueueWorkflowExecution` is never provided to `buildServer`.

## Fix direction

Add a third BullMQ queue in `createRuntimeQueueWiringFromEnv`:

- Construct `workflowExecutionQueue = createNamedQueue<WorkflowExecutionJob>("workflowExecution", redis)`.
- Provide `enqueueWorkflowExecution: async (job) => { await workflowExecutionQueue.add("workflow-execution", job); }` in `buildOptions`.
- Close it alongside the others in `close()`.
- Extend `apps/api/test/runtime-queue-wiring.test.ts` to assert the third queue is created and `enqueueWorkflowExecution` adds a job named `"workflow-execution"`.

## Resolution

Applied the fix above in `apps/api/src/server.ts:createRuntimeQueueWiringFromEnv` and extended `apps/api/test/runtime-queue-wiring.test.ts` to cover the new wiring.
