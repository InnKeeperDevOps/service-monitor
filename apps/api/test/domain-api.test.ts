import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/server.js";
import { createMemoryDomainStore, __resetDomainStoreForTests } from "../src/domainStore.js";

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
});

describe("services API", () => {
  it("returns 401 for unauthenticated GET /api/v1/services", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/services" });
    expect(res.statusCode).toBe(401);
  });

  it("deletes a service", async () => {
    const svc = await domainStore.createService("t-1", { name: "del-me", repo: "o/r", branch: "main" });
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
        repo: "acme/app",
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
        dockerImage: "acme/app:latest",
        composePath: "deploy/compose.yml"
      })
    );
  });
});

describe("workflows API", () => {
  it("returns 401 for unauthenticated GET /api/v1/workflows", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/workflows" });
    expect(res.statusCode).toBe(401);
  });

  it("creates and lists workflow graphs", async () => {
    const svc = await domainStore.createService("t-1", { name: "app", repo: "o/r", branch: "main" });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/workflows",
      headers: AUTH,
      payload: {
        serviceId: svc.id,
        nodes: [{ id: "n1", type: "onCrash" }, { id: "n2", type: "runShell" }],
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
    const svc = await domainStore.createService("t-1", { name: "app2", repo: "o/r2", branch: "main" });
    const payload = {
      serviceId: svc.id,
      nodes: [{ id: "n1", type: "onCrash" }],
      edges: []
    };

    const v1 = await app.inject({ method: "POST", url: "/api/v1/workflows", headers: AUTH, payload });
    expect(v1.json().version).toBe(1);
    const v2 = await app.inject({ method: "POST", url: "/api/v1/workflows", headers: AUTH, payload });
    expect(v2.json().version).toBe(2);
  });

  it("returns conflict when executing workflow for service without bound agent", async () => {
    const svc = await domainStore.createService("t-1", { name: "no-agent", repo: "o/r", branch: "main" });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/workflows/execute",
      headers: AUTH,
      payload: {
        serviceId: svc.id,
        nodes: [{ id: "n1", type: "onCrash" }],
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
      repo: "o/r",
      branch: "main",
      agentId: "agent-1"
    });
    const res = await executeApp.inject({
      method: "POST",
      url: "/api/v1/workflows/execute",
      headers: AUTH,
      payload: {
        serviceId: svc.id,
        nodes: [{ id: "n1", type: "onCrash" }, { id: "n2", type: "runShell" }],
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
});
