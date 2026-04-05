import {
  githubWebhookJobPayloadSchema,
  remediationJobSchema,
  type RemediationJob
} from "@sm/contracts";
import type { JobsOptions, Queue } from "bullmq";
import { fingerprintError } from "@sm/domain";
import { GitHubAppClient, policyGuardedMutation } from "@sm/github";
import { ensureCoreSchema } from "@sm/db";
import { queueNameFor } from "@sm/queue";
import { executors, type ExecutorRunMetadata } from "./executors.js";

type AuditEntry = {
  action: string;
  tenantId: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
};

type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
type AuditWriter = (query: QueryFn, entry: {
  tenantId: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}) => Promise<string>;

let auditPoolPromise: Promise<{ query: QueryFn } | null> | null = null;
let dbAuditWriterPromise: Promise<AuditWriter | null> | null = null;

async function getAuditPool(): Promise<{ query: QueryFn } | null> {
  if (!process.env.DATABASE_URL?.trim()) {
    return null;
  }
  if (!auditPoolPromise) {
    auditPoolPromise = (async () => {
      try {
        const { Pool } = await import("pg");
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        await ensureCoreSchema(pool);
        return {
          query: async (sql: string, params: unknown[]) => {
            const result = await pool.query(sql, params);
            return { rows: result.rows as Record<string, unknown>[] };
          }
        };
      } catch {
        return null;
      }
    })();
  }
  return auditPoolPromise;
}

async function getDbAuditWriter(): Promise<AuditWriter | null> {
  if (!dbAuditWriterPromise) {
    dbAuditWriterPromise = (async () => {
      try {
        const mod = await import("@sm/db");
        return mod.writeAuditLog as AuditWriter;
      } catch {
        return null;
      }
    })();
  }
  return dbAuditWriterPromise;
}

async function tryPersistAuditToDb(entry: AuditEntry): Promise<boolean> {
  const [pool, writeAuditLog] = await Promise.all([getAuditPool(), getDbAuditWriter()]);
  if (!pool || !writeAuditLog) {
    return false;
  }
  await writeAuditLog(pool.query, {
    tenantId: entry.tenantId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata
  });
  return true;
}

function emitAuditToStderr(
  action: string,
  tenantId: string,
  targetType: string,
  targetId?: string,
  metadata?: Record<string, unknown>
) {
  console.error(
    JSON.stringify({
      audit: true,
      action,
      tenantId,
      targetType,
      targetId,
      metadata,
      ts: new Date().toISOString()
    })
  );
}

async function logAuditEvent(entry: AuditEntry) {
  try {
    const persisted = await tryPersistAuditToDb(entry);
    if (!persisted) {
      emitAuditToStderr(entry.action, entry.tenantId, entry.targetType, entry.targetId, entry.metadata);
    }
  } catch {
    emitAuditToStderr(entry.action, entry.tenantId, entry.targetType, entry.targetId, entry.metadata);
  }
}

export type { ExecutorRunMetadata };

export type RemediationRunResult = {
  success: boolean;
  log: string;
  executor: RemediationJob["executor"];
  metadata: ExecutorRunMetadata;
};

export function mapErrorToIncident(input: { message: string; stack?: string[]; tenantId: string; serviceId: string }) {
  return {
    tenantId: input.tenantId,
    serviceId: input.serviceId,
    fingerprint: fingerprintError(input.message, input.stack),
    message: input.message
  };
}

export type LogDedupState = {
  lastSeenByFingerprint: Map<string, number>;
};

export type LogEventLevel = "debug" | "info" | "warn" | "error" | "fatal";

export type ProcessLogEventForIncidentResult =
  | {
      kind: "incident";
      incident: { tenantId: string; serviceId: string; fingerprint: string; message: string };
      nextState: LogDedupState;
    }
  | { kind: "suppressed"; reason: "cooldown"; fingerprint: string; nextState: LogDedupState }
  | { kind: "ignored"; reason: "non_error_level"; nextState: LogDedupState };

function cloneDedupState(state: LogDedupState): LogDedupState {
  return { lastSeenByFingerprint: new Map(state.lastSeenByFingerprint) };
}

export function processLogEventForIncident(
  input: {
    tenantId: string;
    logEvent: {
      level: LogEventLevel;
      message: string;
      serviceId: string;
      agentId: string;
      ts: string;
    };
    cooldownMs: number;
  },
  state: LogDedupState
): ProcessLogEventForIncidentResult {
  const nextState = cloneDedupState(state);
  if (input.logEvent.level !== "error") {
    return { kind: "ignored", reason: "non_error_level", nextState };
  }
  const fingerprint = fingerprintError(input.logEvent.message);
  const eventTimeMs = Date.parse(input.logEvent.ts);
  const lastSeenMs = state.lastSeenByFingerprint.get(fingerprint);
  if (lastSeenMs !== undefined && eventTimeMs - lastSeenMs < input.cooldownMs) {
    return { kind: "suppressed", reason: "cooldown", fingerprint, nextState };
  }
  nextState.lastSeenByFingerprint.set(fingerprint, eventTimeMs);
  return {
    kind: "incident",
    incident: {
      tenantId: input.tenantId,
      serviceId: input.logEvent.serviceId,
      fingerprint,
      message: input.logEvent.message
    },
    nextState
  };
}

export async function enqueueRemediationJob(
  queue: Pick<Queue<RemediationJob>, "add">,
  job: RemediationJob,
  opts?: JobsOptions
) {
  return queue.add("remediation", job, opts);
}

export async function runRemediation(rawJob: unknown): Promise<RemediationRunResult> {
  const job = remediationJobSchema.parse(rawJob);
  const executor = executors[job.executor];
  const result = await executor.run({
    workspacePath: `/tmp/${job.tenantId}/${job.incidentId}`,
    prompt: job.prompt,
    env: {}
  });
  await logAuditEvent({
    action: "remediation_run",
    tenantId: job.tenantId,
    targetType: "remediation_job",
    targetId: job.remediationJobId,
    metadata: {
      executor: job.executor,
      exitCode: result.exitCode,
      simulated: result.metadata.simulated
    }
  });
  return {
    success: result.exitCode === 0,
    log: result.log,
    executor: job.executor,
    metadata: result.metadata
  };
}

const githubMutationActionsHandledByWorker = new Set(["create_pr", "merge_pr", "push", "dispatch_workflow"]);

export type GithubJobProcessResult =
  | {
      ok: true;
      kind: "mutation";
      action: string;
      simulated: boolean;
      repo: string;
      branch: string;
    }
  | { ok: true; kind: "ingestion"; eventType: string }
  | { ok: false; code: "INVALID_PAYLOAD" | "UNSUPPORTED_ACTION" | "POLICY_DENY" | "CONFIG_ERROR"; message: string };

export type GithubProcessorOptions = {
  githubClient?: GitHubAppClient;
  getPolicy?: (tenantId: string) => Promise<{ repos: string[]; branches: string[]; actions: ("create_pr" | "merge_pr" | "dispatch_workflow" | "push")[] } | undefined>;
};

function isSimulateMode(): boolean {
  const allowSimulation = process.env.SM_GITHUB_ALLOW_SIMULATION === "1";
  if (!allowSimulation) {
    return false;
  }
  if (process.env.SM_GITHUB_SIMULATE !== "1") {
    return false;
  }
  if (process.env.NODE_ENV !== "production") {
    return true;
  }
  return process.env.SM_GITHUB_SIMULATE_IN_PRODUCTION === "1";
}

/** Validates GitHub queue job shape and applies worker-side policy (supported mutation actions). */
export async function processGithubWebhookJob(raw: unknown, opts?: GithubProcessorOptions): Promise<GithubJobProcessResult> {
  const parsed = githubWebhookJobPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "INVALID_PAYLOAD", message: parsed.error.message };
  }
  const job = parsed.data;
  const fallbackPullNumber =
    raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).pullNumber === "number"
      ? Number((raw as Record<string, unknown>).pullNumber)
      : undefined;
  if (job.kind === "github_ingestion") {
    return { ok: true, kind: "ingestion", eventType: job.eventType };
  }
  if (!githubMutationActionsHandledByWorker.has(job.action)) {
    return {
      ok: false,
      code: "UNSUPPORTED_ACTION",
      message: `GitHub mutation action not supported by worker: ${job.action}`
    };
  }

  if (opts?.getPolicy) {
    const policy = await opts.getPolicy(job.tenantId);
    const guard = policyGuardedMutation(policy, job.repo, job.branch, job.action);
    if (!guard.allowed) {
      return { ok: false, code: "POLICY_DENY", message: guard.reason };
    }
  }

  if (isSimulateMode()) {
    if (job.kind === "github_mutation") {
      await logAuditEvent({
        action: "github_mutation",
        tenantId: job.tenantId,
        targetType: "github_job",
        metadata: {
          action: job.action,
          repo: job.repo,
          branch: job.branch,
          simulated: true
        }
      });
    }
    return {
      ok: true,
      kind: "mutation",
      action: job.action,
      simulated: true,
      repo: job.repo,
      branch: job.branch
    };
  }

  if (!opts?.githubClient) {
    return {
      ok: false,
      code: "CONFIG_ERROR",
      message: "GitHub client is not configured; set GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY"
    };
  }

  const client = opts.githubClient;
  if (job.action === "create_pr") {
    await client.createPullRequest(job.installationId, job.repo, {
      title: `Automated PR for ${job.branch}`,
      head: job.branch,
      base: "main"
    });
  } else if (job.action === "merge_pr") {
    const pullNumber = job.pullNumber ?? fallbackPullNumber;
    if (!pullNumber) {
      return {
        ok: false,
        code: "INVALID_PAYLOAD",
        message: "merge_pr requires pullNumber"
      };
    }
    await client.mergePullRequest(job.installationId, job.repo, pullNumber);
  } else if (job.action === "push") {
    await client.push(job.installationId, job.repo, job.branch);
  } else if (job.action === "dispatch_workflow") {
    await client.dispatchWorkflow(job.installationId, job.repo, "ci.yml", job.branch);
  }

  if (job.kind === "github_mutation") {
    await logAuditEvent({
      action: "github_mutation",
      tenantId: job.tenantId,
      targetType: "github_job",
      metadata: {
        action: job.action,
        repo: job.repo,
        branch: job.branch,
        simulated: false
      }
    });
  }

  return {
    ok: true,
    kind: "mutation",
    action: job.action,
    simulated: false,
    repo: job.repo,
    branch: job.branch
  };
}

export function queueCatalog() {
  return {
    remediation: queueNameFor("remediation"),
    github: queueNameFor("github"),
    agentCommands: queueNameFor("agentCommands")
  };
}
