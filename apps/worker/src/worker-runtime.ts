import crypto from "node:crypto";
import { Queue, type Worker } from "bullmq";
import { GitHubAppClient } from "@sm/github";
import { QUEUE_NAMES, agentCommandDispatchResponseSchema, agentCommandJobSchema } from "@sm/contracts";
import { createNamedWorker, createRedisConnectionFromEnv } from "@sm/queue";
import {
  processGithubWebhookJob,
  runRemediation,
  type GithubJobProcessResult,
  type GithubProcessorOptions,
  type RemediationRunResult
} from "./index.js";
import { BUILT_IN_DETECTORS } from "@sm/domain";
import { createLogIngestionProcessor, type IncidentStore, type LogIngestionResult } from "./log-ingestion.js";

export type RedisConnection = ReturnType<typeof createRedisConnectionFromEnv>;

function resolveInternalApiToken(env: NodeJS.ProcessEnv): string {
  const configured = env.INTERNAL_API_TOKEN?.trim();
  if (configured) {
    return configured;
  }
  const nodeEnv = env.NODE_ENV ?? process.env.NODE_ENV;
  if (nodeEnv === "production") {
    throw new Error("INTERNAL_API_TOKEN is required in production");
  }
  return "dev-token";
}

/** Dispatches agent command jobs to the API realtime command ingress. */
export async function processAgentCommandJobDispatch(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch
): Promise<{ accepted: true; commandId: string; queued: boolean; delivered: boolean }> {
  const job = agentCommandJobSchema.parse(raw);
  const apiUrl = env.INTERNAL_API_URL;
  if (!apiUrl?.trim()) {
    throw new Error("INTERNAL_API_URL is required for agent command dispatch");
  }
  const internalToken = resolveInternalApiToken(env);
  const response = await fetchFn(`${apiUrl}/api/v1/internal/agent-commands`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${internalToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(job)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Agent command dispatch failed: ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`
    );
  }
  const body = await response.json().catch(() => ({}));
  return agentCommandDispatchResponseSchema.parse(body);
}

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;

function createInMemoryIncidentStore(): IncidentStore {
  const incidents = new Map<string, { id: string; tenantId: string; serviceId: string; fingerprint: string; lastSeenAt: string }>();
  return {
    async findOpenByFingerprint(tenantId, serviceId, fingerprint) {
      const key = `${tenantId}:${serviceId}:${fingerprint}`;
      return incidents.get(key) ?? null;
    },
    async upsertIncident(incident) {
      const key = `${incident.tenantId}:${incident.serviceId}:${incident.fingerprint}`;
      const existing = incidents.get(key);
      if (existing) {
        existing.lastSeenAt = incident.detectedAt;
      } else {
        incidents.set(key, {
          id: `inc-${crypto.randomUUID()}`,
          tenantId: incident.tenantId,
          serviceId: incident.serviceId,
          fingerprint: incident.fingerprint,
          lastSeenAt: incident.detectedAt
        });
      }
    }
  };
}

type AutomationPolicy = {
  repos: string[];
  branches: string[];
  actions: ("create_pr" | "merge_pr" | "dispatch_workflow" | "push")[];
};

/**
 * Fetches automation policy from the control-plane API.
 * Fails closed by default when policy cannot be loaded; set
 * SM_GITHUB_ALLOW_UNGUARDED=1 for explicit dev-only degraded mode.
 */
async function getPolicyFromApi(_tenantId: string): Promise<AutomationPolicy | undefined> {
  const apiUrl = process.env.INTERNAL_API_URL;
  const allowUnguarded = process.env.SM_GITHUB_ALLOW_UNGUARDED === "1";
  if (!apiUrl) {
    if (allowUnguarded) return undefined;
    throw new Error("INTERNAL_API_URL is required for GitHub policy enforcement");
  }
  try {
    const internalToken = resolveInternalApiToken(process.env);
    const res = await fetch(`${apiUrl}/api/v1/settings`, {
      headers: { Authorization: `Bearer ${internalToken}` }
    });
    if (!res.ok) {
      if (allowUnguarded) return undefined;
      throw new Error(`Failed to fetch policy from API: ${res.status}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return data.automationPolicy as AutomationPolicy | undefined;
  } catch {
    if (allowUnguarded) return undefined;
    throw new Error("Failed to fetch policy from API");
  }
}

export function wireBullmqWorkers(
  connection: RedisConnection,
  env: NodeJS.ProcessEnv = process.env
): Worker[] {
  const processLogIngestion = createLogIngestionProcessor({
    cooldownMs: DEFAULT_COOLDOWN_MS,
    detectors: BUILT_IN_DETECTORS,
    incidentStore: createInMemoryIncidentStore()
  });

  const githubOpts: GithubProcessorOptions = {};
  const appId = Number(env.GITHUB_APP_ID);
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (appId > 0 && privateKey) {
    githubOpts.githubClient = new GitHubAppClient({ appId, privateKey });
  }
  githubOpts.getPolicy = getPolicyFromApi;

  const remediation = createNamedWorker<unknown, RemediationRunResult>("remediation", connection, async (job) =>
    runRemediation(job.data)
  );
  const github = createNamedWorker<unknown, GithubJobProcessResult>("github", connection, async (job) =>
    processGithubWebhookJob(job.data, githubOpts)
  );
  const agentCommands = createNamedWorker<unknown, { accepted: true; commandId: string; queued: boolean; delivered: boolean }>(
    "agentCommands",
    connection,
    async (job) => processAgentCommandJobDispatch(job.data, env)
  );
  const remediationQueue = new Queue(QUEUE_NAMES.remediation, { connection });

  const logIngestion = createNamedWorker<unknown, LogIngestionResult>("logIngestion", connection, async (job) => {
    const result = await processLogIngestion(job.data);
    if (result.kind === "incident_created") {
      await remediationQueue.add("remediation", {
        remediationJobId: `rem-${crypto.randomUUID()}`,
        tenantId: result.incident.tenantId,
        incidentId: "inc-auto",
        fingerprint: result.incident.fingerprint,
        executor: "cursor",
        prompt: `Auto-remediation for: ${result.incident.message}`
      });
    }
    return result;
  });
  return [remediation, github, agentCommands, logIngestion];
}

export function startQueueConsumersFromEnv(env: NodeJS.ProcessEnv = process.env): {
  connection: RedisConnection | null;
  workers: Worker[];
} {
  if (env.REDIS_DISABLED === "1") {
    return { connection: null, workers: [] };
  }
  const connection = createRedisConnectionFromEnv(env);
  const workers = wireBullmqWorkers(connection, env);
  return { connection, workers };
}

export async function shutdownWorkersAndRedis(
  workers: Worker[],
  connection: RedisConnection | null
): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  if (connection) {
    await connection.quit();
  }
}
