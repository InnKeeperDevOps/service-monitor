# Plan: many-to-many agent ↔ service binding

> **For agentic workers:** task-by-task plan. Each task lists files
> + checkboxes; commit after each unless noted.

**Goal.** Replace the single nullable `monitored_services.agent_id`
foreign key with a true many-to-many relationship: a service can run
on multiple agents, and an agent can run multiple services. UI grows
a multi-select on both the Agents page (per-row services list) and
the Services page (per-service agents list).

**Why.** A natural ask from the integration test: HA setups where two
agents tail the same service, multi-cluster deployments where one
service has agents in different clusters, and clearer agent-side
editing (you can see and pick what an agent owns from its own row).

**Tech stack.** Postgres, Fastify, React, BullMQ. No agent-side
changes — the agent already accepts whichever commands the platform
sends to its session, regardless of how the platform decided which
agent to address.

---

## Design decisions made up-front

These are calls I'd make if no one pushed back. Flagged so they can be
reverted before code lands.

1. **Drop `monitored_services.agent_id`** entirely. No "primary
   agent" denormalization — the join table is the single source of
   truth. Migration backfills existing non-null `agent_id` rows into
   the new join table, then drops the column.

2. **Auto-fix dispatcher picks the first online agent** from the
   service's bound agents. If none are online, the group lands as
   `missing_auth` (current behavior for missing-key services) plus a
   new reason `no_online_agent`. Round-robin or load-balanced
   strategies can come later.

3. **Per-service realtime command targeting**: when the platform
   picks an agent for a service-scoped command, the panel's UI
   surfaces the choice (which agent did the command go to?) in
   `ack`/`status` events. No new contract field — `agent_command_ack`
   already carries `agentId`.

4. **API shape**: keep `MonitoredService` returning a list field
   `agents: AgentBinding[]` rather than `agentIds: string[]`. The
   binding object can grow `priority`/`createdAt` without breaking
   the contract. For now `AgentBinding = { agentId: string }`.

5. **No backwards-compat shim**: `agentId` (singular) is removed from
   the contract. Web client and tests update in lockstep. Acceptable
   because there are no third-party consumers of the contracts
   package today.

If any of these are wrong, say so before Task 1 starts.

---

## Task 1: Database schema

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/queries.ts`
- Modify: `packages/db/test/schema.test.ts`
- Modify: `packages/db/test/queries.test.ts`

- [ ] **Step 1: Add the join table to `coreSchemaSql`.**
  ```sql
  create table if not exists agent_services (
    tenant_id text not null references tenants(id) on delete cascade,
    agent_id text not null references agents(id) on delete cascade,
    service_id text not null references monitored_services(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (agent_id, service_id)
  );

  create index if not exists agent_services_tenant_id_idx on agent_services(tenant_id);
  create index if not exists agent_services_service_id_idx on agent_services(service_id);
  ```
  Composite primary key prevents duplicate bindings; both single-side
  indexes support the common queries.

- [ ] **Step 2: Migrate existing data, then drop the column.**
  Add to `coreSchemaSql` after the `create table`:
  ```sql
  insert into agent_services (tenant_id, agent_id, service_id)
    select tenant_id, agent_id, id from monitored_services
    where agent_id is not null
    on conflict do nothing;

  alter table monitored_services drop column if exists agent_id cascade;
  ```
  The `if exists` keeps idempotency for envs that already migrated.

- [ ] **Step 3: New `queries.ts` functions.**
  - `attachServiceToAgent(query, tenantId, agentId, serviceId)` →
    `INSERT … ON CONFLICT DO NOTHING RETURNING *`. Returns boolean
    "was a new row created" so the route can distinguish "already
    bound" from "newly bound".
  - `detachServiceFromAgent(query, tenantId, agentId, serviceId)` →
    `DELETE … RETURNING agent_id` and reports whether a row matched.
  - `listAgentsForService(query, tenantId, serviceId)` → array of
    `{ agentId: string }`.
  - `listServicesForAgent(query, tenantId, agentId)` → array of
    `ServiceRow`. Replaces the old "filter `services` where
    `agentId === ?`" pattern in stores.

- [ ] **Step 4: Remove `agentId` from `ServiceRow`** and
  `createService` data shape. The mapped row no longer carries it.

- [ ] **Step 5: Tests.**
  - `schema.test.ts`: assert table + indexes + the migration `alter
    drop column` line.
  - `queries.test.ts`: cover attach idempotency, detach happy + miss,
    listAgentsForService for empty/some, listServicesForAgent.

---

## Task 2: Contracts

**Files:**
- Modify: `packages/contracts/src/http.ts`
- Modify: `packages/contracts/test/schemas.test.ts`
- Modify: `packages/contracts/scripts/generate-openapi.mjs`

- [ ] **Step 1: Schema changes.**
  ```ts
  export const agentBindingSchema = z.object({
    agentId: z.string()
  });

  export const monitoredServiceSchema = z.object({
    // ...existing...
    // remove: agentId
    agents: z.array(agentBindingSchema).default([])
  });

  export const createMonitoredServiceRequestSchema = z.object({
    name: z.string().min(1),
    gitRepoUrl: z.string().min(1),
    sshKeyId: z.string().nullable().optional(),
    branch: z.string().min(1),
    // remove: agentId
    agentIds: z.array(z.string()).default([]),
    dockerImage: z.string().min(1).optional(),
    composePath: z.string().min(1).optional()
  });

  export const updateMonitoredServiceRequestSchema = createMonitoredServiceRequestSchema.partial();
  ```
  `agents: AgentBinding[]` in the response (extensible). `agentIds`
  in the request (simpler for forms).

- [ ] **Step 2: New attach/detach request schemas.**
  ```ts
  export const attachServiceToAgentResponseSchema = z.object({
    bound: z.boolean(),
    agentId: z.string(),
    serviceId: z.string()
  });
  ```

- [ ] **Step 3: Remove agentRuntimeBackend dependents in this commit
  if any leaked back** (audit-only; the previous strip was thorough).

- [ ] **Step 4: Update the schema-validation tests** for the
  modified fields. Drop tests that asserted `agentId` shape.

- [ ] **Step 5: Update OpenAPI generator** to add the new endpoints
  (Task 4) and reflect the response shape.

---

## Task 3: API stores

**Files:**
- Modify: `apps/api/src/domainStore.ts`
- Modify: `apps/api/src/postgresDomainStore.ts`
- Modify: `apps/api/test/domainStore-memory.test.ts`
- Modify: `apps/api/test/postgresDomainStore.test.ts`

- [ ] **Step 1: Update `MonitoredService` runtime shape** to match
  the contract (`agents: AgentBinding[]`).

- [ ] **Step 2: New `DomainStore` methods.**
  ```ts
  attachServiceToAgent(tenantId, agentId, serviceId): Promise<boolean>;
  detachServiceFromAgent(tenantId, agentId, serviceId): Promise<boolean>;
  listAgentsForService(tenantId, serviceId): Promise<{ agentId: string }[]>;
  listServicesForAgent(tenantId, agentId): Promise<MonitoredService[]>;
  ```
  In-memory store: maintain a `Set<{agentId,serviceId}>` keyed by
  tenant. Postgres store delegates to `queries.ts`.

- [ ] **Step 3: Update `listServices` / `getService`** to populate
  the `agents` array from the join table (single SQL with a
  `LEFT JOIN agent_services` + array_agg, or two queries with a Map).
  Memory store: rebuild from the in-memory binding set.

- [ ] **Step 4: Update `createService`** to take an optional
  `agentIds` list and create rows in the join table after the
  service row commits. `updateService` accepts `agentIds` and does a
  full-replace (delete-not-in + insert-missing) inside a tx.

- [ ] **Step 5: Tests for both stores.**

---

## Task 4: API routes

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/test/domain-api.test.ts`
- Modify: `apps/api/src/autoFixDispatcher.ts`
- Modify: `apps/api/test/auto-fix.test.ts`

- [ ] **Step 1: Update existing service routes** to populate
  `agents`. Update `createService` POST and `updateService` PATCH to
  accept `agentIds`. Update the response shape.

- [ ] **Step 2: New attach/detach routes.**
  ```
  POST   /api/v1/agents/:agentId/services/:serviceId   → 200, returns AttachServiceToAgentResponse
  DELETE /api/v1/agents/:agentId/services/:serviceId   → 204 (or 404 if not bound)
  GET    /api/v1/agents/:agentId/services              → returns { services: MonitoredService[] }
  ```
  All scope-checked: agent and service must be in the session's
  tenant.

- [ ] **Step 3: Auto-fix dispatcher target selection.**
  ```ts
  // autoFixDispatcher.ts
  const bindings = service.agents ?? [];
  const onlineAgentId = bindings
    .map(b => b.agentId)
    .find(id => realtimeManager.isAgentOnline(id));
  if (!onlineAgentId) {
    deps.errorGroups.setStatus(group.id, "missing_auth");
    return { kind: "skipped_no_online_agent" };
  }
  // command.agentId = onlineAgentId
  ```
  Add a new `Outcome` kind `skipped_no_online_agent` to the dispatcher
  union and document it in `docs/agent/error-grouping.md`. Add a new
  `error_group_status` value if necessary (or reuse `missing_auth`
  with an updated message).

- [ ] **Step 4: Backward-compat note.** Old sessions that POST a
  service with `agentId` (singular) get a 400 with a clear message
  pointing at `agentIds`. Don't silently accept and discard.

- [ ] **Step 5: Tests.** Endpoint coverage on the three new routes,
  plus updated dispatcher tests for the new outcome.

---

## Task 5: Web client + UI

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/features/agents/AgentsPage.tsx`
- Modify: `apps/web/src/features/services/ServicesPage.tsx`
- Modify: `apps/web/test/agents-page.test.tsx`
- Modify: `apps/web/test/services-page.test.tsx`

- [ ] **Step 1: API client.**
  ```ts
  attachServiceToAgent(agentId, serviceId): Promise<{...}>;
  detachServiceFromAgent(agentId, serviceId): Promise<void>;
  listServicesForAgent(agentId): Promise<{ services: MonitoredService[] }>;
  ```
  Update `MonitoredService` type to use `agents: AgentBinding[]`.

- [ ] **Step 2: AgentsPage — services subsection.** When a row is
  expanded, render a `ServicesForAgentSection` next to
  `ErrorGroupsSection`. It lists currently-bound services and offers
  a "+ Bind service" picker (single-select for now; the user can
  bind several by adding one at a time). Each row has a "Detach"
  button. Both call the new endpoints and refetch.

- [ ] **Step 3: ServicesPage — agents multi-select.** Replace the
  single-agent dropdown with a multi-select. The form's submit
  passes `agentIds[]`. Show currently-bound agents on the row in the
  table.

- [ ] **Step 4: Empty-states + copy.** Agent row with no services →
  "No services bound. Click + to attach." Service with no agents →
  "Unbound — attach to one or more agents to receive logs."

- [ ] **Step 5: Tests.** Both page tests get a binding-flow test:
  click "+ Bind", pick a service, see it appear; click "Detach", see
  it disappear. Mock the api client.

---

## Task 6: Update existing kubernetes-runtime design doc

**Files:**
- Modify: `docs/superpowers/specs/2026-05-08-kubernetes-runtime-workload-discovery-design.md`

The recently-shipped design doc has an "Open question" about
multi-cluster bindings. Many-to-many makes that natural: each agent
in each cluster binds to the same service and tails its in-cluster
pods. Update the doc to mark that question resolved.

- [ ] One-liner amendment in the Open Questions section.

---

## Task 7: Docs

**Files:**
- Modify: `docs/reference/api.md`
- Modify: `docs/admin/api-credentials.md` (if it referenced agent
  binding)
- Possibly new: `docs/agent/binding-services.md`

- [ ] **Step 1: API reference** gets the three new endpoints and
  updated request/response shapes for create/update service.

- [ ] **Step 2: Drop a short doc explaining the binding model**
  (one service → many agents) for operators reading the panel.

- [ ] **Step 3: Cross-link** from the agent runtime docs.

---

## Order of operations

```
Task 1 (db) ──┬─→ Task 2 (contracts) ──→ Task 3 (stores) ──→ Task 4 (routes) ──→ Task 5 (UI)
              └─→ Task 6 (existing design doc amendment, anytime)

Task 7 (docs) ─→ runs after 4 lands, can parallelize with 5
```

Critical path is 1 → 2 → 3 → 4 → 5. Tasks 6 and 7 are independent.

---

## Acceptance criteria

The change is done when:

- [ ] `monitored_services.agent_id` is gone; the join table is the
  single source of truth.
- [ ] `MonitoredService.agents: AgentBinding[]` round-trips through
  contracts → store → API correctly.
- [ ] An admin can bind a service to two agents from either page
  (Agents row or Services form), and unbind it.
- [ ] Auto-fix dispatch picks an online agent from the bindings or
  reports `skipped_no_online_agent`.
- [ ] All existing tests pass; new tests cover the binding flows
  end-to-end.
- [ ] OpenAPI spec includes the three new endpoints.

## Cost

Roughly **1 day** for an engineer who knows the codebase. The risky
chunk is the migration (Task 1) on dev/prod databases that have
real services bound — the backfill INSERT must happen before the
DROP COLUMN, and a partial roll-forward leaves a half-state. The
schema change should land first as its own commit so a rollback is
clean.
