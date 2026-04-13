import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPostgresDomainStore } from "../src/postgresDomainStore.js";
import type { Pool } from "pg";
import * as queries from "@sm/db";

vi.mock("@sm/db", () => {
  return {
    listIncidents: vi.fn(),
    getIncident: vi.fn(),
    upsertIncident: vi.fn(),
    updateIncidentStatus: vi.fn(),
    listSshKeys: vi.fn(),
    createSshKey: vi.fn(),
    deleteSshKey: vi.fn(),
    listAgents: vi.fn(),
    getAgent: vi.fn(),
    recordAgentHeartbeat: vi.fn(),
    markAgentOffline: vi.fn(),
    listServices: vi.fn(),
    getService: vi.fn(),
    createService: vi.fn(),
    updateServiceWorkflow: vi.fn(),
    listWorkflowGraphs: vi.fn(),
    getWorkflowGraph: vi.fn(),
    createWorkflowGraph: vi.fn(),
  };
});

function createMockPool() {
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
  return pool as unknown as Pool;
}

describe("createPostgresDomainStore", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("listIncidents delegates to queries.listIncidents", async () => {
    const pool = createMockPool();
    const store = createPostgresDomainStore(pool);
    vi.mocked(queries.listIncidents).mockResolvedValueOnce([{ id: "i-1" }] as any);
    const result = await store.listIncidents("t-1");
    expect(result).toEqual([{ id: "i-1" }]);
    expect(queries.listIncidents).toHaveBeenCalledWith(expect.any(Function), "t-1");
  });

  it("getIncident delegates to queries.getIncident", async () => {
    const pool = createMockPool();
    const store = createPostgresDomainStore(pool);
    vi.mocked(queries.getIncident).mockResolvedValueOnce({ id: "i-1" } as any);
    const result = await store.getIncident("t-1", "i-1");
    expect(result).toEqual({ id: "i-1" });
    expect(queries.getIncident).toHaveBeenCalledWith(expect.any(Function), "t-1", "i-1");
  });

  it("upsertIncident delegates to queries.upsertIncident", async () => {
    const pool = createMockPool();
    const store = createPostgresDomainStore(pool);
    vi.mocked(queries.upsertIncident).mockResolvedValueOnce({ id: "i-1" } as any);
    const result = await store.upsertIncident("t-1", { id: "i-1" } as any);
    expect(result).toEqual({ id: "i-1" });
  });

  it("updateIncidentStatus delegates to queries.updateIncidentStatus", async () => {
    const pool = createMockPool();
    const store = createPostgresDomainStore(pool);
    vi.mocked(queries.updateIncidentStatus).mockResolvedValueOnce({ id: "i-1" } as any);
    const result = await store.updateIncidentStatus("t-1", "i-1", "resolved");
    expect(result).toEqual({ id: "i-1" });
  });

  describe("listSshKeys", () => {
    it("maps rows correctly", async () => {
      const pool = createMockPool();
      const store = createPostgresDomainStore(pool);
      const date = new Date();
      vi.mocked(queries.listSshKeys).mockResolvedValueOnce([
        { id: "k-1", tenantId: "t-1", name: "Key 1", type: "uploaded", localPath: null, createdAt: date, updatedAt: date },
        { id: "k-2", tenantId: "t-1", name: "Key 2", type: "local_path", localPath: "/path", createdAt: date, updatedAt: date },
      ] as any);
      
      const result = await store.listSshKeys("t-1");
      expect(result).toEqual([
        { id: "k-1", tenantId: "t-1", name: "Key 1", type: "uploaded", localPath: null, createdAt: date, updatedAt: date },
        { id: "k-2", tenantId: "t-1", name: "Key 2", type: "local_path", localPath: "/path", createdAt: date, updatedAt: date },
      ]);
    });
  });

  describe("createSshKey", () => {
    it("encrypts privateKey and delegates to queries.createSshKey", async () => {
      const originalKey = process.env.KAIAD_ENCRYPTION_KEY;
      process.env.KAIAD_ENCRYPTION_KEY = "test-key";
      
      const pool = createMockPool();
      const store = createPostgresDomainStore(pool);
      const date = new Date();
      vi.mocked(queries.createSshKey).mockResolvedValueOnce({
        id: "k-1", tenantId: "t-1", name: "Key 1", type: "uploaded", localPath: null, createdAt: date, updatedAt: date
      } as any);
      
      const result = await store.createSshKey("t-1", { name: "Key 1", type: "uploaded", privateKey: "secret-key-data" });
      expect(result).toEqual({
        id: "k-1", tenantId: "t-1", name: "Key 1", type: "uploaded", localPath: null, createdAt: date, updatedAt: date
      });
      expect(queries.createSshKey).toHaveBeenCalledWith(expect.any(Function), "t-1", expect.objectContaining({
        name: "Key 1", type: "uploaded", privateKeyEncrypted: expect.any(String)
      }));
      
      process.env.KAIAD_ENCRYPTION_KEY = originalKey;
    });

    it("throws if KAIAD_ENCRYPTION_KEY is missing in production", async () => {
      const originalKey = process.env.KAIAD_ENCRYPTION_KEY;
      const originalEnv = process.env.NODE_ENV;
      delete process.env.KAIAD_ENCRYPTION_KEY;
      process.env.NODE_ENV = "production";
      
      const pool = createMockPool();
      const store = createPostgresDomainStore(pool);
      
      await expect(
        store.createSshKey("t-1", { name: "Key 1", type: "uploaded", privateKey: "secret" })
      ).rejects.toThrow("KAIAD_ENCRYPTION_KEY is required in production");
      
      process.env.KAIAD_ENCRYPTION_KEY = originalKey;
      process.env.NODE_ENV = originalEnv;
    });

    it("uses 64 char hex string directly", async () => {
      const originalKey = process.env.KAIAD_ENCRYPTION_KEY;
      process.env.KAIAD_ENCRYPTION_KEY = "a".repeat(64);
      
      const pool = createMockPool();
      const store = createPostgresDomainStore(pool);
      const date = new Date();
      vi.mocked(queries.createSshKey).mockResolvedValueOnce({
        id: "k-1", tenantId: "t-1", name: "Key 1", type: "uploaded", localPath: null, createdAt: date, updatedAt: date
      } as any);
      
      await store.createSshKey("t-1", { name: "Key 1", type: "uploaded", privateKey: "secret" });
      expect(queries.createSshKey).toHaveBeenCalled();
      
      process.env.KAIAD_ENCRYPTION_KEY = originalKey;
    });
  });

  it("deleteSshKey delegates to queries.deleteSshKey", async () => {
    const pool = createMockPool();
    const store = createPostgresDomainStore(pool);
    vi.mocked(queries.deleteSshKey).mockResolvedValueOnce(true);
    const result = await store.deleteSshKey("t-1", "k-1");
    expect(result).toBe(true);
  });

  it("deleteService deletes and returns boolean", async () => {
    const pool = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ id: "s-1" }] } as any);
    const store = createPostgresDomainStore(pool);
    
    const result = await store.deleteService("t-1", "s-1");
    expect(result).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      "DELETE FROM monitored_services WHERE id = $1 AND tenant_id = $2 RETURNING id",
      ["s-1", "t-1"]
    );
  });

  // Coverage for the other delegates
  it("delegates other simple queries", async () => {
    const pool = createMockPool();
    const store = createPostgresDomainStore(pool);
    vi.mocked(queries.listAgents).mockResolvedValueOnce([] as any);
    await store.listAgents("t-1");
    expect(queries.listAgents).toHaveBeenCalled();

    vi.mocked(queries.getAgent).mockResolvedValueOnce(null as any);
    await store.getAgent("t-1", "a-1");
    expect(queries.getAgent).toHaveBeenCalled();

    vi.mocked(queries.recordAgentHeartbeat).mockResolvedValueOnce({} as any);
    await store.recordAgentHeartbeat("t-1", {} as any);
    expect(queries.recordAgentHeartbeat).toHaveBeenCalled();

    vi.mocked(queries.markAgentOffline).mockResolvedValueOnce(true as any);
    await store.markAgentOffline("t-1", "a-1");
    expect(queries.markAgentOffline).toHaveBeenCalled();

    vi.mocked(queries.listServices).mockResolvedValueOnce([] as any);
    await store.listServices("t-1");
    expect(queries.listServices).toHaveBeenCalled();

    vi.mocked(queries.getService).mockResolvedValueOnce(null as any);
    await store.getService("t-1", "s-1");
    expect(queries.getService).toHaveBeenCalled();

    vi.mocked(queries.createService).mockResolvedValueOnce({} as any);
    await store.createService("t-1", {} as any);
    expect(queries.createService).toHaveBeenCalled();

    vi.mocked(queries.updateServiceWorkflow).mockResolvedValueOnce({} as any);
    await store.updateServiceWorkflow("t-1", "s-1", "w-1");
    expect(queries.updateServiceWorkflow).toHaveBeenCalled();

    vi.mocked(queries.listWorkflowGraphs).mockResolvedValueOnce([] as any);
    await store.listWorkflowGraphs("t-1");
    expect(queries.listWorkflowGraphs).toHaveBeenCalled();

    vi.mocked(queries.getWorkflowGraph).mockResolvedValueOnce(null as any);
    await store.getWorkflowGraph("t-1", "w-1");
    expect(queries.getWorkflowGraph).toHaveBeenCalled();

    vi.mocked(queries.createWorkflowGraph).mockResolvedValueOnce({} as any);
    await store.createWorkflowGraph("t-1", {} as any);
    expect(queries.createWorkflowGraph).toHaveBeenCalled();
  });
});
