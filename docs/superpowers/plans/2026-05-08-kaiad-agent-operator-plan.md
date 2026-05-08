# Kaiad Agent Operator Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to work this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. See the design doc at `docs/superpowers/specs/2026-05-08-kaiad-agent-operator-design.md` for the architectural rationale.

**Goal:** Ship an MVP Kubernetes operator that reconciles a `KaiadAgent` CRD into a running agent Deployment, replacing the manual paste-the-start-command flow for k8s installs while leaving it intact for VMs and bare metal.

**Architecture:** New module at `deploy/operator/` (kubebuilder layout). Operator owns the agent's pod-side lifecycle (Deployment, ServiceAccount, scoped RBAC, enrollment Secret). Agent runs in `kubernetes` runtime backend and manages workload Deployments via the kube API. New API scope `enrollment-tokens.create` lets the operator mint short-TTL bootstrap tokens on demand.

**Tech Stack:** Go (controller-runtime / kubebuilder), Postgres (existing), Fastify (existing), React (existing), Helm.

---

### Task 1: Backend — operator API credential & scope

The operator needs a long-lived bearer token with permission to mint enrollment tokens. Today's auth model is session-based; we add a new credential type.

**Files:**
- Modify: `packages/db/src/schema.ts`
- Modify: `packages/db/src/queries.ts`
- Modify: `apps/api/src/auth.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `packages/contracts/src/http.ts`

- [ ] **Step 1: Write failing tests**
  - `packages/db/test/schema.test.ts`: assert `api_credentials` table exists with `id`, `tenant_id`, `name`, `token_hash`, `scopes` (text[]), `created_at`, `last_used_at`, `revoked_at`.
  - `apps/api/test/auth.test.ts`: assert `resolveSession` accepts a bearer token matching an `api_credentials` row, populates `session.scopes`, rejects revoked rows.
  - `apps/api/test/api-credentials.test.ts` (new): `POST /api/v1/admin/api-credentials` mints a credential, `DELETE` revokes it, listing redacts the secret.

- [ ] **Step 2: Add `api_credentials` table**
  ```sql
  create table if not exists api_credentials (
    id text primary key,
    tenant_id text not null references tenants(id) on delete cascade,
    name text not null,
    token_hash text not null,
    scopes text[] not null default '{}',
    created_at timestamptz not null default now(),
    created_by text,
    last_used_at timestamptz,
    revoked_at timestamptz
  );
  create index if not exists api_credentials_tenant_id_idx on api_credentials(tenant_id);
  create unique index if not exists api_credentials_token_hash_idx on api_credentials(token_hash);
  ```

- [ ] **Step 3: Extend `resolveSession`**
  - If `Authorization: Bearer <token>` doesn't match a session, fall through to `api_credentials` lookup (constant-time hash compare).
  - On match, return a `SessionInfo` with `kind: "apiCredential"`, the row's scopes, and tenant id. Update `last_used_at` async.
  - Reject if `revoked_at` is set.

- [ ] **Step 4: Add `requireScope(scope: string)` helper**
  - Routes that previously checked `session.role` for admin gating now use `requireScope("enrollment-tokens.create")` for the operator path. Owner/admin sessions implicitly hold all scopes.

- [ ] **Step 5: Admin endpoints**
  - `POST /api/v1/admin/api-credentials` (owner-only): body `{ name, scopes: ["enrollment-tokens.create"] }`. Returns the bearer once. Stores hash.
  - `GET /api/v1/admin/api-credentials`: list (no secret).
  - `DELETE /api/v1/admin/api-credentials/:id`: sets `revoked_at`.

- [ ] **Step 6: Gate enrollment-tokens.create**
  - Modify `POST /api/v1/agents/enrollment-tokens` to accept either an admin/owner session **or** a credential with the `enrollment-tokens.create` scope. Default TTL clamp stays.

- [ ] **Step 7: Run tests and OpenAPI**
  ```bash
  pnpm --filter @sm/db test -- --run
  pnpm --filter @sm/api test -- --run
  pnpm --filter @sm/contracts run generate:openapi
  ```

- [ ] **Step 8: Commit**
  ```bash
  git add packages/db packages/contracts apps/api
  git commit -m "feat(api): add api_credentials with scopes, gate enrollment-token mint by scope"
  ```

---

### Task 2: Operator scaffolding

**Files (all new):**
- Create: `deploy/operator/go.mod`
- Create: `deploy/operator/cmd/manager/main.go`
- Create: `deploy/operator/PROJECT` (kubebuilder marker)
- Create: `deploy/operator/Dockerfile`
- Create: `deploy/operator/Makefile`
- Create: `deploy/operator/README.md`
- Create: `deploy/operator/.dockerignore`

- [ ] **Step 1: Initialize the module**
  ```bash
  mkdir -p deploy/operator && cd deploy/operator
  go mod init github.com/innkeeperdevops/kaiad/operator
  go get sigs.k8s.io/controller-runtime@latest
  go get k8s.io/api@latest k8s.io/apimachinery@latest k8s.io/client-go@latest
  ```

- [ ] **Step 2: Manager bootstrap**
  - `cmd/manager/main.go`: standard controller-runtime manager, leader election on, metrics on `:8080`, healthz/readyz on `:8081`.
  - Reads operator config from env: `KAIAD_API_BASE_URL`, `KAIAD_API_CREDENTIAL` (mounted from Secret), `KAIAD_OPERATOR_NAMESPACE`.

- [ ] **Step 3: Multi-stage Dockerfile**
  - Build with golang:1.22, copy in `deploy/operator` + `apps/agent` (no — operator is independent of agent code; only needs its module).
  - Produce a static binary; final stage `gcr.io/distroless/static:nonroot`.

- [ ] **Step 4: Makefile targets**
  - `make build`, `make docker-build IMG=...`, `make manifests` (CRD + RBAC YAML), `make generate` (deepcopy), `make test`.

- [ ] **Step 5: Verify it builds and runs against `kind`**
  ```bash
  kind create cluster --name kaiad-op-dev
  make docker-build IMG=kaiad-operator:dev
  kind load docker-image kaiad-operator:dev --name kaiad-op-dev
  ```

- [ ] **Step 6: Commit**
  ```bash
  git add deploy/operator
  git commit -m "chore(operator): scaffold operator module with kubebuilder layout"
  ```

---

### Task 3: `KaiadAgent` CRD types

**Files:**
- Create: `deploy/operator/api/v1alpha1/groupversion_info.go`
- Create: `deploy/operator/api/v1alpha1/kaiadagent_types.go`
- Create: `deploy/operator/api/v1alpha1/zz_generated_deepcopy.go` (generated)
- Create: `deploy/operator/config/crd/bases/kaiad.dev_kaiadagents.yaml` (generated)

- [ ] **Step 1: Write failing tests**
  - `deploy/operator/api/v1alpha1/types_test.go`: round-trip a sample `KaiadAgent` through JSON, assert required fields surface validation errors when missing.

- [ ] **Step 2: Define the spec**
  ```go
  type KaiadAgentSpec struct {
      ControlPlane ControlPlaneSpec `json:"controlPlane"`
      Enrollment   EnrollmentSpec   `json:"enrollment"`
      ServiceID    string           `json:"serviceId,omitempty"`
      Image        string           `json:"image"`
      Resources    *corev1.ResourceRequirements `json:"resources,omitempty"`
      NodeSelector map[string]string `json:"nodeSelector,omitempty"`
      Tolerations  []corev1.Toleration `json:"tolerations,omitempty"`
      Manages      []ManagesRule    `json:"manages,omitempty"`
  }

  type ControlPlaneSpec struct {
      RealtimeURL string `json:"realtimeUrl"`
  }

  type EnrollmentSpec struct {
      SecretRef *SecretKeyRef `json:"secretRef,omitempty"`
      AutoMint  bool          `json:"autoMint,omitempty"`
  }

  type ManagesRule struct {
      APIGroups         []string                  `json:"apiGroups"`
      Resources         []string                  `json:"resources"`
      Verbs             []string                  `json:"verbs"`
      NamespaceSelector *metav1.LabelSelector     `json:"namespaceSelector,omitempty"`
  }
  ```
  - Add `+kubebuilder:validation:` markers for required fields, enums, etc.
  - `KaiadAgentStatus` with `Conditions`, `EnrolledAgentID`, `ObservedGeneration`, `DeploymentName`.

- [ ] **Step 3: Generate deepcopy + CRD manifest**
  ```bash
  make generate manifests
  ```

- [ ] **Step 4: Validate the generated CRD against `kind`**
  ```bash
  kubectl apply -f config/crd/bases/kaiad.dev_kaiadagents.yaml
  kubectl apply -f config/samples/v1alpha1_kaiadagent.yaml  # should be accepted
  kubectl apply -f config/samples/v1alpha1_kaiadagent_invalid.yaml  # should be rejected
  ```

- [ ] **Step 5: Commit**
  ```bash
  git add deploy/operator/api deploy/operator/config/crd
  git commit -m "feat(operator): define KaiadAgent v1alpha1 CRD"
  ```

---

### Task 4: RBAC generator

The trickiest correctness-sensitive piece. `spec.manages` → `Role`/`ClusterRole` + binding.

**Files:**
- Create: `deploy/operator/internal/controller/rbac.go`
- Create: `deploy/operator/internal/controller/rbac_test.go`
- Create: `deploy/operator/internal/controller/allowlist.go`

- [ ] **Step 1: Write failing tests**
  - `rbac_test.go` table-driven:
    - Single rule, namespace-scoped → produces `Role` per namespace matching selector + `RoleBinding`.
    - Cluster-wide rule (no `namespaceSelector`) → produces `ClusterRole` + `ClusterRoleBinding`.
    - Verbs/resources outside the allow-list → returns error before generating anything.
    - Empty `manages` → produces no RBAC objects, agent SA has no permissions.

- [ ] **Step 2: Allow-list**
  ```go
  // allowlist.go
  var allowedRBAC = map[string]map[string][]string{
      "apps": {
          "deployments":  {"get", "list", "watch", "patch", "update"},
          "statefulsets": {"get", "list", "watch", "patch", "update"},
      },
      "": { // core
          "pods":      {"get", "list", "watch"},
          "pods/log":  {"get", "list", "watch"},
          "events":    {"get", "list", "watch", "create"},
      },
      "batch": {
          "jobs":     {"get", "list", "watch", "create", "delete"},
      },
  }
  ```
  - `validateManages(rules []ManagesRule) error` rejects anything outside this map. Specifically reject `secrets`, `*`, `clusterroles`, `clusterrolebindings`.

- [ ] **Step 3: Generator**
  - `generateRBAC(agent KaiadAgent) (objects []client.Object, err error)`.
  - Each `ManagesRule` with a `namespaceSelector` resolves to one `Role` per matching namespace + matching `RoleBinding` to the agent SA.
  - Each `ManagesRule` without a selector becomes a `ClusterRole` + `ClusterRoleBinding`.
  - All objects get owner refs to the `KaiadAgent` CR.

- [ ] **Step 4: Watch namespace label changes**
  - Reconciler watches `Namespace` events; when a namespace gains/loses a label that matches any agent's `namespaceSelector`, re-reconcile that agent so RBAC objects are added/removed.

- [ ] **Step 5: Commit**
  ```bash
  git add deploy/operator/internal/controller/rbac.go deploy/operator/internal/controller/rbac_test.go deploy/operator/internal/controller/allowlist.go
  git commit -m "feat(operator): RBAC generator from KaiadAgent.spec.manages with allow-list"
  ```

---

### Task 5: Enrollment token client

Operator-side HTTP client that talks to the Kaiad API to mint tokens.

**Files:**
- Create: `deploy/operator/internal/kaiad/client.go`
- Create: `deploy/operator/internal/kaiad/client_test.go`
- Create: `deploy/operator/internal/controller/enrollment.go`

- [ ] **Step 1: Write failing tests**
  - `client_test.go` (httptest server): `MintEnrollmentToken(ttl)` returns `{token, expiresAt, agentId}`, retries on 5xx, surfaces 4xx.
  - `enrollment_test.go`: given a `KaiadAgent` with `autoMint: true`, the operator (a) creates a Secret if absent, (b) skips if the Secret already has a token, (c) clears the bootstrap Secret after `Ready=True`.

- [ ] **Step 2: HTTP client**
  - `NewClient(baseURL, bearer string) *Client` — small wrapper with retry/backoff (3 attempts).
  - One method: `MintEnrollmentToken(ctx, ttlSeconds int) (Token, error)`.

- [ ] **Step 3: Reconciler integration**
  - In `enrollment.go`: `materializeBootstrapSecret(ctx, agent)` resolves the Secret. If `autoMint` and Secret missing, mint and create. Owner ref to the CR.
  - After agent reports `Ready=True` (see Task 7), clear the bootstrap token to prevent reuse.

- [ ] **Step 4: Commit**
  ```bash
  git add deploy/operator/internal/kaiad deploy/operator/internal/controller/enrollment.go
  git commit -m "feat(operator): mint enrollment tokens via Kaiad API on reconcile"
  ```

---

### Task 6: Reconciler

The main controller loop.

**Files:**
- Create: `deploy/operator/internal/controller/kaiadagent_controller.go`
- Create: `deploy/operator/internal/controller/kaiadagent_controller_test.go`
- Modify: `deploy/operator/cmd/manager/main.go`

- [ ] **Step 1: Write failing envtest**
  - Use `envtest` (kubebuilder testing framework). Spin up a test apiserver, install the CRD, create a `KaiadAgent`, assert:
    - A `Deployment` is created with the right env vars.
    - A `ServiceAccount` is created.
    - `Role`/`RoleBinding` matches `spec.manages`.
    - Updating `spec.image` triggers a Deployment patch.
    - Deleting the CR garbage-collects everything (owner refs).

- [ ] **Step 2: Reconcile function**
  - `Reconcile(ctx, req)`:
    1. Fetch CR; return if not found.
    2. Validate `spec.manages` against allow-list (Task 4); set `Ready=False, Reason=InvalidSpec` and return if violated.
    3. Materialize bootstrap Secret (Task 5).
    4. Generate RBAC (Task 4) and apply.
    5. Build target Deployment spec; apply (server-side apply).
    6. Update status (`ObservedGeneration`, `DeploymentName`, conditions).

- [ ] **Step 3: Deployment template**
  - 1 replica, agent image from `spec.image`.
  - Env: `SM_REALTIME_URL`, `SM_AGENT_RUNTIME_OVERRIDE=kubernetes`, `SM_AGENT_PERSIST_CREDENTIALS=1`, `SM_SERVICE_ID` if set.
  - `SM_ENROLLMENT_TOKEN` from `valueFrom.secretKeyRef`.
  - Volume mount for the persisted credential (emptyDir is fine for MVP; users wanting durability can override).
  - SA = the one we generated.

- [ ] **Step 4: Wire into main**
  - Register the controller in `cmd/manager/main.go`. Add `Watches` for `Namespace` (for selector changes) and `Deployment` (for status).

- [ ] **Step 5: Commit**
  ```bash
  git add deploy/operator/internal/controller/kaiadagent_controller.go deploy/operator/cmd/manager/main.go
  git commit -m "feat(operator): KaiadAgent reconciler with RBAC, enrollment, and Deployment"
  ```

---

### Task 7: Status from agent connection

The CR's `Ready` condition should reflect that the agent is actually checked in with the control plane, not just that the pod is running.

**Files:**
- Modify: `deploy/operator/internal/controller/kaiadagent_controller.go`
- Modify: `deploy/operator/internal/kaiad/client.go`

- [ ] **Step 1: Add `GetAgent(ctx, agentId)`** to the Kaiad client. Returns 404 if not yet enrolled.

- [ ] **Step 2: After mint, the response includes the future `agentId`** — store it in `status.enrolledAgentID`.

- [ ] **Step 3: Periodic status poll**
  - Reconciler requeues every 30s while `Ready=False`. If `Deployment.status.readyReplicas >= 1` AND `GetAgent(enrolledAgentID).status == "online"`, flip `Ready=True`.
  - Once `Ready=True`, requeue every 5min for drift detection.

- [ ] **Step 4: Tests**
  - Mock the Kaiad client; envtest asserts the condition flips correctly given different responses.

- [ ] **Step 5: Commit**
  ```bash
  git add deploy/operator
  git commit -m "feat(operator): drive Ready condition from agent online status"
  ```

---

### Task 8: Helm chart

**Files (all new):**
- Create: `deploy/operator/charts/kaiad-operator/Chart.yaml`
- Create: `deploy/operator/charts/kaiad-operator/values.yaml`
- Create: `deploy/operator/charts/kaiad-operator/templates/deployment.yaml`
- Create: `deploy/operator/charts/kaiad-operator/templates/serviceaccount.yaml`
- Create: `deploy/operator/charts/kaiad-operator/templates/clusterrole.yaml` (operator's own RBAC)
- Create: `deploy/operator/charts/kaiad-operator/templates/clusterrolebinding.yaml`
- Create: `deploy/operator/charts/kaiad-operator/templates/credentials-secret.yaml`
- Create: `deploy/operator/charts/kaiad-operator/templates/crd.yaml` (or use crds/ directory)
- Create: `deploy/operator/charts/kaiad-operator/templates/_helpers.tpl`

- [ ] **Step 1: Chart skeleton**
  ```yaml
  # Chart.yaml
  apiVersion: v2
  name: kaiad-operator
  version: 0.1.0
  appVersion: "0.1.0"
  description: Operator for the Kaiad agent
  ```

- [ ] **Step 2: values.yaml**
  - `image.repository`, `image.tag`, `image.pullPolicy`
  - `kaiad.apiBaseURL` (required), `kaiad.apiCredentialSecret.create` (bool), `kaiad.apiCredentialSecret.name`, `kaiad.apiCredentialSecret.value` (only used if `create: true`)
  - `resources`, `nodeSelector`, `tolerations`, `replicaCount: 1`

- [ ] **Step 3: Operator's own ClusterRole**
  - Verbs to manage `KaiadAgent` (read/watch/patch status), and to create/patch/delete `Deployment`, `ServiceAccount`, `Role`, `RoleBinding`, `Secret` cluster-wide.
  - Namespace `Role`s are NOT used here (operator must be cluster-scoped to install agents in arbitrary namespaces).

- [ ] **Step 4: CRD installation**
  - Place CRD YAML in `charts/kaiad-operator/crds/` (Helm convention — installed before templates, never templated).

- [ ] **Step 5: Lint and template**
  ```bash
  helm lint deploy/operator/charts/kaiad-operator
  helm template kaiad-operator deploy/operator/charts/kaiad-operator -f deploy/operator/charts/kaiad-operator/values.yaml
  ```

- [ ] **Step 6: Smoke test on `kind`**
  ```bash
  helm install kaiad-operator deploy/operator/charts/kaiad-operator \
    --set image.tag=dev \
    --set kaiad.apiBaseURL=http://host.docker.internal:3000 \
    --set kaiad.apiCredentialSecret.create=true \
    --set kaiad.apiCredentialSecret.value=$(echo -n "kaiad-cred-test" | base64)
  kubectl apply -f deploy/operator/config/samples/v1alpha1_kaiadagent.yaml
  kubectl get kaiadagents -A
  ```

- [ ] **Step 7: Commit**
  ```bash
  git add deploy/operator/charts
  git commit -m "feat(operator): Helm chart for installing the operator"
  ```

---

### Task 9: AgentsPage UI — Kubernetes install tab

**Files:**
- Modify: `apps/web/src/features/agents/EnrollmentTokensPanel.tsx`
- Create: `apps/web/src/features/agents/KubernetesInstallTab.tsx`
- Modify: `apps/web/test/enrollment-tokens-panel.test.tsx`

- [ ] **Step 1: Write failing tests**
  - `enrollment-tokens-panel.test.tsx`: switching to a "Kubernetes" tab renders a YAML block for `KaiadAgent`, populated with the user's selected service id.

- [ ] **Step 2: Tab UI**
  - Add a tabbed split inside the panel: "Linux/VM (start command)" — current behavior — and "Kubernetes (KaiadAgent CR)".
  - The k8s tab does NOT mint a token (the operator does that). It shows a copy-able YAML and links to the Helm install command.

- [ ] **Step 3: YAML generator**
  - `buildKaiadAgentManifest({ realtimeUrl, serviceId, image, namespace })` returns the YAML. Pure function, easy to unit-test.

- [ ] **Step 4: Run web tests, redeploy dev**
  ```bash
  pnpm --filter @sm/web test -- --run
  sudo docker compose -f env/dev/docker-compose.yml up -d --build
  ```

- [ ] **Step 5: Commit**
  ```bash
  git add apps/web/src/features/agents apps/web/test/enrollment-tokens-panel.test.tsx
  git commit -m "feat(web): add Kubernetes install tab to enrollment panel"
  ```

---

### Task 10: Docs

**Files:**
- Create: `docs/agent/kubernetes.md` (install via operator)
- Modify: `docs/agent/install.md` (add a pointer at the top)
- Modify: `docs/index.md` (mention the operator path under "Install")

- [ ] **Step 1: `docs/agent/kubernetes.md`**
  - Prereqs (cluster admin access, Helm, the API base URL).
  - Install operator (Helm command).
  - Mint an operator API credential (`POST /api/v1/admin/api-credentials`) and put it in the chart values.
  - Apply a `KaiadAgent` CR (sample YAML).
  - Verify (`kubectl get kaiadagents`, panel shows agent online).
  - Troubleshooting (CRD validation errors, RBAC allow-list rejections, mint failures).

- [ ] **Step 2: Cross-links**
  - From `docs/agent/install.md`: add a top-of-page note pointing Kubernetes users to the new doc.
  - From `docs/index.md`: include the new doc in the install section.

- [ ] **Step 3: Commit**
  ```bash
  git add docs/agent/kubernetes.md docs/agent/install.md docs/index.md
  git commit -m "docs: install Kaiad agent on Kubernetes via operator"
  ```

---

### Task 11: End-to-end test on `kind`

A real cluster smoke test that exercises the whole flow.

**Files:**
- Create: `deploy/operator/test/e2e/install_test.sh`
- Create: `deploy/operator/test/e2e/README.md`
- Modify: `.github/workflows/operator-e2e.yml` (new CI job)

- [ ] **Step 1: Bash-driven e2e**
  - Spin up `kind`.
  - Boot the Kaiad API (the dev compose stack on the host, exposed via `host.docker.internal`).
  - Mint an operator API credential against the API.
  - `helm install` the operator chart with the credential.
  - `kubectl apply` a sample `KaiadAgent`.
  - Poll `kubectl get kaiadagent -o jsonpath='{.status.conditions}'` until `Ready=True` (timeout 3min).
  - `curl` the Kaiad API to confirm the agent is listed and `status: online`.
  - Tear down `kind`.

- [ ] **Step 2: GitHub Actions job**
  - Triggered on changes under `deploy/operator/**` and on PRs touching agent enrollment.
  - Uses `helm/kind-action` for the cluster.

- [ ] **Step 3: Commit**
  ```bash
  git add deploy/operator/test .github/workflows/operator-e2e.yml
  git commit -m "test(operator): e2e install + enrollment on kind"
  ```

---

### Task 12: Release plumbing

**Files:**
- Modify: `.github/workflows/go-release.yml` (add operator binary)
- Modify: `.github/workflows/docker-publish.yml` (or create) — operator image
- Modify: `Makefile` at repo root (add operator passthroughs)

- [ ] **Step 1: Build the operator image in CI**
  - Tag with the same `vX.Y.Z` as the agent. Push to `ghcr.io/innkeeperdevops/kaiad-operator`.

- [ ] **Step 2: Publish the Helm chart**
  - On tagged release, push the chart to `oci://ghcr.io/innkeeperdevops/charts/kaiad-operator`.

- [ ] **Step 3: Add operator + chart to release notes generator**

- [ ] **Step 4: Commit**
  ```bash
  git add .github Makefile
  git commit -m "ci: build and publish operator image and Helm chart on release"
  ```

---

## Out of scope (deferred to a follow-up plan)

- **`KaiadService` CRD** that reconciles into a workload Deployment. Once we have the operator, the next obvious step is letting users describe the workload declaratively too — but that's a separate feature with its own design doc.
- **Webhook validation/defaulting**. The OpenAPI validation in the CRD is sufficient for v1alpha1. A validating webhook would catch e.g. cross-field invariants but isn't required for MVP.
- **Multi-tenant clusters**. Today the operator is configured with a single API credential, which carries a single tenant. Multi-tenant clusters would need the operator to either (a) read tenant from CR metadata and use multiple credentials, or (b) issue per-tenant tokens. Not in MVP.
- **OLM (OperatorHub) packaging**. Helm is sufficient for now.

## Order of operations / dependencies

```
Task 1 (backend scopes) ──┐
                          ├─→ Task 5 (token mint client) ─┐
Task 2 (scaffolding) ─────┤                                ├─→ Task 6 (reconciler) ─→ Task 7 (status) ─→ Task 11 (e2e)
                          ├─→ Task 3 (CRD types) ──────────┤
                          └─→ Task 4 (RBAC gen) ───────────┘

Task 6 ─→ Task 8 (Helm)
Task 6 ─→ Task 9 (UI tab)
All ─→ Task 10 (docs) ─→ Task 12 (release)
```

Tasks 1–7 are the critical path. Tasks 8–12 can be parallelized once the reconciler is working in envtest.

## Acceptance criteria

The MVP is done when:

1. `helm install kaiad-operator …` succeeds on a fresh `kind` cluster.
2. `kubectl apply` of a sample `KaiadAgent` results in:
   - A running agent Deployment with the right env wiring,
   - A scoped ServiceAccount + Role/RoleBinding matching `spec.manages`,
   - The agent appearing online in the Kaiad panel within 60 seconds,
   - `kubectl get kaiadagent` showing `Ready=True`.
3. Deleting the `KaiadAgent` CR garbage-collects the Deployment, SA, and RBAC objects.
4. The web panel offers both install paths (start command and `KaiadAgent` YAML) without regression.
5. CI runs the e2e smoke test on PRs that touch operator code.
