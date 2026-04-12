import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { createMemoryDomainStore, __resetDomainStoreForTests, __seedAgentForTests } from "../src/domainStore.js";

const AUTH = { authorization: "Bearer dev-token" };

const domainStore = createMemoryDomainStore();
const app = buildServer({ domainStore });

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  __resetDomainStoreForTests();
});

describe("incidents API", () => {
  it("returns 401 for unauthenticated GET /api/v1/incidents", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/incidents" });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty incidents list initially", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/incidents", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ incidents: [] });
  });

  it("returns 404 for non-existent incident", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/incidents/bad-id", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("can update incident status", async () => {
    const inc = await domainStore.upsertIncident("t-1", {
      serviceId: "svc-1",
      fingerprint: "fp-1",
      message: "test error"
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/incidents/${inc.id}/status`,
      headers: AUTH,
      payload: { status: "resolved" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("resolved");
  });

  it("lists incidents after creation", async () => {
    await domainStore.upsertIncident("t-1", {
      serviceId: "svc-1",
      fingerprint: "fp-a",
      message: "error a"
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/incidents", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().incidents).toHaveLength(1);
  });

  it("enforces tenant isolation on incidents", async () => {
    const inc = await domainStore.upsertIncident("t-other", {
      serviceId: "svc-1",
      fingerprint: "fp-x",
      message: "other tenant error"
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/incidents/${inc.id}`,
      headers: AUTH
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("agents API", () => {
  it("returns 401 for unauthenticated GET /api/v1/agents", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/agents" });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty agents list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/agents", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agents: [] });
  });

  it("merges websocketConnected from realtime presence", async () => {
    __seedAgentForTests({
      id: "a-seed-1",
      tenantId: "t-1",
      name: "edge",
      version: "1.0.0",
      status: "online",
      lastSeenAt: new Date().toISOString()
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/agents", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: { id: string; websocketConnected: boolean }[] };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({ id: "a-seed-1", websocketConnected: false });
  });

  it("lists an agent after recordAgentHeartbeat (simulated realtime enrollment)", async () => {
    await domainStore.recordAgentHeartbeat("t-1", { agentId: "a-realtime-1", version: "0.3.0" });
    const res = await app.inject({ method: "GET", url: "/api/v1/agents", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agents: { id: string; version: string | null }[] };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toMatchObject({ id: "a-realtime-1", version: "0.3.0" });
  });
});

describe("services API", () => {
  it("returns 401 for unauthenticated GET /api/v1/services", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/services" });
    expect(res.statusCode).toBe(401);
  });

  it("deletes a service", async () => {
    const svc = await domainStore.createService("t-1", { name: "del-me", gitRepoUrl: "o/r", branch: "main" });
    const res = await app.inject({ method: "DELETE", url: `/api/v1/services/${svc.id}`, headers: AUTH });
    expect(res.statusCode).toBe(204);
    const listRes = await app.inject({ method: "GET", url: "/api/v1/services", headers: AUTH });
    const svcs = listRes.json().services as { id: string }[];
    expect(svcs.find((s) => s.id === svc.id)).toBeUndefined();
  });

  it("returns 404 when deleting non-existent service", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/v1/services/no-such-id", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("creates and lists monitored services", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: AUTH,
      payload: {
        name: "my-app",
        gitRepoUrl: "acme/app",
        branch: "main",
        dockerImage: "acme/app:latest",
        composePath: "deploy/compose.yml"
      }
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().name).toBe("my-app");
    expect(createRes.json().dockerImage).toBe("acme/app:latest");
    expect(createRes.json().composePath).toBe("deploy/compose.yml");

    const listRes = await app.inject({ method: "GET", url: "/api/v1/services", headers: AUTH });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().services).toHaveLength(1);
    expect(listRes.json().services[0]).toEqual(
      expect.objectContaining({
        workflowGraphId: null,
        dockerImage: "acme/app:latest",
        composePath: "deploy/compose.yml"
      })
    );
  });

  it("sets active workflow for a service", async () => {
    const svc = await domainStore.createService("t-1", { name: "svc-active", gitRepoUrl: "o/r", branch: "main" });
    const graph = await domainStore.createWorkflowGraph("t-1", {
      serviceId: svc.id,
      nodes: [{ id: "n1", type: "event", kind: "onCrash" }],
      edges: []
    });

    const setRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/services/${svc.id}/workflow`,
      headers: AUTH,
      payload: { workflowGraphId: graph.id }
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().workflowGraphId).toBe(graph.id);
  });
});

describe("ssh-keys API", () => {
  it("returns 401 for unauthenticated GET /api/v1/ssh-keys", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/ssh-keys" });
    expect(res.statusCode).toBe(401);
  });

  it("creates and lists SSH keys", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/ssh-keys",
      headers: AUTH,
      payload: {
        name: "my-key",
        type: "uploaded",
        privateKey: "some-key-data"
      }
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().name).toBe("my-key");
    expect(createRes.json().type).toBe("uploaded");

    const listRes = await app.inject({ method: "GET", url: "/api/v1/ssh-keys", headers: AUTH });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().keys).toHaveLength(1);
    expect(listRes.json().keys[0]).toEqual(
      expect.objectContaining({
        name: "my-key",
        type: "uploaded"
      })
    );
  });

  it("deletes an SSH key", async () => {
    const key = await domainStore.createSshKey("t-1", { name: "del-key", type: "uploaded" });
    const res = await app.inject({ method: "DELETE", url: `/api/v1/ssh-keys/${key.id}`, headers: AUTH });
    expect(res.statusCode).toBe(204);
    const listRes = await app.inject({ method: "GET", url: "/api/v1/ssh-keys", headers: AUTH });
    const keys = listRes.json().keys as { id: string }[];
    expect(keys.find((k) => k.id === key.id)).toBeUndefined();
  });

  it("returns 404 when deleting non-existent key", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/v1/ssh-keys/no-such-id", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe("workflows API", () => {
  it("returns 401 for unauthenticated GET /api/v1/workflows", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/workflows" });
    expect(res.statusCode).toBe(401);
  });

  it("creates and lists workflow graphs", async () => {
    const svc = await domainStore.createService("t-1", { name: "app", gitRepoUrl: "o/r", branch: "main" });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: AUTH,
      payload: {
        serviceId: svc.id,
        nodes: [{ id: "n1", type: "event", kind: "onCrash" }, { id: "n2", type: "action", kind: "runShell" }],
        edges: [{ from: "n1", to: "n2" }]
      }
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().version).toBe(1);

    const listRes = await app.inject({ method: "GET", url: "/api/v1/workflows", headers: AUTH });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().graphs).toHaveLength(1);
  });

  it("increments version for same service", async () => {
    const svc = await domainStore.createService("t-1", { name: "app2", gitRepoUrl: "o/r2", branch: "main" });
    const payload = {
      serviceId: svc.id,
      nodes: [{ id: "n1", type: "event", kind: "onCrash" }],
      edges: []
    };

    const v1 = await app.inject({ method: "POST", url: "/api/v1/workflows", headers: AUTH, payload });
    expect(v1.json().version).toBe(1);
    const v2 = await app.inject({ method: "POST", url: "/api/v1/workflows", headers: AUTH, payload });
    expect(v2.json().version).toBe(2);
  });

  it("returns conflict when executing workflow for service without bound agent", async () => {
    const svc = await domainStore.createService("t-1", { name: "no-agent", gitRepoUrl: "o/r", branch: "main" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/execute",
      headers: AUTH,
      payload: {
        serviceId: svc.id,
        nodes: [{ id: "n1", type: "event", kind: "onCrash" }],
        edges: []
      }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("AGENT_REQUIRED");
  });

  it("queues workflow execution command when queue hook is configured", async () => {
    const enqueueAgentCommand = vi.fn().mockResolvedValue(undefined);
    const executeApp = buildServer({
      domainStore,
      enqueueAgentCommand
    });
    await executeApp.ready();
    const svc = await domainStore.createService("t-1", {
      name: "with-agent",
      gitRepoUrl: "o/r",
      branch: "main",
      agentId: "agent-1"
    });
    const res = await executeApp.inject({
      method: "POST",
      url: "/api/v1/workflows/execute",
      headers: AUTH,
      payload: {
        serviceId: svc.id,
        nodes: [{ id: "n1", type: "event", kind: "onCrash" }, { id: "n2", type: "action", kind: "runShell" }],
        edges: [{ from: "n1", to: "n2" }]
      }
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(
      expect.objectContaining({
        accepted: true,
        dispatchState: "queued_for_dispatch"
      })
    );
    expect(enqueueAgentCommand).toHaveBeenCalledTimes(1);
    expect(enqueueAgentCommand.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        agentId: "agent-1",
        payload: expect.objectContaining({ type: "run_step" })
      })
    );
    await executeApp.close();
  });

  it("returns dry-run execution steps", async () => {
    const svc = await domainStore.createService("t-1", { name: "dry-run", gitRepoUrl: "o/r", branch: "main" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/dry-run",
      headers: AUTH,
      payload: {
        serviceId: svc.id,
        nodes: [
          { id: "n1", type: "event", kind: "onCrash" },
          { id: "n2", type: "action", kind: "runShell", data: { command: "echo ok" } }
        ],
        edges: [{ from: "n1", to: "n2" }]
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      expect.objectContaining({
        success: true,
        steps: expect.arrayContaining([
          expect.objectContaining({ nodeId: "n1", nodeType: "onCrash", success: true }),
          expect.objectContaining({ nodeId: "n2", nodeType: "runShell", success: true })
        ])
      })
    );
  });

  it("rejects invalid trigger parameters", async () => {
    const svc = await domainStore.createService("t-1", { name: "invalid-trigger-data", gitRepoUrl: "o/r", branch: "main" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: AUTH,
      payload: {
        serviceId: svc.id,
        nodes: [{ id: "n1", type: "event", kind: "onCrash", data: { schedule: "*/5 * * * *" } }],
        edges: []
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual(
      expect.objectContaining({
        code: "BAD_REQUEST"
      })
    );
  });
});
