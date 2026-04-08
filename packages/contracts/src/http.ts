import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.enum(["ok"]),
  uptimeSeconds: z.number().nonnegative()
});

export const membershipEntrySchema = z.object({
  tenantId: z.string(),
  tenantName: z.string(),
  role: z.enum(["owner", "admin", "operator", "viewer"])
});

export const meResponseSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.enum(["owner", "admin", "operator", "viewer"]),
  tenantId: z.string(),
  memberships: z.array(membershipEntrySchema)
});

export const switchActiveTenantRequestSchema = z.object({
  tenantId: z.string().min(1)
});

export const switchActiveTenantResponseSchema = meResponseSchema;

export const createTenantRequestSchema = z.object({
  name: z.string().min(1).max(200),
  tenantId: z
    .string()
    .regex(/^t-[a-z0-9-]+$/)
    .optional()
});

/** POST /api/v1/tenants returns the same shape as GET /me after switching to the new tenant. */
export const createTenantResponseSchema = meResponseSchema;

export type CreateTenantRequest = z.infer<typeof createTenantRequestSchema>;

export const automationActionSchema = z.enum(["create_pr", "merge_pr", "dispatch_workflow", "push"]);

export const automationPolicySchema = z.object({
  repos: z.array(z.string()),
  branches: z.array(z.string()),
  actions: z.array(automationActionSchema)
});

export const agentRuntimeBackendSchema = z.enum(["docker", "kubernetes", "shell"]);

/** How the enrolled agent obtains/runs the workload: clone from GitHub vs binary supplied by Kaiad. */
export const agentWorkloadSourceSchema = z.enum(["github_repo", "binary"]);

export const tenantSettingsSchema = z.object({
  tenantId: z.string(),
  githubRepo: z.string(),
  defaultBranch: z.string(),
  docsUrl: z.string().url().optional(),
  automationPolicy: automationPolicySchema.optional(),
  preferredExecutor: z.enum(["cursor", "claude"]).optional(),
  /** Where the Go agent runs workloads: Docker socket, Kubernetes CLI, or shell-only. */
  agentRuntimeBackend: agentRuntimeBackendSchema.optional(),
  /**
   * Omit (legacy) = treat as GitHub repo mode and ready.
   * `null` = operator has not finished Kaiad configuration; agent waits for a non-null value.
   */
  agentWorkloadSource: z.union([agentWorkloadSourceSchema, z.null()]).optional()
});

export const githubPolicyCheckRequestSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  action: automationActionSchema
});

export const upsertTenantSettingsRequestSchema = tenantSettingsSchema;

export const githubInstallationSettingsSchema = z.object({
  installationId: z.number().int().positive(),
  accountLogin: z.string().min(1),
  appId: z.number().int().positive()
});

/** POST body may include tenantId for symmetry with settings; must match session or be omitted. */
export const upsertGithubInstallationRequestSchema = githubInstallationSettingsSchema.extend({
  tenantId: z.string().optional()
});

export const githubInstallationsResponseSchema = z.object({
  installations: z.array(githubInstallationSettingsSchema)
});

/** GET /api/v1/github/installation-repositories — repos visible to the tenant's linked installation */
export const githubInstallationRepositoriesResponseSchema = z.object({
  repos: z.array(z.string().min(1))
});

export const syncGithubInstallationRequestSchema = z.object({
  installationId: z.number().int().positive()
});

export const createEnrollmentTokenRequestSchema = z.object({
  ttlSeconds: z.number().int().positive().max(365 * 24 * 60 * 60)
});

export const enrollmentTokenMetadataSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  expiresAt: z.string().datetime(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  usedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  isActive: z.boolean()
});

export const createEnrollmentTokenResponseSchema = enrollmentTokenMetadataSchema.extend({
  token: z.string().min(1)
});

export const listEnrollmentTokensResponseSchema = z.object({
  tokens: z.array(enrollmentTokenMetadataSchema)
});

export type CreateEnrollmentTokenRequest = z.infer<typeof createEnrollmentTokenRequestSchema>;
export type EnrollmentTokenMetadata = z.infer<typeof enrollmentTokenMetadataSchema>;
export type CreateEnrollmentTokenResponse = z.infer<typeof createEnrollmentTokenResponseSchema>;
export type ListEnrollmentTokensResponse = z.infer<typeof listEnrollmentTokensResponseSchema>;

export const incidentStatusSchema = z.enum(["open", "acknowledged", "resolved", "closed"]);

export const incidentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  serviceId: z.string(),
  fingerprint: z.string(),
  status: incidentStatusSchema,
  message: z.string().optional(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  eventCount: z.number().int().nonnegative().default(1)
});

export const listIncidentsResponseSchema = z.object({
  incidents: z.array(incidentSchema)
});

export const updateIncidentStatusRequestSchema = z.object({
  status: incidentStatusSchema
});

const workflowTriggerTypes = ["onBuild", "onStartup", "onCrash", "onShutdown", "onLogPattern", "onSchedule"] as const;
const WORKFLOW_TRIGGER_TYPE_SET = new Set<string>(workflowTriggerTypes);
const workflowNodeBaseShape = {
  id: z.string(),
  position: z.object({ x: z.number(), y: z.number() }).optional()
};

function triggerDataSchema(shape: z.ZodRawShape) {
  return z.object({
    displayName: z.string().optional(),
    ...shape
  }).strict();
}

const triggerNodeSchemas = [
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("onBuild"),
    data: triggerDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("onStartup"),
    data: triggerDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("onCrash"),
    data: triggerDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("onShutdown"),
    data: triggerDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("onLogPattern"),
    data: triggerDataSchema({ filter: z.string().min(1) })
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("onSchedule"),
    data: triggerDataSchema({ schedule: z.string().min(1) })
  })
] as const;

const workflowNonTriggerNodeSchema = z.object({
  ...workflowNodeBaseShape,
  type: z.string().refine((type) => !WORKFLOW_TRIGGER_TYPE_SET.has(type), {
    message: "Non-trigger schema does not accept trigger node types"
  }),
  data: z.record(z.unknown()).optional()
});

export const workflowGraphNodeSchema = z.union([
  z.discriminatedUnion("type", triggerNodeSchemas),
  workflowNonTriggerNodeSchema
]);

export const workflowGraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string()
});

export const workflowGraphSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  serviceId: z.string(),
  version: z.number().int().positive(),
  nodes: z.array(workflowGraphNodeSchema),
  edges: z.array(workflowGraphEdgeSchema),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
  isActive: z.boolean()
});

export const createWorkflowGraphRequestSchema = z.object({
  serviceId: z.string(),
  nodes: z.array(workflowGraphNodeSchema),
  edges: z.array(workflowGraphEdgeSchema)
});

export const executeWorkflowRequestSchema = createWorkflowGraphRequestSchema;

export const listWorkflowGraphsResponseSchema = z.object({
  graphs: z.array(workflowGraphSchema)
});

export const executeWorkflowResponseSchema = z.object({
  accepted: z.literal(true),
  workflowId: z.string(),
  workflowVersion: z.number().int().positive(),
  agentId: z.string(),
  commandId: z.string(),
  dispatchState: z.enum(["queued_for_dispatch"])
});

export const workflowDryRunStepSchema = z.object({
  nodeId: z.string(),
  nodeType: z.string(),
  success: z.boolean(),
  output: z.string().optional()
});

export const workflowDryRunResponseSchema = z.object({
  success: z.boolean(),
  steps: z.array(workflowDryRunStepSchema)
});

export const monitoredServiceSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  agentId: z.string().nullable(),
  workflowGraphId: z.string().nullable().optional(),
  name: z.string(),
  repo: z.string(),
  branch: z.string(),
  dockerImage: z.string().nullable().optional(),
  composePath: z.string().nullable().optional()
});

export const setServiceWorkflowRequestSchema = z.object({
  workflowGraphId: z.string().nullable()
});

export const createMonitoredServiceRequestSchema = z.object({
  name: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  agentId: z.string().nullable().optional(),
  dockerImage: z.string().min(1).optional(),
  composePath: z.string().min(1).optional()
});

export const listMonitoredServicesResponseSchema = z.object({
  services: z.array(monitoredServiceSchema)
});

/** Server may merge RealtimeManager session state into list responses. */
export const agentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().nullable(),
  version: z.string().nullable(),
  status: z.enum(["online", "offline", "degraded", "unknown"]),
  lastSeenAt: z.string().datetime().nullable(),
  certFingerprint: z.string().nullable().optional(),
  allowedCapabilities: z.array(z.string()).optional(),
  websocketConnected: z.boolean().optional()
});

export const listAgentsResponseSchema = z.object({
  agents: z.array(agentSchema)
});

export type AutomationAction = z.infer<typeof automationActionSchema>;
export type AutomationPolicy = z.infer<typeof automationPolicySchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type MembershipEntry = z.infer<typeof membershipEntrySchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type GithubInstallationSettings = z.infer<typeof githubInstallationSettingsSchema>;
export type GithubInstallationsResponse = z.infer<typeof githubInstallationsResponseSchema>;
export type GithubInstallationRepositoriesResponse = z.infer<typeof githubInstallationRepositoriesResponseSchema>;
export type SyncGithubInstallationRequest = z.infer<typeof syncGithubInstallationRequestSchema>;
export type Incident = z.infer<typeof incidentSchema>;
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
export type WorkflowGraphNode = z.infer<typeof workflowGraphNodeSchema>;
export type WorkflowGraphEdge = z.infer<typeof workflowGraphEdgeSchema>;
export type ExecuteWorkflowRequest = z.infer<typeof executeWorkflowRequestSchema>;
export type ExecuteWorkflowResponse = z.infer<typeof executeWorkflowResponseSchema>;
export type WorkflowDryRunResponse = z.infer<typeof workflowDryRunResponseSchema>;
export type MonitoredService = z.infer<typeof monitoredServiceSchema>;
export type SetServiceWorkflowRequest = z.infer<typeof setServiceWorkflowRequestSchema>;
export type Agent = z.infer<typeof agentSchema>;

// ---------------------------------------------------------------------------
// OAuth / OIDC auth
// ---------------------------------------------------------------------------

export const oauthAuthorizeResponseSchema = z.object({
  authorizeUrl: z.string()
});

export const oauthCallbackResponseSchema = z.object({
  token: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    tenantId: z.string(),
    role: z.enum(["owner", "admin", "operator", "viewer"])
  })
});

export const authProviderEntrySchema = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string()
});

export const listAuthProvidersResponseSchema = z.object({
  providers: z.array(authProviderEntrySchema)
});

export type OAuthAuthorizeResponse = z.infer<typeof oauthAuthorizeResponseSchema>;
export type OAuthCallbackResponse = z.infer<typeof oauthCallbackResponseSchema>;
export type AuthProviderEntry = z.infer<typeof authProviderEntrySchema>;
export type ListAuthProvidersResponse = z.infer<typeof listAuthProvidersResponseSchema>;
