# Tenant Git Config Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove global Git configurations from the tenant settings to rely on Service-level config and Workflow-level workload sourcing, and introduce new agent connection events.

**Architecture:** We will strip `gitRepoUrl`, `sshKeyId`, `defaultBranch`, and `agentWorkloadSource` from the `TenantSettings` type and database schemas, as these properties correctly belong to `MonitoredService` and `WorkflowGraph`. We will update the `AgentHello` payload and Go agent to drop `ConfigReady` and `Workload` properties, making the agent instantly ready upon connection. Finally, we will add `agentConnected` and `agentDisconnected` to the workflow events.

**Tech Stack:** TypeScript, Node.js, Fastify, Zod, React, Go (Agent WebSocket Client)

---

### Task 1: Update Contracts

**Files:**
- Modify: `packages/contracts/src/http.ts`
- Modify: `packages/contracts/src/realtime.ts`
- Test: `packages/contracts/test/schemas.test.ts`

- [ ] **Step 1: Update `tenantSettingsSchema`**
Remove `gitRepoUrl`, `sshKeyId`, `defaultBranch`, and `agentWorkloadSource`. Add the new events to `workflowEventKindSchema`.

```typescript
// In packages/contracts/src/http.ts
// Remove agentWorkloadSourceSchema

export const tenantSettingsSchema = z.object({
  tenantId: z.string(),
  docsUrl: z.string().url().optional(),
  automationPolicy: automationPolicySchema.optional(),
  preferredExecutor: z.enum(["cursor", "claude"]).optional(),
  agentRuntimeBackend: agentRuntimeBackendSchema.optional()
});

// Update workflowEventKindSchema to include agentConnected and agentDisconnected
export const workflowEventKindSchema = z.enum([
  "onBuild",
  "onStartup",
  "onCrash",
  "onShutdown",
  "onLogPattern",
  "onSchedule",
  "agentStarted",
  "agentStopped",
  "agentOnline",
  "agentOffline",
  "agentConnected",
  "agentDisconnected",
  "agentCrashed",
  "agentRestarted",
  "onServiceConfigurationUpdate"
]);

// Add event nodes for the new kinds
const eventNodeSchemas = [
  // ... existing schemas
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("agentConnected"),
    data: eventDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("agentDisconnected"),
    data: eventDataSchema({}).optional()
  }),
  // ... existing schemas
] as const;
```

- [ ] **Step 2: Update `agentHelloMessageSchema`**
Remove `configReady` and `workload` from `packages/contracts/src/realtime.ts`.

```typescript
// In packages/contracts/src/realtime.ts
export const agentHelloMessageSchema = z.object({
  type: z.literal("hello"),
  service: z.literal("realtime"),
  runtime: z.object({ backend: z.enum(["docker", "kubernetes", "shell"]) }),
  preferredExecutor: z.enum(["cursor", "claude"]).optional()
});
```

- [ ] **Step 3: Update `packages/contracts/test/schemas.test.ts`**
Remove any checks for the deleted fields.

```typescript
// Update the tenantSettingsSchema tests to remove gitRepoUrl, etc.
// Update agentHelloMessageSchema tests to remove configReady and workload.
```

- [ ] **Step 4: Run tests**
Run: `pnpm --filter @sm/contracts test`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add packages/contracts
git commit -m "refactor(contracts): remove tenant git config and add agent events"
```

### Task 2: Update API `AgentHello` Builder

**Files:**
- Modify: `apps/api/src/agentHelloPayload.ts`
- Test: `apps/api/test/agentHelloPayload.test.ts`

- [ ] **Step 1: Simplify `buildRealtimeAgentHello`**

```typescript
// In apps/api/src/agentHelloPayload.ts
import { agentHelloMessageSchema, type TenantSettings } from "@sm/contracts";

export function buildRealtimeAgentHello(settings: TenantSettings | undefined) {
  let runtimeBackend: "docker" | "kubernetes" | "shell" = "docker";
  if (settings?.agentRuntimeBackend) {
    runtimeBackend = settings.agentRuntimeBackend;
  }

  try {
    return agentHelloMessageSchema.parse({
      type: "hello",
      service: "realtime",
      runtime: { backend: runtimeBackend },
      ...(settings?.preferredExecutor ? { preferredExecutor: settings.preferredExecutor } : {})
    });
  } catch (e) {
    console.error("Parse Error in buildRealtimeAgentHello:", e);
    throw e;
  }
}
```

- [ ] **Step 2: Fix API tests**
Remove references to the deleted fields in `apps/api/test/agentHelloPayload.test.ts` and `apps/api/test/agent-settings-propagation.test.ts`, `apps/api/test/auth.test.ts` etc.

- [ ] **Step 3: Run tests**
Run: `pnpm --filter @sm/api test`
Expected: PASS

- [ ] **Step 4: Commit**
```bash
git add apps/api
git commit -m "refactor(api): remove git config from AgentHello payload"
```

### Task 3: Update Web UI Settings Page

**Files:**
- Modify: `apps/web/src/features/settings/TenantConfigurationSection.tsx`
- Modify: `apps/web/src/features/settings/mergeTenantSettings.ts`
- Test: `apps/web/test/tenant-configuration-page.test.tsx`
- Test: `apps/web/test/mergeTenantSettings.test.tsx`

- [ ] **Step 1: Remove fields from `mergeTenantSettings.ts`**

```typescript
// In apps/web/src/features/settings/mergeTenantSettings.ts
// Remove gitRepoUrl, sshKeyId, defaultBranch, agentWorkloadSource
import type { TenantSettings } from "@sm/contracts";

export function mergeTenantSettings(base: TenantSettings, patch: Partial<TenantSettings>): TenantSettings {
  return {
    tenantId: patch.tenantId ?? base.tenantId,
    docsUrl: patch.docsUrl !== undefined ? patch.docsUrl : base.docsUrl,
    automationPolicy: patch.automationPolicy !== undefined ? patch.automationPolicy : base.automationPolicy,
    preferredExecutor: patch.preferredExecutor !== undefined ? patch.preferredExecutor : base.preferredExecutor,
    agentRuntimeBackend: patch.agentRuntimeBackend !== undefined ? patch.agentRuntimeBackend : base.agentRuntimeBackend
  };
}
```

- [ ] **Step 2: Remove UI elements from `TenantConfigurationSection.tsx`**
Remove the state, inputs, and save logic for `gitRepoUrl`, `defaultBranch`, `sshKeyId`, and `agentWorkloadSource`. Only `agentRuntimeBackend` and `preferredExecutor` should remain in the "Agent Configuration" section.

- [ ] **Step 3: Fix Web tests**
Fix the tests in `apps/web/test/tenant-configuration-page.test.tsx` and `apps/web/test/mergeTenantSettings.test.tsx` to remove the deleted fields.

- [ ] **Step 4: Run tests**
Run: `pnpm --filter @sm/web test`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add apps/web
git commit -m "refactor(web): remove tenant git configuration from settings UI"
```

### Task 4: Update Go Agent Client

**Files:**
- Modify: `apps/agent/internal/transport/client.go`
- Modify: `apps/agent/internal/mockrealtime/server.go`
- Modify: `apps/agent/cmd/mock-realtime-server/main.go`
- Modify: `apps/agent/internal/executor/executor.go`

- [ ] **Step 1: Update `AgentHello` struct**

```go
// In apps/agent/internal/transport/client.go
type AgentHello struct {
	Service string `json:"service"`
	Runtime struct {
		Backend string `json:"backend"`
	} `json:"runtime"`
	PreferredExecutor string `json:"preferredExecutor,omitempty"`
}

// Remove ResolveKaiadConfig from AgentHello, or simplify it to always return true, "" if it's used elsewhere.
func (h AgentHello) ResolveKaiadConfig(skipWaitEnv bool) (kaiadReady bool, workloadSource string) {
	return true, "git_repo"
}
```

- [ ] **Step 2: Update mock servers and tests**
Remove references to `ConfigReady`, `Workload`, and `WorkloadSource` in the Go tests and mock servers. The agent now assumes it's ready.

- [ ] **Step 3: Run Go tests**
Run: `cd apps/agent && go test ./...`
Expected: PASS

- [ ] **Step 4: Commit**
```bash
git add apps/agent
git commit -m "refactor(agent): remove config ready check from websocket client"
```
