import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapErrorToIncident,
  processGithubWebhookJob,
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
      prompt: "fix this"
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

describe("github webhook job processor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("handles supported mutation actions in simulate mode", async () => {
    vi.stubEnv("SM_GITHUB_SIMULATE", "1");
    vi.stubEnv("SM_GITHUB_ALLOW_SIMULATION", "1");
    const create = await processGithubWebhookJob({
      kind: "github_mutation",
      tenantId: "t-1",
      installationId: 1,
      action: "create_pr",
      repo: "o/r",
      branch: "main"
    });
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error("unreachable");
    expect(create.kind).toBe("mutation");
    expect(create.simulated).toBe(true);
    expect(create.repo).toBe("o/r");

    const merge = await processGithubWebhookJob({
      kind: "github_mutation",
      tenantId: "t-1",
      installationId: 1,
      action: "merge_pr",
      repo: "o/r",
      branch: "main"
    });
    expect(merge.ok).toBe(true);

    const push = await processGithubWebhookJob({
      kind: "github_mutation",
      tenantId: "t-1",
      installationId: 1,
      action: "push",
      repo: "o/r",
      branch: "feat/x"
    });
    expect(push.ok).toBe(true);
    if (!push.ok) throw new Error("unreachable");
    expect(push.branch).toBe("feat/x");

    const dispatch = await processGithubWebhookJob({
      kind: "github_mutation",
      tenantId: "t-1",
      installationId: 1,
      action: "dispatch_workflow",
      repo: "o/r",
      branch: "main"
    });
    expect(dispatch.ok).toBe(true);
    if (!dispatch.ok) throw new Error("unreachable");
    expect(dispatch.kind).toBe("mutation");
  });

  it("ignores simulate mode for mutations unless SM_GITHUB_ALLOW_SIMULATION=1", async () => {
    vi.stubEnv("SM_GITHUB_SIMULATE", "1");
    const r = await processGithubWebhookJob({
      kind: "github_mutation",
      tenantId: "t-1",
      installationId: 1,
      action: "push",
      repo: "o/r",
      branch: "main"
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("CONFIG_ERROR");
  });

  it("disables simulate mode in production unless explicitly allowed", async () => {
    vi.stubEnv("SM_GITHUB_SIMULATE", "1");
    vi.stubEnv("NODE_ENV", "production");
    const r = await processGithubWebhookJob({
      kind: "github_mutation",
      tenantId: "t-1",
      installationId: 1,
      action: "push",
      repo: "o/r",
      branch: "main"
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("CONFIG_ERROR");
  });

  it("returns config error for mutation when client is missing and simulate mode is off", async () => {
    vi.stubEnv("SM_GITHUB_SIMULATE", "0");
    const r = await processGithubWebhookJob({
      kind: "github_mutation",
      tenantId: "t-1",
      installationId: 1,
      action: "push",
      repo: "o/r",
      branch: "main"
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("CONFIG_ERROR");
  });

  it("returns ingestion success for ingestion placeholder jobs", async () => {
    const r = await processGithubWebhookJob({
      kind: "github_ingestion",
      tenantId: "t-1",
      eventType: "issues"
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.kind).toBe("ingestion");
    expect(r.eventType).toBe("issues");
  });

  it("denies when policy blocks the action", async () => {
    const r = await processGithubWebhookJob(
      {
        kind: "github_mutation",
        tenantId: "t-1",
        installationId: 1,
        action: "push",
        repo: "o/r",
        branch: "main"
      },
      { getPolicy: async () => ({ repos: ["other/repo"], branches: ["main"], actions: ["push"] }) }
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("POLICY_DENY");
  });

  it("returns failure for invalid payload", async () => {
    const r = await processGithubWebhookJob({ not: "valid" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe("INVALID_PAYLOAD");
  });

  it("executes merge_pr against GitHub client in non-simulate mode", async () => {
    vi.stubEnv("SM_GITHUB_SIMULATE", "0");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "pem");
    const githubClient = {
      mergePullRequest: vi.fn().mockResolvedValue({ merged: true })
    } as any;
    const r = await processGithubWebhookJob(
      {
        kind: "github_mutation",
        tenantId: "t-1",
        installationId: 1,
        action: "merge_pr",
        repo: "o/r",
        branch: "main",
        pullNumber: 77
      },
      { githubClient }
    );
    expect(r.ok).toBe(true);
    expect(githubClient.mergePullRequest).toHaveBeenCalledWith(1, "o/r", 77);
  });

  it("executes push against GitHub client in non-simulate mode", async () => {
    vi.stubEnv("SM_GITHUB_SIMULATE", "0");
    vi.stubEnv("GITHUB_APP_PRIVATE_KEY", "pem");
    const githubClient = {
      push: vi.fn().mockResolvedValue({ pushUrl: "https://example.test/repo.git" })
    } as any;
    const r = await processGithubWebhookJob(
      {
        kind: "github_mutation",
        tenantId: "t-1",
        installationId: 1,
        action: "push",
        repo: "o/r",
        branch: "feature/x"
      },
      { githubClient }
    );
    expect(r.ok).toBe(true);
    expect(githubClient.push).toHaveBeenCalledWith(1, "o/r", "feature/x");
  });
});
