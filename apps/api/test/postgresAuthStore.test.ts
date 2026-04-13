import { describe, it, expect, vi } from "vitest";
import { createPostgresAuthStore } from "../src/postgresAuthStore.js";
import type { Pool } from "pg";

function createMockPool() {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [] } as any),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn().mockResolvedValue({ rows: [] } as any),
    connect: vi.fn().mockResolvedValue(client),
  };
  return { pool: pool as unknown as Pool, client };
}

describe("createPostgresAuthStore", () => {
  it("findUserByEmail returns null if not found", async () => {
    const { pool } = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as any);
    const store = createPostgresAuthStore(pool);
    const result = await store.findUserByEmail("test@example.com");
    expect(result).toBeNull();
  });

  it("findUserByEmail returns user if found", async () => {
    const { pool } = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: "u-1", email: "test@example.com", password_hash: "hash" }],
    } as any);
    const store = createPostgresAuthStore(pool);
    const result = await store.findUserByEmail("test@example.com");
    expect(result).toEqual({ id: "u-1", email: "test@example.com", passwordHash: "hash" });
  });

  it("findMemberships returns mapped memberships", async () => {
    const { pool } = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ tenant_id: "t-1", role: "owner" }],
    } as any);
    const store = createPostgresAuthStore(pool);
    const result = await store.findMemberships("u-1");
    expect(result).toEqual([{ tenantId: "t-1", role: "owner" }]);
  });

  it("findMembershipsWithTenants returns mapped memberships", async () => {
    const { pool } = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ tenant_id: "t-1", role: "owner", tenant_name: "Tenant 1" }],
    } as any);
    const store = createPostgresAuthStore(pool);
    const result = await store.findMembershipsWithTenants("u-1");
    expect(result).toEqual([{ tenantId: "t-1", role: "owner", tenantName: "Tenant 1" }]);
  });

  it("createSession creates and returns session id", async () => {
    const { pool } = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({ rowCount: 1 } as any);
    const store = createPostgresAuthStore(pool);
    const date = new Date();
    const result = await store.createSession("u-1", "t-1", "hash", date);
    expect(result).toMatch(/^sess-/);
    expect(pool.query).toHaveBeenCalledWith(
      "INSERT INTO sessions (id, user_id, tenant_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [result, "u-1", "t-1", "hash", date]
    );
  });

  it("findSessionByTokenHash returns null if not found", async () => {
    const { pool } = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as any);
    const store = createPostgresAuthStore(pool);
    const result = await store.findSessionByTokenHash("hash");
    expect(result).toBeNull();
  });

  it("findSessionByTokenHash returns session if found", async () => {
    const { pool } = createMockPool();
    const date = new Date();
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: "sess-1", user_id: "u-1", tenant_id: "t-1", expires_at: date.toISOString() }],
    } as any);
    const store = createPostgresAuthStore(pool);
    const result = await store.findSessionByTokenHash("hash");
    expect(result).toEqual({ id: "sess-1", userId: "u-1", tenantId: "t-1", expiresAt: date });
  });

  it("updateSessionTenant updates session", async () => {
    const { pool } = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({ rowCount: 1 } as any);
    const store = createPostgresAuthStore(pool);
    const result = await store.updateSessionTenant("sess-1", "t-2");
    expect(result).toBe(true);
  });

  it("findUserById returns null if not found", async () => {
    const { pool } = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as any);
    const store = createPostgresAuthStore(pool);
    const result = await store.findUserById("u-1");
    expect(result).toBeNull();
  });

  it("findUserById returns user if found", async () => {
    const { pool } = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: "u-1", email: "test@example.com" }],
    } as any);
    const store = createPostgresAuthStore(pool);
    const result = await store.findUserById("u-1");
    expect(result).toEqual({ id: "u-1", email: "test@example.com" });
  });

  describe("createTenantAsUser", () => {
    it("rolls back and throws if tenant id already exists", async () => {
      const { pool, client } = createMockPool();
      client.query.mockResolvedValueOnce({ rows: [] } as any); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] } as any); // SELECT 1 FROM tenants
      
      const store = createPostgresAuthStore(pool);
      await expect(
        store.createTenantAsUser({ userId: "u-1", sessionId: "sess-1", name: "Tenant 1" })
      ).rejects.toThrow("Tenant id already exists");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    });

    it("rolls back and throws if session update fails", async () => {
      const { pool, client } = createMockPool();
      client.query.mockResolvedValueOnce({ rows: [] } as any); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [] } as any); // SELECT 1 FROM tenants
      client.query.mockResolvedValueOnce({ rows: [] } as any); // INSERT INTO tenants
      client.query.mockResolvedValueOnce({ rows: [] } as any); // INSERT INTO tenant_memberships
      client.query.mockResolvedValueOnce({ rowCount: 0 } as any); // UPDATE sessions
      
      const store = createPostgresAuthStore(pool);
      await expect(
        store.createTenantAsUser({ userId: "u-1", sessionId: "sess-1", name: "Tenant 1" })
      ).rejects.toThrow("SESSION_UPDATE_FAILED");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    });

    it("commits and returns tenantId if successful", async () => {
      const { pool, client } = createMockPool();
      client.query.mockResolvedValueOnce({ rows: [] } as any); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [] } as any); // SELECT 1 FROM tenants
      client.query.mockResolvedValueOnce({ rows: [] } as any); // INSERT INTO tenants
      client.query.mockResolvedValueOnce({ rows: [] } as any); // INSERT INTO tenant_memberships
      client.query.mockResolvedValueOnce({ rowCount: 1 } as any); // UPDATE sessions
      client.query.mockResolvedValueOnce({ rows: [] } as any); // COMMIT
      
      const store = createPostgresAuthStore(pool);
      const result = await store.createTenantAsUser({ userId: "u-1", sessionId: "sess-1", name: "Tenant 1", tenantId: "t-1" });
      expect(result).toEqual({ tenantId: "t-1" });
      expect(client.query).toHaveBeenCalledWith("COMMIT");
      expect(client.release).toHaveBeenCalled();
    });
  });

  describe("deleteTenantForUser", () => {
    it("returns protected if tenant is default webhook tenant", async () => {
      const { pool } = createMockPool();
      const original = process.env.DEFAULT_WEBHOOK_TENANT_ID;
      process.env.DEFAULT_WEBHOOK_TENANT_ID = "t-1";
      const store = createPostgresAuthStore(pool);
      const result = await store.deleteTenantForUser({ userId: "u-1", tenantId: "t-1" });
      expect(result).toBe("protected");
      process.env.DEFAULT_WEBHOOK_TENANT_ID = original;
    });

    it("returns forbidden if user is not in tenant", async () => {
      const { pool, client } = createMockPool();
      client.query.mockResolvedValueOnce({ rows: [] } as any); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [] } as any); // SELECT role FROM tenant_memberships
      
      const store = createPostgresAuthStore(pool);
      const result = await store.deleteTenantForUser({ userId: "u-1", tenantId: "t-1" });
      expect(result).toBe("forbidden");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    });

    it("returns forbidden if user role is viewer", async () => {
      const { pool, client } = createMockPool();
      client.query.mockResolvedValueOnce({ rows: [] } as any); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [{ role: "viewer" }] } as any); // SELECT role FROM tenant_memberships
      
      const store = createPostgresAuthStore(pool);
      const result = await store.deleteTenantForUser({ userId: "u-1", tenantId: "t-1" });
      expect(result).toBe("forbidden");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    });

    it("returns not_found if tenant does not exist", async () => {
      const { pool, client } = createMockPool();
      client.query.mockResolvedValueOnce({ rows: [] } as any); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [{ role: "owner" }] } as any); // SELECT role FROM tenant_memberships
      client.query.mockResolvedValueOnce({ rows: [] } as any); // SELECT 1 FROM tenants
      
      const store = createPostgresAuthStore(pool);
      const result = await store.deleteTenantForUser({ userId: "u-1", tenantId: "t-1" });
      expect(result).toBe("not_found");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    });

    it("returns not_found if delete tenant query affects 0 rows", async () => {
      const { pool, client } = createMockPool();
      client.query.mockResolvedValueOnce({ rows: [] } as any); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [{ role: "owner" }] } as any); // SELECT role FROM tenant_memberships
      client.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] } as any); // SELECT 1 FROM tenants
      client.query.mockResolvedValueOnce({ rows: [] } as any); // UPDATE sessions
      client.query.mockResolvedValueOnce({ rows: [] } as any); // DELETE FROM sessions
      client.query.mockResolvedValueOnce({ rowCount: 0 } as any); // DELETE FROM tenants
      
      const store = createPostgresAuthStore(pool);
      const result = await store.deleteTenantForUser({ userId: "u-1", tenantId: "t-1" });
      expect(result).toBe("not_found");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    });

    it("commits and returns deleted if successful", async () => {
      const { pool, client } = createMockPool();
      client.query.mockResolvedValueOnce({ rows: [] } as any); // BEGIN
      client.query.mockResolvedValueOnce({ rows: [{ role: "owner" }] } as any); // SELECT role FROM tenant_memberships
      client.query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }] } as any); // SELECT 1 FROM tenants
      client.query.mockResolvedValueOnce({ rows: [] } as any); // UPDATE sessions
      client.query.mockResolvedValueOnce({ rows: [] } as any); // DELETE FROM sessions
      client.query.mockResolvedValueOnce({ rowCount: 1 } as any); // DELETE FROM tenants
      client.query.mockResolvedValueOnce({ rows: [] } as any); // COMMIT
      
      const store = createPostgresAuthStore(pool);
      const result = await store.deleteTenantForUser({ userId: "u-1", tenantId: "t-1" });
      expect(result).toBe("deleted");
      expect(client.query).toHaveBeenCalledWith("COMMIT");
    });
    
    it("handles error and rolls back", async () => {
      const { pool, client } = createMockPool();
      client.query.mockResolvedValueOnce({ rows: [] } as any); // BEGIN
      client.query.mockRejectedValueOnce(new Error("DB_ERROR")); // SELECT role FROM tenant_memberships
      
      const store = createPostgresAuthStore(pool);
      await expect(store.deleteTenantForUser({ userId: "u-1", tenantId: "t-1" })).rejects.toThrow("DB_ERROR");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    });
  });
});
