# SSH Keys Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rip out the GitHub App integration entirely and replace it with a generic SSH keys implementation for Git clone/push across the control plane, worker, and agent.

**Architecture:** We will introduce a new `ssh_keys` table to store tenant SSH keys (uploaded encrypted or local paths), update `monitored_services` to use `git_repo_url` and `ssh_key_id`, remove all `@sm/github` code, and update the Go agent to use generic Git over SSH via temporary key files.

**Tech Stack:** Postgres (Drizzle schema), Fastify, React, Go, BullMQ.

---

### Task 1: Database Schema & Core Contracts Update

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/queries.ts`
- Modify: `packages/contracts/src/http.ts`
- Modify: `packages/contracts/src/realtime.ts`
- Run: `cd packages/contracts && pnpm generate:openapi`

- [ ] **Step 1: Write failing tests for contracts and db schema**
```typescript
// packages/db/test/schema.test.ts (update existing test)
expect(coreSchemaSql).toContain("create table if not exists ssh_keys");
expect(coreSchemaSql).not.toContain("github_app_installations");
expect(coreSchemaSql).toContain("git_repo_url text");
expect(coreSchemaSql).toContain("ssh_key_id text references ssh_keys(id)");
```

- [ ] **Step 2: Update database schema**
```typescript
// packages/db/src/schema.ts
// Remove github_app_installations table.
// Add:
export const sshKeysSchema = `
create table if not exists ssh_keys (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  name text not null,
  type text not null, -- 'uploaded' or 'local_path'
  private_key_encrypted text,
  local_path text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
`;
// Update monitored_services to remove repo/github_repo, add git_repo_url and ssh_key_id
```

- [ ] **Step 3: Update `http.ts` and `realtime.ts` schemas**
Remove all github schemas (`githubInstallationSettingsSchema`, etc).
Add `sshKeySchema`, `createSshKeyRequestSchema`.
Update `monitoredServiceSchema` to include `gitRepoUrl` and `sshKeyId`.
Rename `agentWorkloadSourceSchema` values if necessary (e.g. from `github_repo` to `git_repo`).

- [ ] **Step 4: Update DB Queries**
Modify `packages/db/src/queries.ts` to include SSH keys CRUD and update `monitored_services` inserts/updates.

- [ ] **Step 5: Run tests and generate OpenAPI**
Run: `pnpm test --filter @sm/db --filter @sm/contracts`
Run: `cd packages/contracts && pnpm run generate:openapi`

- [ ] **Step 6: Commit**
```bash
git add packages/db packages/contracts
git commit -m "feat: add ssh_keys schema and update contracts"
```

### Task 2: API Domain Store & Setup Logic

**Files:**
- Modify: `apps/api/src/domainStore.ts`
- Modify: `apps/api/src/postgresDomainStore.ts`
- Modify: `apps/api/src/memoryDomainStore.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write failing tests for domain store**
Add `createSshKey`, `listSshKeys`, `deleteSshKey` tests in `apps/api/test/domain-api.test.ts`.

- [ ] **Step 2: Implement SSH Key CRUD in Domain Store**
Add methods to interface and both implementations (memory and postgres).
Ensure encryption/decryption is used for `private_key_encrypted` in postgres.

- [ ] **Step 3: Remove GitHub logic from API**
In `apps/api/src/server.ts`, remove `bootstrapEnv.js` GitHub logic, remove `/api/v1/github/installations` routes, remove webhook ingress routes.

- [ ] **Step 4: Run tests**
Run: `pnpm test --filter @sm/api`

- [ ] **Step 5: Commit**
```bash
git add apps/api
git commit -m "feat: implement API logic for SSH keys and remove GitHub"
```

### Task 3: Worker and Go Agent Integration

**Files:**
- Modify: `apps/worker/src/index.ts`
- Modify: `apps/worker/src/worker-runtime.ts`
- Modify: `packages/contracts/src/jobs.ts`
- Modify: `apps/agent/internal/transport/client.go`
- Modify: `apps/agent/internal/mockrealtime/server.go`

- [ ] **Step 1: Update Job Schemas**
Remove `githubWebhookJobPayloadSchema` and related in `jobs.ts`. Update `remediationJobSchema` to require `gitRepoUrl`, `sshKeyType`, and `sshKeyValue`.

- [ ] **Step 2: Update Worker Runtime**
Remove GitHub app instantiation and queue worker. When creating a remediation job or dispatching, pass the SSH key details to the agent via `AgentCommand`.

- [ ] **Step 3: Update Go Agent to handle SSH Keys**
In `apps/agent`, update where it executes `git clone`/`push`.
If `sshKeyType == "uploaded"`, create `/tmp/kaiad_ssh_key_...` with mode 0600, write `sshKeyValue`, set `GIT_SSH_COMMAND`, and defer removal.
If `sshKeyType == "local_path"`, set `GIT_SSH_COMMAND="ssh -i <local_path> -o StrictHostKeyChecking=no"`.

- [ ] **Step 4: Run tests**
Run: `pnpm test --filter @sm/worker --filter @sm/contracts`
Run: `cd apps/agent && go test ./...`

- [ ] **Step 5: Commit**
```bash
git add apps/worker apps/agent packages/contracts
git commit -m "feat: update worker and go agent for ssh keys"
```

### Task 4: Web UI - SSH Keys Page

**Files:**
- Create: `apps/web/src/features/ssh-keys/SshKeysPage.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: Add API client methods**
Add `listSshKeys`, `createSshKey`, `deleteSshKey` in `api.ts`.

- [ ] **Step 2: Build SSH Keys UI**
Create a table for listing keys, and a modal/form for adding keys (handling uploaded vs local_path). 

- [ ] **Step 3: Add to Navigation**
Update the Sidebar in `app.tsx` (or layout) to include "SSH Keys".

- [ ] **Step 4: Commit**
```bash
git add apps/web
git commit -m "feat: build SSH keys UI page"
```

### Task 5: Web UI - Services and Settings

**Files:**
- Modify: `apps/web/src/features/services/ServicesPage.tsx`
- Modify: `apps/web/src/features/settings/SettingsPage.tsx`
- Modify: `apps/web/src/features/setup/SetupWizardPage.tsx`
- Modify: `apps/web/src/features/tenants/TenantConfigurationPage.tsx`

- [ ] **Step 1: Update Services Page**
Replace GitHub repo input with Git Repo URL. Add dropdown for selecting an SSH Key.

- [ ] **Step 2: Clean up Settings and Setup**
Remove GitHub App ID, Private Key, and Webhook Secret inputs from the setup wizard and settings pages.

- [ ] **Step 3: Run tests and verify**
Run: `pnpm test --filter @sm/web`

- [ ] **Step 4: Commit**
```bash
git add apps/web
git commit -m "feat: update services and remove github from ui"
```
