import { z } from "zod";

/** First message on /realtime from Kaiad after connect; includes tenant agent runtime from settings. */
export const agentHelloMessageSchema = z.object({
  type: z.literal("hello"),
  service: z.literal("realtime"),
  runtime: z
    .object({
      backend: z.enum(["docker", "kubernetes", "shell"])
    })
    .optional(),
  /** When false, the agent should defer workloads until the operator sets tenant agent configuration in Kaiad. */
  configReady: z.boolean().optional(),
  /** Which AI CLI the agent should invoke when running automated fix plans (cursor or claude). */
  preferredExecutor: z.enum(["cursor", "claude"]).optional(),
  workload: z
    .object({
      source: z.enum(["git_repo", "binary"]).nullable(),
      gitRepoUrl: z.string(),
      sshKeyId: z.string().nullable().optional(),
      defaultBranch: z.string()
    })
    .optional()
});

export type AgentHelloMessage = z.infer<typeof agentHelloMessageSchema>;

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

/** Periodic host and agent-process telemetry (CPU, memory, disk, network throughput). */
const hostStatsSchema = z.object({
  type: z.literal("host_stats"),
  agentId: z.string(),
  ts: z.string(),
  /** Host CPU utilization 0–100 (all cores). */
  cpuPercent: z.number().min(0).max(100).optional(),
  memUsedBytes: z.number().int().nonnegative().optional(),
  memTotalBytes: z.number().int().positive().optional(),
  memPercent: z.number().min(0).max(100).optional(),
  diskUsedBytes: z.number().int().nonnegative().optional(),
  diskTotalBytes: z.number().int().positive().optional(),
  /** Path used for disk usage (e.g. `/` or workspace mount). */
  diskPath: z.string().optional(),
  /** Aggregate non-loopback receive throughput since last sample (bytes/s). */
  netRxBytesPerSec: z.number().nonnegative().optional(),
  /** Aggregate non-loopback transmit throughput since last sample (bytes/s). */
  netTxBytesPerSec: z.number().nonnegative().optional(),
  /** Resident set size of the agent process. */
  processRSSBytes: z.number().int().nonnegative().optional()
});

export const agentToPlatformMessageSchema = z.discriminatedUnion("type", [
  heartbeatSchema,
  logEventSchema,
  commandAckSchema,
  hostStatsSchema
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
  permissionsProfile: z.enum(["restricted", "repo", "full"]).optional(),
  gitRepoUrl: z.string(),
  sshKeyType: z.enum(["uploaded", "local_path"]),
  sshKeyValue: z.string().nullable()
});

const runClaudePlanCommandSchema = z.object({
  type: z.literal("run_claude_plan"),
  commandId: z.string(),
  prompt: z.string(),
  workspacePath: z.string().optional(),
  env: z.record(z.string()).optional(),
  permissionsProfile: z.enum(["restricted", "repo", "full"]).optional(),
  gitRepoUrl: z.string(),
  sshKeyType: z.enum(["uploaded", "local_path"]),
  sshKeyValue: z.string().nullable()
});

/** Run a source file or artifact with the host toolchain (agent must have the interpreter/compiler on PATH). */
export const toolchainLanguageSchema = z.enum([
  "python3",
  "java",
  "node",
  "go",
  "php",
  "typescript",
  "rust",
  "swift",
  "kotlin"
]);

export type ToolchainLanguage = z.infer<typeof toolchainLanguageSchema>;

const runToolchainCommandSchema = z.object({
  type: z.literal("run_toolchain"),
  commandId: z.string(),
  language: toolchainLanguageSchema,
  /** Path to script, source file, jar, or binary (absolute or relative to cwd). */
  path: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional()
});

/**
 * Stage a source tree from a .tar.gz (PHP, Node without build, static sites, etc.).
 * The archive is not sent over `/realtime` JSON; use a signed HTTPS URL or a path already on the agent host.
 */
const receiveSourceArchiveCommandSchema = z
  .object({
    type: z.literal("receive_source_archive"),
    commandId: z.string(),
    /** HTTPS URL to fetch (GET). The response body must be gzip-compressed tar (.tar.gz / .tgz). */
    url: z.string().url().optional(),
    /** Absolute path to a .tar.gz already present on the agent (e.g. pre-staged). */
    archivePath: z.string().optional(),
    /** Directory to extract into (created if needed). Defaults to the agent workspace path. */
    destDir: z.string().optional(),
    /** Same as `tar --strip-components` (omit leading path segments from archive members). */
    stripComponents: z.number().int().nonnegative().optional()
  })
  .superRefine((val, ctx) => {
    const u = val.url?.trim();
    const p = val.archivePath?.trim();
    if (!u && !p) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of url or archivePath"
      });
    }
    if (u && p) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide only one of url or archivePath"
      });
    }
  });

/** Uses `z.union` (not `discriminatedUnion`) so variants may apply `.superRefine` (e.g. receive_source_archive url xor path). */
export const platformToAgentMessageSchema = z.union([
  runStepCommandSchema,
  dockerOpCommandSchema,
  cancelRunCommandSchema,
  syncDesiredStateCommandSchema,
  runCursorPlanCommandSchema,
  runClaudePlanCommandSchema,
  runToolchainCommandSchema,
  receiveSourceArchiveCommandSchema
]);

export type AgentToPlatformMessage = z.infer<typeof agentToPlatformMessageSchema>;
export type PlatformToAgentMessage = z.infer<typeof platformToAgentMessageSchema>;
