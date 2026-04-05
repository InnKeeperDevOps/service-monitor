import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTenantStoreBackend } from "../src/storeAdapter.js";

describe("resolveTenantStoreBackend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects memory when DATABASE_URL is unset", () => {
    vi.stubEnv("DATABASE_URL", "");
    expect(resolveTenantStoreBackend(process.env, true)).toBe("memory");
  });

  it("selects memory when pg is not available", () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/db");
    expect(resolveTenantStoreBackend(process.env, false)).toBe("memory");
  });

  it("selects postgres when DATABASE_URL is set and pg is available", () => {
    vi.stubEnv("DATABASE_URL", "postgres://localhost/db");
    expect(resolveTenantStoreBackend(process.env, true)).toBe("postgres");
  });

  it("treats whitespace-only DATABASE_URL as memory", () => {
    vi.stubEnv("DATABASE_URL", "   ");
    expect(resolveTenantStoreBackend(process.env, true)).toBe("memory");
  });
});
