import { logIngestionJobSchema, type LogIngestionJob } from "@sm/contracts";
import { fingerprintError, runDetectors, type LogDetector } from "@sm/domain";

export type IncidentRecord = {
  tenantId: string;
  serviceId: string;
  fingerprint: string;
  message: string;
  detectedAt: string;
  agentId: string;
};

export type LogIngestionResult =
  | { kind: "incident_created"; incident: IncidentRecord }
  | { kind: "suppressed"; reason: "cooldown"; fingerprint: string }
  | { kind: "ignored"; reason: "below_threshold" };

export type IncidentStore = {
  findOpenByFingerprint(tenantId: string, serviceId: string, fingerprint: string): Promise<{ id: string; lastSeenAt: string } | null>;
  upsertIncident(incident: IncidentRecord): Promise<void>;
};

const ERROR_LEVELS = new Set(["error", "fatal"]);

export function createLogIngestionProcessor(opts: {
  cooldownMs: number;
  incidentStore?: IncidentStore;
  detectors?: LogDetector[];
  detectorConfidenceThreshold?: number;
}) {
  const cooldownMs = opts.cooldownMs;
  const store = opts.incidentStore;
  const detectors = opts.detectors;
  const confidenceThreshold = opts.detectorConfidenceThreshold ?? 0.5;

  return async function processLogIngestionJob(raw: unknown): Promise<LogIngestionResult> {
    const job = logIngestionJobSchema.parse(raw);

    if (detectors && detectors.length > 0) {
      const matches = runDetectors(job.message, detectors);
      const hasMatch = matches.some((m) => m.confidence > confidenceThreshold);
      if (!hasMatch) {
        return { kind: "ignored", reason: "below_threshold" };
      }
    } else if (!ERROR_LEVELS.has(job.level)) {
      return { kind: "ignored", reason: "below_threshold" };
    }

    const fingerprint = fingerprintError(job.message);
    const eventTime = Date.parse(job.ts);

    if (store) {
      const existing = await store.findOpenByFingerprint(job.tenantId, job.serviceId, fingerprint);
      if (existing) {
        const lastSeen = Date.parse(existing.lastSeenAt);
        if (eventTime - lastSeen < cooldownMs) {
          return { kind: "suppressed", reason: "cooldown", fingerprint };
        }
      }
    }

    const incident: IncidentRecord = {
      tenantId: job.tenantId,
      serviceId: job.serviceId,
      fingerprint,
      message: job.message,
      detectedAt: job.ts,
      agentId: job.agentId
    };

    if (store) {
      await store.upsertIncident(incident);
    }

    return { kind: "incident_created", incident };
  };
}
