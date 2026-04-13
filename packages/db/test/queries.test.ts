import { describe, it, expect, vi } from "vitest";
import crypto from "node:crypto";
import {
  listIncidents,
  getIncident,
  upsertIncident,
  updateIncidentStatus,
  listAgents,
  getAgent,
  recordAgentHeartbeat,
  markAgentOffline,
  listServices,
  createService,
  listSshKeys,
  getSshKey,
  createSshKey,
  deleteSshKey,
  listWorkflowGraphs,
  createWorkflowGraph,
  type QueryFn,
} from "../src/queries.js";

vi.stubGlobal("crypto", crypto);

function mockQuery(rows: Record<string, unknown>[] = []): QueryFn {
  return vi.fn().mockResolvedValue({ rows });
}

function sequentialQuery(...results: Record<string, unknown>[][]): QueryFn {
  const fn = vi.fn();
  for (const rows of results) {
    fn.mockResolvedValueOnce({ rows });
  }
  return fn;
}

describe("listSshKeys", () => {
  it("returns mapped rows", async () => {
    const query = mockQuery([
      {
        id: "k1",
        tenant_id: "t1",
        name: "My Key",
        type: "uploaded",
        private_key_encrypted: "enc",
        local_path: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    ]);
    const result = await listSshKeys(query, "t1");
    expect(result).toEqual([
      {
        id: "k1",
        tenantId: "t1",
        name: "My Key",
        type: "uploaded",
        privateKeyEncrypted: "enc",
        localPath: null,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    ]);
  });
});

describe("getSshKey", () => {
  it("returns mapped row when found", async () => {
    const query = mockQuery([
      {
        id: "k1",
        tenant_id: "t1",
        name: "My Key",
        type: "uploaded",
        private_key_encrypted: "enc",
        local_path: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    ]);
    const result = await getSshKey(query, "t1", "k1");
    expect(result?.id).toBe("k1");
  });

  it("returns undefined when missing", async () => {
    const result = await getSshKey(mockQuery([]), "t1", "nope");
    expect(result).toBeUndefined();
  });
});

describe("createSshKey", () => {
  it("generates UUID and inserts", async () => {
    const query = mockQuery([
      {
        id: "new-uuid",
        tenant_id: "t1",
        name: "My Key",
        type: "local_path",
        private_key_encrypted: null,
        local_path: "/tmp/key",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      },
    ]);
    const result = await createSshKey(query, "t1", {
      name: "My Key",
      type: "local_path",
      localPath: "/tmp/key",
    });
    expect(result.name).toBe("My Key");
    expect(result.type).toBe("local_path");
    expect(result.localPath).toBe("/tmp/key");
    expect(result.privateKeyEncrypted).toBeNull();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO ssh_keys"),
      expect.arrayContaining(["t1", "My Key", "local_path", null, "/tmp/key"]),
    );
  });
});

describe("deleteSshKey", () => {
  it("returns true when found and deleted", async () => {
    const query = mockQuery([{ id: "k1" }]);
    const result = await deleteSshKey(query, "t1", "k1");
    expect(result).toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM ssh_keys"),
      ["t1", "k1"]
    );
  });

  it("returns false when not found", async () => {
    const result = await deleteSshKey(mockQuery([]), "t1", "nope");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

describe("listIncidents", () => {
  it("returns mapped rows ordered by last_seen_at", async () => {
    const query = mockQuery([
      {
        id: "inc-1",
        tenant_id: "t1",
        service_id: "svc-1",
        fingerprint: "fp",
        message: "boom",
        status: "open",
        event_count: 3,
        first_seen_at: "2025-01-01T00:00:00.000Z",
        last_seen_at: "2025-01-02T00:00:00.000Z",
      },
    ]);
    const result = await listIncidents(query, "t1");
    expect(result).toEqual([
      {
        id: "inc-1",
        tenantId: "t1",
        serviceId: "svc-1",
        fingerprint: "fp",
        message: "boom",
        status: "open",
        eventCount: 3,
        firstSeenAt: "2025-01-01T00:00:00.000Z",
        lastSeenAt: "2025-01-02T00:00:00.000Z",
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM incidents"),
      ["t1"],
    );
  });
});

describe("getIncident", () => {
  it("returns undefined when not found", async () => {
    const result = await getIncident(mockQuery([]), "t1", "nope");
    expect(result).toBeUndefined();
  });
});

describe("upsertIncident", () => {
  it("creates a new incident when none exists", async () => {
    const now = "2025-06-01T00:00:00.000Z";
    const query = sequentialQuery(
      [],
      [
        {
          id: "generated-uuid",
          tenant_id: "t1",
          service_id: "svc-1",
          fingerprint: "fp1",
          message: null,
          status: "open",
          event_count: 1,
          first_seen_at: now,
          last_seen_at: now,
        },
      ],
    );
    const result = await upsertIncident(query, "t1", {
      serviceId: "svc-1",
      fingerprint: "fp1",
    });
    expect(result.status).toBe("open");
    expect(result.eventCount).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
    const insertCall = (query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO incidents");
  });

  it("increments count on existing open incident", async () => {
    const query = sequentialQuery(
      [{ id: "inc-existing", tenant_id: "t1", service_id: "svc-1", fingerprint: "fp1", status: "open" }],
      [
        {
          id: "inc-existing",
          tenant_id: "t1",
          service_id: "svc-1",
          fingerprint: "fp1",
          message: null,
          status: "open",
          event_count: 4,
          first_seen_at: "2025-01-01T00:00:00.000Z",
          last_seen_at: "2025-06-01T00:00:00.000Z",
        },
      ],
    );
    const result = await upsertIncident(query, "t1", {
      serviceId: "svc-1",
      fingerprint: "fp1",
    });
    expect(result.eventCount).toBe(4);
    const updateCall = (query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(updateCall[0]).toContain("event_count = event_count + 1");
    expect(updateCall[0]).toContain("tenant_id = $2");
    expect(updateCall[1]).toEqual(["inc-existing", "t1"]);
  });
});

describe("updateIncidentStatus", () => {
  it("returns updated row", async () => {
    const query = mockQuery([
      {
        id: "inc-1",
        tenant_id: "t1",
        service_id: "svc-1",
        fingerprint: "fp",
        message: null,
        status: "resolved",
        event_count: 2,
        first_seen_at: "2025-01-01T00:00:00.000Z",
        last_seen_at: "2025-01-01T00:00:00.000Z",
      },
    ]);
    const result = await updateIncidentStatus(query, "t1", "inc-1", "resolved");
    expect(result?.status).toBe("resolved");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE incidents SET status"),
      ["resolved", "t1", "inc-1"],
    );
  });

  it("returns undefined when not found", async () => {
    const result = await updateIncidentStatus(mockQuery([]), "t1", "nope", "closed");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe("listAgents", () => {
  it("returns mapped rows", async () => {
    const query = mockQuery([
      {
        id: "a1",
        tenant_id: "t1",
        name: "n1",
        version: "v1",
        status: "online",
        last_seen_at: "2025-01-01T00:00:00.000Z",
        cert_fingerprint: "fp",
        allowed_capabilities: ["a", "b"],
      },
    ]);
    const result = await listAgents(query, "t1");
    expect(result).toEqual([
      {
        id: "a1",
        tenantId: "t1",
        name: "n1",
        version: "v1",
        status: "online",
        lastSeenAt: "2025-01-01T00:00:00.000Z",
        certFingerprint: "fp",
        allowedCapabilities: ["a", "b"],
      },
    ]);
  });
});

describe("getAgent", () => {
  it("returns undefined when missing", async () => {
    const result = await getAgent(mockQuery([]), "t1", "nope");
    expect(result).toBeUndefined();
  });
});

describe("recordAgentHeartbeat", () => {
  it("runs upsert SQL", async () => {
    const query = mockQuery([]);
    await recordAgentHeartbeat(query, "t1", { agentId: "a1", version: "1.0.0" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO agents"),
      ["a1", "t1", "1.0.0"],
    );
  });

  it("passes null version for COALESCE behavior in SQL", async () => {
    const query = mockQuery([]);
    await recordAgentHeartbeat(query, "t1", { agentId: "a1", version: null });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (id) DO UPDATE"),
      ["a1", "t1", null],
    );
  });
});

describe("markAgentOffline", () => {
  it("runs update SQL", async () => {
    const query = mockQuery([]);
    await markAgentOffline(query, "t1", "a1");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE agents SET status"), ["a1", "t1"]);
  });
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

describe("listServices", () => {
  it("returns mapped rows", async () => {
    const query = mockQuery([
      {
        id: "s1",
        tenant_id: "t1",
        agent_id: "a1",
        name: "web",
        git_repo_url: "r",
        ssh_key_id: "k1",
        branch: "main",
        docker_image: "acme/web:latest",
        compose_path: "compose.yml",
        agent_runtime_backend: null
      },
    ]);
    const result = await listServices(query, "t1");
    expect(result).toEqual([
      {
        id: "s1",
        tenantId: "t1",
        agentId: "a1",
        workflowGraphId: null,
        name: "web",
        gitRepoUrl: "r",
        sshKeyId: "k1",
        branch: "main",
        dockerImage: "acme/web:latest",
        composePath: "compose.yml",
        agentRuntimeBackend: null
      },
    ]);
  });
});

describe("createService", () => {
  it("generates UUID and inserts", async () => {
    const query = mockQuery([
      {
        id: "new-uuid",
        tenant_id: "t1",
        agent_id: null,
        name: "api",
        git_repo_url: "r",
        ssh_key_id: null,
        branch: "main",
        docker_image: "acme/api:1.0",
        compose_path: "deploy/compose.yml",
        agent_runtime_backend: null
      },
    ]);
    const result = await createService(query, "t1", {
      name: "api",
      gitRepoUrl: "r",
      sshKeyId: null,
      branch: "main",
      dockerImage: "acme/api:1.0",
      composePath: "deploy/compose.yml",
      agentRuntimeBackend: undefined
    });
    expect(result.name).toBe("api");
    expect(result.agentId).toBeNull();
    expect(result.dockerImage).toBe("acme/api:1.0");
    expect(result.composePath).toBe("deploy/compose.yml");
    expect(result.agentRuntimeBackend).toBeNull();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO monitored_services"),
      expect.arrayContaining(["t1", null, "api", "r", null, "main", "acme/api:1.0", "deploy/compose.yml", null]),
    );
  });
});

// ---------------------------------------------------------------------------
// Workflow Graphs
// ---------------------------------------------------------------------------

describe("listWorkflowGraphs", () => {
  it("parses graph_json into nodes and edges", async () => {
    const query = mockQuery([
      {
        id: "wf1",
        tenant_id: "t1",
        name: "wf",
        version: 2,
        graph_json: { nodes: [{ id: "n1", type: "check" }], edges: [{ from: "n1", to: "n2" }] },
        is_active: true,
      },
    ]);
    const result = await listWorkflowGraphs(query, "t1");
    expect(result).toEqual([
      {
        id: "wf1",
        tenantId: "t1",
        name: "wf",
        version: 2,
        nodes: [{ id: "n1", type: "check" }],
        edges: [{ from: "n1", to: "n2" }],
        isActive: true,
      },
    ]);
  });

  it("handles string graph_json", async () => {
    const query = mockQuery([
      {
        id: "wf1",
        tenant_id: "t1",
        name: "wf",
        version: 1,
        graph_json: JSON.stringify({ nodes: [], edges: [] }),
        is_active: false,
      },
    ]);
    const result = await listWorkflowGraphs(query, "t1");
    expect(result[0].nodes).toEqual([]);
    expect(result[0].edges).toEqual([]);
  });
});

describe("createWorkflowGraph", () => {
  it("calculates next version from MAX", async () => {
    const query = sequentialQuery(
      [{ max_version: 3 }],
      [
        {
          id: "wf-new",
          tenant_id: "t1",
          name: "wf",
          version: 4,
          graph_json: { nodes: [{ id: "n1", type: "t" }], edges: [] },
          is_active: false,
        },
      ],
    );
    const result = await createWorkflowGraph(query, "t1", {
      name: "wf",
      nodes: [{ id: "n1", type: "t" }],
      edges: [],
    });
    expect(result.version).toBe(4);
    expect(result.isActive).toBe(false);
    const insertCall = (query as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(insertCall[1]).toContain(4);
  });

  it("starts at version 1 when no prior graphs", async () => {
    const query = sequentialQuery(
      [{ max_version: 0 }],
      [
        {
          id: "wf-first",
          tenant_id: "t1",
          name: "wf",
          version: 1,
          graph_json: { nodes: [], edges: [] },
          is_active: false,
        },
      ],
    );
    const result = await createWorkflowGraph(query, "t1", {
      name: "wf",
      nodes: [],
      edges: [],
    });
    expect(result.version).toBe(1);
  });
});
