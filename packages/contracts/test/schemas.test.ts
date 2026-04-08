import { describe, expect, it } from "vitest";
import {
  API_PREFIX,
  CORRELATION_HEADER,
  QUEUE_NAMES,
  agentCommandDispatchResponseSchema,
  agentCommandJobSchema,
  agentSchema,
  agentHelloMessageSchema,
  agentToPlatformMessageSchema,
  apiErrorSchema,
  automationActionSchema,
  automationPolicySchema,
  createEnrollmentTokenRequestSchema,
  createEnrollmentTokenResponseSchema,
  createMonitoredServiceRequestSchema,
  executeWorkflowRequestSchema,
  executeWorkflowResponseSchema,
  createWorkflowGraphRequestSchema,
  enrollmentTokenMetadataSchema,
  githubInstallationSettingsSchema,
  githubInstallationsResponseSchema,
  githubMutationJobSchema,
  githubPolicyCheckRequestSchema,
  githubWebhookIngestionPlaceholderJobSchema,
  githubWebhookJobPayloadSchema,
  githubWebhookMutationJobSchema,
  healthResponseSchema,
  incidentSchema,
  incidentStatusSchema,
  listAgentsResponseSchema,
  listEnrollmentTokensResponseSchema,
  listIncidentsResponseSchema,
  listMonitoredServicesResponseSchema,
  listWorkflowGraphsResponseSchema,
  logIngestionJobSchema,
  meResponseSchema,
  monitoredServiceSchema,
  platformToAgentMessageSchema,
  remediationJobSchema,
  tenantSettingsSchema,
  updateIncidentStatusRequestSchema,
  upsertGithubInstallationRequestSchema,
  upsertTenantSettingsRequestSchema,
  workflowGraphEdgeSchema,
  workflowGraphNodeSchema,
  workflowGraphSchema
} from "../src/index.js";

const iso = "2026-01-01T00:00:00.000Z";

describe("constants.ts", () => {
  it("exports stable API_PREFIX", () => {
    expect(API_PREFIX).toBe("/api/v1");
  });

  it("exports QUEUE_NAMES", () => {
    expect(QUEUE_NAMES.remediation).toBe("remediation");
    expect(QUEUE_NAMES.github).toBe("github");
    expect(QUEUE_NAMES.agentCommands).toBe("agent-commands");
    expect(QUEUE_NAMES.logIngestion).toBe("log-ingestion");
  });

  it("exports CORRELATION_HEADER", () => {
    expect(CORRELATION_HEADER).toBe("x-correlation-id");
  });
});

describe("errors.ts", () => {
  describe("apiErrorSchema", () => {
    it("accepts a valid API error", () => {
      expect(() =>
        apiErrorSchema.parse({
          code: "POLICY_DENY",
          message: "Denied",
          correlationId: "cid-1",
          details: { repo: "o/r" }
        })
      ).not.toThrow();
    });

    it("rejects non-object root", () => {
      expect(() => apiErrorSchema.parse("err")).toThrow();
    });
  });
});

describe("http.ts", () => {
  describe("healthResponseSchema", () => {
    it("accepts valid health payload", () => {
      expect(() =>
        healthResponseSchema.parse({ status: "ok", uptimeSeconds: 42 })
      ).not.toThrow();
    });

    it("rejects wrong status enum", () => {
      expect(() =>
        healthResponseSchema.parse({ status: "degraded", uptimeSeconds: 1 })
      ).toThrow();
    });
  });

  describe("meResponseSchema", () => {
    it("accepts valid me response", () => {
      expect(() =>
        meResponseSchema.parse({
          id: "u-1",
          email: "a@b.co",
          role: "admin",
          tenantId: "t-1",
          memberships: [
            { tenantId: "t-1", tenantName: "Acme", role: "admin" as const }
          ]
        })
      ).not.toThrow();
    });

    it("rejects invalid email", () => {
      expect(() =>
        meResponseSchema.parse({
          id: "u-1",
          email: "not-an-email",
          role: "viewer",
          tenantId: "t-1",
          memberships: []
        })
      ).toThrow();
    });
  });

  describe("automationActionSchema", () => {
    it("accepts create_pr", () => {
      expect(() => automationActionSchema.parse("merge_pr")).not.toThrow();
    });

    it("rejects unknown action", () => {
      expect(() => automationActionSchema.parse("delete_repo")).toThrow();
    });
  });

  describe("automationPolicySchema", () => {
    it("accepts valid policy", () => {
      expect(() =>
        automationPolicySchema.parse({
          repos: ["o/r"],
          branches: ["main"],
          actions: ["create_pr", "merge_pr"]
        })
      ).not.toThrow();
    });

    it("allows empty repos array", () => {
      expect(() =>
        automationPolicySchema.parse({
          repos: [],
          branches: ["main"],
          actions: ["push"]
        })
      ).not.toThrow();
    });

    it("rejects invalid nested action", () => {
      expect(() =>
        automationPolicySchema.parse({
          repos: ["o/r"],
          branches: ["main"],
          actions: ["bad"]
        })
      ).toThrow();
    });
  });

  describe("tenantSettingsSchema", () => {
    it("accepts minimal settings", () => {
      expect(() =>
        tenantSettingsSchema.parse({
          tenantId: "t-1",
          githubRepo: "o/r",
          defaultBranch: "main"
        })
      ).not.toThrow();
    });

    it("rejects invalid docsUrl", () => {
      expect(() =>
        tenantSettingsSchema.parse({
          tenantId: "t-1",
          githubRepo: "o/r",
          defaultBranch: "main",
          docsUrl: "not-a-url"
        })
      ).toThrow();
    });

    it("accepts preferredExecutor", () => {
      expect(() =>
        tenantSettingsSchema.parse({
          tenantId: "t-1",
          githubRepo: "o/r",
          defaultBranch: "main",
          preferredExecutor: "claude"
        })
      ).not.toThrow();
    });

    it("rejects invalid preferredExecutor", () => {
      expect(() =>
        tenantSettingsSchema.parse({
          tenantId: "t-1",
          githubRepo: "o/r",
          defaultBranch: "main",
          preferredExecutor: "vscode"
        })
      ).toThrow();
    });

    it("accepts agentRuntimeBackend", () => {
      expect(() =>
        tenantSettingsSchema.parse({
          tenantId: "t-1",
          githubRepo: "o/r",
          defaultBranch: "main",
          agentRuntimeBackend: "shell"
        })
      ).not.toThrow();
    });

    it("rejects invalid agentRuntimeBackend", () => {
      expect(() =>
        tenantSettingsSchema.parse({
          tenantId: "t-1",
          githubRepo: "o/r",
          defaultBranch: "main",
          agentRuntimeBackend: "podman"
        })
      ).toThrow();
    });

    it("accepts agentWorkloadSource", () => {
      expect(() =>
        tenantSettingsSchema.parse({
          tenantId: "t-1",
          githubRepo: "o/r",
          defaultBranch: "main",
          agentWorkloadSource: "binary"
        })
      ).not.toThrow();
    });

    it("accepts null agentWorkloadSource", () => {
      const v = tenantSettingsSchema.parse({
        tenantId: "t-1",
        githubRepo: "o/r",
        defaultBranch: "main",
        agentWorkloadSource: null
      });
      expect(v.agentWorkloadSource).toBeNull();
    });
  });

  describe("githubPolicyCheckRequestSchema", () => {
    it("accepts valid request", () => {
      expect(() =>
        githubPolicyCheckRequestSchema.parse({
          repo: "o/r",
          branch: "main",
          action: "dispatch_workflow"
        })
      ).not.toThrow();
    });

    it("rejects missing branch", () => {
      expect(() =>
        githubPolicyCheckRequestSchema.parse({
          repo: "o/r",
          action: "push"
        })
      ).toThrow();
    });
  });

  describe("upsertTenantSettingsRequestSchema", () => {
    it("matches tenantSettingsSchema", () => {
      const v = upsertTenantSettingsRequestSchema.parse({
        tenantId: "t-1",
        githubRepo: "o/r",
        defaultBranch: "main"
      });
      expect(v.tenantId).toBe("t-1");
    });

    it("rejects missing defaultBranch", () => {
      expect(() =>
        upsertTenantSettingsRequestSchema.parse({
          tenantId: "t-1",
          githubRepo: "o/r"
        })
      ).toThrow();
    });
  });

  describe("githubInstallationSettingsSchema", () => {
    it("accepts valid installation", () => {
      expect(() =>
        githubInstallationSettingsSchema.parse({
          installationId: 9,
          accountLogin: "acme",
          appId: 123
        })
      ).not.toThrow();
    });

    it("rejects non-positive installationId", () => {
      expect(() =>
        githubInstallationSettingsSchema.parse({
          installationId: 0,
          accountLogin: "acme",
          appId: 1
        })
      ).toThrow();
    });
  });

  describe("upsertGithubInstallationRequestSchema", () => {
    it("accepts body with optional tenantId", () => {
      expect(() =>
        upsertGithubInstallationRequestSchema.parse({
          installationId: 7,
          accountLogin: "acme",
          appId: 100,
          tenantId: "t-1"
        })
      ).not.toThrow();
    });

    it("rejects empty accountLogin", () => {
      expect(() =>
        upsertGithubInstallationRequestSchema.parse({
          installationId: 1,
          accountLogin: "",
          appId: 1
        })
      ).toThrow();
    });
  });

  describe("githubInstallationsResponseSchema", () => {
    it("accepts list wrapper", () => {
      expect(() =>
        githubInstallationsResponseSchema.parse({
          installations: [{ installationId: 1, accountLogin: "x", appId: 2 }]
        })
      ).not.toThrow();
    });

    it("rejects malformed installation entry", () => {
      expect(() =>
        githubInstallationsResponseSchema.parse({
          installations: [{ installationId: "nope" }]
        })
      ).toThrow();
    });
  });

  describe("createEnrollmentTokenRequestSchema", () => {
    it("accepts ttlSeconds", () => {
      expect(() => createEnrollmentTokenRequestSchema.parse({ ttlSeconds: 3600 })).not.toThrow();
    });

    it("rejects non-positive ttl", () => {
      expect(() => createEnrollmentTokenRequestSchema.parse({ ttlSeconds: 0 })).toThrow();
    });
  });

  describe("enrollmentTokenMetadataSchema", () => {
    it("accepts metadata", () => {
      expect(() =>
        enrollmentTokenMetadataSchema.parse({
          id: "tok-1",
          tenantId: "t-1",
          expiresAt: iso,
          createdBy: "u-1",
          createdAt: iso,
          usedAt: null,
          revokedAt: null,
          isActive: true
        })
      ).not.toThrow();
    });

    it("rejects invalid datetime", () => {
      expect(() =>
        enrollmentTokenMetadataSchema.parse({
          id: "tok-1",
          tenantId: "t-1",
          expiresAt: "yesterday",
          createdBy: "u-1",
          createdAt: iso,
          usedAt: null,
          revokedAt: null,
          isActive: true
        })
      ).toThrow();
    });
  });

  describe("createEnrollmentTokenResponseSchema", () => {
    it("accepts response with token", () => {
      expect(() =>
        createEnrollmentTokenResponseSchema.parse({
          id: "tok-1",
          tenantId: "t-1",
          token: "secret",
          expiresAt: iso,
          createdBy: "u-1",
          createdAt: iso,
          usedAt: null,
          revokedAt: null,
          isActive: true
        })
      ).not.toThrow();
    });

    it("rejects empty token", () => {
      expect(() =>
        createEnrollmentTokenResponseSchema.parse({
          id: "tok-1",
          tenantId: "t-1",
          token: "",
          expiresAt: iso,
          createdBy: "u-1",
          createdAt: iso,
          usedAt: null,
          revokedAt: null,
          isActive: true
        })
      ).toThrow();
    });
  });

  describe("listEnrollmentTokensResponseSchema", () => {
    it("accepts tokens array", () => {
      expect(() =>
        listEnrollmentTokensResponseSchema.parse({
          tokens: [
            {
              id: "tok-1",
              tenantId: "t-1",
              expiresAt: iso,
              createdBy: "u-1",
              createdAt: iso,
              usedAt: null,
              revokedAt: null,
              isActive: true
            }
          ]
        })
      ).not.toThrow();
    });

    it("rejects tokens with missing id", () => {
      expect(() =>
        listEnrollmentTokensResponseSchema.parse({
          tokens: [{ tenantId: "t-1" }]
        })
      ).toThrow();
    });
  });

  describe("incidentStatusSchema", () => {
    it("accepts acknowledged", () => {
      expect(() => incidentStatusSchema.parse("acknowledged")).not.toThrow();
    });

    it("rejects invalid status", () => {
      expect(() => incidentStatusSchema.parse("pending")).toThrow();
    });
  });

  describe("incidentSchema", () => {
    it("accepts valid incident", () => {
      expect(() =>
        incidentSchema.parse({
          id: "inc-1",
          tenantId: "t-1",
          serviceId: "svc-1",
          fingerprint: "abc",
          status: "open",
          firstSeenAt: iso,
          lastSeenAt: iso,
          eventCount: 1
        })
      ).not.toThrow();
    });

    it("rejects missing tenantId", () => {
      expect(() =>
        incidentSchema.parse({
          id: "inc-1",
          serviceId: "svc-1",
          fingerprint: "abc",
          status: "open",
          firstSeenAt: iso,
          lastSeenAt: iso
        })
      ).toThrow();
    });
  });

  describe("listIncidentsResponseSchema", () => {
    it("accepts list wrapper", () => {
      expect(() =>
        listIncidentsResponseSchema.parse({
          incidents: [
            {
              id: "inc-1",
              tenantId: "t-1",
              serviceId: "svc-1",
              fingerprint: "fp",
              status: "open",
              firstSeenAt: iso,
              lastSeenAt: iso
            }
          ]
        })
      ).not.toThrow();
    });

    it("rejects malformed incident", () => {
      expect(() =>
        listIncidentsResponseSchema.parse({
          incidents: [{ id: "inc-1" }]
        })
      ).toThrow();
    });
  });

  describe("updateIncidentStatusRequestSchema", () => {
    it("accepts status", () => {
      expect(() =>
        updateIncidentStatusRequestSchema.parse({ status: "resolved" })
      ).not.toThrow();
    });

    it("rejects empty object", () => {
      expect(() => updateIncidentStatusRequestSchema.parse({})).toThrow();
    });
  });

  describe("workflowGraphNodeSchema", () => {
    it("accepts node with type and kind", () => {
      expect(() =>
        workflowGraphNodeSchema.parse({
          id: "n1",
          type: "action",
          kind: "runShell",
          data: { label: "Build" }
        })
      ).not.toThrow();
    });

    it("rejects missing kind", () => {
      expect(() => workflowGraphNodeSchema.parse({ id: "n1", type: "action" })).toThrow();
    });
  });

  describe("workflowGraphEdgeSchema", () => {
    it("accepts edge", () => {
      expect(() =>
        workflowGraphEdgeSchema.parse({ from: "a", to: "b" })
      ).not.toThrow();
    });

    it("rejects missing to", () => {
      expect(() => workflowGraphEdgeSchema.parse({ from: "a" })).toThrow();
    });
  });

  describe("workflowGraphSchema", () => {
    const baseNodes = [{ id: "n1", type: "event", kind: "onCrash" }];
    const baseEdges = [{ from: "n1", to: "n2" }];

    it("accepts graph", () => {
      expect(() =>
        workflowGraphSchema.parse({
          id: "g-1",
          tenantId: "t-1",
          serviceId: "svc-1",
          version: 1,
          nodes: baseNodes,
          edges: baseEdges,
          isActive: true
        })
      ).not.toThrow();
    });

    it("rejects non-positive version", () => {
      expect(() =>
        workflowGraphSchema.parse({
          id: "g-1",
          tenantId: "t-1",
          serviceId: "svc-1",
          version: 0,
          nodes: baseNodes,
          edges: baseEdges,
          isActive: false
        })
      ).toThrow();
    });
  });

  describe("workflowGraphNodeSchema trigger data rules", () => {
    it("accepts onSchedule with schedule", () => {
      expect(() =>
        workflowGraphNodeSchema.parse({
          id: "n1",
          type: "event",
          kind: "onSchedule",
          data: { schedule: "*/5 * * * *" }
        })
      ).not.toThrow();
    });

    it("rejects onCrash with schedule", () => {
      expect(() =>
        workflowGraphNodeSchema.parse({
          id: "n1",
          type: "event",
          kind: "onCrash",
          data: { schedule: "*/5 * * * *" }
        })
      ).toThrow();
    });

    it("rejects onLogPattern without filter", () => {
      expect(() =>
        workflowGraphNodeSchema.parse({
          id: "n1",
          type: "event",
          kind: "onLogPattern",
          data: {}
        })
      ).toThrow();
    });
  });

  describe("createWorkflowGraphRequestSchema", () => {
    it("accepts create request", () => {
      expect(() =>
        createWorkflowGraphRequestSchema.parse({
          serviceId: "svc-1",
          nodes: [{ id: "n1", type: "event", kind: "onCrash" }],
          edges: []
        })
      ).not.toThrow();
    });

    it("rejects missing serviceId", () => {
      expect(() =>
        createWorkflowGraphRequestSchema.parse({
          nodes: [],
          edges: []
        })
      ).toThrow();
    });
  });

  describe("listWorkflowGraphsResponseSchema", () => {
    it("accepts graphs list", () => {
      expect(() =>
        listWorkflowGraphsResponseSchema.parse({
          graphs: [
            {
              id: "g-1",
              tenantId: "t-1",
              serviceId: "svc-1",
              version: 1,
              nodes: [{ id: "n1", type: "event", kind: "onCrash" }],
              edges: [],
              isActive: true
            }
          ]
        })
      ).not.toThrow();
    });

    it("rejects invalid graph entry", () => {
      expect(() =>
        listWorkflowGraphsResponseSchema.parse({
          graphs: [{ id: "g-1" }]
        })
      ).toThrow();
    });
  });

  describe("executeWorkflowRequestSchema", () => {
    it("accepts execute request payload", () => {
      expect(() =>
        executeWorkflowRequestSchema.parse({
          serviceId: "svc-1",
          nodes: [{ id: "n1", type: "event", kind: "onCrash" }],
          edges: []
        })
      ).not.toThrow();
    });
  });

  describe("executeWorkflowResponseSchema", () => {
    it("accepts execute response payload", () => {
      expect(() =>
        executeWorkflowResponseSchema.parse({
          accepted: true,
          workflowId: "wf-1",
          workflowVersion: 2,
          agentId: "a-1",
          commandId: "cmd-1",
          dispatchState: "queued_for_dispatch"
        })
      ).not.toThrow();
    });
  });

  describe("monitoredServiceSchema", () => {
    it("accepts service", () => {
      expect(() =>
        monitoredServiceSchema.parse({
          id: "svc-1",
          tenantId: "t-1",
          agentId: null,
          name: "api",
          repo: "o/r",
          branch: "main"
        })
      ).not.toThrow();
    });

    it("rejects missing name", () => {
      expect(() =>
        monitoredServiceSchema.parse({
          id: "svc-1",
          tenantId: "t-1",
          agentId: null,
          repo: "o/r",
          branch: "main"
        })
      ).toThrow();
    });
  });

  describe("createMonitoredServiceRequestSchema", () => {
    it("accepts create request", () => {
      expect(() =>
        createMonitoredServiceRequestSchema.parse({
          name: "api",
          repo: "o/r",
          branch: "main"
        })
      ).not.toThrow();
    });

    it("rejects empty name", () => {
      expect(() =>
        createMonitoredServiceRequestSchema.parse({
          name: "",
          repo: "o/r",
          branch: "main"
        })
      ).toThrow();
    });
  });

  describe("listMonitoredServicesResponseSchema", () => {
    it("accepts services list", () => {
      expect(() =>
        listMonitoredServicesResponseSchema.parse({
          services: [
            {
              id: "svc-1",
              tenantId: "t-1",
              agentId: null,
              name: "api",
              repo: "o/r",
              branch: "main"
            }
          ]
        })
      ).not.toThrow();
    });

    it("rejects invalid service row", () => {
      expect(() =>
        listMonitoredServicesResponseSchema.parse({
          services: [{ id: "svc-1" }]
        })
      ).toThrow();
    });
  });

  describe("agentSchema", () => {
    it("accepts agent", () => {
      expect(() =>
        agentSchema.parse({
          id: "a-1",
          tenantId: "t-1",
          name: null,
          version: null,
          status: "online",
          lastSeenAt: iso
        })
      ).not.toThrow();
    });

    it("accepts name and version as nullable strings", () => {
      expect(() =>
        agentSchema.parse({
          id: "a-1",
          tenantId: "t-1",
          name: "edge-1",
          version: "1.0.0",
          status: "online",
          lastSeenAt: iso,
          certFingerprint: "ab:cd",
          allowedCapabilities: ["docker", "compose"]
        })
      ).not.toThrow();
    });

    it("accepts websocketConnected from server merge", () => {
      expect(() =>
        agentSchema.parse({
          id: "a-1",
          tenantId: "t-1",
          name: null,
          version: null,
          status: "online",
          lastSeenAt: iso,
          websocketConnected: true
        })
      ).not.toThrow();
    });

    it("rejects invalid status", () => {
      expect(() =>
        agentSchema.parse({
          id: "a-1",
          tenantId: "t-1",
          name: null,
          version: null,
          status: "sleeping",
          lastSeenAt: null
        })
      ).toThrow();
    });
  });

  describe("listAgentsResponseSchema", () => {
    it("accepts agents list", () => {
      expect(() =>
        listAgentsResponseSchema.parse({
          agents: [
            {
              id: "a-1",
              tenantId: "t-1",
              name: null,
              version: null,
              status: "offline",
              lastSeenAt: null,
              websocketConnected: false
            }
          ]
        })
      ).not.toThrow();
    });

    it("rejects malformed agent", () => {
      expect(() =>
        listAgentsResponseSchema.parse({
          agents: [{ id: "a-1" }]
        })
      ).toThrow();
    });
  });
});

describe("realtime.ts", () => {
  describe("agentHelloMessageSchema", () => {
    it("accepts minimal hello", () => {
      expect(() =>
        agentHelloMessageSchema.parse({
          type: "hello",
          service: "realtime"
        })
      ).not.toThrow();
    });

    it("accepts hello with runtime", () => {
      const m = agentHelloMessageSchema.parse({
        type: "hello",
        service: "realtime",
        runtime: { backend: "kubernetes" }
      });
      expect(m.runtime?.backend).toBe("kubernetes");
    });

    it("accepts hello with workload and configReady", () => {
      const m = agentHelloMessageSchema.parse({
        type: "hello",
        service: "realtime",
        runtime: { backend: "docker" },
        configReady: false,
        workload: { source: null, githubRepo: "a/b", defaultBranch: "main" }
      });
      expect(m.configReady).toBe(false);
      expect(m.workload?.source).toBeNull();
    });
  });

  describe("agentToPlatformMessageSchema", () => {
    it("accepts heartbeat", () => {
      expect(() =>
        agentToPlatformMessageSchema.parse({
          type: "heartbeat",
          agentId: "a-1",
          ts: iso,
          capacity: 4
        })
      ).not.toThrow();
    });

    it("accepts log_event", () => {
      expect(() =>
        agentToPlatformMessageSchema.parse({
          type: "log_event",
          agentId: "a-1",
          serviceId: "svc-1",
          level: "error",
          message: "boom",
          ts: iso
        })
      ).not.toThrow();
    });

    it("accepts command_ack", () => {
      expect(() =>
        agentToPlatformMessageSchema.parse({
          type: "command_ack",
          commandId: "c-1",
          status: "completed",
          ts: iso
        })
      ).not.toThrow();
    });

    it("accepts host_stats", () => {
      expect(() =>
        agentToPlatformMessageSchema.parse({
          type: "host_stats",
          agentId: "a-1",
          ts: iso,
          cpuPercent: 12.5,
          memUsedBytes: 1_000_000,
          memTotalBytes: 8_000_000_000,
          netRxBytesPerSec: 1024,
          netTxBytesPerSec: 512
        })
      ).not.toThrow();
    });

    it("rejects unknown discriminator", () => {
      expect(() =>
        agentToPlatformMessageSchema.parse({
          type: "unknown",
          agentId: "a-1"
        })
      ).toThrow();
    });
  });

  describe("platformToAgentMessageSchema", () => {
    it("accepts run_step", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "run_step",
          commandId: "c-1",
          shell: "bash -lc 'echo hi'",
          env: { CI: "true" }
        })
      ).not.toThrow();
    });

    it("accepts docker_op", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "docker_op",
          commandId: "c-2",
          operation: "build",
          args: { tag: "app:latest" }
        })
      ).not.toThrow();
    });

    it("accepts cancel_run", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "cancel_run",
          commandId: "c-3",
          targetCommandId: "c-2"
        })
      ).not.toThrow();
    });

    it("accepts sync_desired_state", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "sync_desired_state",
          commandId: "c-4",
          desiredContainers: [
            { serviceId: "svc-1", image: "nginx:latest", state: "running" },
            { serviceId: "svc-2", image: "redis:7", state: "stopped" }
          ]
        })
      ).not.toThrow();
    });

    it("accepts run_cursor_plan", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "run_cursor_plan",
          commandId: "c-5",
          prompt: "Investigate crash and prepare patch",
          workspacePath: "/workspace/svc-1",
          env: { SM_INCIDENT_ID: "inc-1" },
          permissionsProfile: "repo"
        })
      ).not.toThrow();
    });

    it("accepts run_claude_plan", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "run_claude_plan",
          commandId: "c-6",
          prompt: "Draft and apply fix for failing tests",
          workspacePath: "/workspace/svc-2",
          env: { SM_INCIDENT_ID: "inc-2" },
          permissionsProfile: "restricted"
        })
      ).not.toThrow();
    });

    it("accepts run_toolchain", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "run_toolchain",
          commandId: "c-7",
          language: "python3",
          path: "/tmp/a.py",
          args: ["--verbose"],
          env: { PYTHONUNBUFFERED: "1" },
          cwd: "/tmp"
        })
      ).not.toThrow();
    });

    it("accepts receive_source_archive with url", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "receive_source_archive",
          commandId: "c-8",
          url: "https://storage.example.com/tenant/app.tar.gz",
          destDir: "/var/lib/kaiad/workspaces/ws-1",
          stripComponents: 1
        })
      ).not.toThrow();
    });

    it("accepts receive_source_archive with archivePath", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "receive_source_archive",
          commandId: "c-9",
          archivePath: "/var/stage/php-app.tgz"
        })
      ).not.toThrow();
    });

    it("rejects receive_source_archive without url or archivePath", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "receive_source_archive",
          commandId: "c-10"
        })
      ).toThrow();
    });

    it("rejects receive_source_archive with both url and archivePath", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "receive_source_archive",
          commandId: "c-11",
          url: "https://example.com/a.tar.gz",
          archivePath: "/tmp/a.tar.gz"
        })
      ).toThrow();
    });

    it("rejects docker_op with bad operation", () => {
      expect(() =>
        platformToAgentMessageSchema.parse({
          type: "docker_op",
          commandId: "c-1",
          operation: "rm",
          args: {}
        })
      ).toThrow();
    });
  });
});

describe("jobs.ts", () => {
  describe("remediationJobSchema", () => {
    it("accepts valid job", () => {
      expect(() =>
        remediationJobSchema.parse({
          remediationJobId: "rj-1",
          tenantId: "t-1",
          incidentId: "inc-1",
          fingerprint: "fp",
          executor: "cursor",
          prompt: "fix it"
        })
      ).not.toThrow();
    });

    it("rejects missing prompt", () => {
      expect(() =>
        remediationJobSchema.parse({
          remediationJobId: "rj-1",
          tenantId: "t-1",
          incidentId: "inc-1",
          fingerprint: "fp",
          executor: "claude"
        })
      ).toThrow();
    });
  });

  describe("githubMutationJobSchema", () => {
    it("accepts mutation job", () => {
      expect(() =>
        githubMutationJobSchema.parse({
          tenantId: "t-1",
          installationId: 5,
          action: "push",
          repo: "o/r",
          branch: "main"
        })
      ).not.toThrow();
    });

    it("rejects missing repo", () => {
      expect(() =>
        githubMutationJobSchema.parse({
          tenantId: "t-1",
          installationId: 5,
          action: "push",
          branch: "main"
        })
      ).toThrow();
    });
  });

  describe("githubWebhookMutationJobSchema", () => {
    it("accepts webhook mutation", () => {
      expect(() =>
        githubWebhookMutationJobSchema.parse({
          kind: "github_mutation",
          tenantId: "t-1",
          installationId: 5,
          action: "merge_pr",
          repo: "o/r",
          branch: "feat"
        })
      ).not.toThrow();
    });

    it("rejects wrong kind", () => {
      expect(() =>
        githubWebhookMutationJobSchema.parse({
          kind: "github_ingestion",
          tenantId: "t-1",
          installationId: 5,
          action: "push",
          repo: "o/r",
          branch: "main"
        })
      ).toThrow();
    });
  });

  describe("githubWebhookIngestionPlaceholderJobSchema", () => {
    it("accepts ingestion placeholder", () => {
      expect(() =>
        githubWebhookIngestionPlaceholderJobSchema.parse({
          kind: "github_ingestion",
          tenantId: "t-1",
          eventType: "issues",
          deliveryId: "d-1"
        })
      ).not.toThrow();
    });

    it("rejects missing eventType", () => {
      expect(() =>
        githubWebhookIngestionPlaceholderJobSchema.parse({
          kind: "github_ingestion",
          tenantId: "t-1"
        })
      ).toThrow();
    });
  });

  describe("githubWebhookJobPayloadSchema", () => {
    it("accepts mutation branch of union", () => {
      expect(() =>
        githubWebhookJobPayloadSchema.parse({
          kind: "github_mutation",
          tenantId: "t-1",
          installationId: 1,
          action: "create_pr",
          repo: "o/r",
          branch: "main"
        })
      ).not.toThrow();
    });

    it("accepts ingestion branch of union", () => {
      expect(() =>
        githubWebhookJobPayloadSchema.parse({
          kind: "github_ingestion",
          tenantId: "t-1",
          eventType: "ping"
        })
      ).not.toThrow();
    });

    it("rejects unknown kind", () => {
      expect(() =>
        githubWebhookJobPayloadSchema.parse({
          kind: "unknown",
          tenantId: "t-1"
        })
      ).toThrow();
    });
  });

  describe("agentCommandJobSchema", () => {
    it("accepts command job", () => {
      expect(() =>
        agentCommandJobSchema.parse({
          agentId: "a-1",
          commandId: "c-1",
          payload: { foo: 1 }
        })
      ).not.toThrow();
    });

    it("rejects missing payload", () => {
      expect(() =>
        agentCommandJobSchema.parse({
          agentId: "a-1",
          commandId: "c-1"
        })
      ).toThrow();
    });
  });

  describe("agentCommandDispatchResponseSchema", () => {
    it("accepts dispatch response", () => {
      expect(() =>
        agentCommandDispatchResponseSchema.parse({
          accepted: true,
          commandId: "cmd-1",
          queued: true,
          delivered: false
        })
      ).not.toThrow();
    });
  });

  describe("logIngestionJobSchema", () => {
    it("accepts log job", () => {
      expect(() =>
        logIngestionJobSchema.parse({
          tenantId: "t-1",
          agentId: "a-1",
          serviceId: "svc-1",
          level: "warn",
          message: "slow",
          ts: iso
        })
      ).not.toThrow();
    });

    it("rejects invalid level", () => {
      expect(() =>
        logIngestionJobSchema.parse({
          tenantId: "t-1",
          agentId: "a-1",
          serviceId: "svc-1",
          level: "trace",
          message: "x",
          ts: iso
        })
      ).toThrow();
    });
  });
});
