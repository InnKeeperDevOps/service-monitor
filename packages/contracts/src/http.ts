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

export const agentRuntimeBackendSchema = z.enum(["docker", "kubernetes", "shell"]);

export const tenantSettingsSchema = z.object({
  tenantId: z.string(),
  docsUrl: z.string().url().optional(),
  preferredExecutor: z.enum(["cursor", "claude"]).optional(),
  /** Where the Go agent runs workloads: Docker socket, Kubernetes CLI, or shell-only. */
  agentRuntimeBackend: agentRuntimeBackendSchema.optional()
});

export const upsertTenantSettingsRequestSchema = tenantSettingsSchema;

export const sshKeySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string().min(1),
  type: z.enum(["uploaded", "local_path"]),
  localPath: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const createSshKeyRequestSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["uploaded", "local_path"]),
  privateKey: z.string().optional(),
  localPath: z.string().optional()
});

export const listSshKeysResponseSchema = z.object({
  keys: z.array(sshKeySchema)
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

export const workflowNodeTypeSchema = z.enum(["event", "action", "control"]);
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
export const workflowControlKindSchema = z.enum(["branchIf", "join", "wait", "if", "loop"]);
export const workflowActionKindSchema = z.enum([
  "runShell",
  "dockerBuild",
  "dockerRun",
  "composeUp",
  "composeDown",
  "setEnv",
  "injectSecret",
  "template",
  "runCursorPlan",
  "runClaudePlan",
  "httpRequest",
  "slackNotify",
  "emailNotify",
  "genericWebhook",
  "clone",
  "checkoutBranch",
  "createPR",
  "mergePR",
  "push",
  "dispatchWorkflow",
  "commentOnPR",
  "createIssue",
  "addLabels"
]);
const workflowNodeBaseShape = {
  id: z.string(),
  position: z.object({ x: z.number(), y: z.number() }).optional()
};

function eventDataSchema(shape: z.ZodRawShape) {
  return z.object({
    displayName: z.string().optional(),
    ...shape
  }).strict();
}

const eventNodeSchemas = [
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("onBuild"),
    data: eventDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("onStartup"),
    data: eventDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("onCrash"),
    data: eventDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("onShutdown"),
    data: eventDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("onLogPattern"),
    data: eventDataSchema({ filter: z.string().min(1) })
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("onSchedule"),
    data: eventDataSchema({ schedule: z.string().min(1) })
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("agentStarted"),
    data: eventDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("agentStopped"),
    data: eventDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("agentOnline"),
    data: eventDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("agentOffline"),
    data: eventDataSchema({}).optional()
  }),
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
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("agentCrashed"),
    data: eventDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("agentRestarted"),
    data: eventDataSchema({}).optional()
  }),
  z.object({
    ...workflowNodeBaseShape,
    type: z.literal("event"),
    kind: z.literal("onServiceConfigurationUpdate"),
    data: eventDataSchema({}).optional()
  })
] as const;

const workflowActionNodeSchema = z.object({
  ...workflowNodeBaseShape,
  type: z.literal("action"),
  kind: workflowActionKindSchema,
  data: z.record(z.unknown()).optional()
});

const workflowControlNodeSchema = z.object({
  ...workflowNodeBaseShape,
  type: z.literal("control"),
  kind: workflowControlKindSchema,
  data: z.record(z.unknown()).optional()
});

export const workflowGraphNodeSchema = z.union([
  z.discriminatedUnion("kind", eventNodeSchemas),
  workflowActionNodeSchema,
  workflowControlNodeSchema
]);

export const workflowGraphEdgeSchema = z.object({
  from: z.string(),
  to: z.string()
});

export const workflowGraphSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  nodes: z.array(workflowGraphNodeSchema),
  edges: z.array(workflowGraphEdgeSchema),
  viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
  isActive: z.boolean()
});

export const createWorkflowGraphRequestSchema = z.object({
  name: z.string().min(1),
  nodes: z.array(workflowGraphNodeSchema),
  edges: z.array(workflowGraphEdgeSchema)
});

export const executeWorkflowRequestSchema = z.object({
  serviceId: z.string(),
  name: z.string().min(1),
  nodes: z.array(workflowGraphNodeSchema),
  edges: z.array(workflowGraphEdgeSchema)
});

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
  gitRepoUrl: z.string(),
  sshKeyId: z.string().nullable().optional(),
  branch: z.string(),
  dockerImage: z.string().nullable().optional(),
  composePath: z.string().nullable().optional()
});

export const setServiceWorkflowRequestSchema = z.object({
  workflowGraphId: z.string().nullable()
});

export const createMonitoredServiceRequestSchema = z.object({
  name: z.string().min(1),
  gitRepoUrl: z.string().min(1),
  sshKeyId: z.string().nullable().optional(),
  branch: z.string().min(1),
  agentId: z.string().nullable().optional(),
  dockerImage: z.string().min(1).optional(),
  composePath: z.string().min(1).optional()
});

export const updateMonitoredServiceRequestSchema = z.object({
  name: z.string().min(1).optional(),
  gitRepoUrl: z.string().min(1).optional(),
  sshKeyId: z.string().nullable().optional(),
  branch: z.string().min(1).optional(),
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

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type SshKey = z.infer<typeof sshKeySchema>;
export type CreateSshKeyRequest = z.infer<typeof createSshKeyRequestSchema>;
export type ListSshKeysResponse = z.infer<typeof listSshKeysResponseSchema>;
export type Incident = z.infer<typeof incidentSchema>;
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
export type WorkflowGraphNode = z.infer<typeof workflowGraphNodeSchema>;
export type WorkflowGraphEdge = z.infer<typeof workflowGraphEdgeSchema>;
export type ExecuteWorkflowRequest = z.infer<typeof executeWorkflowRequestSchema>;
export type ExecuteWorkflowResponse = z.infer<typeof executeWorkflowResponseSchema>;
export type WorkflowDryRunResponse = z.infer<typeof workflowDryRunResponseSchema>;
export type MonitoredService = z.infer<typeof monitoredServiceSchema>;
export type CreateMonitoredServiceRequest = z.infer<typeof createMonitoredServiceRequestSchema>;
export type UpdateMonitoredServiceRequest = z.infer<typeof updateMonitoredServiceRequestSchema>;
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
