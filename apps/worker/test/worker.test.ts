import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapErrorToIncident,
  processLogEventForIncident,
  queueCatalog,
  runRemediation,
  type LogDedupState
} from "../src/index.js";

function baseLogEvent(overrides: {
  level?: "debug" | "info" | "warn" | "error" | "fatal";
  message?: string;
  ts?: string;
} = {}) {
  return {
    level: "error" as const,
    message: "PID=1 oops",
    serviceId: "svc-1",
    agentId: "agent-1",
    ts: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("log incident pipeline", () => {
  it("log event with level=error creates incident candidate with deterministic fingerprint", () => {
    const empty: LogDedupState = { lastSeenByFingerprint: new Map() };
    const a = processLogEventForIncident(
      { tenantId: "t1", logEvent: baseLogEvent({ message: "PID=1 oops" }), cooldownMs: 60_000 },
      empty
    );
    const b = processLogEventForIncident(
      { tenantId: "t1", logEvent: baseLogEvent({ message: "PID=2 oops" }), cooldownMs: 60_000 },
      empty
    );
    expect(a.kind).toBe("incident");
    expect(b.kind).toBe("incident");
    if (a.kind !== "incident" || b.kind !== "incident") throw new Error("unreachable");
    expect(a.incident.fingerprint).toBe(b.incident.fingerprint);
    expect(a.incident.fingerprint).toBe(
      mapErrorToIncident({ message: "PID=1 oops", tenantId: "t1", serviceId: "svc-1" }).fingerprint
    );
  });

  it("log event with non-error level is ignored", () => {
    const r = processLogEventForIncident(
      { tenantId: "t1", logEvent: baseLogEvent({ level: "info" }), cooldownMs: 60_000 },
      { lastSeenByFingerprint: new Map() }
    );
    expect(r.kind).toBe("ignored");
    if (r.kind !== "ignored") throw new Error("unreachable");
    expect(r.reason).toBe("non_error_level");
  });

  it("same fingerprint within cooldown window is suppressed", () => {
    const empty: LogDedupState = { lastSeenByFingerprint: new Map() };
    const first = processLogEventForIncident(
      {
        tenantId: "t1",
        logEvent: baseLogEvent({ ts: "2026-01-01T00:00:00.000Z" }),
        cooldownMs: 60_000
      },
      empty
    );
    expect(first.kind).toBe("incident");
    if (first.kind !== "incident") throw new Error("unreachable");
    const second = processLogEventForIncident(
      {
        tenantId: "t1",
        logEvent: baseLogEvent({ ts: "2026-01-01T00:00:30.000Z" }),
        cooldownMs: 60_000
      },
      first.nextState
    );
    expect(second.kind).toBe("suppressed");
    if (second.kind !== "suppressed") throw new Error("unreachable");
    expect(second.reason).toBe("cooldown");
  });

  it("same fingerprint outside cooldown is allowed again", () => {
    const empty: LogDedupState = { lastSeenByFingerprint: new Map() };
    const first = processLogEventForIncident(
      {
        tenantId: "t1",
        logEvent: baseLogEvent({ ts: "2026-01-01T00:00:00.000Z" }),
        cooldownMs: 60_000
      },
      empty
    );
    expect(first.kind).toBe("incident");
    if (first.kind !== "incident") throw new Error("unreachable");
    const second = processLogEventForIncident(
      {
        tenantId: "t1",
        logEvent: baseLogEvent({ ts: "2026-01-01T00:01:00.100Z" }),
        cooldownMs: 60_000
      },
      first.nextState
    );
    expect(second.kind).toBe("incident");
  });
});

describe("worker", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates deterministic incident fingerprints", () => {
    const first = mapErrorToIncident({ message: "PID=1 error", tenantId: "t1", serviceId: "s1" });
    const second = mapErrorToIncident({ message: "PID=2 error", tenantId: "t1", serviceId: "s1" });
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("exposes queue catalog from contracts", () => {
    expect(queueCatalog().remediation).toBe("remediation");
  });

  it("runs executor for remediation jobs", async () => {
    vi.stubEnv("SM_EXECUTOR_SIMULATE", "1");
    vi.stubEnv("SM_EXECUTOR_ALLOW_SIMULATION", "1");
    const output = await runRemediation({
      remediationJobId: "r-1",
      tenantId: "t-1",
      incidentId: "i-1",
      fingerprint: "f",
      executor: "cursor",
      prompt: "fix this",
      gitRepoUrl: "https://example.com/repo.git",
      sshKeyType: "uploaded",
      sshKeyValue: null
    });
    expect(output.success).toBe(true);
    expect(output.executor).toBe("cursor");
    expect(output.metadata.simulated).toBe(true);
    expect(output.metadata.command).toEqual(["cursor"]);
    expect(output.metadata.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(output.metadata.endedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(output.log).toContain("simulated run");
  });
});

