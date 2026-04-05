import { z } from "zod";

export const remediationJobSchema = z.object({
  remediationJobId: z.string(),
  tenantId: z.string(),
  incidentId: z.string(),
  serviceId: z.string().optional(),
  fingerprint: z.string(),
  executor: z.enum(["cursor", "claude"]),
  prompt: z.string(),
  correlationId: z.string().optional()
});

export const githubMutationJobSchema = z.object({
  tenantId: z.string(),
  installationId: z.number().int(),
  action: z.enum(["create_pr", "merge_pr", "dispatch_workflow", "push"]),
  repo: z.string(),
  branch: z.string(),
  pullNumber: z.number().int().positive().optional()
});

/** Enqueued from POST /webhooks/github after signature verification. */
export const githubWebhookMutationJobSchema = githubMutationJobSchema.extend({
  kind: z.literal("github_mutation"),
  correlationId: z.string().optional()
});

/** Placeholder for events that are ingested asynchronously (not mapped to a mutation). */
export const githubWebhookIngestionPlaceholderJobSchema = z.object({
  kind: z.literal("github_ingestion"),
  tenantId: z.string(),
  eventType: z.string(),
  deliveryId: z.string().optional()
});

export const githubWebhookJobPayloadSchema = z.discriminatedUnion("kind", [
  githubWebhookMutationJobSchema,
  githubWebhookIngestionPlaceholderJobSchema
]);

export const agentCommandJobSchema = z.object({
  agentId: z.string(),
  commandId: z.string(),
  payload: z.record(z.unknown())
});

export const agentCommandDispatchResponseSchema = z.object({
  accepted: z.literal(true),
  commandId: z.string(),
  queued: z.boolean(),
  delivered: z.boolean()
});

export type RemediationJob = z.infer<typeof remediationJobSchema>;
export type GithubMutationJob = z.infer<typeof githubMutationJobSchema>;
export type GithubWebhookMutationJob = z.infer<typeof githubWebhookMutationJobSchema>;
export type GithubWebhookIngestionPlaceholderJob = z.infer<typeof githubWebhookIngestionPlaceholderJobSchema>;
export type GithubWebhookJobPayload = z.infer<typeof githubWebhookJobPayloadSchema>;
export type AgentCommandJob = z.infer<typeof agentCommandJobSchema>;
export type AgentCommandDispatchResponse = z.infer<typeof agentCommandDispatchResponseSchema>;

export const logIngestionJobSchema = z.object({
  tenantId: z.string(),
  agentId: z.string(),
  serviceId: z.string(),
  level: z.enum(["debug", "info", "warn", "error", "fatal"]),
  message: z.string(),
  ts: z.string(),
  correlationId: z.string().optional()
});

export type LogIngestionJob = z.infer<typeof logIngestionJobSchema>;
