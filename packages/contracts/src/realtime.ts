import { z } from "zod";

const heartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  agentId: z.string(),
  ts: z.string(),
  capacity: z.number().int().nonnegative(),
  tenantId: z.string().optional(),
  agentVersion: z.string().optional()
});

const logEventSchema = z.object({
  type: z.literal("log_event"),
  agentId: z.string(),
  serviceId: z.string(),
  level: z.enum(["debug", "info", "warn", "error", "fatal"]),
  message: z.string(),
  ts: z.string()
});

const commandAckSchema = z.object({
  type: z.literal("command_ack"),
  commandId: z.string(),
  status: z.enum(["accepted", "completed", "failed", "cancelled"]),
  ts: z.string(),
  output: z.string().optional()
});

export const agentToPlatformMessageSchema = z.discriminatedUnion("type", [
  heartbeatSchema,
  logEventSchema,
  commandAckSchema
]);

const runStepCommandSchema = z.object({
  type: z.literal("run_step"),
  commandId: z.string(),
  shell: z.string(),
  env: z.record(z.string())
});

const dockerOpCommandSchema = z.object({
  type: z.literal("docker_op"),
  commandId: z.string(),
  operation: z.enum(["build", "run", "compose_up", "compose_down"]),
  args: z.record(z.string())
});

const cancelRunCommandSchema = z.object({
  type: z.literal("cancel_run"),
  commandId: z.string(),
  targetCommandId: z.string()
});

const syncDesiredStateCommandSchema = z.object({
  type: z.literal("sync_desired_state"),
  commandId: z.string(),
  desiredContainers: z.array(
    z.object({
      serviceId: z.string(),
      image: z.string(),
      state: z.enum(["running", "stopped"])
    })
  )
});

const runCursorPlanCommandSchema = z.object({
  type: z.literal("run_cursor_plan"),
  commandId: z.string(),
  prompt: z.string(),
  workspacePath: z.string().optional(),
  env: z.record(z.string()).optional(),
  permissionsProfile: z.enum(["restricted", "repo", "full"]).optional()
});

const runClaudePlanCommandSchema = z.object({
  type: z.literal("run_claude_plan"),
  commandId: z.string(),
  prompt: z.string(),
  workspacePath: z.string().optional(),
  env: z.record(z.string()).optional(),
  permissionsProfile: z.enum(["restricted", "repo", "full"]).optional()
});

export const platformToAgentMessageSchema = z.discriminatedUnion("type", [
  runStepCommandSchema,
  dockerOpCommandSchema,
  cancelRunCommandSchema,
  syncDesiredStateCommandSchema,
  runCursorPlanCommandSchema,
  runClaudePlanCommandSchema
]);

export type AgentToPlatformMessage = z.infer<typeof agentToPlatformMessageSchema>;
export type PlatformToAgentMessage = z.infer<typeof platformToAgentMessageSchema>;
