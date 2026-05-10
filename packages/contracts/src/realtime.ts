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
  /** Which AI CLI the agent should invoke when running automated fix plans (cursor or claude). */
  preferredExecutor: z.enum(["cursor", "claude"]).optional()
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

/**
 * Agent-side observation of the externally-facing endpoints for a
 * service it deployed via redeploy_service. Sent right after a
 * successful kubectl apply (in k8s mode) or `docker run` (in docker
 * mode). Server upserts service_loadbalancer_status keyed by
 * (service_id, environment).
 *
 * The agent reports as much as the cluster has assigned at the moment.
 * For metallb / cloud LB, externalIp/externalHostname populate; for
 * ingress-nginx the controller's external endpoint is reported in
 * externalIp/externalHostname and the ingress class lives in detail.
 * Fields that aren't applicable are null/empty.
 */
const lbStatusReportSchema = z.object({
  type: z.literal("lb_status_report"),
  agentId: z.string(),
  ts: z.string(),
  serviceId: z.string(),
  environment: z.string(),
  /** k8s namespace or docker grouping the service was deployed into. */
  namespace: z.string().default(""),
  buildId: z.string().optional(),
  /** Image reference the agent actually applied. */
  imageRef: z.string().optional(),
  lbType: z.enum(["none", "k8s", "metallb", "nginx"]),
  externalIp: z.string().nullable(),
  externalHostname: z.string().nullable(),
  ports: z
    .array(
      z.object({
        port: z.number().int(),
        name: z.string().optional(),
        protocol: z.string().optional(),
        targetPort: z.number().int().optional()
      })
    )
    .default([]),
  domains: z
    .array(
      z.object({
        host: z.string(),
        port: z.number().int(),
        protocol: z.enum(["http", "https"])
      })
    )
    .default([]),
  detail: z.record(z.unknown()).default({})
});

/** Periodic host and agent-process telemetry (CPU, memory, disk, network throughput). */
export const hostStatsSchema = z.object({
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

export type HostStatsMessage = z.infer<typeof hostStatsSchema>;

/**
 * Single error-level log line plus the last N context lines the agent saw
 * immediately before it. Emitted by the agent's logship wrapper; the API
 * normalizes the message, fingerprints, dedups into an error_group, and
 * triggers the auto-fix workflow when the service has git auth configured.
 */
export const appLogErrorSchema = z.object({
  type: z.literal("app_log_error"),
  agentId: z.string(),
  serviceId: z.string(),
  ts: z.string(),
  message: z.string(),
  contextLines: z.array(z.string())
});

export type AppLogErrorMessage = z.infer<typeof appLogErrorSchema>;

/** Periodic per-container telemetry for one app/container on the agent host. */
export const appStatsSchema = z.object({
  type: z.literal("app_stats"),
  agentId: z.string(),
  ts: z.string(),
  containerId: z.string(),
  name: z.string().optional(),
  image: z.string().optional(),
  serviceId: z.string().optional(),
  state: z.string().optional(),
  cpuPercent: z.number().min(0).optional(),
  memUsedBytes: z.number().int().nonnegative().optional(),
  memLimitBytes: z.number().int().positive().optional(),
  memPercent: z.number().min(0).max(100).optional(),
  netRxBytesPerSec: z.number().nonnegative().optional(),
  netTxBytesPerSec: z.number().nonnegative().optional()
});

export type AppStatsMessage = z.infer<typeof appStatsSchema>;

export const agentToPlatformMessageSchema = z.discriminatedUnion("type", [
  heartbeatSchema,
  logEventSchema,
  commandAckSchema,
  hostStatsSchema,
  appStatsSchema,
  appLogErrorSchema,
  lbStatusReportSchema
]);

export type LbStatusReportMessage = z.infer<typeof lbStatusReportSchema>;

/** Snapshot of an error group surfaced to the panel. */
export const errorGroupSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  agentId: z.string(),
  serviceId: z.string(),
  fingerprint: z.string(),
  normalizedMessage: z.string(),
  sampleMessage: z.string(),
  /** open: detected, eligible for fix. fixing: fix workflow in flight.
   *  fixed: most recent fix push succeeded. paused: same fingerprint reappeared
   *  shortly after a fix push (loop suspected). missing_auth: service has no
   *  git ssh key, auto-fix is disabled.
   */
  status: z.enum(["open", "fixing", "fixed", "paused", "missing_auth"]),
  count: z.number().int().nonnegative(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  lastFixAt: z.string().nullable().optional(),
  lastFixCommit: z.string().nullable().optional(),
  contextLines: z.array(z.string()).optional()
});

export type ErrorGroup = z.infer<typeof errorGroupSchema>;

/** UI telemetry stream events pushed by the API to subscribed panel clients. */
export const uiTelemetryEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("host_stats"),
    agentId: z.string(),
    stats: hostStatsSchema.omit({ type: true, agentId: true })
  }),
  z.object({
    type: z.literal("app_stats"),
    agentId: z.string(),
    containerId: z.string(),
    stats: appStatsSchema.omit({ type: true, agentId: true, containerId: true })
  }),
  z.object({
    type: z.literal("agent_presence"),
    agentId: z.string(),
    websocketConnected: z.boolean()
  }),
  z.object({
    type: z.literal("app_gone"),
    agentId: z.string(),
    containerId: z.string()
  }),
  z.object({
    type: z.literal("error_group_updated"),
    group: errorGroupSchema
  })
]);

export type UiTelemetryEvent = z.infer<typeof uiTelemetryEventSchema>;

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
  args: z.record(z.string()),
  agentRuntimeBackend: z.enum(["docker", "kubernetes", "shell"]).optional()
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
  ),
  /**
   * Managed host processes (non-container workloads). The agent matches a running process
   * by substring on its cmdline and reports it as an `app_stats` frame with
   * `containerId = "proc-<pid>"`.
   *
   * When `command` is set + `state: "running"` and no process matches `commandPattern`,
   * the agent will start the process via `bash -c "nohup <command> >> <logPath> 2>&1 &"`.
   * `logPath` defaults to `/tmp/sm-agent/<serviceId>.log`. The agent tails that file and
   * ships error-classified lines as `app_log_error` frames.
   */
  desiredProcesses: z
    .array(
      z.object({
        serviceId: z.string(),
        commandPattern: z.string().min(1),
        state: z.enum(["running", "stopped"]),
        command: z.string().optional(),
        logPath: z.string().optional(),
        cwd: z.string().optional()
      })
    )
    .optional()
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
  sshKeyValue: z.string().nullable(),
  agentRuntimeBackend: z.enum(["docker", "kubernetes", "shell"]).optional()
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
  sshKeyValue: z.string().nullable(),
  agentRuntimeBackend: z.enum(["docker", "kubernetes", "shell"]).optional()
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

/**
 * Auto-fix dispatch issued by the API when an error_group becomes eligible
 * for self-healing. The agent clones the service repo, runs the configured
 * AI CLI (claude/cursor) against it with the error + context as the prompt,
 * then commits any resulting changes and pushes to `branch`.
 */
const runFixPlanCommandSchema = z.object({
  type: z.literal("run_fix_plan"),
  commandId: z.string(),
  errorGroupId: z.string(),
  errorMessage: z.string(),
  normalizedMessage: z.string(),
  fingerprint: z.string(),
  contextLines: z.array(z.string()),
  gitRepoUrl: z.string(),
  branch: z.string().default("main"),
  sshKeyType: z.enum(["uploaded", "local_path"]),
  sshKeyValue: z.string().nullable(),
  workspacePath: z.string().optional(),
  serviceId: z.string(),
  agentRuntimeBackend: z.enum(["docker", "kubernetes", "shell"]).optional()
});

/**
 * Forces the agent to redeploy a service with the freshly-built image
 * reference. Emitted by the worker after a manual build (triggered_by
 * = 'manual') succeeds — the operator clicked "Start build" and
 * implicitly opted into a redeploy. Polled builds never emit this.
 *
 * v1: agent acknowledges receipt; the per-runtime "pull image and
 * recreate the container / `kubectl rollout restart`" handler is a
 * follow-up. The dispatch round-trip is wired now so the panel shows
 * the command being delivered.
 */
const redeployDomainSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["http", "https"])
});

const redeployLoadBalancerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("k8s"), annotations: z.record(z.string()).default({}) }),
  z.object({ type: z.literal("metallb"), addressPool: z.string().min(1).optional() }),
  z.object({
    type: z.literal("nginx"),
    ingressClass: z.string().min(1).default("nginx"),
    tlsSecret: z.string().min(1).optional()
  })
]);

const redeployServiceCommandSchema = z.object({
  type: z.literal("redeploy_service"),
  commandId: z.string(),
  serviceId: z.string(),
  /** Fully-qualified image reference (host/repo:tag) the agent should pull. */
  imageRef: z.string(),
  /** Source build row id, for cross-referencing in agent logs. */
  buildId: z.string(),
  /**
   * Per-agent deployment metadata, resolved by the worker via
   * resolveEnvironment(pipeline, agent.environment) before dispatch.
   * The agent receives only the slice that applies to its environment;
   * different agents bound to the same service get different values
   * for the same image.
   */
  environment: z.string(),
  instances: z.number().int().min(0),
  domains: z.array(redeployDomainSchema).default([]),
  loadBalancer: redeployLoadBalancerSchema.default({ type: "none" }),
  /**
   * Kubernetes namespace (k8s mode) or docker grouping name (docker
   * mode). Empty string means "fall back to runtime default":
   * k8s mode → agent pod's own namespace; docker mode → "kaiad".
   */
  namespace: z.string().default("")
});

/**
 * Tells the agent to remove a service it previously deployed. Sent by
 * the platform when a binding is removed via DELETE /api/v1/agents/:id/
 * services/:serviceId. The agent matches by labels (docker) or by the
 * synthesized resource name (k8s) — `namespace` carries the last-known
 * namespace from service_loadbalancer_status so the agent looks in the
 * right place.
 */
const teardownServiceCommandSchema = z.object({
  type: z.literal("teardown_service"),
  commandId: z.string(),
  serviceId: z.string(),
  environment: z.string().default(""),
  namespace: z.string().default("")
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
  receiveSourceArchiveCommandSchema,
  runFixPlanCommandSchema,
  redeployServiceCommandSchema,
  teardownServiceCommandSchema
]);

export type AgentToPlatformMessage = z.infer<typeof agentToPlatformMessageSchema>;
export type PlatformToAgentMessage = z.infer<typeof platformToAgentMessageSchema>;
