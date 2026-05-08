# Docs Refresh — May 2026

> Plan for closing documentation gaps and stale content discovered after the
> recent merge of: workflow-feature strip, per-service runtime drop,
> enrollment-tokens relocation, api_credentials backend, and the agent
> operator. The audit was tighter than expected because the
> `cursor/strip-workflows-c6cd` merge already deleted the workflow doc
> pages cleanly, so this is a focused refresh rather than a sweeping
> rewrite.

## Scope summary

| Category | Findings | Effort |
|---|---|---|
| Stale references in shipped docs | 1 line in `agent/install.md` | 2 min |
| New features undocumented | API credentials, error grouping + auto-fix | ~3 hours |
| OpenAPI spec drift | api-credentials + error-groups endpoints missing | ~1 hour |
| Cross-link breakage | none — strip-workflows merge cleaned it | 0 |

Total ~4 hours of focused work. No sweeping migration; we know exactly
what's broken and what's missing.

---

## Task 1: Fix the stale enrollment-token reference

**File:** `docs/agent/install.md` line 97

Currently says enrollment tokens are minted from **Settings**. That panel
moved to the Agents page in commit `ada567e`.

- [ ] Update the line to point at "Agents → Enrollment Tokens" and add a
  one-line note about the runtime selector tab.

This is the only stale reference found in shipped docs. The strip-workflows
merge already removed every other workflow-era doc page; cross-links
elsewhere are clean.

---

## Task 2: Document API credentials

**New file:** `docs/admin/api-credentials.md`

The endpoints exist (`POST/GET/DELETE /api/v1/admin/api-credentials`) and
are referenced inline in `agent/kubernetes.md` for the operator install
flow, but they have no first-class user-facing documentation. Anyone
building a non-operator integration (CI minting tokens, custom webhook
gateway, etc.) is out of luck.

Page should cover:

- [ ] **What they are**: long-lived bearer tokens for machine
  integrations. Distinct from session tokens (which expire). Distinct
  from enrollment tokens (which are single-use bootstrap credentials for
  agents).
- [ ] **Authentication model**: owner/admin sessions implicitly hold
  every scope; api-credential bearers must list each scope explicitly.
  The `hasScope()` helper is the gate.
- [ ] **Available scopes**: enumerate `enrollment-tokens.create` and
  `agents.read` with what each unlocks. Note that the scope set is
  intentionally narrow and grows by deliberate addition.
- [ ] **Mint / list / revoke** examples — owner session required for
  all three. API credentials cannot mint other API credentials (this is
  a privilege-escalation gate; mention it explicitly).
- [ ] **Token format**: `kop_<64-hex>`, hashed at rest, only returned
  once at creation time. Lost tokens require revocation + re-mint.
- [ ] **Rotation guidance**: tokens never expire automatically; treat
  long-lived credentials as a secret-management problem (rotate on
  schedule, revoke on personnel changes, store in cluster Secret /
  vault, never check into VCS).
- [ ] **Cross-link** from `docs/agent/kubernetes.md` (which currently
  has the operator-specific mint example inline — keep the example
  there, link to the full reference).

Place under `docs/admin/` because the existing `ux-voice.md` is the
only file there and a top-level page is overdue. Set `nav_order: 1`
on the new page.

**Exit criteria:** an admin reading only this page can mint a credential
for any documented scope, understand the rotation expectations, and find
the right curl invocations.

---

## Task 3: Document error grouping + auto-fix dispatch

**New file:** `docs/agent/error-grouping.md`

Major recent feature with zero user-facing documentation. The agent ships
`app_log_error` frames; the API normalizes / fingerprints / dedupes them
into error groups; the dispatcher decides which groups become auto-fix
runs against the configured plan executor; the panel renders them on the
Agents page.

Page should cover:

- [ ] **What you see in the UI**: ErrorGroupsSection on the Agents page,
  per-tenant / per-agent / per-service views. Status enum (open, fixing,
  fixed, paused, missing_auth) with one-sentence semantics each.
- [ ] **How groups are formed**: fingerprinting strategy (normalized
  message → hash). Note that this is intentionally noisy on purpose —
  identical exceptions from different code paths group together; the
  "context lines" payload disambiguates in the UI.
- [ ] **How auto-fix is dispatched**: trigger conditions (new group OR
  status `open`), eligibility checks (`isProbablyUserInputError` skip,
  `missing_auth` when SSH key isn't set), the `run_fix_plan` realtime
  command, the configured plan executor (cursor / claude). Reference
  `apps/api/src/autoFixDispatcher.ts` for ground truth.
- [ ] **Lifecycle**: open → fixing (after dispatch) → fixed (after
  successful commit) → re-opens on the next matching error.
- [ ] **API endpoints**: `GET /api/v1/error-groups`,
  `GET /api/v1/agents/:agentId/error-groups`,
  `GET /api/v1/services/:id/error-groups`. Set status manually:
  `POST /api/v1/error-groups/:id/status` (verify route exists; if not,
  document as a gap).
- [ ] **Realtime broadcast**: the `error_group_updated` UI telemetry
  event is what powers live status flips on the Agents page.
- [ ] **Privacy / safety**: error messages and context lines are stored
  per tenant; flag what data leaves the host (the answer is: the lines
  the agent classifies as errors).
- [ ] **Disabling auto-fix**: how to mark a group as `paused` so the
  dispatcher skips it. (Confirm the route exists; if it's UI-only,
  document the UI flow.)

Place under `docs/agent/` next to `runtimes.md`. Set `nav_order: 5`.

**Exit criteria:** an operator can answer "why did this error group
auto-create a PR?" without reading source code.

---

## Task 4: Bring `docs/reference/api.md` in sync

**File:** `docs/reference/api.md`

Add sections (preserve existing route-table style):

- [ ] **Admin / API credentials** — three endpoints + scope gating note.
- [ ] **Error groups** — three list endpoints, status-update endpoint
  (if it exists), realtime event payload reference.
- [ ] Remove any stragglers referencing `/api/v1/services/:id/workflow`
  or `/api/v1/workflows/*` if found (audit said no, but double-check
  while editing).
- [ ] Cross-link the new dedicated pages (Task 2 and Task 3) at the top
  of each section so the reference doesn't have to duplicate the
  conceptual material.

**Exit criteria:** the route table matches `apps/api/src/server.ts`
modulo formatting. No phantom routes, no missing real ones.

---

## Task 5: Regenerate / hand-edit the OpenAPI spec

**File:** `packages/contracts/openapi/openapi.yaml`

The spec is a meaningful artifact (it drives any generated client). It
currently lacks the api-credentials and error-groups endpoints; it may
also still describe workflow endpoints (audit didn't confirm because the
file is outside `docs/`).

- [ ] Confirm whether the OpenAPI spec is **generated** from contracts
  Zod schemas (`packages/contracts/scripts/generate-openapi.mjs` exists)
  or **hand-maintained**. If generated, the fix is to add the missing
  schemas to the generator inputs.
- [ ] Add the api-credentials endpoints + schemas
  (`apiCredentialMetadataSchema`, `createApiCredentialRequestSchema`,
  `createApiCredentialResponseSchema`, `listApiCredentialsResponseSchema`
  already exist in `packages/contracts/src/http.ts` — wire them into
  the OpenAPI generator).
- [ ] Add the error-groups endpoints. Schemas may need to be authored
  if `errorGrouping.ts` defines them ad-hoc rather than via the
  `@sm/contracts` package. Probably worth promoting them into
  `@sm/contracts` while we're here.
- [ ] Drop any remaining workflow-era schemas if the generator still
  emits them.
- [ ] Run `pnpm --filter @sm/contracts run generate:openapi` and commit
  the regenerated YAML.

**Exit criteria:** `openapi.yaml` validates and round-trips through a
generator without phantom or missing routes.

---

## Out of scope

- A general docs IA refresh (sidebar reorganization, theme overhaul) —
  separate concern, not driven by recent changes.
- A docs site CI check that fails on broken cross-links — useful but
  this plan's scope is content, not tooling. Note for a follow-up.
- Migrating the GitHub-App page to a generic-Git story. The audit
  flagged its "workflow" references as acceptable (they refer to GitHub
  Actions `workflow_dispatch`, not Kaiad's removed workflow feature),
  but the page as a whole describes the App-installation flow that was
  partially replaced by SSH keys. Genuine work but separate from this
  refresh.

---

## Order of operations

1. **Task 1** is trivial (one line) — land first.
2. **Tasks 2 + 3** can go in parallel (independent pages).
3. **Task 4** depends on 2 and 3 because the reference page should
   cross-link to them.
4. **Task 5** is the last polish — it codifies what the previous tasks
   already documented in prose.

Suggested commit boundaries: one per task. Total ~5 commits, ~4 hours.

---

## Acceptance criteria

The refresh is done when:

- [ ] No mentions of "Settings → Enrollment Tokens" remain in
  shipped docs.
- [ ] An admin can find authoritative documentation for **API credentials**
  by following the docs nav (no source-diving required).
- [ ] An operator can understand the **error grouping + auto-fix loop**
  without reading `autoFixDispatcher.ts`.
- [ ] `docs/reference/api.md` route table matches the routes in
  `apps/api/src/server.ts`.
- [ ] `packages/contracts/openapi/openapi.yaml` reflects the same
  routes (or, if regeneration uncovers a deeper drift, that drift is
  flagged in a follow-up).
