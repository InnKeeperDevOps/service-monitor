import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as enrollmentStore from "../src/enrollmentStore.js";
import { ensureCoreSchema } from "@sm/db";

vi.mock("pg", () => {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  return {
    Pool: vi.fn().mockImplementation(() => ({ query })),
  };
});

vi.mock("@sm/db", () => ({
  ensureCoreSchema: vi.fn(),
}));

describe("enrollmentStore postgres store", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await enrollmentStore.__resetEnrollmentStoreForTests();
  });

  it("fails to initialize if DATABASE_URL is set but throws error", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    process.env.SM_ENROLLMENT_STORE = ""; // remove memory
    vi.mocked(ensureCoreSchema).mockRejectedValueOnce(new Error("db error"));
    
    await expect(enrollmentStore.listEnrollmentTokensForTenant("t-1")).rejects.toThrow(
      "DATABASE_URL is configured but enrollment token store could not initialize: db error"
    );
  });

  it("initializes postgres store and creates token", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    process.env.SM_ENROLLMENT_STORE = "";
    
    const result = await enrollmentStore.createEnrollmentTokenForTenant({
      tenantId: "t-1",
      createdBy: "u-1",
      ttlSeconds: 3600
    });
    
    expect(result.token).toBeDefined();
    expect(result.response.tenantId).toBe("t-1");
  });

  it("lists tokens from postgres", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    process.env.SM_ENROLLMENT_STORE = "";
    
    const date = new Date().toISOString();
    const { Pool } = await import("pg");
    const mockPool = new Pool();
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [
        {
          id: "token-1",
          tenant_id: "t-1",
          token_hash: "hash",
          expires_at: date,
          created_by: "u-1",
          created_at: date,
          used_at: null,
          revoked_at: null
        }
      ]
    } as any);

    const tokens = await enrollmentStore.listEnrollmentTokensForTenant("t-1");
    expect(tokens.length).toBe(1);
    expect(tokens[0].id).toBe("token-1");
  });

  it("deletes token from postgres", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    process.env.SM_ENROLLMENT_STORE = "";
    
    const { Pool } = await import("pg");
    const mockPool = new Pool();
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rowCount: 1 } as any);
    
    const result = await enrollmentStore.deleteEnrollmentTokenForTenant("t-1", "token-1");
    expect(result).toBe(true);
  });

  it("deactivates token from postgres - success", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    process.env.SM_ENROLLMENT_STORE = "";
    
    const { Pool } = await import("pg");
    const mockPool = new Pool();
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rowCount: 1 } as any); // UPDATE returns 1
    
    const result = await enrollmentStore.deactivateEnrollmentTokenForTenant("t-1", "token-1");
    expect(result).toBe("deactivated");
  });

  it("deactivates token from postgres - not_found", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    process.env.SM_ENROLLMENT_STORE = "";
    
    const { Pool } = await import("pg");
    const mockPool = new Pool();
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rowCount: 0 } as any); // UPDATE
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rows: [] } as any); // SELECT exists
    
    const result = await enrollmentStore.deactivateEnrollmentTokenForTenant("t-1", "token-1");
    expect(result).toBe("not_found");
  });

  it("deactivates token from postgres - not_revocable", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    process.env.SM_ENROLLMENT_STORE = "";
    
    const { Pool } = await import("pg");
    const mockPool = new Pool();
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rowCount: 0 } as any); // UPDATE
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rows: [{ "?column?": 1 }] } as any); // SELECT exists
    
    const result = await enrollmentStore.deactivateEnrollmentTokenForTenant("t-1", "token-1");
    expect(result).toBe("not_revocable");
  });

  it("consumes token from postgres - success", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    process.env.SM_ENROLLMENT_STORE = "";
    
    const { Pool } = await import("pg");
    const mockPool = new Pool();
    vi.mocked(mockPool.query).mockResolvedValueOnce({
      rows: [{ tenant_id: "t-1", id: "token-1" }]
    } as any);
    
    const result = await enrollmentStore.validateEnrollmentToken("some-plaintext-token");
    expect(result).toEqual({ tenantId: "t-1", tokenId: "token-1" });
  });

  it("consumes token from postgres - null", async () => {
    process.env.DATABASE_URL = "postgres://fake";
    process.env.SM_ENROLLMENT_STORE = "";
    
    const { Pool } = await import("pg");
    const mockPool = new Pool();
    vi.mocked(mockPool.query).mockResolvedValueOnce({ rows: [] } as any);
    
    const result = await enrollmentStore.validateEnrollmentToken("some-plaintext-token");
    expect(result).toBeNull();
  });
});
