import { z } from "zod";

export const remediationJobSchema = z.object({
  remediationJobId: z.string(),
  tenantId: z.string(),
  incidentId: z.string(),
  serviceId: z.string().optional(),
  fingerprint: z.string(),
  executor: z.enum(["cursor", "claude"]),
  prompt: z.string(),
  correlationId: z.string().optional(),
  gitRepoUrl: z.string(),
  sshKeyType: z.enum(["uploaded", "local_path"]),
  sshKeyValue: z.string().nullable()
});

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

export const workflowExecutionJobSchema = z.object({
  workflowExecutionId: z.string(),
  tenantId: z.string(),
  serviceId: z.string(),
  workflowGraphId: z.string(),
  workflowVersion: z.number(),
  triggerPayload: z.record(z.unknown()).nullable(),
  nodes: z.array(z.any()),
  edges: z.array(z.object({ from: z.string(), to: z.string() }))
});

export type WorkflowExecutionJob = z.infer<typeof workflowExecutionJobSchema>;
