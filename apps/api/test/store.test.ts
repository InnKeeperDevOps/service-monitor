import { describe, expect, it, vi, afterEach } from "vitest";
import { getTenantSettings, upsertTenantSettings, __resetTenantStoreForTests } from "../src/store.js";
import { __resetMemoryTenantStoreForTests } from "../src/memoryTenantStore.js";

vi.mock("pg", () => ({
  Pool: class {
    query = vi.fn().mockResolvedValue({ rows: [] });
    end = vi.fn();
    connect = vi.fn().mockResolvedValue({
      query: vi.fn(),
      release: vi.fn()
    });
  }
}));

vi.mock("@sm/db", () => ({
  ensureCoreSchema: vi.fn().mockResolvedValue(undefined),
}));

describe("store", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetTenantStoreForTests();
  });

  it("initializes memory store when backend is memory", async () => {
    process.env.SM_TENANT_STORE = "memory";
    await upsertTenantSettings({ tenantId: "t-1", docsUrl: "http://docs" });
    const s = await getTenantSettings("t-1");
    expect(s?.docsUrl).toBe("http://docs");
  });

  it("initializes memory store when postgres url is missing", async () => {
    process.env.SM_TENANT_STORE = "postgres";
    process.env.DATABASE_URL = "   "; // missing
    await upsertTenantSettings({ tenantId: "t-1", docsUrl: "http://docs2" });
    const s = await getTenantSettings("t-1");
    expect(s?.docsUrl).toBe("http://docs2");
  });

  it("initializes postgres store when backend is postgres and url exists", async () => {
    process.env.SM_TENANT_STORE = "postgres";
    process.env.DATABASE_URL = "postgres://fake";
    // It will return the mocked Postgres store which currently returns empty rows,
    // so getTenantSettings will be undefined or empty.
    const { createPostgresTenantStore } = await import("../src/postgresTenantStore.js");
    vi.mocked(createPostgresTenantStore);
    await getTenantSettings("t-1");
  });
});
