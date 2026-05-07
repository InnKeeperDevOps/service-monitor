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
        dockerImage: "acme/app:latest",
        composePath: "deploy/compose.yml"
      })
    );
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

describe("agents administration API", () => {
  it("returns 401 for unauthenticated GET /api/v1/agents/:id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/agents/a-1" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when fetching an unknown agent", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/agents/missing", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("renames a registered agent", async () => {
    __seedAgentForTests({
      id: "a-rename",
      tenantId: "t-1",
      name: null,
      version: null,
      status: "online",
      lastSeenAt: null,
      certFingerprint: null,
      allowedCapabilities: []
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/agents/a-rename",
      headers: AUTH,
      payload: { name: "Edge agent #1" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Edge agent #1");
  });

  it("deletes a registered agent and detaches its services", async () => {
    __seedAgentForTests({
      id: "a-del",
      tenantId: "t-1",
      name: "to delete",
      version: null,
      status: "online",
      lastSeenAt: null,
      certFingerprint: null,
      allowedCapabilities: []
    });
    const svc = await domainStore.createService("t-1", {
      name: "linked",
      gitRepoUrl: "o/r",
      branch: "main",
      agentId: "a-del"
    });
    const res = await app.inject({ method: "DELETE", url: "/api/v1/agents/a-del", headers: AUTH });
    expect(res.statusCode).toBe(204);
    const detached = await domainStore.getService("t-1", svc.id);
    expect(detached?.agentId).toBeNull();
  });
});
