import { describe, it, expect } from "vitest";
import { createLogIngestionProcessor, type IncidentStore } from "../src/log-ingestion.js";

const BASE_JOB = {
  tenantId: "t-1",
  agentId: "a-1",
  serviceId: "svc-1",
  level: "error" as const,
  message: "NullPointerException at com.example.App.main",
  ts: new Date().toISOString()
};

describe("createLogIngestionProcessor", () => {
  it("creates an incident for error-level log events", async () => {
    const processor = createLogIngestionProcessor({ cooldownMs: 3600_000 });
    const result = await processor(BASE_JOB);
    expect(result.kind).toBe("incident_created");
    if (result.kind === "incident_created") {
      expect(result.incident.tenantId).toBe("t-1");
      expect(result.incident.fingerprint).toBeTruthy();
    }
  });

  it("creates an incident for fatal-level log events", async () => {
    const processor = createLogIngestionProcessor({ cooldownMs: 3600_000 });
    const result = await processor({ ...BASE_JOB, level: "fatal" });
    expect(result.kind).toBe("incident_created");
  });

  it("ignores non-error log events", async () => {
    const processor = createLogIngestionProcessor({ cooldownMs: 3600_000 });
    for (const level of ["debug", "info", "warn"]) {
      const result = await processor({ ...BASE_JOB, level });
      expect(result.kind).toBe("ignored");
    }
  });

  it("suppresses duplicate fingerprints within cooldown window", async () => {
    const now = Date.now();
    const store: IncidentStore = {
      findOpenByFingerprint: async () => ({
        id: "inc-1",
        lastSeenAt: new Date(now - 1000).toISOString()
      }),
      upsertIncident: async () => {}
    };
    const processor = createLogIngestionProcessor({ cooldownMs: 3600_000, incidentStore: store });
    const result = await processor({ ...BASE_JOB, ts: new Date(now).toISOString() });
    expect(result.kind).toBe("suppressed");
  });

  it("allows incident after cooldown expires", async () => {
    const now = Date.now();
    const upserted: unknown[] = [];
    const store: IncidentStore = {
      findOpenByFingerprint: async () => ({
        id: "inc-1",
        lastSeenAt: new Date(now - 4_000_000).toISOString()
      }),
      upsertIncident: async (inc) => { upserted.push(inc); }
    };
    const processor = createLogIngestionProcessor({ cooldownMs: 3600_000, incidentStore: store });
    const result = await processor({ ...BASE_JOB, ts: new Date(now).toISOString() });
    expect(result.kind).toBe("incident_created");
    expect(upserted).toHaveLength(1);
  });

  it("rejects invalid job payloads", async () => {
    const processor = createLogIngestionProcessor({ cooldownMs: 3600_000 });
    await expect(processor({ bad: "data" })).rejects.toThrow();
  });
});
