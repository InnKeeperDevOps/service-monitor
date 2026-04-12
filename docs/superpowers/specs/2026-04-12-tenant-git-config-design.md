# Remove Tenant-Level Git Config & Update Workload Sourcing

## Overview

The tenant configuration currently stores global Git configurations (`gitRepoUrl`, `defaultBranch`, `sshKeyId`, `agentWorkloadSource`). This violates the isolation principle since a single tenant can manage multiple services, each with its own repository and execution lifecycle. This design proposes removing these settings from the tenant level and relying entirely on the `Service` level for Git configuration and the `Workflow` level for CI/CD execution and workload sourcing.

Additionally, we'll introduce new events (like `agentConnected`) to give workflows more control over agent lifecycle responses.

## Architecture

### 1. Contract & Database Updates
- **Remove** `gitRepoUrl`, `sshKeyId`, `defaultBranch`, and `agentWorkloadSource` from `tenantSettingsSchema` in `packages/contracts/src/http.ts`.
- **Remove** these fields from the `TenantSettings` type and `getTenantSettings` / `updateTenantSettings` implementation in `apps/api`.
- **Remove** the `ConfigReady` and `Workload` properties from the `AgentHello` message type in `packages/contracts/src/realtime.ts` (and the Go agent `transport/client.go`).
- **Add** new workflow events: `agentConnected`, `agentDisconnected` to `workflowEventKindSchema` in `packages/contracts/src/http.ts` (alongside existing `agentOnline`, `agentOffline`).

### 2. API Updates
- Update `apps/api/src/agentHelloPayload.ts` to no longer inject `configReady` and `workload` properties based on tenant settings. The agent is considered immediately ready upon connection.
- Update `mergeTenantSettings` in `apps/web/src/features/settings/mergeTenantSettings.ts` to remove these properties.
- Remove references to these properties in `apps/api` test files.

### 3. UI Updates
- **Remove** the Git / Workload Source fields from `apps/web/src/features/settings/TenantConfigurationSection.tsx`.
- The user will now solely configure repositories on the `ServicesPage` (which already has `gitRepoUrl` and `sshKeyId` inputs).
- Add support for the new `agentConnected` and `agentDisconnected` events in the Workflow Editor dropdowns (or ensure they flow through automatically).

### 4. Go Agent Updates
- Update `apps/agent/internal/transport/client.go` to remove `ConfigReady` and `Workload` fields from `AgentHello`.
- Update `ResolveKaiadConfig` to simply return `true` (ready) without checking for workload sources.

## Testing Strategy
- Fix broken tests in `apps/web`, `apps/api`, `packages/contracts`, and `apps/agent` that try to supply `gitRepoUrl` at the tenant settings level or expect `ConfigReady` in the Agent Hello message.
- Verify the web UI renders correctly without the Git configuration section on the settings page.
- Verify the Go agent successfully handshakes with the API.

## Backward Compatibility
- Existing rows in the DB might have JSON data in the settings table containing `gitRepoUrl`, but our Zod schemas will ignore it if we don't `passthrough()`, or we can safely drop it from the schema.
