import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ensureCoreSchema, __resetEnsureCoreSchemaForTests } from "../src/ensureSchema.js";

describe("ensureCoreSchema", () => {
  beforeEach(() => {
    __resetEnsureCoreSchemaForTests();
    delete process.env.SM_SKIP_DB_SCHEMA_SYNC;
  });

  afterEach(() => {
    __resetEnsureCoreSchemaForTests();
    delete process.env.SM_SKIP_DB_SCHEMA_SYNC;
  });

  it("runs core SQL once per process and reuses the promise", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query };
    await ensureCoreSchema(pool);
    await ensureCoreSchema(pool);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("skips when SM_SKIP_DB_SCHEMA_SYNC=1", async () => {
    process.env.SM_SKIP_DB_SCHEMA_SYNC = "1";
    const query = vi.fn();
    await ensureCoreSchema({ query });
    expect(query).not.toHaveBeenCalled();
  });
});
