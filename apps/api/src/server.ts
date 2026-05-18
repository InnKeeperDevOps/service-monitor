import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bootstrapEnv, getDataDir, isSetupRequired } from "./bootstrapEnv.js";
import { setupRoutes, type SetupCompleteCallback } from "./setupRoutes.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  agentCommandJobSchema,
  agentToPlatformMessageSchema,
  apiErrorSchema,
  createEnrollmentTokenRequestSchema,
  createEnrollmentTokenResponseSchema,
  createMonitoredServiceRequestSchema,
  createSshKeyRequestSchema,
  listSshKeysResponseSchema,
  healthResponseSchema,
  listAgentsResponseSchema,
  updateAgentRequestSchema,
  hostStatsSchema,
  appStatsSchema,
  uiTelemetryEventSchema,
  type AgentTelemetry,
  type AgentAppTelemetry,
  listEnrollmentTokensResponseSchema,
  listIncidentsResponseSchema,
  listAuthProvidersResponseSchema,
  meResponseSchema,
  createTenantRequestSchema,
  switchActiveTenantRequestSchema,
  oauthAuthorizeResponseSchema,
  oauthCallbackResponseSchema,
  updateIncidentStatusRequestSchema,
  updateMonitoredServiceRequestSchema,
  upsertTenantSettingsRequestSchema,
  agentCommandDispatchResponseSchema,
  platformToAgentMessageSchema,
  apiCredentialMetadataSchema,
  createApiCredentialRequestSchema,
  createApiCredentialResponseSchema,
  listApiCredentialsResponseSchema,
  attachServiceToAgentResponseSchema,
  listServicesForAgentResponseSchema,
  type AgentToPlatformMessage,
  type AgentCommandJob,
  type LogIngestionJob,
  type TenantSettings,
  parsePipelineYaml,
  selectPipeline,
  resolveEnvironment
} from "@sm/contracts";
import { correlationIdPlugin } from "./correlationId.js";
import {
  loginWithDiagnostics,
  resolveSession,
  generateSessionToken,
  hashToken,
  hasScope,
  type AuthStore,
  type LoginTraceStep,
  type SessionInfo
} from "./auth.js";
import {
  createApiCredentialForTenant,
  listApiCredentialsForTenant,
  revokeApiCredentialForTenant
} from "./apiCredentialsStore.js";
import {
  addOAuthProvider,
  buildAuthorizeUrl,
  consumeState,
  exchangeCodeForToken,
  fetchUserInfo,
  generateState,
  getOAuthProvider,
  listProviders,
  seedGoogleProviderFromEnv,
  type OAuthProviderConfig
} from "./oauth.js";
import { createMemoryDomainStore, type DomainStore } from "./domainStore.js";
import { createPostgresDomainStore } from "./postgresDomainStore.js";
import { resolveTenantStoreBackend } from "./storeAdapter.js";
import {
  createEnrollmentTokenForTenant,
  deactivateEnrollmentTokenForTenant,
  deleteEnrollmentTokenForTenant,
  listEnrollmentTokensForTenant,
  peekEnrollmentToken,
  validateEnrollmentToken
} from "./enrollmentStore.js";
import {
  ensureRegistryAuth,
  filterAllowedActions,
  parseScopes,
  signRegistryToken,
  type RegistryAccess,
  type RegistryAuthConfig
} from "@sm/registry-auth";
import {
  deleteTag as registryDeleteTag,
  listRepositories as registryListRepositories,
  listTags as registryListTags
} from "./registry/admin.js";
import { registerRegistryRoutes } from "./registry/routes.js";
import { createMemoryAuthStore, seedDevUser } from "./memoryAuthStore.js";
import { createPostgresAuthStore } from "./postgresAuthStore.js";
import { readConfig, writeConfig, type KaiadConfig } from "./configPersistence.js";
import { enforcePolicy } from "./policy.js";
import { createReadinessCheckersFromEnv, type ReadinessChecker } from "./readyChecks.js";
import { RealtimeManager, type PendingCommandRedis } from "./realtimeManager.js";
import { ErrorGroupStore, isProbablyUserInputError } from "./errorGrouping.js";
import { dispatchAutoFix } from "./autoFixDispatcher.js";
import {
  getTenantSettings,
  upsertTenantSettings
} from "./store.js";
import { createNamedQueue, createRedisConnectionFromEnv } from "@sm/queue";
import { buildRealtimeAgentHello } from "./agentHelloPayload.js";
import {
  buildOperatorInstallYaml,
  parseOperatorInstallOptions
} from "./operatorInstallYaml.js";
import {
  ensureCoreSchema,
  enqueueManualBuild,
  getRegistryRepoVisibility,
  setRegistryRepoVisibility,
  listRegistryRepoVisibility,
  getRegistryManifestByTag,
  getBuild,
  getBuildArtifact,
  listBuildArtifacts,
  listBuildsForService,
  listAllDeployTargets,
  listLatestBuildsForBoundServices,
  listLoadBalancerStatusForTenant,
  listMissingDeploysForAgent,
  listRunningServicesForAgent,
  popLoadBalancerStatusForAgentService,
  upsertLoadBalancerStatus,
  type QueryFn,
  type LoadBalancerStatusRow
} from "@sm/db";

const startedAt = Date.now();

async function buildMeResponse(store: AuthStore, session: SessionInfo) {
  let rows = await store.findMembershipsWithTenants(session.id);
  if (rows.length === 0) {
    rows = [
      {
        tenantId: session.tenantId,
        tenantName: session.tenantId,
        role: session.role,
      },
    ];
  }
  const memberships = rows.map((r) => ({
    tenantId: r.tenantId,
    tenantName: r.tenantName,
    role: r.role as SessionInfo["role"],
  }));
  return meResponseSchema.parse({
    id: session.id,
    email: session.email,
    role: session.role,
    tenantId: session.tenantId,
    memberships,
  });
}

function signValid(secret: string, payload: string, signature?: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(signature, "utf8"));
}

function defaultWebhookTenantId() {
  return process.env.DEFAULT_WEBHOOK_TENANT_ID ?? "t-webhook";
}

function loginEmailMetadata(email: string | undefined): {
  emailProvided: boolean;
  emailDomain: string | null;
  emailFingerprint: string | null;
} {
  const normalized = email?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return { emailProvided: false, emailDomain: null, emailFingerprint: null };
  }

  const domain = normalized.includes("@") ? normalized.split("@").slice(1).join("@") : null;
  const emailFingerprint = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return { emailProvided: true, emailDomain: domain, emailFingerprint };
}

function requestSourceIp(req: { ip: string; headers: Record<string, unknown> }): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip;
}

function emitLoginFailureLog(
  req: { log: { warn: (obj: Record<string, unknown>, msg?: string) => void } },
  payload: Record<string, unknown>
): void {
  req.log.warn(payload, "Login attempt failed");
  const loggerFn = req.log.warn as unknown as { name?: string };
  if (loggerFn.name === "noop") {
    // Ensure failures are visible in backend stdout/stderr when Fastify logger is disabled.
    console.error("[auth.login.failed]", JSON.stringify(payload));
  }
}

function emitLoginStepLog(
  req: { log: { info: (obj: Record<string, unknown>, msg?: string) => void } },
  payload: Record<string, unknown>
): void {
  req.log.info(payload, "Login step");
  const loggerFn = req.log.info as unknown as { name?: string };
  if (loggerFn.name === "noop") {
    // Keep step-by-step visibility in backend logs even if Fastify logger is disabled.
    console.error("[auth.login.step]", JSON.stringify(payload));
  }
}

export type BuildServerOptions = {
  enqueueLogIngestion?: (job: LogIngestionJob) => void | Promise<void>;
  enqueueAgentCommand?: (job: AgentCommandJob) => void | Promise<void>;
  /** When omitted, checkers are derived from POSTGRES_* / REDIS_* env (TCP probes). */
  readinessCheckers?: ReadinessChecker[];
  domainStore?: DomainStore;
  redis?: PendingCommandRedis;
  authStore?: AuthStore;
  onSetupComplete?: SetupCompleteCallback;
};

export type RuntimeQueueWiring = {
  buildOptions: Pick<BuildServerOptions, "enqueueLogIngestion" | "enqueueAgentCommand" | "redis">;
  close: () => Promise<void>;
};

export type { ReadinessChecker } from "./readyChecks.js";

/** Best-effort extraction of a 7+ char hex SHA from agent run_fix_plan output.
 *  The agent prints `commit=<sha>` on a successful push; if absent, return null. */
function extractCommitShaFromOutput(output: string): string | null {
  const m = output.match(/commit=([0-9a-f]{7,40})/i);
  return m ? m[1] : null;
}

/**
 * Two `resolveEnvironment` outputs that mean the same deployment.
 * Used to skip churn when an agent's env flips but the resolved config
 * is identical for both (kaiad.yaml didn't carve out anything different
 * between the two envs).
 */
function resolvedConfigsEqual(
  a: { instances: number; namespace: string; loadBalancer: unknown; domains: unknown },
  b: { instances: number; namespace: string; loadBalancer: unknown; domains: unknown }
): boolean {
  if (a.instances !== b.instances) return false;
  if (a.namespace !== b.namespace) return false;
  if (JSON.stringify(a.loadBalancer) !== JSON.stringify(b.loadBalancer)) return false;
  if (JSON.stringify(a.domains) !== JSON.stringify(b.domains)) return false;
  return true;
}

const noopLogIngestion = (_job: LogIngestionJob) => Promise.resolve();
const noopAgentCommandEnqueue = async (_job: AgentCommandJob) => {
  throw new Error("Agent command queue is not configured");
};

async function pgImportAvailable(): Promise<boolean> {
  try {
    await import("pg");
    return true;
  } catch {
    return false;
  }
}

async function initDomainStoreFromEnv(): Promise<DomainStore> {
  const pgOk = await pgImportAvailable();
  const backend = resolveTenantStoreBackend(process.env, pgOk);
  if (backend === "postgres") {
    const { Pool } = await import("pg");
    const url = process.env.DATABASE_URL;
    if (!url?.trim()) {
      return createMemoryDomainStore();
    }
    const pool = new Pool({ connectionString: url });
    await ensureCoreSchema(pool);
    return createPostgresDomainStore(pool);
  }
  return createMemoryDomainStore();
}

function createLazyDomainStore(resolve: () => Promise<DomainStore>): DomainStore {
  let store: DomainStore | undefined;
  let loading: Promise<DomainStore> | undefined;

  async function get(): Promise<DomainStore> {
    if (store) return store;
    if (!loading) {
      loading = resolve().then((s) => {
        store = s;
        return s;
      });
    }
    return loading;
  }

  return {
    listIncidents: (tenantId) => get().then((s) => s.listIncidents(tenantId)),
    getIncident: (tenantId, id) => get().then((s) => s.getIncident(tenantId, id)),
    upsertIncident: (tenantId, data) => get().then((s) => s.upsertIncident(tenantId, data)),
    updateIncidentStatus: (tenantId, id, status) =>
      get().then((s) => s.updateIncidentStatus(tenantId, id, status)),
    listAgents: (tenantId) => get().then((s) => s.listAgents(tenantId)),
    getAgent: (tenantId, id) => get().then((s) => s.getAgent(tenantId, id)),
    recordAgentHeartbeat: (tenantId, data) =>
      get().then((s) => s.recordAgentHeartbeat(tenantId, data)),
    markAgentOffline: (tenantId, agentId) => get().then((s) => s.markAgentOffline(tenantId, agentId)),
    listServices: (tenantId) => get().then((s) => s.listServices(tenantId)),
    getService: (tenantId, id) => get().then((s) => s.getService(tenantId, id)),
    createService: (tenantId, data) => get().then((s) => s.createService(tenantId, data)),
    updateService: (tenantId, id, patch) => get().then((s) => s.updateService(tenantId, id, patch)),
    deleteService: (tenantId, id) => get().then((s) => s.deleteService(tenantId, id)),
    attachServiceToAgent: (tenantId, agentId, serviceId) =>
      get().then((s) => s.attachServiceToAgent(tenantId, agentId, serviceId)),
    detachServiceFromAgent: (tenantId, agentId, serviceId) =>
      get().then((s) => s.detachServiceFromAgent(tenantId, agentId, serviceId)),
    listServicesForAgent: (tenantId, agentId) =>
      get().then((s) => s.listServicesForAgent(tenantId, agentId)),
    updateAgent: (tenantId, agentId, data) => get().then((s) => s.updateAgent(tenantId, agentId, data)),
    deleteAgent: (tenantId, agentId) => get().then((s) => s.deleteAgent(tenantId, agentId)),
    listSshKeys: (tenantId) => get().then((s) => s.listSshKeys(tenantId)),
    createSshKey: (tenantId, data) => get().then((s) => s.createSshKey(tenantId, data)),
    deleteSshKey: (tenantId, id) => get().then((s) => s.deleteSshKey(tenantId, id)),
    getSshKeyMaterial: (tenantId, id) => get().then((s) => s.getSshKeyMaterial(tenantId, id))
  };
}

function resolveDomainStore(opts: BuildServerOptions): DomainStore {
  if (opts.domainStore) {
    return opts.domainStore;
  }
  return createLazyDomainStore(() => initDomainStoreFromEnv());
}

function queueDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.REDIS_DISABLED === "1";
}

function resolveInternalApiToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.INTERNAL_API_TOKEN?.trim();
  if (configured) {
    return configured;
  }
  if (env.NODE_ENV === "production") {
    return null;
  }
  return "dev-token";
}

export function createRuntimeQueueWiringFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeQueueWiring | null {
  if (queueDisabled(env)) {
    return null;
  }

  const redis = createRedisConnectionFromEnv(env);
  const logQueue = createNamedQueue<LogIngestionJob>("logIngestion", redis);
  const agentCommandQueue = createNamedQueue<AgentCommandJob>("agentCommands", redis);

  return {
    buildOptions: {
      redis,
      enqueueLogIngestion: async (job) => {
        await logQueue.add("log-ingestion", job);
      },
      enqueueAgentCommand: async (job) => {
        await agentCommandQueue.add("agent-command", job);
      }
    },
    close: async () => {
      await Promise.allSettled([
        logQueue.close(),
        agentCommandQueue.close()
      ]);
      await redis.quit();
    }
  };
}

function createSwappableAuthStore(initial: AuthStore): AuthStore & { swap: (next: AuthStore) => void } {
  let current = initial;
  return {
    findUserByEmail: (email) => current.findUserByEmail(email),
    findMemberships: (userId) => current.findMemberships(userId),
    findMembershipsWithTenants: (userId) => current.findMembershipsWithTenants(userId),
    createSession: (userId, tenantId, tokenHash, expiresAt) =>
      current.createSession(userId, tenantId, tokenHash, expiresAt),
    findSessionByTokenHash: (tokenHash) => current.findSessionByTokenHash(tokenHash),
    findUserById: (id) => current.findUserById(id),
    updateSessionTenant: (sessionId, tenantId) => current.updateSessionTenant(sessionId, tenantId),
    createTenantAsUser: (args) => current.createTenantAsUser(args),
    deleteTenantForUser: (args) => current.deleteTenantForUser(args),
    swap: (next) => { current = next; },
  };
}

async function swapAuthStoreToPostgres(
  swappable: AuthStore & { swap: (next: AuthStore) => void },
  databaseUrl: string
): Promise<void> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  const { ensureCoreSchema } = await import("@sm/db");
  await ensureCoreSchema(pool);
  swappable.swap(createPostgresAuthStore(pool));
}

function githubInstallUrlFromSlug(slug: string): string {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

/** Resolve public slug + install URL from env, config (no user-entered slug required). */
async function resolveGithubInstallInfo(cfg: KaiadConfig | null): Promise<{
  appSlug: string | null;
  installUrl: string | null;
}> {
  const envSlug = process.env.GITHUB_APP_SLUG?.trim();
  if (envSlug) {
    return { appSlug: envSlug, installUrl: githubInstallUrlFromSlug(envSlug) };
  }
  const gh = cfg?.githubApp;
  const fromFile = gh?.appSlug?.trim();
  if (fromFile) {
    return { appSlug: fromFile, installUrl: githubInstallUrlFromSlug(fromFile) };
  }
  return { appSlug: null, installUrl: null };
}

export function buildServer(opts: BuildServerOptions = {}) {
  const enqueueLogIngestion = opts.enqueueLogIngestion ?? noopLogIngestion;
  const enqueueAgentCommand = opts.enqueueAgentCommand ?? noopAgentCommandEnqueue;
  const readinessCheckers = opts.readinessCheckers ?? createReadinessCheckersFromEnv();
  const domainStore = resolveDomainStore(opts);
  const authStore = opts.authStore ?? createMemoryAuthStore();
  const realtimeManager = new RealtimeManager({ redis: opts.redis });
  const errorGroups = new ErrorGroupStore();
  /** Map of in-flight fix command_id → errorGroupId, so the WS command_ack
   *  handler can mark the right group fixed/open and emit onFixCreated. */
  const fixCommandToGroup = new Map<string, { tenantId: string; serviceId: string; agentId: string; errorGroupId: string }>();

  /**
   * Per-service auto-fix concurrency gate. Key is `<tenantId>:<serviceId>`.
   *
   * One physical incident (e.g. a thrown NullPointerException) typically
   * lands as multiple error groups — Spring emits a "Servlet.service()
   * threw exception" wrapper, the NPE itself, and the top stack frame
   * each as a distinct ERROR-level line. Without this lock, every group
   * fires its own `run_fix_plan` and we end up with N concurrent Claude
   * runs racing to push to the same branch — N-1 of them lose the race
   * and report "no changes" because the first push already fixed the
   * file. The lock is acquired SYNCHRONOUSLY before dispatchAutoFix's
   * first await so concurrent app_log_error handlers can't both observe
   * the unlocked state. Released by the command_ack handler regardless
   * of fix outcome (a stuck "fixing" lock would starve future incidents
   * for that service until process restart).
   */
  const fixInFlightByService = new Set<string>();
  const fixServiceKey = (tenantId: string, serviceId: string) => `${tenantId}:${serviceId}`;
  const app = Fastify();
  app.register(cors);
  app.register(websocket);
  app.register(correlationIdPlugin);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.join(__dirname, "public");
  app.register(fastifyStatic, {
    root: publicDir,
    prefix: "/",
    wildcard: false,
  });

  app.decorate("realtimeManager", realtimeManager);

  app.addHook("onRequest", async (req, reply) => {
    // Unit tests run without a real DB; allow API routes while still exposing /api/v1/setup/status.
    const skipSetupGate =
      process.env.KAIAD_SKIP_SETUP_GATE === "1" && process.env.VITEST === "true";
    if (skipSetupGate) return;
    if (!isSetupRequired()) return;
    const url = req.url;
    if (
      url.startsWith("/api/v1/setup/") ||
      url === "/health" ||
      url === "/ready" ||
      !url.startsWith("/api/")
    ) {
      return;
    }
    return reply.status(503).send({
      code: "SETUP_REQUIRED",
      message: "Initial setup has not been completed",
    });
  });

  app.register(setupRoutes, { onSetupComplete: opts.onSetupComplete });

  // Registry token-auth endpoint. The built-in OCI registry is configured
  // with `auth: token` and points at this realm; clients hit it with
  // Basic auth and ?service=&scope=, and we hand back a JWT scoped to
  // what they requested (or 401 if they have no business pulling).
  //
  // Auth model:
  //   - kaiad session (owner/admin) → push + pull on any repo
  //   - kaiad session (operator/viewer) or api credential → pull only
  //   - enrollment token (peeked, not consumed) → pull only on `kaiad-agent`
  //
  // The dev-token shortcut counts as an owner session, so the local
  // push helper script (scripts/push-agent.sh) keeps working with
  // `docker login -u admin -p dev-token`.
  const registryAuthConfig: RegistryAuthConfig = {
    keyPath: process.env.REGISTRY_AUTH_KEY_PATH || `${getDataDir()}/registry-auth/key.pem`,
    certPath: process.env.REGISTRY_AUTH_CERT_PATH || `${getDataDir()}/registry-auth/cert.pem`,
    issuer: process.env.REGISTRY_AUTH_ISSUER || "kaiad",
    service: process.env.REGISTRY_AUTH_SERVICE || "kaiad-registry",
    // 5min is too tight for multi-GB layer uploads — a mid-push token
    // expiry triggers a 401, crane re-auths via the realm URL, and the
    // upload session restarts. Default to 1h; override via env if you
    // have stricter compliance requirements.
    ttlSeconds: Number.parseInt(process.env.REGISTRY_AUTH_TOKEN_TTL_SECONDS ?? "3600", 10)
  };
  // Generate the keypair eagerly so the registry can read cert.pem at startup.
  ensureRegistryAuth(registryAuthConfig);

  // Repositories that are ALWAYS anonymously pullable, regardless of the
  // registry_repository_visibility table. `kaiad-agent` and
  // `kaiad-operator` are baked into the kaiad image and force-published
  // public on boot (see the bootstrap after listen), so
  // `docker pull <host>/kaiad-agent:latest`, the operator install
  // bundle's image, and KaiadAgent pods always work without GHCR
  // access. Extra always-public repos can be added via
  // KAIAD_REGISTRY_PUBLIC_PULL_REPOS="repo-a,repo-b".
  const FORCED_PUBLIC_REPOS = new Set(
    [
      "kaiad-agent",
      "kaiad-operator",
      ...(process.env.KAIAD_REGISTRY_PUBLIC_PULL_REPOS ?? "").split(",")
    ]
      .map((s) => s.trim())
      .filter(Boolean)
  );

  /**
   * Is `repo` anonymously pullable? True when it is force-public, or its
   * registry_repository_visibility row is public. Falls back to the
   * force-public set when the registry DB is unavailable so the baked-in
   * agent image stays pullable even without Postgres.
   */
  async function isRepoPubliclyPullable(repo: string): Promise<boolean> {
    if (FORCED_PUBLIC_REPOS.has(repo)) return true;
    try {
      const pool = await getRegistryPool();
      if (!pool) return false;
      const visible = await getRegistryRepoVisibility(
        async (sql: string, params: unknown[]) => {
          const r = await pool.query(sql, params as unknown[]);
          return { rows: r.rows as Record<string, unknown>[] };
        },
        repo
      );
      return visible === true;
    } catch {
      return false;
    }
  }

  app.get("/registry/token", async (req, reply) => {
    // Docker daemons frequently request the same realm with multiple
    // ?scope= params (one per repo touched in the operation), and
    // Fastify deserializes repeated keys as a string array. Normalize
    // to a single space-joined string before passing to parseScopes.
    const q = req.query as Record<string, string | string[] | undefined>;
    const requestedService = (Array.isArray(q.service) ? q.service[0] : q.service) ?? "";
    const rawScope = q.scope;
    const scope = Array.isArray(rawScope)
      ? rawScope.filter((s): s is string => typeof s === "string").join(" ")
      : rawScope ?? "";

    // Decode Basic auth — Docker daemons / kubelet / podman all use it.
    const auth = req.headers.authorization ?? "";
    let user = "";
    let password = "";
    if (auth.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
        const idx = decoded.indexOf(":");
        if (idx >= 0) {
          user = decoded.slice(0, idx);
          password = decoded.slice(idx + 1);
        }
      } catch {
        /* fall through to 401 */
      }
    }

    const requested = parseScopes(scope);

    // Resolve credential. Try kaiad session first (admin-class push),
    // then a (peeked) enrollment token. Skipped entirely when no Basic
    // auth was sent — anonymous callers can still get a public-pull
    // token below.
    type Grant = { subject: string; canPush: boolean };
    let grant: Grant | null = null;
    if (password) {
      const session = await resolveSession(authStore, `Bearer ${password}`);
      if (session) {
        const adminLike = session.role === "owner" || session.role === "admin";
        grant = { subject: session.id, canPush: adminLike };
      }
      if (!grant) {
        const enroll = await peekEnrollmentToken(password);
        if (enroll) {
          grant = { subject: `enrollment:${enroll.tokenId}`, canPush: false };
        }
      }
    }

    // Anonymous public pull: when every requested scope is pull-only on
    // a default-public repo (kaiad-agent), hand back a token without
    // credentials. This is the standard public-registry behaviour and
    // is what makes `<host>/kaiad-agent:latest` pullable out of the box.
    if (!grant && requested.length > 0) {
      const pullOnlyRepos = requested.every(
        (r) =>
          r.type === "repository" &&
          r.actions.length > 0 &&
          r.actions.every((a) => a === "pull")
      );
      const allPublic =
        pullOnlyRepos &&
        (await Promise.all(requested.map((r) => isRepoPubliclyPullable(r.name)))).every(Boolean);
      if (allPublic) {
        grant = { subject: "anonymous", canPush: false };
      }
    }

    if (!grant) {
      reply.header("WWW-Authenticate", 'Basic realm="kaiad-registry"');
      return reply
        .status(401)
        .send({ errors: [{ code: "UNAUTHORIZED", message: password ? "Invalid credentials" : "Basic auth required" }] });
    }

    // Translate the requested scope into what we'll grant.
    //   admin session         → pull + push on any repository
    //   enrollment token      → pull-only on any repository (covers
    //                           kaiad-agent AND any workload image
    //                           the user pushed under this Kaiad)
    // Catalog and other registry-wide ops aren't granted to either —
    // browsing /v2/_catalog needs an explicit per-tenant scope we
    // don't model yet.
    const granted: RegistryAccess[] =
      requested.length === 0
        ? []
        : filterAllowedActions(requested, (req) => {
            if (req.type !== "repository") return [];
            return req.actions.filter((action) => {
              if (action === "pull") return true;
              if (action === "push" || action === "*") return grant.canPush;
              return false;
            });
          });

    const audience = requestedService || registryAuthConfig.service;
    const tokenInfo = signRegistryToken(
      { ...registryAuthConfig, service: audience },
      { subject: grant.subject, access: granted }
    );

    return {
      token: tokenInfo.token,
      access_token: tokenInfo.token,
      expires_in: tokenInfo.expiresInSeconds,
      issued_at: tokenInfo.issuedAt
    };
  });

  // ── Registry shared pool ─────────────────────────────────────────────
  // Used by both the panel-facing /api/v1/registry/* routes and the OCI
  // /v2/* routes registered further down. Lazy: opens on first hit so
  // the memory-store fallback (dev-without-postgres) still serves the
  // rest of the app — registry endpoints just respond 503.
  let registryPool: import("pg").Pool | null | undefined;
  async function getRegistryPool(): Promise<import("pg").Pool | null> {
    if (registryPool !== undefined) return registryPool;
    const url = process.env.DATABASE_URL;
    if (!url?.trim()) {
      registryPool = null;
      return null;
    }
    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url });
      await ensureCoreSchema(pool);
      registryPool = pool;
      return pool;
    } catch (err) {
      app.log.error({ err }, "registry pool init failed");
      registryPool = null;
      return null;
    }
  }
  async function getRegistryAdminContext(): Promise<
    { pool: import("pg").Pool; queryFn: QueryFn } | null
  > {
    const pool = await getRegistryPool();
    if (!pool) return null;
    return {
      pool,
      queryFn: async (sql: string, params: unknown[]) => {
        const r = await pool.query(sql, params as unknown[]);
        return { rows: r.rows as Record<string, unknown>[] };
      }
    };
  }

  /**
   * Publish one baked OCI bundle to the local registry if its `:latest`
   * tag is missing, then (re)assert the repo public. Best-effort: logs
   * and swallows failures so the API still serves.
   */
  async function publishBakedBundle(
    repo: string,
    bundle: string,
    version: string
  ): Promise<void> {
    const port = Number(process.env.PORT ?? 3001);
    const registry = `127.0.0.1:${port}`; // kaiad serves /v2/* itself
    const craneBin = process.env.KAIAD_CRANE_BIN || "/usr/local/bin/crane";

    try {
      const ctx = await getRegistryAdminContext();
      if (!ctx) {
        console.error(`[image-bootstrap] registry DB unavailable; skipping ${repo}`);
        return;
      }

      if (!fs.existsSync(bundle)) {
        // Nothing to publish from this build; keep an existing repo public.
        if (await getRegistryManifestByTag(ctx.queryFn, repo, "latest")) {
          await setRegistryRepoVisibility(ctx.queryFn, repo, true);
        }
        console.error(`[image-bootstrap] no baked bundle at ${bundle}; skipping ${repo}`);
        return;
      }
      if (!fs.existsSync(craneBin)) {
        console.error(`[image-bootstrap] crane not found at ${craneBin}; cannot publish ${repo}`);
        return;
      }

      // Publish :<version> only when that exact tag isn't there yet, but
      // ALWAYS (re)push the moving :latest to THIS build's baked bundle —
      // successive builds (and version bumps) ship different agent code,
      // so :latest must track the current image. crane push is
      // content-addressed, so re-pushing identical bytes is a no-op.
      const versionPresent = await getRegistryManifestByTag(ctx.queryFn, repo, version);
      const tags = versionPresent ? ["latest"] : [version, "latest"];

      // Mint our own push token (the dev-token shortcut is disabled in
      // prod, so don't rely on it). Signed with the same registry key
      // the /v2 verifier checks.
      const { token } = signRegistryToken(registryAuthConfig, {
        subject: "system:image-bootstrap",
        access: [{ type: "repository", name: repo, actions: ["push", "pull"] }]
      });

      const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), `kaiad-${repo}-push-`));
      try {
        fs.writeFileSync(
          path.join(cfgDir, "config.json"),
          JSON.stringify({ auths: { [registry]: { registrytoken: token } } })
        );
        const run = promisify(execFile);
        const env = { ...process.env, DOCKER_CONFIG: cfgDir };
        for (const tag of tags) {
          console.error(`[image-bootstrap] pushing ${bundle} → ${registry}/${repo}:${tag}`);
          await run(craneBin, ["--insecure", "push", bundle, `${registry}/${repo}:${tag}`], {
            env
          });
        }
        await setRegistryRepoVisibility(ctx.queryFn, repo, true);
        console.error(`[image-bootstrap] ${repo}: published ${tags.join(", ")} (version ${version}); set public`);
      } finally {
        fs.rmSync(cfgDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error(`[image-bootstrap] ${repo} failed (non-fatal):`, err);
    }
  }

  /**
   * Boot-time guarantee for the images baked into the kaiad image at
   * docker-build time (no runtime toolchain needed — the Go binaries
   * were compiled in the Dockerfile): publish kaiad-agent and
   * kaiad-operator if missing and keep them public, so agents and the
   * operator install bundle pull from this Kaiad without GHCR access.
   */
  async function ensureBundledImagesPublished(): Promise<void> {
    await publishBakedBundle(
      "kaiad-agent",
      process.env.KAIAD_AGENT_BUNDLE || "/opt/kaiad-agent.tar",
      process.env.KAIAD_AGENT_VERSION || "0.1.0"
    );
    await publishBakedBundle(
      "kaiad-operator",
      process.env.KAIAD_OPERATOR_BUNDLE || "/opt/kaiad-operator.tar",
      process.env.KAIAD_OPERATOR_VERSION || "0.1.0"
    );
  }

  // ── Registry-management API (panel-only) ───────────────────
  // Reads from Postgres directly. The native /v2/* server (registered
  // below) handles OCI distribution traffic; this surface returns the
  // richer per-tag info (digest + size + createdAt) the panel needs in
  // a single fetch, avoiding the multi-HTTP-roundtrip the previous
  // registry:2 proxy required.

  /**
   * Reject unless the caller is an owner/admin kaiad session. Returns
   * `null` on rejection (after sending the response) or the resolved
   * session on success.
   */
  async function requireAdminSession(req: any, reply: any) {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: req.correlationId
        })
      );
      return null;
    }
    if (session.kind === "apiCredential" || (session.role !== "owner" && session.role !== "admin")) {
      reply.status(403).send(
        apiErrorSchema.parse({
          code: "FORBIDDEN",
          message: "Owner or admin session required",
          correlationId: req.correlationId
        })
      );
      return null;
    }
    return session;
  }

  app.get("/api/v1/registry/repositories", async (req, reply) => {
    const session = await requireAdminSession(req, reply);
    if (!session) return;
    const ctx = await getRegistryAdminContext();
    if (!ctx) {
      return reply.status(503).send(
        apiErrorSchema.parse({
          code: "REGISTRY_UNAVAILABLE",
          message: "Registry storage not configured (DATABASE_URL missing)",
          correlationId: (req as any).correlationId
        })
      );
    }
    const [repositories, visibilityRows] = await Promise.all([
      registryListRepositories(ctx.queryFn),
      listRegistryRepoVisibility(ctx.queryFn)
    ]);
    const visById = new Map(visibilityRows.map((v) => [v.repo, v.public]));
    return {
      repositories: repositories.map((r) => {
        const forcedPublic = FORCED_PUBLIC_REPOS.has(r.name);
        return {
          ...r,
          public: forcedPublic || visById.get(r.name) === true,
          // UI locks the toggle for force-public repos (e.g. kaiad-agent).
          forcedPublic
        };
      })
    };
  });

  // Set a repository's anonymous-pull visibility. Force-public repos
  // (kaiad-agent) cannot be made private — the agent image must stay
  // pullable for unattended operator deployments.
  app.put<{ Params: { name: string }; Body: { public?: unknown } }>(
    "/api/v1/registry/repositories/:name/visibility",
    async (req, reply) => {
      const session = await requireAdminSession(req, reply);
      if (!session) return;
      const isPublic = (req.body as { public?: unknown })?.public;
      if (typeof isPublic !== "boolean") {
        return reply.status(400).send(
          apiErrorSchema.parse({
            code: "INVALID_REQUEST",
            message: "Body must be { public: boolean }",
            correlationId: (req as any).correlationId
          })
        );
      }
      const name = req.params.name;
      if (FORCED_PUBLIC_REPOS.has(name) && !isPublic) {
        return reply.status(409).send(
          apiErrorSchema.parse({
            code: "FORCED_PUBLIC",
            message: `${name} is always public and cannot be made private`,
            correlationId: (req as any).correlationId
          })
        );
      }
      const ctx = await getRegistryAdminContext();
      if (!ctx) {
        return reply.status(503).send(
          apiErrorSchema.parse({
            code: "REGISTRY_UNAVAILABLE",
            message: "Registry storage not configured (DATABASE_URL missing)",
            correlationId: (req as any).correlationId
          })
        );
      }
      await setRegistryRepoVisibility(ctx.queryFn, name, isPublic);
      return { name, public: isPublic || FORCED_PUBLIC_REPOS.has(name) };
    }
  );

  // Repo names can contain slashes (e.g. `library/alpine`). Fastify
  // doesn't accept '/' inside a single :name param, so the panel must
  // url-encode '/' as %2F. encodeURIComponent on the client handles it.
  app.get<{ Params: { name: string } }>(
    "/api/v1/registry/repositories/:name/tags",
    async (req, reply) => {
      const session = await requireAdminSession(req, reply);
      if (!session) return;
      const ctx = await getRegistryAdminContext();
      if (!ctx) {
        return reply.status(503).send(
          apiErrorSchema.parse({
            code: "REGISTRY_UNAVAILABLE",
            message: "Registry storage not configured (DATABASE_URL missing)",
            correlationId: (req as any).correlationId
          })
        );
      }
      const name = req.params.name;
      const tags = await registryListTags(ctx.pool, ctx.queryFn, name);
      return { name, tags };
    }
  );

  app.delete<{ Params: { name: string; tag: string } }>(
    "/api/v1/registry/repositories/:name/tags/:tag",
    async (req, reply) => {
      const session = await requireAdminSession(req, reply);
      if (!session) return;
      const ctx = await getRegistryAdminContext();
      if (!ctx) {
        return reply.status(503).send(
          apiErrorSchema.parse({
            code: "REGISTRY_UNAVAILABLE",
            message: "Registry storage not configured (DATABASE_URL missing)",
            correlationId: (req as any).correlationId
          })
        );
      }
      const { name, tag } = req.params;
      const result = await registryDeleteTag(ctx.queryFn, name, tag);
      if (!result.deleted) {
        return reply.status(404).send(
          apiErrorSchema.parse({
            code: "NOT_FOUND",
            message: `tag not found: ${tag}`,
            correlationId: (req as any).correlationId
          })
        );
      }
      return { deleted: true, digest: result.digest };
    }
  );

  // ── Native OCI Distribution v2 (kaiad-hosted) ────────────────────────
  // Replaces the registry:2 sidecar. Uses the shared registryPool above.
  registerRegistryRoutes(app, {
    getPool: getRegistryPool,
    authConfig: registryAuthConfig,
    // `realm` is the absolute URL clients hit to obtain a token. We
    // can't always know the public hostname from inside the API, so
    // honour KAIAD_REGISTRY_REALM if set; otherwise default to the
    // service-relative path and let the host nginx rewrite if needed.
    tokenRealm: process.env.KAIAD_REGISTRY_REALM || "/registry/token",
    service: registryAuthConfig.service,
    // Lets the /v2 pull routes serve public repos with no bearer token
    // at all (same predicate the token minter uses for anonymous grants).
    isPubliclyPullable: isRepoPubliclyPullable
  });

  // WebSocket routes must live in an async child plugin (Fastify 5 + @fastify/websocket);
  // otherwise upgrades fail with HTTP 500 for both TCP and injectWS.
  app.register(async (instance) => {
    instance.get("/realtime", { websocket: true }, async (socket, req) => {
      const isDev = process.env.NODE_ENV !== "production";
      const tokenParam = (req.query as Record<string, string | undefined>)?.token;
      let agentTenantId: string | undefined;

      if (tokenParam) {
        let result: Awaited<ReturnType<typeof validateEnrollmentToken>>;
        try {
          result = await validateEnrollmentToken(tokenParam);
        } catch (err) {
          socket.send(
            JSON.stringify(
              apiErrorSchema.parse({
                code: "ENROLLMENT_STORE_UNAVAILABLE",
                message: err instanceof Error ? err.message : "Enrollment token validation unavailable"
              })
            )
          );
          socket.close();
          return;
        }
        if (result) {
          agentTenantId = result.tenantId;
        } else {
          socket.send(
            JSON.stringify(
              apiErrorSchema.parse({
                code: "INVALID_TOKEN",
                message: "Invalid or expired enrollment token"
              })
            )
          );
          socket.close();
          return;
        }
      }

      if (!agentTenantId && isDev) {
        agentTenantId = "t-1";
      }

      let helloSettings: TenantSettings | undefined;
      if (agentTenantId) {
        helloSettings = await getTenantSettings(agentTenantId);
      }
      socket.send(JSON.stringify(buildRealtimeAgentHello(helloSettings)));
      let registeredAgentId: string | undefined;

      socket.on("message", async (raw) => {
        let parsedJson: unknown;
        try {
          const text = typeof raw === "string" ? raw : raw.toString("utf8");
          parsedJson = JSON.parse(text);
        } catch {
          socket.send(
            JSON.stringify(
              apiErrorSchema.parse({
                code: "INVALID_MESSAGE",
                message: "Message must be valid JSON"
              })
            )
          );
          socket.close();
          return;
        }

        const parsed = agentToPlatformMessageSchema.safeParse(parsedJson);
        if (!parsed.success) {
          socket.send(
            JSON.stringify(
              apiErrorSchema.parse({
                code: "INVALID_MESSAGE",
                message: parsed.error.message
              })
            )
          );
          socket.close();
          return;
        }

        const msg: AgentToPlatformMessage = parsed.data;

        const ensureRegistered = (agentId: string) => {
          if (!registeredAgentId) {
            registeredAgentId = agentId;
            realtimeManager.registerAgent({ agentId, socket }).catch(() => {});
            if (agentTenantId) {
              realtimeManager.bindAgentTenant(agentId, agentTenantId);
              realtimeManager.broadcastToTenant(
                agentTenantId,
                JSON.stringify(
                  uiTelemetryEventSchema.parse({
                    type: "agent_presence",
                    agentId,
                    websocketConnected: true
                  })
                )
              );
              // Reconcile pass: dispatch redeploy_service for any
              // bound services that have a successful build but no
              // lb_status_report. Ensures freshly-bound or
              // newly-restarted agents catch up to the latest images
              // without waiting for the next git push.
              const tenantForReconcile = agentTenantId;
              setImmediate(() => {
                reconcileAgentDeploys(tenantForReconcile, agentId)
                  .then((r) => {
                    if (r.dispatched > 0 || r.skipped.length > 0) {
                      req.log?.info?.(
                        { agentId, ...r },
                        "agent reconcile dispatched"
                      );
                    }
                  })
                  .catch((err) =>
                    req.log?.warn?.({ agentId, err: (err as Error).message }, "agent reconcile failed")
                  );
              });
            }
          }
        };

        if (msg.type === "heartbeat") {
          if (msg.tenantId && !agentTenantId) {
            agentTenantId = msg.tenantId;
          }
          const tenantForStore = agentTenantId;
          if (
            tenantForStore &&
            (!msg.tenantId || msg.tenantId === tenantForStore)
          ) {
            void domainStore
              .recordAgentHeartbeat(tenantForStore, {
                agentId: msg.agentId,
                version: msg.agentVersion ?? null,
                runtimeBackend: msg.runtime?.backend ?? null
              })
              .catch(() => {});
          }
          ensureRegistered(msg.agentId);
        }

        if (msg.type === "host_stats") {
          if (agentTenantId) {
            void domainStore
              .recordAgentHeartbeat(agentTenantId, {
                agentId: msg.agentId,
                version: null
              })
              .catch(() => {});
          }
          ensureRegistered(msg.agentId);
          realtimeManager.setHostStats(msg.agentId, parsedJson);
          if (agentTenantId) {
            const { type: _t, agentId: _a, ...stats } = msg;
            realtimeManager.broadcastToTenant(
              agentTenantId,
              JSON.stringify(
                uiTelemetryEventSchema.parse({
                  type: "host_stats",
                  agentId: msg.agentId,
                  stats
                })
              )
            );
          }
        }

        if (msg.type === "app_stats") {
          if (agentTenantId) {
            void domainStore
              .recordAgentHeartbeat(agentTenantId, {
                agentId: msg.agentId,
                version: null
              })
              .catch(() => {});
          }
          ensureRegistered(msg.agentId);
          realtimeManager.setAppStats(msg.agentId, msg.containerId, parsedJson);
          if (agentTenantId) {
            const { type: _t, agentId: _a, containerId: _c, ...stats } = msg;
            realtimeManager.broadcastToTenant(
              agentTenantId,
              JSON.stringify(
                uiTelemetryEventSchema.parse({
                  type: "app_stats",
                  agentId: msg.agentId,
                  containerId: msg.containerId,
                  stats
                })
              )
            );
          }
        }

        if (msg.type === "command_ack" && registeredAgentId) {
          void realtimeManager
            .acknowledgeCommand(registeredAgentId, msg.commandId, { status: msg.status, output: msg.output })
            .catch(() => {});

          // If this ack belongs to a fix command we dispatched, transition
          // the error group and (on success) emit onFixCreated.
          const fixMeta = fixCommandToGroup.get(msg.commandId);
          if (fixMeta) {
            fixCommandToGroup.delete(msg.commandId);
            // Release the per-service auto-fix lock so the NEXT
            // incident on this service can dispatch. Runs on every
            // ack (completed / failed / cancelled) so a single bad
            // fix won't jam the gate. fixMeta.serviceId is whatever
            // the agent reported (usually the kaiad service NAME via
            // the service-name label); resolve to the canonical
            // MonitoredService.id with the same id-then-name lookup
            // we used at dispatch time.
            try {
              let lockSvc = await domainStore.getService(fixMeta.tenantId, fixMeta.serviceId);
              if (!lockSvc) {
                const all = await domainStore.listServices(fixMeta.tenantId);
                lockSvc = all.find((s) => s.name === fixMeta.serviceId);
              }
              if (lockSvc) {
                fixInFlightByService.delete(fixServiceKey(fixMeta.tenantId, lockSvc.id));
              }
            } catch {
              // Best effort. Worst case the lock leaks for this
              // service until the next process restart.
            }
            if (msg.status === "completed") {
              const commitSha = extractCommitShaFromOutput(msg.output ?? "");
              const updated = errorGroups.setStatus(fixMeta.errorGroupId, "fixed", commitSha ?? undefined);
              if (updated) {
                realtimeManager.broadcastToTenant(
                  fixMeta.tenantId,
                  JSON.stringify(
                    uiTelemetryEventSchema.parse({
                      type: "error_group_updated",
                      group: updated
                    })
                  )
                );
              }
            } else if (msg.status === "failed" || msg.status === "cancelled") {
              const updated = errorGroups.setStatus(fixMeta.errorGroupId, "open");
              if (updated) {
                realtimeManager.broadcastToTenant(
                  fixMeta.tenantId,
                  JSON.stringify(
                    uiTelemetryEventSchema.parse({
                      type: "error_group_updated",
                      group: updated
                    })
                  )
                );
              }
            }
          }
        }

        if (msg.type === "app_log_error") {
          const tenantId = agentTenantId ?? (isDev ? "t-1" : null);
          if (!tenantId) {
            // No tenant binding yet — drop silently; agent will resend later.
          } else if (isProbablyUserInputError(msg.message)) {
            // User-input errors are not auto-fix candidates. We still log
            // for visibility but do not create an error group.
            req.log?.info?.({
              event: "auto_fix.skip_user_input",
              serviceId: msg.serviceId,
              message: msg.message
            });
          } else {
            ensureRegistered(msg.agentId);
            const upsert = errorGroups.upsert({
              tenantId,
              agentId: msg.agentId,
              serviceId: msg.serviceId,
              message: msg.message,
              contextLines: msg.contextLines,
              ts: msg.ts
            });
            // Attach context lines for the UI snapshot.
            const groupForUi = { ...upsert.group, contextLines: msg.contextLines };
            realtimeManager.broadcastToTenant(
              tenantId,
              JSON.stringify(
                uiTelemetryEventSchema.parse({
                  type: "error_group_updated",
                  group: groupForUi
                })
              )
            );

            // Auto-fix dispatch — only on a NEW group or when status was open.
            // Paused / fixing groups are skipped by the dispatcher itself.
            // Env knob `SM_AUTO_FIX_DISABLED=1` short-circuits the entire
            // dispatch so incidents accumulate in the queue without the
            // server triggering fix plans — useful for testing dedup
            // behaviour where you want to SEE incidents land without
            // them being mutated mid-test.
            const autoFixDisabled = process.env.SM_AUTO_FIX_DISABLED === "1";
            if (autoFixDisabled) {
              req.log?.info?.({
                event: "auto_fix.disabled",
                groupId: upsert.group.id,
                serviceId: msg.serviceId
              });
            } else if (upsert.isNew || upsert.group.status === "open") {
              // The agent's log streamer reports `serviceId` as the docker
              // container name (not the kaiad service UUID). Look up by id
              // first; on miss, fall back to a name match so this works for
              // services managed via the panel UI without a sync_desired_state.
              let service = await domainStore.getService(tenantId, msg.serviceId);
              if (!service) {
                const all = await domainStore.listServices(tenantId);
                service = all.find((s) => s.name === msg.serviceId);
              }
              const svcKey = service ? fixServiceKey(tenantId, service.id) : null;
              // Optimistic synchronous acquire so concurrent
              // app_log_error handlers (3+ per NPE due to Spring's
              // multi-line error output) can't all observe the
              // unlocked state and race into parallel dispatches.
              let weAcquired = false;
              if (svcKey) {
                if (fixInFlightByService.has(svcKey)) {
                  req.log?.info?.({
                    event: "auto_fix.skip_in_flight_for_service",
                    groupId: upsert.group.id,
                    serviceId: service?.id
                  });
                } else {
                  fixInFlightByService.add(svcKey);
                  weAcquired = true;
                }
              }
              const outcome = (svcKey && !weAcquired)
                ? ({ kind: "skipped_in_flight" } as const)
                : await dispatchAutoFix(
                    {
                      domainStore,
                      errorGroups,
                      readSshKeyMaterial: (tid, kid) => domainStore.getSshKeyMaterial(tid, kid),
                      enqueueAgentCommand,
                      isAgentOnline: (id) => realtimeManager.getConnectedAgentIds().includes(id)
                    },
                    upsert.group,
                    service
                  );
              // Release the lock when dispatchAutoFix declined to
              // actually send a command (no online agent, missing
              // repo, missing auth). Without this the service would
              // be jammed until process restart.
              if (weAcquired && outcome.kind !== "dispatched" && svcKey) {
                fixInFlightByService.delete(svcKey);
              }
              if (outcome.kind === "dispatched") {
                fixCommandToGroup.set(outcome.commandId, {
                  tenantId,
                  serviceId: msg.serviceId,
                  agentId: msg.agentId,
                  errorGroupId: upsert.group.id
                });
                const fixing = errorGroups.get(upsert.group.id);
                if (fixing) {
                  realtimeManager.broadcastToTenant(
                    tenantId,
                    JSON.stringify(
                      uiTelemetryEventSchema.parse({
                        type: "error_group_updated",
                        group: fixing
                      })
                    )
                  );
                }
              } else if (outcome.kind === "skipped_missing_auth") {
                const updated = errorGroups.get(upsert.group.id);
                if (updated) {
                  realtimeManager.broadcastToTenant(
                    tenantId,
                    JSON.stringify(
                      uiTelemetryEventSchema.parse({
                        type: "error_group_updated",
                        group: updated
                      })
                    )
                  );
                }
              }
            }
          }
        }

        if (msg.type === "lb_status_report") {
          // Per-service load-balancer observation. The agent sends this
          // after a successful redeploy_service so the panel's Load
          // Balancers page can show domain → external IP : port.
          const tenantId = agentTenantId;
          if (tenantId) {
            try {
              const q = await getBuildsQuery();
              if (q) {
                await upsertLoadBalancerStatus(q, {
                  tenantId,
                  serviceId: msg.serviceId,
                  agentId: msg.agentId,
                  environment: msg.environment,
                  namespace: msg.namespace ?? "",
                  lbType: msg.lbType,
                  externalIp: msg.externalIp,
                  externalHostname: msg.externalHostname,
                  ports: msg.ports,
                  domains: msg.domains,
                  detail: msg.detail,
                  imageRef: msg.imageRef ?? null,
                  buildId: msg.buildId ?? null
                });
              }
            } catch (err) {
              req.log?.warn?.(
                { err: (err as Error).message, serviceId: msg.serviceId, env: msg.environment },
                "lb_status_report upsert failed"
              );
            }
          }
        }

        if (msg.type === "log_event") {
          const tenantId = agentTenantId ?? (isDev ? "t-1" : "unknown");
          void Promise.resolve(
            enqueueLogIngestion({
              tenantId,
              agentId: msg.agentId,
              serviceId: msg.serviceId,
              level: msg.level,
              message: msg.message,
              ts: msg.ts,
              correlationId: (msg as any).correlationId
            })
          ).catch(() => {});
        }

        socket.send(JSON.stringify({ type: "ack", accepted: true as const }));
      });

      socket.on("close", () => {
        if (registeredAgentId) {
          if (agentTenantId) {
            realtimeManager.broadcastToTenant(
              agentTenantId,
              JSON.stringify(
                uiTelemetryEventSchema.parse({
                  type: "agent_presence",
                  agentId: registeredAgentId,
                  websocketConnected: false
                })
              )
            );
          }
          realtimeManager.unregisterAgent(registeredAgentId);
          if (agentTenantId) {
            void domainStore.markAgentOffline(agentTenantId, registeredAgentId).catch(() => {});
          }
        }
      });
    });

    instance.get("/api/v1/realtime/ui", { websocket: true }, async (socket, req) => {
      const session = await resolveSession(authStore, req.headers.authorization as string | undefined);
      const tokenFromQuery = (req.query as Record<string, string | undefined>)?.token;
      const resolved = session ?? (tokenFromQuery
        ? await resolveSession(authStore, `Bearer ${tokenFromQuery}`)
        : null);
      if (!resolved) {
        socket.send(
          JSON.stringify(
            apiErrorSchema.parse({
              code: "UNAUTHORIZED",
              message: "Missing or invalid session for UI telemetry stream"
            })
          )
        );
        socket.close();
        return;
      }

      const subscriber = { tenantId: resolved.tenantId, socket };
      realtimeManager.addUiSubscriber(subscriber);
      socket.on("close", () => {
        realtimeManager.removeUiSubscriber(subscriber);
      });
    });
  });

  app.get("/health", async () =>
    healthResponseSchema.parse({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000)
    })
  );

  app.get("/ready", async (_req, reply) => {
    for (const check of readinessCheckers) {
      const result = await check();
      if (!result.ok) {
        return reply.status(503).send({
          status: "not_ready" as const,
          code: result.code,
          message: result.message
        });
      }
    }
    return { status: "ready" as const };
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    const { email, password } = req.body as { email?: string; password?: string };
    const emailMeta = loginEmailMetadata(email);
    const correlationId = (req as { correlationId?: string }).correlationId;
    const sourceIp = requestSourceIp(req as unknown as { ip: string; headers: Record<string, unknown> });
    const stepLogReq = req as unknown as { log: { info: (obj: Record<string, unknown>, msg?: string) => void } };
    const failureLogReq = req as unknown as { log: { warn: (obj: Record<string, unknown>, msg?: string) => void } };
    emitLoginStepLog(stepLogReq, {
      event: "auth.login.step",
      step: "REQUEST_RECEIVED",
      correlationId,
      sourceIp,
      ...emailMeta
    });
    if (!email || !password) {
      emitLoginStepLog(stepLogReq, {
        event: "auth.login.step",
        step: "INPUT_VALIDATION_FAILED",
        hasPassword: Boolean(password),
        correlationId,
        sourceIp,
        ...emailMeta
      });
      emitLoginFailureLog(failureLogReq, {
        event: "auth.login.failed",
        reason: "MISSING_CREDENTIAL_FIELDS",
        hasPassword: Boolean(password),
        correlationId,
        sourceIp,
        ...emailMeta
      });
      return reply.status(400).send({ code: "BAD_REQUEST", message: "email and password required" });
    }
    emitLoginStepLog(stepLogReq, {
      event: "auth.login.step",
      step: "INPUT_VALIDATION_PASSED",
      correlationId,
      sourceIp,
      ...emailMeta
    });
    // Match DB lookups: stored emails are compared as plain text; normalize so login matches
    // signup/OAuth rows (and so fingerprint-aligned attempts actually query the same key).
    const loginEmail = email.trim().toLowerCase();
    const result = await loginWithDiagnostics(authStore, loginEmail, password);
    for (const traceStep of result.trace) {
      emitLoginStepLog(stepLogReq, {
        event: "auth.login.step",
        step: traceStep as LoginTraceStep,
        correlationId,
        sourceIp,
        ...emailMeta
      });
    }
    if (!result.ok) {
      emitLoginStepLog(stepLogReq, {
        event: "auth.login.step",
        step: "AUTHENTICATION_FAILED",
        reason: result.reason,
        correlationId,
        sourceIp,
        ...emailMeta
      });
      emitLoginFailureLog(failureLogReq, {
        event: "auth.login.failed",
        reason: result.reason,
        correlationId,
        sourceIp,
        ...emailMeta
      });
      return reply.status(401).send({ code: "INVALID_CREDENTIALS", message: "Invalid email or password" });
    }
    emitLoginStepLog(stepLogReq, {
      event: "auth.login.step",
      step: "AUTHENTICATION_SUCCEEDED",
      correlationId,
      sourceIp,
      tenantId: result.session.tenantId,
      role: result.session.role,
      ...emailMeta
    });
    return {
      token: result.token,
      user: {
        id: result.session.id,
        email: result.session.email,
        role: result.session.role,
        tenantId: result.session.tenantId
      }
    };
  });

  // --- OAuth / OIDC ---

  app.get("/api/v1/auth/providers", async () => {
    return listAuthProvidersResponseSchema.parse({ providers: listProviders() });
  });

  app.get("/api/v1/auth/oauth/authorize", async (req, reply) => {
    const { provider: providerId } = req.query as { provider?: string };
    if (!providerId) {
      return reply.status(400).send(
        apiErrorSchema.parse({ code: "BAD_REQUEST", message: "provider query param required" })
      );
    }
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      return reply.status(404).send(
        apiErrorSchema.parse({ code: "PROVIDER_NOT_FOUND", message: `OAuth provider '${providerId}' not configured` })
      );
    }
    const redirectUri = (req.query as Record<string, string>).redirect_uri
      ?? `${req.protocol}://${req.hostname}/api/v1/auth/oauth/callback`;
    const state = generateState(providerId);
    const authorizeUrl = buildAuthorizeUrl(provider, redirectUri, state);
    return oauthAuthorizeResponseSchema.parse({ authorizeUrl });
  });

  app.get("/api/v1/auth/oauth/callback", async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) {
      return reply.status(400).send(
        apiErrorSchema.parse({ code: "BAD_REQUEST", message: "code and state query params required" })
      );
    }
    const providerId = consumeState(state);
    if (!providerId) {
      return reply.status(400).send(
        apiErrorSchema.parse({ code: "INVALID_STATE", message: "Invalid or expired OAuth state" })
      );
    }
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      return reply.status(500).send(
        apiErrorSchema.parse({ code: "PROVIDER_NOT_FOUND", message: "Provider disappeared during flow" })
      );
    }
    const redirectUri = (req.query as Record<string, string>).redirect_uri
      ?? `${req.protocol}://${req.hostname}/api/v1/auth/oauth/callback`;

    let tokenResult: Awaited<ReturnType<typeof exchangeCodeForToken>>;
    try {
      tokenResult = await exchangeCodeForToken(provider, code, redirectUri);
    } catch (err) {
      return reply.status(502).send(
        apiErrorSchema.parse({
          code: "TOKEN_EXCHANGE_FAILED",
          message: err instanceof Error ? err.message : "Token exchange failed"
        })
      );
    }

    let userInfo: Awaited<ReturnType<typeof fetchUserInfo>>;
    try {
      userInfo = await fetchUserInfo(provider, tokenResult.accessToken);
    } catch (err) {
      return reply.status(502).send(
        apiErrorSchema.parse({
          code: "USERINFO_FAILED",
          message: err instanceof Error ? err.message : "UserInfo fetch failed"
        })
      );
    }

    if (!userInfo.email) {
      return reply.status(400).send(
        apiErrorSchema.parse({ code: "NO_EMAIL", message: "OAuth provider did not return an email" })
      );
    }

    let user = await authStore.findUserByEmail(userInfo.email);
    const defaultTenantId = process.env.SM_DEFAULT_TENANT_ID ?? "t-default";
    if (!user) {
      const userId = `u-oauth-${crypto.randomUUID()}`;
      user = { id: userId, email: userInfo.email, passwordHash: null };
    }

    const memberships = await authStore.findMemberships(user.id);
    const membership = memberships[0];
    const role = membership?.role ?? "viewer";

    const sessionToken = generateSessionToken();
    const tokenHash = hashToken(sessionToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const sessionId = await authStore.createSession(
      user.id,
      membership?.tenantId ?? defaultTenantId,
      tokenHash,
      expiresAt
    );

    return oauthCallbackResponseSchema.parse({
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        tenantId: membership?.tenantId ?? defaultTenantId,
        role
      }
    });
  });

  app.post("/api/v1/settings/oauth-providers", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token" })
      );
    }
    if (session.role !== "owner" && session.role !== "admin") {
      return reply.status(403).send(
        apiErrorSchema.parse({ code: "FORBIDDEN", message: "Admin access required" })
      );
    }
    const body = req.body as Record<string, unknown>;
    const cfg: OAuthProviderConfig = {
      id: String(body.id ?? ""),
      provider: String(body.provider ?? ""),
      clientId: String(body.clientId ?? ""),
      clientSecret: String(body.clientSecret ?? ""),
      authorizeUrl: String(body.authorizeUrl ?? ""),
      tokenUrl: String(body.tokenUrl ?? ""),
      userInfoUrl: String(body.userInfoUrl ?? ""),
      scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : []
    };
    if (!cfg.id || !cfg.provider || !cfg.clientId) {
      return reply.status(400).send(
        apiErrorSchema.parse({ code: "BAD_REQUEST", message: "id, provider, and clientId are required" })
      );
    }
    try {
      addOAuthProvider(cfg);
    } catch (err) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: err instanceof Error ? err.message : "Invalid OAuth provider configuration"
        })
      );
    }
    return reply.status(201).send({ ok: true });
  });

  app.get("/api/v1/settings/github-app", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token" })
      );
    }
    const cfg = readConfig();
    const gh = cfg?.githubApp;
    const { appSlug, installUrl } = await resolveGithubInstallInfo(cfg);
    return {
      appId: gh?.appId?.trim() ? gh.appId : null,
      appSlug,
      installUrl,
      privateKeyConfigured: !!gh?.privateKeyPem?.trim(),
      webhookSecretConfigured: !!gh?.webhookSecret?.trim()
    };
  });

  app.post("/api/v1/settings/github-app", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token" })
      );
    }
    if (session.role !== "owner" && session.role !== "admin") {
      return reply.status(403).send(
        apiErrorSchema.parse({ code: "FORBIDDEN", message: "Admin access required" })
      );
    }
    const current = readConfig();
    if (!current) {
      return reply.status(503).send(
        apiErrorSchema.parse({
          code: "CONFIG_UNAVAILABLE",
          message: "Server configuration file not found; complete setup before editing GitHub App credentials"
        })
      );
    }
    const body = req.body as Record<string, unknown>;
    const githubAppId = String(body.githubAppId ?? "").trim();
    if (!githubAppId) {
      return reply.status(400).send(
        apiErrorSchema.parse({ code: "BAD_REQUEST", message: "githubAppId is required" })
      );
    }
    const pemIn = String(body.githubAppPrivateKeyPem ?? "").trim();
    const secretIn = String(body.githubWebhookSecret ?? "").trim();
    const existing = current.githubApp;
    let appSlug = existing?.appSlug?.trim() ?? "";
    if (Object.prototype.hasOwnProperty.call(body, "githubAppSlug")) {
      appSlug = String(body.githubAppSlug ?? "").trim();
    }
    const privateKeyPem = pemIn || existing?.privateKeyPem?.trim() || "";
    const webhookSecret = secretIn || existing?.webhookSecret?.trim() || "";
    if (!privateKeyPem) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: "GitHub App private key is required when none is stored yet"
        })
      );
    }
    if (!webhookSecret) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: "GitHub webhook secret is required when none is stored yet"
        })
      );
    }
    const next: KaiadConfig = {
      ...current,
      githubApp: {
        appId: githubAppId,
        privateKeyPem,
        webhookSecret,
        ...(appSlug ? { appSlug } : {})
      }
    };
    try {
      await writeConfig(next);
    } catch (err) {
      return reply.status(500).send(
        apiErrorSchema.parse({
          code: "CONFIG_WRITE_FAILED",
          message: err instanceof Error ? err.message : "Failed to write configuration"
        })
      );
    }
    return { ok: true };
  });

  app.get("/api/v1/me", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    return await buildMeResponse(authStore, session);
  });

  app.post("/api/v1/session/active-tenant", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    const body = switchActiveTenantRequestSchema.parse(req.body);
    const memberships = await authStore.findMembershipsWithTenants(session.id);
    const allowed = memberships.some((m) => m.tenantId === body.tenantId);
    if (!allowed) {
      return reply.status(403).send(
        apiErrorSchema.parse({
          code: "FORBIDDEN",
          message: "Not a member of this tenant",
          correlationId: (req as any).correlationId
        })
      );
    }
    const ok = await authStore.updateSessionTenant(session.sessionId, body.tenantId);
    if (!ok) {
      return reply.status(500).send(
        apiErrorSchema.parse({
          code: "INTERNAL_ERROR",
          message: "Failed to update session tenant",
          correlationId: (req as any).correlationId
        })
      );
    }
    const next = await resolveSession(authStore, req.headers.authorization);
    if (!next) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Session invalid after tenant switch",
          correlationId: (req as any).correlationId
        })
      );
    }
    return await buildMeResponse(authStore, next);
  });

  app.post("/api/v1/tenants", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    const body = createTenantRequestSchema.parse(req.body);
    try {
      await authStore.createTenantAsUser({
        userId: session.id,
        sessionId: session.sessionId,
        name: body.name,
        tenantId: body.tenantId
      });
    } catch (e: unknown) {
      const code = e && typeof e === "object" && "code" in e ? (e as { code?: string }).code : undefined;
      if (code === "TENANT_ID_TAKEN") {
        return reply.status(409).send(
          apiErrorSchema.parse({
            code: "TENANT_ID_TAKEN",
            message: "That tenant id is already in use",
            correlationId: (req as any).correlationId
          })
        );
      }
      const msg = e instanceof Error ? e.message : "";
      if (msg === "SESSION_UPDATE_FAILED") {
        return reply.status(500).send(
          apiErrorSchema.parse({
            code: "INTERNAL_ERROR",
            message: "Failed to attach session to new tenant",
            correlationId: (req as any).correlationId
          })
        );
      }
      throw e;
    }
    const next = await resolveSession(authStore, req.headers.authorization);
    if (!next) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Session invalid after creating tenant",
          correlationId: (req as any).correlationId
        })
      );
    }
    return await buildMeResponse(authStore, next);
  });

  app.delete<{ Params: { tenantId: string } }>("/api/v1/tenants/:tenantId", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    const tenantId = decodeURIComponent(req.params.tenantId);
    const outcome = await authStore.deleteTenantForUser({ userId: session.id, tenantId });
    if (outcome === "forbidden") {
      return reply.status(403).send(
        apiErrorSchema.parse({
          code: "FORBIDDEN",
          message: "Not allowed to delete this tenant",
          correlationId: (req as any).correlationId
        })
      );
    }
    if (outcome === "not_found") {
      return reply.status(404).send(
        apiErrorSchema.parse({
          code: "NOT_FOUND",
          message: "Tenant not found",
          correlationId: (req as any).correlationId
        })
      );
    }
    if (outcome === "protected") {
      return reply.status(409).send(
        apiErrorSchema.parse({
          code: "PROTECTED_TENANT",
          message: "This tenant is configured as the default webhook tenant and cannot be deleted",
          correlationId: (req as any).correlationId
        })
      );
    }
    return reply.status(204).send();
  });

  app.get("/api/v1/settings", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send({ code: "UNAUTHORIZED", message: "Unauthorized" });
    }
    const settings = await getTenantSettings(session.tenantId);
    if (!settings) {
      return reply.status(404).send({ code: "NOT_FOUND", message: "No settings yet" });
    }
    return settings;
  });

  app.post<{ Body: TenantSettings }>("/api/v1/settings", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send({ code: "UNAUTHORIZED", message: "Unauthorized" });
    }
    const payload = upsertTenantSettingsRequestSchema.parse(req.body);
    if (payload.tenantId !== session.tenantId) {
      return reply.status(403).send({ code: "TENANT_SCOPE_DENY", message: "Cross-tenant write denied" });
    }
    return await upsertTenantSettings(payload);
  });

  // --- Admin API credentials (long-lived bearer tokens with explicit scopes,
  // used by the Kaiad operator and similar machine integrations). Owner/admin
  // only; api-credential bearers cannot create or revoke other credentials. ---

  app.post("/api/v1/admin/api-credentials", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    if (session.kind === "apiCredential" || (session.role !== "owner" && session.role !== "admin")) {
      return reply.status(403).send(apiErrorSchema.parse({ code: "FORBIDDEN", message: "Owner or admin session required", correlationId: (req as any).correlationId }));
    }
    const parsed = createApiCredentialRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(apiErrorSchema.parse({ code: "BAD_REQUEST", message: parsed.error.issues[0]?.message ?? "Invalid request", correlationId: (req as any).correlationId }));
    }
    const { metadata, token } = await createApiCredentialForTenant({
      tenantId: session.tenantId,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      createdBy: session.id
    });
    return createApiCredentialResponseSchema.parse({ ...metadata, token });
  });

  app.get("/api/v1/admin/api-credentials", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    if (session.kind === "apiCredential" || (session.role !== "owner" && session.role !== "admin")) {
      return reply.status(403).send(apiErrorSchema.parse({ code: "FORBIDDEN", message: "Owner or admin session required", correlationId: (req as any).correlationId }));
    }
    const credentials = await listApiCredentialsForTenant(session.tenantId);
    return listApiCredentialsResponseSchema.parse({
      credentials: credentials.map((c) => apiCredentialMetadataSchema.parse(c))
    });
  });

  app.delete<{ Params: { id: string } }>("/api/v1/admin/api-credentials/:id", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    if (session.kind === "apiCredential" || (session.role !== "owner" && session.role !== "admin")) {
      return reply.status(403).send(apiErrorSchema.parse({ code: "FORBIDDEN", message: "Owner or admin session required", correlationId: (req as any).correlationId }));
    }
    const ok = await revokeApiCredentialForTenant(session.tenantId, req.params.id);
    if (!ok) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Credential not found or already revoked", correlationId: (req as any).correlationId }));
    }
    return reply.status(204).send();
  });

  app.post("/api/v1/agents/enrollment-tokens", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    if (session.kind === "apiCredential" && !hasScope(session, "enrollment-tokens.create")) {
      return reply.status(403).send(
        apiErrorSchema.parse({
          code: "FORBIDDEN",
          message: "API credential lacks scope 'enrollment-tokens.create'",
          correlationId: (req as any).correlationId
        })
      );
    }
    const body = createEnrollmentTokenRequestSchema.parse(req.body);
    try {
      const { response } = await createEnrollmentTokenForTenant({
        tenantId: session.tenantId,
        createdBy: session.id,
        ttlSeconds: body.ttlSeconds
      });
      return createEnrollmentTokenResponseSchema.parse(response);
    } catch (err) {
      return reply.status(503).send(
        apiErrorSchema.parse({
          code: "ENROLLMENT_STORE_UNAVAILABLE",
          message: err instanceof Error ? err.message : "Enrollment token store unavailable",
          correlationId: (req as any).correlationId
        })
      );
    }
  });

  app.get("/api/v1/agents/enrollment-tokens", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    try {
      // Defaults: only ACTIVE tokens, capped at 50 most-recent rows.
      // Without these defaults the panel can render thousands of rows
      // (operators that re-mint on every reconcile, plus accumulated
      // expired/used tokens) and spend ~400 ms blocking the main thread.
      // Override with `?includeInactive=true` (caller wants the full
      // list) and/or `?limit=N` (caller wants more than 50). Hard cap
      // 500 so a misbehaving caller can't ask for ten thousand.
      const HARD_CAP = 500;
      const DEFAULT_LIMIT = 50;
      const q = req.query as Record<string, string | undefined>;
      const includeInactive = q.includeInactive === "true" || q.includeInactive === "1";
      const requestedLimit = q.limit ? Number.parseInt(q.limit, 10) : DEFAULT_LIMIT;
      const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, HARD_CAP)
        : DEFAULT_LIMIT;
      const all = await listEnrollmentTokensForTenant(session.tenantId);
      const filtered = includeInactive ? all : all.filter((t) => t.isActive);
      const sorted = [...filtered].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      const capped = sorted.slice(0, limit);
      return listEnrollmentTokensResponseSchema.parse({ tokens: capped });
    } catch (err) {
      return reply.status(503).send(
        apiErrorSchema.parse({
          code: "ENROLLMENT_STORE_UNAVAILABLE",
          message: err instanceof Error ? err.message : "Enrollment token store unavailable",
          correlationId: (req as any).correlationId
        })
      );
    }
  });

  app.post<{ Params: { tokenId: string } }>("/api/v1/agents/enrollment-tokens/:tokenId/deactivate", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    try {
      const outcome = await deactivateEnrollmentTokenForTenant(session.tenantId, req.params.tokenId);
      if (outcome === "not_found") {
        return reply.status(404).send(
          apiErrorSchema.parse({
            code: "NOT_FOUND",
            message: "Enrollment token not found",
            correlationId: (req as any).correlationId
          })
        );
      }
      if (outcome === "not_revocable") {
        return reply.status(409).send(
          apiErrorSchema.parse({
            code: "ENROLLMENT_TOKEN_NOT_REVOCABLE",
            message: "Enrollment token cannot be deactivated (already used, revoked, or expired)",
            correlationId: (req as any).correlationId
          })
        );
      }
      return reply.status(204).send();
    } catch (err) {
      return reply.status(503).send(
        apiErrorSchema.parse({
          code: "ENROLLMENT_STORE_UNAVAILABLE",
          message: err instanceof Error ? err.message : "Enrollment token store unavailable",
          correlationId: (req as any).correlationId
        })
      );
    }
  });

  app.delete<{ Params: { tokenId: string } }>("/api/v1/agents/enrollment-tokens/:tokenId", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    try {
      const deleted = await deleteEnrollmentTokenForTenant(session.tenantId, req.params.tokenId);
      if (!deleted) {
        return reply.status(404).send(
          apiErrorSchema.parse({
            code: "NOT_FOUND",
            message: "Enrollment token not found",
            correlationId: (req as any).correlationId
          })
        );
      }
      return reply.status(204).send();
    } catch (err) {
      return reply.status(503).send(
        apiErrorSchema.parse({
          code: "ENROLLMENT_STORE_UNAVAILABLE",
          message: err instanceof Error ? err.message : "Enrollment token store unavailable",
          correlationId: (req as any).correlationId
        })
      );
    }
  });

  // Operator install bundle download. Renders a single YAML containing the
  // CRD, namespace, ServiceAccount, ClusterRole, ClusterRoleBinding, and
  // Deployment needed to run the Kaiad operator. Unauthenticated by design:
  // contains no tenant-specific data, just static manifests templated with
  // the operator namespace + image. The panel UI links to this endpoint as
  // a download for the "Step 0 — install operator" section.
  app.get("/api/v1/operator/install.yaml", async (req, reply) => {
    const parsed = parseOperatorInstallOptions(
      req.query as Record<string, string | string[] | undefined>
    );
    if (!parsed.ok) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "INVALID_REQUEST",
          message: parsed.reason,
          correlationId: (req as any).correlationId
        })
      );
    }
    const yaml = buildOperatorInstallYaml(parsed.value);
    reply.header("Content-Type", "application/yaml; charset=utf-8");
    reply.header(
      "Content-Disposition",
      'attachment; filename="kaiad-operator-install.yaml"'
    );
    return reply.send(yaml);
  });

  // --- SSH Keys ---

  app.get("/api/v1/ssh-keys", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    const keys = await domainStore.listSshKeys(session.tenantId);
    return listSshKeysResponseSchema.parse({ keys });
  });

  app.post("/api/v1/ssh-keys", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    const payload = createSshKeyRequestSchema.parse(req.body);
    const key = await domainStore.createSshKey(session.tenantId, {
      name: payload.name,
      type: payload.type,
      privateKey: payload.privateKey,
      localPath: payload.localPath
    });
    return reply.status(201).send(key);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/ssh-keys/:id", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    const deleted = await domainStore.deleteSshKey(session.tenantId, req.params.id);
    if (!deleted) {
      return reply.status(404).send(
        apiErrorSchema.parse({
          code: "NOT_FOUND",
          message: "SSH key not found",
          correlationId: (req as any).correlationId
        })
      );
    }
    return reply.status(204).send();
  });

  app.post("/api/v1/internal/agent-commands", async (req, reply) => {
    const internalToken = resolveInternalApiToken(process.env);
    if (!internalToken) {
      return reply.status(503).send(
        apiErrorSchema.parse({
          code: "INTERNAL_TOKEN_UNCONFIGURED",
          message: "INTERNAL_API_TOKEN must be configured in production",
          correlationId: (req as any).correlationId
        })
      );
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${internalToken}`) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid internal bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    const job = agentCommandJobSchema.parse(req.body);
    const rawPayload =
      job.payload && typeof job.payload === "object" ? (job.payload as Record<string, unknown>) : {};
    const commandCandidate = { ...rawPayload, commandId: rawPayload.commandId ?? job.commandId };
    const command = platformToAgentMessageSchema.parse(commandCandidate);
    let dispatchResult: Awaited<ReturnType<typeof realtimeManager.sendCommand>>;
    try {
      dispatchResult = await realtimeManager.sendCommand(job.agentId, JSON.stringify(command));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to enqueue agent command";
      const isBackpressure = message.startsWith("Backpressure:");
      const isDurabilityGap = message.includes("no durable command queue");
      const status = isBackpressure ? 429 : isDurabilityGap ? 503 : 500;
      return reply.status(status).send(
        apiErrorSchema.parse({
          code:
            status === 429
              ? "BACKPRESSURE"
              : status === 503
                ? "COMMAND_DURABILITY_UNAVAILABLE"
                : "INTERNAL_ERROR",
          message,
          correlationId: (req as any).correlationId
        })
      );
    }
    return reply.status(202).send(
      agentCommandDispatchResponseSchema.parse({
        accepted: true as const,
        commandId: job.commandId,
        queued: dispatchResult.queued,
        delivered: dispatchResult.delivered
      })
    );
  });

  // --- Incidents ---

  app.get("/api/v1/incidents", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const incidents = await domainStore.listIncidents(session.tenantId);
    return listIncidentsResponseSchema.parse({ incidents });
  });

  app.get<{ Params: { id: string } }>("/api/v1/incidents/:id", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const incident = await domainStore.getIncident(session.tenantId, req.params.id);
    if (!incident) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Incident not found", correlationId: (req as any).correlationId }));
    }
    return incident;
  });

  app.patch<{ Params: { id: string } }>("/api/v1/incidents/:id/status", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const body = updateIncidentStatusRequestSchema.parse(req.body);
    const updated = await domainStore.updateIncidentStatus(session.tenantId, req.params.id, body.status);
    if (!updated) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Incident not found", correlationId: (req as any).correlationId }));
    }
    return updated;
  });

  // --- Agents ---

  app.get("/api/v1/agents", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const agents = await domainStore.listAgents(session.tenantId);
    const connected = new Set(realtimeManager.getConnectedAgentIds());
    const agentsWithPresence = agents.map((a) => {
      const rawStats = realtimeManager.getHostStats(a.id);
      let telemetry: AgentTelemetry | undefined;
      if (rawStats !== undefined) {
        const parsed = hostStatsSchema.safeParse(rawStats);
        if (parsed.success) {
          const { type: _type, agentId: _agentId, ...rest } = parsed.data;
          telemetry = rest;
        }
      }
      const apps: AgentAppTelemetry[] = [];
      for (const raw of realtimeManager.getAppStats(a.id)) {
        const parsedApp = appStatsSchema.safeParse(raw);
        if (parsedApp.success) {
          const { type: _t, agentId: _a, ...rest } = parsedApp.data;
          apps.push(rest);
        }
      }
      return {
        ...a,
        websocketConnected: connected.has(a.id),
        ...(telemetry ? { telemetry } : {}),
        ...(apps.length > 0 ? { apps } : {})
      };
    });
    return listAgentsResponseSchema.parse({ agents: agentsWithPresence });
  });

  app.get<{ Params: { id: string } }>("/api/v1/agents/:id", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const agent = await domainStore.getAgent(session.tenantId, req.params.id);
    if (!agent) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Agent not found", correlationId: (req as any).correlationId }));
    }
    const connected = realtimeManager.getConnectedAgentIds().includes(agent.id);
    return { ...agent, websocketConnected: connected };
  });

  app.patch<{ Params: { id: string } }>("/api/v1/agents/:id", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    if (session.role !== "owner" && session.role !== "admin") {
      return reply.status(403).send(apiErrorSchema.parse({ code: "FORBIDDEN", message: "Admin access required", correlationId: (req as any).correlationId }));
    }
    const parsed = updateAgentRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: parsed.error.issues[0]?.message ?? "Invalid agent update payload",
          correlationId: (req as any).correlationId
        })
      );
    }
    // Snapshot the prior env BEFORE the update so we can detect
    // env-change and trigger redeploys on services whose resolved
    // config differs across the old/new env.
    const prior = await domainStore.getAgent(session.tenantId, req.params.id);
    const updated = await domainStore.updateAgent(session.tenantId, req.params.id, parsed.data);
    if (!updated) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Agent not found", correlationId: (req as any).correlationId }));
    }
    if (
      parsed.data.environment !== undefined &&
      prior &&
      prior.environment !== updated.environment
    ) {
      // Run after the response is sent — redeploy fan-out can be slow
      // (one HTTP POST per service), and the caller doesn't need to
      // wait. The helper logs/skips errors per-service.
      const tenantId = session.tenantId;
      const agentId = req.params.id;
      const oldEnv = prior.environment;
      const newEnv = updated.environment;
      setImmediate(() => {
        redeployAgentForEnvChange(tenantId, agentId, oldEnv, newEnv).catch((err) =>
          req.log?.warn?.(
            { err: (err as Error).message, agentId, oldEnv, newEnv },
            "redeployAgentForEnvChange failed"
          )
        );
      });
    }
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/v1/agents/:id", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    if (session.role !== "owner" && session.role !== "admin") {
      return reply.status(403).send(apiErrorSchema.parse({ code: "FORBIDDEN", message: "Admin access required", correlationId: (req as any).correlationId }));
    }
    const deleted = await domainStore.deleteAgent(session.tenantId, req.params.id);
    if (!deleted) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Agent not found", correlationId: (req as any).correlationId }));
    }
    realtimeManager.disconnectAgent(req.params.id);
    return reply.status(204).send();
  });

  // --- Error groups ---

  app.get("/api/v1/error-groups", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    return { groups: errorGroups.listForTenant(session.tenantId) };
  });

  app.get<{ Params: { agentId: string } }>("/api/v1/agents/:agentId/error-groups", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    return { groups: errorGroups.listForAgent(session.tenantId, req.params.agentId) };
  });

  app.get<{ Params: { id: string } }>("/api/v1/services/:id/error-groups", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    return { groups: errorGroups.listForService(session.tenantId, req.params.id) };
  });

  // --- Monitored Services ---

  app.get("/api/v1/services", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const svcs = await domainStore.listServices(session.tenantId);
    return { services: svcs };
  });

  app.post("/api/v1/services", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const body = createMonitoredServiceRequestSchema.parse(req.body);
    const raw = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const svc = await domainStore.createService(session.tenantId, {
      ...body,
      dockerImage:
        body.dockerImage
        ?? (typeof raw.dockerImage === "string" && raw.dockerImage.trim().length > 0 ? raw.dockerImage : undefined),
      composePath:
        body.composePath
        ?? (typeof raw.composePath === "string" && raw.composePath.trim().length > 0 ? raw.composePath : undefined)
    });
    return reply.status(201).send(svc);
  });

  app.patch<{ Params: { id: string } }>("/api/v1/services/:id", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const parsed = updateMonitoredServiceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: parsed.error.issues[0]?.message ?? "Invalid service update payload",
          correlationId: (req as any).correlationId
        })
      );
    }
    const updated = await domainStore.updateService(session.tenantId, req.params.id, parsed.data);
    if (!updated) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Service not found", correlationId: (req as any).correlationId }));
    }
    return updated;
  });


  // ── Load-balancer rollup ────────────────────────────────────────────
  // Joins service_loadbalancer_status (filled by agents reporting
  // post-redeploy) with the bound services + their resolved domains/
  // ports. The panel's Load Balancers page calls this to render
  // domain → external IP : port across every service this tenant has.
  app.get("/api/v1/load-balancers", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply
        .status(401)
        .send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const q = await getBuildsQuery();
    if (!q) return { entries: [] };
    const rows = await listLoadBalancerStatusForTenant(q, session.tenantId);
    const services = await domainStore.listServices(session.tenantId);
    const byId = new Map(services.map((s) => [s.id, s]));
    // Pre-fetch the tenant's agents once so we can resolve each row's
    // owner-agent runtime without one query per row. Listing agents
    // is small (tens of rows) so this is the right shape.
    const agentList = await domainStore.listAgents(session.tenantId);
    const agentRuntimeById = new Map(
      agentList.map((a) => [a.id, a.runtimeBackend ?? null] as const)
    );
    const entries = rows.map((r: LoadBalancerStatusRow) => {
      const svc = byId.get(r.serviceId);
      return {
        id: r.id,
        serviceId: r.serviceId,
        serviceName: svc?.name ?? r.serviceId,
        agentId: r.agentId,
        agentRuntime: r.agentId ? agentRuntimeById.get(r.agentId) ?? null : null,
        environment: r.environment,
        namespace: r.namespace,
        lbType: r.lbType,
        externalIp: r.externalIp,
        externalHostname: r.externalHostname,
        ports: r.ports,
        domains: r.domains,
        detail: r.detail,
        observedAt: r.observedAt
      };
    });
    return { entries };
  });

  app.delete<{ Params: { id: string } }>("/api/v1/services/:id", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const deleted = await domainStore.deleteService(session.tenantId, req.params.id);
    if (!deleted) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Service not found", correlationId: (req as any).correlationId }));
    }
    return reply.status(204).send();
  });

  // ── Build pipeline (read-only API) ───────────────────────────────────────
  // The worker INSERTs and UPDATEs these rows directly via @sm/db; this
  // surface is panel-side reads only. We keep the routes scoped under
  // /services/:id/... because every build is per-service — there's no
  // global "all builds" query mode we want to expose.
  //
  // Lazy pool: build endpoints only need the DB when called, and the
  // memory store fallback never has builds anyway. We open one process-
  // wide Pool on first hit and reuse it.
  let buildsQueryFn: QueryFn | null | undefined;
  async function getBuildsQuery(): Promise<QueryFn | null> {
    if (buildsQueryFn !== undefined) return buildsQueryFn;
    const url = process.env.DATABASE_URL;
    if (!url?.trim()) {
      buildsQueryFn = null;
      return null;
    }
    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: url });
      await ensureCoreSchema(pool);
      buildsQueryFn = async (sql: string, params: unknown[]) => {
        const r = await pool.query(sql, params as unknown[]);
        return { rows: r.rows as Record<string, unknown>[] };
      };
      return buildsQueryFn;
    } catch (err) {
      app.log.error({ err }, "builds query pool init failed");
      buildsQueryFn = null;
      return null;
    }
  }

  app.get<{ Params: { id: string } }>("/api/v1/services/:id/builds", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply
        .status(401)
        .send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const svc = await domainStore.getService(session.tenantId, req.params.id);
    if (!svc) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Service not found", correlationId: (req as any).correlationId }));
    }
    const q = await getBuildsQuery();
    if (!q) return { builds: [] };
    const builds = await listBuildsForService(q, session.tenantId, req.params.id);
    return { builds };
  });

  // Manual build trigger. Inserts a queued row with empty git_sha; the
  // worker resolves HEAD via git ls-remote on claim. After success, the
  // worker dispatches a redeploy_service command to every bound agent.
  // Owner/admin-only — manual builds bypass the poll dedupe and emit
  // agent commands, so they need a real session.
  app.post<{ Params: { id: string } }>("/api/v1/services/:id/builds", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply
        .status(401)
        .send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    if (session.kind === "apiCredential" || (session.role !== "owner" && session.role !== "admin")) {
      return reply.status(403).send(
        apiErrorSchema.parse({
          code: "FORBIDDEN",
          message: "Owner or admin session required to trigger a build",
          correlationId: (req as any).correlationId
        })
      );
    }
    const svc = await domainStore.getService(session.tenantId, req.params.id);
    if (!svc) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Service not found", correlationId: (req as any).correlationId }));
    }
    const q = await getBuildsQuery();
    if (!q) {
      return reply.status(503).send(
        apiErrorSchema.parse({
          code: "BUILDS_UNAVAILABLE",
          message: "Build pipeline requires a postgres backend",
          correlationId: (req as any).correlationId
        })
      );
    }
    const build = await enqueueManualBuild(q, {
      tenantId: session.tenantId,
      serviceId: svc.id,
      branch: svc.branch
    });
    return reply.status(202).send({ build });
  });

  app.get<{ Params: { id: string; buildId: string } }>(
    "/api/v1/services/:id/builds/:buildId",
    async (req, reply) => {
      const session = await resolveSession(authStore, req.headers.authorization);
      if (!session) {
        return reply
          .status(401)
          .send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
      }
      const svc = await domainStore.getService(session.tenantId, req.params.id);
      if (!svc) {
        return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Service not found", correlationId: (req as any).correlationId }));
      }
      const q = await getBuildsQuery();
      if (!q) {
        return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Build not found", correlationId: (req as any).correlationId }));
      }
      const build = await getBuild(q, session.tenantId, req.params.buildId);
      if (!build || build.serviceId !== req.params.id) {
        return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Build not found", correlationId: (req as any).correlationId }));
      }
      const artifacts = await listBuildArtifacts(q, build.id);
      return { build, artifacts };
    }
  );

  app.get<{ Params: { id: string; buildId: string; name: string } }>(
    "/api/v1/services/:id/builds/:buildId/artifacts/:name",
    async (req, reply) => {
      const session = await resolveSession(authStore, req.headers.authorization);
      if (!session) {
        return reply
          .status(401)
          .send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
      }
      const q = await getBuildsQuery();
      if (!q) {
        return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Artifact not found", correlationId: (req as any).correlationId }));
      }
      const build = await getBuild(q, session.tenantId, req.params.buildId);
      if (!build || build.serviceId !== req.params.id) {
        return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Artifact not found", correlationId: (req as any).correlationId }));
      }
      const artifact = await getBuildArtifact(q, build.id, req.params.name);
      if (!artifact) {
        return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Artifact not found", correlationId: (req as any).correlationId }));
      }
      // Stream the file from disk. Path is constructed safely from the
      // recorded rel_path (sanitized at insert time) so a crafted artifact
      // name can't escape KAIAD_DATA_DIR/builds/<id>/.
      const dataDir = process.env.KAIAD_DATA_DIR ?? "/data";
      const fsMod = await import("node:fs/promises");
      const pathMod = await import("node:path");
      const filePath = pathMod.join(dataDir, "builds", build.id, artifact.relPath);
      try {
        const data = await fsMod.readFile(filePath);
        reply.header("Content-Type", "application/octet-stream");
        reply.header("Content-Disposition", `attachment; filename="${artifact.name.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
        reply.header("Content-Length", String(data.length));
        return reply.send(data);
      } catch {
        return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Artifact file missing on disk", correlationId: (req as any).correlationId }));
      }
    }
  );

  // --- Many-to-many agent ↔ service binding ------------------------------
  // The data layer keeps these as a join table so a service can run on
  // multiple agents (HA, multi-cluster) and an agent can be observing many
  // services. Both directions are editable from the panel.

  app.get<{ Params: { agentId: string } }>("/api/v1/agents/:agentId/services", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const services = await domainStore.listServicesForAgent(session.tenantId, req.params.agentId);
    return listServicesForAgentResponseSchema.parse({ services });
  });

  // Running-version snapshot per agent. The agents page joins this
  // with the bound-services list to render "service X currently
  // running build abc12345 / image panel.dev.kaiad.dev/...:abc12345"
  // inline. Returns the most recent lb_status_report row per
  // (service, env), filtered to this agent.
  app.get<{ Params: { agentId: string } }>(
    "/api/v1/agents/:agentId/running-services",
    async (req, reply) => {
      const session = await resolveSession(authStore, req.headers.authorization);
      if (!session) {
        return reply.status(401).send(
          apiErrorSchema.parse({
            code: "UNAUTHORIZED",
            message: "Missing or invalid bearer token",
            correlationId: (req as any).correlationId
          })
        );
      }
      const q = await getBuildsQuery();
      if (!q) return { running: [] };
      const rows = await listRunningServicesForAgent(q, session.tenantId, req.params.agentId);
      const running = rows.map((r) => ({
        serviceId: r.serviceId,
        environment: r.environment,
        namespace: r.namespace,
        imageRef: r.imageRef,
        buildId: r.buildId,
        observedAt: r.observedAt,
        externalIp: r.externalIp,
        externalHostname: r.externalHostname
      }));
      return { running };
    }
  );

  /**
   * Reconcile pass — for every service this agent is bound to, if no
   * lb_status_report row exists yet, dispatch a redeploy_service for
   * the latest successful build. Idempotent (already-reported services
   * are skipped). Used both via this endpoint and on agent reconnect.
   *
   * The platform fans these out as agent-commands the same way the
   * worker does after a build; this is just the "catch up" entry
   * point for newly-bound agents that never saw the build dispatch.
   */
  async function reconcileAgentDeploys(
    tenantId: string,
    agentId: string
  ): Promise<{ dispatched: number; skipped: string[] }> {
    const q = await getBuildsQuery();
    if (!q) return { dispatched: 0, skipped: [] };

    const agent = await domainStore.getAgent(tenantId, agentId);
    if (!agent) return { dispatched: 0, skipped: [] };
    const env = agent.environment ?? "development";

    const missing = await listMissingDeploysForAgent(q, tenantId, agentId);
    let dispatched = 0;
    const skipped: string[] = [];

    const apiUrl =
      process.env.INTERNAL_API_URL?.trim() ?? `http://127.0.0.1:${process.env.PORT ?? "8092"}`;
    const internalToken = process.env.INTERNAL_API_TOKEN?.trim() || "dev-token";

    for (const m of missing) {
      // Parse the captured pipeline_yaml + pick the right pipeline
      // for this service's pipelineName, then resolve env. If the
      // yaml fails to parse (shouldn't — it parsed at build time)
      // we skip rather than block other services.
      const parsed = parsePipelineYaml(m.pipelineYaml);
      if (!parsed.ok) {
        skipped.push(`${m.serviceName}: kaiad.yaml parse failed (${parsed.reason})`);
        continue;
      }
      const picked = selectPipeline(parsed, m.pipelineName ?? null);
      if (!picked.ok) {
        skipped.push(`${m.serviceName}: ${picked.reason}`);
        continue;
      }
      const resolved = resolveEnvironment(picked.pipeline, env);
      const commandId = crypto.randomUUID();
      const job: AgentCommandJob = {
        agentId,
        commandId,
        payload: {
          type: "redeploy_service",
          commandId,
          serviceId: m.serviceId,
          serviceName: m.serviceName,
          imageRef: m.imageRef,
          buildId: m.buildId,
          environment: env,
          instances: resolved.instances,
          domains: resolved.domains,
          loadBalancer: resolved.loadBalancer,
          namespace: resolved.namespace
        }
      };
      try {
        const res = await fetch(`${apiUrl}/api/v1/internal/agent-commands`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${internalToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(job)
        });
        if (res.ok) dispatched += 1;
        else skipped.push(`${m.serviceName}: dispatch ${res.status}`);
      } catch (err) {
        skipped.push(`${m.serviceName}: ${(err as Error).message}`);
      }
    }
    return { dispatched, skipped };
  }

  // Typed error so the deploy helper can signal HTTP status/code back
  // to either deploy route without coupling to `reply`.
  class DeployError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string
    ) {
      super(message);
    }
  }

  /**
   * Deploy a SPECIFIC build (version) of a service to a set of target
   * agents. Resolves the build's captured kaiad.yaml per each agent's
   * environment and dispatches `redeploy_service` (same payload the
   * post-build auto-redeploy uses). Shared by the Services-page Deploy
   * (all bound agents) and the Agents-page Deploy (one agent).
   */
  async function deployBuildToAgents(
    tenantId: string,
    serviceId: string,
    buildId: string,
    targets: Array<{ agentId: string; environment: string }>
  ): Promise<{
    dispatched: number;
    results: Array<{ agentId: string; delivered: boolean; queued: boolean }>;
    skipped: string[];
  }> {
    const out = {
      dispatched: 0,
      results: [] as Array<{ agentId: string; delivered: boolean; queued: boolean }>,
      skipped: [] as string[]
    };
    const q = await getBuildsQuery();
    if (!q) {
      throw new DeployError(503, "REGISTRY_UNAVAILABLE", "Build store not configured (DATABASE_URL missing)");
    }
    const svc = await domainStore.getService(tenantId, serviceId);
    if (!svc) throw new DeployError(404, "NOT_FOUND", "Service not found");
    const build = await getBuild(q, tenantId, buildId);
    if (!build || build.serviceId !== serviceId) {
      throw new DeployError(404, "NOT_FOUND", "Build not found for this service");
    }
    if (build.status !== "success" || !build.imageRef) {
      throw new DeployError(400, "BAD_REQUEST", "Only a successful build with an image can be deployed");
    }

    // Per-env config from the build's captured kaiad.yaml; pipeline-less
    // or unparseable older builds fall back to safe defaults so the
    // deploy still goes out.
    let pickedPipeline: Parameters<typeof resolveEnvironment>[0] | null = null;
    if (build.pipelineYaml) {
      const parsed = parsePipelineYaml(build.pipelineYaml);
      if (parsed.ok) {
        const picked = selectPipeline(parsed, svc.pipelineName ?? null);
        if (picked.ok) pickedPipeline = picked.pipeline;
      }
    }

    for (const t of targets) {
      const resolved = pickedPipeline
        ? resolveEnvironment(pickedPipeline, t.environment)
        : { instances: 1, domains: [], loadBalancer: { type: "none" }, namespace: "" };
      const commandId = crypto.randomUUID();
      const command = {
        type: "redeploy_service",
        commandId,
        serviceId,
        serviceName: svc.name,
        imageRef: build.imageRef,
        buildId: build.id,
        environment: t.environment,
        instances: resolved.instances,
        domains: resolved.domains,
        loadBalancer: resolved.loadBalancer,
        namespace: resolved.namespace
      };
      try {
        const r = await realtimeManager.sendCommand(t.agentId, JSON.stringify(command));
        out.dispatched += 1;
        out.results.push({
          agentId: t.agentId,
          delivered: !!r.delivered,
          queued: !!r.queued
        });
      } catch (err) {
        out.skipped.push(`${t.agentId}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  function sendDeployError(req: any, reply: any, err: unknown) {
    if (err instanceof DeployError) {
      return reply.status(err.status).send(
        apiErrorSchema.parse({
          code: err.code,
          message: err.message,
          correlationId: (req as any).correlationId
        })
      );
    }
    return reply.status(500).send(
      apiErrorSchema.parse({
        code: "INTERNAL",
        message: err instanceof Error ? err.message : "Deploy failed",
        correlationId: (req as any).correlationId
      })
    );
  }

  // Deploy a chosen version of a service to ALL its bound agents.
  app.post<{ Params: { id: string }; Body: { buildId?: unknown } }>(
    "/api/v1/services/:id/deploy",
    async (req, reply) => {
      const session = await requireAdminSession(req, reply);
      if (!session) return;
      const buildId = (req.body as { buildId?: unknown } | undefined)?.buildId;
      if (typeof buildId !== "string" || !buildId) {
        return reply.status(400).send(
          apiErrorSchema.parse({
            code: "BAD_REQUEST",
            message: "buildId is required",
            correlationId: (req as any).correlationId
          })
        );
      }
      const q = await getBuildsQuery();
      if (!q) {
        return reply.status(503).send(
          apiErrorSchema.parse({
            code: "REGISTRY_UNAVAILABLE",
            message: "Build store not configured (DATABASE_URL missing)",
            correlationId: (req as any).correlationId
          })
        );
      }
      const { rows } = await q(
        `SELECT a.id AS agent_id, a.environment
           FROM agent_services s
           JOIN agents a ON a.id = s.agent_id
          WHERE s.service_id = $1`,
        [req.params.id]
      );
      const targets = rows.map((r) => ({
        agentId: String(r.agent_id),
        environment: String(r.environment ?? "development")
      }));
      try {
        const result = await deployBuildToAgents(
          session.tenantId,
          req.params.id,
          buildId,
          targets
        );
        return { ...result, boundAgents: targets.length };
      } catch (err) {
        return sendDeployError(req, reply, err);
      }
    }
  );

  // Deploy a chosen version of a (bound) service to ONE agent.
  app.post<{ Params: { agentId: string }; Body: { serviceId?: unknown; buildId?: unknown } }>(
    "/api/v1/agents/:agentId/deploy",
    async (req, reply) => {
      const session = await requireAdminSession(req, reply);
      if (!session) return;
      const body = req.body as { serviceId?: unknown; buildId?: unknown } | undefined;
      if (
        typeof body?.serviceId !== "string" || !body.serviceId ||
        typeof body?.buildId !== "string" || !body.buildId
      ) {
        return reply.status(400).send(
          apiErrorSchema.parse({
            code: "BAD_REQUEST",
            message: "serviceId and buildId are required",
            correlationId: (req as any).correlationId
          })
        );
      }
      const agent = await domainStore.getAgent(session.tenantId, req.params.agentId);
      if (!agent) {
        return reply.status(404).send(
          apiErrorSchema.parse({
            code: "NOT_FOUND",
            message: "Agent not found",
            correlationId: (req as any).correlationId
          })
        );
      }
      const q = await getBuildsQuery();
      if (!q) {
        return reply.status(503).send(
          apiErrorSchema.parse({
            code: "REGISTRY_UNAVAILABLE",
            message: "Build store not configured (DATABASE_URL missing)",
            correlationId: (req as any).correlationId
          })
        );
      }
      const { rows } = await q(
        `SELECT 1 FROM agent_services WHERE agent_id = $1 AND service_id = $2 LIMIT 1`,
        [req.params.agentId, body.serviceId]
      );
      if (rows.length === 0) {
        return reply.status(400).send(
          apiErrorSchema.parse({
            code: "BAD_REQUEST",
            message: "Agent is not bound to this service",
            correlationId: (req as any).correlationId
          })
        );
      }
      try {
        return await deployBuildToAgents(session.tenantId, body.serviceId, body.buildId, [
          { agentId: req.params.agentId, environment: agent.environment ?? "development" }
        ]);
      } catch (err) {
        return sendDeployError(req, reply, err);
      }
    }
  );

  /**
   * Re-deploy services bound to an agent whose env just flipped.
   *
   * For each bound service with a successful build, resolve the
   * effective config under the OLD env and the NEW env from the
   * captured pipeline_yaml. Skip if both resolve identically (the
   * env doesn't carve out anything different in kaiad.yaml).
   *
   * When the resolved namespace differs we tear down the old (env, ns)
   * first — otherwise the OLD namespace keeps zombie pods/containers
   * the new config will never reach. When only domains/instances/lb
   * change we redeploy in place; the agent's apply is idempotent on
   * the same namespace.
   */
  async function redeployAgentForEnvChange(
    tenantId: string,
    agentId: string,
    oldEnv: string,
    newEnv: string
  ): Promise<{ redeployed: number; tornDown: number; unchanged: number; skipped: string[] }> {
    const out = { redeployed: 0, tornDown: 0, unchanged: 0, skipped: [] as string[] };
    if (oldEnv === newEnv) return out;
    const q = await getBuildsQuery();
    if (!q) return out;

    const services = await listLatestBuildsForBoundServices(q, tenantId, agentId);
    const apiUrl =
      process.env.INTERNAL_API_URL?.trim() ?? `http://127.0.0.1:${process.env.PORT ?? "8092"}`;
    const internalToken = process.env.INTERNAL_API_TOKEN?.trim() || "dev-token";

    for (const m of services) {
      const parsed = parsePipelineYaml(m.pipelineYaml);
      if (!parsed.ok) {
        out.skipped.push(`${m.serviceName}: kaiad.yaml parse failed (${parsed.reason})`);
        continue;
      }
      const picked = selectPipeline(parsed, m.pipelineName ?? null);
      if (!picked.ok) {
        out.skipped.push(`${m.serviceName}: ${picked.reason}`);
        continue;
      }
      const oldR = resolveEnvironment(picked.pipeline, oldEnv);
      const newR = resolveEnvironment(picked.pipeline, newEnv);
      if (resolvedConfigsEqual(oldR, newR)) {
        out.unchanged += 1;
        continue;
      }

      // Namespace flipped → tear down old first so the cluster doesn't
      // keep zombie resources in the previous namespace. We pop the
      // status row using the agent's recorded last-deployed namespace
      // (which is what the agent will actually find to delete) — that
      // covers the case where a prior kaiad.yaml change moved the
      // service into a different namespace under the old env name.
      if (oldR.namespace !== newR.namespace) {
        try {
          const last = await popLoadBalancerStatusForAgentService(q, tenantId, agentId, m.serviceId);
          const teardownNs = last?.namespace ?? oldR.namespace;
          const teardownEnv = last?.environment ?? oldEnv;
          const tdId = crypto.randomUUID();
          const tdJob: AgentCommandJob = {
            agentId,
            commandId: tdId,
            payload: {
              type: "teardown_service",
              commandId: tdId,
              serviceId: m.serviceId,
              serviceName: m.serviceName,
              environment: teardownEnv,
              namespace: teardownNs
            }
          };
          fetch(`${apiUrl}/api/v1/internal/agent-commands`, {
            method: "POST",
            headers: { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(tdJob)
          }).catch(() => {});
          out.tornDown += 1;
        } catch (err) {
          out.skipped.push(`${m.serviceName}: teardown ${(err as Error).message}`);
        }
      }

      const cmdId = crypto.randomUUID();
      const job: AgentCommandJob = {
        agentId,
        commandId: cmdId,
        payload: {
          type: "redeploy_service",
          commandId: cmdId,
          serviceId: m.serviceId,
          serviceName: m.serviceName,
          imageRef: m.imageRef,
          buildId: m.buildId,
          environment: newEnv,
          instances: newR.instances,
          domains: newR.domains,
          loadBalancer: newR.loadBalancer,
          namespace: newR.namespace
        }
      };
      try {
        const res = await fetch(`${apiUrl}/api/v1/internal/agent-commands`, {
          method: "POST",
          headers: { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(job)
        });
        if (res.ok) out.redeployed += 1;
        else out.skipped.push(`${m.serviceName}: dispatch ${res.status}`);
      } catch (err) {
        out.skipped.push(`${m.serviceName}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  app.post<{ Params: { agentId: string } }>(
    "/api/v1/agents/:agentId/reconcile-deploys",
    async (req, reply) => {
      const session = await resolveSession(authStore, req.headers.authorization);
      if (!session) {
        return reply.status(401).send(
          apiErrorSchema.parse({
            code: "UNAUTHORIZED",
            message: "Missing or invalid bearer token",
            correlationId: (req as any).correlationId
          })
        );
      }
      const result = await reconcileAgentDeploys(session.tenantId, req.params.agentId);
      return result;
    }
  );

  app.post<{ Params: { agentId: string; serviceId: string } }>(
    "/api/v1/agents/:agentId/services/:serviceId",
    async (req, reply) => {
      const session = await resolveSession(authStore, req.headers.authorization);
      if (!session) {
        return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
      }
      // Cross-tenant guard: both agent and service must live in the
      // session's tenant. The store helper already checks that, but we
      // distinguish the 404 (missing) from a validated false (already
      // bound — idempotent).
      const agent = await domainStore.getAgent(session.tenantId, req.params.agentId);
      if (!agent) {
        return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Agent not found", correlationId: (req as any).correlationId }));
      }
      const service = await domainStore.getService(session.tenantId, req.params.serviceId);
      if (!service) {
        return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Service not found", correlationId: (req as any).correlationId }));
      }
      const bound = await domainStore.attachServiceToAgent(
        session.tenantId,
        req.params.agentId,
        req.params.serviceId
      );
      return attachServiceToAgentResponseSchema.parse({
        bound,
        agentId: req.params.agentId,
        serviceId: req.params.serviceId
      });
    }
  );

  app.delete<{ Params: { agentId: string; serviceId: string } }>(
    "/api/v1/agents/:agentId/services/:serviceId",
    async (req, reply) => {
      const session = await resolveSession(authStore, req.headers.authorization);
      if (!session) {
        return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
      }
      const removed = await domainStore.detachServiceFromAgent(
        session.tenantId,
        req.params.agentId,
        req.params.serviceId
      );
      if (!removed) {
        return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Binding not found", correlationId: (req as any).correlationId }));
      }

      // Tear down what the agent had deployed for this service. We
      // pop the last-known status row so the agent gets the right
      // namespace/env to clean up, then dispatch the teardown_service
      // command. Failures are logged but don't fail the detach — the
      // binding is gone either way and an operator can manually
      // clean up if the agent is offline.
      try {
        const q = await getBuildsQuery();
        if (q) {
          const last = await popLoadBalancerStatusForAgentService(
            q,
            session.tenantId,
            req.params.agentId,
            req.params.serviceId
          );
          // Look up the service's display name so the agent can match
          // k8s Services by metadata.name (which is now the service
          // name, not the UUID). Best-effort: if the service row was
          // already deleted, the agent falls back to UUID-based match.
          const svcRow = await domainStore.getService(session.tenantId, req.params.serviceId).catch(() => null);
          const apiUrl =
            process.env.INTERNAL_API_URL?.trim() ?? `http://127.0.0.1:${process.env.PORT ?? "8092"}`;
          const internalToken = process.env.INTERNAL_API_TOKEN?.trim() || "dev-token";
          const commandId = crypto.randomUUID();
          const job: AgentCommandJob = {
            agentId: req.params.agentId,
            commandId,
            payload: {
              type: "teardown_service",
              commandId,
              serviceId: req.params.serviceId,
              serviceName: svcRow?.name ?? "",
              environment: last?.environment ?? "",
              namespace: last?.namespace ?? ""
            }
          };
          fetch(`${apiUrl}/api/v1/internal/agent-commands`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${internalToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(job)
          }).catch((err) =>
            req.log?.warn?.(
              { err: (err as Error).message, agentId: req.params.agentId, serviceId: req.params.serviceId },
              "teardown_service dispatch failed"
            )
          );
        }
      } catch (err) {
        req.log?.warn?.(
          { err: (err as Error).message, agentId: req.params.agentId, serviceId: req.params.serviceId },
          "teardown popLoadBalancerStatus failed"
        );
      }

      return reply.status(204).send();
    }
  );

  /**
   * Deployment drift scheduler.
   *
   * Walks every (agent, bound service) in the system on a fixed cadence
   * and dispatches a redeploy_service whenever the deployed state
   * (`service_loadbalancer_status`) drifts from the desired state
   * (latest successful build + agent's env + resolved kaiad.yaml).
   *
   * The on-connect reconciler covers initial deploys and reconnect
   * gaps; the every-build dispatcher covers new images; the env-change
   * handler covers env flips. This scheduler covers everything else —
   * stale deploys when one of those mechanisms missed (e.g. the agent
   * was offline during a build dispatch and the on-connect reconciler
   * already ran), and any future drift sources we haven't named yet.
   *
   * Drift triggers (any one ⇒ redeploy):
   *   • no status row at all (never deployed)
   *   • currentImageRef ≠ latest imageRef (newer build available)
   *   • currentBuildId ≠ latest buildId (image tag stable but rebuilt)
   *   • currentEnvironment ≠ agent.env (agent moved between envs)
   *   • currentNamespace ≠ resolveEnvironment(yaml, agent.env).namespace
   *     (kaiad.yaml flipped which ns this env deploys into)
   *
   * The scheduler skips agents that aren't currently WebSocket-connected
   * — there's no point dispatching a command to an offline agent, the
   * on-connect reconciler will pick up any drift when they come back.
   */
  const reconcileIntervalMs = (() => {
    const raw = process.env.RECONCILE_INTERVAL_MS?.trim();
    if (!raw) return 60_000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 5_000 ? n : 60_000;
  })();
  const reconcileDisabled =
    process.env.RECONCILE_DISABLED === "1" ||
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true";

  async function reconcileAllDeployments(): Promise<{
    checked: number;
    redeployed: number;
    skipped: number;
  }> {
    const out = { checked: 0, redeployed: 0, skipped: 0 };
    const q = await getBuildsQuery();
    if (!q) return out;

    let targets: Awaited<ReturnType<typeof listAllDeployTargets>>;
    try {
      targets = await listAllDeployTargets(q);
    } catch (err) {
      app.log.warn?.({ err: (err as Error).message }, "reconcile: listAllDeployTargets failed");
      return out;
    }
    if (targets.length === 0) return out;

    const connectedAgents = new Set(realtimeManager.getConnectedAgentIds());
    const apiUrl =
      process.env.INTERNAL_API_URL?.trim() ?? `http://127.0.0.1:${process.env.PORT ?? "8092"}`;
    const internalToken = process.env.INTERNAL_API_TOKEN?.trim() || "dev-token";

    for (const t of targets) {
      out.checked += 1;
      // Skip offline agents — on-connect reconciler will handle them
      // when they return. Saves command-queue churn for agents that
      // are deliberately stopped.
      if (!connectedAgents.has(t.agentId)) {
        out.skipped += 1;
        continue;
      }

      const parsed = parsePipelineYaml(t.pipelineYaml);
      if (!parsed.ok) {
        out.skipped += 1;
        continue;
      }
      const picked = selectPipeline(parsed, t.pipelineName ?? null);
      if (!picked.ok) {
        out.skipped += 1;
        continue;
      }
      const desired = resolveEnvironment(picked.pipeline, t.agentEnv);

      // Namespace comparison: when the kaiad.yaml leaves namespace
      // unset, `desired.namespace` is "" and the agent picks a runtime
      // default (docker→"kaiad", k8s→pod's own ns). The server can't
      // know that default from here, so empty desired ↔ any current
      // is treated as a match — otherwise drift fires forever and
      // teardown+redeploy fight over the same containers.
      const namespaceDrift =
        desired.namespace !== "" &&
        (t.currentNamespace ?? "") !== "" &&
        t.currentNamespace !== desired.namespace;

      const drift =
        t.currentImageRef === null ||
        t.currentBuildId === null ||
        t.currentImageRef !== t.imageRef ||
        t.currentBuildId !== t.buildId ||
        t.currentEnvironment !== t.agentEnv ||
        namespaceDrift;

      if (!drift) continue;

      // Namespace flip → tear down the old (env, ns) first so the
      // cluster doesn't accumulate zombie resources in the previous
      // namespace. We AWAIT the teardown's enqueue response so the
      // redeploy can't beat it into the agent's command queue —
      // otherwise the agent processes redeploy first, then teardown
      // wipes what we just deployed. Failures fall through to the
      // redeploy: the binding's last-known row is still popped.
      if (namespaceDrift && t.currentNamespace) {
        try {
          await popLoadBalancerStatusForAgentService(q, t.tenantId, t.agentId, t.serviceId);
          const tdId = crypto.randomUUID();
          const tdJob: AgentCommandJob = {
            agentId: t.agentId,
            commandId: tdId,
            payload: {
              type: "teardown_service",
              commandId: tdId,
              serviceId: t.serviceId,
              serviceName: t.serviceName,
              environment: t.currentEnvironment ?? t.agentEnv,
              namespace: t.currentNamespace
            }
          };
          await fetch(`${apiUrl}/api/v1/internal/agent-commands`, {
            method: "POST",
            headers: { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(tdJob)
          }).catch((err) =>
            app.log.warn?.(
              { err: (err as Error).message, agentId: t.agentId, serviceId: t.serviceId },
              "reconcile: teardown dispatch failed"
            )
          );
        } catch (err) {
          app.log.warn?.(
            { err: (err as Error).message, agentId: t.agentId, serviceId: t.serviceId },
            "reconcile: teardown failed"
          );
        }
      }

      const cmdId = crypto.randomUUID();
      const job: AgentCommandJob = {
        agentId: t.agentId,
        commandId: cmdId,
        payload: {
          type: "redeploy_service",
          commandId: cmdId,
          serviceId: t.serviceId,
          serviceName: t.serviceName,
          imageRef: t.imageRef,
          buildId: t.buildId,
          environment: t.agentEnv,
          instances: desired.instances,
          domains: desired.domains,
          loadBalancer: desired.loadBalancer,
          namespace: desired.namespace
        }
      };
      try {
        const res = await fetch(`${apiUrl}/api/v1/internal/agent-commands`, {
          method: "POST",
          headers: { Authorization: `Bearer ${internalToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(job)
        });
        if (res.ok) out.redeployed += 1;
        else out.skipped += 1;
      } catch (err) {
        out.skipped += 1;
        app.log.warn?.(
          { err: (err as Error).message, agentId: t.agentId, serviceId: t.serviceId },
          "reconcile: redeploy dispatch failed"
        );
      }
    }
    return out;
  }

  // Manual trigger — handy for ops + integration tests. No auth gate
  // needed beyond the standard session check; the action is idempotent
  // per drift state.
  app.post("/api/v1/internal/reconcile-all", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(
        apiErrorSchema.parse({
          code: "UNAUTHORIZED",
          message: "Missing or invalid bearer token",
          correlationId: (req as any).correlationId
        })
      );
    }
    if (session.role !== "owner" && session.role !== "admin") {
      return reply.status(403).send(
        apiErrorSchema.parse({
          code: "FORBIDDEN",
          message: "Admin access required",
          correlationId: (req as any).correlationId
        })
      );
    }
    const result = await reconcileAllDeployments();
    return result;
  });

  // Periodic loop. setInterval (not setTimeout-chain) is fine: each
  // tick re-reads connectedAgents + the targets list, so a slow tick
  // doesn't compound on later ones; concurrent ticks are guarded by
  // a simple in-flight flag so we don't pile up redeploys when the
  // DB or downstream is slow.
  let reconcileInFlight = false;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  if (!reconcileDisabled) {
    reconcileTimer = setInterval(() => {
      if (reconcileInFlight) return;
      reconcileInFlight = true;
      reconcileAllDeployments()
        .catch((err) => app.log.warn?.({ err: (err as Error).message }, "reconcile loop failed"))
        .finally(() => {
          reconcileInFlight = false;
        });
    }, reconcileIntervalMs);
    // Don't keep the event loop alive solely for this timer.
    reconcileTimer.unref?.();
    app.log.info?.(
      { intervalMs: reconcileIntervalMs },
      "deployment drift scheduler started"
    );
  }
  app.addHook("onClose", async () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (
      req.method === "GET" &&
      !req.url.startsWith("/api/") &&
      !req.url.startsWith("/webhooks/") &&
      req.url !== "/health" &&
      req.url !== "/ready" &&
      req.url !== "/realtime"
    ) {
      return reply.sendFile("index.html");
    }
    return reply.status(404).send({ code: "NOT_FOUND", message: "Route not found" });
  });

  return Object.assign(app, { realtimeManager, ensureBundledImagesPublished });
}

/** Avoid auto-listen in test runners; allow normal `node dist/server.js` startup. */
if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  void (async () => {
  bootstrapEnv();
  const store = createMemoryAuthStore();
  const seedDevCredentials =
    process.env.NODE_ENV !== "production" || process.env.SM_ALLOW_DEV_TOKEN === "1";
  if (seedDevCredentials) {
    seedDevUser(store).catch(() => {});
  }
  if (process.env.NODE_ENV !== "production") {
    seedGoogleProviderFromEnv();
  }

  const swappableStore = createSwappableAuthStore(store);
  let currentQueueWiring = createRuntimeQueueWiringFromEnv(process.env);
  if (!currentQueueWiring) {
    console.error("[api] REDIS_DISABLED=1 — queue-backed async paths are disabled");
  }

  const persisted = readConfig();
  const activeDbUrl = process.env.DATABASE_URL?.trim() || persisted?.databaseUrl?.trim();
  const isSetup = persisted?.setupComplete || !!process.env.DATABASE_URL;

  if (isSetup && activeDbUrl) {
    try {
      await swapAuthStoreToPostgres(swappableStore, activeDbUrl);
      console.error("[api] Auth store: Postgres");
    } catch (err) {
      console.error("[api] Failed to attach Postgres auth store at startup:", err);
    }
  }

  const onSetupComplete: SetupCompleteCallback = async (config: KaiadConfig) => {
    console.error("[api] Setup complete — hot-reloading runtime...");

    if (config.databaseUrl) process.env.DATABASE_URL = config.databaseUrl;
    if (config.redisUrl) process.env.REDIS_URL = config.redisUrl;
    if (config.publicBaseUrl) process.env.PUBLIC_BASE_URL = config.publicBaseUrl;
    if (config.internalApiToken) process.env.INTERNAL_API_TOKEN = config.internalApiToken;
    if (config.internalApiUrl) process.env.INTERNAL_API_URL = config.internalApiUrl;
    if (config.defaultWebhookTenantId) process.env.DEFAULT_WEBHOOK_TENANT_ID = config.defaultWebhookTenantId;
    if (config.oauth?.googleClientId) {
      process.env.GOOGLE_CLIENT_ID = config.oauth.googleClientId;
      process.env.GOOGLE_CLIENT_SECRET = config.oauth.googleClientSecret ?? "";
    }
    if (config.kubernetes?.namespace) {
      process.env.KAIAD_K8S_NAMESPACE = config.kubernetes.namespace;
    }

    const setupDbUrl = config.databaseUrl?.trim();
    if (setupDbUrl) {
      try {
        await swapAuthStoreToPostgres(swappableStore, setupDbUrl);
        console.error("[api] Auth store swapped to Postgres");
      } catch (err) {
        console.error("[api] Failed to create Postgres auth store:", err);
      }
    }

    if (config.oauth?.googleClientId) {
      seedGoogleProviderFromEnv();
      console.error("[api] Google OAuth provider seeded");
    }

    if (!currentQueueWiring) {
      const newWiring = createRuntimeQueueWiringFromEnv(process.env);
      if (newWiring) {
        currentQueueWiring = newWiring;
        console.error("[api] Queue wiring initialized (note: already-registered routes still use noop enqueue — restart recommended for full queue support)");
      }
    }

    console.error("[api] Hot-reload complete");
  };

  const app = buildServer({
    authStore: swappableStore,
    onSetupComplete,
    ...(currentQueueWiring?.buildOptions ?? {}),
  });
  let shutdownFn = async () => {
    await currentQueueWiring?.close().catch(() => {});
    await app.close().catch(() => {});
  };

  try {
    await app.listen({ port: Number(process.env.PORT ?? 3001), host: "0.0.0.0" });
    if (process.env.SM_EMBED_WORKER === "1") {
      const port = Number(process.env.PORT ?? 3001);
      if (!process.env.INTERNAL_API_URL) {
        process.env.INTERNAL_API_URL = `http://127.0.0.1:${port}`;
      }
      try {
        const mod = await import("@sm/worker/runtime");
        const { connection: wc, workers: wi, buildLoops } = mod.startQueueConsumersFromEnv(process.env);
        if (wi.length > 0) {
          console.error(`[api] Embedded worker: ${wi.length} BullMQ consumer(s) started`);
        } else {
          console.error("[api] Embedded worker: no consumers started (REDIS_DISABLED?)");
        }
        const prev = shutdownFn;
        shutdownFn = async () => {
          await mod.shutdownWorkersAndRedis(wi, wc, buildLoops).catch(() => {});
          await prev();
        };
      } catch (err) {
        console.error("[api] Failed to start embedded worker:", err);
      }
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Ensure the baked agent + operator images are published + public.
  // Runs after listen so the loopback /v2 endpoint it pushes to is
  // accepting connections. Detached: self-logs, never throws, must not
  // delay readiness.
  void app.ensureBundledImagesPublished();

  process.on("SIGTERM", () => {
    void shutdownFn();
  });
  process.on("SIGINT", () => {
    void shutdownFn();
  });
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
