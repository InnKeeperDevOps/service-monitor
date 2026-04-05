import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapEnv } from "../src/bootstrapEnv.js";

describe("bootstrapEnv", () => {
  let tempDataDir: string | null = null;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempDataDir) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
      tempDataDir = null;
    }
  });

  it("loads setup config values into process env", () => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaiad-config-"));
    fs.writeFileSync(
      path.join(tempDataDir, "kaiad.config.json"),
      JSON.stringify(
        {
          setupComplete: true,
          databaseUrl: "postgres://cfg-user:cfg-pass@db-host:5432/kaiad",
          redisUrl: "redis://redis-host:6379"
        },
        null,
        2
      )
    );

    vi.stubEnv("KAIAD_DATA_DIR", tempDataDir);
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("REDIS_URL", "");

    const result = bootstrapEnv();

    expect(result).toEqual({ setupComplete: true, configLoaded: true });
    expect(process.env.DATABASE_URL).toBe("postgres://cfg-user:cfg-pass@db-host:5432/kaiad");
    expect(process.env.REDIS_URL).toBe("redis://redis-host:6379");
  });

  it("overrides stale DATABASE_URL with configured value", () => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kaiad-config-"));
    fs.writeFileSync(
      path.join(tempDataDir, "kaiad.config.json"),
      JSON.stringify(
        {
          setupComplete: true,
          databaseUrl: "postgres://new-user:new-pass@new-db:5432/kaiad"
        },
        null,
        2
      )
    );

    vi.stubEnv("KAIAD_DATA_DIR", tempDataDir);
    vi.stubEnv("DATABASE_URL", "postgres://old-user:old-pass@old-db:5432/kaiad");

    const result = bootstrapEnv();

    expect(result).toEqual({ setupComplete: true, configLoaded: true });
    expect(process.env.DATABASE_URL).toBe("postgres://new-user:new-pass@new-db:5432/kaiad");
  });
});
