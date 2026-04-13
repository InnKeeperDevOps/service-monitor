import { describe, it, expect, vi } from "vitest";
import { createPostgresTenantStore } from "../src/postgresTenantStore.js";
import type { Pool } from "pg";

function createMockPool() {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(client),
  };
  return { pool: pool as unknown as Pool, client };
}

describe("createPostgresTenantStore", () => {
  it("getTenantSettings ensures table and returns undefined if not found", async () => {
    const { pool, client } = createMockPool();
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as any); // SELECT payload
    client.query.mockResolvedValueOnce({ rows: [] } as any); // ENSURE_SQL

    const store = createPostgresTenantStore(pool);
    const result = await store.getTenantSettings("t-1");
    expect(result).toBeUndefined();
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("create table if not exists api_tenant_settings"));
    expect(client.release).toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith("select payload from api_tenant_settings where tenant_id = $1", ["t-1"]);
  });

  it("getTenantSettings returns payload if found", async () => {
    const { pool, client } = createMockPool();
    const settings = { tenantId: "t-1", foo: "bar" };
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ payload: settings }] } as any); // SELECT payload
    client.query.mockResolvedValueOnce({ rows: [] } as any); // ENSURE_SQL

    const store = createPostgresTenantStore(pool);
    const result = await store.getTenantSettings("t-1");
    expect(result).toEqual(settings);
  });

  it("upsertTenantSettings ensures table and inserts/updates settings", async () => {
    const { pool, client } = createMockPool();
    const settings = { tenantId: "t-1", automationPolicy: { enabled: true } };
    vi.mocked(pool.query).mockResolvedValueOnce({ rowCount: 1 } as any); // INSERT
    client.query.mockResolvedValueOnce({ rows: [] } as any); // ENSURE_SQL

    const store = createPostgresTenantStore(pool);
    const result = await store.upsertTenantSettings(settings as any);
    expect(result).toEqual(settings);
    
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ payload: settings }] } as any); // SELECT payload for getTenantSettings
    await store.getTenantSettings("t-1");
    expect(client.query).toHaveBeenCalledTimes(1); // ENSURE_SQL is cached
  });
});
