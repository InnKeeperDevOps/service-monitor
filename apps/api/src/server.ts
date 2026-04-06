import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapEnv, isSetupRequired } from "./bootstrapEnv.js";
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
  executeWorkflowRequestSchema,
  executeWorkflowResponseSchema,
  workflowDryRunResponseSchema,
  createWorkflowGraphRequestSchema,
  githubInstallationsResponseSchema,
  githubPolicyCheckRequestSchema,
  healthResponseSchema,
  listAgentsResponseSchema,
  listEnrollmentTokensResponseSchema,
  listIncidentsResponseSchema,
  listWorkflowGraphsResponseSchema,
  listAuthProvidersResponseSchema,
  meResponseSchema,
  oauthAuthorizeResponseSchema,
  oauthCallbackResponseSchema,
  updateIncidentStatusRequestSchema,
  upsertGithubInstallationRequestSchema,
  setServiceWorkflowRequestSchema,
  upsertTenantSettingsRequestSchema,
  agentCommandDispatchResponseSchema,
  platformToAgentMessageSchema,
  type AgentToPlatformMessage,
  type AgentCommandJob,
  type GithubWebhookJobPayload,
  type LogIngestionJob,
  type TenantSettings
} from "@sm/contracts";
import {
  WORKFLOW_NODE_TYPES,
  topologicalWaves,
  validateWorkflowGraph as validateDomainWorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeType
} from "@sm/domain";
import { getInstallationMetadata } from "@sm/github";
import { correlationIdPlugin } from "./correlationId.js";
import {
  loginWithDiagnostics,
  resolveSession,
  generateSessionToken,
  hashToken,
  type AuthStore,
  type LoginTraceStep
} from "./auth.js";
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
  validateEnrollmentToken
} from "./enrollmentStore.js";
import { createMemoryAuthStore, seedDevUser } from "./memoryAuthStore.js";
import { createPostgresAuthStore } from "./postgresAuthStore.js";
import { readConfig, type KaiadConfig } from "./configPersistence.js";
import { enforcePolicy } from "./policy.js";
import { createReadinessCheckersFromEnv, type ReadinessChecker } from "./readyChecks.js";
import { RealtimeManager, type PendingCommandRedis } from "./realtimeManager.js";
import {
  getTenantSettings,
  listGithubInstallationsForTenant,
  upsertGithubInstallationForTenant,
  upsertTenantSettings
} from "./store.js";
import { createNamedQueue, createRedisConnectionFromEnv } from "@sm/queue";
import { ensureCoreSchema } from "@sm/db";

const startedAt = Date.now();
const WORKFLOW_NODE_TYPE_SET = new Set<string>(WORKFLOW_NODE_TYPES);

function toEngineWorkflowNodes(
  nodes: Array<{ id: string; type: string; data?: Record<string, unknown>; position?: { x: number; y: number } }>
): WorkflowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: node.type as WorkflowNodeType,
    data: node.data,
    position: node.position
  }));
}

type DryRunNodeResult = {
  success: boolean;
  output?: string;
  branchTaken?: "true" | "false";
};

type DryRunHandler = (nodeId: string, node: WorkflowNode) => Promise<DryRunNodeResult>;

function createDryRunHandlers(): Record<WorkflowNodeType, DryRunHandler> {
  const handlers = {} as Record<WorkflowNodeType, DryRunHandler>;
  for (const nodeType of WORKFLOW_NODE_TYPES) {
    handlers[nodeType] = async (nodeId, node) => {
      if (node.type === "branchIf") {
        const condition = String(node.data?.condition ?? "").trim().toLowerCase();
        const truthy = condition.length > 0 && condition !== "false" && condition !== "0";
        return {
          success: true,
          branchTaken: truthy ? "true" : "false",
          output: `Dry run branch "${truthy ? "true" : "false"}" selected`
        };
      }
      if (node.type === "runShell") {
        const command = String(node.data?.command ?? "echo hello").trim();
        return { success: true, output: `Dry run would execute: ${command}` };
      }
      if (node.type === "httpRequest") {
        const method = String(node.data?.method ?? "GET").toUpperCase();
        const url = String(node.data?.url ?? "https://example.com");
        return { success: true, output: `Dry run would request: ${method} ${url}` };
      }
      return { success: true, output: `Dry run executed ${node.type} (${nodeId})` };
    };
  }
  return handlers;
}

async function executeDryRunGraph(
  nodes: WorkflowNode[],
  edges: Array<{ from: string; to: string }>,
  handlers: Record<WorkflowNodeType, DryRunHandler>
): Promise<{ success: boolean; nodeResults: Record<string, DryRunNodeResult> }> {
  const nodeResults: Record<string, DryRunNodeResult> = {};
  const failed = new Set<string>();
  const skipped = new Set<string>();

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
  }

  const waves = topologicalWaves(nodes, edges);
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  for (const wave of waves) {
    await Promise.all(
      wave
        .filter((nodeId) => !skipped.has(nodeId))
        .map(async (nodeId) => {
          const node = nodeMap.get(nodeId);
          if (!node) return;
          const incomingNodes = incoming.get(nodeId) ?? [];
          const allIncomingFailed = incomingNodes.length > 0 && incomingNodes.every(
            (incomingNode) => failed.has(incomingNode) || skipped.has(incomingNode)
          );
          if (allIncomingFailed) {
            skipped.add(nodeId);
            return;
          }

          const handler = handlers[node.type];
          if (!handler) {
            nodeResults[nodeId] = { success: false, output: `No dry-run handler for ${node.type}` };
            failed.add(nodeId);
            return;
          }

          const result = await handler(nodeId, node);
          nodeResults[nodeId] = result;
          if (!result.success) {
            failed.add(nodeId);
            return;
          }

          if (node.type === "branchIf" && result.branchTaken) {
            const targets = outgoing.get(nodeId) ?? [];
            const takenIndex = result.branchTaken === "true" ? 0 : 1;
            for (let i = 0; i < targets.length; i++) {
              if (i !== takenIndex) {
                markDescendantsSkipped(targets[i], outgoing, skipped);
              }
            }
          }
        })
    );
  }

  return { success: failed.size === 0, nodeResults };
}

function markDescendantsSkipped(
  nodeId: string,
  outgoing: Map<string, string[]>,
  skipped: Set<string>
): void {
  if (skipped.has(nodeId)) return;
  skipped.add(nodeId);
  for (const child of outgoing.get(nodeId) ?? []) {
    markDescendantsSkipped(child, outgoing, skipped);
  }
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

export function buildGithubWebhookJobFromEvent(
  eventType: string,
  body: unknown,
  deliveryId: string | undefined,
  correlationId?: string
): GithubWebhookJobPayload {
  const tenantId = defaultWebhookTenantId();
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const installationId = (record.installation as { id?: number } | undefined)?.id;
  const repo = (record.repository as { full_name?: string } | undefined)?.full_name ?? "unknown/unknown";

  if (eventType === "push") {
    const ref = typeof record.ref === "string" ? record.ref : "";
    const branch = ref.replace(/^refs\/heads\//, "") || "main";
    return {
      kind: "github_mutation",
      tenantId,
      installationId: typeof installationId === "number" ? installationId : 0,
      action: "push",
      repo,
      branch,
      correlationId
    };
  }

  if (eventType === "pull_request") {
    const pr = record.pull_request as { head?: { ref?: string }; merged?: boolean; number?: number } | undefined;
    const branch = pr?.head?.ref ?? "main";
    const action = typeof record.action === "string" ? record.action : "";
    const merged = pr?.merged === true;
    const mutationAction = action === "closed" && merged ? "merge_pr" : "create_pr";
    return {
      kind: "github_mutation",
      tenantId,
      installationId: typeof installationId === "number" ? installationId : 0,
      action: mutationAction,
      repo,
      branch,
      pullNumber: typeof pr?.number === "number" ? pr.number : undefined,
      correlationId
    };
  }

  if (eventType === "workflow_dispatch") {
    const ref = typeof record.ref === "string" ? record.ref : "";
    const branch = ref.replace(/^refs\/heads\//, "") || "main";
    return {
      kind: "github_mutation",
      tenantId,
      installationId: typeof installationId === "number" ? installationId : 0,
      action: "dispatch_workflow",
      repo,
      branch,
      correlationId
    };
  }

  return {
    kind: "github_ingestion",
    tenantId,
    eventType: eventType || "unknown",
    deliveryId
  };
}

export type BuildServerOptions = {
  enqueueGithubJob?: (job: GithubWebhookJobPayload) => void | Promise<void>;
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
  buildOptions: Pick<BuildServerOptions, "enqueueGithubJob" | "enqueueLogIngestion" | "enqueueAgentCommand" | "redis">;
  close: () => Promise<void>;
};

export type { ReadinessChecker } from "./readyChecks.js";

const noopGithubEnqueue = (_job: GithubWebhookJobPayload) => Promise.resolve();
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
    listServices: (tenantId) => get().then((s) => s.listServices(tenantId)),
    getService: (tenantId, id) => get().then((s) => s.getService(tenantId, id)),
    createService: (tenantId, data) => get().then((s) => s.createService(tenantId, data)),
    updateServiceWorkflow: (tenantId, serviceId, workflowGraphId) =>
      get().then((s) => s.updateServiceWorkflow(tenantId, serviceId, workflowGraphId)),
    deleteService: (tenantId, id) => get().then((s) => s.deleteService(tenantId, id)),
    listWorkflowGraphs: (tenantId) => get().then((s) => s.listWorkflowGraphs(tenantId)),
    getWorkflowGraph: (tenantId, workflowId) => get().then((s) => s.getWorkflowGraph(tenantId, workflowId)),
    createWorkflowGraph: (tenantId, data) => get().then((s) => s.createWorkflowGraph(tenantId, data))
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
  const githubQueue = createNamedQueue<GithubWebhookJobPayload>("github", redis);
  const logQueue = createNamedQueue<LogIngestionJob>("logIngestion", redis);
  const agentCommandQueue = createNamedQueue<AgentCommandJob>("agentCommands", redis);

  return {
    buildOptions: {
      redis,
      enqueueGithubJob: async (job) => {
        await githubQueue.add("github-webhook", job);
      },
      enqueueLogIngestion: async (job) => {
        await logQueue.add("log-ingestion", job);
      },
      enqueueAgentCommand: async (job) => {
        await agentCommandQueue.add("agent-command", job);
      }
    },
    close: async () => {
      await Promise.allSettled([githubQueue.close(), logQueue.close(), agentCommandQueue.close()]);
      await redis.quit();
    }
  };
}

function createSwappableAuthStore(initial: AuthStore): AuthStore & { swap: (next: AuthStore) => void } {
  let current = initial;
  return {
    findUserByEmail: (email) => current.findUserByEmail(email),
    findMemberships: (userId) => current.findMemberships(userId),
    createSession: (userId, tenantId, tokenHash, expiresAt) =>
      current.createSession(userId, tenantId, tokenHash, expiresAt),
    findSessionByTokenHash: (tokenHash) => current.findSessionByTokenHash(tokenHash),
    findUserById: (id) => current.findUserById(id),
    swap: (next) => { current = next; },
  };
}

async function swapAuthStoreToPostgres(
  swappable: AuthStore & { swap: (next: AuthStore) => void },
  databaseUrl: string
): Promise<void> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: databaseUrl });
  swappable.swap(createPostgresAuthStore(pool));
}

export function buildServer(opts: BuildServerOptions = {}) {
  const enqueueGithubJob = opts.enqueueGithubJob ?? noopGithubEnqueue;
  const enqueueLogIngestion = opts.enqueueLogIngestion ?? noopLogIngestion;
  const enqueueAgentCommand = opts.enqueueAgentCommand ?? noopAgentCommandEnqueue;
  const readinessCheckers = opts.readinessCheckers ?? createReadinessCheckersFromEnv();
  const domainStore = resolveDomainStore(opts);
  const authStore = opts.authStore ?? createMemoryAuthStore();
  const realtimeManager = new RealtimeManager({ redis: opts.redis });
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
        } else if (!isDev) {
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

      socket.send(JSON.stringify({ type: "hello", service: "realtime" }));
      let registeredAgentId: string | undefined;

      socket.on("message", (raw) => {
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

        if (msg.type === "heartbeat") {
          if (!registeredAgentId) {
            registeredAgentId = msg.agentId;
            realtimeManager.registerAgent({ agentId: msg.agentId, socket }).catch(() => {});
          }
          if (msg.tenantId && !agentTenantId) {
            agentTenantId = msg.tenantId;
          }
        }

        if (msg.type === "command_ack" && registeredAgentId) {
          void realtimeManager.acknowledgeCommand(registeredAgentId, msg.commandId).catch(() => {});
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
          realtimeManager.unregisterAgent(registeredAgentId);
        }
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
    return { token: result.token, user: result.session };
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
    const tenantId = "t-1";
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
    const sessionId = await authStore.createSession(user.id, membership?.tenantId ?? tenantId, tokenHash, expiresAt);

    return oauthCallbackResponseSchema.parse({
      token: sessionToken,
      user: {
        id: sessionId,
        email: user.email,
        tenantId: membership?.tenantId ?? tenantId,
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
    return meResponseSchema.parse(session);
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
      const tokens = await listEnrollmentTokensForTenant(session.tenantId);
      return listEnrollmentTokensResponseSchema.parse({ tokens });
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

  app.get("/api/v1/github/installations", async (req, reply) => {
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
    const installations = await listGithubInstallationsForTenant(session.tenantId);
    return githubInstallationsResponseSchema.parse({ installations });
  });

  app.post("/api/v1/github/installations", async (req, reply) => {
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
    const payload = upsertGithubInstallationRequestSchema.parse(req.body);
    if (payload.tenantId !== undefined && payload.tenantId !== session.tenantId) {
      return reply.status(403).send(
        apiErrorSchema.parse({
          code: "TENANT_SCOPE_DENY",
          message: "Cross-tenant write denied",
          correlationId: (req as any).correlationId
        })
      );
    }
    const { tenantId: _ignored, ...installation } = payload;
    return await upsertGithubInstallationForTenant(session.tenantId, installation);
  });

  app.post("/api/v1/github/installations/sync", async (req, reply) => {
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
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const installationId = Number(body.installationId);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: "installationId must be a positive integer",
          correlationId: (req as any).correlationId
        })
      );
    }
    const appId = Number(process.env.GITHUB_APP_ID);
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
    if (!(appId > 0) || !privateKey?.trim()) {
      return reply.status(503).send(
        apiErrorSchema.parse({
          code: "GITHUB_APP_NOT_CONFIGURED",
          message: "GitHub App credentials are not configured",
          correlationId: (req as any).correlationId
        })
      );
    }
    try {
      const installation = await getInstallationMetadata({
        appId,
        privateKey,
        installationId
      });
      return await upsertGithubInstallationForTenant(session.tenantId, installation);
    } catch (err) {
      return reply.status(502).send(
        apiErrorSchema.parse({
          code: "GITHUB_INSTALLATION_LOOKUP_FAILED",
          message: err instanceof Error ? err.message : "Failed to fetch installation metadata",
          correlationId: (req as any).correlationId
        })
      );
    }
  });

  app.post("/api/v1/github/policy/check", async (req, reply) => {
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
    const body = githubPolicyCheckRequestSchema.parse(req.body);
    const settings = await getTenantSettings(session.tenantId);
    const policy = settings?.automationPolicy ?? { repos: [], branches: [], actions: [] };
    const result = enforcePolicy(policy, body);
    if (!result.allowed) {
      return reply.status(403).send(
        apiErrorSchema.parse({
          code: result.reason,
          message: "GitHub automation action is not allowed by tenant policy",
          correlationId: (req as any).correlationId
        })
      );
    }
    return { allowed: true as const };
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

  app.post("/webhooks/github", async (req, reply) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "test-secret";
    const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const signature = req.headers["x-hub-signature-256"]?.toString().replace("sha256=", "");
    if (!signValid(secret, rawBody, signature)) {
      return reply.status(401).send({ code: "WEBHOOK_SIGNATURE_INVALID", message: "Invalid webhook signature" });
    }
    const eventType = req.headers["x-github-event"]?.toString() ?? "unknown";
    const deliveryId = req.headers["x-github-delivery"]?.toString();
    const job = buildGithubWebhookJobFromEvent(eventType, req.body, deliveryId, (req as any).correlationId);
    await enqueueGithubJob(job);
    return { accepted: true as const };
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
    return listAgentsResponseSchema.parse({ agents });
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

  app.patch<{ Params: { id: string } }>("/api/v1/services/:id/workflow", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const body = setServiceWorkflowRequestSchema.parse(req.body);
    const service = await domainStore.getService(session.tenantId, req.params.id);
    if (!service) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Service not found", correlationId: (req as any).correlationId }));
    }
    if (body.workflowGraphId) {
      const workflow = await domainStore.getWorkflowGraph(session.tenantId, body.workflowGraphId);
      if (!workflow || workflow.serviceId !== service.id) {
        return reply.status(400).send(apiErrorSchema.parse({ code: "BAD_REQUEST", message: "Workflow does not belong to this service", correlationId: (req as any).correlationId }));
      }
    }
    const updated = await domainStore.updateServiceWorkflow(session.tenantId, service.id, body.workflowGraphId ?? null);
    if (!updated) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Service not found", correlationId: (req as any).correlationId }));
    }
    return updated;
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

  // --- Workflow Graphs ---

  app.get("/api/v1/workflows", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const graphs = await domainStore.listWorkflowGraphs(session.tenantId);
    return listWorkflowGraphsResponseSchema.parse({ graphs });
  });

  app.get<{ Params: { id: string } }>("/api/v1/workflows/:id", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const workflow = await domainStore.getWorkflowGraph(session.tenantId, req.params.id);
    if (!workflow) {
      return reply.status(404).send(apiErrorSchema.parse({ code: "NOT_FOUND", message: "Workflow not found", correlationId: (req as any).correlationId }));
    }
    return workflow;
  });

  app.post("/api/v1/workflows", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const parsedBody = createWorkflowGraphRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: parsedBody.error.issues[0]?.message ?? "Invalid workflow graph payload",
          correlationId: (req as any).correlationId
        })
      );
    }
    const body = parsedBody.data;
    const nodes = toEngineWorkflowNodes(body.nodes);
    const edges = body.edges.map((edge) => ({ from: edge.from, to: edge.to }));
    const validationErrors = validateDomainWorkflowGraph(nodes, edges);
    if (validationErrors.length > 0) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: validationErrors[0].message,
          correlationId: (req as any).correlationId
        })
      );
    }
    const graph = await domainStore.createWorkflowGraph(session.tenantId, body);
    return reply.status(201).send(graph);
  });

  app.post("/api/v1/workflows/execute", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const parsedBody = executeWorkflowRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: parsedBody.error.issues[0]?.message ?? "Invalid workflow execute payload",
          correlationId: (req as any).correlationId
        })
      );
    }
    const body = parsedBody.data;
    const nodes = toEngineWorkflowNodes(body.nodes);
    const edges = body.edges.map((edge) => ({ from: edge.from, to: edge.to }));
    const validationErrors = validateDomainWorkflowGraph(nodes, edges);
    if (validationErrors.length > 0) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: validationErrors[0].message,
          correlationId: (req as any).correlationId
        })
      );
    }
    const service = await domainStore.getService(session.tenantId, body.serviceId);
    if (!service) {
      return reply.status(404).send(
        apiErrorSchema.parse({
          code: "NOT_FOUND",
          message: "Service not found",
          correlationId: (req as any).correlationId
        })
      );
    }
    const graph = await domainStore.createWorkflowGraph(session.tenantId, body);
    if (!service.agentId) {
      return reply.status(409).send(
        apiErrorSchema.parse({
          code: "AGENT_REQUIRED",
          message: "Selected service is not bound to an agent",
          correlationId: (req as any).correlationId
        })
      );
    }
    const commandId = `cmd-${crypto.randomUUID()}`;
    const payload = platformToAgentMessageSchema.parse({
      type: "run_step",
      commandId,
      shell: `sm-workflow-exec --workflow-id ${graph.id} --version ${graph.version}`,
      env: {
        SM_WORKFLOW_ID: graph.id,
        SM_WORKFLOW_VERSION: String(graph.version),
        SM_SERVICE_ID: graph.serviceId
      }
    });
    try {
      await enqueueAgentCommand({
        agentId: service.agentId,
        commandId,
        payload
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to enqueue workflow execution command";
      return reply.status(503).send(
        apiErrorSchema.parse({
          code: "INTERNAL_ERROR",
          message,
          correlationId: (req as any).correlationId
        })
      );
    }
    return reply.status(202).send(
      executeWorkflowResponseSchema.parse({
        accepted: true as const,
        workflowId: graph.id,
        workflowVersion: graph.version,
        agentId: service.agentId,
        commandId,
        dispatchState: "queued_for_dispatch" as const
      })
    );
  });

  app.post("/api/v1/workflows/dry-run", async (req, reply) => {
    const session = await resolveSession(authStore, req.headers.authorization);
    if (!session) {
      return reply.status(401).send(apiErrorSchema.parse({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token", correlationId: (req as any).correlationId }));
    }
    const parsedBody = executeWorkflowRequestSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: parsedBody.error.issues[0]?.message ?? "Invalid workflow dry-run payload",
          correlationId: (req as any).correlationId
        })
      );
    }
    const body = parsedBody.data;
    const invalidNodeType = body.nodes.find((node) => !WORKFLOW_NODE_TYPE_SET.has(node.type));
    if (invalidNodeType) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: `Unknown workflow node type: ${invalidNodeType.type}`,
          correlationId: (req as any).correlationId
        })
      );
    }

    const nodes = toEngineWorkflowNodes(body.nodes);
    const edges = body.edges.map((edge) => ({ from: edge.from, to: edge.to }));
    const validationErrors = validateDomainWorkflowGraph(nodes, edges);
    if (validationErrors.length > 0) {
      return reply.status(400).send(
        apiErrorSchema.parse({
          code: "BAD_REQUEST",
          message: validationErrors[0].message,
          correlationId: (req as any).correlationId
        })
      );
    }

    const result = await executeDryRunGraph(
      nodes,
      edges,
      createDryRunHandlers()
    );

    const steps = nodes.map((node) => {
      const nodeResult = result.nodeResults[node.id];
      if (!nodeResult) {
        return {
          nodeId: node.id,
          nodeType: node.type,
          success: false,
          output: "Skipped (branch condition not taken)"
        };
      }
      const output = nodeResult.output == null ? undefined : String(nodeResult.output);
      return {
        nodeId: node.id,
        nodeType: node.type,
        success: nodeResult.success,
        output
      };
    });

    return workflowDryRunResponseSchema.parse({
      success: result.success,
      steps
    });
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

  return Object.assign(app, { realtimeManager });
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
  if (persisted?.setupComplete && persisted.databaseUrl?.trim()) {
    try {
      await swapAuthStoreToPostgres(swappableStore, persisted.databaseUrl);
      console.error("[api] Auth store: Postgres (persisted config)");
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
    if (config.githubApp) {
      process.env.GITHUB_APP_ID = config.githubApp.appId;
      process.env.GITHUB_APP_PRIVATE_KEY = config.githubApp.privateKeyPem;
      process.env.GITHUB_WEBHOOK_SECRET = config.githubApp.webhookSecret;
    }
    if (config.oauth?.googleClientId) {
      process.env.GOOGLE_CLIENT_ID = config.oauth.googleClientId;
      process.env.GOOGLE_CLIENT_SECRET = config.oauth.googleClientSecret ?? "";
    }
    if (config.kubernetes?.namespace) {
      process.env.KAIAD_K8S_NAMESPACE = config.kubernetes.namespace;
    }

    try {
      await swapAuthStoreToPostgres(swappableStore, config.databaseUrl);
      console.error("[api] Auth store swapped to Postgres");
    } catch (err) {
      console.error("[api] Failed to create Postgres auth store:", err);
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
        const { connection: wc, workers: wi } = mod.startQueueConsumersFromEnv(process.env);
        if (wi.length > 0) {
          console.error(`[api] Embedded worker: ${wi.length} BullMQ consumer(s) started`);
        } else {
          console.error("[api] Embedded worker: no consumers started (REDIS_DISABLED?)");
        }
        const prev = shutdownFn;
        shutdownFn = async () => {
          await mod.shutdownWorkersAndRedis(wi, wc).catch(() => {});
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
